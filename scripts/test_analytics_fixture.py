import json
from datetime import date, timedelta
import unittest

from analytics_fixture import build_fixture, oracle


class CoherentFixtureTests(unittest.TestCase):
    def setUp(self):
        self.start = date(2026, 10, 1)
        self.events, self.apps = build_fixture(42, self.start)
        self.expected = oracle(self.events, self.start, self.start + timedelta(days=9))

    def test_seed_reproducibility_identity_and_three_app_kinds(self):
        self.assertEqual(self.events, build_fixture(42, self.start)[0])
        self.assertEqual(len(self.apps), 3)
        self.assertEqual(len(self.events), 63)
        self.assertEqual(len({(e['app_id'], e['event_id']) for e in self.events}), 57)
        for app in self.apps:
            rows = [e for e in self.events if e['app_id'] == app]
            installs = {e['user_id']: e['event_time'] for e in rows if e['event_name'] == 'install'}
            self.assertTrue(all(e['event_time'] >= installs[e['user_id']] for e in rows))
            refund = next(e for e in rows if e['event_name'] == 'refund')
            self.assertTrue(any(e['properties'].get('transaction_id') == refund['properties']['original_transaction_id'] for e in rows))

    def test_reactivation_and_inactivity_threshold_are_as_of_date(self):
        rows = [r for r in self.expected['lifecycle'] if r['app_id'] == self.apps[0]]
        keyed = {r['metric_date']: r for r in rows}
        self.assertEqual(keyed['2026-10-07']['inactive_7d_users'], 0)
        self.assertEqual(keyed['2026-10-08']['inactive_7d_users'], 1)
        self.assertEqual(keyed['2026-10-09']['inactive_7d_users'], 2)
        self.assertEqual(keyed['2026-10-10']['inactive_7d_users'], 1)
        final = keyed['2026-10-10']
        self.assertEqual(final['installed_users'], 3)
        self.assertEqual(final['new_installs'], 1)
        self.assertEqual(final['activated_users'], 1)
        self.assertEqual(final['first_payers'], 1)
        self.assertEqual(final['paid_installed_users'], 2)

    def test_money_tokens_and_unreported_costs_are_not_conflated(self):
        period = {r['app_id']: r for r in self.expected['compare']}
        self.assertEqual([period[a]['revenue_usd'] for a in self.apps], ['23.00', '43.00', '63.00'])
        costs = [r for r in self.expected['costs'] if r['metric_date'] == '2026-10-10']
        llm = [r for r in costs if r['cost_kind'] == 'llm']
        self.assertTrue(all(r['events'] == 1 and r['input_tokens'] == 2000 and r['cost_usd'] == '0.02' for r in llm))
        unknown = [r for r in costs if r['cost_records'] == 0]
        self.assertTrue(unknown)
        self.assertTrue(all(r['cost_usd'] is None for r in unknown))
        exports = [r for r in self.expected['events'] if r['event_name'] == 'export_completed']
        self.assertEqual(len(exports), 3)
        self.assertTrue(all(r['events'] == 1 for r in exports))

    def test_llm_usage_without_cost_preserves_tokens_and_unknown_cost(self):
        # Simulate the brief's token-only llm_call without changing seed fixtures.
        # Both unique LLM calls for app A lose cost, while the other apps keep it.
        events = []
        for e in self.events:
            copy = dict(e, properties=dict(e['properties']))
            if e['app_id'] == self.apps[0] and e['event_name'] == 'llm_call':
                copy['properties'].pop('cost_usd', None)
            events.append(copy)
        expected = oracle(events, self.start, self.start + timedelta(days=9))
        app = self.apps[0]
        llm_days = [r for r in expected['daily'] if r['app_id'] == app and r['llm_calls'] > 0]
        self.assertEqual(len(llm_days), 2)
        self.assertTrue(all(r['llm_cost_usd'] is None for r in llm_days))
        other_days = [r for r in expected['daily'] if r['app_id'] == app and r['llm_calls'] == 0]
        self.assertTrue(all(r['llm_cost_usd'] == '0' for r in other_days))
        compare = next(r for r in expected['compare'] if r['app_id'] == app)
        self.assertIsNone(compare['llm_cost_usd'])
        llm_groups = [r for r in expected['costs'] if r['app_id'] == app and r['cost_kind'] == 'llm']
        self.assertEqual(len(llm_groups), 2)
        self.assertTrue(all(r['cost_records'] == 0 and r['cost_usd'] is None for r in llm_groups))
        self.assertEqual(sum(r['input_tokens'] for r in llm_groups), 3000)
        self.assertEqual(sum(r['output_tokens'] for r in llm_groups), 300)

        # Restore pricing for just the first LLM identity (and its identical
        # replay if present): only known values contribute to reported cost.
        priced_id = next(e['event_id'] for e in self.events
                         if e['app_id'] == app and e['event_name'] == 'llm_call'
                         and e['properties']['cost_usd'] == '0.01')
        for e in events:
            if e['app_id'] == app and e['event_id'] == priced_id:
                e['properties']['cost_usd'] = '0.01'
        partial = oracle(events, self.start, self.start + timedelta(days=9))
        row = next(r for r in partial['compare'] if r['app_id'] == app)
        self.assertEqual(row['llm_cost_usd'], '0.01')
        groups = [r for r in partial['costs'] if r['app_id'] == app and r['cost_kind'] == 'llm']
        self.assertEqual(sum(r['cost_records'] for r in groups), 1)
        self.assertEqual(sum(r['events'] for r in groups), 2)
        self.assertEqual(sum(r['input_tokens'] for r in groups), 3000)

    def test_missing_install_does_not_create_a_false_cohort(self):
        events = [e for e in self.events if e['event_name'] != 'install']
        expected = oracle(events, self.start, self.start + timedelta(days=9))
        self.assertEqual(expected['lifecycle'], [])
        self.assertTrue(expected['daily'])


if __name__ == '__main__':
    unittest.main()
