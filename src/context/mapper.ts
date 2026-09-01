import type { RepositoryRef } from "../target/types.js";

export interface ContextMapRequest {
  sourceRoot: string;
  outputRoot: string;
  baseSha: string;
  repository: RepositoryRef;
  allowDegradedContext?: boolean;
  /**
   * Issue #60: when present, the session is asked to map ONLY these paths —
   * the delta a cached graph is being patched with, at the NEW base. Absent
   * means a full map. The scoped session still writes the standard output
   * layout; what enters the published graph is further restricted by the
   * merge (only nodes naming a delta path), so an overreaching scoped
   * session cannot widen the graph beyond the delta.
   */
  scopePaths?: readonly string[];
}

export type MappingFailureCode =
  | "invalid-request"
  | "pi-session-failed"
  | "invalid-artifacts"
  /** A subprocess-backed mapper (graphify, #62) exited non-zero or was not found. */
  | "mapper-subprocess-failed";
/**
 * Closed for the two reasons the tgd mapper produces, open to free text for
 * mappers whose degradation has detail worth stating (#62 — a graphify schema
 * the adapter does not recognise must name itself). Free-text reasons reach
 * the operator's stderr and the pack header's degraded-reasons line, never
 * diff-derived prose channels.
 */
export type DegradedReason = "knowledge-graph-unavailable" | "domain-context-unavailable" | (string & {});

export interface MappingFailure {
  stage: "context-map";
  code: MappingFailureCode;
  message: string;
}

export interface MappingResult {
  status: "ready" | "degraded" | "failed";
  manifestPath: string;
  artifactPaths: string[];
  analyzedFiles: number;
  degradedReasons: DegradedReason[];
  failure?: MappingFailure;
}

export interface ContextMapper {
  map(request: ContextMapRequest): Promise<MappingResult>;
}
