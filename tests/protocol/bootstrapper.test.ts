import { describe, expect, it } from "vitest";
import {
  CheckpointRequiredError,
  HttpStatusError,
  InvalidSessionError,
  ProtocolError,
  SessionExpiredError,
} from "../../src/errors/errors.js";
import { silentLogger } from "../../src/logging/logger.js";
import { createBrowserProfile, DEFAULT_USER_AGENT } from "../../src/protocol/bootstrap/browser-profile.js";
import { type BootstrapTrace, loadBootstrap } from "../../src/protocol/bootstrap/bootstrapper.js";
import { classifyRedirect } from "../../src/protocol/bootstrap/redirects.js";
import { CookieJar } from "../../src/transport/http/cookie-jar.js";
import { HttpClient } from "../../src/transport/http/http-client.js";
import { type FakeRoute, fakeFetch } from "../helpers/fake-fetch.js";
import { fakeSession } from "../helpers/fixtures.js";
import { SYNTH, syntheticMessagesPage } from "../helpers/synthetic-page.js";

const MESSAGES = "www.facebook.com/messages";
const USER = "100000000000001";

function setup(routes: Record<string, FakeRoute | FakeRoute[]>, userAgent?: string) {
  const { fetch, requests } = fakeFetch(routes);
  const cookies = new CookieJar({ cookies: fakeSession(Date.now()).cookies });
  const http = new HttpClient({ cookieJar: cookies, fetch, retry: { maxAttempts: 1 } });
  const traces: BootstrapTrace[] = [];
  const run = () =>
    loadBootstrap(
      { http, cookies, profile: createBrowserProfile(userAgent), logger: silentLogger, now: Date.now },
      USER,
      new AbortController().signal,
      (t) => traces.push(t),
    );
  return { run, requests, cookies, traces };
}

describe("classifyRedirect", () => {
  it.each([
    ["https://www.facebook.com/login.php?next=https%3A%2F%2Fwww.facebook.com%2Fmessages", "login"],
    ["https://www.facebook.com/login/?next=x", "login"],
    ["https://www.facebook.com/checkpoint/828281030927956/?next=x", "checkpoint"],
    ["https://www.facebook.com/auth_platform/afad/?apc=x", "challenge"],
    ["https://www.facebook.com/challenge/?x", "challenge"],
    ["https://www.facebook.com/privacy/consent/lgpd/", "consent"],
    ["https://www.facebook.com/consent/", "consent"],
    ["https://www.facebook.com/accounts/suspended/", "suspended"],
    ["https://www.facebook.com/messages/t/123456/", "messages"],
    ["https://www.facebook.com/home.php", "unknown"],
    ["https://evil.example.com/messages/", "unknown"],
    ["https://facebook.com.evil.example/login.php", "unknown"],
  ])("%s → %s", (url, kind) => {
    expect(classifyRedirect(new URL(url))).toBe(kind);
  });
});

describe("loadBootstrap", () => {
  it("loads the page with navigation headers and session cookies, and returns the config", async () => {
    const { run, requests, traces } = setup({ [MESSAGES]: { body: syntheticMessagesPage() } });
    const { config, trace } = await run();
    expect(config.fbDtsg).toBe(SYNTH.dtsg);
    expect(config.lsVersionId).toBe(SYNTH.lsVersion);
    expect(requests).toHaveLength(1);
    const h = requests[0]!.headers;
    expect(requests[0]!.url).toBe("https://www.facebook.com/messages");
    expect(h["user-agent"]).toBe(DEFAULT_USER_AGENT);
    expect(h["sec-fetch-site"]).toBe("none");
    expect(h["sec-fetch-mode"]).toBe("navigate");
    expect(h["sec-ch-ua-platform"]).toBe('"Windows"');
    expect(h["cookie"]).toContain("xs=FAKE-xs-value-for-tests");
    expect(trace.hops).toEqual([{ status: 200, host: "www.facebook.com", path: "/messages" }]);
    expect(trace.page?.modules["LSD"]?.keys).toEqual(["token"]);
    expect(traces).toHaveLength(1);
  });

  it("omits client hints for a custom user agent (never invents them)", async () => {
    const { run, requests } = setup(
      { [MESSAGES]: { body: syntheticMessagesPage() } },
      "Mozilla/5.0 Custom/1.0",
    );
    await run();
    expect(requests[0]!.headers["user-agent"]).toBe("Mozilla/5.0 Custom/1.0");
    expect(Object.keys(requests[0]!.headers).some((k) => k.startsWith("sec-ch-ua"))).toBe(false);
  });

  it("follows a same-app redirect within /messages", async () => {
    const { run, requests } = setup({
      [MESSAGES]: { status: 302, headers: [["location", "/messages/t/123/"]] },
      "www.facebook.com/messages/t/123/": { body: syntheticMessagesPage() },
    });
    await run();
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/messages", "/messages/t/123/"]);
    expect(requests[1]!.headers["sec-fetch-site"]).toBe("same-origin");
  });

  it("maps a login redirect to SessionExpiredError and records the hop without the query", async () => {
    const { run, traces } = setup({
      [MESSAGES]: {
        status: 302,
        headers: [["location", "https://www.facebook.com/login.php?next=secret-token"]],
      },
    });
    await expect(run()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(traces[0]!.hops).toEqual([
      { status: 302, host: "www.facebook.com", path: "/messages", kind: "login" },
    ]);
    expect(JSON.stringify(traces)).not.toContain("secret-token");
  });

  it.each([
    ["/checkpoint/1501092823525282/", "checkpoint"],
    ["/auth_platform/afad/", "challenge"],
    ["/privacy/consent/gdpr/", "consent"],
    ["/accounts/suspended/", "suspended"],
  ])("maps a redirect to %s to CheckpointRequiredError(%s)", async (path, kind) => {
    const { run } = setup({
      [MESSAGES]: { status: 302, headers: [["location", `https://www.facebook.com${path}`]] },
    });
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CheckpointRequiredError);
    expect((error as CheckpointRequiredError).kind).toBe(kind);
  });

  it("treats a deleted xs cookie as an expired session", async () => {
    const { run, cookies } = setup({
      [MESSAGES]: {
        body: syntheticMessagesPage(),
        headers: [
          [
            "set-cookie",
            "xs=deleted; expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0; path=/; domain=.facebook.com",
          ],
        ],
      },
    });
    await expect(run()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(cookies.get("xs")).toBeUndefined();
  });

  it("treats a logged-out page (USER_ID 0) as an expired session", async () => {
    const { run } = setup({ [MESSAGES]: { body: syntheticMessagesPage({ loggedOut: true }) } });
    await expect(run()).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("rejects a page for another account", async () => {
    const { run } = setup({ [MESSAGES]: { body: syntheticMessagesPage({ userId: "100000000000777" }) } });
    await expect(run()).rejects.toBeInstanceOf(InvalidSessionError);
  });

  it("reports unexpected redirects and redirect loops as ProtocolError", async () => {
    const offsite = setup({ [MESSAGES]: { status: 302, headers: [["location", "https://example.com/x"]] } });
    await expect(offsite.run()).rejects.toThrow(/Unexpected redirect to example.com\/x/);

    const loop = setup({ [MESSAGES]: { status: 302, headers: [["location", "/messages"]] } });
    await expect(loop.run()).rejects.toThrow(/More than 5 redirects/);

    const noLocation = setup({ [MESSAGES]: { status: 302 } });
    await expect(noLocation.run()).rejects.toBeInstanceOf(ProtocolError);
  });

  it("passes server errors through as retryable HttpStatusError, with a trace", async () => {
    const { run, traces } = setup({ [MESSAGES]: { status: 503 } });
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpStatusError);
    expect((error as HttpStatusError).retryable).toBe(true);
    expect(traces).toHaveLength(1);
  });

  it("records rotated cookie names (never values) in the trace", async () => {
    const { run, cookies } = setup({
      [MESSAGES]: {
        body: syntheticMessagesPage(),
        headers: [
          [
            "set-cookie",
            "fr=ROTATED-FR-VALUE; Max-Age=7776000; path=/; domain=.facebook.com; secure; httponly",
          ],
        ],
      },
    });
    const { trace } = await run();
    expect(trace.changedCookies).toEqual(["fr"]);
    expect(JSON.stringify(trace)).not.toContain("ROTATED-FR-VALUE");
    expect(cookies.get("fr")).toBe("ROTATED-FR-VALUE");
  });
});
