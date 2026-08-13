import { createHash } from "node:crypto";
import type {
  ChildMarkerInput,
  ChildMarkerKind,
  ChildMarkerPayload,
  Sha256Digest,
} from "./types.js";

export const CHILD_MARKER_VERSION = 1 as const;
export const STABLE_CONVERSATION_ID_GRAMMAR =
  "parent: act_<32 lowercase hex>; children: out_|finding_|clar_<32 lowercase hex>";
export const CHILD_MARKER_GRAMMAR =
  "<!-- tgd-child:v=1;kind=<action|finding|clarification>;parent=<act_ID>;child=<kind-compatible_ID>;repo=<64 lowercase hex>;review=<positive safe integer>;content=<64 lowercase hex> -->";

const DIGEST_RE = /^[0-9a-f]{64}$/u;
const ACTION_ID_RE = /^act_[0-9a-f]{32}$/u;
const CHILD_ID_RE: Readonly<Record<ChildMarkerKind, RegExp>> = {
  action: /^out_[0-9a-f]{32}$/u,
  finding: /^finding_[0-9a-f]{32}$/u,
  clarification: /^clar_[0-9a-f]{32}$/u,
};
const MARKER_RE = /^<!-- tgd-child:v=1;kind=(action|finding|clarification);parent=(act_[0-9a-f]{32});child=((?:out|finding|clar)_[0-9a-f]{32});repo=([0-9a-f]{64});review=([1-9][0-9]*);content=([0-9a-f]{64}) -->$/u;

function sha256(domain: string, value: string): Sha256Digest {
  return createHash("sha256").update(`${domain}\0${value}`, "utf8").digest("hex");
}

export function computeRepositoryDigest(provider: "github" | "gitlab", canonicalRepository: string): Sha256Digest {
  return sha256(`tgd:repository:v1:${provider}`, canonicalRepository);
}

export function computeContentDigest(normalizedContent: string): Sha256Digest {
  return sha256("tgd:content:v1", normalizedContent);
}

function validatePayload(input: ChildMarkerInput): void {
  if (input.version !== undefined && input.version !== 1) throw new Error("invalid marker version");
  if (!(input.kind in CHILD_ID_RE)) throw new Error("invalid marker kind");
  if (!ACTION_ID_RE.test(input.parentId)) throw new Error("invalid marker parentId");
  if (!CHILD_ID_RE[input.kind].test(input.childId)) throw new Error("invalid marker childId");
  if (!DIGEST_RE.test(input.repositoryDigest)) throw new Error("invalid marker repositoryDigest");
  if (!DIGEST_RE.test(input.contentDigest)) throw new Error("invalid marker contentDigest");
  if (!Number.isSafeInteger(input.reviewNumber) || input.reviewNumber <= 0) {
    throw new Error("invalid marker reviewNumber");
  }
}

/**
 * Formats the complete canonical hidden marker. No user-controlled body text is
 * embedded: only validated IDs, binding digests, kind, version and review ID.
 */
export function formatChildMarker(input: ChildMarkerInput): string {
  validatePayload(input);
  return `<!-- tgd-child:v=${CHILD_MARKER_VERSION};kind=${input.kind};parent=${input.parentId};child=${input.childId};repo=${input.repositoryDigest};review=${input.reviewNumber};content=${input.contentDigest} -->`;
}

/** Parses only a complete, canonical marker; embedded or decorated text is rejected. */
export function parseChildMarker(raw: string): ChildMarkerPayload | null {
  const match = MARKER_RE.exec(raw);
  if (!match) return null;
  const reviewNumber = Number(match[5]);
  const payload: ChildMarkerPayload = {
    version: 1,
    kind: match[1] as ChildMarkerKind,
    parentId: match[2]!,
    childId: match[3]!,
    repositoryDigest: match[4]!,
    reviewNumber,
    contentDigest: match[6]!,
  };
  try {
    validatePayload(payload);
    return formatChildMarker(payload) === raw ? payload : null;
  } catch {
    return null;
  }
}

export type ChildMarkerBinding = Partial<Omit<ChildMarkerPayload, "version">> & {
  readonly version?: 1;
};

/** Requires each supplied canonical binding value to match the signed-by-context marker fields. */
export function verifyChildMarkerBinding(raw: string, expected: ChildMarkerBinding): boolean {
  const marker = parseChildMarker(raw);
  if (!marker) return false;
  return (Object.keys(expected) as Array<keyof ChildMarkerBinding>)
    .every((key) => expected[key] === undefined || marker[key] === expected[key]);
}
