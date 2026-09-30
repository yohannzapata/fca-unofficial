import { describe, expect, it } from "vitest";
import { probeSession } from "../../src/client/probe.js";
import { MemorySessionStore, type SessionStore } from "../../src/session/session-store.js";
import { SessionCorruptedError } from "../../src/errors/errors.js";
import { fakeFetch } from "../helpers/fake-fetch.js";
import { fakeSession } from "../helpers/fixtures.js";
import { SYNTH, syntheticMessagesPage } from "../helpers/synthetic-page.js";

const MESSAGES = "www.facebook.com/messages";
const SECRETS = [
  SYNTH.dtsg,
  SYNTH.lsd,
  SYNTH.eqmcDtsg,
  "SYNTH-CAT",
  "Synthetic Person",
  SYNTH.deviceClientId,
  "FAKE-xs-value-for-tests",
  "FAKE-datr",
  "100000000000001",
];

function expectNoSecrets(report: unknown): void {
  const json = JSON.stringify(report);
  for (const secret of SECRETS) expect(json, `report leaked ${secret}`).not.toContain(secret);
}

describe("probeSession", () => {
  it("reports a healthy session with allowlisted, secret-free details", async () => {
    const { fetch } = fakeFetch({ [MESSAGES]: { body: syntheticMessagesPage() } });
    const report = await probeSession(
      { session: new MemorySessionStore(fakeSession()) },
      { fetch, now: () => 0 },
    );
    expect(report.outcome).toBe("ok");
    expect(report.session).toEqual({
      userIdSuffix: "…0001",
      cookieNames: ["c_user", "datr", "fr", "sb", "xs"],
      userAgent: "custom", // fakeSession stores "TestAgent/1.0"
    });
    expect(report.config).toMatchObject({
      tokens: { fbDtsg: true, lsd: true, jazoest: true, cometReq: true },
      userMatchesSession: true,
      lsVersionId: SYNTH.lsVersion,
      dgwAppId: SYNTH.dgwAppId,
      deviceClientIdPresent: true,
      syncParams: { mailbox: true, contact: true, e2ee: true },
      missingForRealtime: [],
    });
    expect(report.page?.modules["CurrentUserInitialData"]?.keys).toContain("USER_ID");
    expect(report.http?.hops).toHaveLength(1);
    expectNoSecrets(report);
  });

  it("reports an expired session", async () => {
    const { fetch } = fakeFetch({
      [MESSAGES]: { status: 302, headers: [["location", "https://www.facebook.com/login.php?next=x"]] },
    });
    const report = await probeSession({ session: new MemorySessionStore(fakeSession()) }, { fetch });
    expect(report.outcome).toBe("session_expired");
    expect(report.error?.code).toBe("SESSION_EXPIRED");
    expect(report.http?.hops[0]?.kind).toBe("login");
    expectNoSecrets(report);
  });

  it("reports page structure problems with the page summary (for diagnosis)", async () => {
    const { fetch } = fakeFetch({ [MESSAGES]: { body: syntheticMessagesPage({ omit: ["LSD"] }) } });
    const report = await probeSession({ session: new MemorySessionStore(fakeSession()) }, { fetch });
    expect(report.outcome).toBe("protocol_error");
    expect(report.page?.modulesMissing).toContain("LSD");
    expectNoSecrets(report);
  });

  it("reports store problems and network problems", async () => {
    const empty = await probeSession({ session: new MemorySessionStore() });
    expect(empty.outcome).toBe("invalid_session");

    const broken: SessionStore = {
      load: () => Promise.reject(new SessionCorruptedError("bad checksum")),
      save: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    };
    expect((await probeSession({ session: broken })).outcome).toBe("session_store_error");

    const { fetch } = fakeFetch({}); // no routes: behaves like a network failure
    const offline = await probeSession({ session: new MemorySessionStore(fakeSession()) }, { fetch });
    expect(offline.outcome).toBe("network_error");
  });

  it("persists cookies rotated by the server", async () => {
    const store = new MemorySessionStore(fakeSession());
    const { fetch } = fakeFetch({
      [MESSAGES]: {
        body: syntheticMessagesPage(),
        headers: [["set-cookie", "fr=ROTATED; Max-Age=7776000; Path=/; Domain=.facebook.com; Secure"]],
      },
    });
    const report = await probeSession({ session: store }, { fetch });
    expect(report.http?.changedCookies).toEqual(["fr"]);
    expect((await store.load())?.cookies.find((c) => c.name === "fr")?.value).toBe("ROTATED");
  });
});
