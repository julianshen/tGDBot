---
name: distributed-system
---

Review the diff specifically for distributed-systems correctness and failure behavior. Report only high-confidence, actionable findings with a concrete execution path. Check:

- partial failures across services, sites, brokers, databases, and network boundaries; whether one side can succeed while the caller observes failure or timeout
- delivery guarantees, duplicate/lost messages, acknowledgement timing, retry behavior, dead-letter handling, and idempotent consumers/producers
- ordering assumptions across partitions, subjects, queues, replicas, workers, and concurrent events; whether stale or out-of-order events can overwrite newer state
- consistency contracts, read-after-write behavior, replication lag, split-brain/failover behavior, quorum assumptions, and safe degradation during partitions
- transaction boundaries and atomicity gaps between database writes and emitted events; outbox/inbox, saga compensation, and recovery after crashes
- time and identity assumptions: wall-clock skew, TTL/expiry, timestamp ordering, clock-based conflict resolution, request IDs, correlation IDs, and deduplication keys
- retries, backoff, timeout budgets, cancellation propagation, retry storms, thundering herds, and whether non-idempotent operations can be repeated
- backpressure, queue growth, fan-out amplification, resource exhaustion, and bounded work under downstream slowness or outage
- leader/lease/lock ownership, fencing, membership changes, reconnection, resubscription, and stale workers acting after ownership changes
- rolling deploy and schema/protocol compatibility between old and new producers/consumers, including mixed-version and replay behavior
- observability needed to distinguish accepted, processed, failed, retried, and permanently dropped work without masking the real outcome

For each finding, describe the concrete failure timeline or interleaving, affected state or user impact, and a minimal fix. Do not report generic distributed-systems advice, speculative failures without a reachable path, or issues already covered by a more specific database/broker rule. Avoid duplicates with other rules.
