#!/usr/bin/env python3
"""Generate reproducible mobile-app events; standard library only."""
import argparse
import json
import random
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

APPS = ("budgetbee", "storyhub", "museai")
REGIONS = ("ES", "US", "GB", "DE", "FR")
FEATURES = {"budgetbee": ("budget", "spending_chart", "notifications"),
            "storyhub": ("article", "bookmark", "share"),
            "museai": ("chat", "image_create", "summarize")}
EVENTS = {
    "budgetbee": ("session_start", "feature_used", "purchase", "renewal", "refund", "backend_error", "request_latency"),
    "storyhub": ("session_start", "feature_used", "purchase", "renewal", "refund", "backend_error", "request_latency"),
    "museai": ("session_start", "feature_used", "purchase", "renewal", "refund", "backend_error", "request_latency", "llm_call"),
}
WEIGHTS = {"session_start": 27, "feature_used": 40, "purchase": 7, "renewal": 3,
           "refund": 1, "backend_error": 3, "request_latency": 10, "llm_call": 9}


def make_event(rng: random.Random, idx: int, start: datetime, days: int) -> dict:
    app = APPS[idx % len(APPS)]
    name = rng.choices(EVENTS[app], weights=[WEIGHTS[n] for n in EVENTS[app]], k=1)[0]
    when = start + timedelta(seconds=rng.randrange(days * 86400))
    props = {}
    if name in ("purchase", "renewal"):
        props = {"transaction_id": f"tx-{idx:08d}", "amount_usd": rng.choice([4.99, 9.99, 19.99]), "currency": "USD"}
    elif name == "refund":
        props = {"transaction_id": f"refund-{idx:08d}", "amount_usd": 4.99, "currency": "USD"}
    elif name == "feature_used":
        props = {"feature": rng.choice(FEATURES[app]), "duration_ms": rng.randint(100, 24000)}
    elif name == "session_start":
        props = {"source": rng.choice(("organic", "paid", "referral"))}
    elif name == "backend_error":
        props = {"code": rng.choice((429, 500, 503)), "component": rng.choice(("api", "payments", "cache"))}
    elif name == "request_latency":
        props = {"route": "/v1/action", "latency_ms": rng.randint(25, 2500)}
    elif name == "llm_call":
        input_tokens = rng.randint(150, 4000)
        output_tokens = rng.randint(40, 1300)
        props = {"model": rng.choice(("quasar-mini", "quasar-pro")),
                 "input_tokens": input_tokens, "output_tokens": output_tokens,
                 "cost_usd": round(input_tokens * 0.0000005 + output_tokens * 0.0000015, 6)}
    return {
        "schema_version": 1,
        "event_id": str(uuid.UUID(int=rng.getrandbits(128), version=4)),
        "app_id": app,
        "event_name": name,
        "event_category": "financial" if name in {"purchase", "renewal", "refund"} else "engagement" if name in {"session_start", "feature_used"} else "backend",
        "user_id": f"{app}-user-{rng.randrange(1, 801):04d}",
        "event_time": when.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "app_version": f"{rng.randint(1, 3)}.{rng.randint(0, 9)}.0",
        "region": rng.choice(REGIONS),
        "properties": props,
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--seed', type=int, default=42)
    p.add_argument('--count', type=int, default=2000)
    p.add_argument('--start-date', default='2026-10-13', help='UTC YYYY-MM-DD')
    p.add_argument('--days', type=int, default=14)
    p.add_argument('--duplicate-rate', type=float, default=0.02)
    p.add_argument('--invalid-rate', type=float, default=0.01)
    p.add_argument('--output', default='events.ndjson')
    p.add_argument('--scenario', choices=['random', 'lifecycle'], default='random')
    p.add_argument('--app-prefix', default='case')
    args = p.parse_args()
    if args.count < 1 or args.days < 1 or not 0 <= args.duplicate_rate <= 1 or not 0 <= args.invalid_rate <= 1:
        p.error('count and days must be positive, rates must be between zero and one')
    start = datetime.strptime(args.start_date, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    if args.scenario == 'lifecycle':
        from analytics_fixture import build_fixture, oracle
        if args.days < 10:
            p.error('lifecycle scenario requires --days >= 10')
        if not re.fullmatch(r'[a-z][a-z0-9_]{1,40}', args.app_prefix):
            p.error('app-prefix must be lowercase snake_case, 2-41 characters')
        records, apps = build_fixture(args.seed, start.date(), args.days, args.app_prefix)
        target = Path(args.output)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(''.join(json.dumps(e, sort_keys=True) + '\n' for e in records))
        expected = oracle(records, start.date(), start.date() + timedelta(days=args.days - 1))
        target.with_suffix('.expected.json').write_text(json.dumps(expected, indent=2) + '\n')
        print(json.dumps({'seed': args.seed, 'scenario': 'lifecycle', 'apps': apps, 'records': len(records), 'unique_events': len({(e['app_id'], e['event_id']) for e in records}), 'file': str(target)}, indent=2))
        return
    rng = random.Random(args.seed)
    events = [make_event(rng, i, start, args.days) for i in range(args.count)]
    duplicates = [dict(e) for e in events if rng.random() < args.duplicate_rate]
    invalid = []
    for e in events:
        if rng.random() < args.invalid_rate:
            bad = dict(e)
            bad.pop('event_id')
            invalid.append(bad)
    records = events + duplicates + invalid
    rng.shuffle(records)
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('w', encoding='utf-8') as handle:
        for e in records:
            handle.write(json.dumps(e, separators=(',', ':'), sort_keys=True) + '\n')
    print(json.dumps({'file': str(target), 'seed': args.seed, 'unique_events': args.count,
                      'duplicates': len(duplicates), 'invalid': len(invalid), 'sent_attempts': len(records)}, indent=2))

if __name__ == '__main__':
    main()
