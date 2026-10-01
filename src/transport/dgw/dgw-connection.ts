import { ConfigurationError, type MessengerError, NetworkError, RealtimeError } from "../../errors/errors.js";
import type { Logger } from "../../logging/logger.js";
import { abortError, type Deferred, deferred, raceAbort, withTimeout } from "../../util/abort.js";
import {
  decodeFrames,
  DgwCloseCode,
  type DgwFrame,
  encodeFrames,
  MAX_ACK_ID,
  MAX_STREAM_ID,
} from "./frames.js";

export type DgwCloseReason =
  | "closed_by_client"
  | "server_close"
  | "unauthorized"
  | "heartbeat_timeout"
  | "socket_error"
  | "handler_error";

/** Why the connection ended. `error` is absent only for a client-initiated close. */
export interface DgwClosedInfo {
  readonly reason: DgwCloseReason;
  readonly code?: number;
  readonly error?: MessengerError;
}

export interface DgwConnectionOptions {
  /** wss:// URL including the x-dgw-* query (ws:// is accepted for loopback test servers only). */
  url: string | URL;
  /** Handshake headers (cookie, origin, user-agent, sec-fetch-*). Never logged. */
  headers?: Readonly<Record<string, string>>;
  logger: Logger;
  /** Aborting the signal aborts opening, or closes an open connection. */
  signal?: AbortSignal;
  /** Client ping cadence. Default 10 s (protocol-status.md §3.1). */
  pingIntervalMs?: number;
  /** Close as dead after this long without any inbound message. Default 30 s. */
  inactivityTimeoutMs?: number;
  /** Wait for establish confirmations and acks. Default 5 s. */
  ackTimeoutMs?: number;
  /** Wait for a one-off response. Default 10 s. */
  responseTimeoutMs?: number;
  /** Server announced it will close soon (DGW "drain"). */
  onDrain?: (reason: number) => void;
}

export interface DgwStats {
  readonly messagesIn: number;
  readonly framesIn: number;
  readonly framesOut: number;
  readonly unsupportedFrames: number;
  readonly malformedMessages: number;
  readonly droppedBytes: number;
  readonly drains: number;
  readonly deauths: number;
  readonly openStreams: number;
  readonly lastInboundAt: number | undefined;
}

export interface OpenStreamOptions {
  /** JSON establish parameters. Default "{}". */
  parameters?: string;
  /** First data frame, sent together with the establish frame and acknowledged by the server. */
  initPayload?: Uint8Array;
  /**
   * Called synchronously, in order, for every data frame pushed on this stream. The frame
   * is acknowledged only after this returns; if it throws, the frame is NOT acknowledged
   * and the whole connection closes ("handler_error") so the data is re-synced later.
   */
  onData: (payload: Uint8Array) => void;
  /** The stream ended: closed by the server, or because the connection closed. */
  onClose?: (cause: "server" | "connection") => void;
  signal?: AbortSignal;
}

export interface DgwStream {
  readonly id: number;
  /** Sends a data frame and waits for the server's ack. */
  send(payload: Uint8Array, signal?: AbortSignal): Promise<void>;
  /** Ends the stream (sends end-of-data). Idempotent. */
  close(): void;
}

export interface RequestOptions {
  /** false = fire-and-forget (no ack, no response). Default true. */
  expectResponse?: boolean;
  signal?: AbortSignal;
  responseTimeoutMs?: number;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Ensures a rejected-but-unawaited internal promise never becomes an unhandled rejection. */
function quietDeferred<T>(): Deferred<T> {
  const d = deferred<T>();
  d.promise.catch(() => undefined);
  return d;
}

class OneOffStream {
  readonly established = quietDeferred<undefined>();
  readonly acked = quietDeferred<undefined>();
  readonly response = quietDeferred<Uint8Array>();
  constructor(readonly id: number) {}

  fail(error: Error): void {
    this.established.reject(error);
    this.acked.reject(error);
    this.response.reject(error);
  }
}

class PersistentStream {
  readonly established = quietDeferred<undefined>();
  readonly pendingAcks = new Map<number, Deferred<undefined>>();
  #nextAckId = 0;
  closed = false;

  constructor(
    readonly id: number,
    readonly onData: (payload: Uint8Array) => void,
    readonly onClose: ((cause: "server" | "connection") => void) | undefined,
  ) {}

  allocateAck(): { id: number; done: Deferred<undefined> } {
    for (let i = 0; i <= MAX_ACK_ID; i++) {
      const id = this.#nextAckId;
      this.#nextAckId = this.#nextAckId >= MAX_ACK_ID ? 0 : this.#nextAckId + 1;
      if (!this.pendingAcks.has(id)) {
        const done = quietDeferred<undefined>();
        this.pendingAcks.set(id, done);
        return { id, done };
      }
    }
    throw new RealtimeError("DGW: too many unacknowledged frames on one stream");
  }

  fail(error: Error): void {
    this.established.reject(error);
    for (const pending of this.pendingAcks.values()) pending.reject(error);
    this.pendingAcks.clear();
  }
}

type Stream = OneOffStream | PersistentStream;

/**
 * One DGW connection over the native WebSocket (Node ≥ 24 supports custom handshake headers;
 * protocol-status.md §3.1). It multiplexes one-off request/response streams and persistent
 * push streams, keeps the link alive with pings, and reports its end exactly once through
 * `closed`. It never reconnects by itself: that is the supervisor's job.
 */
export class DgwConnection {
  /** Settles exactly once, never rejects. */
  readonly closed: Promise<DgwClosedInfo>;

  readonly #ws: WebSocket;
  readonly #log: Logger;
  readonly #options: Required<
    Pick<
      DgwConnectionOptions,
      "pingIntervalMs" | "inactivityTimeoutMs" | "ackTimeoutMs" | "responseTimeoutMs"
    >
  > &
    Pick<DgwConnectionOptions, "onDrain" | "signal">;
  readonly #streams = new Map<number, Stream>();
  readonly #resolveClosed: (info: DgwClosedInfo) => void;
  #closedInfo: DgwClosedInfo | undefined;
  #nextStreamId = 0;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  #stats = {
    messagesIn: 0,
    framesIn: 0,
    framesOut: 0,
    unsupportedFrames: 0,
    malformedMessages: 0,
    droppedBytes: 0,
    drains: 0,
    deauths: 0,
    lastInboundAt: undefined as number | undefined,
  };

  /** Opens the WebSocket and resolves once the handshake completed. */
  static open(options: DgwConnectionOptions): Promise<DgwConnection> {
    const url = new URL(options.url);
    if (url.protocol !== "wss:" && !(url.protocol === "ws:" && LOOPBACK.has(url.hostname))) {
      return Promise.reject(
        new ConfigurationError("DGW requires a wss:// URL (ws:// only for loopback test servers)"),
      );
    }
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal));

    return new Promise<DgwConnection>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { ...options.headers } });
      ws.binaryType = "arraybuffer";
      const cleanup = (): void => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onOpen = (): void => {
        cleanup();
        resolve(new DgwConnection(ws, options));
      };
      const onError = (): void => {
        cleanup();
        reject(
          new NetworkError("DGW WebSocket handshake failed", "NETWORK", { details: { host: url.host } }),
        );
      };
      const onClose = (event: CloseEvent): void => {
        cleanup();
        reject(
          new NetworkError("DGW WebSocket closed during handshake", "NETWORK", {
            details: { host: url.host, closeCode: event.code },
          }),
        );
      };
      const onAbort = (): void => {
        cleanup();
        try {
          ws.close();
        } catch {
          // already closing
        }
        reject(abortError(options.signal as AbortSignal));
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private constructor(ws: WebSocket, options: DgwConnectionOptions) {
    this.#ws = ws;
    this.#log = options.logger;
    this.#options = {
      pingIntervalMs: options.pingIntervalMs ?? 10_000,
      inactivityTimeoutMs: options.inactivityTimeoutMs ?? 30_000,
      ackTimeoutMs: options.ackTimeoutMs ?? 5_000,
      responseTimeoutMs: options.responseTimeoutMs ?? 10_000,
      ...(options.onDrain === undefined ? {} : { onDrain: options.onDrain }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    let resolveClosed!: (info: DgwClosedInfo) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;

    ws.addEventListener("message", this.#onMessage);
    ws.addEventListener("close", this.#onClose);
    ws.addEventListener("error", this.#onError);
    this.#options.signal?.addEventListener("abort", this.#onAbort, { once: true });
    this.#pingTimer = setInterval(() => {
      this.#trySend([{ type: "ping" }]);
    }, this.#options.pingIntervalMs);
    this.#armInactivityTimer();
    this.#log.debug("dgw connected");
  }

  get isOpen(): boolean {
    return this.#closedInfo === undefined;
  }

  get stats(): DgwStats {
    return { ...this.#stats, openStreams: this.#streams.size };
  }

  /**
   * One-off request/response stream: establish + data → ack → response data → our ack +
   * end-of-data (protocol-status.md §3.3). Resolves with the response payload (or undefined
   * for fire-and-forget).
   */
  async request(payload: Uint8Array, options: RequestOptions = {}): Promise<Uint8Array | undefined> {
    const expectResponse = options.expectResponse ?? true;
    const stream = new OneOffStream(this.#allocateStreamId());
    this.#streams.set(stream.id, stream);
    try {
      this.#send([
        { type: "establish", streamId: stream.id, parameters: "{}" },
        { type: "data", streamId: stream.id, ackId: 0, requiresAck: expectResponse, payload },
      ]);
      await this.#wait(
        stream.established.promise,
        this.#options.ackTimeoutMs,
        "DGW stream establish",
        options.signal,
      );
      if (!expectResponse) return undefined;
      await this.#wait(stream.acked.promise, this.#options.ackTimeoutMs, "DGW request ack", options.signal);
      return await this.#wait(
        stream.response.promise,
        options.responseTimeoutMs ?? this.#options.responseTimeoutMs,
        "DGW response",
        options.signal,
      );
    } catch (error) {
      if (this.#streams.get(stream.id) === stream)
        this.#trySend([{ type: "endOfData", streamId: stream.id }]);
      throw error;
    } finally {
      if (this.#streams.get(stream.id) === stream) this.#streams.delete(stream.id);
    }
  }

  /** Opens a persistent stream that the server pushes data frames on. */
  async openStream(options: OpenStreamOptions): Promise<DgwStream> {
    const stream = new PersistentStream(this.#allocateStreamId(), options.onData, options.onClose);
    this.#streams.set(stream.id, stream);
    const frames: DgwFrame[] = [
      { type: "establish", streamId: stream.id, parameters: options.parameters ?? "{}" },
    ];
    let initAck: Deferred<undefined> | undefined;
    if (options.initPayload) {
      const ack = stream.allocateAck();
      initAck = ack.done;
      frames.push({
        type: "data",
        streamId: stream.id,
        ackId: ack.id,
        requiresAck: true,
        payload: options.initPayload,
      });
    }
    try {
      this.#send(frames);
      await this.#wait(
        stream.established.promise,
        this.#options.ackTimeoutMs,
        "DGW stream establish",
        options.signal,
      );
      if (initAck)
        await this.#wait(initAck.promise, this.#options.ackTimeoutMs, "DGW stream init ack", options.signal);
    } catch (error) {
      this.#endStream(stream);
      throw error;
    }
    return {
      id: stream.id,
      send: async (payload, signal) => {
        if (stream.closed || this.#streams.get(stream.id) !== stream)
          throw new RealtimeError("DGW stream is closed");
        const ack = stream.allocateAck();
        this.#send([{ type: "data", streamId: stream.id, ackId: ack.id, requiresAck: true, payload }]);
        try {
          await this.#wait(ack.done.promise, this.#options.ackTimeoutMs, "DGW data ack", signal);
        } finally {
          stream.pendingAcks.delete(ack.id);
        }
      },
      close: () => {
        this.#endStream(stream);
      },
    };
  }

  /** Closes the connection. Idempotent. */
  close(): Promise<void> {
    if (this.#closedInfo) return Promise.resolve();
    this.#finish({ reason: "closed_by_client" });
    try {
      this.#ws.close(1000);
    } catch {
      // already closing
    }
    return Promise.resolve();
  }

  // ---------------------------------------------------------------- inbound

  readonly #onMessage = (event: MessageEvent): void => {
    if (this.#closedInfo) return;
    this.#stats.messagesIn++;
    this.#stats.lastInboundAt = Date.now();
    this.#armInactivityTimer();
    const data: unknown = event.data;
    if (!(data instanceof ArrayBuffer)) {
      this.#log.warn("dgw: ignoring non-binary message");
      return;
    }
    const decoded = decodeFrames(new Uint8Array(data));
    this.#stats.framesIn += decoded.frames.length;
    for (const frame of decoded.frames) {
      this.#handleFrame(frame);
      // A frame handler may have closed the connection (e.g. a failing stream handler).
      if (!this.isOpen) return;
    }
    if (decoded.stopped) {
      if (decoded.stopped.kind === "unsupported") this.#stats.unsupportedFrames++;
      else this.#stats.malformedMessages++;
      this.#stats.droppedBytes += decoded.stopped.droppedBytes;
      this.#log.warn("dgw: dropped part of a message (possible data loss)", {
        kind: decoded.stopped.kind,
        frameType: decoded.stopped.frameType,
        droppedBytes: decoded.stopped.droppedBytes,
        detail: decoded.stopped.detail,
      });
    }
  };

  #handleFrame(frame: DgwFrame): void {
    switch (frame.type) {
      case "ping":
        this.#trySend([{ type: "pong" }]);
        return;
      case "pong":
        return;
      case "drain":
        this.#stats.drains++;
        this.#log.info("dgw: server announced drain", { reason: frame.reason });
        this.#options.onDrain?.(frame.reason);
        return;
      case "deauth":
        this.#stats.deauths++;
        this.#log.warn("dgw: received deauth frame");
        return;
      case "ack": {
        const stream = this.#streams.get(frame.streamId);
        if (stream instanceof OneOffStream) {
          if (frame.ackId === 0) stream.acked.resolve(undefined);
        } else if (stream) {
          stream.pendingAcks.get(frame.ackId)?.resolve(undefined);
          stream.pendingAcks.delete(frame.ackId);
        } else {
          this.#log.debug("dgw: ack for unknown stream", { streamId: frame.streamId });
        }
        return;
      }
      case "establish": {
        const stream = this.#streams.get(frame.streamId);
        if (!stream) {
          this.#log.debug("dgw: establish response for unknown stream", { streamId: frame.streamId });
          return;
        }
        const code = establishCode(frame.parameters);
        if (code === 200) stream.established.resolve(undefined);
        else {
          stream.established.reject(
            new RealtimeError(`DGW stream establish failed (code ${code ?? "missing"})`, {
              details: { streamId: frame.streamId, code: code ?? null },
            }),
          );
        }
        return;
      }
      case "data": {
        const stream = this.#streams.get(frame.streamId);
        if (!stream) {
          this.#log.debug("dgw: data for unknown stream", { streamId: frame.streamId });
          if (frame.requiresAck)
            this.#trySend([{ type: "ack", streamId: frame.streamId, ackId: frame.ackId }]);
          return;
        }
        if (stream instanceof OneOffStream) {
          stream.response.resolve(frame.payload);
          const reply: DgwFrame[] = frame.requiresAck
            ? [{ type: "ack", streamId: stream.id, ackId: frame.ackId }]
            : [];
          reply.push({ type: "endOfData", streamId: stream.id });
          this.#trySend(reply);
          return;
        }
        try {
          stream.onData(frame.payload);
        } catch (error) {
          this.#log.error("dgw: stream data handler failed; closing so the data is re-synced", {
            streamId: stream.id,
            error,
          });
          this.#abortConnection(
            "handler_error",
            new RealtimeError("DGW stream data handler failed", { cause: error }),
          );
          return;
        }
        if (frame.requiresAck) this.#trySend([{ type: "ack", streamId: stream.id, ackId: frame.ackId }]);
        return;
      }
      case "endOfData": {
        const stream = this.#streams.get(frame.streamId);
        if (!stream) return;
        this.#streams.delete(frame.streamId);
        const error = new RealtimeError("DGW stream ended by the server", {
          details: { streamId: frame.streamId, reason: frame.reason ?? null },
        });
        if (stream instanceof OneOffStream) {
          stream.fail(error);
        } else {
          stream.closed = true;
          stream.fail(error);
          safeCall(() => stream.onClose?.("server"), this.#log);
        }
        return;
      }
    }
  }

  readonly #onClose = (event: CloseEvent): void => {
    if (event.code === (DgwCloseCode.Unauthorized as number)) {
      this.#finish({
        reason: "unauthorized",
        code: event.code,
        error: new RealtimeError("DGW rejected the session (close code 4003)", {
          retryable: false,
          details: { closeCode: event.code },
        }),
      });
      return;
    }
    this.#finish({
      reason: "server_close",
      code: event.code,
      error: new RealtimeError(`DGW connection closed (code ${event.code})`, {
        details: { closeCode: event.code, closeReason: event.reason || null },
      }),
    });
  };

  readonly #onError = (): void => {
    this.#abortConnection("socket_error", new RealtimeError("DGW WebSocket error"));
  };

  readonly #onAbort = (): void => {
    void this.close();
  };

  // ---------------------------------------------------------------- internals

  #armInactivityTimer(): void {
    if (this.#inactivityTimer !== undefined) clearTimeout(this.#inactivityTimer);
    this.#inactivityTimer = setTimeout(() => {
      this.#abortConnection(
        "heartbeat_timeout",
        new RealtimeError(`No DGW traffic for ${this.#options.inactivityTimeoutMs} ms`, {
          details: { timeoutMs: this.#options.inactivityTimeoutMs },
        }),
      );
    }, this.#options.inactivityTimeoutMs);
  }

  #abortConnection(reason: DgwCloseReason, error: MessengerError): void {
    if (this.#closedInfo) return;
    this.#finish({ reason, error });
    try {
      this.#ws.close(1000);
    } catch {
      // already closing
    }
  }

  #finish(info: DgwClosedInfo): void {
    if (this.#closedInfo) return;
    this.#closedInfo = info;
    if (this.#pingTimer !== undefined) clearInterval(this.#pingTimer);
    if (this.#inactivityTimer !== undefined) clearTimeout(this.#inactivityTimer);
    this.#pingTimer = undefined;
    this.#inactivityTimer = undefined;
    this.#options.signal?.removeEventListener("abort", this.#onAbort);
    this.#ws.removeEventListener("message", this.#onMessage);
    const failure = new RealtimeError("DGW connection closed", { details: { reason: info.reason } });
    const streams = [...this.#streams.values()];
    this.#streams.clear();
    for (const stream of streams) {
      stream.fail(failure);
      if (stream instanceof PersistentStream && !stream.closed) {
        stream.closed = true;
        safeCall(() => stream.onClose?.("connection"), this.#log);
      }
    }
    if (info.reason !== "closed_by_client") {
      this.#log.info("dgw connection closed", { reason: info.reason, code: info.code });
    }
    this.#resolveClosed(info);
  }

  #endStream(stream: PersistentStream): void {
    if (this.#streams.get(stream.id) !== stream) return;
    this.#streams.delete(stream.id);
    stream.closed = true;
    stream.fail(new RealtimeError("DGW stream closed by client"));
    this.#trySend([{ type: "endOfData", streamId: stream.id }]);
  }

  #allocateStreamId(): number {
    if (this.#closedInfo) throw new RealtimeError("DGW connection is closed");
    for (let i = 0; i <= MAX_STREAM_ID; i++) {
      const id = this.#nextStreamId;
      this.#nextStreamId = this.#nextStreamId >= MAX_STREAM_ID ? 0 : this.#nextStreamId + 1;
      if (!this.#streams.has(id)) return id;
    }
    throw new RealtimeError("DGW: no free stream ids");
  }

  #send(frames: DgwFrame[]): void {
    if (this.#closedInfo || this.#ws.readyState !== WebSocket.OPEN) {
      throw new RealtimeError("DGW connection is not open");
    }
    this.#ws.send(encodeFrames(frames));
    this.#stats.framesOut += frames.length;
  }

  #trySend(frames: DgwFrame[]): void {
    try {
      this.#send(frames);
    } catch (error) {
      this.#log.debug("dgw: send skipped", { error });
    }
  }

  async #wait<T>(promise: Promise<T>, timeoutMs: number, what: string, signal?: AbortSignal): Promise<T> {
    const scope = withTimeout(signal, timeoutMs, what);
    try {
      return await raceAbort(promise, scope.signal);
    } finally {
      scope.dispose();
    }
  }
}

/** Establish responses carry a status code either as a bare number or as `{ "code": … }`. */
function establishCode(parameters: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(parameters);
    if (typeof parsed === "number") return parsed;
    if (typeof parsed === "object" && parsed !== null) {
      const code = (parsed as { code?: unknown }).code;
      return typeof code === "number" ? code : undefined;
    }
  } catch {
    // fall through
  }
  return undefined;
}

function safeCall(fn: () => void, log: Logger): void {
  try {
    fn();
  } catch (error) {
    log.warn("dgw: stream close callback threw", { error });
  }
}
