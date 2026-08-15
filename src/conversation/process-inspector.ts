import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Ceiling on a single process-identity lookup. On darwin and win32 that lookup
 * is a subprocess, and a subprocess has no timeout of its own: without this an
 * unresponsive `ps` becomes an unbounded wait for the repository lock, with no
 * CPU use and no diagnostic to explain it.
 */
const DEFAULT_INSPECT_TIMEOUT_MS = 5_000;

export interface ProcessIdentity {
  readonly pid: number;
  readonly hostname: string;
  readonly startIdentity: string;
}

export type ProcessInspection =
  | { readonly status: "alive"; readonly startIdentity: string }
  | { readonly status: "absent" }
  | { readonly status: "unknown" };

export interface ProcessInspector {
  current(): Promise<ProcessIdentity>;
  inspect(pid: number): Promise<ProcessInspection>;
}

export interface ProcessInspectorDependencies {
  readonly exec?: (
    file: string,
    args: readonly string[],
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  readonly timeoutMs?: number;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

const TIMED_OUT = Symbol("tgd.process-inspect-timeout");

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        // Never hold the event loop open for a lookup nobody is waiting on.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function linuxProcess(pid: number): Promise<ProcessInspection> {
  let bootId: string;
  try {
    bootId = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
  } catch {
    return { status: "unknown" };
  }
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = stat.lastIndexOf(")");
    if (closingParenthesis < 0) return { status: "unknown" };
    const fieldsFromState = stat.slice(closingParenthesis + 2).trim().split(/\s+/u);
    const startTime = fieldsFromState[19];
    if (startTime === undefined || !/^\d+$/u.test(startTime)) return { status: "unknown" };
    return { status: "alive", startIdentity: `linux:${bootId.trim()}:${startTime}` };
  } catch (error) {
    return isMissing(error) ? { status: "absent" } : { status: "unknown" };
  }
}

async function darwinProcess(
  pid: number,
  exec: NonNullable<ProcessInspectorDependencies["exec"]>,
  timeoutMs: number,
): Promise<ProcessInspection> {
  try {
    const result = await withTimeout(exec("ps", ["-o", "lstart=", "-p", String(pid)]), timeoutMs);
    if (result === TIMED_OUT) return { status: "unknown" };
    const started = result.stdout.trim().replace(/\s+/gu, " ");
    return started === "" ? { status: "absent" } : { status: "alive", startIdentity: `darwin:${started}` };
  } catch (error) {
    const exitCode = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    return exitCode === 1 ? { status: "absent" } : { status: "unknown" };
  }
}

async function windowsProcess(
  pid: number,
  exec: NonNullable<ProcessInspectorDependencies["exec"]>,
  timeoutMs: number,
): Promise<ProcessInspection> {
  const command = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;` +
    `if($null -eq $p){Write-Output ABSENT}else{Write-Output $p.StartTime.ToUniversalTime().Ticks}`;
  try {
    const result = await withTimeout(
      exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]),
      timeoutMs,
    );
    if (result === TIMED_OUT) return { status: "unknown" };
    const output = result.stdout.trim();
    if (output === "ABSENT") return { status: "absent" };
    return /^\d+$/u.test(output)
      ? { status: "alive", startIdentity: `win32:${output}` }
      : { status: "unknown" };
  } catch {
    return { status: "unknown" };
  }
}

export function createDefaultProcessInspector(
  platform: NodeJS.Platform = process.platform,
  currentPid: number = process.pid,
  currentHostname: string = hostname(),
  dependencies: ProcessInspectorDependencies = {},
): ProcessInspector {
  const exec = dependencies.exec ??
    ((file, args) => execFileAsync(file, [...args], { encoding: "utf8" }));
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;
  const inspect = platform === "linux"
    ? linuxProcess
    : platform === "darwin"
      ? (pid: number) => darwinProcess(pid, exec, timeoutMs)
      : platform === "win32"
        ? (pid: number) => windowsProcess(pid, exec, timeoutMs)
        : async (): Promise<ProcessInspection> => ({ status: "unknown" });

  // A running process's start identity cannot change, so this is resolved once
  // and shared. Every lock acquisition asks for it, and on darwin/win32 each
  // lookup is a subprocess — without caching, one poll run spawns a stream of
  // them, which is both wasteful and a way to exhaust process limits under
  // concurrency.
  let cached: Promise<ProcessIdentity> | undefined;
  return {
    inspect,
    current: () => {
      cached ??= (async () => {
        const current = await inspect(currentPid);
        if (current.status !== "alive") {
          throw new Error("Unable to verify the current process start identity; conversation locking fails closed");
        }
        return { pid: currentPid, hostname: currentHostname, startIdentity: current.startIdentity };
      })().catch((error: unknown) => {
        // A failed lookup must not be cached as a permanent failure: the next
        // acquisition gets a fresh attempt rather than inheriting a transient one.
        cached = undefined;
        throw error;
      });
      return cached;
    },
  };
}
