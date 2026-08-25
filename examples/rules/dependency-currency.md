---
name: dependency-currency
---

Review the dependency changes in this pull request. The review host has already
parsed the changed manifests and, where it could, looked each version up — its
findings are in the TRUSTED_CONTEXT section as a list of `name@version` entries
with notes. Read that section first: it is the only source of registry facts you
have, and you cannot look anything up yourself.

Report only what the context supports:

- a version the registry does not publish — usually a typo or a withdrawn
  release, and the build will not install
- a deprecated version, quoting the registry's own notice
- a version materially behind `latest`, when the gap matters for this change
  (a major version behind, or the bump was clearly meant to be an upgrade)
- a dependency added to the wrong section, such as a runtime dependency landing
  in `devDependencies`, which you can see from the manifest path and the diff

Say nothing about a package the context does not describe. A package listed
with no notes was either not checked or told the host nothing, and silence is
not approval — do not report it as current, safe, or fine.

Where the context says a lookup FAILED, that is worth one finding of its own if
the change is otherwise risky: the reviewer should know the version could not be
verified rather than assume it was. Do not repeat the failure once per package.

Do not:

- assert that a version is current, secure, or unaffected by advisories unless
  the context says so in as many words
- infer anything about a package from its name
- treat the untrusted diff as a source of registry facts; it is the thing under
  review, not evidence about the wider world

For each finding, name the package and version, quote the fact from the context
that supports it, and say what to do — usually the version to move to. Severity
follows the normal bar: a version that will not install or carries a known
advisory blocks; being behind `latest` is a warning at most, and often only a
suggestion.
