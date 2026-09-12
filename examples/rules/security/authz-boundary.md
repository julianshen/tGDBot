---
name: authz-boundary
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

You are looking for one thing: an operation that acts on someone's data or
privileges without establishing that the caller is entitled to it.

Report a CANDIDATE, not a verdict. Whether the operation is actually reachable
and by whom is decided afterwards by a separate stage with evidence you do not
have.

## What counts

- **Missing ownership checks** — a record fetched or mutated by an identifier
  from the request, with nothing tying that identifier to the caller. This is
  the commonest real one, and the easiest to read past.
- **Tenant boundaries** — a query scoped by an id the caller supplied rather
  than by the tenant the session belongs to.
- **Privilege escalation** — a field that sets a role, a plan, a quota, or an
  ownership relation, accepted from a request body that a non-admin can send.
- **Inconsistent enforcement** — a guard applied on one route of a pair, or
  applied on read and not on write. The asymmetry is itself the evidence.
- **Auth bypass shapes** — a check whose failure path continues, a comparison
  that treats a missing value as a match, a decision made before a value that
  can change it is parsed.

## What does not count

- A route you cannot see the registration for, where a guard may be applied by
  middleware, a decorator, or a framework convention. Say so as a candidate
  ONLY if something in the diff suggests the guard is absent; do not report
  every handler in a codebase whose routing you cannot read.
- Defence in depth you would prefer. A second check that would be nice is not a
  missing check.
- Administrative code paths that are documented as trusted and are not exposed.

## What a good finding says

Name **the resource, the identifier, and the check that is missing**. "This does
not check authorization" is not actionable. "`updateInvoice` loads the invoice
by `req.body.invoiceId` and never compares its `organizationId` to
`session.organizationId`, so any signed-in user can modify any organization's
invoice" is.

If the codebase has an established authorization helper, name it and say that
this path does not use it. A finding that proposes a bespoke check where a
house helper exists will be ignored, correctly.

Set `severity` to what the defect deserves **if the path is reachable**. The
reachability judgement is made later, with evidence.
