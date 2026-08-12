export const SCENE_ENGINE_CONTRACT = "dwg-scene-engine/1";
export const SCENE_ENGINE_PROGRESS_SCHEMA =
  "dwg-scene-engine-progress/1";
export const SCENE_CACHE_SCHEMA_VERSION = "dwg-scene-cache/1.25";

export class SceneEngineError extends Error {
  constructor(
    readonly code: string,
    readonly userMessage: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "SceneEngineError";
  }
}

export function abortSceneEngineError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

export function isSceneEngineAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export type SceneEngineBackendKind =
  | "native-process"
  | "wasm-worker";

export type SceneEngineFeature =
  | "linework"
  | "blocks"
  | "hatch"
  | "wipeout"
  | "text"
  | "shx-bigfont";

export interface SceneEngineCapabilities {
  readonly localExecution: true;
  readonly packedSceneCache: true;
  readonly progressivePreview: boolean;
  readonly cancellable: true;
  readonly features: readonly SceneEngineFeature[];
  readonly conversionOptions: readonly string[];
}

export interface SceneEngineDescriptor {
  readonly schema: typeof SCENE_ENGINE_CONTRACT;
  readonly engineId: string;
  readonly engineVersion: string;
  readonly backendId: string;
  readonly backendKind: SceneEngineBackendKind;
  readonly displayName: string;
  readonly cacheSchema: typeof SCENE_CACHE_SCHEMA_VERSION;
  readonly capabilities: SceneEngineCapabilities;
}

export type SceneConversionOptionValue = boolean | number | string;
export type SceneConversionOptions = Readonly<
  Record<string, SceneConversionOptionValue>
>;

export const EMPTY_SCENE_CONVERSION_OPTIONS: SceneConversionOptions =
  Object.freeze({});

export type SceneEngineProgressPhase =
  | "checking"
  | "parsing"
  | "preview-ready"
  | "validating"
  | "cache-ready"
  | "failed"
  | "cancelled";

export interface SceneEngineProgressEvent {
  readonly schema: typeof SCENE_ENGINE_PROGRESS_SCHEMA;
  readonly phase: SceneEngineProgressPhase;
  readonly engineId: string;
  readonly engineVersion: string;
  readonly backendId: string;
  readonly backendKind: SceneEngineBackendKind;
}

export interface SceneEngineSnapshot {
  readonly revision: string;
}

export interface SceneEnginePreviewArtifact {
  readonly path: string;
  readonly size: number;
}

export interface SceneEngineConversionRequest {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly previewPath?: string;
  readonly signal: AbortSignal;
  readonly options: SceneConversionOptions;
  readonly onProgress?: (event: SceneEngineProgressEvent) => void;
  readonly onPreview?: (
    preview: SceneEnginePreviewArtifact,
  ) => void | Promise<void>;
}

export interface SceneEngine {
  readonly descriptor: SceneEngineDescriptor;
  snapshot(): Promise<SceneEngineSnapshot>;
  convert(request: SceneEngineConversionRequest): Promise<void>;
}

function isSafeOptionName(value: string): boolean {
  return /^[a-z][a-zA-Z0-9._-]{0,63}$/u.test(value);
}

export function normalizeSceneConversionOptions(
  options: SceneConversionOptions,
): SceneConversionOptions {
  const entries = Object.entries(options);
  if (entries.length > 64) {
    throw new TypeError("too many scene conversion options");
  }
  entries.sort(([left], [right]) => left.localeCompare(right, "en"));
  const normalized: Record<string, SceneConversionOptionValue> = {};
  for (const [name, value] of entries) {
    if (!isSafeOptionName(name)) {
      throw new TypeError(`invalid scene conversion option: ${name}`);
    }
    if (
      (typeof value === "number" && !Number.isFinite(value)) ||
      (typeof value === "string" && value.length > 256) ||
      (typeof value !== "boolean" &&
        typeof value !== "number" &&
        typeof value !== "string")
    ) {
      throw new TypeError(`invalid value for scene conversion option: ${name}`);
    }
    normalized[name] = value;
  }
  return Object.freeze(normalized);
}

export function canonicalSceneConversionOptions(
  options: SceneConversionOptions,
): string {
  return JSON.stringify(
    Object.entries(normalizeSceneConversionOptions(options)),
  );
}

export function createSceneEngineProgress(
  descriptor: SceneEngineDescriptor,
  phase: SceneEngineProgressPhase,
): SceneEngineProgressEvent {
  return Object.freeze({
    schema: SCENE_ENGINE_PROGRESS_SCHEMA,
    phase,
    engineId: descriptor.engineId,
    engineVersion: descriptor.engineVersion,
    backendId: descriptor.backendId,
    backendKind: descriptor.backendKind,
  });
}
