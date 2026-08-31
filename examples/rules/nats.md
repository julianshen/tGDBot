---
name: nats
---

Review the diff specifically for NATS correctness and operational safety. Report only high-confidence, actionable findings with a concrete execution path. Check:

- subject construction and token boundaries, including accidental wildcard semantics, malformed or unvalidated IDs, cross-tenant/room routing, and incorrect use of `*` versus `>`
- request/reply behavior: missing responders, timeouts, inbox correlation, nil or malformed replies, reply errors, and whether failures are propagated instead of reported as success
- queue groups versus fan-out subscriptions, unintended competing consumers, duplicate delivery, and assumptions about ordering or exactly-once processing
- JetStream consumers and messages when present: ack/ack-sync/NAK/term semantics, AckWait, MaxDeliver, redelivery, durable/ephemeral identity, replay, and idempotency
- publish/consume ordering around database transactions, outbox state, retries, and cross-site replication
- subscription lifecycle: drain/unsubscribe, reconnect and resubscription, shutdown, handler leaks, and whether pending work can finish safely
- backpressure and resource limits: pending messages/bytes, slow consumers, unbounded concurrency, request fan-out, and timeout/cancellation propagation
- connection readiness, reconnect behavior, flush/error handling, and whether messages can be silently lost during connection transitions

For each finding, identify the relevant subject/consumer/lifecycle or interleaving, the concrete impact, and a minimal fix. Do not report generic NATS best practices, speculative ordering concerns without a reachable path, or issues outside the changed NATS behavior. Avoid duplicates with other rules.
