import { randomUUID } from "node:crypto";
import {
  ProtocolError,
  RealtimeError,
  TimeoutError,
  toMessengerError,
  type MessengerError,
} from "../../errors/errors.js";
import type { ConnectionClosedInfo, SupervisedConnection } from "../../lifecycle/supervisor.js";
import type { Logger } from "../../logging/logger.js";
import type { CookieJar } from "../../transport/http/cookie-jar.js";
import { DgwConnection, type DgwStream } from "../../transport/dgw/dgw-connection.js";
import { type Deferred, deferred } from "../../util/abort.js";
import type { BootstrapConfig } from "../bootstrap/bootstrap-config.js";
import type { BrowserProfile } from "../bootstrap/browser-profile.js";
import { type DecodeStats, decodeLightspeedPayload } from "../lightspeed/decoder.js";
import { type ParsedCall, parseProcedureCall } from "../lightspeed/procedures.js";
import {
  buildDatabaseQuery,
  buildEnvelope,
  buildTaskBatch,
  createEpochIdGenerator,
  fetchThreadsTask,
  type LsResponse,
  LsRequestType,
  parseLsResponse,
} from "../lightspeed/requests.js";
import {
  applyFirstBlock,
  type FirstBlock,
  restoreSyncState,
  SYNC_DATABASES,
  type SyncDatabaseState,
  syncParamsFor,
  type SyncStateMap,
} from "../sync/sync-state.js";

/** Where a batch of rows came from. Only live, sync and reconcile batches produce events. */
export type BatchSource =
  | "baseline" // first-ever sync of a database (no stored cursor): current state, not news
  | "sync" // catch-up from a stored cursor after (re)connecting
  | "reconcile" // periodic re-sync while connected (silent-stall defence)
  | "live" // pushed by the server in real time
  | "task"; // response to a read task (e.g. thread list)

export interface RowBatch {
  readonly source: BatchSource;
  readonly database: number | undefined;
  readonly calls: readonly ParsedCall[];
  readonly decodeStats: DecodeStats;
}

export interface RealtimeSink {
  /** Called synchronously, in arrival order. Throwing aborts the connection (data is re-synced). */
  batch(batch: RowBatch): void;
  /** New cursor state to persist (debounced by the caller). */
  syncState(state: SyncStateMap): void;
}

export interface RealtimeTuning {
  /** Test override for the gateway; production uses wss://gateway.facebook.com/ws/lightspeed. */
  gatewayUrl?: string;
  reconcileIntervalMs?: number;
  syncResponseTimeoutMs?: number;
  pingIntervalMs?: number;
  inactivityTimeoutMs?: number;
  ackTimeoutMs?: number;
  responseTimeoutMs?: number;
}

export interface RealtimeSessionOptions {
  readonly config: BootstrapConfig;
  readonly userId: string;
  readonly cookies: CookieJar;
  readonly profile: BrowserProfile;
  readonly logger: Logger;
  readonly now: () => number;
  readonly sink: RealtimeSink;
  /** Stored cursors from the session, if any. */
  readonly syncState: SyncStateMap | undefined;
  /** Send the reference client's initial thread-list fetch (first connection of a client). */
  readonly initialThreadFetch: boolean;
  readonly tuning?: RealtimeTuning;
}

export const GATEWAY_URL = "wss://gateway.facebook.com/ws/lightspeed";

export interface RealtimeStats {
  readonly syncPages: number;
  readonly liveBatches: number;
  readonly reconciliations: number;
  readonly unknownProcedures: number;
  readonly unsupportedOps: number;
}
const MAX_SYNC_PAGES = 100;

/**
 * One realtime connection: DGW socket + Lightspeed sync streams (protocol-status.md §3.4–3.6).
 * Implements SupervisedConnection, so the ConnectionSupervisor owns reconnection.
 */
export class RealtimeSession implements SupervisedConnection {
  readonly closed: Promise<ConnectionClosedInfo>;

  readonly #dgw: DgwConnection;
  readonly #options: RealtimeSessionOptions;
  readonly #log: Logger;
  readonly #config: { readonly appId: string; readonly lsVersionId: string };
  readonly #state: Record<number, SyncDatabaseState>;
  readonly #streams = new Map<number, DgwStream>();
  readonly #waiters = new Map<number, Deferred<LsResponse>>();
  readonly #syncing = new Set<number>();
  readonly #nextEpochId: () => string;
  #nextRequestId = 0;
  #nextTaskId = 0;
  #reconcileTimer: ReturnType<typeof setInterval> | undefined;
  #failure: { reason: string; error: MessengerError } | undefined;
  #stats: { -readonly [K in keyof RealtimeStats]: RealtimeStats[K] } = {
    syncPages: 0,
    liveBatches: 0,
    reconciliations: 0,
    unknownProcedures: 0,
    unsupportedOps: 0,
  };

  /** Opens the gateway, performs the initial sync, and starts listening. */
  static async start(options: RealtimeSessionOptions, signal: AbortSignal): Promise<RealtimeSession> {
    const { config } = options;
    const missing = [
      config.appId === undefined ? "appId" : "",
      config.dgwAppId === undefined ? "dgwAppId" : "",
      config.deviceClientId === undefined ? "deviceClientId" : "",
      config.lsVersionId === undefined ? "lsVersionId" : "",
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new ProtocolError(
        "realtime",
        `The messages page lacks values needed for realtime: ${missing.join(", ")}`,
        "PROTOCOL",
        {
          details: { missing: missing.join(",") },
        },
      );
    }

    const url = gatewayUrl(options.tuning?.gatewayUrl ?? GATEWAY_URL, {
      appId: config.dgwAppId as string,
      userId: options.userId,
      deviceId: config.deviceClientId as string,
    });
    const tuning = options.tuning ?? {};
    const cookie = options.cookies.cookieHeader(new URL(url));
    const dgw = await DgwConnection.open({
      url,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        "user-agent": options.profile.userAgent,
        origin: "https://www.facebook.com",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "websocket",
        "sec-fetch-site": "same-site",
      },
      logger: options.logger.child({ component: "dgw" }),
      signal,
      ...(tuning.pingIntervalMs === undefined ? {} : { pingIntervalMs: tuning.pingIntervalMs }),
      ...(tuning.inactivityTimeoutMs === undefined
        ? {}
        : { inactivityTimeoutMs: tuning.inactivityTimeoutMs }),
      ...(tuning.ackTimeoutMs === undefined ? {} : { ackTimeoutMs: tuning.ackTimeoutMs }),
      ...(tuning.responseTimeoutMs === undefined ? {} : { responseTimeoutMs: tuning.responseTimeoutMs }),
    });

    const session = new RealtimeSession(dgw, options);
    try {
      await session.#initialSync(signal);
    } catch (error) {
      await session.close();
      throw error;
    }
    session.#startReconciliation();
    return session;
  }

  private constructor(dgw: DgwConnection, options: RealtimeSessionOptions) {
    this.#dgw = dgw;
    this.#options = options;
    this.#log = options.logger.child({ component: "realtime" });
    this.#config = {
      appId: options.config.appId as string,
      lsVersionId: options.config.lsVersionId as string,
    };
    this.#state = restoreSyncState(options.syncState);
    this.#nextEpochId = createEpochIdGenerator(options.now);
    this.closed = dgw.closed.then((info): ConnectionClosedInfo => {
      this.#stopReconciliation();
      for (const waiter of this.#waiters.values())
        waiter.reject(new RealtimeError("Realtime connection closed"));
      this.#waiters.clear();
      if (this.#failure) return { reason: this.#failure.reason, error: this.#failure.error };
      return info.error ? { reason: info.reason, error: info.error } : { reason: info.reason };
    });
  }

  get stats(): RealtimeStats & { readonly dgw: DgwConnection["stats"] } {
    return { ...this.#stats, dgw: this.#dgw.stats };
  }

  close(): Promise<void> {
    this.#stopReconciliation();
    return this.#dgw.close();
  }

  // ------------------------------------------------------------------ sync

  async #initialSync(signal: AbortSignal): Promise<void> {
    if (this.#options.initialThreadFetch) await this.#fetchThreadList(signal);
    const results = await Promise.allSettled(
      SYNC_DATABASES.map(async (db) => {
        const stream = await this.#dgw.openStream({
          onData: (payload) => {
            this.#onStreamData(db, payload);
          },
          onClose: (cause) => {
            this.#onStreamClosed(db, cause);
          },
          signal,
        });
        this.#streams.set(db, stream);
        await this.#syncDatabase(db, this.#state[db]?.cursor === null ? "baseline" : "sync", signal);
      }),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        this.#log.warn("database sync failed", {
          database: SYNC_DATABASES[index],
          error: toMessengerError(result.reason),
        });
      }
    });
    // Database 1 (the mailbox) is required; the others are best-effort, as in the reference client.
    const mailbox = results[0];
    if (mailbox?.status === "rejected") throw toMessengerError(mailbox.reason);
  }

  async #fetchThreadList(signal: AbortSignal): Promise<void> {
    const payload = buildTaskBatch({
      epochId: this.#nextEpochId(),
      versionId: this.#config.lsVersionId,
      tasks: [
        fetchThreadsTask({ syncGroup: 1, cursor: this.#state[1]?.cursor ?? "", taskId: this.#nextTaskId++ }),
        fetchThreadsTask({ syncGroup: 95, cursor: null, taskId: this.#nextTaskId++ }),
      ],
    });
    const response = await this.#dgw.request(this.#encode(payload, LsRequestType.Task), { signal });
    if (response) this.#processResponse(parseLsResponse(text(response)), "task", undefined);
  }

  /** Syncs one database from its cursor, following the cursor until it stops advancing. */
  async #syncDatabase(db: number, source: BatchSource, signal?: AbortSignal): Promise<void> {
    if (this.#syncing.has(db)) return;
    this.#syncing.add(db);
    try {
      for (let page = 0; page < MAX_SYNC_PAGES; page++) {
        const stream = this.#streams.get(db);
        if (!stream) throw new RealtimeError(`No sync stream for database ${db}`);
        const state = this.#state[db] as SyncDatabaseState;
        const query = buildDatabaseQuery({
          database: db,
          version: this.#config.lsVersionId,
          epochId: this.#nextEpochId(),
          ...(state.sendSyncParams
            ? { syncParams: syncParamsFor(state, this.#options.config.syncParams) ?? "" }
            : { lastAppliedCursor: state.cursor }),
        });
        const requestId = this.#allocateRequestId();
        const waiter = deferred<LsResponse>();
        waiter.promise.catch(() => undefined);
        this.#waiters.set(requestId, waiter);
        const timeoutMs = this.#options.tuning?.syncResponseTimeoutMs ?? 30_000;
        const timer = setTimeout(() => {
          waiter.reject(new TimeoutError(`No sync response for database ${db} within ${timeoutMs} ms`));
        }, timeoutMs);
        let response: LsResponse;
        try {
          await stream.send(
            this.#encodeWithId(
              query,
              state.sendSyncParams ? LsRequestType.SyncWithParams : LsRequestType.SyncWithCursor,
              requestId,
            ),
            signal,
          );
          response = await waiter.promise;
        } finally {
          clearTimeout(timer);
          this.#waiters.delete(requestId);
        }
        this.#stats.syncPages++;
        const advanced = this.#processResponse(response, source, db);
        if (!advanced) return;
      }
      this.#log.warn("sync stopped after the page limit", { database: db, pages: MAX_SYNC_PAGES });
    } finally {
      this.#syncing.delete(db);
    }
  }

  /** Decodes a response, hands rows to the sink, then advances cursors. Returns whether `db`'s cursor advanced. */
  #processResponse(response: LsResponse, source: BatchSource, db: number | undefined): boolean {
    if (!response.payload) return false;
    const decoded = decodeLightspeedPayload(response.payload);
    const calls = decoded.calls.map(parseProcedureCall);
    this.#stats.unknownProcedures += calls.filter((c) => "unknown" in c).length;
    this.#stats.unsupportedOps += Object.values(decoded.stats.unsupportedOps).reduce((a, b) => a + b, 0);
    this.#options.sink.batch({ source, database: db, calls, decodeStats: decoded.stats });

    let advancedRequested = false;
    let changed = false;
    for (const call of calls) {
      if (
        "unknown" in call ||
        (call.procedure !== "executeFirstBlockForSyncTransaction" &&
          call.procedure !== "executeFirstBlockForSyncTransactionV4")
      ) {
        continue;
      }
      const block = call.row as FirstBlock;
      const target = block.databaseId === undefined ? db : Number(block.databaseId);
      if (target === undefined || !(target in this.#state)) continue;
      const { state, advanced } = applyFirstBlock(this.#state[target] as SyncDatabaseState, block);
      this.#state[target] = state;
      changed = true;
      if (advanced && target === db) advancedRequested = true;
    }
    if (changed) this.#options.sink.syncState({ ...this.#state });
    return advancedRequested;
  }

  // ------------------------------------------------------------------ inbound

  #onStreamData(db: number, payload: Uint8Array): void {
    const response = parseLsResponse(text(payload));
    const waiter = response.requestId === undefined ? undefined : this.#waiters.get(response.requestId);
    if (waiter) {
      waiter.resolve(response);
      return;
    }
    this.#stats.liveBatches++;
    this.#processResponse(response, "live", db);
  }

  #onStreamClosed(db: number, cause: "server" | "connection"): void {
    this.#streams.delete(db);
    if (cause !== "server") return;
    if (db === 1) {
      this.#fail("sync_stream_ended", new RealtimeError("The server ended the mailbox sync stream"));
    } else {
      this.#log.warn("the server ended a sync stream", { database: db });
    }
  }

  // ------------------------------------------------------------------ reconciliation

  #startReconciliation(): void {
    const interval = this.#options.tuning?.reconcileIntervalMs ?? 5 * 60_000;
    if (!(interval > 0) || !Number.isFinite(interval)) return;
    this.#reconcileTimer = setInterval(() => {
      if (!this.#dgw.isOpen || this.#syncing.has(1)) return;
      this.#stats.reconciliations++;
      this.#syncDatabase(1, "reconcile").catch((error: unknown) => {
        this.#fail("reconcile_failed", toMessengerError(error));
      });
    }, interval);
  }

  #stopReconciliation(): void {
    if (this.#reconcileTimer !== undefined) clearInterval(this.#reconcileTimer);
    this.#reconcileTimer = undefined;
  }

  #fail(reason: string, error: MessengerError): void {
    if (this.#failure || !this.#dgw.isOpen) return;
    this.#log.warn("closing realtime session", { reason, code: error.code });
    this.#failure = {
      reason,
      error: error.retryable ? error : new RealtimeError(error.message, { cause: error }),
    };
    void this.#dgw.close();
  }

  // ------------------------------------------------------------------ helpers

  #allocateRequestId(): number {
    this.#nextRequestId = this.#nextRequestId >= 0xffff ? 1 : this.#nextRequestId + 1;
    return this.#nextRequestId;
  }

  #encode(payload: string, type: LsRequestType): Uint8Array {
    return this.#encodeWithId(payload, type, this.#allocateRequestId());
  }

  #encodeWithId(payload: string, type: LsRequestType, requestId: number): Uint8Array {
    return new TextEncoder().encode(buildEnvelope({ appId: this.#config.appId, payload, requestId, type }));
  }
}

/**
 * Builds the gateway URL. Query keys are sorted, as Go's url.Values.Encode() produces them
 * in the reference client (protocol-status.md §3.1).
 */
export function gatewayUrl(base: string, ids: { appId: string; userId: string; deviceId: string }): string {
  const url = new URL(base);
  const params: [string, string][] = [
    ["x-dgw-appid", ids.appId],
    ["x-dgw-appversion", "0"],
    ["x-dgw-authtype", "1:0"],
    ["x-dgw-deviceid", ids.deviceId],
    ["x-dgw-loggingid", randomUUID()],
    ["x-dgw-tier", "prod"],
    ["x-dgw-uuid", ids.userId],
    ["x-dgw-version", "5"],
  ];
  for (const [key, value] of params) url.searchParams.set(key, value);
  return url.toString();
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
