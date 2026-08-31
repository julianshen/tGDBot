---
name: nats-large-payload
---

Review the diff specifically for NATS messages that carry large payloads (128 KB or more). Report findings only when there is a concrete path to a payload that reaches or exceeds that size — do not speculate about "future growth potential" or hypothetical scale. Focus on:

- NATS publish/subscribe calls (`nc.Publish`, `nc.PublishMsg`, `js.Publish`, `js.PublishMsg`, `nc.Request`, `nc.RespondMsg`, `nats.Msg.Data`) where the payload being published contains an entire struct, document, file buffer, or large blob — especially if the payload includes full Mongo/Cassandra documents, file bytes, image data, or serialized multi-KB structs
- handlers/subscriptions that decode a full `nats.Msg` into a struct and then immediately discard most of its fields (the handler is paying serialization + memory cost for data it doesn't use — either slice the payload at the publisher or use a projection on the DB read)
- request/reply patterns where a handler sends back a large response body (>128 KB) that the caller only reads one or two fields from (unnecessary wire traffic + deserialization on every consumer)
- batch or fan-out publish loops that publish N large payloads sequentially — N × 128 KB+ per payload means the consumer's pending message buffer grows linearly, risking slow-consumer errors
- JetStream publish calls with large payloads that lack `Compression` or chunking — NATS 2.10+ JetStream supports `Compression` option; if the diff publishes >128 KB documents without it, flag it

When a publish/subscribe call uses a payload that is demonstrably small (e.g. known scalars, IDs, small validated structs that serialise to <128 KB), do not report it even if it matches the above patterns — the rule targets only payloads that are large enough to cause measurable memory or wire overhead. When in doubt, estimate conservatively: a struct with >20 BSON/JSON fields or a slice that grows with user data (rooms, members, subscriptions) is likely over 128 KB under load; a struct with 3–5 IDs or scalars is not.

For each finding:
- identify the exact publish/subscribe call site and the payload type or estimated size
- describe the concrete impact: consumer-side OOM risk, slow-consumer disconnection, unnecessary serialization latency, or fan-out memory pressure
- suggest a minimal fix: use a reference (e.g. object store key) instead of inlining the payload, slice the payload to only the fields the consumer needs via a projected DB read, add JetStream compression, or split into smaller chunked messages
- cite the payload type or struct tag set that led to the estimate

Do not report generic "NATS has a 1 MB max payload" warnings, speculative concerns about unknown payload sizes, or issues outside the changed publish/subscribe behavior. Avoid duplicates with the `nats` and `performance-and-concurrency` rules — if those rules already flag a slow consumer or backpressure issue at the same site, skip it here.