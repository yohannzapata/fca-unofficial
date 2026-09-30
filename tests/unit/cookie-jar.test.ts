import { describe, expect, it } from "vitest";
import { CookieJar, domainMatches, pathMatches } from "../../src/transport/http/cookie-jar.js";
import { fakeSession } from "../helpers/fixtures.js";

const NOW = 1_700_000_000_000;
const WWW = new URL("https://www.facebook.com/messages");

describe("CookieJar", () => {
  it("sends session cookies to facebook.com subdomains over https only", () => {
    const jar = new CookieJar({ cookies: fakeSession(NOW).cookies, now: () => NOW });
    const header = jar.cookieHeader(WWW);
    expect(header).toContain("c_user=100000000000001");
    expect(header).toContain("xs=FAKE-xs-value-for-tests");
    expect(jar.cookieHeader(new URL("wss://gateway.facebook.com/ws/lightspeed"))).toContain("xs=");
    expect(jar.cookieHeader(new URL("http://www.facebook.com/"))).toBeUndefined(); // secure cookies
    expect(jar.cookieHeader(new URL("https://example.com/"))).toBeUndefined();
    expect(jar.cookieHeader(new URL("https://notfacebook.com/"))).toBeUndefined();
  });

  it("applies Set-Cookie updates, Max-Age precedence and deletions, notifying on change", () => {
    let changes = 0;
    let now = NOW;
    const jar = new CookieJar({
      cookies: fakeSession(NOW).cookies,
      now: () => now,
      onChange: () => changes++,
    });
    jar.setFromResponse(WWW, ["xs=ROTATED; Domain=.facebook.com; Path=/; Secure; HttpOnly"]);
    expect(jar.get("xs")).toBe("ROTATED");
    expect(changes).toBe(1);

    // identical re-set: no change notification
    jar.setFromResponse(WWW, ["xs=ROTATED; Domain=.facebook.com; Path=/; Secure; HttpOnly"]);
    expect(changes).toBe(1);

    jar.setFromResponse(WWW, [
      "tmp=1; Max-Age=60; Expires=Wed, 01 Jan 2020 00:00:00 GMT; Domain=facebook.com; Secure",
    ]);
    expect(jar.get("tmp")).toBe("1"); // Max-Age wins over a past Expires
    now += 61_000;
    expect(jar.get("tmp")).toBeUndefined();

    jar.setFromResponse(WWW, ["fr=; Max-Age=0; Domain=.facebook.com; Path=/"]);
    expect(jar.get("fr")).toBeUndefined();
    expect(jar.toSessionCookies().some((c) => c.name === "fr")).toBe(false);
  });

  it("rejects Domain attributes that do not match the responding host", () => {
    const jar = new CookieJar({ now: () => NOW });
    expect(
      jar.setFromResponse(WWW, [
        "evil=1; Domain=example.com",
        "tld=1; Domain=com",
        "ok=1; Domain=facebook.com",
      ]),
    ).toBe(1);
    expect(jar.get("evil")).toBeUndefined();
    expect(jar.get("ok")).toBe("1");
  });

  it("host-only cookies are not sent to other subdomains; paths are matched per RFC 6265", () => {
    const jar = new CookieJar({ now: () => NOW });
    jar.setFromResponse(new URL("https://www.facebook.com/a/b"), ["h=1", "p=2; Path=/messages"]);
    expect(jar.cookieHeader(new URL("https://www.facebook.com/a/x"))).toBe("h=1");
    expect(jar.cookieHeader(new URL("https://m.facebook.com/a/x"))).toBeUndefined();
    expect(jar.cookieHeader(new URL("https://www.facebook.com/messages/t/1"))).toBe("p=2"); // h has default path /a
    expect(jar.cookieHeader(new URL("https://www.facebook.com/messagesX"))).toBeUndefined();
  });

  it("round-trips through session cookies", () => {
    const jar = new CookieJar({ cookies: fakeSession(NOW).cookies, now: () => NOW });
    const again = new CookieJar({ cookies: jar.toSessionCookies(), now: () => NOW });
    expect(again.cookieHeader(WWW)).toBe(jar.cookieHeader(WWW));
  });

  it("matching helpers", () => {
    expect(domainMatches("www.facebook.com", "facebook.com")).toBe(true);
    expect(domainMatches("evilfacebook.com", "facebook.com")).toBe(false);
    expect(pathMatches("/messages/t", "/messages")).toBe(true);
    expect(pathMatches("/messages", "/messages/")).toBe(false);
    expect(pathMatches("/messagesX", "/messages")).toBe(false);
  });
});
