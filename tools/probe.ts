/**
 * Read-only session probe.
 *
 * Loads https://www.facebook.com/messages ONCE with your stored session, the same as opening
 * it in a browser, and prints what the library found. It performs no actions on your
 * account. The report contains no cookie values, tokens or personal data, so it is safe to
 * share when reporting protocol problems. Cookies Facebook rotates are saved back to your
 * session file.
 *
 *   npm run build
 *   node tools/probe.ts             print the report
 *   node tools/probe.ts --save      also write traces/probe-<timestamp>.json (gitignored)
 *   node tools/probe.ts --verbose   debug logging (redacted) to stderr
 *
 * Environment: FCA_SESSION_PATH (default .session/messenger.json), FCA_SESSION_PASSPHRASE,
 * FCA_USER_AGENT (optional; defaults to the user agent stored with the session).
 */
import { mkdir, writeFile } from "node:fs/promises";
import {
  createConsoleLogger,
  createPassphraseCodec,
  FileSessionStore,
  probeSession,
  type SessionProbeReport,
} from "fca-unofficial";

const args = new Set(process.argv.slice(2));
const passphrase = process.env["FCA_SESSION_PASSPHRASE"];
const userAgent = process.env["FCA_USER_AGENT"];

const report = await probeSession({
  session: new FileSessionStore({
    path: process.env["FCA_SESSION_PATH"] ?? ".session/messenger.json",
    ...(passphrase ? { codec: createPassphraseCodec({ passphrase }) } : {}),
  }),
  ...(args.has("--verbose") ? { logger: createConsoleLogger({ level: "debug" }) } : {}),
  ...(userAgent ? { userAgent } : {}),
});

console.log(JSON.stringify(report, null, 2));
console.error(`\n${summarize(report)}`);

if (args.has("--save")) {
  await mkdir("traces", { recursive: true });
  const file = `traces/probe-${report.generatedAt.replace(/[:.]/g, "-")}.json`;
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`Saved report to ${file}`);
}
process.exitCode = report.outcome === "ok" ? 0 : 1;

function summarize(r: SessionProbeReport): string {
  switch (r.outcome) {
    case "ok": {
      const missing = r.config?.missingForRealtime ?? [];
      return missing.length === 0
        ? "Session is valid, and everything realtime messaging needs was found in the page."
        : `Session is valid. Not found in the page (needed for realtime messaging): ${missing.join(", ")}.`;
    }
    case "session_expired":
      return "Facebook no longer accepts this session. Log in again in your browser and re-import the cookies.";
    case "checkpoint_required":
      return "Facebook wants an interactive check. Open facebook.com in your browser, complete it, then re-import.";
    case "invalid_session":
      return `The stored session is missing or invalid: ${r.error?.message ?? ""}`;
    case "session_store_error":
      return `Could not read the session file: ${r.error?.message ?? ""}`;
    case "network_error":
      return `Network problem: ${r.error?.message ?? ""}`;
    case "protocol_error":
      return `The page did not look as expected (Facebook may have changed it): ${r.error?.message ?? ""}`;
    case "error":
      return `Unexpected error: ${r.error?.message ?? ""}`;
  }
}
