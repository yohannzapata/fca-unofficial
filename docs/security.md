# Security

## Scope and intent

This library lets a person read **their own** Messenger account from their own machine.
It is deliberately unsuited to anything else. There is no multi-account orchestration, no
sending (yet), no password login, and no checkpoint, captcha or 2FA automation.

## What the library will never do

- Send session material (cookies, tokens, keys) anywhere other than Facebook's own hosts.
- Contact third-party services: no telemetry, analytics, update checks, "UID lookup" APIs
  or login proxies.
- Execute downloaded code: no `eval`, `new Function` or `node:vm` (lint-enforced), no
  auto-update, no dynamic `require`.
- Run install scripts. There are no `preinstall`/`postinstall` scripts, and the
  repository's `.npmrc` sets `ignore-scripts=true`.
- Spoof or randomise browser fingerprints, emulate telemetry, or "act human" to avoid
  detection.
- Write files anywhere except where you point a `FileSessionStore`.

## Network destinations

| When                                      | Host                                                  | Purpose                                                            |
| ----------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| Now                                       | `www.facebook.com`                                    | One read-only `GET /messages` per `connect()` attempt or probe run |
| With realtime receiving                   | `gateway.facebook.com`                                | Realtime WebSocket (DGW); GraphQL on `www.facebook.com`            |
| With attachment support                   | `*.fbcdn.net`                                         | Attachment download, **only when your code asks**                  |
| Optional encrypted-chat package, if built | `web-chat-e2ee.facebook.com`, `reg-e2ee.facebook.com` | Encrypted chats (opt-in, separate package)                         |

The HTTP transport refuses plain `http://` except to loopback test servers.

## Secrets handling

| Secret                                      | Where it lives                             | Protection                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session cookies (`xs`, `c_user`, `datr`, …) | Your `SessionStore`                        | Atomic, checksummed writes; optional AES-256-GCM (application key or scrypt passphrase); `0600`/`0700` on POSIX                                                                                |
| Page tokens (`fb_dtsg`, `lsd`)              | In memory only, for one connection attempt | Never written to disk or logs; the probe report contains presence flags only                                                                                                                   |
| Logs                                        | Your logger                                | Every logger is wrapped: secret keys redacted recursively, secret-shaped substrings masked, strings truncated, logger exceptions swallowed                                                     |
| Errors                                      | Thrown or emitted                          | `details` accept primitives only, and secret keys are redacted at construction; `toJSON()` excludes the cause chain and stacks; HTTP errors carry host and path, never query strings or bodies |

**Windows note:** POSIX file modes do not apply. Session files inherit the ACL of their
directory, so keep them under your user profile (for example `%LOCALAPPDATA%`). Prefer
`createPassphraseCodec` or `createAesGcmCodec` for encryption at rest.

## Account risk

Meta may flag automated access ("We suspect automated behaviour on your account"),
require a checkpoint, or restrict the account. The library reduces risk by behaving like
one consistent browser session. It uses a fixed user agent, no parallel sessions, sane
reconnect backoff and no polling. It does not _hide_ automation. If Facebook demands an
interactive check, you get `CheckpointRequiredError` and must resolve it in a
real browser.

## Supply chain

- Zero runtime dependencies. Dev dependencies are pinned exactly and locked by
  `package-lock.json`.
- `npm audit` is clean at the time of writing.
- Policy for adding a dependency (all must hold): it is necessary; actively maintained and
  reputable; ships no unexpected native binaries or network behaviour; has a compatible
  license; has no known vulnerabilities; and cannot be replaced by a small amount of our
  own code.
- **Never install FCA forks to "compare behaviour".** Several are malware (OSV
  MAL-2026-13457, MAL-2026-4363, MAL-2026-4560 and others). Read them as text only. See
  `docs/research/existing-projects.md`.

## Reporting

Open a private security advisory on the repository. Never paste session material into
issues or logs.
