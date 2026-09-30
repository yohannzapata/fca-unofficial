import { ProtocolNotImplementedError } from "../errors/errors.js";
import type { SupervisedConnection } from "../lifecycle/supervisor.js";
import type { Logger } from "../logging/logger.js";
import type { SessionData } from "../session/session.js";
import type { CookieJar } from "../transport/http/cookie-jar.js";
import type { HttpClient } from "../transport/http/http-client.js";
import { missingForRealtime } from "./bootstrap/bootstrap-config.js";
import type { BrowserProfile } from "./bootstrap/browser-profile.js";
import { loadBootstrap } from "./bootstrap/bootstrapper.js";

/** Everything the protocol layer needs for one connection attempt, provided by the client. */
export interface ProtocolContext {
  readonly session: SessionData;
  readonly http: HttpClient;
  /** Live cookie jar; changes are persisted by the client. */
  readonly cookies: CookieJar;
  readonly profile: BrowserProfile;
  readonly logger: Logger;
  readonly now: () => number;
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

/**
 * Bootstrap and session validation are implemented; the realtime transport
 * (DGW/Lightspeed) is not yet. connect() therefore validates the session with
 * Facebook (surfacing SessionExpiredError / CheckpointRequiredError) and then fails
 * honestly and permanently instead of pretending to connect.
 */
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
    const missing = missingForRealtime(config);
    throw new ProtocolNotImplementedError(
      "realtime",
      "Session verified with Facebook, but the realtime transport (DGW/Lightspeed) is not implemented yet. " +
        "See docs/research/protocol-status.md.",
      { details: { missingForRealtime: missing.join(",") || null } },
    );
  }
}
