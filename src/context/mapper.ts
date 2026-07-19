export interface ContextMapRequest {
  sourceRoot: string;
  outputRoot: string;
  baseSha: string;
  allowDegradedContext?: boolean;
}

export type MappingFailureCode = "invalid-request" | "pi-session-failed" | "invalid-artifacts";
export type DegradedReason = "knowledge-graph-unavailable" | "domain-context-unavailable";

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
