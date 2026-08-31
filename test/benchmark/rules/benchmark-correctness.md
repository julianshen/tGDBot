---
name: benchmark-correctness
description: Correctness defects a reviewer should catch, pinned for the benchmark.
---

Report code that will fail at runtime or behave incorrectly.

Focus on:

- dereferencing a value that can be absent
- credentials, tokens or keys written into source
- a dependency moved across a major version without the caller being updated

Do NOT report:

- a change the pull request's description explains as deliberate
- work the description says is coming in a later step
- style, naming, or formatting
