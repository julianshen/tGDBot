---
name: cassandra
---

Review the diff specifically for Apache Cassandra correctness, data-modeling, and operational risks. Report only high-confidence, actionable findings with a concrete execution path. Check:

- partition-key design, partition growth, hot partitions, clustering-key order, and whether queries match the table's primary-key shape without accidental full scans or `ALLOW FILTERING`
- consistency levels, quorum assumptions, multi-DC behavior, read/write races, stale reads, and whether the chosen level matches the correctness contract
- tombstone generation and amplification from deletes, TTLs, range deletes, overwrites, and compaction; flag unbounded tombstone or partition behavior
- pagination and paging-state handling, stable ordering, page-size/resource limits, and duplicate or skipped rows across concurrent writes
- retries, timeouts, idempotency, speculative execution, partial failures, and whether non-idempotent mutations can be applied more than once
- batches, logged batches, unlogged batches, and cross-partition writes used as if they were transactions or atomic across unrelated partitions
- lightweight transactions/CAS: contention, retry behavior, conditional-result handling, and whether the code treats an applied/not-applied result correctly
- timestamp, last-write-wins, null/unset, collection, UDT, and schema-evolution semantics that can silently overwrite or erase data
- migrations and initialization: ordering, compatibility with rolling deploys, all schema mirrors/environments, and whether old/new readers and writers can coexist safely
- prepared statements, bind types, serialized payload size, coordinator load, connection/session lifecycle, and resource cleanup

For each finding, identify the affected table/query/mutation and the concrete data or operational impact, then suggest a minimal fix. Do not report generic Cassandra best practices, speculative scale concerns without a reachable workload path, or issues outside the changed Cassandra behavior. Avoid duplicates with other rules.
