# Sessions

The library never logs in. You log in to `https://www.facebook.com` in your own browser,
completing any 2FA or checkpoint there, and give the library that browser session's
cookies. They behave like a password: anyone holding them can use your account.

## 1. Export cookies

The needed cookies are **`c_user`, `xs`, `datr`**; `sb` and `fr` are recommended.
Accepted formats:

- **Cookie header string**: in DevTools → Network, select any request to
  `www.facebook.com` and copy the `cookie` request header value.
- **JSON array**: most cookie-export browser extensions produce
  `[{ "name", "value", "domain", "path", "expirationDate", … }]`.
- **Legacy FCA `appState`**: `[{ "key", "value", "domain", … }]`.
- **Name → value object**: `{ "c_user": "…", "xs": "…", "datr": "…" }`.

Cookies for domains other than facebook.com are dropped with a warning.

Tips:

- Use a normal (non-private) window, and do not log out afterwards. Logging out
  invalidates `xs`.
- Only install cookie-export extensions you trust. An extension can read every cookie
  you have.
- Delete the exported file after importing.

## 2. Import

```bash
node examples/basic/import-session.ts cookies.txt
# or from stdin, so nothing touches the disk:
node examples/basic/import-session.ts < cookies.txt
```

Programmatically:

```ts
import { sessionFromCookies, FileSessionStore } from "fca-unofficial";

const { session, warnings } = sessionFromCookies(cookieText); // validates locally, no network
await new FileSessionStore({ path: ".session/messenger.json" }).save(session);
```

`sessionFromCookies` throws `InvalidSessionError` naming any missing cookies. The error
names cookies only and never includes their values.

## 3. Storage

`SessionStore` is an interface (`load`, `save`, `clear`), so you can keep the session
wherever you like. Two implementations ship:

| Store                | Use                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemorySessionStore` | Tests, short scripts                                                                                                                            |
| `FileSessionStore`   | Local file. Writes are atomic (temp file → fsync → rename), SHA-256 checksummed and schema-validated; the previous valid file is kept as `.bak` |

Encryption at rest:

```ts
new FileSessionStore({ path, codec: createPassphraseCodec({ passphrase }) }); // scrypt + AES-256-GCM
new FileSessionStore({ path, codec: createAesGcmCodec({ key }) }); // your own 32-byte key
```

If the file is damaged or tampered with, `load()` throws `SessionCorruptedError`. The
backup is **never** loaded automatically, so a stale session is not revived without you
knowing. Call `store.loadBackup()` deliberately if you want it.

The default `.gitignore` excludes `.session/`, `appstate.json` and `*.session.json`.

## 4. Expiry and invalidation

The server can end a session (you logged out, changed your password, or Facebook
revoked it) or require an interactive check. Both `connect()` and the probe
(`node tools/probe.ts`) load `facebook.com/messages` and report:

- `SessionExpiredError`: a redirect to the login page, a logged-out page, or Facebook
  deleting the `xs` cookie. Export fresh cookies and import again.
- `CheckpointRequiredError` (`kind`: checkpoint, consent, challenge or suspended): open
  facebook.com in your browser, resolve the check, then re-export.
- `InvalidSessionError`: the page belongs to a different account than `c_user`.

Cookies that Facebook rotates during these requests are written back to your store
(debounced and atomic). A cookie update that would remove a required cookie (for
example `xs` on logout) is **not** saved, so the last good session stays on disk.

The client never clears your store by itself. What to do is your decision.
