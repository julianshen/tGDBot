// Entry point for the single-file binary (`npm run build:binary`).
//
// A compiled binary has no directory to read the vendored markdown out of:
// `import.meta.url` resolves into Bun's virtual filesystem, so the reads fail
// and the tool starts with zero rules loaded — which aborts every review, and
// with no restricted `reviewer` agent to seed, which is the ADR-003 guarantee
// that the dispatched subagent has no bash/edit/write.
//
// Bun embeds both files at build time through the text import, and they are
// handed to the same seam the Node build reads from disk. This runs BEFORE
// `cli.js` is imported, so nothing can observe a half-populated registry.
//
// Deliberately outside `src/`: `with { type: "text" }` is a bundler feature
// that `tsc` cannot resolve, and putting it in the compiled tree would break
// `npm run build` for the sake of a build variant. It is therefore not covered
// by the type-check — kept to a handful of lines for that reason.
import builtinRule from "../src/rules/builtin/tgd-review.md" with { type: "text" };
import reviewerAgent from "../src/review/builtin-agents/reviewer.md" with { type: "text" };
import { provideVendoredAsset } from "../src/vendored-assets.js";

provideVendoredAsset("builtin-rule", builtinRule);
provideVendoredAsset("reviewer-agent", reviewerAgent);

// `main()` is called EXPLICITLY rather than relying on `cli.ts`'s direct-run
// guard. That guard compares `import.meta.url` to `file://${process.argv[1]}`,
// which holds by luck on macOS and Linux inside a binary and is false on
// Windows, where argv[1] is a filesystem path and the module URL is a
// normalized, percent-encoded file URL — so the advertised windows-x64 binary
// would start and exit without reviewing anything (Codex review of PR #137).
const { main } = await import("../src/cli.js");
process.exitCode = await main(process.argv.slice(2));
