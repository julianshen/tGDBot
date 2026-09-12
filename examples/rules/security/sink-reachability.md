---
name: sink-reachability
applies_to:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.mts"
  - "**/*.cts"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.mjs"
  - "**/*.cjs"
  - "**/*.py"
  - "**/*.go"
  - "**/*.rs"
  - "**/*.java"
  - "**/*.rb"
  - "**/*.php"
---

You are looking for one thing: a value an attacker can influence reaching an
operation that trusts it.

Report a CANDIDATE, not a verdict. Whether the path is actually reachable,
whether an attacker really controls the value, and how severe it is are decided
afterwards by a separate stage with evidence you do not have. Your job is to
find the pairing and say precisely where both halves are.

## What counts

The sink matters more than the vocabulary. Any of these, in any language:

- **Query construction** — SQL, NoSQL filters, ORM raw fragments, LDAP, XPath,
  GraphQL built by string assembly rather than by parameter binding.
- **Command and process execution** — a shell string, `exec`, `system`,
  `Runtime.exec`, a subprocess argument list whose elements come from input.
- **Deserialization and parsing** — pickle, YAML with arbitrary tags, Java
  readObject, PHP unserialize, any parser given attacker bytes with types it
  will instantiate.
- **Path and file handling** — a filename, an archive entry, an upload
  destination, a template path joined from input.
- **Template and markup rendering** — HTML, server-side templates, anything
  that can carry script or directives into an interpreter.
- **Outbound requests** — a URL, a host, a redirect target, a webhook
  destination assembled from input.

## What does not count

- A value the code constructs entirely itself, with no input reaching it.
- Input that passes through a parameterised API — a bound query parameter, an
  argument-array subprocess call, an escaping template engine — where the
  library, not the string, decides the boundary.
- A defect that is a bug but not a security one. Report those under whatever
  rule covers correctness; a security finding that turns out to be an ordinary
  bug trains readers to skip the section.
- Test fixtures and example code whose whole purpose is to demonstrate the
  unsafe form.

## What a good finding says

Name **both ends and the path between them**: where the value enters, where it
is used, and what it passes through on the way. "This builds SQL by
concatenation" is half a finding. "`req.params.id` reaches the `WHERE` clause at
line 40 through `buildFilter`, with no binding in between" is one.

Quote the constructing expression in `existingCode`. If a sanitiser or
validator is present but you believe it is insufficient, say which one and why —
a finding that ignores a guard the author wrote reads as though you did not see
it.

Set `severity` to what the defect deserves **if the path is reachable**. Do not
discount it for being hard to reach; that judgement is made later, with
evidence.
