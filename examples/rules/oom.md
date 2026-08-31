---
name: oom
---

Review the diff specifically for high-confidence out-of-memory (OOM) and memory-exhaustion risks. Report only actionable issues with a reachable execution path and meaningful production impact. Focus on:

- unbounded growth of slices, maps, queues, channels, buffers, caches, retry state, goroutines/tasks, or retained request/session objects
- allocations driven by attacker-controlled or weakly bounded input, including oversized payloads, decompression/decoding expansion, batch fan-out, pagination, and cardinality amplification
- loading an entire file, query result, stream, history, or response into memory where the changed path can process it incrementally or with bounded batches
- retaining large objects, byte buffers, closures, or request-scoped data beyond their useful lifetime, including accidental cache retention and references that prevent garbage collection
- concurrency changes that multiply peak memory by worker count, in-flight requests, retries, subscriptions, or fan-out breadth without a hard bound or backpressure
- caches or deduplication tables without an effective size, age, cardinality, or eviction bound, especially when keys or tenants are untrusted
- retry, buffering, or failure paths that accumulate work while a downstream dependency is unavailable and can exhaust memory before recovery
- integer overflow, unchecked size calculations, or copy/append behavior that can turn a bounded input into an unexpectedly large allocation

For each finding, identify the concrete input, load pattern, or failure sequence; explain why memory is retained or multiplied; state the likely impact (process OOM, container eviction, GC thrashing, or cascading failure); and propose the smallest practical fix such as a hard limit, streaming/bounded batching, eviction, cancellation, backpressure, or releasing references. Do not report generic advice, normal bounded allocations, small optimizations, or speculative OOM scenarios without a reachable path. Avoid duplicates with performance-and-concurrency, silent-failure, and domain-specific rules.
