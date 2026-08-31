---
name: mongodb
---

Review the diff specifically for MongoDB correctness, data-modeling, and operational risks. Report only high-confidence, actionable findings with a concrete execution path. Check:

- document shape and bounded growth, BSON/document-size limits, unbounded arrays, duplication, and whether embedding versus referencing matches the access and update patterns
- query and index alignment: collection scans, missing or ineffective compound indexes, sort coverage, regex/prefix behavior, projection, aggregation stages, and accidental high-cardinality fan-out
- atomicity boundaries: single-document guarantees versus multi-document invariants, unsafe read-modify-write sequences, transactions, and whether session/transaction context is propagated to every operation
- consistency and durability: read preference, read concern, write concern, journaling, replica-set failover, stale reads, and whether settings satisfy the feature's correctness contract
- retryable writes, transient transaction errors, duplicate key races, upserts, idempotency, and whether retries can create duplicates or overwrite newer data
- update semantics: `$set` versus replacement updates, `$unset`, positional/array filters, null versus missing fields, optimistic concurrency/version checks, and accidental field loss
- pagination and ordering: stable sort keys, skip/limit degradation, range pagination, concurrent inserts/deletes, and duplicate or skipped results
- change streams and event processing: resume tokens, invalidate/rename events, reconnect behavior, duplicate delivery, ordering assumptions, backpressure, and idempotent consumers
- TTL indexes, expiration timing, soft deletes, partial/sparse indexes, schema validation, migrations, and old/new version compatibility
- connection/client/session lifecycle, cursor cleanup, timeouts, context cancellation, pool limits, and resource leaks

For each finding, identify the affected collection/query/update or lifecycle and the concrete data or operational impact, then suggest a minimal fix. Do not report generic MongoDB best practices, speculative scale concerns without a reachable workload path, or issues outside the changed MongoDB behavior. Avoid duplicates with other rules.
