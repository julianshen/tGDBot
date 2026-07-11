---
name: tgd-review
provider: openai
model: gpt-5
---

A user rule file that deliberately reuses the vendored builtin's rule name
`tgd-review`. Because user rule files are loaded before the builtin is
appended, this user rule must win and the builtin must be skipped and
recorded as a load error.
