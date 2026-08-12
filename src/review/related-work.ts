export type RelatedWorkKind = "issue" | "pull_request" | "merge_request";
export type RelatedWorkState = "open" | "closed" | "merged";

export interface RelatedWorkReference {
  provider: "github" | "gitlab";
  host: string;
  port?: string;
  projectPath: string;
  number: number;
  kindHint?: RelatedWorkKind;
  sourceText: string;
  identifier: string;
  fallbackUrl?: string;
}

export interface RelatedWorkItem extends RelatedWorkReference {
  kind?: RelatedWorkKind;
  title?: string;
  state?: RelatedWorkState;
  url?: string;
}

export interface ExtractRelatedWorkResult {
  readonly references: readonly RelatedWorkReference[];
  readonly omittedCount: number;
}

interface ReviewContext {
  provider: "github" | "gitlab";
  host: string;
  port?: string;
  projectPath: string;
  number: number;
  authority: string;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const NUMBER = /^[1-9][0-9]*$/;

export function isValidRelatedWorkProjectPath(
  provider: "github" | "gitlab",
  projectPath: string,
): boolean {
  const segments = projectPath.split("/");
  return (provider === "github" ? segments.length === 2 : segments.length >= 2) &&
    segments.every((part) => part !== "." && part !== ".." && SEGMENT.test(part));
}

function parseNumber(value: string): number | undefined {
  if (!NUMBER.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function decodeProject(raw: string, provider: "github" | "gitlab"): string | undefined {
  if (/%(?:2f|5c)/i.test(raw) || raw.includes("\\")) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return undefined; }
  if (!isValidRelatedWorkProjectPath(provider, decoded)) return undefined;
  return decoded;
}

function parseReview(input: { provider: "github" | "gitlab"; reviewUrl: string }): ReviewContext | undefined {
  let url: URL;
  try { url = new URL(input.reviewUrl); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
  const path = url.pathname.replace(/\/$/, "");
  const match = input.provider === "github"
    ? /^\/(.+)\/pull\/([1-9][0-9]*)$/.exec(path)
    : /^\/(.+)\/-\/merge_requests\/([1-9][0-9]*)$/.exec(path);
  if (!match) return undefined;
  const projectPath = decodeProject(match[1]!, input.provider);
  const number = parseNumber(match[2]!);
  if (!projectPath || number === undefined) return undefined;
  return { provider: input.provider, host: url.hostname.toLowerCase(), port: url.port || undefined, projectPath, number, authority: url.host.toLowerCase() };
}

function visibleMarkdown(value: string): string {
  let output = "";
  let fence: { char: string; length: number } | undefined;
  let inline = 0;
  for (let index = 0; index < value.length;) {
    const atLineStart = index === 0 || value[index - 1] === "\n";
    if (atLineStart) {
      const fenceMatch = /^( {0,3})(`{3,}|~{3,})/.exec(value.slice(index));
      if (fenceMatch) {
        const marker = fenceMatch[2]!;
        const lineEnd = value.indexOf("\n", index);
        const contentEnd = lineEnd < 0 ? value.length : value[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
        const remainder = value.slice(index + fenceMatch[0].length, contentEnd);
        const closes = fence && marker[0] === fence.char && marker.length >= fence.length && /^[ \t]*$/.test(remainder);
        if (!fence) fence = { char: marker[0]!, length: marker.length };
        else if (closes) fence = undefined;
        const end = lineEnd < 0 ? value.length : lineEnd + 1;
        output += " ".repeat(end - index);
        index = end;
        continue;
      }
    }
    if (fence) { output += value[index] === "\n" ? "\n" : " "; index++; continue; }
    if (value[index] === "`") {
      let count = 1;
      while (value[index + count] === "`") count++;
      if (!inline) inline = count;
      else if (count === inline) inline = 0;
      output += " ".repeat(count); index += count; continue;
    }
    output += inline ? (value[index] === "\n" ? "\n" : " ") : value[index];
    index++;
  }
  return output;
}

function makeReference(context: ReviewContext, projectPath: string, number: number, kindHint: RelatedWorkKind | undefined, sourceText: string): RelatedWorkReference {
  const local = projectPath === context.projectPath;
  const sigil = kindHint === "merge_request" ? "!" : "#";
  const identifier = `${local ? "" : projectPath}${sigil}${number}`;
  const fallbackPath = context.provider === "github" ? `issues/${number}` : `-/${kindHint === "merge_request" ? "merge_requests" : "issues"}/${number}`;
  return { provider: context.provider, host: context.host, ...(context.port ? { port: context.port } : {}), projectPath, number, ...(kindHint ? { kindHint } : {}), sourceText, identifier, fallbackUrl: `https://${context.authority}/${projectPath}/${fallbackPath}` };
}

export function relatedWorkIdentity(reference: RelatedWorkReference): string {
  const authorityPort = reference.port ?? "443";
  const kind = reference.provider === "gitlab" ? `|${reference.kindHint ?? "issue"}` : "";
  return `${reference.provider}|${reference.host.toLowerCase()}|${authorityPort}|${reference.projectPath}|${reference.number}${kind}`;
}

export function safeRelatedWorkIdentifier(reference: RelatedWorkReference): string {
  const sigil = reference.provider === "gitlab" && reference.kindHint === "merge_request" ? "!" : "#";
  return `${reference.projectPath}${sigil}${reference.number}`;
}

function candidateIdentity(candidate: unknown): string | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  try {
    const record = candidate as Record<string, unknown>;
    const provider = record.provider;
    const host = record.host;
    const port = record.port;
    const projectPath = record.projectPath;
    const number = record.number;
    const kindHint = record.kindHint;
    if ((provider !== "github" && provider !== "gitlab") || typeof host !== "string" ||
      typeof projectPath !== "string" || typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 ||
      (port !== undefined && typeof port !== "string") ||
      (kindHint !== undefined && kindHint !== "issue" && kindHint !== "pull_request" && kindHint !== "merge_request")) return undefined;
    return relatedWorkIdentity({ provider, host, ...(port === undefined ? {} : { port }), projectPath, number, ...(kindHint === undefined ? {} : { kindHint }), sourceText: "", identifier: "" });
  } catch {
    return undefined;
  }
}

export function reconcileRelatedWork(
  references: readonly RelatedWorkReference[],
  output: unknown,
): readonly RelatedWorkItem[] {
  try {
    if (!Array.isArray(output)) return [...references];
  } catch {
    return [...references];
  }
  const expected = new Set(references.map(relatedWorkIdentity));
  const candidates = new Map<string, unknown[]>();
  let length: number;
  try { length = output.length; } catch { return [...references]; }
  for (let index = 0; index < length; index++) {
    let candidate: unknown;
    try { candidate = output[index]; } catch { continue; }
    const key = candidateIdentity(candidate);
    if (!key || !expected.has(key)) continue;
    const values = candidates.get(key);
    if (values) values.push(candidate);
    else candidates.set(key, [candidate]);
  }
  return references.map((reference) => {
    const values = candidates.get(relatedWorkIdentity(reference));
    return values?.length === 1 ? validateResolvedRelatedWork(reference, values[0]) : reference;
  });
}

function candidates(text: string, context: ReviewContext): Array<{ index: number; reference: RelatedWorkReference }> {
  const visible = visibleMarkdown(text);
  const found: Array<{ index: number; reference: RelatedWorkReference }> = [];
  const occupied: Array<[number, number]> = [];
  const urlPattern = /https:\/\/[^\s<>()\]]+/g;
  for (const match of visible.matchAll(urlPattern)) {
    const rawToken = match[0];
    const sourceText = rawToken.replace(/[.,]+$/, "");
    occupied.push([match.index!, match.index! + rawToken.length]);
    let url: URL;
    try { url = new URL(sourceText); } catch { continue; }
    if (url.protocol !== "https:" || url.host.toLowerCase() !== context.authority || url.search || url.hash) continue;
    const pathMatch = context.provider === "github"
      ? /^\/(.+)\/(issues|pull)\/([1-9][0-9]*)$/.exec(url.pathname)
      : /^\/(.+)\/-\/(issues|merge_requests)\/([1-9][0-9]*)$/.exec(url.pathname);
    if (!pathMatch) continue;
    const project = decodeProject(pathMatch[1]!, context.provider);
    const number = parseNumber(pathMatch[3]!);
    if (!project || number === undefined) continue;
    const kind: RelatedWorkKind = pathMatch[2] === "issues" ? "issue" : context.provider === "github" ? "pull_request" : "merge_request";
    found.push({ index: match.index!, reference: makeReference(context, project, number, kind, sourceText) });
  }
  const shorthand = context.provider === "github"
    ? /(?<![A-Za-z0-9_.@/-])(?:(?<project>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(?<number>[1-9][0-9]*)(?![A-Za-z0-9_.-])/g
    : /(?<![A-Za-z0-9_.@/-])(?:(?<project>[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+))?(?<sigil>[#!])(?<number>[1-9][0-9]*)(?![A-Za-z0-9_.-])/g;
  for (const match of visible.matchAll(shorthand)) {
    if (occupied.some(([start, end]) => match.index! >= start && match.index! < end)) continue;
    const project = match.groups?.project ? decodeProject(match.groups.project, context.provider) : context.projectPath;
    const number = parseNumber(match.groups?.number ?? "");
    if (!project || number === undefined) continue;
    const kind = context.provider === "gitlab" ? (match.groups?.sigil === "!" ? "merge_request" : "issue") : undefined;
    found.push({ index: match.index!, reference: makeReference(context, project, number, kind, match[0]) });
  }
  return found.sort((a, b) => a.index - b.index);
}

export function extractRelatedWork(input: { provider: "github" | "gitlab"; reviewUrl: string; title: string; description: string }): ExtractRelatedWorkResult {
  const context = parseReview(input);
  if (!context) return { references: [], omittedCount: 0 };
  const unique: RelatedWorkReference[] = [];
  const identities = new Set<string>();
  for (const value of [input.title, input.description]) for (const { reference } of candidates(value, context)) {
    const isSelf = reference.projectPath === context.projectPath && reference.number === context.number &&
      (context.provider === "github" || reference.kindHint === "merge_request");
    const identity = relatedWorkIdentity(reference);
    if (!isSelf && !identities.has(identity)) { identities.add(identity); unique.push(reference); }
  }
  return { references: unique.slice(0, 10), omittedCount: Math.max(0, unique.length - 10) };
}

export function normalizeRelatedWorkState(kind: RelatedWorkKind, value: unknown): RelatedWorkState | undefined {
  if (value === "open" || value === "opened") return "open";
  if (value === "closed") return "closed";
  if (value === "merged" && kind !== "issue") return "merged";
  return undefined;
}

export function sanitizeRelatedWorkTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\r\n]+/g, " ").replace(/[\u0000-\u001F\u007F-\u009F]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  const points = [...clean];
  return points.length > 200 ? points.slice(0, 199).join("") + "…" : clean;
}

function exactCandidateUrl(reference: RelatedWorkReference, kind: RelatedWorkKind, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  const expectedPort = reference.port === undefined || reference.port === "443" ? "" : reference.port;
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== reference.host.toLowerCase() || url.port !== expectedPort || url.search || url.hash || url.username || url.password) return undefined;
  const path = reference.provider === "github"
    ? `/${reference.projectPath}/${kind === "issue" ? "issues" : "pull"}/${reference.number}`
    : `/${reference.projectPath}/-/${kind === "issue" ? "issues" : "merge_requests"}/${reference.number}`;
  return url.pathname === path ? url.href.replace(/\/$/, "") : undefined;
}

export function validateResolvedRelatedWork(reference: RelatedWorkReference, candidate: unknown): RelatedWorkItem {
  if (!candidate || typeof candidate !== "object") return reference;
  try {
    const record = candidate as Record<string, unknown>;
    const kind = record.kind;
    if (kind !== "issue" && kind !== "pull_request" && kind !== "merge_request") return reference;
    if ((reference.provider === "github" && kind === "merge_request") || (reference.provider === "gitlab" && kind === "pull_request") || (reference.kindHint && kind !== reference.kindHint)) return reference;
    const url = exactCandidateUrl(reference, kind, record.url);
    if (!url) return reference;
    const title = sanitizeRelatedWorkTitle(record.title);
    const state = normalizeRelatedWorkState(kind, record.state);
    return { ...reference, kind, ...(title ? { title } : {}), ...(state ? { state } : {}), url };
  } catch {
    return reference;
  }
}
