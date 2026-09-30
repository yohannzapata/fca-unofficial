import { CheckpointRequiredError, ProtocolError, SessionExpiredError } from "../../errors/errors.js";
import type { Logger } from "../../logging/logger.js";
import type { CookieJar } from "../../transport/http/cookie-jar.js";
import type { HttpClient } from "../../transport/http/http-client.js";
import { type BootstrapConfig, buildBootstrapConfig } from "./bootstrap-config.js";
import { type BrowserProfile, navigationHeaders } from "./browser-profile.js";
import { type PageScan, type PageScanSummary, scanMessagesPage, summarizeScan } from "./page-scanner.js";
import { classifyRedirect, type RedirectKind } from "./redirects.js";

/** protocol-status.md §2: messagix loads `${baseURL}/messages`. */
export const MESSAGES_URL = "https://www.facebook.com/messages";
const MAX_REDIRECTS = 5;
const MAX_PAGE_BYTES = 32 * 1024 * 1024;

export interface BootstrapDependencies {
  readonly http: HttpClient;
  readonly cookies: CookieJar;
  readonly profile: BrowserProfile;
  readonly logger: Logger;
  readonly now: () => number;
}

/** A secret-free record of what happened, for diagnostics (the probe) and logs. */
export interface BootstrapTrace {
  readonly hops: readonly {
    readonly status: number;
    readonly host: string;
    readonly path: string;
    readonly kind?: RedirectKind;
  }[];
  readonly pageBytes: number;
  readonly durationMs: number;
  /** Names (never values) of cookies the server set or changed. */
  readonly changedCookies: readonly string[];
  /** Present once the page was received and scanned (also on validation failures). */
  readonly page: PageScanSummary | undefined;
}

export interface BootstrapResult {
  readonly config: BootstrapConfig;
  readonly scan: PageScan;
  readonly trace: BootstrapTrace;
}

/**
 * Loads facebook.com/messages with the session cookies and extracts the configuration.
 * Read-only: a single page navigation (plus same-app redirects). Throws typed errors:
 *  - SessionExpiredError: redirect to login, logged-out page, or the server deleted `xs`;
 *  - CheckpointRequiredError: checkpoint / challenge / consent / suspended;
 *  - ProtocolError: unexpected redirect or unrecognised page structure;
 *  - Network/Timeout/HttpStatus errors from the transport (retryable ones are retried).
 * `onTrace` receives the secret-free trace on success and on failure.
 */
export async function loadBootstrap(
  deps: BootstrapDependencies,
  expectedUserId: string,
  signal: AbortSignal,
  onTrace?: (trace: BootstrapTrace) => void,
): Promise<BootstrapResult> {
  const started = deps.now();
  const before = cookieValues(deps.cookies);
  const hops: { status: number; host: string; path: string; kind?: RedirectKind }[] = [];
  let pageBytes = 0;
  let page: PageScanSummary | undefined;
  const trace = (): BootstrapTrace => ({
    hops,
    pageBytes,
    durationMs: deps.now() - started,
    changedCookies: changedCookieNames(before, cookieValues(deps.cookies)),
    page,
  });

  try {
    let url = new URL(MESSAGES_URL);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await deps.http.request({
        method: "GET",
        url,
        headers: navigationHeaders(deps.profile, hop === 0 ? "none" : "same-origin"),
        signal,
        label: "bootstrap",
        maxResponseBytes: MAX_PAGE_BYTES,
      });

      if (deps.cookies.get("xs") === undefined) {
        hops.push({ status: response.status, host: url.host, path: url.pathname });
        throw new SessionExpiredError("Facebook removed the session cookie (xs); log in again and re-import");
      }

      if (response.status >= 300 && response.status < 400) {
        if (!response.redirectLocation) {
          throw new ProtocolError("bootstrap", `HTTP ${response.status} without a Location header`);
        }
        const target = new URL(response.redirectLocation, url);
        const kind = classifyRedirect(target);
        hops.push({ status: response.status, host: url.host, path: url.pathname, kind });
        deps.logger.debug("bootstrap redirect", {
          status: response.status,
          kind,
          host: target.host,
          path: target.pathname,
        });
        switch (kind) {
          case "login":
            throw new SessionExpiredError();
          case "checkpoint":
          case "challenge":
          case "consent":
          case "suspended":
            throw new CheckpointRequiredError(kind);
          case "messages":
            if (target.hostname !== "www.facebook.com") {
              throw new ProtocolError("bootstrap", `Unexpected redirect to ${target.host}${target.pathname}`);
            }
            url = target;
            continue;
          case "unknown":
            throw new ProtocolError("bootstrap", `Unexpected redirect to ${target.host}${target.pathname}`);
        }
      }

      hops.push({ status: response.status, host: url.host, path: url.pathname });
      pageBytes = response.body.length;
      const scan = scanMessagesPage(response.body);
      page = summarizeScan(scan);
      const config = buildBootstrapConfig(scan, expectedUserId, deps.now());
      deps.logger.info("bootstrap complete", {
        modules: [...scan.modules.keys()],
        lsVersionId: config.lsVersionId,
        pageBytes,
        durationMs: deps.now() - started,
      });
      const result = { config, scan, trace: trace() };
      onTrace?.(result.trace);
      return result;
    }
    throw new ProtocolError(
      "bootstrap",
      `More than ${MAX_REDIRECTS} redirects while loading the messages page`,
    );
  } catch (error) {
    onTrace?.(trace());
    throw error;
  }
}

function cookieValues(jar: CookieJar): Map<string, string> {
  return new Map(jar.toSessionCookies().map((c) => [`${c.domain}|${c.path}|${c.name}`, c.value]));
}

function changedCookieNames(before: Map<string, string>, after: Map<string, string>): string[] {
  const names = new Set<string>();
  for (const [key, value] of after) if (before.get(key) !== value) names.add(key.split("|")[2] ?? key);
  for (const key of before.keys()) if (!after.has(key)) names.add(key.split("|")[2] ?? key);
  return [...names].sort();
}
