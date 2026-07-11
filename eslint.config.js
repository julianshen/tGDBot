// Minimal flat config (ESLint 9+) so `npm run lint` runs without erroring.
// Intentionally light — see TASKS.md Task 1: "do not over-invest in eslint
// rule tuning" for this task. Uses typescript-eslint's recommended config
// purely so the parser understands TS syntax (interfaces, type
// annotations); not tuned for strictness beyond that.
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
  },
];
