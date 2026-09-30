/**
 * The browser identity presented to facebook.com. Fixed per session: consistency, not
 * randomization (docs/security.md). No fingerprint spoofing beyond sending the same
 * headers a normal browser sends.
 */
export interface BrowserProfile {
  readonly userAgent: string;
  readonly acceptLanguage: string;
  /** Low-entropy client hints matching `userAgent`; empty when they cannot be known exactly. */
  readonly clientHints: Readonly<Record<string, string>>;
}

/**
 * Default: desktop Chrome 141 on Windows. The Chrome version and brand list mirror the
 * values the maintained reference client sends (mautrix/meta useragent.go @ e012f9f8); the
 * platform is Windows because this project targets a Windows monitor. Override with your
 * own browser's user agent at import time for best consistency with your cookies.
 */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const DEFAULT_CLIENT_HINTS: Readonly<Record<string, string>> = Object.freeze({
  "sec-ch-ua": '"Chromium";v="141", "Google Chrome";v="141", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
});

export function createBrowserProfile(userAgent?: string, acceptLanguage = "en-US,en;q=0.9"): BrowserProfile {
  const ua = userAgent?.trim() || DEFAULT_USER_AGENT;
  return Object.freeze({
    userAgent: ua,
    acceptLanguage,
    // Client hints are only sent when they are known to match the UA exactly. Inventing
    // hints for an arbitrary UA would create an inconsistent (more unusual) request.
    clientHints: ua === DEFAULT_USER_AGENT ? DEFAULT_CLIENT_HINTS : Object.freeze({}),
  });
}

/** Headers for a top-level page navigation (e.g. loading /messages). */
export function navigationHeaders(
  profile: BrowserProfile,
  site: "none" | "same-origin",
): Record<string, string> {
  return {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": profile.acceptLanguage,
    "user-agent": profile.userAgent,
    ...profile.clientHints,
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    // The reference client notes that "none" is required for the page to include some config.
    "sec-fetch-site": site,
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
  };
}
