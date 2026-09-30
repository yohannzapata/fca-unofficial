/**
 * Classification of redirects received while loading facebook.com/messages.
 * Source: path rules used by mautrix/meta httpclient/http.go (checkHTTPRedirect) @ e012f9f8
 * (protocol-status.md §1). Only the path is inspected; query strings may carry tokens.
 */
export type RedirectKind =
  | "login" // session no longer valid
  | "checkpoint"
  | "challenge"
  | "consent"
  | "suspended"
  | "messages" // benign move within the messages app
  | "unknown";

const FACEBOOK_HOST = /(^|\.)facebook\.com$/i;

export function classifyRedirect(target: URL): RedirectKind {
  if (!FACEBOOK_HOST.test(target.hostname)) return "unknown";
  const path = target.pathname;
  if (path.includes("/challenge/") || path.includes("/auth_platform/")) return "challenge";
  if (path === "/accounts/suspended/" || path === "/accounts/suspended") return "suspended";
  if (path === "/consent/" || path.startsWith("/privacy/consent/")) return "consent";
  if (path.includes("/checkpoint/") || path === "/checkpoint") return "checkpoint";
  if (path === "/login.php" || path === "/login" || path.startsWith("/login/")) return "login";
  if (path === "/messages" || path.startsWith("/messages/")) return "messages";
  return "unknown";
}
