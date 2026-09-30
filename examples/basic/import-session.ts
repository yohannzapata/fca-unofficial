/**
 * Imports session cookies exported from YOUR OWN logged-in browser into a local session file.
 *
 * Reads from a file path or stdin, never from command-line arguments (those end up in shell
 * history and process listings). Performs no network access.
 *
 *   npm run build
 *   node examples/basic/import-session.ts cookies.txt     # Cookie header, or a JSON cookie export
 *
 * Optional environment:
 *   FCA_SESSION_PATH        where to write (default .session/messenger.json)
 *   FCA_SESSION_PASSPHRASE  encrypt the file at rest (scrypt + AES-256-GCM)
 *   FCA_USER_AGENT          the user agent of the browser the cookies came from (recommended;
 *                           in that browser, open DevTools → Console, run: navigator.userAgent)
 */
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import {
  type CookieInput,
  createPassphraseCodec,
  FileSessionStore,
  isMessengerError,
  sessionFromCookies,
} from "fca-unofficial";

const source = process.argv[2];
const raw = (source ? await readFile(source, "utf8") : await text(process.stdin)).trim();
const input = (raw.startsWith("[") || raw.startsWith("{") ? JSON.parse(raw) : raw) as CookieInput;

const passphrase = process.env["FCA_SESSION_PASSPHRASE"];
const store = new FileSessionStore({
  path: process.env["FCA_SESSION_PATH"] ?? ".session/messenger.json",
  ...(passphrase ? { codec: createPassphraseCodec({ passphrase }) } : {}),
});

const userAgent = process.env["FCA_USER_AGENT"];

try {
  const { session, warnings } = sessionFromCookies(input, userAgent ? { userAgent } : {});
  await store.save(session);
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  console.log(
    `Saved session for user …${session.userId.slice(-4)} to ${store.path} (${passphrase ? "encrypted" : "not encrypted"}).`,
  );
  if (source) console.log(`You can now delete ${source}; the session file is the only copy you need.`);
} catch (error) {
  if (!isMessengerError(error)) throw error;
  console.error(`Import failed [${error.code}]: ${error.message}`);
  process.exitCode = 1;
}
