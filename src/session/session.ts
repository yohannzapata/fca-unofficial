import { InvalidSessionError } from "../errors/errors.js";

export const SESSION_SCHEMA_VERSION = 1;

/** Cookie names without which a session cannot work (protocol-status.md §1). */
export const REQUIRED_COOKIES = ["c_user", "xs", "datr"] as const;
/** Cookies a normal browser session also has; their absence is suspicious but not fatal. */
export const RECOMMENDED_COOKIES = ["sb", "fr"] as const;

export interface SessionCookie {
  readonly name: string;
  readonly value: string;
  /** Lowercase; a leading "." means "domain cookie" (sent to subdomains), otherwise host-only. */
  readonly domain: string;
  readonly path: string;
  /** Expiry as ms since epoch; absent = session cookie. */
  readonly expiresAt?: number;
  readonly secure: boolean;
  readonly httpOnly: boolean;
}

/**
 * Persisted session state. Contains secrets (cookies): keep it local, never log it.
 * Future versions may add optional fields (e.g. sync cursors) without a schema version bump.
 */
export interface SessionData {
  readonly version: typeof SESSION_SCHEMA_VERSION;
  /** Facebook user id (from `c_user`). */
  readonly userId: string;
  readonly cookies: readonly SessionCookie[];
  /** User agent kept fixed for the life of the session (consistency, not randomization). */
  readonly userAgent?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Accepted cookie input shapes. */
export type CookieInput =
  | string // "name=value; name2=value2" (a Cookie request header)
  | readonly CookieLike[] // browser-extension export, or legacy FCA "appState" ({ key, value, … })
  | Readonly<Record<string, string>>; // { c_user: "...", xs: "...", ... }

export interface CookieLike {
  name?: string;
  key?: string; // FCA appState uses "key"
  value?: string;
  domain?: string;
  path?: string;
  expires?: number | string; // ms, s, or date string depending on the exporter
  expirationDate?: number; // seconds (Chrome extension exports)
  secure?: boolean;
  httpOnly?: boolean;
  hostOnly?: boolean;
}

export interface SessionFromCookiesOptions {
  userAgent?: string;
  now?: () => number;
}

export interface SessionFromCookiesResult {
  readonly session: SessionData;
  /** Human-readable, secret-free notes (e.g. ignored foreign-domain cookies). */
  readonly warnings: readonly string[];
}

const FACEBOOK_DOMAIN = "facebook.com";
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Builds a validated session from cookies the user exported from their own browser.
 * Purely local: performs no network access. Only facebook.com cookies are kept.
 */
export function sessionFromCookies(
  input: CookieInput,
  options: SessionFromCookiesOptions = {},
): SessionFromCookiesResult {
  const now = (options.now ?? Date.now)();
  const warnings: string[] = [];
  const parsed = parseCookieInput(input, warnings, now);

  const byName = new Map<string, SessionCookie>();
  for (const cookie of parsed) {
    if (!isFacebookDomain(cookie.domain)) continue;
    // Prefer the most specific (longest) path; later duplicates of equal specificity win.
    const existing = byName.get(cookie.name);
    if (!existing || cookie.path.length >= existing.path.length) byName.set(cookie.name, cookie);
  }
  const ignoredForeign = parsed.filter((c) => !isFacebookDomain(c.domain)).length;
  if (ignoredForeign > 0) warnings.push(`Ignored ${ignoredForeign} cookie(s) for non-facebook.com domains`);

  const missing = REQUIRED_COOKIES.filter((name) => !byName.get(name)?.value);
  if (missing.length > 0) {
    throw new InvalidSessionError(
      `Missing required cookie(s): ${missing.join(", ")}. Export all facebook.com cookies from a logged-in browser.`,
      { details: { missing: missing.join(",") } },
    );
  }
  const userId = byName.get("c_user")?.value ?? "";
  if (!/^\d{1,20}$/.test(userId)) {
    throw new InvalidSessionError("Cookie c_user must be a numeric Facebook user id");
  }
  const expired = [...byName.values()]
    .filter((c) => c.expiresAt !== undefined && c.expiresAt <= now)
    .map((c) => c.name);
  const expiredRequired = REQUIRED_COOKIES.filter((name) => expired.includes(name));
  if (expiredRequired.length > 0) {
    throw new InvalidSessionError(`Required cookie(s) already expired: ${expiredRequired.join(", ")}`);
  }
  for (const name of RECOMMENDED_COOKIES) {
    if (!byName.has(name))
      warnings.push(`Cookie "${name}" is missing; a normal browser session usually has it`);
  }

  const session: SessionData = {
    version: SESSION_SCHEMA_VERSION,
    userId,
    cookies: [...byName.values()].filter((c) => c.expiresAt === undefined || c.expiresAt > now),
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
    createdAt: now,
    updatedAt: now,
  };
  return { session, warnings };
}

function parseCookieInput(input: CookieInput, warnings: string[], now: number): SessionCookie[] {
  if (typeof input === "string") return parseCookieHeader(input, warnings);
  if (Array.isArray(input)) {
    const out: SessionCookie[] = [];
    (input as readonly CookieLike[]).forEach((entry, index) => {
      const cookie = normalizeCookieLike(entry, now);
      if (cookie) out.push(cookie);
      else warnings.push(`Ignored malformed cookie entry at index ${index}`);
    });
    return out;
  }
  if (typeof input === "object") {
    const out: SessionCookie[] = [];
    for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
      if (typeof value !== "string" || !COOKIE_NAME_PATTERN.test(name)) {
        warnings.push("Ignored a malformed cookie entry");
        continue;
      }
      out.push(defaultCookie(name, value));
    }
    return out;
  }
  throw new InvalidSessionError(
    "Unsupported cookie input; pass a Cookie header string, an array, or a name→value map",
  );
}

function parseCookieHeader(header: string, warnings: string[]): SessionCookie[] {
  const out: SessionCookie[] = [];
  const text = header.replace(/^\s*cookie\s*:\s*/i, "");
  for (const part of text.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      warnings.push("Ignored a malformed cookie pair");
      continue;
    }
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!COOKIE_NAME_PATTERN.test(name)) {
      warnings.push("Ignored a cookie with an invalid name");
      continue;
    }
    out.push(defaultCookie(name, value));
  }
  return out;
}

function defaultCookie(name: string, value: string): SessionCookie {
  return { name, value, domain: `.${FACEBOOK_DOMAIN}`, path: "/", secure: true, httpOnly: false };
}

function normalizeCookieLike(entry: CookieLike, now: number): SessionCookie | undefined {
  if (typeof entry !== "object") return undefined;
  const name = entry.name ?? entry.key;
  const value = entry.value;
  if (typeof name !== "string" || !COOKIE_NAME_PATTERN.test(name) || typeof value !== "string")
    return undefined;
  let domain =
    typeof entry.domain === "string" && entry.domain ? entry.domain.toLowerCase() : `.${FACEBOOK_DOMAIN}`;
  if (entry.hostOnly === false && !domain.startsWith(".")) domain = `.${domain}`;
  const path = typeof entry.path === "string" && entry.path.startsWith("/") ? entry.path : "/";
  const expiresAt = normalizeExpiry(entry.expirationDate ?? entry.expires, now);
  return {
    name,
    value,
    domain,
    path,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    secure: entry.secure ?? true,
    httpOnly: entry.httpOnly ?? false,
  };
}

/** Accepts seconds, milliseconds or a date string; returns ms since epoch. */
function normalizeExpiry(value: number | string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (value.trim() === "" || value === "Infinity") return undefined;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeExpiry(numeric, now);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (!Number.isFinite(value) || value <= 0) return undefined;
  // Heuristic: values below 1e11 are seconds (1e11 s ≈ year 5138; 1e11 ms ≈ 1973).
  return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
}

export function isFacebookDomain(domain: string): boolean {
  const bare = domain.replace(/^\./, "").toLowerCase();
  return bare === FACEBOOK_DOMAIN || bare.endsWith(`.${FACEBOOK_DOMAIN}`);
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; problems: string[] };

/**
 * Structural validation of stored session data. Problems are described without values,
 * so they are safe to log and to include in errors.
 */
export function validateSessionData(input: unknown): ValidationResult<SessionData> {
  const problems: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, problems: ["session is not an object"] };
  }
  const data = input as Record<string, unknown>;
  if (data["version"] !== SESSION_SCHEMA_VERSION)
    problems.push(`unsupported version (expected ${SESSION_SCHEMA_VERSION})`);
  if (typeof data["userId"] !== "string" || !/^\d{1,20}$/.test(data["userId"]))
    problems.push("userId must be a numeric string");
  if (typeof data["createdAt"] !== "number" || !Number.isFinite(data["createdAt"]))
    problems.push("createdAt must be a number");
  if (typeof data["updatedAt"] !== "number" || !Number.isFinite(data["updatedAt"]))
    problems.push("updatedAt must be a number");
  if (data["userAgent"] !== undefined && typeof data["userAgent"] !== "string")
    problems.push("userAgent must be a string");

  const cookies = data["cookies"];
  if (!Array.isArray(cookies)) {
    problems.push("cookies must be an array");
  } else {
    cookies.forEach((cookie: unknown, index) => {
      const problem = validateCookie(cookie);
      if (problem) problems.push(`cookies[${index}]: ${problem}`);
    });
    const names = new Set(cookies.map((c: unknown) => (c as { name?: unknown }).name));
    for (const required of REQUIRED_COOKIES) {
      if (!names.has(required)) problems.push(`required cookie "${required}" is missing`);
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: input as unknown as SessionData };
}

function validateCookie(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return "not an object";
  const c = input as Record<string, unknown>;
  if (typeof c["name"] !== "string" || !COOKIE_NAME_PATTERN.test(c["name"])) return "invalid name";
  if (typeof c["value"] !== "string") return "value must be a string";
  if (typeof c["domain"] !== "string" || !isFacebookDomain(c["domain"]))
    return "domain must be facebook.com or a subdomain";
  if (typeof c["path"] !== "string" || !c["path"].startsWith("/")) return "invalid path";
  if (
    c["expiresAt"] !== undefined &&
    (typeof c["expiresAt"] !== "number" || !Number.isFinite(c["expiresAt"]))
  ) {
    return "expiresAt must be a number";
  }
  if (typeof c["secure"] !== "boolean" || typeof c["httpOnly"] !== "boolean")
    return "secure/httpOnly must be booleans";
  return undefined;
}
