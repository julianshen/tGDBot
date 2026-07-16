// The hermetic execution surfaces a dispatch run stands up and tears down:
// the isolated session cwd seeded with the tool-restricted `reviewer` agent
// (ADR-003), and the throwaway agent dir that carries symlinked credentials
// plus the intercom-off subagent config. Split out of dispatch.ts
// (design-review #8); dispatchRules still owns WHEN these are created,
// pointed at via PI_CODING_AGENT_DIR, and removed.
import { mkdir, mkdtemp, copyFile, symlink, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Files symlinked into the hermetic agent dir (see createIsolatedAgentDir).
// Exported because orchestrator-model.ts reads the same files through the
// same agent dir, so the names must not drift apart.
export const AUTH_FILE = "auth.json";
export const MODELS_FILE = "models.json";
export const SETTINGS_FILE = "settings.json";
const HERMETIC_AGENT_LINK_FILES = [AUTH_FILE, MODELS_FILE, SETTINGS_FILE];

// ADR-003: vendored, tool-restricted `reviewer` agent definition. Its
// frontmatter matches the shape of pi-subagents' own bundled
// agents/reviewer.md (name: reviewer, description, ...) but its `tools`
// list is `read, grep, find, ls` only — no bash/edit/write/intercom.
// Resolved relative to this module's own location (not process.cwd()) so it
// works whether running from src/ in dev (vitest) or from dist/ after
// `npm run build` — the build script copies this .md file alongside the
// compiled dispatch.js at dist/review/builtin-agents/reviewer.md (same
// pattern as src/rules/loader.ts's BUILTIN_RULE_PATH).
export const VENDORED_REVIEWER_AGENT_PATH = fileURLToPath(
  new URL("./builtin-agents/reviewer.md", import.meta.url),
);

// ADR-003 "restrict dispatched subagent tools via project-scoped agent
// override": pi-subagents' agent discovery priority is Builtin < Installed
// package < User < Project, and — per pi-subagents' own README ("Agents and
// chains") and its discoverAgents()/mergeAgentsForScope() source — "if both
// .agents/ and the project config agents directory define the same parsed
// runtime agent name, the project config directory wins." pi-subagents'
// bundled `reviewer` agent (which has bash/edit/write) is loaded at
// "builtin" priority (see BUILTIN_AGENTS_DIR in
// node_modules/pi-subagents/src/agents/agents.ts) — the LOWEST priority.
//
// So: seed a fresh, empty temp directory with `<tempDir>/.pi/agents/
// reviewer.md` (our restricted definition) and use that temp directory as
// the orchestrating session's own `cwd`. pi-subagents' `findNearestProjectRoot`
// walks up from `cwd` looking for a `.pi` (or legacy `.agents`) directory;
// since we seed `<tempDir>/.pi/agents/`, `<tempDir>/.pi` exists, so the temp
// dir itself is treated as the "project root" — making our restricted
// `reviewer` definition win project-scope discovery and shadow the bundled
// one, for every dispatched task that references `agent: "reviewer"`.
//
// Critically, this NEVER touches the actual repo being reviewed: the temp
// directory is created fresh via `os.tmpdir()` + `fs.mkdtemp`, is empty
// except for the one seeded agent file, and is removed in dispatchRules'
// `finally` block after the session completes (success or failure).
//
// This also means the orchestrating session's OWN project-local resource
// discovery (.pi/extensions, .pi/skills, .pi/prompts, AGENTS.md — see
// node_modules/@earendil-works/pi-coding-agent/docs/sdk.md's "Directories"
// section) is scoped to this empty temp dir rather than to
// process.cwd()/the target repo, so nothing under the target repo can be
// accidentally discovered as an extension/skill/prompt either — confirmed
// by reading that doc directly rather than assuming.
//
// pi-subagents' and rpiv-advisor's own extension entry points
// (additionalExtensionPaths, above) are UNAFFECTED by this: they are
// resolved via `require.resolve` against THIS package's own node_modules in
// extensions.ts, which returns absolute paths independent of `cwd`.
export async function createIsolatedSessionCwd(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tgd-review-agent-session-"));
  const agentsDir = path.join(tempDir, ".pi", "agents");
  await mkdir(agentsDir, { recursive: true });
  await copyFile(VENDORED_REVIEWER_AGENT_PATH, path.join(agentsDir, "reviewer.md"));
  return tempDir;
}

// Bug fix (found via a real multi-model run against hmchangw/chat#490):
// pi-subagents' "intercom bridge" defaults to mode "always" — it injects
// `intercom`/`contact_supervisor` tools plus a coordination instruction into
// EVERY dispatched agent (even our tool-restricted reviewer) and lets a
// PARALLEL run "detach for intercom coordination", handing control back to
// the orchestrator to reply to a supervisor request over multiple turns.
// Our orchestrator is single-shot (one prompt() call, read the final
// message), so when N>1 rules dispatch in parallel and the run detaches, the
// orchestrator can't do that multi-turn coordination and every task fails at
// once. A single-rule run (N=1) happened to avoid the detach, which is why
// one model worked but two didn't.
//
// The fix: disable the intercom bridge for our dispatched runs by setting
// pi-subagents' `intercomBridge.mode: "off"` in its config. pi-subagents
// reads that config from `<agentDir>/extensions/subagent/config.json`, where
// `agentDir` comes from `process.env.PI_CODING_AGENT_DIR` (or ~/.pi/agent) —
// a GLOBAL location we must not mutate as a side effect of running the CLI.
// So instead we build a hermetic, throwaway agent dir per dispatch:
//   - symlink the real agentDir's `auth.json`/`models.json`/`settings.json`
//     into it (so credentials and model config still resolve — a symlink,
//     not a copy, so no secret is ever duplicated to a second location)
//   - write our own `extensions/subagent/config.json` with the bridge off
// dispatchRules points `PI_CODING_AGENT_DIR` at this temp dir for the
// duration of the session (restoring the previous value afterward) and
// removes it in its `finally` block. This never touches the user's real
// ~/.pi/agent. Validated end-to-end: with the bridge off, a 2-model parallel
// fan-out against hmchangw/chat#490 completes with rulesRun for both models.
const SUBAGENT_CONFIG_INTERCOM_OFF = JSON.stringify({ intercomBridge: { mode: "off" } });

// Issue #1: the pi SDK's auth failures ("No API key found for <provider>",
// "Authentication failed for ...", "No model selected") are thrown from deep
// inside session.prompt() and name neither auth.json nor the agent dir. When
// the hermetic agent dir was built WITHOUT credentials, that produced the
// utterly opaque `No API key found for undefined` — the registry had no
// providers at all, so the resolved model carried no provider name. These are
// the error shapes worth annotating with the auth context below.
//
// Deliberately NOT including "No models available": that string is only ever
// produced as createAgentSession's non-throwing `modelFallbackMessage` (see
// createRealDispatchSession), never thrown from prompt(), so matching it here
// would be dead code.
export const PI_AUTH_ERROR_RE = /No API key found|Authentication failed|No model selected/i;

// Why auth.json is (or isn't) present in the hermetic agent dir. The two
// failure causes are kept DISTINCT on purpose: telling someone "no auth.json
// found — check PI_CODING_AGENT_DIR" when the file is right there but couldn't
// be symlinked sends them to verify a path that will check out fine, while the
// real cause (a filesystem that can't symlink) goes unmentioned.
export type AuthLinkStatus = "linked" | "absent" | "link-failed";

export interface IsolatedAgentDir {
  dir: string;
  /**
   * Anything other than "linked" means the hermetic dir has NO credentials
   * file, so provider auth must come from environment variables. That is NOT
   * an error on its own — running with env-var-based auth (ANTHROPIC_API_KEY
   * etc.) and no auth.json anywhere is a normal setup (e.g. any CI you run this
   * in), and that must keep working silently. It IS the most useful fact to
   * attach to a downstream auth failure — see describeAuthContext.
   */
  authStatus: AuthLinkStatus;
}

// Single source of the auth explanation, so the wording can't drift between
// the places that surface it. Returns undefined when auth.json linked fine
// (nothing to explain).
export function describeAuthContext(
  authStatus: AuthLinkStatus,
  realAgentDir: string,
): string | undefined {
  if (authStatus === "linked") return undefined;
  if (authStatus === "absent") {
    return (
      `no ${AUTH_FILE} was found in the pi agent dir (${realAgentDir}), so provider ` +
      `credentials had to come from environment variables (e.g. ANTHROPIC_API_KEY) — ` +
      `if none were set, that is this error. If you expected file-based auth (e.g. OAuth ` +
      `set up via pi's /login), then PI_CODING_AGENT_DIR is likely not pointing where you think`
    );
  }
  return (
    `${AUTH_FILE} EXISTS in the pi agent dir (${realAgentDir}) but could not be linked into ` +
    `the isolated agent dir (see the symlink warning above), so provider credentials fell back ` +
    `to environment variables`
  );
}

export async function createIsolatedAgentDir(realAgentDir: string): Promise<IsolatedAgentDir> {
  const tempAgentDir = await mkdtemp(path.join(os.tmpdir(), "tgd-review-agent-agentdir-"));

  // Symlink credential/model/settings files from the real agent dir so the
  // orchestrating session and dispatched subagents still resolve API keys and
  // custom-provider config. Only link files that actually exist (a fresh CI
  // env may have none — that's fine, the review just runs with whatever
  // provider auth is present via env vars, same as before).
  let authStatus: AuthLinkStatus = "absent";

  await Promise.all(
    HERMETIC_AGENT_LINK_FILES.map(async (name) => {
      const source = path.join(realAgentDir, name);
      try {
        await access(source);
      } catch {
        return; // source absent — nothing to link
      }
      try {
        await symlink(source, path.join(tempAgentDir, name));
        if (name === AUTH_FILE) authStatus = "linked";
      } catch (err) {
        // A failed symlink (e.g. sandbox without symlink support) shouldn't
        // abort the review — warn and continue; worst case is that provider
        // auth resolves from env vars instead of auth.json.
        if (name === AUTH_FILE) authStatus = "link-failed";
        console.warn(
          `dispatchRules: could not symlink ${name} into the isolated agent dir (${(err as Error).message})`,
        );
      }
    }),
  );

  const subagentConfigDir = path.join(tempAgentDir, "extensions", "subagent");
  await mkdir(subagentConfigDir, { recursive: true });
  await writeFile(path.join(subagentConfigDir, "config.json"), SUBAGENT_CONFIG_INTERCOM_OFF, "utf-8");

  return { dir: tempAgentDir, authStatus };
}
