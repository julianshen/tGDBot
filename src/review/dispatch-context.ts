import type { ContextPackResult } from "../context/context-pack.js";
import type { RuleDefinition } from "../rules/types.js";
import type { RuleContextPacks } from "./types.js";

const MANIFEST_HASH_RE = /^[a-f0-9]{64}$/;

export class DispatchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchInputError";
  }
}

export interface ValidatedDispatchContext {
  packsByRule?: ReadonlyMap<string, ContextPackResult>;
  manifestHash?: string;
}

function invalid(message: string): never {
  throw new DispatchInputError(message);
}

export function validateDispatchContext(
  rules: RuleDefinition[],
  contextPacks: RuleContextPacks | undefined,
): ValidatedDispatchContext {
  if (contextPacks === undefined) return {};
  if (typeof contextPacks !== "object" || contextPacks === null || Array.isArray(contextPacks)) {
    return invalid("contextPacks must be a rule-name-keyed object");
  }

  const expectedNames = new Set<string>();
  for (const rule of rules) {
    if (expectedNames.has(rule.name)) {
      return invalid(`contextPacks cannot target duplicate rule name ${JSON.stringify(rule.name)}`);
    }
    expectedNames.add(rule.name);
  }

  for (const key in contextPacks) {
    if (!Object.hasOwn(contextPacks, key)) {
      return invalid(`contextPacks contains inherited key ${JSON.stringify(key)}`);
    }
  }

  const ownKeys = Reflect.ownKeys(contextPacks);
  for (const key of ownKeys) {
    if (typeof key !== "string" || !expectedNames.has(key)) {
      return invalid(`contextPacks contains unknown own key ${String(key)}`);
    }
  }
  for (const name of expectedNames) {
    if (!Object.hasOwn(contextPacks, name)) {
      return invalid(`contextPacks is missing rule ${JSON.stringify(name)}`);
    }
  }

  const packsByRule = new Map<string, ContextPackResult>();
  let manifestHash: string | undefined;
  for (const rule of rules) {
    const pack: unknown = contextPacks[rule.name];
    if (typeof pack !== "object" || pack === null || Array.isArray(pack)) {
      return invalid(`context pack for ${JSON.stringify(rule.name)} must be an object`);
    }

    const candidate = pack as Record<string, unknown>;
    if (!Object.hasOwn(candidate, "text")) {
      return invalid(`context pack for ${JSON.stringify(rule.name)} must contain non-empty text`);
    }
    if (!Object.hasOwn(candidate, "manifestHash")) {
      return invalid(
        `context pack for ${JSON.stringify(rule.name)} must contain a lowercase SHA-256 manifest hash`,
      );
    }

    const text = candidate.text;
    const packManifestHash = candidate.manifestHash;
    const truncated = candidate.truncated;
    const sources = candidate.sources;
    if (typeof text !== "string" || text.trim().length === 0) {
      return invalid(`context pack for ${JSON.stringify(rule.name)} must contain non-empty text`);
    }
    if (typeof packManifestHash !== "string" || !MANIFEST_HASH_RE.test(packManifestHash)) {
      return invalid(
        `context pack for ${JSON.stringify(rule.name)} must contain a lowercase SHA-256 manifest hash`,
      );
    }
    if (manifestHash !== undefined && packManifestHash !== manifestHash) {
      return invalid("contextPacks must all use the same manifest hash");
    }

    manifestHash = packManifestHash;
    packsByRule.set(
      rule.name,
      Object.freeze({
        text,
        manifestHash: packManifestHash,
        truncated: truncated === true,
        sources: Array.isArray(sources)
          ? ([...sources] as ContextPackResult["sources"])
          : [],
      }),
    );
  }

  return { packsByRule, manifestHash };
}
