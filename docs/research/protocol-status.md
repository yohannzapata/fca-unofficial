# Messenger protocol status

**Research date:** 2026-09-30
**Status of this document:** research record, not a promise of support. It is the
specification that `src/protocol/**` is implemented against. Any protocol constant
used in code must trace back to an entry here.

## How to read this document

Every claim carries one of these labels:

| Label                     | Meaning                                                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VERIFIED-IMPL**         | Implemented in an actively maintained open-source client, at a pinned commit updated within the last ~30 days. We read the code; we did **not** observe it against live Messenger. |
| **VERIFIED-IMPL×2**       | As above, and independently corroborated by a second unrelated implementation.                                                                                                     |
| **VERIFIED-LOCAL**        | Tested on the development machine (only applies to runtime/tooling facts).                                                                                                         |
| **VERIFIED-DOC**          | Stated in Meta's own documentation or announcements, or in reputable press reporting of them.                                                                                      |
| **STRONGLY INFERRED**     | Consistent evidence from several sources, but no direct confirmation.                                                                                                              |
| **UNKNOWN**               | No reliable evidence. Must be investigated with a live, user-owned session before being depended on.                                                                               |
| **OBSOLETE / HISTORICAL** | Was true at some point; known or very likely no longer true for the current web client.                                                                                            |

**Nothing in this document is labelled "verified live".** No real account was used
during research. The first live verification has to be done by the account owner, using
the read-only probe (`tools/probe.ts`).

### Pinned sources

| Short name      | Repository / source                              | Commit / date                                     | License    |
| --------------- | ------------------------------------------------ | ------------------------------------------------- | ---------- |
| `messagix`      | `mautrix/meta` → `pkg/messagix`, `pkg/connector` | `e012f9f83ee0` (2026-09-27)                       | AGPL-3.0   |
| `messagix-mqtt` | same, last commit before MQTT removal            | `b10ff8e97134` (parent of `598da1d4`, 2026-07-14) | AGPL-3.0   |
| `fme`           | `HerokeyVN/FB-Messenger-E2EE`                    | `446b6af5d734` (2026-09-24)                       | AGPL-3.0   |
| `muqit`         | `togashigreat/fbchat-muqit`                      | `db9cbd77674b` (2026-04-30)                       | GPL-3.0    |
| `vblnt`         | `VangBanLaNhat/fca-unofficial`                   | `a8789a9fa021` (2026-08-18)                       | MIT        |
| `anbu`          | `anbuinfosec/fca-unofficial`                     | `06d9d59e6aba` (2025-09-25)                       | MIT        |
| `dongdev`       | `dongp06/fca-unofficial` (archived)              | `4f741c643bd3` (2026-04-11)                       | Apache-2.0 |

> **Clean-room note.** `messagix`, `fme` and `muqit` are copyleft. This project only takes
> _facts_ from them: endpoint URLs, frame byte layouts, field names, enum values and
> sequencing. It never translates their code. Where this document gives a byte layout,
> the description is ours. See `architecture-options.md` §5 for the licensing decision.

---

## 0. Headline findings

1. **The only web surface left is `https://www.facebook.com/messages`.**
   messenger.com shut down on 2026-04-15 and redirects there. The Messenger desktop apps
   were discontinued on 2025-12-15. **VERIFIED-DOC** (TechCrunch 2026-02-19; TechCrunch
   2025-10-16; others)
2. **The realtime transport changed in July 2026.** The most authoritative maintained
   client (`messagix`) moved its main socket from MQTT-over-WebSocket
   (`edge-chat.facebook.com`) to **DGW**, a binary multiplexed stream protocol at
   `wss://gateway.facebook.com/ws/lightspeed` (commit `598da1d4`, 2026-07-14).
   **VERIFIED-IMPL.** fbchat-muqit independently uses another DGW endpoint
   (`wss://gateway.facebook.com/ws/realtime`), which corroborates the gateway's existence
   (**VERIFIED-IMPL×2** for the host, _not_ for the lightspeed path).
3. **Two message-sync protocols are in use by open-source clients:**
   - **Lightspeed (LS)**: the current web client's local-database sync protocol, used by
     `messagix`, first over MQTT and now over DGW. **VERIFIED-IMPL.**
   - **Legacy "Iris" delta sync** (`/messenger_sync_create_queue` → `/t_ms` deltas over
     MQTT): used by every FCA fork and fbchat-muqit. The forks were still being updated
     in Aug–Sep 2026, so the endpoint **probably still answers**
     (**STRONGLY INFERRED**). `messagix` never used it. It is the older protocol, and we
     treat it as **HISTORICAL but possibly operational**.
4. **End-to-end encryption is the dominant limitation.** Meta has been making personal
   (1:1) chats E2EE by default since December 2023 (**VERIFIED-DOC**). The content of
   E2EE threads is **not** carried by Lightspeed or `/t_ms`. It arrives over a separate
   WhatsApp-derived protocol: Noise handshake, WA-binary stanzas, the Signal protocol and
   Meta protobufs, at `wss://web-chat-e2ee.facebook.com/ws/chat`. Using it requires
   registering a new E2EE device on the account. **VERIFIED-IMPL×2** (`messagix` via
   whatsmeow, `fme`).
   Group chats _can_ be E2EE (thread type `ENCRYPTED_OVER_WA_GROUP` exists). Whether they
   are E2EE by default is **UNKNOWN**; press reports say opt-in.
5. **E2EE message history before the client's device registration is not obtainable.**
   It lives in Meta's PIN-protected "secure storage" backup. No inspected open-source
   client reads it (`messagix` ROADMAP: "Reading chat backup" unchecked). **VERIFIED-IMPL.**
6. **Authentication in practice means browser cookies.** Every reputable client imports
   the `c_user`, `xs` and `datr` cookies (plus `sb` and `fr`) from a normal browser login.
   Password logins in the ecosystem impersonate Meta's mobile apps, and **several npm
   packages send passwords to third-party servers** (see `existing-projects.md`).
   **VERIFIED-IMPL.**
7. **There is no official API for personal inboxes.** The Messenger Platform serves
   Facebook Pages and Instagram professional accounts only (**VERIFIED-DOC**). Meta's
   Terms §3.2(3): "You may not access or collect data from our Products using automated
   means" without prior permission (Terms last revised 2025-01-01, **VERIFIED-DOC**).

---

## 1. Session material and authentication

| Item                                                                                                                                                          | Status                       | Evidence / notes                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required cookies: `c_user` (user ID), `xs` (main session), `datr`                                                                                             | VERIFIED-IMPL                | `messagix` `cookies/cookies.go` (`FBRequiredCookies`)                                                                                                                               |
| Recommended extra cookies: `sb`, `fr`                                                                                                                         | VERIFIED-IMPL / DOC          | docs.mau.fi authentication guide lists `datr, c_user, sb, xs`                                                                                                                       |
| "Logged in" heuristic: `xs` present                                                                                                                           | VERIFIED-IMPL                | `messagix` `Cookies.IsLoggedIn` (a cheap check only, not validation)                                                                                                                |
| Real validation: loading `/messages` yields `CurrentUserInitialData.ACCOUNT_ID != "0"`                                                                        | VERIFIED-IMPL                | `messagix` `client.go` (`IsAuthenticated`), `ErrUserIDIsZero`                                                                                                                       |
| Cookie updates via `Set-Cookie`; deleted when `Max-Age<0` or expired                                                                                          | VERIFIED-IMPL                | `messagix` `Cookies.UpdateFromResponse`                                                                                                                                             |
| Distinct failure classes: token invalidated / redirect-to-login, checkpoint required, consent required, challenge required, account suspended, 429 rate limit | VERIFIED-IMPL                | `messagix` `httpclient/http.go` error set                                                                                                                                           |
| GraphQL error code `1357004` means "please reload page" (stale page tokens)                                                                                   | VERIFIED-IMPL                | `messagix` `types/error.go`                                                                                                                                                         |
| Page-derived tokens (`fb_dtsg`, `lsd`, …) lifetime                                                                                                            | **UNKNOWN**                  | `messagix` refuses cached state older than **24 h** (`MaxCachedStateAge`); `vblnt` refreshes `fb_dtsg` daily. Treat as ≤ 24 h, and refresh by reloading the page.                   |
| `xs` cookie lifetime / rotation                                                                                                                               | **UNKNOWN**                  | Must be observed. Design for rotation via `Set-Cookie`.                                                                                                                             |
| DGW close code **4003** = unauthorized, treated as permanent                                                                                                  | VERIFIED-IMPL                | `messagix` `dgw/frames.go`, `client.go` connection loop. Caveat: mautrix issue #346 reports a _single_ 4003 on Instagram was a false logout. Confirm before invalidating a session. |
| Account risk: "We suspect automated behaviour on your account" warnings                                                                                       | VERIFIED-IMPL (user reports) | mautrix/meta issue #44 (open, updated 2026-08-26)                                                                                                                                   |

**Not supported by design:** email/password login, mobile-app impersonation
(`b-graph.facebook.com/auth/login` with an embedded app token), TOTP secret handling,
captcha or checkpoint automation. These exist in the ecosystem; see
`existing-projects.md` for why we exclude them.

---

## 2. HTTP bootstrap (facebook.com)

| Item                                                                                                                                                                                                                                                                                                                                                                  | Status                               | Evidence                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap = `GET https://www.facebook.com/messages` with browser-like navigation headers                                                                                                                                                                                                                                                                              | VERIFIED-IMPL                        | `messagix` `LoadMessagesPage`, `httpclient/http.go`                                                                                                                       |
| `sec-fetch-site: none` is needed for the page to include `__csr` bitmap data                                                                                                                                                                                                                                                                                          | VERIFIED-IMPL (comment in code)      | `messagix` `httpclient/http.go`                                                                                                                                           |
| Config is extracted from inline `<script>` JSON: `ScheduledServerJS` / `requireLazy` / `__bbox` / `define` module tuples                                                                                                                                                                                                                                              | VERIFIED-IMPL                        | `messagix` `httpclient/js_module_parser.go`, `modules.go`                                                                                                                 |
| Config modules used: `SiteData`, `LSD` (token), `DTSGInitData`/`DTSGInitialData` (fb_dtsg), `CurrentUserInitialData`, `MessengerWebInitData` (appId, CryptoAuthToken), `DGWWebConfig` (appId), `MqttWebDeviceID` (clientID), `LSPlatformMessengerSyncParams` (mailbox/contact/e2ee sync params), `CometPlatformRootClient` / SSJS `LSVersion` (LS schema `versionId`) | VERIFIED-IMPL                        | `messagix` `types/configs.go`, `httpclient/configs.go`, `httpclient/modules.go`                                                                                           |
| The page embeds a prefetched initial LS sync (`RelayPrefetchedStreamCache` → `LSPlatformGraphQLLightspeedRequestQuery`)                                                                                                                                                                                                                                               | VERIFIED-IMPL                        | `messagix` `httpclient/modules.go`                                                                                                                                        |
| GraphQL endpoint `POST https://www.facebook.com/api/graphql/`, `application/x-www-form-urlencoded`                                                                                                                                                                                                                                                                    | VERIFIED-IMPL×2                      | `messagix`, all FCA forks                                                                                                                                                 |
| Required form fields: `fb_dtsg`, `lsd`, `doc_id`, `variables`; commonly sent: `av`, `__user`, `__a=1`, `__req`, `__hs`, `dpr`, `__ccg`, `__rev`, `__s`, `__hsi`, `__dyn`, `__csr`, `__comet_req`, `jazoest`, `__spin_r/b/t`, `fb_api_caller_class=RelayModern`, `fb_api_req_friendly_name`, `server_timestamps=true`                                                  | VERIFIED-IMPL                        | `messagix` `httpclient/http.go` (`HTTPQuery`), with its own annotations on which are required                                                                             |
| Headers: `x-fb-friendly-name`, `x-fb-lsd`, `x-asbd-id`, `origin`, `referer`, `sec-fetch-*`                                                                                                                                                                                                                                                                            | VERIFIED-IMPL                        | `messagix` `httpclient/graphql.go`, `http.go`                                                                                                                             |
| `doc_id` for `LSPlatformGraphQLLightspeedRequestQuery` = `9697184873702141`                                                                                                                                                                                                                                                                                           | VERIFIED-IMPL, **high volatility**   | `messagix` `graphql/docs.go`. Doc IDs rotate when Meta ships new client bundles. Must be configurable, never scattered.                                                   |
| `doc_id` for `MAWCatQuery` (E2EE crypto auth token) = `29559957360285299`                                                                                                                                                                                                                                                                                             | VERIFIED-IMPL, high volatility       | same                                                                                                                                                                      |
| Responses prefixed with `for (;;);`                                                                                                                                                                                                                                                                                                                                   | STRONGLY INFERRED (legacy endpoints) | FCA `utils.js` strips it; unknown for current `/api/graphql/` responses. Parser must tolerate both.                                                                       |
| User agent / client hints                                                                                                                                                                                                                                                                                                                                             | VERIFIED-IMPL                        | `messagix` uses a fixed desktop Chrome UA plus matching `sec-ch-ua*` headers. We will use a configurable, _consistent_ UA. No randomisation ("anti-detection") by design. |

---

## 3. Realtime transport A: DGW gateway (current)

### 3.1 Connection

| Item                                                                                                                                                                                                                                                    | Status                                                | Evidence                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| URL `wss://gateway.facebook.com/ws/lightspeed`                                                                                                                                                                                                          | VERIFIED-IMPL                                         | `messagix` `endpoints/facebook.go` (`dgw_lightspeed`)                                                                                    |
| Query parameters: `x-dgw-appid=<DGWWebConfig.appId>`, `x-dgw-appversion=0`, `x-dgw-authtype=1:0` (Facebook), `x-dgw-version=5`, `x-dgw-uuid=<user id>`, `x-dgw-tier=prod`, `x-dgw-loggingid=<random uuid>`, `x-dgw-deviceid=<MqttWebDeviceID.clientID>` | VERIFIED-IMPL                                         | `messagix` `dgw/socket.go` (`getConnURL`), `configs.go` (`updateSocketIDs`)                                                              |
| Handshake headers: `cookie`, `user-agent`, `origin: https://www.facebook.com`, `sec-fetch-dest: empty`, `sec-fetch-mode: websocket`, `sec-fetch-site: same-site`                                                                                        | VERIFIED-IMPL                                         | `messagix` `dgw/socket.go` (`getConnHeaders`)                                                                                            |
| Node ≥ 24 native `WebSocket` sends custom `cookie`/`origin`/`user-agent`/`sec-fetch-*` headers via the non-standard `headers` init option (undici 7.29.1)                                                                                               | **VERIFIED-LOCAL**                                    | Tested 2026-09-30 on Node 24.21.0. Not guaranteed on Node 22 (undici 6), so we target Node ≥ 24.                                         |
| All DGW traffic is binary WebSocket messages; one message may contain several concatenated frames                                                                                                                                                       | VERIFIED-IMPL                                         | `messagix` `dgw/socket.go` read loop                                                                                                     |
| Client sends `Ping` every 10 s; the connection is considered dead after 30 s without `Pong`/`Ping`                                                                                                                                                      | VERIFIED-IMPL (client policy, not server requirement) | `messagix` `PingInterval`, `PongTimeout`                                                                                                 |
| Server may send `Drain` (reasons: ELB, SLB, AppServerPush, GracePeriodExpired, Unknown, MaxConnectionAgeExceeded)                                                                                                                                       | VERIFIED-IMPL                                         | `messagix` `dgw/frames.go`. Semantics: the server intends to close soon, so the client should reconnect proactively (STRONGLY INFERRED). |
| Server may send `Deauth`                                                                                                                                                                                                                                | VERIFIED-IMPL                                         | Fatal only on HTTP-stream transport in `messagix`. Semantics on WebSocket: **UNKNOWN**.                                                  |
| WebSocket close codes: 4000 graceful, 4001 keepalive timeout, 4002 DGW server error, 4003 unauthorized, 4004 rejected, 4005 bad request                                                                                                                 | VERIFIED-IMPL                                         | `messagix` `dgw/frames.go`                                                                                                               |

### 3.2 Frame layouts (all integers little-endian)

`u24` = 3-byte little-endian length. `sid` = `u16` stream id.

| Type                      | Byte 0    | Layout after type byte                                      | Status                           |
| ------------------------- | --------- | ----------------------------------------------------------- | -------------------------------- |
| Empty                     | 2         | — (not parsed)                                              | VERIFIED-IMPL (enum only)        |
| Drain                     | 3         | `u24 len (=1)`, `u8 reason`                                 | VERIFIED-IMPL                    |
| Deauth                    | 4         | none                                                        | VERIFIED-IMPL                    |
| Deprecated estab/data/eod | 5 / 6 / 8 | not used                                                    | VERIFIED-IMPL (enum only)        |
| SmallAck                  | 7         | layout **UNKNOWN**, treated as unsupported                  | VERIFIED-IMPL (enum only)        |
| Ping                      | 9         | none                                                        | VERIFIED-IMPL×2 (`fme` `0x09`)   |
| Pong                      | 10        | none                                                        | VERIFIED-IMPL×2 (`fme` `0x0a`)   |
| Ack                       | 12        | `sid`, `u24 len (=2)`, `u16 ackId`                          | VERIFIED-IMPL×2 (`fme` `0x0c`)   |
| Data                      | 13        | `sid`, `u24 len (= 2 + payload)`, `u16 ackField`, `payload` | VERIFIED-IMPL×2 (`fme` `0x0d`)   |
| EndOfData                 | 14        | `sid` (no length)                                           | VERIFIED-IMPL                    |
| EstablishStream           | 15        | `sid`, `u24 len`, JSON parameters (`{}` when none)          | VERIFIED-IMPL×2 (`fme` `0x0f`)   |
| EndOfDataWithReason       | 16        | `sid`, `u24 len (=1)`, `u8 reason`                          | VERIFIED-IMPL (added 2026-09-23) |
| ExtendedData              | 17        | like Data plus one content-type byte after `ackField`       | VERIFIED-IMPL                    |

- `ackField`: the low 15 bits are the ack id. The top bit (bit 15, i.e. bit 7 of the
  second byte) is **requires-ack**. **VERIFIED-IMPL**
- EndOfData reasons: 0 Unknown, 1 UpstreamTermination, 2 ClientHasFinishedSending,
  3 StreamError, 4 AuthError, 5 ParsingError, 6 ClientPubackError, 7 UpstreamException,
  8 Draining, 9 EndpointRegistrationFailed. **VERIFIED-IMPL**
- Unknown frame types have no length prefix we can rely on. The current reference
  implementation **drops the remainder of that WebSocket message**, which can lose data.
  **VERIFIED-IMPL** (logged as "potential data loss"). We must count and surface this.

### 3.3 Stream semantics

| Behaviour                                                                                                                                                                                                                                      | Status                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Stream ids are client-allocated `u16`, incrementing from 0 per connection, and reset on reconnect                                                                                                                                              | VERIFIED-IMPL                 |
| **One-off request/response stream**: client sends `EstablishStream{sid, {}}` + `Data{sid, ackId 0, requiresAck}` → server acks establish → server `Ack{sid, 0}` → server `Data{sid, response}` → client `Ack` (if required) + `EndOfData{sid}` | VERIFIED-IMPL                 |
| **Persistent stream**: `EstablishStream` + initial `Data`; the server then pushes `Data` frames on that stream for the lifetime of the connection                                                                                              | VERIFIED-IMPL                 |
| Every inbound `Data` with requires-ack must be acked, including for unknown streams                                                                                                                                                            | VERIFIED-IMPL                 |
| Ack timeout 5 s, sync-response timeout 30 s                                                                                                                                                                                                    | VERIFIED-IMPL (client policy) |

### 3.4 Lightspeed-over-DGW envelope

Request (the `Data` payload, JSON):
`{"app_id": "<CurrentUserInitialData.APP_ID>", "payload": "<JSON string>", "request_id": <u16 counter, never 0>, "type": <int>}`

| `type` | Meaning                                       | Status        |
| ------ | --------------------------------------------- | ------------- |
| 1      | Database sync with `sync_params`              | VERIFIED-IMPL |
| 2      | Database sync with `last_applied_cursor`      | VERIFIED-IMPL |
| 3      | Task batch (mutations and fetches)            | VERIFIED-IMPL |
| 4      | Fire-and-forget (no ack or response expected) | VERIFIED-IMPL |

Response / push (JSON):
`{"request_id": <int>, "payload": "<JSON string: LightSpeedData>", "sp": ["<procedure names>"], "target": <int>}`

Database query (`payload` for types 1/2):
`{"database": <id>, "version": <LS versionId>, "epoch_id": <int>, "sync_params"?: "<string>", "last_applied_cursor"?: "<string|null>"}`

Task batch (`payload` for type 3):
`{"epoch_id": <int>, "tasks": [{"label": "<num>", "payload": "<JSON string>", "queue_name": "<string>", "task_id": <int>, "failure_count": null}], "version_id": "<LS versionId>", "data_trace_id"?: "<string>"}`

`epoch_id` = `(unixMillis << 22) | (sameMsCounter << 12) | 42`. **VERIFIED-IMPL** (the
constant 42 is as observed; its meaning is UNKNOWN).

### 3.5 Sync databases

| DB                                            | Use                                                                                           | Status                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1                                             | Mailbox: threads, messages and receipts. Recursively synced until the cursor stops advancing. | VERIFIED-IMPL                            |
| 2                                             | Contacts (sync params)                                                                        | VERIFIED-IMPL                            |
| 95                                            | Contacts channel (thread-list companion)                                                      | VERIFIED-IMPL                            |
| 104                                           | Synced on connect; purpose **UNKNOWN**                                                        | VERIFIED-IMPL (usage), UNKNOWN (meaning) |
| 5, 16, 26, 28, 89, 120, 140–145, 196–198, 202 | Known to exist; purposes largely **UNKNOWN**                                                  | VERIFIED-IMPL (list only)                |

- Minimal set synced on each (re)connect: **[1, 2, 95, 104]**. **VERIFIED-IMPL**
- Each database keeps a `last_applied_cursor`. On reconnect, sending the stored cursor
  makes the server deliver changes since that cursor. This **is** the gap-filling
  mechanism. **VERIFIED-IMPL** (mechanism); guarantees on how far back a cursor stays
  valid are **UNKNOWN**.
- Cursor and first-block metadata come from the `executeFirstBlockForSyncTransaction(V4)`
  procedure (`nextCursor`, `currentCursor`, `syncChannel`, `sendSyncParams`,
  `currentSeqId`). A `nextCursor` of `"dummy_cursor"` or an unchanged cursor ends the
  recursion. **VERIFIED-IMPL**
- `messagix` persists `{configs, cursors, packet counter}` and discards them after 24 h.
  **VERIFIED-IMPL**

### 3.6 Known reliability problem: the silent stall

mautrix/meta issue **#352** (closed 2026-09-18, several reporters): the connection
stays "CONNECTED", keepalives succeed, but **group-chat message events stop arriving**
with no error. DMs were unaffected. Restarting recovers only through backfill. An
upgrade appeared to mitigate it, but the root cause is not documented.
**VERIFIED-IMPL (user reports).**
**Design consequence:** keepalive health ≠ data health. We need periodic cursor-based
reconciliation (see `docs/architecture.md` §7).

---

## 4. Realtime transport B: legacy MQTT (edge-chat)

**Status: HISTORICAL for the reference implementation; STRONGLY INFERRED still
reachable** (the FCA forks were updated in Aug–Sep 2026). **Not planned for
implementation** unless DGW proves unusable. Recorded here for compatibility knowledge.

| Item                                                                                                                                                                                                                                                                                                 | Evidence                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wss://edge-chat.facebook.com/chat?sid=<rand>&cid=<uuid>[&region=…]`                                                                                                                                                                                                                                 | `vblnt`, `anbu`, `dongdev`, `muqit`                                                                                                                                                 |
| MQTT 3.1 (`MQIsdp`, level 3), client id `mqttwsclient`, clean session                                                                                                                                                                                                                                | `messagix-mqtt` `socket.go`; FCA forks                                                                                                                                              |
| Username is a JSON blob: `{u, s, chat_on, fg, d, ct:"websocket", aid:"219994525426954", mqtt_sid:"", cp:3, ecp:10, st:[], pm:[], dc:"", no_auto_fg:true, gas:null, pack:[]}`                                                                                                                         | FCA forks (identical across ≥3)                                                                                                                                                     |
| `messagix` subscribed **only** to `/ls_req`, `/ls_resp`, `/ls_app_settings`, `/ls_foreground_state`                                                                                                                                                                                                  | `messagix-mqtt` `topics.go`                                                                                                                                                         |
| FCA subscribes to about 20 topics including `/t_ms`, `/thread_typing`, `/orca_typing_notifications`, `/orca_presence`, `/legacy_web`, `/messaging_events`…                                                                                                                                           | `anbu`, `vblnt` `listenMqtt.js`                                                                                                                                                     |
| Iris sync: publish `/messenger_sync_create_queue` `{sync_api_version: 10 or 11, max_deltas_able_to_process, delta_batch_size: 500, encoding: "JSON", entity_fbid, initial_titan_sequence_id, device_params: null}`, or `/messenger_sync_get_diffs` with `last_seq_id` and `sync_token` when resuming | FCA forks, `muqit`                                                                                                                                                                  |
| Initial sequence id from a GraphQL(batch) thread-list query with `includeSeqID`                                                                                                                                                                                                                      | FCA `getSeqID`                                                                                                                                                                      |
| `/t_ms` deltas (`NewMessage`, `ClientPayload{deltaMessageReaction, deltaRecallMessageData, deltaMessageReply}`, `ReadReceipt`, `AdminTextMessage`, …)                                                                                                                                                | FCA `parseDelta`                                                                                                                                                                    |
| Queue errors (`ERROR_QUEUE_OVERFLOW`, `ERROR_QUEUE_NOT_FOUND`) force re-creating the queue                                                                                                                                                                                                           | FCA forks (**STRONGLY INFERRED** current)                                                                                                                                           |
| Iris deltas carry E2EE thread content                                                                                                                                                                                                                                                                | **Believed false.** No FCA fork receives E2EE content without a separate E2EE stack (`vblnt` added, then removed, a native E2EE bridge in 2026; `fme` exists for exactly this gap). |

---

## 5. Lightspeed payload format

| Item                                                                                                                                                                                                                                     | Status                                                                                         | Evidence                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `payload` decodes to `{"name": string, "step": nested arrays}`                                                                                                                                                                           | VERIFIED-IMPL                                                                                  | `messagix` `lightspeed/lightspeed.go`                                                                                          |
| A step is `[opcode, ...operands]`; 125 opcodes enumerated (1 = BLOCK … 126 = QUERY_GROUP_BY)                                                                                                                                             | VERIFIED-IMPL                                                                                  | same                                                                                                                           |
| Opcodes needed to extract data: `1` BLOCK, `2` LOAD, `3` STORE, `4` STORE_ARRAY, `5` CALL_STORED_PROCEDURE `[5, "procName", ...args]`, `9` UNDEFINED, `19` I64_FROM_STRING `[19, "123"]`, `23` IF, `26` NOT, `27` IS_NULL …              | VERIFIED-IMPL                                                                                  | `messagix` `lightspeed/decode.go` implements only a subset and ignores the rest                                                |
| Procedure names on the wire are lowerCamel (`insertMessage`, `upsertReaction`, …). `sp` lists the procedure names a payload uses.                                                                                                        | VERIFIED-IMPL                                                                                  | `messagix` `table/table.go` (`SPTable`)                                                                                        |
| Arguments are **positional**. Each procedure has a fixed index → field mapping (e.g. `insertMessage`: 0 text, 3 threadKey, 5 timestampMs, 8 messageId, 9 offlineThreadingId, 10 senderId, 17 isUnsent, 23 replySourceId, 68 editCount …) | VERIFIED-IMPL, **medium volatility**                                                           | `messagix` `table/messages.go`. Index maps change when Meta changes schemas. Unknown indices must be preserved, never guessed. |
| 64-bit ids appear as `[19, "<decimal>"]` and must stay strings or `bigint` in JS (> 2^53)                                                                                                                                                | VERIFIED-IMPL (encoding); STRONGLY INFERRED (magnitudes exceed 2^53 for thread keys and FBIDs) | FBIDs routinely exceed 2^53                                                                                                    |

---

## 6. Event availability (Lightspeed)

This decides which public events the library can honestly promise.

| Public concept                | LS procedure(s)                                                                                                                                  | Status                 | Notes                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| New message                   | `insertMessage`, `upsertMessage` (plus attachment procedures in the same batch)                                                                  | VERIFIED-IMPL          | `upsert` is also used for history pages                                                                         |
| Message edit                  | `editMessage {messageId, authorityLevel, text, editCount}`, `updateOrInsertEditMessageHistory`                                                   | VERIFIED-IMPL          | **Carries no thread key**; it must be resolved from a message→thread index                                      |
| Message unsend (for everyone) | `deleteThenInsertMessage` with `isUnsent=true`; `deleteMessage {threadKey, messageId}`                                                           | VERIFIED-IMPL          | Whether `deleteMessage` also covers "deleted for me on another device" is **UNKNOWN**. Expose `reason: "unsent" | "removed"`. |
| Reaction add / update         | `upsertReaction {threadKey, timestampMs, messageId, actorId, reaction, authorityLevel}`; V2: `updateOrInsertReactionV2` (aggregated counts)      | VERIFIED-IMPL          |                                                                                                                 |
| Reaction remove               | `deleteReaction`; V2 `deleteReactionV2`                                                                                                          | VERIFIED-IMPL          |                                                                                                                 |
| Typing                        | `updateTypingIndicator {threadKey, senderId, isTyping}`                                                                                          | VERIFIED-IMPL          | Web client re-sends about every 3 s while typing; clients time out after about 5 s                              |
| Read receipt (others)         | `updateReadReceipt`                                                                                                                              | VERIFIED-IMPL          |                                                                                                                 |
| Own read state                | `markThreadReadV2`                                                                                                                               | VERIFIED-IMPL          |                                                                                                                 |
| Thread created / updated      | `deleteThenInsertThread`, `updateOrInsertThread`, `syncUpdateThreadName`, `setThreadImageURL`, `updateThreadMuteSetting`, `updateThreadSnippet*` | VERIFIED-IMPL          |                                                                                                                 |
| Participants                  | `addParticipantIdToGroupThread`, `removeParticipantFromThread`, `updateThreadParticipantAdminStatus`                                             | VERIFIED-IMPL          |                                                                                                                 |
| Thread deleted                | `deleteThread`, `deletePartialThread` (deleted for the current user)                                                                             | VERIFIED-IMPL          |                                                                                                                 |
| Thread became E2EE            | `moveThreadToE2EECutoverFolder`                                                                                                                  | VERIFIED-IMPL          | Signals that content moves to the E2EE channel                                                                  |
| Presence                      | `deleteThenInsertContactPresence` exists; `messagix` does not implement presence                                                                 | **UNKNOWN**            | Not promised                                                                                                    |
| Delivery receipts             | `updateDeliveryReceipt`                                                                                                                          | VERIFIED-IMPL (exists) | Semantics unverified                                                                                            |
| Message requests              | `deleteThenInsertMessageRequest` (`messageRequestStatus`), folder `pending`/`spam`                                                               | VERIFIED-IMPL          |                                                                                                                 |

**Dispatch ordering inside one LS batch** (as practised by `messagix` `handlemeta.go`):
thread deletions → thread upserts → participant and folder changes → message
upserts/inserts → edits → name/image → receipts → typing → deletes/unsends → reactions →
participant removals. **VERIFIED-IMPL.** Order matters, because an edit or reaction may
reference a message inserted earlier in the same batch.

### Thread types

`1` ONE_TO_ONE, `2` GROUP_THREAD, `15` ENCRYPTED_OVER_WA_ONE_TO_ONE,
`16` ENCRYPTED_OVER_WA_GROUP, plus about 30 others (community, marketplace, …).
**VERIFIED-IMPL** (`messagix` `table/enums.go`). Types 15 and 16 are the E2EE threads
whose content is not in Lightspeed.

---

## 7. History, threads, users

| Operation                                                                                                            | Mechanism                                                                                                                                                                                                                                                | Status                          |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Thread list page                                                                                                     | LS task label **145** `FetchThreadsTask`, queue `trq`, `{is_after, parent_thread_key (-1 = inbox), reference_thread_key, reference_activity_timestamp (9999999999999 = newest), additional_pages_to_fetch, cursor, messaging_tag, sync_group (1 or 95)}` | VERIFIED-IMPL                   |
| Pagination state                                                                                                     | `upsertSyncGroupThreadsRange` / `updateThreadsRangesV2` → `{hasMoreBefore, minThreadKey, minLastActivityTimestampMs, parentThreadKey}`                                                                                                                   | VERIFIED-IMPL                   |
| Message history page                                                                                                 | LS task label **228** `FetchMessagesTask`, queue `mrq.<threadKey>`, `{thread_key, direction: 0, reference_timestamp_ms, reference_message_id, sync_group: 1, cursor}`                                                                                    | VERIFIED-IMPL                   |
| History range state                                                                                                  | `insertNewMessageRange`, `updateExistingMessageRange` (`hasMoreBefore`, min timestamp/id)                                                                                                                                                                | VERIFIED-IMPL                   |
| E2EE thread history                                                                                                  | Not available (see §0.5)                                                                                                                                                                                                                                 | VERIFIED-IMPL (absence)         |
| Contacts / user profile                                                                                              | Contact tables (`deleteThenInsertContact`, `verifyContactRowExists`) arrive with DB 2/95 and thread syncs; LS task **207** `GetContactsFullTask {contact_id}`                                                                                            | VERIFIED-IMPL                   |
| Search users                                                                                                         | LS tasks **30**/**31**                                                                                                                                                                                                                                   | VERIFIED-IMPL (not planned yet) |
| Legacy GraphQL/`/ajax/mercury/*` history and thread info (FCA `getThreadHistory`, `getThreadInfo`, `*Deprecated.js`) | **UNKNOWN / HISTORICAL**. FCA forks still ship them, with doc_ids of unknown age. Not used.                                                                                                                                                              |                                 |

---

## 8. Attachments

| Item                                                                                                                                                                                                                                                              | Status                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Attachment metadata arrives in the same LS batch as the message: `insertBlobAttachment` (images, video, audio, files), `insertXmaAttachment` (shares/links/stories), `insertStickerAttachment`, `insertAttachment`, `insertAttachmentItem`, `insertAttachmentCta` | VERIFIED-IMPL                                                       |
| Media URLs are `*.fbcdn.net` signed URLs with explicit expiry fields (e.g. `playableUrlExpirationTimestampMs`)                                                                                                                                                    | VERIFIED-IMPL (fields); STRONGLY INFERRED (signed, time-limited)    |
| Whether downloads need cookies                                                                                                                                                                                                                                    | **UNKNOWN**. Signed URLs suggest not. Must be verified live.        |
| Upload endpoint `https://www.facebook.com/ajax/mercury/upload.php`                                                                                                                                                                                                | VERIFIED-IMPL (`messagix` `media_upload`). Needed only for sending. |
| E2EE media: encrypted blobs, keys inside the E2EE protobuf (WhatsApp-style media crypto)                                                                                                                                                                          | VERIFIED-IMPL×2 (`messagix` via whatsmeow, `fme` `media-crypto.ts`) |

---

## 9. End-to-end encrypted Messenger

| Item                                                                                                                                                                              | Status                                                                                                 | Evidence                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Default E2EE for personal (1:1) chats and calls, rollout since Dec 2023, "in process"                                                                                             | VERIFIED-DOC                                                                                           | about.fb.com 2023-12-06, 2024-03 explainer; Messenger Help Center                         |
| Group chats: E2EE groups exist (`ENCRYPTED_OVER_WA_GROUP`); default status                                                                                                        | VERIFIED-IMPL (existence); **UNKNOWN** (default)                                                       |                                                                                           |
| Socket `wss://web-chat-e2ee.facebook.com/ws/chat`, Noise handshake, WA-binary stanzas                                                                                             | VERIFIED-IMPL×2                                                                                        | `messagix` `endpoints/facebook.go` + whatsmeow `MessengerConfig`; `fme` `noise-socket.ts` |
| Client payload: `Product=MESSENGER`, `FbCat` = crypto auth token, `FbUserAgent`, `Username=<fbid>`, `Device=<wa device id>`, platform `BLUE_WEB`                                  | VERIFIED-IMPL                                                                                          | `messagix` `e2ee-client.go`                                                               |
| Crypto auth token (CAT) from page config `MessengerWebInitData.CryptoAuthToken`, refreshed via GraphQL `MAWCatQuery`; roughly 24 h lifetime                                       | VERIFIED-IMPL                                                                                          | `messagix` `refreshCAT`                                                                   |
| Device registration ("ICDC"): `POST https://reg-e2ee.facebook.com/v2/fb_icdc_fetch`, then `/v2/fb_register_v2` with the identity key, signed prekey and signed ICDC identity list | VERIFIED-IMPL×2                                                                                        | `messagix` `e2ee-register.go`; `fme` `icdc.service.ts`                                    |
| Message layers: Signal (`msg`, `pkmsg`, `skmsg` + SKDM) → `MessageTransport` → `MessageApplication` / `ConsumerApplication` / `ArmadilloApplication` protobufs                    | VERIFIED-IMPL×2                                                                                        | `fme` `src/e2ee/message/proto/*`; whatsmeow                                               |
| Registering adds a device to the user's account (long-lived keys must be persisted)                                                                                               | VERIFIED-IMPL                                                                                          | Both. Whether other participants see a "security code changed" notice is **UNKNOWN**.     |
| Reading secure-storage (PIN) backups                                                                                                                                              | **Not implemented anywhere inspected.** `messagix-js` asks for the PIN, but its source is unpublished. |                                                                                           |

**Implication for a personal monitor:** without E2EE support the library sees the
_existence, names and activity timestamps_ of E2EE 1:1 threads, but **not their
messages**. Whether the thread snippet exposes plaintext for E2EE threads is
**UNKNOWN**, and it is unlikely.

---

## 10. Network destinations (expected)

Planned for the core (non-E2EE) library:

| Host                   | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `www.facebook.com`     | Bootstrap page load, GraphQL                                    |
| `gateway.facebook.com` | DGW realtime WebSocket                                          |
| `*.fbcdn.net`          | Attachment downloads, only when the application explicitly asks |

Additionally, only if the optional E2EE package is added later: `web-chat-e2ee.facebook.com`,
`reg-e2ee.facebook.com`. Nothing else, with no telemetry.

---

## 11. Open questions to resolve with a live, user-owned session

Ordered by impact on the primary goal (reliable receiving):

1. Does `wss://gateway.facebook.com/ws/lightspeed` accept our handshake with only
   cookies and page-derived ids? (Expected yes, per `messagix`.)
2. Exact procedure batches for: new DM text, new group text, reply, edit, unsend,
   reaction add/remove, typing, attachments. Record sanitized fixtures.
3. How long does a `last_applied_cursor` remain valid across a disconnect (minutes?
   days?), and what does the server return when it is too old?
4. The lifetime of `fb_dtsg`/`lsd` and whether `xs` rotates.
5. What an E2EE 1:1 thread looks like in LS (snippet contents, last-activity updates).
   This tells us whether "activity-only" notifications are possible without E2EE.
6. Behaviour on `Drain` and `Deauth`, and how often the server rotates connections.
7. The silent-stall conditions (§3.6): does per-database re-sync fix them?
8. Do live new messages always arrive as `insertMessage`, or sometimes as `upsertMessage`
   outside history pages? Record both from a live trace before relying on the distinction
   (§15).

## 12. Obsolete / historical

| Item                                                         | Status                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| messenger.com web client                                     | OBSOLETE (shut down 2026-04-15)                                  |
| Messenger desktop apps                                       | OBSOLETE (discontinued 2025-12-15)                               |
| Web email/password form login (original `facebook-chat-api`) | OBSOLETE; also out of scope by policy                            |
| XMPP chat API                                                | OBSOLETE (2015)                                                  |
| `/ajax/mercury/*` endpoints, `graphqlbatch` thread history   | HISTORICAL. Still called by FCA forks; current behaviour UNKNOWN |
| MQTT `/ls_req` + `/ls_resp` as `messagix`'s transport        | HISTORICAL since 2026-07-14 (replaced by DGW)                    |
| Iris `/t_ms` delta sync                                      | HISTORICAL, possibly still operational (§4)                      |

## 13. Implementation notes: bootstrap (2026-09-30)

What `src/protocol/bootstrap/*` does, and what the first live probe
(`node tools/probe.ts --save`) must confirm:

| Decision                                                                                                                                                                                                  | Why                                                | Probe confirms it if…                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET https://www.facebook.com/messages` with navigation headers (`sec-fetch-site: none` on the first hop)                                                                                                 | §2                                                 | `outcome: "ok"` and `http.hops` is a single `200`                                                        |
| Redirects are followed only within `/messages*` on `www.facebook.com`. `/login*` → expired; `/checkpoint/`, `/challenge/`, `/auth_platform/`, consent, `/accounts/suspended/` → `CheckpointRequiredError` | §1 (messagix `checkHTTPRedirect`)                  | `hops[].kind` values match reality when a session really expires                                         |
| Config found by a **generic walk** of every JSON `<script>` for whitelisted `[name, deps[], config{}, id>0]` tuples, independent of the ScheduledServerJS/`__bbox` wrapper                                | Wrappers change more often than config shapes      | `page.modules` lists every module in `CONFIG_MODULES` except the optional `DTSGInitData`/`MqttWebConfig` |
| LS `versionId` read with a regex from the raw `requestPayload` text of the `adp_LSPlatformGraphQLLightspeedRequest*` preloader                                                                            | int64 may exceed 2^53; `JSON.parse` would round it | `config.lsVersionId` is non-null                                                                         |
| `USER_ID`/`ACCOUNT_ID` must equal `c_user`; `"USER_ID":"0"` → expired                                                                                                                                     | §1                                                 | `config.userMatchesSession: true`                                                                        |
| Numbers that cannot be represented exactly are reported in `lossyFields`, never rounded                                                                                                                   | Correctness                                        | `config.lossyFields` is empty                                                                            |
| **Not implemented:** the reference client's fallback of crawling static JS files for `LSVersion` when the page lacks it (that would contact `static.xx.fbcdn.net`)                                        | Keep network destinations minimal until needed     | If `lsVersionId` is null in the live probe, implement it with the realtime transport                     |
| **Not implemented:** `__dyn`/`__csr` bitmaps (define ids are collected for later)                                                                                                                         | messagix marks them "not required"                 | GraphQL requests succeed without them                                                                    |
| Default UA: Chrome 141 on Windows with matching low-entropy client hints; a custom UA is sent **without** client hints                                                                                    | Consistency, no invented fingerprints              | No checkpoint appears after probing                                                                      |

All bootstrap tests use **synthetic** pages (`tests/helpers/synthetic-page.ts`, clearly
labelled). They will be complemented, not replaced, by sanitized structure fixtures derived
from the probe report, which contains module names, config keys and ids, and never values.

## 14. Implementation notes: realtime transport and decoder (2026-10-01)

`src/transport/dgw/*` and `src/protocol/lightspeed/*`. Each row states where this
implementation follows the reference client (`messagix` @ `e012f9f8`) and where it
deliberately differs.

| Topic                    | Implementation                                                                                                                                                                                                                   | Relation to the reference                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frame codec              | Byte layouts of §3.2; several frames per WebSocket message; an unknown frame type stops decoding and the rest of the message is dropped and counted                                                                              | Same behaviour                                                                                                                                                         |
| Handshake                | Native `WebSocket` with `cookie`/`origin`/`user-agent`/`sec-fetch-*` headers (VERIFIED-LOCAL on Node 24)                                                                                                                         | Same headers. A failed handshake cannot be told apart from a network error (the native API exposes no HTTP status), so it is reported as a retryable `NetworkError`    |
| Keepalive                | Ping every 10 s; the connection is declared dead after 30 s **without any inbound message**                                                                                                                                      | The reference resets its timer only on ping/pong; we also accept any data as proof of liveness                                                                         |
| Timeouts                 | Establish and ack wait 5 s; a one-off response waits 10 s                                                                                                                                                                        | The reference waits 5 s for responses; 10 s is more tolerant of large sync responses                                                                                   |
| Establish response       | Success requires code 200, sent either as a bare number or as `{"code":200}`                                                                                                                                                     | Same                                                                                                                                                                   |
| Ack ids                  | Per stream, 0–0x7FFF, wrapping and skipping ids still pending; ack id 0 for one-off streams                                                                                                                                      | Same                                                                                                                                                                   |
| Acknowledging pushes     | A pushed frame is acked **after** its handler succeeds; on handler failure the frame is not acked and the connection closes (`handler_error`, retryable)                                                                         | Same                                                                                                                                                                   |
| Data for unknown streams | Acked anyway                                                                                                                                                                                                                     | Same                                                                                                                                                                   |
| Close code 4003          | `unauthorized`, non-retryable                                                                                                                                                                                                    | Same. Note the Instagram false-positive report in §1; revisit if live use shows spurious 4003s                                                                         |
| Other close codes        | `server_close`, retryable                                                                                                                                                                                                        | Same                                                                                                                                                                   |
| Drain / deauth           | Drain: reported via `onDrain`, connection kept open. Deauth: logged                                                                                                                                                              | Same (the reference treats deauth as fatal only on its HTTP-stream transport)                                                                                          |
| Decoder opcodes          | Evaluated: BLOCK, LOAD, STORE, CALL_STORED_PROCEDURE, UNDEFINED, TO_BLOB, I64_FROM_STRING, IF, I64_EQUAL, I64_ADD, CURRENT_TIME, LOG_*, array/map helpers. Every other opcode evaluates to `undefined` and is counted per opcode | Same subset, except as below                                                                                                                                           |
| `IF`                     | Runs a branch only when the condition is definitely true or false; otherwise skips both branches and counts it                                                                                                                   | The reference also skips non-integer conditions                                                                                                                        |
| `NOT`, `STORE_ARRAY`     | Not evaluated (counted)                                                                                                                                                                                                          | The reference returns `NOT`'s operand unchanged (flagged by its own TODO), and its `STORE_ARRAY` semantics are unclear. Live payloads will show whether either matters |
| 64-bit integers          | `[19,"…"]` → exact decimal text (`I64`); plain JSON numbers are accepted for i64 fields only when they are safe integers                                                                                                         | The reference rejects plain numbers for int64 fields                                                                                                                   |
| Procedure rows           | Only fields the library uses are mapped; extra arguments are counted (`unrecognizedArgs`) and wrong types recorded (`typeMismatches`), never coerced                                                                             | The reference keeps an `Unrecognized` map of values; we keep counts only, to avoid retaining message content                                                           |

What a first live trace must confirm: the establish response format, that sync responses
and pushes arrive on persistent streams as described in §3.4, and the absence of
unsupported opcodes in ordinary message payloads (or which ones appear).

## 15. Implementation notes: sync and event pipeline (2026-10-01)

`src/protocol/lightspeed/requests.ts`, `src/protocol/sync/*`, `src/protocol/realtime/*`
and `src/pipeline/*`. As in §14, each row states the relation to the reference client.

| Topic                         | Implementation                                                                                                                                                                                                 | Relation to the reference / evidence                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request encoding              | Database queries and task batches are written as JSON text with 64-bit fields (`epoch_id`, `version`) as raw digits, because the LS version exceeds 2^53                                                       | Same field set and order as §3.4. VERIFIED-IMPL (fields); the raw-digit encoding is required by the value range                                                                              |
| Initial per-database settings | DB 1: cursor query, mailbox channel. DB 2: sync params, contact channel. DB 95: cursor query, contact channel. DB 104: sync params, channel 0 (e2ee params)                                                    | Same as the reference's sync manager. VERIFIED-IMPL                                                                                                                                          |
| Cursor rule                   | A first-block row advances the cursor only when `nextCursor` is not empty, not `"dummy_cursor"`, and differs from both `currentCursor` and the stored cursor; then the database is queried again (≤ 100 pages) | Same rule; the page cap is ours (the reference recurses without a cap). VERIFIED-IMPL                                                                                                        |
| Streams                       | One persistent stream per database in `[1, 2, 95, 104]`; sync responses are matched by `request_id`, anything else on the stream is a live push                                                                | STRONGLY INFERRED from §3.4; to be confirmed by the first live trace                                                                                                                         |
| Required databases            | DB 1 failing fails the attempt (retryable); DBs 2, 95 and 104 failing is logged only. The server ending the DB 1 stream triggers a reconnect                                                                   | The reference also tolerates failures of the secondary databases. The DB 1 stream-end handling is ours                                                                                       |
| Thread-list task              | On the first connection of a client only, a read-only task batch (label `145`, queue `trq`) for sync groups 1 and 95, as the reference sends after connecting; its rows only seed state                        | VERIFIED-IMPL (payload). Not repeated on reconnects, where cursor catch-up covers the gap                                                                                                    |
| Cursor persistence            | Cursors are stored in the session (`sync`), debounced and atomic, and restored on the next run. They are not discarded after a fixed age                                                                       | The reference discards persisted cursors after 24 h (§3.5). Cursor lifetime is UNKNOWN (§11, question 3); what the server answers for a stale cursor will decide whether to add an age limit |
| Baseline suppression          | The first sync of a database without a stored cursor is `baseline`: its rows seed dedup and indexes but emit no events                                                                                         | Ours. A monitor must not report the whole inbox as new on first run                                                                                                                          |
| New vs. history               | Only `insertMessage` produces `message` events; `upsertMessage` (sent with `insertNewMessageRange` for history pages) only updates indexes                                                                     | STRONGLY INFERRED from the reference's handling. If live traces show new messages arriving as `upsertMessage`, this rule changes (§11, question 8)                                           |
| Dispatch order                | Messages → edits → typing → unsends/removals → reactions within a batch                                                                                                                                        | The relevant subset of the order in §6. VERIFIED-IMPL                                                                                                                                        |
| Dedup                         | Bounded TTL+LRU keys `m:`, `e:<id>:<editCount>`, `d:`; reaction and typing state maps. Not persisted, so delivery is at-least-once across restarts                                                             | Ours                                                                                                                                                                                         |
| Typing stop                   | Inferred after 6 s without a refresh; typing rows are ignored outside live pushes                                                                                                                              | Based on §6 (re-sent about every 3 s, clients time out after about 5 s)                                                                                                                      |
| Reconciliation                | DB 1 is re-synced from its cursor every 5 minutes while connected; missed rows are emitted with `recovered: true`                                                                                              | Ours, as the defence against the silent stall (§3.6). Whether it actually cures the stall is UNKNOWN (§11, question 7)                                                                       |
| Handling of sync failures     | A missing or late response (30 s) fails that database's sync; for DB 1 the connection attempt fails and the supervisor retries with backoff                                                                    | The reference has a dedicated failure handler whose server-side semantics are UNKNOWN; we rely on reconnecting instead                                                                       |
