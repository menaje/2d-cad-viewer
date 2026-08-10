import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import path from "node:path";
import {
  abortSceneEngineError,
  createSceneEngineProgress,
  SCENE_CACHE_SCHEMA_VERSION,
  SCENE_ENGINE_CONTRACT,
  SceneEngineError,
  type SceneEngine,
  type SceneEngineConversionRequest,
  type SceneEngineDescriptor,
  type SceneEngineProgressPhase,
  type SceneEngineSnapshot,
} from "./scene-engine";

export const ADAPTER_PROTOCOL = "dwg-engine-adapter/1";
export const CACHE_SCHEMA_VERSION = SCENE_CACHE_SCHEMA_VERSION;
export const DOCTOR_REPORT_SCHEMA = "dwg-engine-doctor/1";
export const LIBREDWG_NATIVE_ENGINE_VERSION = "0.14";
export const LIBREDWG_ADAPTER_EXTENSION_ID =
  "menaje.dwg-viewer-libredwg";
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_DOCTOR_STDOUT_BYTES = 64 * 1024;
const DEFAULT_DOCTOR_TIMEOUT_MS = 5_000;
const TERMINATION_GRACE_MS = 1_500;

export interface AdapterSelection {
  configuredPath?: string;
  environmentPath?: string;
  extensionPath: string;
  bundledExtensionPath?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
}

export async function resolveLibreDwgAdapter(
  selection: AdapterSelection,
): Promise<string> {
  const platform = selection.platform ?? process.platform;
  const architecture = selection.architecture ?? process.arch;
  const executableName =
    platform === "win32" ? "libredwg-adapter.exe" : "libredwg-adapter";
  const bundledRoot =
    selection.bundledExtensionPath?.trim() || selection.extensionPath;
  const bundledPath = path.join(
    bundledRoot,
    "native",
    `${platform}-${architecture}`,
    executableName,
  );
  const candidate =
    selection.configuredPath?.trim() ||
    selection.environmentPath?.trim() ||
    bundledPath;

  if (!path.isAbsolute(candidate)) {
    throw new SceneEngineError(
      "ADAPTER_PATH_NOT_ABSOLUTE",
      "LibreDWG 변환기 경로를 절대 경로로 설정해 주세요.",
    );
  }

  try {
    await access(candidate, platform === "win32" ? undefined : 1);
    const metadata = await stat(candidate);
    if (!metadata.isFile()) {
      throw new Error("not a file");
    }
  } catch (error) {
    throw new SceneEngineError(
      "ADAPTER_NOT_FOUND",
      "LibreDWG 변환기를 찾을 수 없습니다. 자동 설치를 다시 시도하거나 DWG Viewer 설정에서 검증된 오프라인 변환기 경로를 지정해 주세요.",
      { cause: error },
    );
  }
  return candidate;
}

function hashFields(fields: readonly string[]): string {
  const hash = createHash("sha256");
  for (const field of fields) {
    const encoded = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32LE(encoded.byteLength);
    hash.update(length);
    hash.update(encoded);
  }
  return hash.digest("hex");
}

async function hashAdapterContents(adapterPath: string): Promise<string> {
  const before = await stat(adapterPath, { bigint: true });
  if (!before.isFile()) {
    throw new SceneEngineError(
      "ENGINE_NOT_FILE",
      "LibreDWG Native 변환기 파일을 읽을 수 없습니다.",
    );
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(adapterPath)) {
    hash.update(chunk);
  }
  const after = await stat(adapterPath, { bigint: true });
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new SceneEngineError(
      "ENGINE_CHANGED_DURING_SNAPSHOT",
      "LibreDWG Native 변환기가 확인 중 변경되었습니다. 다시 시도해 주세요.",
    );
  }
  return hash.digest("hex");
}

interface AdapterReport {
  schema?: unknown;
  status?: unknown;
  cache?: {
    format_major?: unknown;
    format_minor?: unknown;
    size_bytes?: unknown;
    validated?: unknown;
  };
  performance?: unknown;
}

export interface LibreDwgAdapterPerformance {
  readonly parseMs: number;
  readonly writeMs: number;
  readonly totalMs: number;
  readonly workerCount: number;
  readonly parallelSortWorkers: number;
  readonly parallelSectionWorkers: number;
  readonly stages: Readonly<Record<string, number>>;
}

function safeMetric(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function parsePerformance(
  value: unknown,
): LibreDwgAdapterPerformance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const parseMs = safeMetric(raw.parse_ms);
  const writeMs = safeMetric(raw.write_ms);
  const totalMs = safeMetric(raw.total_ms);
  const workerCount = safeMetric(raw.worker_count);
  const parallelSortWorkers = safeMetric(raw.parallel_sort_workers);
  const parallelSectionWorkers = safeMetric(
    raw.parallel_section_workers,
  );
  if (
    parseMs === undefined ||
    writeMs === undefined ||
    totalMs === undefined ||
    workerCount === undefined ||
    workerCount < 1 ||
    parallelSortWorkers === undefined ||
    parallelSortWorkers < 1 ||
    parallelSectionWorkers === undefined ||
    parallelSectionWorkers < 1
  ) {
    return undefined;
  }
  const stages: Record<string, number> = {};
  if (
    raw.stages &&
    typeof raw.stages === "object" &&
    !Array.isArray(raw.stages)
  ) {
    for (const [name, metric] of Object.entries(
      raw.stages as Record<string, unknown>,
    )) {
      if (name === "section_groups") {
        if (
          metric &&
          typeof metric === "object" &&
          !Array.isArray(metric)
        ) {
          for (const [group, duration] of Object.entries(
            metric as Record<string, unknown>,
          )) {
            const normalized = safeMetric(duration);
            if (normalized !== undefined) {
              stages[`section_groups.${group}`] = normalized;
            }
          }
        }
        continue;
      }
      const normalized = safeMetric(metric);
      if (normalized !== undefined) {
        stages[name] = normalized;
      }
    }
  }
  return Object.freeze({
    parseMs,
    writeMs,
    totalMs,
    workerCount,
    parallelSortWorkers,
    parallelSectionWorkers,
    stages: Object.freeze(stages),
  });
}

export function parseAdapterReport(
  output: string,
  actualCacheBytes: bigint,
): LibreDwgAdapterPerformance | undefined {
  let report: AdapterReport;
  try {
    report = JSON.parse(output.trim()) as AdapterReport;
  } catch (error) {
    throw new SceneEngineError(
      "ADAPTER_REPORT_INVALID",
      "LibreDWG 변환기가 올바른 완료 보고서를 반환하지 않았습니다.",
      { cause: error },
    );
  }
  const reportSize = report.cache?.size_bytes;
  const expectedVersion = /\/(\d+)\.(\d+)$/u.exec(
    CACHE_SCHEMA_VERSION,
  );
  const sizeMatches =
    (typeof reportSize === "number" &&
      Number.isSafeInteger(reportSize) &&
      BigInt(reportSize) === actualCacheBytes) ||
    (typeof reportSize === "string" &&
      /^\d+$/.test(reportSize) &&
      BigInt(reportSize) === actualCacheBytes);
  if (
    report.schema !== "dwg-scene-cache/1" ||
    report.status !== "ok" ||
    report.cache?.format_major !== Number(expectedVersion?.[1]) ||
    report.cache?.format_minor !== Number(expectedVersion?.[2]) ||
    report.cache?.validated !== true ||
    !sizeMatches ||
    actualCacheBytes <= 0n
  ) {
    throw new SceneEngineError(
      "ADAPTER_REPORT_REJECTED",
      "LibreDWG 변환 결과의 무결성 검사를 통과하지 못했습니다.",
    );
  }
  return parsePerformance(report.performance);
}

interface RawDoctorReport {
  schema?: unknown;
  status?: unknown;
  protocol?: unknown;
  engine?: {
    id?: unknown;
    version?: unknown;
    license?: unknown;
    linkage?: unknown;
  };
  cache?: {
    schema?: unknown;
  };
  target?: {
    platform?: unknown;
    architecture?: unknown;
  };
}

export interface LibreDwgDoctorReport {
  engineVersion: string;
  linkage: "static" | "dynamic" | "unknown";
  platform: string;
  architecture: string;
}

function isSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 40 &&
    /^[a-zA-Z0-9._+-]+$/u.test(value)
  );
}

export function parseLibreDwgDoctorReport(
  output: string,
): LibreDwgDoctorReport {
  let report: RawDoctorReport;
  try {
    report = JSON.parse(output.trim()) as RawDoctorReport;
  } catch (error) {
    throw new SceneEngineError(
      "ADAPTER_DOCTOR_REPORT_INVALID",
      "LibreDWG 변환기가 올바른 진단 보고서를 반환하지 않았습니다.",
      { cause: error },
    );
  }

  const linkage = report.engine?.linkage;
  if (
    report.schema !== DOCTOR_REPORT_SCHEMA ||
    report.status !== "ok" ||
    report.protocol !== ADAPTER_PROTOCOL ||
    report.engine?.id !== "libredwg" ||
    report.engine.version !== LIBREDWG_NATIVE_ENGINE_VERSION ||
    report.engine.license !== "GPL-3.0-or-later" ||
    (linkage !== "static" &&
      linkage !== "dynamic" &&
      linkage !== "unknown") ||
    report.cache?.schema !== CACHE_SCHEMA_VERSION ||
    !isSafeIdentifier(report.target?.platform) ||
    !isSafeIdentifier(report.target?.architecture)
  ) {
    throw new SceneEngineError(
      "ADAPTER_DOCTOR_REPORT_REJECTED",
      "선택한 LibreDWG 변환기는 이 버전의 DWG Viewer와 호환되지 않습니다.",
    );
  }

  return {
    engineVersion: report.engine.version,
    linkage,
    platform: report.target.platform,
    architecture: report.target.architecture,
  };
}

export interface DiagnoseAdapterOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  argumentPrefix?: readonly string[];
}

export async function diagnoseLibreDwgAdapter(
  adapterPath: string,
  {
    signal = new AbortController().signal,
    timeoutMs = DEFAULT_DOCTOR_TIMEOUT_MS,
    argumentPrefix = [],
  }: DiagnoseAdapterOptions = {},
): Promise<LibreDwgDoctorReport> {
  if (signal.aborted) {
    throw abortSceneEngineError();
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30_000
  ) {
    throw new TypeError("doctor timeout is outside the supported range");
  }

  let child;
  try {
    child = spawn(adapterPath, [...argumentPrefix, "doctor"], {
      env: {
        ...process.env,
        DWG_VIEWER_ADAPTER_PROTOCOL: ADAPTER_PROTOCOL,
        DWG_VIEWER_BENCHMARK_PHASE: "doctor",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: path.dirname(adapterPath),
    });
  } catch (error) {
    throw new SceneEngineError(
      "ADAPTER_START_FAILED",
      "LibreDWG 변환기를 시작하지 못했습니다.",
      { cause: error },
    );
  }

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputError: Error | undefined;
  let timedOut = false;
  let terminationTimer: NodeJS.Timeout | undefined;

  const terminate = (): void => {
    if (
      terminationTimer ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return;
    }
    child.kill("SIGTERM");
    terminationTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, TERMINATION_GRACE_MS);
    terminationTimer.unref();
  };
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  timeoutTimer.unref();
  const onAbort = (): void => terminate();
  signal.addEventListener("abort", onAbort, { once: true });

  child.stdout!.on("data", (value: Buffer | string) => {
    if (outputError) {
      return;
    }
    try {
      stdoutBytes = appendBounded(
        stdout,
        Buffer.from(value),
        stdoutBytes,
        MAX_DOCTOR_STDOUT_BYTES,
      );
    } catch (error) {
      outputError = error as Error;
      terminate();
    }
  });
  child.stderr!.on("data", (value: Buffer | string) => {
    if (outputError) {
      return;
    }
    try {
      stderrBytes = appendBounded(
        stderr,
        Buffer.from(value),
        stderrBytes,
        MAX_STDERR_BYTES,
      );
    } catch (error) {
      outputError = error as Error;
      terminate();
    }
  });

  const result = await new Promise<{
    code: number | null;
    error?: Error;
  }>((resolve) => {
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      resolve({ code, error: spawnError });
    });
  });

  clearTimeout(timeoutTimer);
  signal.removeEventListener("abort", onAbort);
  if (terminationTimer) {
    clearTimeout(terminationTimer);
  }
  if (signal.aborted) {
    throw abortSceneEngineError();
  }
  if (timedOut) {
    throw new SceneEngineError(
      "ADAPTER_DOCTOR_TIMEOUT",
      "LibreDWG 변환기 진단이 제한 시간 안에 끝나지 않았습니다.",
    );
  }
  if (outputError) {
    throw outputError;
  }
  if (result.error) {
    throw new SceneEngineError(
      "ADAPTER_START_FAILED",
      "LibreDWG 변환기를 시작하지 못했습니다.",
      { cause: result.error },
    );
  }
  if (result.code !== 0) {
    throw new SceneEngineError(
      "ADAPTER_DOCTOR_FAILED",
      "LibreDWG 변환기 자체 진단에 실패했습니다.",
    );
  }
  return parseLibreDwgDoctorReport(
    Buffer.concat(stdout, stdoutBytes).toString("utf8"),
  );
}

interface RunAdapterOptions {
  adapterPath: string;
  argumentPrefix?: readonly string[];
  inputPath: string;
  outputPath: string;
  previewPath?: string;
  platform?: NodeJS.Platform;
  signal: AbortSignal;
  onPhase?: (phase: "converting" | "validating") => void;
  onPerformance?: (performance: LibreDwgAdapterPerformance) => void;
  onPreview?: (preview: {
    path: string;
    size: number;
  }) => void | Promise<void>;
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maximumBytes: number,
): number {
  const nextBytes = currentBytes + chunk.byteLength;
  if (nextBytes > maximumBytes) {
    throw new SceneEngineError(
      "ADAPTER_OUTPUT_LIMIT",
      "LibreDWG 변환기가 허용 범위를 넘는 출력을 반환했습니다.",
    );
  }
  chunks.push(chunk);
  return nextBytes;
}

function windowsChildPath(
  candidatePath: string,
  workingDirectory: string,
  label: string,
): string {
  const resolvedPath = path.resolve(candidatePath);
  if (path.dirname(resolvedPath) !== path.resolve(workingDirectory)) {
    throw new SceneEngineError(
      "ADAPTER_PATH_ISOLATION_FAILED",
      `Windows ${label} 경로가 변환 작업 디렉터리 밖에 있습니다.`,
    );
  }
  return path.basename(resolvedPath);
}

async function windowsPipedInputMetadata(
  inputPath: string,
): Promise<{ size: bigint; version: string }> {
  const handle = await open(inputPath, "r");
  try {
    const [metadata, header] = await Promise.all([
      handle.stat({ bigint: true }),
      (async () => {
        const bytes = Buffer.alloc(6);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== bytes.length) {
          throw new Error("short DWG header");
        }
        return bytes.toString("ascii");
      })(),
    ]);
    if (
      !metadata.isFile() ||
      metadata.size <= 0n ||
      !/^AC\d{4}$/u.test(header)
    ) {
      throw new Error("invalid DWG input metadata");
    }
    return { size: metadata.size, version: header };
  } catch (error) {
    throw new SceneEngineError(
      "INPUT_METADATA_FAILED",
      "Windows에서 도면 입력 스트림을 준비하지 못했습니다.",
      { cause: error },
    );
  } finally {
    await handle.close();
  }
}

export async function runLibreDwgAdapter({
  adapterPath,
  argumentPrefix = [],
  inputPath,
  outputPath,
  previewPath,
  platform = process.platform,
  signal,
  onPhase,
  onPerformance,
  onPreview,
}: RunAdapterOptions): Promise<void> {
  if (signal.aborted) {
    throw abortSceneEngineError();
  }

  const workingDirectory = path.dirname(outputPath);
  let adapterInputPath = inputPath;
  let adapterOutputPath = outputPath;
  let adapterPreviewPath = previewPath;
  let pipedInput:
    | {
        size: bigint;
        version: string;
      }
    | undefined;
  if (platform === "win32") {
    pipedInput = await windowsPipedInputMetadata(inputPath);
    adapterInputPath = "-";
    adapterOutputPath = windowsChildPath(
      outputPath,
      workingDirectory,
      "output",
    );
    adapterPreviewPath = previewPath
      ? windowsChildPath(previewPath, workingDirectory, "preview")
      : undefined;
  }

  let child;
  try {
    child = spawn(
      adapterPath,
      [
        ...argumentPrefix,
        "convert",
        adapterInputPath,
        adapterOutputPath,
      ],
      {
        env: {
          ...process.env,
          DWG_VIEWER_ADAPTER_PROTOCOL: ADAPTER_PROTOCOL,
          DWG_VIEWER_BENCHMARK_PHASE: "convert",
          ...(pipedInput
            ? {
                DWG_VIEWER_STDIN_SOURCE_SIZE:
                  pipedInput.size.toString(),
                DWG_VIEWER_STDIN_SOURCE_VERSION:
                  pipedInput.version,
              }
            : {}),
          ...(adapterPreviewPath
            ? {
                DWG_VIEWER_PREVIEW_PATH: adapterPreviewPath,
                DWG_VIEWER_PREVIEW_READY_PATH:
                  `${adapterPreviewPath}.ready`,
              }
            : {}),
        },
        stdio: [pipedInput ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
        cwd: workingDirectory,
      },
    );
  } catch (error) {
    throw new SceneEngineError(
      "ADAPTER_START_FAILED",
      "LibreDWG 변환기를 시작하지 못했습니다.",
      { cause: error },
    );
  }

  onPhase?.("converting");
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputError: Error | undefined;
  let terminationTimer: NodeJS.Timeout | undefined;
  let previewNotified = false;
  let previewCheck: Promise<void> | undefined;
  let pipedInputBytes = 0n;

  const checkPreview = async (): Promise<void> => {
    if (
      !previewPath ||
      !onPreview ||
      previewNotified ||
      signal.aborted
    ) {
      return;
    }
    try {
      const [readyMetadata, previewMetadata] = await Promise.all([
        stat(`${previewPath}.ready`),
        stat(previewPath),
      ]);
      if (
        !readyMetadata.isFile() ||
        !previewMetadata.isFile() ||
        !Number.isSafeInteger(previewMetadata.size) ||
        previewMetadata.size <= 0
      ) {
        return;
      }
      await onPreview({
        path: previewPath,
        size: previewMetadata.size,
      });
      previewNotified = true;
    } catch {
      // Progressive preview is best-effort; full conversion remains valid.
    }
  };
  const previewTimer =
    previewPath && onPreview
      ? setInterval(() => {
          if (!previewCheck) {
            previewCheck = checkPreview().finally(() => {
              previewCheck = undefined;
            });
          }
        }, 25)
      : undefined;
  previewTimer?.unref();

  const terminate = (): void => {
    if (
      terminationTimer ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return;
    }
    child.kill("SIGTERM");
    terminationTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, TERMINATION_GRACE_MS);
    terminationTimer.unref();
  };
  const onAbort = (): void => terminate();
  signal.addEventListener("abort", onAbort, { once: true });
  const inputStream = pipedInput
    ? createReadStream(inputPath)
    : undefined;
  if (inputStream) {
    inputStream.on("data", (chunk: Buffer | string) => {
      pipedInputBytes += BigInt(Buffer.byteLength(chunk));
    });
    inputStream.on("error", (error) => {
      if (!outputError) {
        outputError = new SceneEngineError(
          "INPUT_READ_FAILED",
          "Windows에서 도면 입력 스트림을 읽지 못했습니다.",
          { cause: error },
        );
      }
      terminate();
    });
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && !outputError) {
        outputError = new SceneEngineError(
          "INPUT_READ_FAILED",
          "Windows 도면 입력 스트림 전송이 중단되었습니다.",
          { cause: error },
        );
        terminate();
      }
    });
    if (!child.stdin) {
      inputStream.destroy();
      outputError = new SceneEngineError(
        "ADAPTER_START_FAILED",
        "Windows 변환기의 입력 스트림을 열지 못했습니다.",
      );
      terminate();
    } else {
      inputStream.pipe(child.stdin);
    }
  }

  child.stdout!.on("data", (value: Buffer | string) => {
    if (outputError) {
      return;
    }
    try {
      stdoutBytes = appendBounded(
        stdout,
        Buffer.from(value),
        stdoutBytes,
        MAX_STDOUT_BYTES,
      );
    } catch (error) {
      outputError = error as Error;
      terminate();
    }
  });
  child.stderr!.on("data", (value: Buffer | string) => {
    if (outputError) {
      return;
    }
    try {
      stderrBytes = appendBounded(
        stderr,
        Buffer.from(value),
        stderrBytes,
        MAX_STDERR_BYTES,
      );
    } catch (error) {
      outputError = error as Error;
      terminate();
    }
  });

  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>((resolve) => {
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, closeSignal) => {
      resolve({ code, signal: closeSignal, error: spawnError });
    });
  });

  inputStream?.destroy();
  child.stdin?.destroy();
  if (previewTimer) {
    clearInterval(previewTimer);
  }
  await previewCheck;
  await checkPreview();
  signal.removeEventListener("abort", onAbort);
  if (terminationTimer) {
    clearTimeout(terminationTimer);
  }
  if (signal.aborted) {
    throw abortSceneEngineError();
  }
  if (outputError) {
    throw outputError;
  }
  if (pipedInput && pipedInputBytes !== pipedInput.size) {
    throw new SceneEngineError(
      "INPUT_CHANGED",
      "Windows 도면 입력 크기가 변환 중 변경되었습니다.",
    );
  }
  if (result.error) {
    throw new SceneEngineError(
      "ADAPTER_START_FAILED",
      "LibreDWG 변환기를 시작하지 못했습니다.",
      { cause: result.error },
    );
  }
  if (result.code !== 0) {
    throw new SceneEngineError(
      "ADAPTER_CONVERSION_FAILED",
      "DWG 변환에 실패했습니다. 변환기 호환성과 도면 상태를 확인해 주세요.",
    );
  }

  onPhase?.("validating");
  let outputMetadata;
  try {
    outputMetadata = await stat(outputPath, { bigint: true });
  } catch (error) {
    throw new SceneEngineError(
      "CACHE_OUTPUT_MISSING",
      "LibreDWG 변환기가 캐시 파일을 만들지 못했습니다.",
      { cause: error },
    );
  }
  const performance = parseAdapterReport(
    Buffer.concat(stdout, stdoutBytes).toString("utf8"),
    outputMetadata.size,
  );
  if (performance && onPerformance) {
    try {
      onPerformance(performance);
    } catch {
      // Telemetry observers must not invalidate a verified cache.
    }
  }
}

export const LIBREDWG_NATIVE_ENGINE_DESCRIPTOR = Object.freeze({
  schema: SCENE_ENGINE_CONTRACT,
  engineId: "libredwg",
  engineVersion: LIBREDWG_NATIVE_ENGINE_VERSION,
  backendId: "native",
  backendKind: "native-process",
  displayName: "LibreDWG Native",
  cacheSchema: CACHE_SCHEMA_VERSION,
  capabilities: Object.freeze({
    localExecution: true,
    packedSceneCache: true,
    progressivePreview: true,
    cancellable: true,
    features: Object.freeze([
      "linework",
      "blocks",
      "hatch",
      "wipeout",
      "text",
      "shx-bigfont",
    ] as const),
    conversionOptions: Object.freeze([] as const),
  }),
}) satisfies SceneEngineDescriptor;

interface NativeAdapterInvocation {
  argumentPrefix?: readonly string[];
  platform?: NodeJS.Platform;
  onPerformance?: (performance: LibreDwgAdapterPerformance) => void;
}

export class LibreDwgNativeSceneEngine implements SceneEngine {
  readonly descriptor = LIBREDWG_NATIVE_ENGINE_DESCRIPTOR;

  constructor(
    readonly adapterPath: string,
    private readonly invocation: NativeAdapterInvocation = {},
  ) {}

  async snapshot(): Promise<SceneEngineSnapshot> {
    return Object.freeze({
      revision: await hashAdapterContents(this.adapterPath),
    });
  }

  async convert({
    sourcePath,
    outputPath,
    previewPath,
    signal,
    options,
    onProgress,
    onPreview,
  }: SceneEngineConversionRequest): Promise<void> {
    if (Object.keys(options).length > 0) {
      throw new SceneEngineError(
        "ENGINE_OPTIONS_UNSUPPORTED",
        "LibreDWG Native가 지원하지 않는 변환 옵션이 지정되었습니다.",
      );
    }
    const emit = (phase: SceneEngineProgressPhase): void => {
      try {
        onProgress?.(createSceneEngineProgress(this.descriptor, phase));
      } catch {
        // Progress observers must not interrupt or leak the converter process.
      }
    };
    await runLibreDwgAdapter({
      adapterPath: this.adapterPath,
      argumentPrefix: this.invocation.argumentPrefix,
      inputPath: sourcePath,
      outputPath,
      previewPath,
      platform: this.invocation.platform,
      signal,
      onPhase: (phase) =>
        emit(phase === "converting" ? "parsing" : "validating"),
      onPerformance: this.invocation.onPerformance,
      onPreview,
    });
  }
}
