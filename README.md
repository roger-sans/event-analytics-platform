# Event Analytics Platform

**Status: Private reference implementation / archived cloud deployment.**

An educational example of an event analytics architecture for fictional mobile apps,
including a seeded event generator, HTTP ingestion, Pub/Sub and BigQuery integration
contracts, data modeling, and a metrics-serving API.

## Conceptual architecture

```text
Synthetic mobile events (Python)
             |
      HTTP ingestion (Node.js)
             |
         Pub/Sub
             |
  BigQuery raw / deduplicated events
             |
       Daily aggregates
             |
       Analytics API
             |
  BI dashboard (conceptual only)
```

## Contents

- `scripts/generate_events.py`: reproducible synthetic event generator.
- `service/src/`: ingestion and analytics-serving reference code.
- `service/test/`: local JavaScript tests.
- `infra/sql/`: sample BigQuery layouts and transformations.
- `docs/architecture.md`: design trade-offs and limitations.

## Offline exploration

```bash
python3 scripts/generate_events.py --seed 42 --count 500 --output events.ndjson
npm ci --prefix service
npm test --prefix service
python3 -m unittest discover -s scripts -p 'test_*.py'
```

These commands only generate local events and run local tests. They do **not**
deploy infrastructure. `service/src/index.js` uses cloud SDKs and needs a separate,
explicitly provisioned environment to run with real GCP services; do not launch
it unless intended. No live endpoints, GCP projects, credentials, billing accounts,
or external dashboard connections are included in this repository.

## Boundaries

- All app names and event data are synthetic.
- Source code is a reference, not a certified production platform.
- No production credentials or original evaluation reports are included. Keep this
  reference private; sanitizing names does not remove confidentiality obligations.
- BigQuery SQL uses explicit placeholder project identifiers where relevant.
- Local tests do not certify cloud deployment, billing, scalability, or SLAs.
