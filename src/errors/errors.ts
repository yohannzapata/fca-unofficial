import { isSecretKey, REDACTED, redactString } from "../logging/redact.js";

export type ErrorCode =
  | "INTERNAL"
  | "CONFIGURATION"
  | "CLIENT_STATE"
  | "ABORTED"
  | "AUTHENTICATION"
  | "INVALID_SESSION"
  | "SESSION_EXPIRED"
  | "CHECKPOINT_REQUIRED"
  | "SESSION_STORE"
  | "SESSION_CORRUPTED"
  | "NETWORK"
  | "TIMEOUT"
  | "HTTP_STATUS"
  | "RATE_LIMITED"
  | "PROTOCOL"
  | "PROTOCOL_NOT_IMPLEMENTED"
  | "REALTIME";

/**
 * Diagnostic details attached to errors. Primitive values only, so that objects holding
 * secrets (headers, cookie jars, payloads) cannot be attached by accident. Values under
 * secret-looking keys are redacted at construction time regardless.
 */
export type ErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

export interface MessengerErrorOptions {
  cause?: unknown;
  details?: Record<string, string | number | boolean | null | undefined>;
  retryable?: boolean;
}

function sanitizeDetails(details: MessengerErrorOptions["details"]): ErrorDetails {
  const out: Record<string, string | number | boolean | null> = {};
  if (!details) return out;
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;
    if (isSecretKey(key)) out[key] = REDACTED;
    else out[key] = typeof value === "string" ? redactString(value, 500) : value;
  }
  return Object.freeze(out);
}

/** Base class for every error this library produces. */
export class MessengerError extends Error {
  readonly code: ErrorCode;
  /** Whether retrying the same operation later may succeed. Drives reconnect classification. */
  readonly retryable: boolean;
  readonly details: ErrorDetails;

  constructor(message: string, code: ErrorCode = "INTERNAL", options: MessengerErrorOptions = {}) {
    super(redactString(message, 1_000), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = sanitizeDetails(options.details);
  }

  /** Safe serialization: never includes the cause chain, stack, or anything beyond sanitized details. */
  toJSON(): { name: string; code: ErrorCode; message: string; retryable: boolean; details: ErrorDetails } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export class ConfigurationError extends MessengerError {
  constructor(message: string, options: MessengerErrorOptions = {}) {
    super(message, "CONFIGURATION", { ...options, retryable: false });
  }
}

/** The client was used in a state that does not allow the operation (e.g. after `destroy()`). */
export class ClientStateError extends MessengerError {
  constructor(message: string, options: MessengerErrorOptions = {}) {
    super(message, "CLIENT_STATE", { ...options, retryable: false });
  }
}

/** The caller (or client shutdown) cancelled the operation. */
export class OperationAbortedError extends MessengerError {
  constructor(message = "Operation aborted", options: MessengerErrorOptions = {}) {
    super(message, "ABORTED", { ...options, retryable: false });
  }
}

export class AuthenticationError extends MessengerError {
  constructor(message: string, code: ErrorCode = "AUTHENTICATION", options: MessengerErrorOptions = {}) {
    super(message, code, { ...options, retryable: false });
  }
}

/** Session material is missing or malformed. Detected locally, without network access. */
export class InvalidSessionError extends AuthenticationError {
  constructor(message: string, options: MessengerErrorOptions = {}) {
    super(message, "INVALID_SESSION", options);
  }
}

/** The server no longer accepts the session (logged out, cookies revoked). */
export class SessionExpiredError extends AuthenticationError {
  constructor(
    message = "The session is no longer valid; log in again in a browser and re-import it",
    options: MessengerErrorOptions = {},
  ) {
    super(message, "SESSION_EXPIRED", options);
  }
}

export type CheckpointKind = "checkpoint" | "consent" | "challenge" | "suspended";

/**
 * The account needs an interactive action in a real browser (security checkpoint,
 * consent screen, challenge, suspension). This library never attempts to automate these.
 */
export class CheckpointRequiredError extends AuthenticationError {
  readonly kind: CheckpointKind;

  constructor(kind: CheckpointKind, options: MessengerErrorOptions = {}) {
    super(
      `Facebook requires interactive action (${kind}); resolve it in a browser, then reconnect`,
      "CHECKPOINT_REQUIRED",
      { ...options, details: { ...options.details, kind } },
    );
    this.kind = kind;
  }
}

export class SessionStoreError extends MessengerError {
  constructor(message: string, code: ErrorCode = "SESSION_STORE", options: MessengerErrorOptions = {}) {
    super(message, code, { ...options, retryable: false });
  }
}

/** Stored session data failed integrity or schema validation. It is never silently discarded. */
export class SessionCorruptedError extends SessionStoreError {
  constructor(message: string, options: MessengerErrorOptions = {}) {
    super(message, "SESSION_CORRUPTED", options);
  }
}

export class NetworkError extends MessengerError {
  constructor(message: string, code: ErrorCode = "NETWORK", options: MessengerErrorOptions = {}) {
    super(message, code, { retryable: true, ...options });
  }
}

export class TimeoutError extends NetworkError {
  constructor(message: string, options: MessengerErrorOptions = {}) {
    super(message, "TIMEOUT", options);
  }
}

export class HttpStatusError extends MessengerError {
  readonly status: number;

  constructor(
    status: number,
    message: string,
    code: ErrorCode = "HTTP_STATUS",
    options: MessengerErrorOptions = {},
  ) {
    super(message, code, {
      retryable: status === 408 || status === 429 || status >= 500,
      ...options,
      details: { ...options.details, status },
    });
    this.status = status;
  }
}

export class RateLimitError extends HttpStatusError {
  /** Server-requested delay, if it sent one. */
  readonly retryAfterMs: number | undefined;

  constructor(retryAfterMs: number | undefined, options: MessengerErrorOptions = {}) {
    super(429, "Rate limited by server", "RATE_LIMITED", {
      ...options,
      retryable: true,
      details: { ...options.details, retryAfterMs: retryAfterMs ?? null },
    });
    this.retryAfterMs = retryAfterMs;
  }
}

/** A response or payload did not match what the protocol layer expects. */
export class ProtocolError extends MessengerError {
  readonly area: string;

  constructor(
    area: string,
    message: string,
    code: ErrorCode = "PROTOCOL",
    options: MessengerErrorOptions = {},
  ) {
    super(message, code, { retryable: false, ...options, details: { ...options.details, area } });
    this.area = area;
  }
}

/**
 * A protocol component has not been implemented or verified yet. Thrown instead of
 * pretending to work. Permanent: retrying will not help.
 */
export class ProtocolNotImplementedError extends ProtocolError {
  constructor(component: string, message: string, options: MessengerErrorOptions = {}) {
    super(component, message, "PROTOCOL_NOT_IMPLEMENTED", { ...options, retryable: false });
  }
}

/** Realtime connection failures. Retryable unless stated otherwise. */
export class RealtimeError extends MessengerError {
  constructor(message: string, options: MessengerErrorOptions = {}) {
    super(message, "REALTIME", { retryable: true, ...options });
  }
}

export function isMessengerError(value: unknown): value is MessengerError {
  return value instanceof MessengerError;
}

/**
 * Normalizes anything thrown into a MessengerError. Unknown errors become non-retryable
 * INTERNAL errors: unexpected failures are surfaced, not retried forever.
 */
export function toMessengerError(value: unknown): MessengerError {
  if (value instanceof MessengerError) return value;
  if (value instanceof Error) {
    return new MessengerError(`Unexpected error: ${value.message}`, "INTERNAL", {
      cause: value,
      details: { causeName: value.name },
    });
  }
  return new MessengerError("Unexpected non-error value thrown", "INTERNAL", {
    details: { valueType: typeof value },
  });
}
