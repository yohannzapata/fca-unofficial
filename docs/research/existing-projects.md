# Existing projects

**Research date:** 2026-09-30. Commit hashes are the heads inspected. "Inspected" means
we read the source files named below, not just the README. Nothing was installed or
executed.

## Ecosystem summary

- **One serious, current reference implementation exists: mautrix-meta (Go).** Its
  `messagix` package is maintained daily and tracks Meta's protocol changes (MQTT → DGW
  in July 2026). It is the primary _fact source_ for this project, used clean-room
  because it is AGPL-3.0.
- **The FCA (JavaScript) ecosystem is fragmented into dozens of personal forks.** npm
  search for `fca` / `facebook-chat-api` returns more than 60 packages, many updated this
  month. They share the 2015–2020 architecture of `Schmavery/facebook-chat-api`: global
  mutable `ctx`, callbacks, MQTT `/t_ms` Iris sync, scraping helpers, and multiple
  uncoordinated reconnect paths.
- **The FCA ecosystem has a malware problem.** At least 7 packages have OSV malware
  records, 3 of them from 2026. Several popular packages without such records have risky
  defaults: credentials sent to third-party servers, prebuilt native binaries, and
  auto-update. One repository has a user-reported issue about unwanted automatic follows.
- **TypeScript E2EE:** exactly one transparent implementation exists
  (`HerokeyVN/FB-Messenger-E2EE`, AGPL-3.0). Others ship unauditable binaries or
  unpublished sources.
- **No existing project combines** a typed modern API, protocol isolation, current
  transport (DGW), a single lifecycle manager, dedup/reconciliation, meaningful tests,
  and a clean security posture. That gap is what this project fills.

### Packages with published malware records (OSV)

These classifications are OSV's, not ours. Follow the links for the authoritative records.

| Package                                                             | OSV record                      | Behaviour described in the record                                              |
| ------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| `shadowx-fca` 10.0.0, 10.1.0, 10.6.0                                | **MAL-2026-13457** (2026-08-06) | `login()` POSTs email, password and 2FA seed to `minhdong.site`                |
| `@asura21232/fca-unofficial-nextgen` 2.0.1                          | **MAL-2026-4363** (2026-05-22)  | Sends email, password and 2FA secret to `api.fca-ng.top`                       |
| `fca-official-uzair-rajput` 1.16.0                                  | **MAL-2026-4560** (2026-05-20)  | Auto-update on every `login()`, giving the maintainer arbitrary code execution |
| `fb-chat-api2`, `fb-chat-fca`, `fb-chat-api-temp`, `fb-farebi-amir` | **MAL-2023-325/326/8172/8247**  | GHSA malware records                                                           |

### Observed behaviour worth knowing before using a package

What we saw in each package's code or files at the stated version or commit. These are
factual observations of default behaviour, **not** malware classifications. Any of them
may have changed since; check the current source before relying on this.

| Package (version / commit inspected)                                      | What we observed                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@dongdev/fca-unofficial` 4.0.3 (`src/core/auth-helpers.ts` @ `4f741c64`) | The email/password login helper sends email, password and TOTP secret to `https://minhdong.site/api/v1/facebook/login_ios` by default (configurable via `apiServer`). This is the same host named in MAL-2026-13457. `autoUpdate` defaults to `true`. |
| `ws3-fca` (nethgraves)                                                    | Repository issue #10, opened by a user and closed 2025-06-05, titled "Remove the backdoor.", reports automatic follows/shares of the author's content without consent. We did not find such behaviour in the login files at HEAD `4afe416a`.          |
| `fca-anodite` / `botws-fca` 1.0.0                                         | By design (per its README and `index.js`), routes every API call, including the `c_user`/`xs` session cookies, through a third-party server (`api.khotools.com`).                                                                                     |
| `@eryxenx/fca` 1.1.9, `@rxabdullah/xdi-fca` 1.8.3                         | Ship prebuilt native libraries named `messagix.dll` / `messagix.so` (~16–17 MB), loaded through `koffi` FFI. We did not inspect the binaries; native code in a session-handling package cannot be audited from the published source.                  |

---

## Project reports

### 1. mautrix/meta (`pkg/messagix`): **primary reference**

```text
Repository:           https://github.com/mautrix/meta
Status:               Actively maintained (Tulir Asokan / Beeper). Monthly releases (v0.2609.0, 2026-09-16).
Last meaningful update: 2026-09-27 (e012f9f8)
Language:             Go 1.26
Architecture:         messagix (protocol client) + connector (bridge logic) + msgconv. Clean
                      separation: dgw/ (transport), lightspeed/ (payload decoder),
                      table/ (typed procedure rows), socket/ (task builders),
                      httpclient/ (bootstrap + GraphQL), syncManager (cursors).
Authentication:       Browser cookies (facebook.com); optional Messenger Lite iOS/Android
                      password login (mobile API impersonation).
HTTP:                 imroc/req with TLS fingerprinting (utls); browser-like headers.
GraphQL:              Centralised doc table (graphql/docs.go); few operations used.
Realtime:             DGW binary stream gateway since 2026-07-14; MQTT before that.
MQTT:                 Removed from the main socket (still used for Instagram native paths).
Events:               Lightspeed table rows → typed Go structs → bridge events, in a defined order.
Message history:      FetchMessagesTask (LS label 228) with range tracking.
Attachments:          Full (blob/xma/sticker); uploads via ajax/mercury/upload.php.
Session persistence:  Cookies + dumped state (configs, sync cursors), max age 24 h.
Reconnect:            Single connection loop; exponential backoff 1 s → 5 min; immediate
                      reconnect after connections > 2 min; context cancellation.
Typing:               Yes (LS updateTypingIndicator).
Reactions:            Yes.
Thread management:    Yes (rename, image, members, admins, mute, delete).
TypeScript:           N/A.
Tests:                Very few (6 test files at HEAD, none for the Messenger realtime path).
Security concerns:    None found. Explicitly redacts login responses in logs.
License:              AGPL-3.0 (+ exceptions file).
Strengths:            Current, correct, well-factored, handles E2EE via whatsmeow,
                      explicit ordering and error taxonomy.
Weaknesses:           Protocol code has little test coverage; silent-stall bug reports
                      (#352); uses os.Exit in decoder error paths; AGPL.
Useful ideas:         Per-database cursors as the gap-filling primitive; single connection
                      loop with "reset backoff after long healthy connection"; typed rows
                      keyed by positional index with an `Unrecognized` bag; ordered
                      dispatch; distinct permanent vs transient disconnect events.
Things NOT to copy:   Code (license); TLS/browser fingerprint spoofing; Messenger Lite
                      password flows; os.Exit on malformed input.
```

### 2. anbuinfosec/fca-unofficial (the repo linked in the brief)

```text
Repository:           https://github.com/anbuinfosec/fca-unofficial  (npm @anbuinfosec/fca-unofficial 2.0.0)
Status:               Low activity: 5 commits total; last 2025-09-25; 6 stars.
Last meaningful update: 2025-09-25 (06d9d59e), two commits described as
                      "Implement code changes to enhance functionality and improve performance".
Language:             JavaScript (CommonJS) + hand-written index.d.ts.
Architecture:         Classic FCA core (index.js 62 KB, utils.js 60 KB, src/*.js one file per
                      API method) plus bolted-on lib/ "safety", "performance", "database",
                      "compatibility" managers (derived from nexus-fca; logs mention
                      "Nexus MQTT bridge").
Authentication:       appState cookies; email/password + TOTP via b-graph.facebook.com/auth/login,
                      impersonating the Facebook Android app (hard-coded app token
                      350685531728|…, randomised device and bandwidth headers).
HTTP:                 Mixed: request (deprecated), got, axios.
GraphQL:              Raw doc_ids scattered across ~80 src files.
Realtime:             MQTT edge-chat, Iris /t_ms sync (sync_api_version 11) + /ls_req tasks.
MQTT:                 mqtt@4 over a hand-built ws stream; ~20 topics.
Events:               Callback `(err, event)` with FCA event shapes.
Message history:      GraphQL (getThreadHistory) + deprecated mercury variant.
Attachments:          Yes (upload.facebook.com / ajax endpoints).
Session persistence:  appstate JSON written by several modules (CookieManager,
                      CookieRefresher with backups, SingleSessionGuard, DeviceManager).
Reconnect:            Multiple independent triggers: mqtt.js reconnectPeriod=1000, plus
                      'error', 'close' and 'disconnect' handlers each calling
                      scheduleAdaptiveReconnect, plus globalSafety._ensureMqttAlive, plus a
                      "synthetic keepalive with randomized cadence … to appear human".
Typing:               Yes (/thread_typing, /orca_typing_notifications).
Reactions:            Yes.
Thread management:    Extensive (also profile, posts, comments, follow, friend requests).
TypeScript:           Declarations only.
Tests:                None present (mocha configured, no test files).
Security concerns:    - Writes fca-config.json into process.cwd() at import time.
                      - "enableAntiDetection", "bypassRegionLock", "enableHumanBehavior"
                        safety modes (detection evasion).
                      - getUID sends profile URLs to a third-party service, id.traodoisub.com.
                      - Imports child_process.execSync. autoUpdate:true is in the default
                        config, but no implementation or call site was found at this commit.
                      - Commits a Fca_Database/database.sqlite binary to the repo (not in
                        the npm "files" list).
                      - Heavy dependency tree including native sqlite3 and deprecated request.
License:              MIT.
Strengths:            Broad feature surface; shows what the FCA API shape looks like today.
Weaknesses:           Uncoordinated reconnect loops; global state (global.fca,
                      global.mqttClient); evasion features; no tests.
Useful ideas:         Health-metrics concept (ack latency, failure counts); FCA method list
                      for a future compat layer.
Things NOT to copy:   Everything in lib/safety (evasion), multiple reconnect triggers,
                      randomised keepalives, mobile-app impersonation login,
                      third-party lookups, import-time side effects.
```

### 3. Schmavery/facebook-chat-api (the original)

```text
Repository:           https://github.com/Schmavery/facebook-chat-api  (npm facebook-chat-api 1.8.0)
Status:               Archived. Last push 2021-12-24; npm last published 2020-04-03.
Language:             JavaScript. License: MIT. 1.9k stars.
Architecture/Auth:    Web form email/password login → cookie jar ("appState"); GraphQL batch;
                      MQTT /t_ms. The ancestor of every FCA fork.
Status of techniques: OBSOLETE (login flow), HISTORICAL (endpoints).
Useful ideas:         The public API vocabulary (listen, sendMessage, getThreadInfo…) for a
                      future compat layer.
Things NOT to copy:   Architecture (global ctx, callbacks, no lifecycle).
```

### 4. fca-unofficial/fca-unofficial (org fork; the npm `fca-unofficial` package)

```text
Status:               Archived fork of Schmavery. Last push 2022-10-27. npm fca-unofficial
                      latest 1.3.10, modified 2022-09-19, maintainer badaimweeb.
Notes:                The name everyone forks from; itself unmaintained. Uses deprecated
                      `request` and `websocket-stream`.
```

### 5. VangBanLaNhat/fca-unofficial (`@vangbanlanhat/fca-unofficial`)

```text
Status:               Maintained fork. Last commit 2026-08-18; 48 stars; 21 test files.
Language:             JavaScript. License: MIT.
Realtime:             MQTT edge-chat + /t_ms (sync_api_version 11), aid 219994525426954.
Notable history:      Added an E2EE "native bridge" (2026-03/04), then removed it
                      ("FIX(e2ee): remove e2ee support", 2026-05-06).
                      2026-07-12: "add browser telemetry emulation" (sends fake ScreenTime/
                      Badge telemetry queries "to mimic real browser").
                      2026-08-18: checkpoint detection; scheduled fb_dtsg refresh.
Security concerns:    Telemetry emulation is detection evasion. No exfiltration found in
                      the files inspected (listenMqtt.js, e2ee removal diff).
Useful ideas:         Confirms fb_dtsg needs periodic refresh; checkpoint detection exists as
                      a distinct failure.
Things NOT to copy:   Telemetry emulation; FCA architecture.
```

### 6. XaviaTeam/fca-unofficial (`@xaviabot/fca-unofficial`)

```text
Status:               Last push 2025-02-18; npm 1.4.0 (2024-03-20). Fork of the org fork. 7 test files.
Notes:                Not inspected in depth. Stale relative to 2026 protocol changes.
```

### 7. dongp06/fca-unofficial (`@dongdev/fca-unofficial`)

```text
Repository:           https://github.com/dongp06/fca-unofficial. Archived 2026-04-11
                      (npm 4.0.3 still installable, ~2.1k downloads/month).
Language:             TypeScript. License: Apache-2.0.
Architecture:         The most "modern-looking" FCA: src/domains/{messages,threads,users},
                      src/transport/{http,realtime}, session/, compat/. Still FCA semantics
                      underneath (edge-chat MQTT, /t_ms, sync_api_version 11).
Tests:                1 test file.
Security concerns:    High. The default password-login helper sends email, password and TOTP
                      secret to https://minhdong.site/api/v1/facebook/login_ios
                      (auth-helpers.ts; configurable via apiServer), the host named in OSV
                      record MAL-2026-13457. autoUpdate: true by default. Opt-in
                      remote-control WebSocket (src/remote/remoteClient.ts).
Useful ideas:         Shows that a domain/transport split is feasible on top of FCA.
Things NOT to copy:   Anything involving apiServer, remote control or auto-update.
```

### 8. ws3-fca (NethWs3Dev → nethgraves)

```text
Status:               Last push 2026-04-16; npm 3.5.2 (2025-08-31, ~3.6k downloads/month). 0 tests.
Security history:     Issue #10 "Remove the backdoor." (closed 2025-06-05): auto follow/share
                      of the author's content without consent. Current tree still contains
                      src/deltas/apis/posting/follow.js (an API method; no auto-invocation
                      found in login files at HEAD).
Other:                Depends on express, freeport, node-cron (server components in a client
                      library).
```

### 9. fca-priyansh (and similar high-download personal forks)

```text
Status:               npm 23.0.0 (2026-08-02), ~8.9k downloads/month, source on GitLab.
Inspected:            npm metadata only.
Red flags:            Depends on npm packages named `os`, `path`, `assert`, `readline`
                      (placeholder/squat names for Node built-ins), plus express, deasync
                      (native), request (deprecated), unique-random-useragent.
Verdict:              Not audited further; excluded as a reference.
```

### 10. E2EE-claiming FCA forks with native binaries (`@eryxenx/fca`, `@rxabdullah/xdi-fca`; similar descriptions: `hridoy-fca`, `toru-ultimate`)

```text
Status:               Active (Aug–Sep 2026); @eryxenx/fca ~5k downloads/month.
How E2EE "works":     Bundles prebuilt messagix.dll / messagix.so (~16–17 MB) and calls
                      them via koffi FFI (verified for the first two; the others share a
                      README tagline and were not inspected).
Security concerns:    Native code that cannot be audited from the published source, running
                      with full access to cookies and E2EE keys. We did not inspect the
                      binaries.
Useful ideas:         Confirms demand; also that a Go sidecar (see ntkhang03 PR #23,
                      "Messagix transport adapter (Node ↔ Go sidecar)") is how many JS
                      projects cope with E2EE.
```

### 11. HerokeyVN/FB-Messenger-E2EE (`fb-messenger-e2ee`)

```text
Repository:           https://github.com/HerokeyVN/FB-Messenger-E2EE
Status:               Active; last commit 2026-09-24; npm 0.1.8.
Language:             TypeScript (Bun-first, Node-compatible). License: AGPL-3.0.
Architecture:         Layered: core facade → controllers → actions → services → e2ee/
                      {application, signal, store, transport (noise, wa-binary, dgw), message
                      (protobuf builders/codecs), media}.
Authentication:       Delegates appState login and CAT bootstrap to fca-unofficial.
Realtime:             Noise-over-WebSocket E2EE socket; optional DGW helpers (frame constants
                      match messagix: ping 0x09, pong 0x0a, ack 0x0c, data 0x0d, open 0x0f).
E2EE:                 Signal via @signalapp/libsignal-client (official, native, AGPL); prekey
                      maintenance; SKDM/sender keys; retry receipts; encrypted media.
Session persistence:  JSON DeviceStore holding long-lived private keys, plus a session JSON.
Tests:                Jest integration tests + manual scripts.
Security concerns:    None found in inspected files; depends on an FCA fork for bootstrap.
                      Device store = plaintext private keys on disk (documented).
Strengths:            The only transparent TS E2EE implementation. Good event identity model
                      (threadId vs chatJid vs senderJid vs deviceId).
Useful ideas:         E2EE event identity model; device-store field inventory; retry receipt
                      flow; prekey maintenance thresholds.
Things NOT to copy:   Code (AGPL); FCA dependency for bootstrap.
```

### 12. messagix-js

```text
Status:               npm 0.1.0 only (2026-01-19), maintainer "monokaijs", no repository
                      link, AGPL-3.0, bundled dist only.
Realtime:             "MQTT WebSocket (Lightspeed protocol)", pre-DGW, likely stale.
Security concerns:    Asks users for their 6-digit E2EE secure-storage PIN; source not
                      published. Unverifiable.
```

### 13. fbchat-muqit (Python)

```text
Repository:           https://github.com/togashigreat/fbchat-muqit. Last commit 2026-04-30;
                      82 stars; GPL-3.0; 3 test files.
Architecture:         asyncio; storage abstraction (JSON/Redis); event dispatcher.
Realtime:             MQTT edge-chat with /t_ms Iris sync (sync_api_version 10) + /ls_req for
                      sending; ALSO wss://gateway.facebook.com/ws/realtime (independent DGW
                      corroboration).
Useful ideas:         Pluggable storage interface; async-first design.
```

### 14. fbchat (Python, fbchat-dev)

```text
Status:               Last push 2024-02-16; unmaintained since ~2020. BSD-3. HISTORICAL.
Useful ideas:         Well-typed model classes (historical reference for domain modelling).
```

---

## What this means for us

1. **Protocol facts come from `messagix`**, corroborated where possible by `fme`/`muqit`,
   and are re-verified live by the account owner before being marked stable.
2. **No FCA fork is a safe dependency or code source.** Use FCA only as a _vocabulary_
   reference for an optional compatibility layer.
3. **Password login is excluded.** In this ecosystem it is the main vector for credential
   theft.
4. **E2EE is a separate, opt-in package**, because it needs native crypto
   (libsignal) or a large audited-primitive implementation, long-lived key storage, and
   device registration on the user's account.
5. **Tests and fixtures are a differentiator.** Even the reference implementation has
   almost none for the realtime path.
