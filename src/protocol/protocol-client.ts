import type { SupervisedConnection } from "../lifecycle/supervisor.js";
import type { Logger } from "../logging/logger.js";
import type { SessionData } from "../session/session.js";
import type { CookieJar } from "../transport/http/cookie-jar.js";
import type { HttpClient } from "../transport/http/http-client.js";
import type { BrowserProfile } from "./bootstrap/browser-profile.js";
import { loadBootstrap } from "./bootstrap/bootstrapper.js";
import { RealtimeSession, type RealtimeSink, type RealtimeTuning } from "./realtime/realtime-session.js";
import type { SyncStateMap } from "./sync/sync-state.js";

/** Everything the protocol layer needs for one connection attempt, provided by the client. */
export interface ProtocolContext {
  readonly session: SessionData;
  readonly http: HttpClient;
  /** Live cookie jar; changes are persisted by the client. */
  readonly cookies: CookieJar;
  readonly profile: BrowserProfile;
  readonly logger: Logger;
  readonly now: () => number;
  readonly realtime: {
    /** Receives decoded row batches and cursor updates. */
    readonly sink: RealtimeSink;
    /** Stored sync cursors, if any. */
    readonly syncState: SyncStateMap | undefined;
    /** Send the initial thread-list fetch (first connection of a client instance). */
    readonly initialThreadFetch: boolean;
    readonly tuning?: RealtimeTuning;
  };
}

/**
 * The single boundary between the client and everything Messenger-specific
 * (docs/architecture.md §2). Services and the pipeline never reach past it.
 */
export interface ProtocolClient {
  /**
   * Validates the session against the server, bootstraps, opens the realtime transport and
   * performs the initial sync. Resolves with a live connection, or throws a typed error:
   * retryable for transient failures, non-retryable for permanent ones.
   */
  connect(context: ProtocolContext, signal: AbortSignal): Promise<SupervisedConnection>;
}

/** Bootstrap (facebook.com/messages) followed by a Lightspeed realtime session over DGW. */
export class MessengerProtocolClient implements ProtocolClient {
  async connect(context: ProtocolContext, signal: AbortSignal): Promise<SupervisedConnection> {
    const { config } = await loadBootstrap(
      {
        http: context.http,
        cookies: context.cookies,
        profile: context.profile,
        logger: context.logger.child({ component: "bootstrap" }),
        now: context.now,
      },
      context.session.userId,
      signal,
    );
    return RealtimeSession.start(
      {
        config,
        userId: context.session.userId,
        cookies: context.cookies,
        profile: context.profile,
        logger: context.logger,
        now: context.now,
        sink: context.realtime.sink,
        syncState: context.realtime.syncState,
        initialThreadFetch: context.realtime.initialThreadFetch,
        ...(context.realtime.tuning === undefined ? {} : { tuning: context.realtime.tuning }),
      },
      signal,
    );
  }
}
