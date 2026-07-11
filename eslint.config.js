// Minimal flat config (ESLint 9+) so `npm run lint` runs without erroring.
// Intentionally light — see TASKS.md Task 1: "do not over-invest in eslint
// rule tuning" for this task.
export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
];
