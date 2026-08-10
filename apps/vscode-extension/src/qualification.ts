import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

export const QUALIFICATION_EVENT_SCHEMA =
  "dwg-vscode-qualification-event/1";
export const QUALIFICATION_REPORT_ENV =
  "DWG_VIEWER_QUALIFICATION_REPORT";
export const QUALIFICATION_TOKEN_ENV =
  "DWG_VIEWER_QUALIFICATION_TOKEN";
export const QUALIFICATION_DRAWING_ENV =
  "DWG_VIEWER_QUALIFICATION_DRAWING";
export const QUALIFICATION_CLOSE_AFTER_ENV =
  "DWG_VIEWER_QUALIFICATION_CLOSE_AFTER";
export const QUALIFICATION_MODE_ENV =
  "DWG_VIEWER_QUALIFICATION_MODE";

export type QualificationCloseStage =
  | "conversion"
  | "preview"
  | "full";
export type QualificationFields = Readonly<
  Record<string, boolean | number | string | null>
>;

const SAFE_EVENT = /^[a-z][a-z0-9-]{0,47}$/u;
const SAFE_FIELD = /^[a-z][a-z0-9_]{0,47}$/u;
const SAFE_STRING = /^[^/\\\r\n]{0,80}$/u;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_EVENT_BYTES = 4 * 1024;

function validateFields(fields: QualificationFields): void {
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELD.test(key)) {
      throw new TypeError("invalid qualification field name");
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && SAFE_STRING.test(value))
    ) {
      continue;
    }
    throw new TypeError("invalid qualification field value");
  }
}

export class QualificationReporter {
  private readonly startedAt = Date.now();
  private readonly handle: Promise<FileHandle>;
  private queue: Promise<void> = Promise.resolve();
  private failure: unknown;
  private closeClaimed = false;
  private closed = false;

  constructor(
    reportPath: string,
    readonly closeAfter: QualificationCloseStage,
    readonly hostPid: number,
  ) {
    this.handle = open(reportPath, "wx", 0o600);
  }

  emit(
    event: string,
    fields: QualificationFields = {},
  ): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    if (!SAFE_EVENT.test(event)) {
      throw new TypeError("invalid qualification event");
    }
    validateFields(fields);
    const record = JSON.stringify({
      schema: QUALIFICATION_EVENT_SCHEMA,
      event,
      elapsed_ms: Math.max(0, Date.now() - this.startedAt),
      ...fields,
    });
    if (Buffer.byteLength(record, "utf8") > MAX_EVENT_BYTES) {
      throw new RangeError("qualification event exceeds byte limit");
    }
    this.queue = this.queue
      .then(async () => {
        const handle = await this.handle;
        await handle.appendFile(`${record}\n`, "utf8");
      })
      .catch((error) => {
        this.failure ??= error;
      });
    return this.queue;
  }

  claimClose(stage: QualificationCloseStage): boolean {
    if (this.closeClaimed || this.closeAfter !== stage) {
      return false;
    }
    this.closeClaimed = true;
    return true;
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.failure) {
      throw this.failure;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.emit("extension-deactivated", {
      extension_host_pid: this.hostPid,
    });
    this.closed = true;
    await this.queue;
    const handle = await this.handle.catch(() => undefined);
    await handle?.close().catch(() => undefined);
  }
}

export function createQualificationReporter(
  environment: NodeJS.ProcessEnv = process.env,
  hostPid = process.pid,
): QualificationReporter | undefined {
  const reportPath = environment[QUALIFICATION_REPORT_ENV]?.trim();
  const token = environment[QUALIFICATION_TOKEN_ENV]?.trim();
  const drawingPath = environment[QUALIFICATION_DRAWING_ENV]?.trim();
  const mode = environment[QUALIFICATION_MODE_ENV]?.trim();
  const closeAfter =
    environment[QUALIFICATION_CLOSE_AFTER_ENV]?.trim();
  if (
    !reportPath ||
    !path.isAbsolute(reportPath) ||
    !token ||
    !TOKEN_PATTERN.test(token) ||
    (mode !== "comparison" &&
      (!drawingPath || !path.isAbsolute(drawingPath))) ||
    (closeAfter !== "conversion" &&
      closeAfter !== "preview" &&
      closeAfter !== "full")
  ) {
    return undefined;
  }
  const reporter = new QualificationReporter(
    reportPath,
    closeAfter,
    hostPid,
  );
  void reporter.emit("extension-activated", {
    extension_host_pid: hostPid,
  });
  return reporter;
}
