import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  CheckpointRequiredError,
  HttpStatusError,
  InvalidSessionError,
  MessengerError,
  NetworkError,
  ProtocolNotImplementedError,
  RateLimitError,
  SessionCorruptedError,
  SessionExpiredError,
  TimeoutError,
  toMessengerError,
} from "../../src/errors/errors.js";

describe("error hierarchy", () => {
  it("assigns codes, names and retryability", () => {
    const cases: [MessengerError, string, boolean][] = [
      [new InvalidSessionError("x"), "INVALID_SESSION", false],
      [new SessionExpiredError(), "SESSION_EXPIRED", false],
      [new CheckpointRequiredError("checkpoint"), "CHECKPOINT_REQUIRED", false],
      [new NetworkError("x"), "NETWORK", true],
      [new TimeoutError("x"), "TIMEOUT", true],
      [new HttpStatusError(503, "x"), "HTTP_STATUS", true],
      [new HttpStatusError(404, "x"), "HTTP_STATUS", false],
      [new RateLimitError(1000), "RATE_LIMITED", true],
      [new ProtocolNotImplementedError("realtime", "x"), "PROTOCOL_NOT_IMPLEMENTED", false],
      [new SessionCorruptedError("x"), "SESSION_CORRUPTED", false],
    ];
    for (const [error, code, retryable] of cases) {
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(retryable);
      expect(error.name).toBe(error.constructor.name);
      expect(error).toBeInstanceOf(MessengerError);
      expect(error).toBeInstanceOf(Error);
    }
    expect(new SessionExpiredError()).toBeInstanceOf(AuthenticationError);
    expect(new TimeoutError("x")).toBeInstanceOf(NetworkError);
    expect(new RateLimitError(undefined)).toBeInstanceOf(HttpStatusError);
  });

  it("redacts secret-looking detail keys and secret-shaped message content", () => {
    const error = new MessengerError("failed with cookie xs=abc123secret; fb_dtsg=tok-en", "INTERNAL", {
      details: {
        cookie: "c_user=1; xs=zzz",
        fb_dtsg: "tok",
        host: "www.facebook.com",
        attempt: 2,
        gone: undefined,
      },
    });
    expect(error.message).not.toContain("abc123secret");
    expect(error.message).not.toContain("tok-en");
    expect(error.details).toEqual({
      cookie: "[REDACTED]",
      fb_dtsg: "[REDACTED]",
      host: "www.facebook.com",
      attempt: 2,
    });
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it("serializes safely without the cause chain", () => {
    const cause = new Error("inner xs=secretvalue");
    const error = new NetworkError("outer", "NETWORK", { cause, details: { host: "h" } });
    const json = JSON.stringify(error);
    expect(json).not.toContain("secretvalue");
    expect(json).not.toContain("inner");
    expect(JSON.parse(json)).toEqual({
      name: "NetworkError",
      code: "NETWORK",
      message: "outer",
      retryable: true,
      details: { host: "h" },
    });
    expect(error.cause).toBe(cause);
  });

  it("carries the checkpoint kind", () => {
    const error = new CheckpointRequiredError("consent");
    expect(error.kind).toBe("consent");
    expect(error.details["kind"]).toBe("consent");
  });

  it("normalizes unknown throwables into non-retryable INTERNAL errors", () => {
    const wrapped = toMessengerError(new TypeError("boom"));
    expect(wrapped.code).toBe("INTERNAL");
    expect(wrapped.retryable).toBe(false);
    expect(wrapped.details["causeName"]).toBe("TypeError");
    expect(toMessengerError("str").code).toBe("INTERNAL");
    const original = new NetworkError("x");
    expect(toMessengerError(original)).toBe(original);
  });
});
