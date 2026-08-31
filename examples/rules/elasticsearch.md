---
name: elasticsearch
---

Review the diff specifically for Elasticsearch correctness, search behavior, and operational risks. Report only high-confidence, actionable findings with a concrete execution path. Check:

- index mappings, field types, analyzers/normalizers, dynamic mapping, mapping explosion, nested versus object semantics, and compatibility with existing indexed documents
- query correctness: analyzed versus keyword fields, exact matching, sorting, missing/null behavior, nested queries, filters, scoring, highlighting, and accidental broad or expensive queries
- index lifecycle and deployments: aliases, read/write alias swaps, rollover, reindex, versioned indexes, templates, migrations, and whether old/new mappings remain compatible during rolling deploys
- write behavior: refresh visibility, optimistic concurrency/version conflicts, partial updates, upserts, deletes, retry semantics, idempotency, and whether failures are surfaced instead of treated as success
- bulk requests: item-level failures, response inspection, retry/backoff, partial success, request sizing, memory use, and duplicate writes
- pagination and result stability: deep paging limits, `search_after`, point-in-time (PIT), stable tie-breaker sorts, concurrent updates/deletes, and duplicate or skipped hits
- shard/replica and consistency assumptions, routing, hot shards, unbounded result/aggregation sizes, cardinality, bucket growth, and circuit-breaker/resource exhaustion paths
- refresh, translog, durability, and read-after-write expectations when the feature depends on immediate search visibility
- ingest pipelines, scripts, runtime fields, source filtering, stored fields, and security-sensitive data leakage through indexed content or `_source`
- client, response, cursor/PIT, cancellation, timeout, connection-pool, and resource lifecycle management

For each finding, identify the affected index/query/request or lifecycle and the concrete data or operational impact, then suggest a minimal fix. Do not report generic Elasticsearch best practices, speculative scale concerns without a reachable workload path, or issues outside the changed Elasticsearch behavior. Avoid duplicates with other rules.
