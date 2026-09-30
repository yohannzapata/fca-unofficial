import type { SessionCookie } from "../../session/session.js";

interface JarCookie {
  readonly name: string;
  readonly value: string;
  /** Lowercase, without a leading dot. */
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly path: string;
  readonly expiresAt: number | undefined;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly createdSeq: number;
}

export interface CookieJarOptions {
  cookies?: readonly SessionCookie[];
  now?: () => number;
  /** Called after any change (set, update, delete). Use it to persist the session. */
  onChange?: () => void;
}

/**
 * A minimal RFC 6265 cookie jar: domain/path matching, expiry, Max-Age precedence,
 * deletion via expiry, and rejection of Domain attributes that do not match the
 * responding host. Public-suffix handling is limited to rejecting single-label domains;
 * sufficient because the client only ever talks to facebook.com hosts.
 */
export class CookieJar {
  readonly #cookies = new Map<string, JarCookie>();
  readonly #now: () => number;
  readonly #onChange: () => void;
  #seq = 0;

  constructor(options: CookieJarOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#onChange = options.onChange ?? (() => undefined);
    for (const cookie of options.cookies ?? []) {
      const hostOnly = !cookie.domain.startsWith(".");
      this.#put({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain.replace(/^\./, "").toLowerCase(),
        hostOnly,
        path: cookie.path,
        expiresAt: cookie.expiresAt,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        createdSeq: this.#seq++,
      });
    }
  }

  get size(): number {
    return this.#cookies.size;
  }

  /** The value for a Cookie request header, or undefined if nothing matches. */
  cookieHeader(url: URL): string | undefined {
    const now = this.#now();
    const host = url.hostname.toLowerCase();
    const secureChannel = url.protocol === "https:" || url.protocol === "wss:";
    const path = url.pathname || "/";
    const matches = [...this.#cookies.values()]
      .filter((c) => (c.expiresAt === undefined || c.expiresAt > now) && (!c.secure || secureChannel))
      .filter((c) => (c.hostOnly ? host === c.domain : domainMatches(host, c.domain)))
      .filter((c) => pathMatches(path, c.path))
      .sort((a, b) => b.path.length - a.path.length || a.createdSeq - b.createdSeq);
    if (matches.length === 0) return undefined;
    return matches.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  /** Applies Set-Cookie headers received from `url`. Returns how many cookies changed. */
  setFromResponse(url: URL, setCookieHeaders: readonly string[]): number {
    let changed = 0;
    for (const header of setCookieHeaders) {
      if (this.#apply(url, header)) changed++;
    }
    if (changed > 0) this.#onChange();
    return changed;
  }

  get(name: string, domain?: string): string | undefined {
    const now = this.#now();
    for (const c of this.#cookies.values()) {
      if (c.name !== name) continue;
      if (c.expiresAt !== undefined && c.expiresAt <= now) continue;
      if (domain !== undefined && !domainMatches(domain.replace(/^\./, "").toLowerCase(), c.domain)) continue;
      return c.value;
    }
    return undefined;
  }

  /** Snapshot for persistence. Expired cookies are dropped. */
  toSessionCookies(): SessionCookie[] {
    const now = this.#now();
    return [...this.#cookies.values()]
      .filter((c) => c.expiresAt === undefined || c.expiresAt > now)
      .sort((a, b) => a.createdSeq - b.createdSeq)
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.hostOnly ? c.domain : `.${c.domain}`,
        path: c.path,
        ...(c.expiresAt === undefined ? {} : { expiresAt: c.expiresAt }),
        secure: c.secure,
        httpOnly: c.httpOnly,
      }));
  }

  #apply(url: URL, header: string): boolean {
    const [pair = "", ...attributeParts] = header.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) return false;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) return false;

    const host = url.hostname.toLowerCase();
    let domain = host;
    let hostOnly = true;
    let path = defaultPath(url.pathname);
    let expiresAt: number | undefined;
    let maxAgeSeen = false;
    let secure = false;
    let httpOnly = false;

    for (const raw of attributeParts) {
      const idx = raw.indexOf("=");
      const key = (idx === -1 ? raw : raw.slice(0, idx)).trim().toLowerCase();
      const val = idx === -1 ? "" : raw.slice(idx + 1).trim();
      switch (key) {
        case "max-age": {
          if (!/^-?\d+$/.test(val)) break;
          const seconds = Number(val);
          maxAgeSeen = true;
          expiresAt = seconds <= 0 ? Number.NEGATIVE_INFINITY : this.#now() + seconds * 1000;
          break;
        }
        case "expires": {
          if (maxAgeSeen) break;
          const parsed = Date.parse(val);
          if (!Number.isNaN(parsed)) expiresAt = parsed;
          break;
        }
        case "domain": {
          const d = val.replace(/^\./, "").toLowerCase();
          if (!d) break;
          if (!d.includes(".") || !domainMatches(host, d)) return false; // reject foreign/public-suffix domains
          domain = d;
          hostOnly = false;
          break;
        }
        case "path":
          if (val.startsWith("/")) path = val;
          break;
        case "secure":
          secure = true;
          break;
        case "httponly":
          httpOnly = true;
          break;
        default:
          break;
      }
    }

    const key = cookieKey(domain, path, name);
    if (expiresAt !== undefined && expiresAt <= this.#now()) {
      return this.#cookies.delete(key);
    }
    const existing = this.#cookies.get(key);
    const next: JarCookie = {
      name,
      value,
      domain,
      hostOnly,
      path,
      expiresAt,
      secure,
      httpOnly,
      createdSeq: existing?.createdSeq ?? this.#seq++,
    };
    if (
      existing &&
      existing.value === next.value &&
      existing.expiresAt === next.expiresAt &&
      existing.secure === next.secure &&
      existing.httpOnly === next.httpOnly &&
      existing.hostOnly === next.hostOnly
    ) {
      return false;
    }
    this.#put(next);
    return true;
  }

  #put(cookie: JarCookie): void {
    this.#cookies.set(cookieKey(cookie.domain, cookie.path, cookie.name), cookie);
  }
}

function cookieKey(domain: string, path: string, name: string): string {
  return `${domain}\u0000${path}\u0000${name}`;
}

export function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath.charAt(cookiePath.length) === "/";
}

function defaultPath(pathname: string): string {
  if (!pathname.startsWith("/")) return "/";
  const last = pathname.lastIndexOf("/");
  return last <= 0 ? "/" : pathname.slice(0, last);
}
