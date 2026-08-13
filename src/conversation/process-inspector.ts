import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
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

async function darwinProcess(pid: number): Promise<ProcessInspection> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    const started = stdout.trim().replace(/\s+/gu, " ");
    return started === "" ? { status: "absent" } : { status: "alive", startIdentity: `darwin:${started}` };
  } catch (error) {
    const exitCode = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    return exitCode === 1 ? { status: "absent" } : { status: "unknown" };
  }
}

async function windowsProcess(pid: number): Promise<ProcessInspection> {
  const command = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;` +
    `if($null -eq $p){Write-Output ABSENT}else{Write-Output $p.StartTime.ToUniversalTime().Ticks}`;
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8" });
    const result = stdout.trim();
    if (result === "ABSENT") return { status: "absent" };
    return /^\d+$/u.test(result)
      ? { status: "alive", startIdentity: `win32:${result}` }
      : { status: "unknown" };
  } catch {
    return { status: "unknown" };
  }
}

export function createDefaultProcessInspector(
  platform: NodeJS.Platform = process.platform,
  currentPid: number = process.pid,
  currentHostname: string = hostname(),
): ProcessInspector {
  const inspect = platform === "linux" ? linuxProcess : platform === "darwin" ? darwinProcess :
    platform === "win32" ? windowsProcess : async (): Promise<ProcessInspection> => ({ status: "unknown" });
  return {
    inspect,
    current: async () => {
      const current = await inspect(currentPid);
      if (current.status !== "alive") {
        throw new Error("Unable to verify the current process start identity; conversation locking fails closed");
      }
      return { pid: currentPid, hostname: currentHostname, startIdentity: current.startIdentity };
    },
  };
}
