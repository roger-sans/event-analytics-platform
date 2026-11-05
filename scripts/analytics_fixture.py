"""Seeded coherent histories and an independent Python acceptance oracle (stdlib only)."""
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal
import random
import uuid


def build_fixture(seed, start, days=10, prefix='case'):
    if days < 10:
        raise ValueError('Lifecycle scenario needs at least 10 days')
    start = date.fromisoformat(start) if isinstance(start, str) else start
    events = []
    apps = []
    for index, suffix in enumerate(('budgetbee', 'storyhub', 'museai'), 1):
        app = prefix + '_' + suffix
        apps.append(app)
        features = {'budgetbee': ('budget', 'chart'), 'storyhub': ('article', 'bookmark'), 'museai': ('chat', 'summarize')}[suffix]
        def add(user, offset, name, category, props):
            idx = len(events)
            event = dict(schema_version=1, event_id=str(uuid.uuid5(uuid.NAMESPACE_URL, f'{seed}:{app}:{start}:{days}:{idx}')),
                         app_id=app, user_id=app + '-' + user,
                         event_name=name, event_category=category,
                         event_time=f'{start + timedelta(days=offset)}T{9 + idx // 60:02d}:{idx % 60:02d}:00Z',
                         app_version='1.0.0', region='ES', properties=props)
            events.append(event)
            return event
        add('u1', 0, 'install', 'engagement', {'source': 'organic'})
        add('u1', 0, 'session_start', 'engagement', {'source': 'organic'})
        add('u1', 0, 'feature_used', 'engagement', {'feature': features[0]})
        purchase = add('u1', 1, 'purchase', 'financial', {'transaction_id': app + '-tx1', 'amount_usd': str(index * 10), 'currency': 'USD'})
        add('u1', 3, 'renewal', 'financial', {'transaction_id': app + '-tx2', 'amount_usd': str(index * 10), 'currency': 'USD'})
        add('u1', 4, 'refund', 'financial', {'transaction_id': app + '-refund1', 'original_transaction_id': app + '-tx1', 'amount_usd': '2.00', 'currency': 'USD'})
        add('u1', days - 1, 'feature_used', 'engagement', {'feature': features[0], 'duration_ms': 300})
        add('u2', 1, 'install', 'engagement', {'source': 'paid'})
        add('u2', 1, 'session_start', 'engagement', {})
        add('u2', 1, 'feature_used', 'engagement', {'feature': features[1], 'duration_ms': 900})
        add('u3', days - 1, 'install', 'engagement', {'source': 'referral'})
        add('u3', days - 1, 'feature_used', 'engagement', {'feature': features[1]})
        add('u3', days - 1, 'purchase', 'financial', {'transaction_id': app + '-tx3', 'amount_usd': '5.00', 'currency': 'USD'})
        add('u1', 2, 'llm_call', 'backend', {'provider': 'synthetic', 'model': 'mini', 'input_tokens': 1000, 'output_tokens': 100, 'cost_usd': '0.01'})
        llm = add('u3', days - 1, 'llm_call', 'backend', {'provider': 'synthetic', 'model': 'pro', 'input_tokens': 2000, 'output_tokens': 200, 'cost_usd': '0.02'})
        add('u3', days - 1, 'backend_cost', 'backend', {'provider': 'synthetic', 'component': 'api', 'cost_usd': '0.03'})
        add('u3', days - 1, 'backend_error', 'backend', {'component': 'api', 'code': 503})
        add('u3', days - 1, 'request_latency', 'backend', {'component': 'api', 'latency_ms': 120})
        add('u3', days - 1, 'export_completed', 'engagement', {'format': 'pdf', 'parts': [index, 'custom'], 'paid': True})
        # Duplicates carry the SAME immutable ID and content.
        events.extend([purchase.copy(), llm.copy()])
    random.Random(seed).shuffle(events)
    return events, apps


def oracle(events, start, end):
    """Expected rows for events in publication order; first app/event identity wins.

    This models the warehouse after the earliest delivery has materialized.
    The actual pre-materialization tie-breaker is (publish_time, message_id),
    not a guarantee about HTTP request or Pub/Sub delivery order.
    """
    start, end = date.fromisoformat(str(start)), date.fromisoformat(str(end))
    # Input events are in publication order for conflict scenarios. Once an
    # identity is materialized, later deliveries must not replace its value.
    # The seeded fixture shuffles only identical duplicates, so order is inert.
    unique = {}
    for event in events:
        unique.setdefault((event['app_id'], event['event_id']), event)
    by_day, by_user = defaultdict(list), defaultdict(list)
    for e in unique.values():
        day = date.fromisoformat(e['event_time'][:10])
        by_day[(e['app_id'], day)].append(e)
        if e.get('user_id'):
            by_user[(e['app_id'], e['user_id'])].append(e)
    result = {name: [] for name in ('daily', 'features', 'costs', 'events', 'lifecycle', 'compare')}
    for (app, day), rows in sorted(by_day.items()):
        if not start <= day <= end:
            continue
        base = dict(metric_date=str(day), app_id=app)
        money = [e for e in rows if e['event_name'] in ('purchase', 'renewal')]
        backend = [e for e in rows if e['event_category'] == 'backend']
        reported = [e for e in backend if e['event_name'] != 'llm_call' and 'cost_usd' in e['properties']]
        llm_calls = [e for e in rows if e['event_name'] == 'llm_call']
        llm_reported = [Decimal(str(e['properties']['cost_usd'])) for e in llm_calls if 'cost_usd' in e['properties']]
        llm_cost = str(sum(llm_reported)) if llm_reported else (None if llm_calls else '0')
        revenue = sum((Decimal(str(e['properties']['amount_usd'])) * (-1 if e['event_name'] == 'refund' else 1)
                       for e in rows if e['event_name'] in ('purchase', 'renewal', 'refund')), Decimal(0))
        daily = dict(base, dau=len({e['user_id'] for e in rows if e['event_category'] == 'engagement' and e.get('user_id')}),
                     paying_users=len({e['user_id'] for e in money if e.get('user_id')}), purchases=len(money), revenue_usd=str(revenue),
                     feature_events=sum(e['event_name'] == 'feature_used' for e in rows),
                     llm_calls=sum(e['event_name'] == 'llm_call' for e in rows),
                     llm_cost_usd=llm_cost,
                     backend_errors=sum(e['event_name'] == 'backend_error' for e in rows),
                     backend_cost_usd=str(sum((Decimal(str(e['properties']['cost_usd'])) for e in reported), Decimal(0))) if reported else None,
                     backend_cost_events=len(reported))
        result['daily'].append(daily)
        for kind, keyfn, selected in [
            ('features', lambda e: (e['properties'].get('feature') or 'unknown',), [e for e in rows if e['event_name'] == 'feature_used']),
            ('events', lambda e: (e['event_name'], e['event_category']), rows),
            ('costs', lambda e: ('llm' if e['event_name'] == 'llm_call' else 'backend', e['properties'].get('provider', 'unknown'),
                                e['properties'].get('model', 'unknown') if e['event_name'] == 'llm_call' else 'not_applicable', e['properties'].get('component', 'unknown')), backend),
        ]:
            groups = defaultdict(list)
            for e in selected:
                groups[keyfn(e)].append(e)
            for key, group in groups.items():
                row = dict(base, events=len(group))
                if kind == 'costs':
                    row.update(zip(('cost_kind', 'provider', 'model', 'component'), key))
                    costs = [Decimal(str(e['properties']['cost_usd'])) for e in group if 'cost_usd' in e['properties']]
                    row.update(cost_records=len(costs), cost_usd=str(sum(costs)) if costs else None,
                               token_reported_calls=sum(e['event_name'] == 'llm_call' and all(k in e['properties'] for k in ('input_tokens', 'output_tokens')) for e in group))
                    for field in ('input_tokens', 'output_tokens'):
                        tokens = [e['properties'][field] for e in group if e['event_name'] == 'llm_call' and field in e['properties']]
                        row[field] = sum(tokens) if tokens else None
                else:
                    row.update(zip(('feature',) if kind == 'features' else ('event_name', 'event_category'), key))
                    row['users'] = len({e['user_id'] for e in group if e.get('user_id')})
                result[kind].append(row)
    for day_offset in range((end - start).days + 1):
        day = start + timedelta(days=day_offset)
        snapshots = defaultdict(list)
        for (app, user), rows in by_user.items():
            installs = [e for e in rows if e['event_name'] == 'install' and date.fromisoformat(e['event_time'][:10]) <= day]
            if not installs:
                continue
            install = min(e['event_time'] for e in installs)
            available = [e for e in rows if install <= e['event_time'] and date.fromisoformat(e['event_time'][:10]) <= day]
            engaged = sorted(date.fromisoformat(e['event_time'][:10]) for e in available if e['event_category'] == 'engagement' and e['event_name'] != 'install')
            paid = sorted(date.fromisoformat(e['event_time'][:10]) for e in available if e['event_name'] in ('purchase', 'renewal'))
            installed = date.fromisoformat(install[:10])
            snapshots[app].append(dict(new=installed == day, activated=bool(engaged) and engaged[0] == day,
                                       paid=bool(paid) and paid[0] == day, engaged=bool(engaged), ever_paid=bool(paid),
                                       inactive=(day - (engaged[-1] if engaged else installed)).days >= 7))
        for app, states in snapshots.items():
            result['lifecycle'].append(dict(metric_date=str(day), app_id=app, new_installs=sum(s['new'] for s in states), installed_users=len(states),
                activated_users=sum(s['activated'] for s in states), first_payers=sum(s['paid'] for s in states),
                engaged_installed_users=sum(s['engaged'] for s in states), paid_installed_users=sum(s['ever_paid'] for s in states), inactive_7d_users=sum(s['inactive'] for s in states)))
    for app in sorted({e['app_id'] for e in events}):
        daily = [r for r in result['daily'] if r['app_id'] == app]
        row = dict(app_id=app)
        for field in ('revenue_usd', 'purchases', 'feature_events', 'llm_cost_usd', 'llm_calls', 'backend_errors', 'backend_cost_usd', 'backend_cost_events'):
            # A day without LLM calls contributes zero, but must not turn an
            # unreported LLM cost on another day into a false reported zero.
            llm_days = [r for r in daily if r['llm_calls'] > 0] if field == 'llm_cost_usd' else []
            selected = llm_days if llm_days else daily
            vals = [Decimal(str(r[field])) for r in selected if r[field] is not None]
            row[field] = str(sum(vals)) if vals else None
        row['active_user_days'] = sum(r['dau'] for r in daily)
        row['average_dau'] = str(Decimal(row['active_user_days']) / Decimal((end - start).days + 1)) if daily else None
        result['compare'].append(row)
    return result
