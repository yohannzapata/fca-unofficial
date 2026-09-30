import { describe, expect, it } from "vitest";
import {
  createConsoleLogger,
  createRedactingLogger,
  type LogFields,
  type Logger,
  silentLogger,
} from "../../src/logging/logger.js";
import { isSecretKey, redact, REDACTED, redactString } from "../../src/logging/redact.js";

describe("redact", () => {
  it("replaces values under secret keys at any depth", () => {
    const input = {
      headers: { Cookie: "c_user=1; xs=abc", "user-agent": "UA" },
      session: { cookies: [{ name: "xs", value: "abc" }] },
      nested: { deeper: { accessToken: "t", fb_dtsg: "d", password: "p", ok: 1 } },
      appState: [{ key: "xs", value: "abc" }],
    };
    expect(redact(input)).toEqual({
      headers: { Cookie: REDACTED, "user-agent": "UA" },
      session: REDACTED,
      nested: { deeper: { accessToken: REDACTED, fb_dtsg: REDACTED, password: REDACTED, ok: 1 } },
      appState: REDACTED,
    });
  });

  it("masks secret-shaped substrings in strings", () => {
    const s = redactString(
      "GET /x?access_token=AAA&fb_dtsg=BBB cookie: xs=CCC; datr=DDD; c_user=5 Authorization: Bearer abcdefghijk",
    );
    for (const secret of ["AAA", "BBB", "CCC", "DDD", "abcdefghijk"]) expect(s).not.toContain(secret);
    expect(s).toContain("c_user=5");
  });

  it("handles cycles, binary data, errors, maps and depth limits without throwing", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    expect(redact(cyclic)).toEqual({ a: 1, self: "[Circular]" });
    expect(redact({ buf: new Uint8Array(12) })).toEqual({ buf: "[bytes 12]" });
    expect(
      redact(
        new Map([
          ["xs", "v"],
          ["k", "v"],
        ]),
      ),
    ).toEqual({ xs: REDACTED, k: "v" });
    const err = Object.assign(new Error("fail xs=secret"), { code: "E1" });
    expect(redact({ err })).toEqual({ err: { name: "Error", message: `fail xs=${REDACTED}`, code: "E1" } });
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i++) deep = { d: deep };
    expect(JSON.stringify(redact(deep))).toContain("[MaxDepth]");
    expect(redact({ big: 10n, fn: () => 1 })).toEqual({ big: "10" });
  });

  it("truncates huge strings and arrays", () => {
    expect((redact("x".repeat(5000)) as string).length).toBeLessThan(2100);
    expect((redact(Array.from({ length: 80 }, (_, i) => i)) as unknown[]).at(-1)).toBe("[+30 more]");
  });

  it("classifies keys", () => {
    for (const k of [
      "xs",
      "XS",
      "cookie",
      "set-cookie",
      "fb_dtsg",
      "lsd",
      "api_token",
      "clientSecret",
      "private_key",
      "PIN",
    ]) {
      expect(isSecretKey(k), k).toBe(true);
    }
    for (const k of ["userId", "threadId", "host", "status", "c_user"]) expect(isSecretKey(k), k).toBe(false);
  });
});

type Line = { level: string; message: string; fields: LogFields | undefined };

class RecordingLogger implements Logger {
  constructor(
    private readonly bindings: LogFields = {},
    readonly lines: Line[] = [],
  ) {}
  #rec(level: string, message: string, fields?: LogFields): void {
    this.lines.push({
      level,
      message,
      fields: fields === undefined ? undefined : { ...this.bindings, ...fields },
    });
  }
  error(m: string, f?: LogFields): void {
    this.#rec("error", m, f);
  }
  warn(m: string, f?: LogFields): void {
    this.#rec("warn", m, f);
  }
  info(m: string, f?: LogFields): void {
    this.#rec("info", m, f);
  }
  debug(m: string, f?: LogFields): void {
    this.#rec("debug", m, f);
  }
  trace(m: string, f?: LogFields): void {
    this.#rec("trace", m, f);
  }
  child(bindings: LogFields): Logger {
    return new RecordingLogger({ ...this.bindings, ...bindings }, this.lines);
  }
}

describe("loggers", () => {
  it("redacting wrapper scrubs messages, fields and child bindings before they reach a user logger", () => {
    const inner = new RecordingLogger();
    const log = createRedactingLogger(inner).child({ cookie: "xs=1", component: "c" });
    log.info("request with xs=topsecret", { headers: { cookie: "xs=topsecret" }, host: "h" });
    const serialized = JSON.stringify(inner.lines);
    expect(serialized).not.toContain("topsecret");
    expect(inner.lines[0]!.fields).toMatchObject({ component: "c", host: "h", cookie: REDACTED });
  });

  it("redacting wrapper swallows exceptions thrown by a broken logger", () => {
    const broken: Logger = {
      error: () => {
        throw new Error("sink down");
      },
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
      child: () => {
        throw new Error("no child");
      },
    };
    const log = createRedactingLogger(broken);
    expect(() => {
      log.error("x");
    }).not.toThrow();
    expect(() => log.child({ a: 1 })).not.toThrow();
  });

  it("does not double-wrap and leaves the silent logger alone", () => {
    const wrapped = createRedactingLogger(new RecordingLogger());
    expect(createRedactingLogger(wrapped)).toBe(wrapped);
    expect(createRedactingLogger(silentLogger)).toBe(silentLogger);
  });

  it("console logger filters by level and supports json output", () => {
    const out: string[] = [];
    const log = createConsoleLogger({
      level: "info",
      format: "json",
      write: (l) => out.push(l),
      now: () => new Date("2026-01-01T00:00:00Z"),
    }).child({ component: "t" });
    log.debug("hidden");
    log.info("shown", { n: 1 });
    log.error("bad");
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0]!)).toEqual({
      time: "2026-01-01T00:00:00.000Z",
      level: "info",
      msg: "shown",
      component: "t",
      n: 1,
    });
  });

  it("silent level emits nothing", () => {
    const out: string[] = [];
    const log = createConsoleLogger({ level: "silent", write: (l) => out.push(l) });
    log.error("x");
    expect(out).toHaveLength(0);
  });
});
