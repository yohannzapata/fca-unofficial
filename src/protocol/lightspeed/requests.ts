import { ProtocolError } from "../../errors/errors.js";

/**
 * Lightspeed request/response envelopes (protocol-status.md §3.4).
 *
 * 64-bit integers (epoch ids, the schema version) routinely exceed 2^53, so they are
 * carried as decimal strings and written into the JSON as raw digits rather than going
 * through JavaScript numbers.
 */

/** Envelope `type` values. */
export const LsRequestType = {
  SyncWithParams: 1,
  SyncWithCursor: 2,
  Task: 3,
  FireAndForget: 4,
} as const;
export type LsRequestType = (typeof LsRequestType)[keyof typeof LsRequestType];

const DIGITS = /^-?\d{1,20}$/;

function rawInt(value: string, field: string): string {
  if (!DIGITS.test(value)) throw new RangeError(`${field} must be a decimal integer`);
  return value;
}

/**
 * Epoch ids: `(unixMillis << 22) | (sameMillisecondCounter << 12) | 42`, as observed in the
 * reference client (the meaning of the constant 42 is unknown).
 */
export function createEpochIdGenerator(now: () => number = Date.now): () => string {
  let lastMs = -1;
  let counter = 0;
  return () => {
    const ms = now();
    if (ms === lastMs) counter = (counter + 1) & 0x3ff;
    else {
      lastMs = ms;
      counter = 0;
    }
    return ((BigInt(ms) << 22n) | (BigInt(counter) << 12n) | 42n).toString();
  };
}

export interface DatabaseQuery {
  readonly database: number;
  /** LS schema version (`versionId` from the messages page), decimal text. */
  readonly version: string;
  readonly epochId: string;
  /** Sent for type 1 requests. */
  readonly syncParams?: string;
  /** Sent for type 2 requests (null on the very first sync). */
  readonly lastAppliedCursor?: string | null;
}

/** `{"database","last_applied_cursor","sync_params","epoch_id","version","failure_count"}` */
export function buildDatabaseQuery(query: DatabaseQuery): string {
  return (
    `{"database":${rawInt(String(query.database), "database")}` +
    `,"last_applied_cursor":${query.lastAppliedCursor == null ? "null" : JSON.stringify(query.lastAppliedCursor)}` +
    `,"sync_params":${query.syncParams === undefined ? "null" : JSON.stringify(query.syncParams)}` +
    `,"epoch_id":${rawInt(query.epochId, "epoch_id")}` +
    `,"version":${rawInt(query.version, "version")}` +
    `,"failure_count":null}`
  );
}

export interface TaskSpec {
  readonly label: string;
  /** Task payload, already serialized to JSON text. */
  readonly payload: string;
  readonly queueName: string;
  readonly taskId: number;
}

/** `{"epoch_id","tasks":[{"failure_count","label","payload","queue_name","task_id"}],"version_id"}` */
export function buildTaskBatch(options: {
  epochId: string;
  versionId: string;
  tasks: readonly TaskSpec[];
}): string {
  const tasks = options.tasks
    .map(
      (t) =>
        `{"failure_count":null,"label":${JSON.stringify(t.label)},"payload":${JSON.stringify(t.payload)}` +
        `,"queue_name":${JSON.stringify(t.queueName)},"task_id":${t.taskId}}`,
    )
    .join(",");
  return `{"epoch_id":${rawInt(options.epochId, "epoch_id")},"tasks":[${tasks}],"version_id":${JSON.stringify(rawInt(options.versionId, "version_id"))}}`;
}

/**
 * Thread-list fetch (task label 145, queue "trq"), as sent by the reference client right
 * after its first connection. Read-only.
 */
export function fetchThreadsTask(options: {
  syncGroup: 1 | 95;
  cursor: string | null;
  taskId: number;
}): TaskSpec {
  const payload =
    `{"is_after":0,"parent_thread_key":-1,"reference_thread_key":0,"reference_activity_timestamp":9999999999999` +
    `,"additional_pages_to_fetch":0,"cursor":${options.cursor === null ? "null" : JSON.stringify(options.cursor)}` +
    `,"messaging_tag":null,"sync_group":${options.syncGroup}}`;
  return { label: "145", payload, queueName: "trq", taskId: options.taskId };
}

/** `{"app_id","payload","request_id","type"}` */
export function buildEnvelope(options: {
  appId: string;
  payload: string;
  requestId: number;
  type: LsRequestType;
}): string {
  if (!Number.isInteger(options.requestId) || options.requestId < 1 || options.requestId > 0xffff) {
    throw new RangeError("request_id must be within 1..65535");
  }
  return JSON.stringify({
    app_id: options.appId,
    payload: options.payload,
    request_id: options.requestId,
    type: options.type,
  });
}

export interface LsResponse {
  readonly requestId: number | undefined;
  /** The Lightspeed payload document (JSON text), if any. */
  readonly payload: string | undefined;
  readonly dependencies: readonly string[];
}

/** Parses a response/push envelope `{"request_id","payload","sp","target"}`. */
export function parseLsResponse(text: string): LsResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ProtocolError("lightspeed", "Lightspeed envelope is not valid JSON", "PROTOCOL", {
      cause: error,
      details: { bytes: text.length },
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolError("lightspeed", "Lightspeed envelope is not an object");
  }
  const envelope = parsed as Record<string, unknown>;
  const requestId = envelope["request_id"];
  const payload = envelope["payload"];
  const sp = envelope["sp"];
  return {
    requestId: typeof requestId === "number" && Number.isInteger(requestId) ? requestId : undefined,
    payload: typeof payload === "string" && payload !== "" ? payload : undefined,
    dependencies: Array.isArray(sp) ? sp.filter((d): d is string => typeof d === "string") : [],
  };
}
