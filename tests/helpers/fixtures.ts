import { sessionFromCookies, type SessionData } from "../../src/session/session.js";

/**
 * Obviously fake cookie values. Never put real session material in tests or fixtures.
 */
export const FAKE_COOKIE_HEADER =
  "c_user=100000000000001; xs=FAKE-xs-value-for-tests; datr=FAKE-datr; sb=FAKE-sb; fr=FAKE-fr";

export function fakeSession(now = 1_700_000_000_000): SessionData {
  return sessionFromCookies(FAKE_COOKIE_HEADER, { now: () => now, userAgent: "TestAgent/1.0" }).session;
}
