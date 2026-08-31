---
name: performance-and-concurrency
---

Review the diff specifically for high-confidence performance and concurrency problems. Report only actionable issues with a reachable execution path and meaningful impact in production. Focus on:

- data races, lost updates, unsafe shared mutable state, and incorrect synchronization
- deadlocks, lock-order inversions, starvation, blocking work on latency-sensitive paths, and goroutine/task leaks
- unbounded queues, fan-out, buffering, retries, goroutine/task creation, or memory growth under load
- duplicate concurrent work, broken singleflight/coalescing, thundering-herd behavior, and cache stampedes
- incorrect cancellation, timeout, backpressure, or shutdown handling
- accidental serialization of independent work or avoidable N+1/database/network calls when the changed path is materially affected
- pagination, batching, polling, or retry behavior that can amplify load or fail to make progress

For each finding, describe the concrete interleaving or load pattern, expected impact, and a minimal fix. Do not report speculative micro-optimizations, stylistic preferences, normal linear scans over bounded data, or concurrency concerns without a reachable race/deadlock/resource-exhaustion path. Avoid duplicates with other rules.
