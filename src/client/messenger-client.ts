import {
  ClientStateError,
  ConfigurationError,
  type MessengerError,
  OperationAbortedError,
  toMessengerError,
} from "../errors/errors.js";
import { type Listener, TypedEmitter } from "../events/typed-emitter.js";
import type { BackoffOptions } from "../lifecycle/backoff.js";
import type { ConnectionState } from "../lifecycle/connection-state.js";
import { ConnectionSupervisor, type SupervisedConnection } from "../lifecycle/supervisor.js";
import { createRedactingLogger, type Logger, silentLogger } from "../logging/logger.js";
import type { ClientEvents } from "../model/events.js";
import { createBrowserProfile } from "../protocol/bootstrap/browser-profile.js";
import { MessengerProtocolClient, type ProtocolClient } from "../protocol/protocol-client.js";
import type { SessionStore } from "../session/session-store.js";
import { HttpClient } from "../transport/http/http-client.js";
import { SessionManager } from "./session-manager.js";

export interface ReconnectOptions extends Partial<BackoffOptions> {
  /** Stop (state "failed") after this many consecutive failures. Default: unlimited. */
  maxConsecutiveFailures?: number;
  /** Upper bound for one connect attempt, ms. Default 60 000. */
  connectTimeoutMs?: number;
  /** A connection alive this long resets the backoff, ms. Default 120 000. */
  stableAfterMs?: number;
}

export interface MessengerClientOptions {
  /** Where the session lives. The client never reads cookies from anywhere else. */
  session: SessionStore;
  /** Optional logger; wrapped so secrets are redacted. Default: silent. */
  logger?: Logger;
  reconnect?: ReconnectOptions;
  /**
   * User agent to present. Default: the one stored with the session, else a fixed desktop
   * Chrome UA. Use the UA of the browser the cookies came from, for consistency.
   */
  userAgent?: string;
}

/** Internal seams for tests. Not part of the public API. */
export interface ClientInternals {
  protocol?: ProtocolClient;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  saveDebounceMs?: number;
}

export interface ClientHealth {
  readonly state: ConnectionState;
  readonly destroyed: boolean;
  readonly connectedSince: number | undefined;
  readonly uptimeMs: number;
  readonly connects: number;
  readonly reconnects: number;
  readonly consecutiveFailures: number;
  readonly nextRetryAt: number | undefined;
  readonly lastError: ReturnType<MessengerError["toJSON"]> | undefined;
  readonly eventCounts: Readonly<Record<string, number>>;
}

/**
 * The public entry point. Owns the lifecycle: one supervisor, one shutdown signal,
 * one event emitter, one session manager. See docs/architecture.md §4.
 */
export class MessengerClient {
  readonly #log: Logger;
  readonly #emitter: TypedEmitter<ClientEvents>;
  readonly #supervisor: ConnectionSupervisor;
  readonly #protocol: ProtocolClient;
  readonly #sessions: SessionManager;
  readonly #shutdown = new AbortController();
  readonly #now: () => number;
  readonly #fetch: typeof fetch | undefined;
  readonly #userAgent: string | undefined;
  readonly #eventCounts: Record<string, number> = {};
  #destroyed = false;
  #destroying: Promise<void> | undefined;

  constructor(options: MessengerClientOptions, internals: ClientInternals = {}) {
    const store = (options as Partial<MessengerClientOptions> | undefined)?.session;
    if (
      !store ||
      typeof store.load !== "function" ||
      typeof store.save !== "function" ||
      typeof store.clear !== "function"
    ) {
      throw new ConfigurationError("options.session must be a SessionStore (load/save/clear)");
    }
    this.#now = internals.now ?? Date.now;
    this.#fetch = internals.fetch;
    this.#userAgent = options.userAgent;
    this.#log = createRedactingLogger(options.logger ?? silentLogger).child({ component: "messenger" });
    this.#protocol = internals.protocol ?? new MessengerProtocolClient();
    this.#sessions = new SessionManager({
      store,
      logger: this.#log.child({ component: "session" }),
      now: this.#now,
      ...(internals.saveDebounceMs === undefined ? {} : { saveDebounceMs: internals.saveDebounceMs }),
    });

    this.#emitter = new TypedEmitter<ClientEvents>({
      onListenerError: (error, event) => {
        const err = toMessengerError(error);
        this.#log.error("event listener threw", { event, error: err });
        if (event !== "error") this.#emit("error", err);
      },
      onLeakWarning: (event, count) => {
        this.#log.warn("possible listener leak", { event, count });
      },
    });

    const { maxConsecutiveFailures, connectTimeoutMs, stableAfterMs, ...backoff } = options.reconnect ?? {};
    this.#supervisor = new ConnectionSupervisor({
      connector: (signal) => this.#connectOnce(signal),
      logger: this.#log.child({ component: "supervisor" }),
      backoff,
      ...(maxConsecutiveFailures === undefined ? {} : { maxConsecutiveFailures }),
      ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
      ...(stableAfterMs === undefined ? {} : { stableAfterMs }),
      now: this.#now,
      ...(internals.random === undefined ? {} : { random: internals.random }),
      onStateChange: (change) => {
        this.#emit("stateChange", change);
        const session = this.#sessions.current;
        if (change.to === "connected" && change.reason === "connected" && session) {
          this.#emit("ready", { userId: session.userId });
        }
      },
      onError: (error, context) => {
        if (context.fatal) this.#emit("error", error);
      },
    });
  }

  get state(): ConnectionState {
    return this.#supervisor.state;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  on<K extends keyof ClientEvents>(event: K, listener: Listener<ClientEvents[K]>): () => void {
    this.#assertUsable();
    return this.#emitter.on(event, listener);
  }

  once<K extends keyof ClientEvents>(event: K, listener: Listener<ClientEvents[K]>): () => void {
    this.#assertUsable();
    return this.#emitter.once(event, listener);
  }

  off<K extends keyof ClientEvents>(event: K, listener: Listener<ClientEvents[K]>): void {
    this.#emitter.off(event, listener);
  }

  /**
   * Connects and keeps the connection alive until disconnect()/destroy(). Resolves once
   * connected; transient failures are retried with backoff; permanent failures (invalid or
   * expired session, checkpoint, unimplemented protocol) reject and leave the state "failed".
   * Calling it while already connecting/connected returns the same pending result.
   */
  async connect(): Promise<void> {
    this.#assertUsable();
    const state = this.#supervisor.state;
    // A new run re-reads the store, so a session re-imported after a failure is picked up.
    if (state === "idle" || state === "disconnected" || state === "failed") void this.#sessions.reset();
    await this.#supervisor.start();
  }

  /** Stops the connection and persists pending cookie updates. Idempotent. */
  async disconnect(): Promise<void> {
    await this.#supervisor.stop();
    await this.#sessions.reset();
  }

  /**
   * Releases everything (connection, timers, listeners, pending operations) and persists
   * pending cookie updates. Idempotent and terminal: afterwards every method except
   * disconnect()/destroy()/health() throws.
   */
  destroy(): Promise<void> {
    if (this.#destroying) return this.#destroying;
    this.#destroyed = true;
    this.#destroying = (async () => {
      try {
        await this.#supervisor.stop();
      } finally {
        this.#shutdown.abort(new OperationAbortedError("Client destroyed"));
        await this.#sessions.reset();
        this.#emitter.removeAllListeners();
      }
    })();
    return this.#destroying;
  }

  /** Local health snapshot. Computed on demand; never sent anywhere. */
  health(): ClientHealth {
    const stats = this.#supervisor.stats;
    return {
      state: stats.state,
      destroyed: this.#destroyed,
      connectedSince: stats.connectedSince,
      uptimeMs: stats.connectedSince === undefined ? 0 : Math.max(0, this.#now() - stats.connectedSince),
      connects: stats.connects,
      reconnects: stats.reconnects,
      consecutiveFailures: stats.consecutiveFailures,
      nextRetryAt: stats.nextRetryAt,
      lastError: stats.lastError?.toJSON(),
      eventCounts: { ...this.#eventCounts },
    };
  }

  async #connectOnce(signal: AbortSignal): Promise<SupervisedConnection> {
    const session = await this.#sessions.load();
    const cookies = this.#sessions.cookieJar();
    const http = new HttpClient({
      cookieJar: cookies,
      signal: this.#shutdown.signal,
      logger: this.#log.child({ component: "http" }),
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
    });
    return this.#protocol.connect(
      {
        session,
        http,
        cookies,
        profile: createBrowserProfile(this.#userAgent ?? session.userAgent),
        logger: this.#log,
        now: this.#now,
      },
      signal,
    );
  }

  #emit<K extends keyof ClientEvents>(event: K, ...args: ClientEvents[K]): void {
    this.#eventCounts[event] = (this.#eventCounts[event] ?? 0) + 1;
    const delivered = this.#emitter.emit(event, ...args);
    if (!delivered && event === "error") {
      this.#log.warn("error event emitted with no listener", { error: args[0] });
    }
  }

  #assertUsable(): void {
    if (this.#destroyed) throw new ClientStateError("This client has been destroyed; create a new one");
  }
}
