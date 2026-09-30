import { randomBytes } from "node:crypto";
import {
  ConfigurationError,
  HttpStatusError,
  type MessengerError,
  NetworkError,
  ProtocolError,
  RateLimitError,
  toMessengerError,
} from "../../errors/errors.js";
import { type BackoffOptions, computeBackoffDelay, resolveBackoffOptions } from "../../lifecycle/backoff.js";
import { type Logger, silentLogger } from "../../logging/logger.js";
import { abortError, sleep, throwIfAborted, withTimeout } from "../../util/abort.js";
import type { CookieJar } from "./cookie-jar.js";

export type HttpMethod = "GET" | "HEAD" | "POST";

export interface RetryPolicy {
  /** Total attempts including the first. 1 = no retries. */
  readonly maxAttempts: number;
  readonly backoff: BackoffOptions;
  /** A server Retry-After longer than this is not waited for; the RateLimitError is thrown instead. */
  readonly maxRetryAfterMs: number;
}

export const DEFAULT_HTTP_RETRY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  backoff: resolveBackoffOptions({ initialDelayMs: 500, maxDelayMs: 10_000, multiplier: 2, jitter: 0.5 }),
  maxRetryAfterMs: 60_000,
});

export interface HttpRequest {
  method: HttpMethod;
  url: string | URL;
  headers?: Readonly<Record<string, string>>;
  body?: string | URLSearchParams | Uint8Array;
  /** Per-attempt timeout. Default: client default (30 s). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Whether the request may be retried automatically. Defaults to true for GET/HEAD and
   * false otherwise. Never mark mutations idempotent.
   */
  idempotent?: boolean;
  retry?: Partial<RetryPolicy> | false;
  /** Default "manual", so the protocol layer can see redirects to login/checkpoint pages. */
  redirect?: "manual" | "follow";
  maxResponseBytes?: number;
  /** Which statuses count as success. Default: 200–399. */
  acceptStatus?: (status: number) => boolean;
  /** Short label for logs, e.g. "bootstrap" or "graphql:SomeQuery". */
  label?: string;
}

export interface HttpResponse<T> {
  /** Local correlation id (logs/errors only; never sent to the server). */
  readonly requestId: string;
  readonly status: number;
  readonly headers: Headers;
  readonly url: string;
  readonly body: T;
  readonly redirectLocation: string | undefined;
  readonly attempts: number;
  readonly durationMs: number;
}

export interface HttpClientOptions {
  cookieJar?: CookieJar;
  /** Headers sent with every request (e.g. a fixed user-agent). */
  defaultHeaders?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  retry?: Partial<RetryPolicy>;
  /** Client-wide shutdown signal: aborting it cancels every in-flight request. */
  signal?: AbortSignal;
  logger?: Logger;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  random?: () => number;
  now?: () => number;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Messenger-agnostic HTTP transport over fetch: timeouts, cancellation, retries only for
 * idempotent requests, request ids, response size limits, cookie handling, and typed errors.
 * It never logs headers, bodies, or query strings.
 */
export class HttpClient {
  readonly #jar: CookieJar | undefined;
  readonly #defaultHeaders: Readonly<Record<string, string>>;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #retry: RetryPolicy;
  readonly #signal: AbortSignal | undefined;
  readonly #log: Logger;
  readonly #fetch: typeof fetch;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #idPrefix = randomBytes(3).toString("hex");
  #counter = 0;

  constructor(options: HttpClientOptions = {}) {
    this.#jar = options.cookieJar;
    this.#defaultHeaders = { ...options.defaultHeaders };
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
    this.#retry = { ...DEFAULT_HTTP_RETRY, ...options.retry };
    this.#signal = options.signal;
    this.#log = options.logger ?? silentLogger;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    if (!(this.#timeoutMs > 0)) throw new ConfigurationError("timeoutMs must be > 0");
    if (!(this.#maxResponseBytes > 0)) throw new ConfigurationError("maxResponseBytes must be > 0");
    if (!(this.#retry.maxAttempts >= 1)) throw new ConfigurationError("retry.maxAttempts must be >= 1");
  }

  /** Performs a request and returns the body as text. */
  request(req: HttpRequest): Promise<HttpResponse<string>> {
    return this.#execute(req, (bytes) => Buffer.from(bytes).toString("utf8"));
  }

  /** Performs a request and returns the raw body bytes. */
  requestBytes(req: HttpRequest): Promise<HttpResponse<Uint8Array>> {
    return this.#execute(req, (bytes) => bytes);
  }

  async #execute<T>(req: HttpRequest, decode: (bytes: Uint8Array) => T): Promise<HttpResponse<T>> {
    const url = new URL(req.url);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
      throw new ConfigurationError("Only https URLs are allowed (plain http only for loopback test servers)");
    }
    const requestId = `${this.#idPrefix}-${++this.#counter}`;
    const idempotent = req.idempotent ?? (req.method === "GET" || req.method === "HEAD");
    const policy: RetryPolicy =
      req.retry === false || !idempotent
        ? { ...this.#retry, maxAttempts: 1 }
        : { ...this.#retry, ...req.retry };
    const parent = combineSignals(req.signal, this.#signal);
    const started = this.#now();

    for (let attempt = 1; ; attempt++) {
      throwIfAborted(parent);
      try {
        const result = await this.#attempt(req, url, requestId, attempt, parent);
        return {
          requestId,
          status: result.status,
          headers: result.headers,
          url: url.toString(),
          body: decode(result.body),
          redirectLocation:
            result.status >= 300 && result.status < 400
              ? (result.headers.get("location") ?? undefined)
              : undefined,
          attempts: attempt,
          durationMs: this.#now() - started,
        };
      } catch (error) {
        const err = toMessengerError(error);
        const delay = this.#retryDelay(err, attempt, policy);
        if (delay === undefined || parent?.aborted) throw err;
        this.#log.debug("http retry scheduled", {
          requestId,
          attempt,
          delayMs: delay,
          code: err.code,
          label: req.label,
        });
        await sleep(delay, parent);
      }
    }
  }

  #retryDelay(error: MessengerError, attempt: number, policy: RetryPolicy): number | undefined {
    if (!error.retryable || attempt >= policy.maxAttempts) return undefined;
    if (error instanceof RateLimitError && error.retryAfterMs !== undefined) {
      return error.retryAfterMs <= policy.maxRetryAfterMs ? error.retryAfterMs : undefined;
    }
    return computeBackoffDelay(attempt, policy.backoff, this.#random);
  }

  async #attempt(
    req: HttpRequest,
    url: URL,
    requestId: string,
    attempt: number,
    parent: AbortSignal | undefined,
  ): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
    const label = req.label ?? req.method;
    const timeoutMs = req.timeoutMs ?? this.#timeoutMs;
    const scope = withTimeout(parent, timeoutMs, `HTTP ${label}`);
    const headers = new Headers(this.#defaultHeaders);
    for (const [key, value] of Object.entries(req.headers ?? {})) headers.set(key, value);
    if (!headers.has("cookie")) {
      const cookie = this.#jar?.cookieHeader(url);
      if (cookie) headers.set("cookie", cookie);
    }
    const logFields = {
      requestId,
      attempt,
      method: req.method,
      host: url.host,
      path: url.pathname,
      label: req.label,
    };
    this.#log.debug("http request", logFields);
    const started = this.#now();

    try {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: req.method,
          headers,
          ...(req.body === undefined ? {} : { body: req.body }),
          redirect: req.redirect ?? "manual",
          signal: scope.signal,
        });
      } catch (error) {
        throw this.#transportError(error, scope, parent, url, label);
      }

      this.#jar?.setFromResponse(url, response.headers.getSetCookie());

      const accept = req.acceptStatus ?? ((s: number) => s >= 200 && s < 400);
      if (!accept(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        this.#log.debug("http response rejected", {
          ...logFields,
          status: response.status,
          durationMs: this.#now() - started,
        });
        const details = { host: url.host, path: url.pathname, label: req.label, requestId };
        if (response.status === 429) {
          throw new RateLimitError(parseRetryAfter(response.headers.get("retry-after"), this.#now()), {
            details,
          });
        }
        throw new HttpStatusError(response.status, `HTTP ${response.status} for ${label}`, "HTTP_STATUS", {
          details,
        });
      }

      let body: Uint8Array;
      try {
        body = await readBodyLimited(response, req.maxResponseBytes ?? this.#maxResponseBytes, label);
      } catch (error) {
        if (error instanceof ProtocolError) throw error;
        throw this.#transportError(error, scope, parent, url, label);
      }
      this.#log.debug("http response", {
        ...logFields,
        status: response.status,
        bytes: body.byteLength,
        durationMs: this.#now() - started,
      });
      return { status: response.status, headers: response.headers, body };
    } finally {
      scope.dispose();
    }
  }

  #transportError(
    error: unknown,
    scope: ReturnType<typeof withTimeout>,
    parent: AbortSignal | undefined,
    url: URL,
    label: string,
  ): Error {
    if (scope.timedOut()) return abortError(scope.signal);
    if (parent?.aborted) return abortError(parent);
    const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
    const code = typeof cause?.code === "string" ? cause.code : null;
    return new NetworkError(`Network request failed for ${label}`, "NETWORK", {
      cause: error,
      details: { host: url.host, errno: code },
    });
  }
}

function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

async function readBodyLimited(response: Response, maxBytes: number, label: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProtocolError("http", `Response for ${label} exceeds ${maxBytes} bytes`, "PROTOCOL", {
      details: { declaredBytes: declared, maxBytes },
    });
  }
  if (!response.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Leaving a for-await loop early (throw) cancels the underlying stream.
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new ProtocolError("http", `Response for ${label} exceeds ${maxBytes} bytes`, "PROTOCOL", {
        details: { maxBytes },
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/** Retry-After: delta-seconds or an HTTP date. Returns ms, or undefined if absent/invalid. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}
