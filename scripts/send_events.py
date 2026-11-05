#!/usr/bin/env python3
"""Send NDJSON events to a local or deployed ingestion endpoint and count outcomes."""
import argparse
import json
import os
import urllib.request
import urllib.error
from collections import Counter
from pathlib import Path


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('file', type=Path)
    p.add_argument('--url', default='http://localhost:8080/v1/events')
    p.add_argument('--limit', type=int, default=100)
    p.add_argument('--api-key', default=os.environ.get('INGEST_API_KEY', ''))
    args = p.parse_args()
    results = Counter()
    with args.file.open(encoding='utf-8') as handle:
        for index, line in enumerate(handle):
            if index >= args.limit:
                break
            headers = {'Content-Type': 'application/json'}
            if args.api_key:
                headers['x-api-key'] = args.api_key
            request = urllib.request.Request(args.url, line.encode(), headers=headers, method='POST')
            try:
                with urllib.request.urlopen(request, timeout=15) as response:
                    results[str(response.status)] += 1
            except urllib.error.HTTPError as exc:
                results[str(exc.code)] += 1
            except urllib.error.URLError as exc:
                results['network_failure'] += 1
                print(f'network error on attempt {index + 1}: {exc}', flush=True)
                break
    print(json.dumps(dict(results), indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
