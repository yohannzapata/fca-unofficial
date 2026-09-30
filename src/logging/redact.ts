/**
 * Redaction of secrets from anything that may reach a log sink or an error object.
 *
 * Two mechanisms:
 *  - key-based: values under secret-looking keys are replaced wholesale;
 *  - pattern-based: secret-shaped substrings inside strings (`xs=…`, `fb_dtsg=…`, `Bearer …`).
 */

export const REDACTED = "[REDACTED]";

/** Exact (case-insensitive) key names that always hold secrets. Includes Facebook cookie names. */
const SECRET_KEYS = new Set([
  "cookie",
  "cookies",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "xs",
  "datr",
  "sb",
  "fr",
  "fb_dtsg",
  "dtsg",
  "lsd",
  "jazoest",
  "appstate",
  "app_state",
  "session",
  "pin",
  "cat",
  "fbcat",
]);

/** Substrings that mark a key as secret wherever they appear (e.g. `accessToken`, `private_key`). */
const SECRET_KEY_FRAGMENTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "cookie",
  "dtsg",
  "privatekey",
  "private_key",
  "totp",
  "twofactor",
  "sessiondata",
];

export function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SECRET_KEYS.has(lower)) return true;
  const compact = lower.replace(/[-\s]/g, "");
  return SECRET_KEY_FRAGMENTS.some((fragment) => compact.includes(fragment));
}

const SECRET_PAIR_PATTERN =
  /\b(xs|datr|sb|fr|fb_dtsg|lsd|jazoest|access_token|token|password)=([^;&\s"']+)/gi;
const AUTH_SCHEME_PATTERN = /\b(Bearer|OAuth|Basic)\s+[A-Za-z0-9._~+/=|-]{6,}/g;

export const MAX_STRING_LENGTH = 2_000;

/** Masks secret-shaped substrings and truncates very long strings. */
export function redactString(value: string, maxLength = MAX_STRING_LENGTH): string {
  let out = value
    .replace(SECRET_PAIR_PATTERN, `$1=${REDACTED}`)
    .replace(AUTH_SCHEME_PATTERN, `$1 ${REDACTED}`);
  if (out.length > maxLength) {
    out = `${out.slice(0, maxLength)}…[truncated ${out.length - maxLength} chars]`;
  }
  return out;
}

export interface RedactOptions {
  /** Maximum nesting depth before values are replaced with a marker. Default 6. */
  maxDepth?: number;
  /** Maximum array entries kept. Default 50. */
  maxArrayLength?: number;
}

/**
 * Returns a redacted deep copy suitable for logging. Never mutates the input.
 * Handles cycles, binary data, errors, maps and sets; functions are dropped.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? 6;
  const maxArrayLength = options.maxArrayLength ?? 50;
  const seen = new WeakSet<object>();

  const visit = (input: unknown, depth: number): unknown => {
    if (typeof input === "string") return redactString(input);
    if (input === null || typeof input !== "object") {
      if (typeof input === "function" || typeof input === "symbol") return undefined;
      if (typeof input === "bigint") return input.toString();
      return input;
    }
    if (seen.has(input)) return "[Circular]";
    if (depth >= maxDepth) return "[MaxDepth]";
    if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
      return `[bytes ${input.byteLength}]`;
    }
    if (input instanceof Date) return input.toISOString();
    seen.add(input);
    try {
      if (input instanceof Error) {
        const out: Record<string, unknown> = { name: input.name, message: redactString(input.message) };
        const code = (input as { code?: unknown }).code;
        if (typeof code === "string" || typeof code === "number") out["code"] = code;
        return out;
      }
      if (Array.isArray(input)) {
        const items = input.slice(0, maxArrayLength).map((item) => visit(item, depth + 1));
        if (input.length > maxArrayLength) items.push(`[+${input.length - maxArrayLength} more]`);
        return items;
      }
      if (input instanceof Map) {
        const out: Record<string, unknown> = {};
        for (const [key, val] of input) {
          const k = String(key);
          out[k] = isSecretKey(k) ? REDACTED : visit(val, depth + 1);
        }
        return out;
      }
      if (input instanceof Set) {
        return visit([...input], depth);
      }
      if (input instanceof Headers) {
        const out: Record<string, unknown> = {};
        input.forEach((val, key) => {
          out[key] = isSecretKey(key) ? REDACTED : redactString(val);
        });
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(input)) {
        if (isSecretKey(key)) {
          out[key] = REDACTED;
        } else {
          const visited = visit(val, depth + 1);
          if (visited !== undefined) out[key] = visited;
        }
      }
      return out;
    } finally {
      seen.delete(input);
    }
  };

  return visit(value, 0);
}
