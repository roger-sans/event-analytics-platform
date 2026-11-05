#!/usr/bin/env python3
"""Tests that require no third-party Python packages."""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('generate_events.py')

class GeneratorTests(unittest.TestCase):
    def test_seed_reproducibility_and_duplicates(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp) / 'a.ndjson', Path(tmp) / 'b.ndjson'
            for dest in (a, b):
                subprocess.run([sys.executable, str(SCRIPT), '--seed', '24', '--count', '300',
                                '--duplicate-rate', '0.25', '--invalid-rate', '0.1',
                                '--output', str(dest)], check=True, capture_output=True)
            self.assertEqual(hashlib.sha256(a.read_bytes()).hexdigest(), hashlib.sha256(b.read_bytes()).hexdigest())
            rows = [json.loads(row) for row in a.read_text().splitlines()]
            valid = [row for row in rows if 'event_id' in row]
            self.assertEqual(len({x['event_id'] for x in valid}), 300)
            self.assertEqual({x['app_id'] for x in valid}, {'budgetbee', 'storyhub', 'museai'})
            self.assertGreater(len(valid), 300)  # seeded duplicate injection
            self.assertGreater(len(rows), len(valid))  # malformed injection

if __name__ == '__main__':
    unittest.main()
