# fca-unofficial

[![CI](https://github.com/yohannzapata/fca-unofficial/actions/workflows/ci.yml/badge.svg)](https://github.com/yohannzapata/fca-unofficial/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js ≥ 24](https://img.shields.io/badge/node-%E2%89%A5%2024-339933)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![Dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)

An unofficial Facebook Messenger client library for Node.js, written in TypeScript.

It is built for **personal use with your own account**: long-running local tools that
read your messages and process them on your own machine. It has a typed API, keeps your
session safe on disk, reconnects reliably, and sends nothing anywhere except to Facebook.

> [!WARNING]
> **Early development.** The library can validate your session with Facebook, but it
> **cannot receive messages yet**. See [Project status](#project-status) and
> [Roadmap](#roadmap).

## Contents

- [Highlights](#highlights)
- [Project status](#project-status)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [API overview](#api-overview)
- [Documentation](#documentation)
- [Roadmap](#roadmap)
- [Security and privacy](#security-and-privacy)
- [Disclaimer](#disclaimer)
- [Development](#development)
- [License](#license)

## Highlights

- **Reliable connection lifecycle.** A single supervised reconnect loop with exponential
  backoff, jitter and cancellation, and an explicit state machine. It is tested so that
  repeated "connection lost" signals produce exactly one reconnect.
- **Safe sessions.** Cookies are imported locally from your own browser. Sessions are
  stored in atomic, checksummed files with optional AES-256-GCM encryption. Corruption is
  detected, never silently ignored.
- **No secrets in logs.** Every logger, including one you supply, passes through a
  redactor. Errors carry safe diagnostic details only.
- **Typed, stable API.** Your code works with typed events and domain objects, never raw
  protocol payloads.
- **Minimal footprint.** Zero runtime dependencies, ESM, strict TypeScript.
- **No login automation.** No password login, no 2FA handling, no checkpoint or captcha
  bypassing. You log in with your normal browser.

## Project status

The same information is available at runtime as `FEATURE_STATUS`.

| Feature                                                    | Status                                  |
| ---------------------------------------------------------- | --------------------------------------- |
| Session import and validation (local)                      | stable                                  |
| Session storage (atomic, checksummed, optional encryption) | stable                                  |
| Connection lifecycle and reconnect supervision             | stable                                  |
| Session validation with Facebook, checkpoint detection     | experimental                            |
| Receiving messages in real time                            | in development                          |
| Thread list, message history, user profiles                | planned                                 |
| Edits, unsends, reactions, typing indicators               | planned                                 |
| End-to-end encrypted chats                                 | not supported (under evaluation)        |
| Sending messages                                           | not supported (planned after read-only) |

**Stable** means implemented, tested and independent of Facebook's protocol.
**Experimental** means implemented and tested, but not yet verified against live
Facebook.

> [!IMPORTANT]
> Personal one-to-one chats on Messenger are end-to-end encrypted by default. Their content
> travels over a separate protocol that this library does not support. See
> [protocol status §9](docs/research/protocol-status.md#9-end-to-end-encrypted-messenger).

## Requirements

- Node.js 24 or later
- A Facebook account you own, logged in through a normal browser

## Installation

The library is installed from GitHub. It is **not** published to npm; the npm package
named `fca-unofficial` belongs to someone else and is unrelated to this project.

```bash
git clone https://github.com/yohannzapata/fca-unofficial.git
cd fca-unofficial
npm ci
npm run build
```

## Quick start

**1. Export your cookies.** Log in to `https://www.facebook.com` in your browser and export
the facebook.com cookies to a file, either as the `Cookie` request header or as a JSON
cookie export. The required cookies are `c_user`, `xs` and `datr`, and `sb` and `fr` are
recommended. Keep the file outside the project folder. See
[docs/sessions.md](docs/sessions.md).

**2. Import them** into a local, optionally encrypted session file. Setting
`FCA_USER_AGENT` to your browser's user agent (run `navigator.userAgent` in its DevTools
console) keeps requests consistent with that browser.

```bash
FCA_SESSION_PASSPHRASE="a long passphrase" FCA_USER_AGENT="…" node examples/basic/import-session.ts ~/Downloads/cookies.txt
```

Then delete the exported cookie file.

> [!TIP]
> In PowerShell, set variables first, for example `$env:FCA_SESSION_PASSPHRASE = "…"`,
> then run `node examples/basic/import-session.ts "$HOME\Downloads\cookies.txt"`.

**3. Check the session.** The read-only probe loads `facebook.com/messages` once and prints
a report that contains no secrets:

```bash
FCA_SESSION_PASSPHRASE="a long passphrase" node tools/probe.ts
```

**4. Use the client:**

```ts
import {
  MessengerClient,
  FileSessionStore,
  createPassphraseCodec,
  createConsoleLogger,
} from "fca-unofficial";

const client = new MessengerClient({
  session: new FileSessionStore({
    path: ".session/messenger.json",
    codec: createPassphraseCodec({ passphrase: process.env.FCA_SESSION_PASSPHRASE! }),
  }),
  logger: createConsoleLogger({ level: "info" }), // silent by default
});

client.on("stateChange", ({ from, to, reason }) => console.log(`${from} -> ${to}`, reason ?? ""));
client.on("error", (error) => console.error(error.code, error.message));

try {
  await client.connect();
} catch (error) {
  // Today: rejects with PROTOCOL_NOT_IMPLEMENTED after validating the session.
  console.error(error);
} finally {
  console.log(client.health());
  await client.destroy();
}
```

## API overview

| API                                                                 | Purpose                                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `new MessengerClient({ session, logger?, reconnect?, userAgent? })` | Creates a client for one account                                             |
| `client.connect()` / `disconnect()` / `destroy()`                   | Lifecycle. `disconnect()` and `destroy()` are idempotent                     |
| `client.on(event, listener)`                                        | Events: `ready`, `stateChange`, `error`. Returns an unsubscribe function     |
| `client.state`, `client.health()`                                   | Current connection state and a local health snapshot                         |
| `sessionFromCookies(input)`                                         | Validates exported cookies locally and builds a session                      |
| `FileSessionStore`, `MemorySessionStore`                            | Session storage. Implement `SessionStore` for your own backend               |
| `createPassphraseCodec()`, `createAesGcmCodec()`                    | Optional encryption at rest for `FileSessionStore`                           |
| `probeSession({ session })`                                         | Read-only session check with a secret-free report                            |
| `MessengerError` and subclasses                                     | Typed errors with stable `code` values. See [docs/errors.md](docs/errors.md) |

## Documentation

| Document                                                      | Contents                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| [Sessions](docs/sessions.md)                                  | Exporting cookies, storing sessions, encryption, expiry           |
| [Errors](docs/errors.md)                                      | Error codes and what to do about them                             |
| [Security](docs/security.md)                                  | Threat model, network destinations, secret handling, dependencies |
| [Architecture](docs/architecture.md)                          | Layers, lifecycle, event pipeline, session subsystem              |
| [Protocol status](docs/research/protocol-status.md)           | What is known about Messenger's protocol, with evidence levels    |
| [Existing projects](docs/research/existing-projects.md)       | Review of other Messenger client libraries                        |
| [Architecture options](docs/research/architecture-options.md) | Design alternatives considered                                    |

## Roadmap

1. **Real-time message receiving.** Facebook's current web gateway (DGW) and Lightspeed
   sync, with gap filling after reconnects.
2. **Read API.** Thread list, message history and user profiles.
3. **Message events.** Edits, unsends, reactions and typing indicators, with duplicate
   suppression.
4. **Long-running reliability.** Soak and fault-injection testing.
5. **Later.** End-to-end encrypted chats (under evaluation), sending messages, and an
   optional compatibility layer for code written against older FCA-style APIs.

## Security and privacy

- The library contacts only Facebook's own hosts. There is no telemetry, analytics,
  update check or third-party service.
- Session files never leave your machine unless you move them yourself.
- Report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

> [!CAUTION]
> Your session cookies work like your password. Never share them, commit them, or paste
> them into issues.

## Disclaimer

This project is not affiliated with, endorsed by, or supported by Meta Platforms, Inc.
Meta provides no official API for personal Messenger accounts, and its Terms of Service
restrict automated access. Using this library may lead to restrictions on your account,
and it may stop working whenever Facebook changes its web client. Use it at your own
risk, and only with an account you own.

This is an independent implementation. It shares no code with other packages or forks
named `fca-unofficial`.

## Development

```bash
npm run check   # type check, lint, format check and tests
npm test        # tests only
npm run build   # compile to dist/
```

Dependency install scripts are disabled through `.npmrc`. CI runs the full check on
Linux and Windows.

## License

[MIT](LICENSE) © Yohann Joachim Zapata
