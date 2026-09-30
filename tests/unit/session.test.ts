import { describe, expect, it } from "vitest";
import { InvalidSessionError, SessionCorruptedError } from "../../src/errors/errors.js";
import { sessionFromCookies, validateSessionData } from "../../src/session/session.js";
import { MemorySessionStore } from "../../src/session/session-store.js";
import { FAKE_COOKIE_HEADER, fakeSession } from "../helpers/fixtures.js";

const NOW = 1_700_000_000_000;
const now = () => NOW;

describe("sessionFromCookies", () => {
  it("parses a Cookie header (with or without the 'Cookie:' prefix)", () => {
    for (const input of [FAKE_COOKIE_HEADER, `Cookie: ${FAKE_COOKIE_HEADER}`]) {
      const { session, warnings } = sessionFromCookies(input, { now });
      expect(session.userId).toBe("100000000000001");
      expect(session.cookies.map((c) => c.name).sort()).toEqual(["c_user", "datr", "fr", "sb", "xs"]);
      expect(session.cookies.every((c) => c.domain === ".facebook.com" && c.path === "/")).toBe(true);
      expect(session.version).toBe(1);
      expect(session.createdAt).toBe(NOW);
      expect(warnings).toEqual([]);
    }
  });

  it("parses browser-extension exports (expirationDate in seconds) and drops foreign domains", () => {
    const { session, warnings } = sessionFromCookies(
      [
        {
          name: "c_user",
          value: "100000000000001",
          domain: ".facebook.com",
          path: "/",
          expirationDate: NOW / 1000 + 3600,
          secure: true,
        },
        { name: "xs", value: "FAKE", domain: ".facebook.com", httpOnly: true },
        { name: "datr", value: "FAKE", domain: ".facebook.com" },
        { name: "tracking", value: "zzz", domain: ".example.com" },
      ],
      { now },
    );
    expect(session.cookies.find((c) => c.name === "c_user")?.expiresAt).toBe(NOW + 3_600_000);
    expect(session.cookies.find((c) => c.name === "xs")?.httpOnly).toBe(true);
    expect(session.cookies.some((c) => c.name === "tracking")).toBe(false);
    expect(warnings.some((w) => w.includes("non-facebook.com"))).toBe(true);
  });

  it("accepts legacy FCA appState ({ key, value, hostOnly })", () => {
    const { session } = sessionFromCookies(
      [
        { key: "c_user", value: "100000000000001", domain: "facebook.com", hostOnly: false },
        { key: "xs", value: "FAKE", domain: "facebook.com", hostOnly: false },
        { key: "datr", value: "FAKE", domain: "facebook.com", hostOnly: false },
      ],
      { now },
    );
    expect(session.cookies.every((c) => c.domain === ".facebook.com")).toBe(true);
  });

  it("accepts a name→value map", () => {
    const { session } = sessionFromCookies({ c_user: "100000000000001", xs: "FAKE", datr: "FAKE" }, { now });
    expect(session.cookies).toHaveLength(3);
  });

  it("warns about missing recommended cookies", () => {
    const { warnings } = sessionFromCookies("c_user=100000000000001; xs=FAKE; datr=FAKE", { now });
    expect(warnings).toHaveLength(2);
  });

  it("reports missing required cookies by name only, never by value", () => {
    try {
      sessionFromCookies("c_user=100000000000001; xs=SUPERSECRETVALUE", { now });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidSessionError);
      const e = error as InvalidSessionError;
      expect(e.message).toContain("datr");
      expect(JSON.stringify(e)).not.toContain("SUPERSECRETVALUE");
      expect(e.message).not.toContain("SUPERSECRETVALUE");
    }
  });

  it("rejects a non-numeric c_user and already-expired required cookies", () => {
    expect(() => sessionFromCookies("c_user=abc; xs=F; datr=F", { now })).toThrow(/numeric/);
    expect(() =>
      sessionFromCookies(
        [
          { name: "c_user", value: "1", domain: ".facebook.com" },
          { name: "xs", value: "F", domain: ".facebook.com", expires: NOW - 1 },
          { name: "datr", value: "F", domain: ".facebook.com" },
        ],
        { now },
      ),
    ).toThrow(/expired: xs/);
  });

  it("ignores malformed pairs with a warning", () => {
    const { warnings } = sessionFromCookies(`${FAKE_COOKIE_HEADER}; garbage; =novalue`, { now });
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });
});

describe("validateSessionData", () => {
  it("accepts a valid session", () => {
    expect(validateSessionData(fakeSession()).ok).toBe(true);
  });

  it("lists problems without leaking values", () => {
    const bad = {
      ...fakeSession(),
      version: 2,
      userId: "x",
      cookies: [{ name: "xs", value: 5, domain: ".evil.com", path: "/" }],
    };
    const result = validateSessionData(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join("\n")).toMatch(/version/);
      expect(result.problems.join("\n")).toMatch(/userId/);
      expect(result.problems.join("\n")).toMatch(/cookies\[0\]/);
      expect(result.problems.join("\n")).toMatch(/c_user/);
    }
    expect(validateSessionData(null).ok).toBe(false);
    expect(validateSessionData([]).ok).toBe(false);
  });
});

describe("MemorySessionStore", () => {
  it("round-trips copies, refuses invalid data, and clears", async () => {
    const store = new MemorySessionStore();
    expect(await store.load()).toBeNull();
    const session = fakeSession();
    await store.save(session);
    const loaded = await store.load();
    expect(loaded).toEqual(session);
    expect(loaded).not.toBe(session);
    await expect(store.save({ ...session, userId: "nope" })).rejects.toBeInstanceOf(SessionCorruptedError);
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});
