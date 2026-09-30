import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigurationError,
  HttpStatusError,
  NetworkError,
  OperationAbortedError,
  ProtocolError,
  RateLimitError,
  TimeoutError,
} from "../../src/errors/errors.js";
import { resolveBackoffOptions } from "../../src/lifecycle/backoff.js";
import { createConsoleLogger } from "../../src/logging/logger.js";
import { CookieJar } from "../../src/transport/http/cookie-jar.js";
import { HttpClient, parseRetryAfter } from "../../src/transport/http/http-client.js";

type Handler = (req: IncomingMessage, res: ServerResponse, hit: number) => void;

let server: Server;
let base: string;
let handler: Handler;
let hits: IncomingMessage[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req);
    handler(req, res, hits.length);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});
beforeEach(() => {
  hits = [];
  handler = (_req, res) => res.end("ok");
});

const fastRetry = { maxAttempts: 3, backoff: resolveBackoffOptions({ initialDelayMs: 1, maxDelayMs: 5 }) };

describe("HttpClient", () => {
  it("returns text, sends default headers and jar cookies, and adds no extra headers", async () => {
    const jar = new CookieJar({ now: () => Date.now() });
    jar.setFromResponse(new URL(base), ["sid=abc"]);
    const client = new HttpClient({ cookieJar: jar, defaultHeaders: { "user-agent": "TestAgent/1.0" } });
    const res = await client.request({ method: "GET", url: `${base}/hello` });
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
    expect(res.attempts).toBe(1);
    expect(res.requestId).toMatch(/^[0-9a-f]{6}-1$/);
    const headers = hits[0]!.headers;
    expect(headers["user-agent"]).toBe("TestAgent/1.0");
    expect(headers["cookie"]).toBe("sid=abc");
    expect(Object.keys(headers).filter((h) => h.includes("request-id") || h.startsWith("x-"))).toEqual([]);
  });

  it("captures Set-Cookie from responses (including deletions) into the jar", async () => {
    let changes = 0;
    const jar = new CookieJar({ onChange: () => changes++ });
    handler = (req, res) => {
      res.setHeader("set-cookie", req.url === "/set" ? ["a=1", "b=2"] : ["a=; Max-Age=0"]);
      res.end();
    };
    const client = new HttpClient({ cookieJar: jar });
    await client.request({ method: "GET", url: `${base}/set` });
    expect(jar.get("a")).toBe("1");
    await client.request({ method: "GET", url: `${base}/del` });
    expect(jar.get("a")).toBeUndefined();
    expect(jar.get("b")).toBe("2");
    expect(changes).toBe(2);
  });

  it("does not follow redirects by default and exposes the location", async () => {
    handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "/login.php?next=x");
      res.end();
    };
    const client = new HttpClient();
    const res = await client.request({ method: "GET", url: `${base}/messages` });
    expect(res.status).toBe(302);
    expect(res.redirectLocation).toBe("/login.php?next=x");
    expect(hits).toHaveLength(1);
  });

  it("retries idempotent requests on 503 and succeeds", async () => {
    handler = (_req, res, hit) => {
      res.statusCode = hit < 3 ? 503 : 200;
      res.end(hit < 3 ? "busy" : "done");
    };
    const client = new HttpClient({ retry: fastRetry });
    const res = await client.request({ method: "GET", url: base });
    expect(res.body).toBe("done");
    expect(res.attempts).toBe(3);
  });

  it("never retries non-idempotent requests", async () => {
    handler = (_req, res) => {
      res.statusCode = 503;
      res.end();
    };
    const client = new HttpClient({ retry: fastRetry });
    const error = await client.request({ method: "POST", url: base, body: "x=1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpStatusError);
    expect((error as HttpStatusError).status).toBe(503);
    expect(hits).toHaveLength(1);
  });

  it("does not retry non-retryable statuses", async () => {
    handler = (_req, res) => {
      res.statusCode = 404;
      res.end();
    };
    const client = new HttpClient({ retry: fastRetry });
    await expect(client.request({ method: "GET", url: base })).rejects.toMatchObject({
      status: 404,
      retryable: false,
    });
    expect(hits).toHaveLength(1);
  });

  it("honours short Retry-After on 429, and refuses to wait for long ones", async () => {
    handler = (_req, res, hit) => {
      res.statusCode = hit === 1 ? 429 : 200;
      res.setHeader("retry-after", "0");
      res.end();
    };
    const client = new HttpClient({ retry: fastRetry });
    expect((await client.request({ method: "GET", url: base })).attempts).toBe(2);

    hits = [];
    handler = (_req, res) => {
      res.statusCode = 429;
      res.setHeader("retry-after", "3600");
      res.end();
    };
    const error = await client.request({ method: "GET", url: base }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(3_600_000);
    expect(hits).toHaveLength(1);
  });

  it("times out slow responses with a retryable TimeoutError", async () => {
    handler = () => undefined; // never responds
    const client = new HttpClient({ timeoutMs: 100 });
    const error = await client.request({ method: "GET", url: base, retry: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).retryable).toBe(true);
  });

  it("cancels on caller abort and on client-wide shutdown", async () => {
    handler = () => undefined;
    const client = new HttpClient();
    const controller = new AbortController();
    const pending = client.request({ method: "GET", url: base, signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 20);
    await expect(pending).rejects.toBeInstanceOf(OperationAbortedError);

    const shutdown = new AbortController();
    const client2 = new HttpClient({ signal: shutdown.signal });
    const pending2 = client2.request({ method: "GET", url: base });
    setTimeout(() => {
      shutdown.abort();
    }, 20);
    await expect(pending2).rejects.toBeInstanceOf(OperationAbortedError);

    await expect(client2.request({ method: "GET", url: base })).rejects.toBeInstanceOf(OperationAbortedError);
  });

  it("enforces the response size limit (declared and streamed)", async () => {
    handler = (_req, res) => res.end("x".repeat(5000));
    const client = new HttpClient({ maxResponseBytes: 1000 });
    await expect(client.request({ method: "GET", url: base })).rejects.toBeInstanceOf(ProtocolError);

    handler = (_req, res) => {
      res.write("y".repeat(800));
      res.end("y".repeat(800)); // chunked, no content-length
    };
    await expect(client.request({ method: "GET", url: base })).rejects.toThrow(/exceeds 1000 bytes/);
  });

  it("maps connection failures to retryable NetworkError", async () => {
    const client = new HttpClient({ retry: { maxAttempts: 1 } });
    const error = await client
      .request({ method: "GET", url: "http://127.0.0.1:9/" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).retryable).toBe(true);
  });

  it("refuses plain http except to loopback", async () => {
    const client = new HttpClient();
    await expect(client.request({ method: "GET", url: "http://www.facebook.com/" })).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it("never logs cookies, query strings or bodies", async () => {
    const lines: string[] = [];
    handler = (_req, res) => {
      res.setHeader("set-cookie", "xs=SERVER-SECRET; Path=/");
      res.end("BODY-SECRET");
    };
    const jar = new CookieJar();
    jar.setFromResponse(new URL(base), ["xs=CLIENT-SECRET"]);
    const client = new HttpClient({
      cookieJar: jar,
      logger: createConsoleLogger({ level: "trace", write: (l) => lines.push(l) }),
    });
    await client.request({
      method: "POST",
      url: `${base}/api?fb_dtsg=QUERY-SECRET`,
      body: "lsd=FORM-SECRET",
    });
    const all = lines.join("\n");
    expect(all).toContain("http request");
    for (const secret of ["SERVER-SECRET", "CLIENT-SECRET", "QUERY-SECRET", "FORM-SECRET", "BODY-SECRET"]) {
      expect(all).not.toContain(secret);
    }
  });

  it("parses Retry-After values", () => {
    expect(parseRetryAfter("5", 0)).toBe(5000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });
});
