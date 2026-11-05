"""Contract-level regressions for immutable identity and event-time attribution.

These are pure Python oracle checks. They do not claim to execute BigQuery SQL.
"""
import copy
from datetime import date
import unittest

from analytics_fixture import oracle


START = date(2026, 10, 21)
END = date(2026, 10, 23)
SHARED_ID = '98a591ab-d53e-4ec2-94d5-02e768ee7ef4'


def event(app, name, category, day, amount=None, event_id=SHARED_ID):
    properties = {} if amount is None else {
        'transaction_id': app + '-tx-001', 'amount_usd': amount, 'currency': 'USD'
    }
    return dict(
        schema_version=1, event_id=event_id, app_id=app,
        user_id=app + '-user-1', event_name=name, event_category=category,
        event_time=day + 'T12:00:00Z', properties=properties,
    )


def daily_rows(snapshot):
    return {(row['app_id'], row['metric_date']): row for row in snapshot['daily']}


def comparison(snapshot):
    return {row['app_id']: row for row in snapshot['compare']}


class EventEdgeCaseTests(unittest.TestCase):
    def test_conflicting_replay_cannot_overwrite_materialized_purchase(self):
        first = event('edge_a', 'purchase', 'financial', '2026-10-21', '9.99')
        conflict = copy.deepcopy(first)
        conflict['properties']['amount_usd'] = '99.99'
        before = oracle([first], START, END)
        after = oracle([first, conflict], START, END)
        self.assertEqual(after, before)
        row = daily_rows(after)[('edge_a', '2026-10-21')]
        self.assertEqual((row['revenue_usd'], row['purchases']), ('9.99', 1))
        self.assertEqual(comparison(after)['edge_a']['revenue_usd'], '9.99')
        # This oracle takes publication order, not the largest/last amount.
        reverse = oracle([conflict, first], START, END)
        self.assertEqual(daily_rows(reverse)[('edge_a', '2026-10-21')]['revenue_usd'], '99.99')

    def test_same_uuid_in_different_apps_represents_two_facts(self):
        a = event('edge_a', 'purchase', 'financial', '2026-10-21', '9.99')
        b = event('edge_b', 'purchase', 'financial', '2026-10-21', '5.00')
        self.assertEqual(a['event_id'], b['event_id'])
        snapshot = oracle([a, b], START, END)
        rows = daily_rows(snapshot)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[('edge_a', '2026-10-21')]['revenue_usd'], '9.99')
        self.assertEqual(rows[('edge_b', '2026-10-21')]['revenue_usd'], '5.00')
        self.assertEqual(sum(r['purchases'] for r in rows.values()), 2)

    def test_late_purchase_updates_event_date_not_arrival_date(self):
        original = event('edge_a', 'purchase', 'financial', '2026-10-22', '4.00',
                         event_id='1a112e85-108c-4b7b-9c79-492c093c5316')
        late = event('edge_a', 'purchase', 'financial', '2026-10-21', '2.50',
                     event_id='0f125485-ae74-4316-9e1d-41cf01132818')
        # The late event arrives on Oct 23 but occurred on Oct 21.
        before = oracle([original], START, END)
        after = oracle([original, late], START, END)
        rows = daily_rows(after)
        self.assertNotIn(('edge_a', '2026-10-21'), daily_rows(before))
        self.assertEqual(rows[('edge_a', '2026-10-21')]['revenue_usd'], '2.50')
        self.assertEqual(rows[('edge_a', '2026-10-22')]['revenue_usd'], '4.00')
        self.assertNotIn(('edge_a', '2026-10-23'), rows)
        self.assertEqual(comparison(after)['edge_a']['revenue_usd'], '6.50')
        self.assertEqual(oracle([original, late, late], START, END), after)


if __name__ == '__main__':
    unittest.main()
