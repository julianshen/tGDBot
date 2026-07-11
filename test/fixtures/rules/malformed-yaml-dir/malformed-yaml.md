---
name: malformed-yaml
provider: [anthropic
model: claude-opus-4-5
---

This rule file has genuinely malformed YAML frontmatter (an unclosed `[`
flow-sequence on the `provider` field) and must be recorded as a load error
rather than crashing the whole `loadRules()` run.
