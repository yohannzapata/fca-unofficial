import {
  ConfigurationError,
  type MessengerError,
  OperationAbortedError,
  RealtimeError,
  toMessengerError,
} from "../errors/errors.js";
import { type Logger, silentLogger } from "../logging/logger.js";
import { type Deferred, deferred, raceAbort, sleep, withTimeout } from "../util/abort.js";
import { type BackoffOptions, computeBackoffDelay, resolveBackoffOptions } from "./backoff.js";
import { type ConnectionState, ConnectionStateMachine, type StateChange } from "./connection-state.js";

/** Why a live connection ended. */
export interface ConnectionClosedInfo {
  /** Short machine-readable cause, e.g. "heartbeat_timeout", "server_close", "drain". */
  readonly reason: string;
  /** Present when the close was caused by an error. Non-retryable errors stop reconnection. */
  readonly error?: MessengerError;
}

/**
 * A live connection as seen by the supervisor. Implemented by the protocol layer.
 * Contract: `closed` settles exactly once (and should not reject); `close()` is idempotent.
 */
export interface SupervisedConnection {
  readonly closed: Promise<ConnectionClosedInfo>;
  close(): Promise<void>;
}

/**
 * Establishes one connection. Must honour `signal` (abort = stop or connect timeout).
 * Throw a retryable MessengerError for transient failures and a non-retryable one for
 * permanent failures (invalid session, checkpoint, not implemented…).
 */
export type Connector = (signal: AbortSignal) => Promise<SupervisedConnection>;

export interface SupervisorOptions {
  connector: Connector;
  logger?: Logger;
  backoff?: Partial<BackoffOptions>;
  /**
   * Give up (state "failed") after this many consecutive failures. A failure is a failed
   * connect attempt or a connection that dropped before `stableAfterMs`. Default: unlimited
   * (delays are capped by backoff.maxDelayMs, so this never becomes a hot loop).
   */
  maxConsecutiveFailures?: number;
  /** Upper bound for a single connect attempt. Default 60 s. */
  connectTimeoutMs?: number;
  /** A connection that lived at least this long resets the failure count. Default 120 s. */
  stableAfterMs?: number;
  onStateChange?: (change: StateChange) => void;
  /** Called for every failure; `fatal` means the supervisor stopped in state "failed". */
  onError?: (error: MessengerError, context: { fatal: boolean; attempt: number }) => void;
  random?: () => number;
  now?: () => number;
}

export interface SupervisorStats {
  readonly state: ConnectionState;
  readonly consecutiveFailures: number;
  /** Successful connections after the first one of the current run. */
  readonly reconnects: number;
  /** Successful connections over the supervisor's lifetime. */
  readonly connects: number;
  readonly connectedSince: number | undefined;
  readonly nextRetryAt: number | undefined;
  readonly lastError: MessengerError | undefined;
}

interface ResolvedOptions {
  readonly connector: Connector;
  readonly backoff: BackoffOptions;
  readonly maxConsecutiveFailures: number;
  readonly connectTimeoutMs: number;
  readonly stableAfterMs: number;
  readonly onError: NonNullable<SupervisorOptions["onError"]>;
  readonly random: () => number;
  readonly now: () => number;
}

/**
 * Owns THE reconnect loop (docs/architecture.md §6.2). Guarantees:
 *  - at most one loop runs at a time; concurrent start() calls share it;
 *  - every delay is a cancellable sleep owned by the loop; stop() aborts it and waits;
 *  - repeated close signals from one connection produce exactly one reconnect;
 *  - permanent errors stop immediately; transient ones back off exponentially with jitter.
 */
export class ConnectionSupervisor {
  readonly #options: ResolvedOptions;
  readonly #log: Logger;
  readonly #machine: ConnectionStateMachine;

  #run: Promise<void> | undefined;
  #runController: AbortController | undefined;
  #firstConnected: Deferred<undefined> | undefined;
  #stopping: Promise<void> | undefined;

  #failures = 0;
  #reconnects = 0;
  #connects = 0;
  #connectedAt: number | undefined;
  #nextRetryAt: number | undefined;
  #lastError: MessengerError | undefined;

  constructor(options: SupervisorOptions) {
    if (typeof options.connector !== "function") throw new ConfigurationError("connector must be a function");
    const maxConsecutiveFailures = options.maxConsecutiveFailures ?? Number.POSITIVE_INFINITY;
    const connectTimeoutMs = options.connectTimeoutMs ?? 60_000;
    const stableAfterMs = options.stableAfterMs ?? 120_000;
    if (!(maxConsecutiveFailures >= 1)) throw new ConfigurationError("maxConsecutiveFailures must be >= 1");
    if (!(connectTimeoutMs > 0)) throw new ConfigurationError("connectTimeoutMs must be > 0");
    if (!(stableAfterMs >= 0)) throw new ConfigurationError("stableAfterMs must be >= 0");
    const now = options.now ?? Date.now;
    this.#options = {
      connector: options.connector,
      backoff: resolveBackoffOptions(options.backoff),
      maxConsecutiveFailures,
      connectTimeoutMs,
      stableAfterMs,
      onError: options.onError ?? (() => undefined),
      random: options.random ?? Math.random,
      now,
    };
    this.#log = options.logger ?? silentLogger;
    this.#machine = new ConnectionStateMachine({
      now,
      onChange: (change) => {
        this.#log.debug("connection state changed", { ...change });
        options.onStateChange?.(change);
      },
    });
  }

  get state(): ConnectionState {
    return this.#machine.state;
  }

  get stats(): SupervisorStats {
    return {
      state: this.#machine.state,
      consecutiveFailures: this.#failures,
      reconnects: this.#reconnects,
      connects: this.#connects,
      connectedSince: this.#connectedAt,
      nextRetryAt: this.#nextRetryAt,
      lastError: this.#lastError,
    };
  }

  /**
   * Starts the loop if it is not running. Resolves on the first successful connection of
   * this run; rejects if the run fails permanently or is stopped before connecting.
   */
  start(): Promise<void> {
    if (this.#stopping) {
      const pendingStop = this.#stopping;
      return pendingStop.then(() => this.start());
    }
    if (this.#run && this.#firstConnected) return this.#firstConnected.promise;

    this.#machine.transition("connecting", { reason: "start" });
    const controller = new AbortController();
    const first = deferred<undefined>();
    this.#runController = controller;
    this.#firstConnected = first;
    this.#failures = 0;
    this.#reconnects = 0;
    this.#nextRetryAt = undefined;

    this.#run = this.#loop(controller.signal, first)
      .catch((error: unknown) => {
        // The loop is written not to throw; this is a last line of defence.
        const err = toMessengerError(error);
        this.#log.error("supervisor loop crashed", { error: err });
        if (!controller.signal.aborted && this.#machine.state !== "failed") {
          this.#machine.transition("failed", { reason: err.code });
          this.#options.onError(err, { fatal: true, attempt: this.#failures });
        }
        first.reject(err);
      })
      .finally(() => {
        first.reject(new OperationAbortedError("Connection run ended before a connection was established"));
        this.#run = undefined;
        this.#runController = undefined;
        this.#connectedAt = undefined;
        this.#nextRetryAt = undefined;
      });
    return first.promise;
  }

  /** Stops the loop and closes the live connection. Idempotent; safe in every state. */
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    const state = this.#machine.state;
    const run = this.#run;

    if (state === "idle" || state === "disconnected") return Promise.resolve();

    if (state === "failed") {
      // The loop has already decided to exit (possibly still unwinding).
      this.#stopping = (run ?? Promise.resolve())
        .then(() => {
          if (this.#machine.state === "failed") this.#machine.transition("disconnected", { reason: "stop" });
        })
        .finally(() => {
          this.#stopping = undefined;
        });
      return this.#stopping;
    }

    // connecting | connected | reconnecting: a loop is active.
    this.#machine.transition("disconnecting", { reason: "stop" });
    this.#runController?.abort(new OperationAbortedError("disconnect() requested"));
    this.#stopping = (run ?? Promise.resolve())
      .then(() => {
        this.#machine.transition("disconnected", { reason: "stop" });
      })
      .finally(() => {
        this.#stopping = undefined;
      });
    return this.#stopping;
  }

  async #loop(signal: AbortSignal, first: Deferred<undefined>): Promise<void> {
    let everConnected = false;

    while (!isAborted(signal)) {
      let connection: SupervisedConnection;
      try {
        connection = await this.#connectOnce(signal);
      } catch (error) {
        if (isAborted(signal)) return;
        const err = toMessengerError(error);
        if (!this.#recordFailure(signal, err, first, err.code)) return;
        if (!(await this.#waitBeforeRetry(signal))) return;
        continue;
      }

      if (isAborted(signal)) {
        await this.#closeQuietly(connection);
        return;
      }

      const connectedAt = this.#options.now();
      this.#connects += 1;
      if (everConnected) this.#reconnects += 1;
      this.#connectedAt = connectedAt;
      this.#nextRetryAt = undefined;
      this.#transition(signal, "connected", { reason: everConnected ? "reconnected" : "connected" });
      everConnected = true;
      first.resolve(undefined);

      const info = await this.#waitForClose(connection, signal);
      this.#connectedAt = undefined;
      await this.#closeQuietly(connection);
      if (isAborted(signal)) return;

      if (this.#options.now() - connectedAt >= this.#options.stableAfterMs) this.#failures = 0;
      const err =
        info.error ??
        new RealtimeError(`Connection closed (${info.reason})`, { details: { reason: info.reason } });
      if (!this.#recordFailure(signal, err, first, info.reason)) return;
      if (!(await this.#waitBeforeRetry(signal))) return;
    }
  }

  /** Counts a failure; returns false if the supervisor transitioned to "failed". */
  #recordFailure(
    signal: AbortSignal,
    error: MessengerError,
    first: Deferred<undefined>,
    reason: string,
  ): boolean {
    this.#failures += 1;
    this.#lastError = error;
    const attempt = this.#failures;

    let fatal: MessengerError | undefined;
    if (!error.retryable) {
      fatal = error;
    } else if (attempt >= this.#options.maxConsecutiveFailures) {
      fatal = new RealtimeError(`Giving up after ${attempt} consecutive connection failures`, {
        cause: error,
        retryable: false,
        details: { attempts: attempt, lastCode: error.code },
      });
    }

    if (fatal) {
      this.#lastError = fatal;
      this.#log.error("connection failed permanently", { code: fatal.code, attempt, error: fatal });
      this.#transition(signal, "failed", { reason: fatal.code, attempt });
      this.#options.onError(fatal, { fatal: true, attempt });
      first.reject(fatal);
      return false;
    }

    this.#log.warn("connection attempt failed", { code: error.code, reason, attempt });
    this.#transition(signal, "reconnecting", { reason, attempt });
    this.#options.onError(error, { fatal: false, attempt });
    return true;
  }

  async #connectOnce(signal: AbortSignal): Promise<SupervisedConnection> {
    const scope = withTimeout(signal, this.#options.connectTimeoutMs, "Connection attempt");
    const pending = Promise.resolve().then(() => this.#options.connector(scope.signal));
    try {
      return await raceAbort(pending, scope.signal);
    } catch (error) {
      // If we stopped waiting (abort/timeout) but the connector still produces a
      // connection later, close it so nothing leaks.
      pending.then(
        (late) => this.#closeQuietly(late),
        () => undefined,
      );
      throw error;
    } finally {
      scope.dispose();
    }
  }

  #waitForClose(connection: SupervisedConnection, signal: AbortSignal): Promise<ConnectionClosedInfo> {
    const closed = connection.closed.then(
      (info) => info,
      (error: unknown) => ({ reason: "error", error: toMessengerError(error) }),
    );
    return new Promise<ConnectionClosedInfo>((resolve) => {
      const onAbort = (): void => {
        resolve({ reason: "stopped" });
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      void closed.then((info) => {
        signal.removeEventListener("abort", onAbort);
        resolve(info);
      });
    });
  }

  async #waitBeforeRetry(signal: AbortSignal): Promise<boolean> {
    const delay = computeBackoffDelay(
      Math.max(1, this.#failures),
      this.#options.backoff,
      this.#options.random,
    );
    this.#nextRetryAt = this.#options.now() + delay;
    this.#log.info("reconnecting after delay", { delayMs: delay, attempt: this.#failures });
    try {
      await sleep(delay, signal);
      return true;
    } catch {
      return false;
    } finally {
      this.#nextRetryAt = undefined;
    }
  }

  async #closeQuietly(connection: SupervisedConnection): Promise<void> {
    try {
      await connection.close();
    } catch (error) {
      this.#log.debug("error while closing connection", { error });
    }
  }

  #transition(
    signal: AbortSignal,
    to: ConnectionState,
    details: { reason?: string; attempt?: number },
  ): void {
    // Once stop() has begun, only stop() moves the state machine.
    if (signal.aborted || this.#machine.state === to) return;
    this.#machine.transition(to, details);
  }
}

/**
 * Reads `signal.aborted` through a call so TypeScript does not keep a narrowed value
 * across `await` boundaries: the signal can be aborted while the loop is suspended.
 */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
