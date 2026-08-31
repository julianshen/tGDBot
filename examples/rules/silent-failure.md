---
name: silent-failure
---

Review the diff specifically for silent or masked failures. Report only actionable, high-confidence findings where an error, failed operation, timeout, cancellation, rejected promise, goroutine/task failure, partial write, or exhausted retry can be ignored, converted into apparent success, acknowledged before durable completion, or hidden by logging/default values. Pay special attention to:

- ignored return values and discarded errors
- empty catch/recover blocks and logs that do not propagate the failure
- async work whose errors are never observed
- success responses, acknowledgements, or cache updates emitted before downstream work succeeds
- retry loops that stop without surfacing failure
- partial results or fallback values that conceal data loss or authorization failures
- cleanup/rollback failures that leave inconsistent state

For each finding, explain the concrete failure path, user or data impact, and a minimal fix. Do not report defensive best-effort behavior when the contract explicitly permits it, harmless observability gaps, or merely hypothetical failures without a reachable path. Avoid duplicates with other rules.
