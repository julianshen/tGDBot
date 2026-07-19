export interface ContextMapRequest {
  sourceRoot: string;
  outputRoot: string;
  baseSha: string;
  allowDegradedContext?: boolean;
}

export interface MappingFailure {
  stage: "context-map";
  code: string;
  message: string;
}

export interface MappingResult {
  status: "ready" | "degraded" | "failed";
  manifestPath: string;
  artifactPaths: string[];
  analyzedFiles: number;
  degradedReasons: string[];
  failure?: MappingFailure;
}

export interface ContextMapper {
  map(request: ContextMapRequest): Promise<MappingResult>;
}
