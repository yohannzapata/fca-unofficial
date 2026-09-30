import { toMessengerError } from "../errors/errors.js";
import { createRedactingLogger, type Logger, silentLogger } from "../logging/logger.js";
import { missingForRealtime } from "../protocol/bootstrap/bootstrap-config.js";
import { createBrowserProfile, DEFAULT_USER_AGENT } from "../protocol/bootstrap/browser-profile.js";
import { type BootstrapTrace, loadBootstrap } from "../protocol/bootstrap/bootstrapper.js";
import type { PageScanSummary } from "../protocol/bootstrap/page-scanner.js";
import type { SessionStore } from "../session/session-store.js";
import { HttpClient } from "../transport/http/http-client.js";
import { withTimeout } from "../util/abort.js";
import { SessionManager } from "./session-manager.js";

export type ProbeOutcome =
  | "ok"
  | "session_expired"
  | "checkpoint_required"
  | "invalid_session"
  | "session_store_error"
  | "network_error"
  | "protocol_error"
  | "error";

/**
 * Result of probeSession(). Built from an allowlist: it never contains cookie values,
 * tokens (fb_dtsg, lsd), names, or other personal data, so it is safe to share when
 * reporting protocol problems. Values included are presence flags, counts, cookie/module
 * NAMES, config KEYS, and global identifiers (Lightspeed schema version, app ids).
 */
export interface SessionProbeReport {
  readonly tool: "fca-unofficial session probe";
  readonly reportVersion: 1;
  readonly generatedAt: string;
  readonly nodeVersion: string;
  readonly outcome: ProbeOutcome;
  readonly error?: { readonly code: string; readonly message: string };
  readonly session?: {
    readonly userIdSuffix: string;
    readonly cookieNames: readonly string[];
    readonly userAgent: "default" | "custom";
  };
  readonly http?: {
    readonly hops: BootstrapTrace["hops"];
    readonly pageBytes: number;
    readonly durationMs: number;
    readonly changedCookies: readonly string[];
  };
  readonly page?: PageScanSummary;
  readonly config?: {
    readonly tokens: {
      readonly fbDtsg: boolean;
      readonly lsd: boolean;
      readonly jazoest: boolean;
      readonly cometReq: boolean;
    };
    readonly userMatchesSession: true;
    readonly appId: string | null;
    readonly dgwAppId: string | null;
    readonly messengerWebAppId: string | null;
    readonly lsVersionId: string | null;
    readonly region: string | null;
    readonly deviceClientIdPresent: boolean;
    readonly syncParams: { readonly mailbox: boolean; readonly contact: boolean; readonly e2ee: boolean };
    readonly lossyFields: readonly string[];
    readonly missingForRealtime: readonly string[];
  };
}

export interface ProbeOptions {
  session: SessionStore;
  logger?: Logger;
  /** Same meaning as MessengerClientOptions.userAgent. */
  userAgent?: string;
  signal?: AbortSignal;
  /** Overall time limit. Default 60 s. */
  timeoutMs?: number;
}

/** Internal seams for tests. */
export interface ProbeInternals {
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Read-only diagnostic: loads facebook.com/messages once with the stored session and reports
 * what was found. Performs no mutations on the account. Cookie rotations sent by Facebook
 * are persisted to the store (as the client would), so the session stays current.
 */
export async function probeSession(
  options: ProbeOptions,
  internals: ProbeInternals = {},
): Promise<SessionProbeReport> {
  const now = internals.now ?? Date.now;
  const log = createRedactingLogger(options.logger ?? silentLogger).child({ component: "probe" });
  const base = {
    tool: "fca-unofficial session probe",
    reportVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    nodeVersion: process.version,
  } as const;

  const sessions = new SessionManager({ store: options.session, logger: log, now, saveDebounceMs: 0 });
  const scope = withTimeout(options.signal, options.timeoutMs ?? 60_000, "Session probe");
  let trace: BootstrapTrace | undefined;
  let sessionInfo: SessionProbeReport["session"];

  try {
    const session = await sessions.load();
    const userAgent = options.userAgent ?? session.userAgent;
    sessionInfo = {
      userIdSuffix: `…${session.userId.slice(-4)}`,
      cookieNames: [...new Set(session.cookies.map((c) => c.name))].sort(),
      userAgent: userAgent === undefined || userAgent === DEFAULT_USER_AGENT ? "default" : "custom",
    };
    const cookies = sessions.cookieJar();
    const http = new HttpClient({
      cookieJar: cookies,
      logger: log.child({ component: "http" }),
      ...(internals.fetch === undefined ? {} : { fetch: internals.fetch }),
    });
    const { config } = await loadBootstrap(
      { http, cookies, profile: createBrowserProfile(userAgent), logger: log, now },
      session.userId,
      scope.signal,
      (t) => {
        trace = t;
      },
    );
    return {
      ...base,
      outcome: "ok",
      session: sessionInfo,
      ...httpAndPage(trace),
      config: {
        tokens: {
          fbDtsg: config.fbDtsg.length > 0,
          lsd: config.lsd.length > 0,
          jazoest: config.jazoest !== undefined,
          cometReq: config.cometReq !== undefined,
        },
        userMatchesSession: true,
        appId: config.appId ?? null,
        dgwAppId: config.dgwAppId ?? null,
        messengerWebAppId: config.messengerWebAppId ?? null,
        lsVersionId: config.lsVersionId ?? null,
        region: config.region ?? null,
        deviceClientIdPresent: config.deviceClientId !== undefined,
        syncParams: {
          mailbox: config.syncParams?.mailbox !== undefined,
          contact: config.syncParams?.contact !== undefined,
          e2ee: config.syncParams?.e2ee !== undefined,
        },
        lossyFields: config.lossyFields,
        missingForRealtime: missingForRealtime(config),
      },
    };
  } catch (thrown) {
    const error = toMessengerError(thrown);
    log.warn("probe failed", { code: error.code });
    return {
      ...base,
      outcome: outcomeFor(error.code),
      error: { code: error.code, message: error.message },
      ...(sessionInfo === undefined ? {} : { session: sessionInfo }),
      ...httpAndPage(trace),
    };
  } finally {
    scope.dispose();
    await sessions.reset();
  }
}

function httpAndPage(trace: BootstrapTrace | undefined): Pick<SessionProbeReport, "http" | "page"> {
  if (!trace) return {};
  return {
    http: {
      hops: trace.hops,
      pageBytes: trace.pageBytes,
      durationMs: trace.durationMs,
      changedCookies: trace.changedCookies,
    },
    ...(trace.page === undefined ? {} : { page: trace.page }),
  };
}

function outcomeFor(code: string): ProbeOutcome {
  switch (code) {
    case "SESSION_EXPIRED":
      return "session_expired";
    case "CHECKPOINT_REQUIRED":
      return "checkpoint_required";
    case "INVALID_SESSION":
      return "invalid_session";
    case "SESSION_STORE":
    case "SESSION_CORRUPTED":
      return "session_store_error";
    case "NETWORK":
    case "TIMEOUT":
    case "HTTP_STATUS":
    case "RATE_LIMITED":
      return "network_error";
    case "PROTOCOL":
      return "protocol_error";
    default:
      return "error";
  }
}
