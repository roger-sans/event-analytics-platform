# Reference architecture and trade-offs

This private project illustrates several choices for an event-analytics system:

1. **Flexible event envelope.** Typed shared attributes plus variable event-specific
   properties allow different fictional apps to report heterogeneous telemetry. The
   flexibility makes typed downstream metrics and schema evolution more involved.
2. **At-least-once delivery.** HTTP accepts validated events; Pub/Sub may deliver more
   than once. Analytics must deduplicate stable `(app_id, event_id)` identifiers
   before financial aggregation.
3. **BigQuery storage.** Event-date partitions and app/event clustering support
   constrained queries. Their real-world impact depends on workload and table size.
4. **Precomputed serving metrics.** Daily aggregates reduce repeated scans, at the
   cost of refresh work, storage, scheduling, and data freshness trade-offs.
5. **Bounded response caching.** Per-process cache and coalescing may reduce repeated
   API traffic, but are not a distributed cache or a production SLA.
6. **User lifecycle.** Install/engagement/payment/inactivity examples are descriptive
   proxies; inactivity alone is not confirmed customer churn.

This is an offline reference. No cloud service is required or provisioned by the
repository. Cloud code and SQL are retained as implementation examples only.
