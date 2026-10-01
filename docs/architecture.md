# Architecture

**Status:** living design document, last updated 2026-09-30. Built on
`docs/research/*.md`; read `protocol-status.md` first. This document describes the target
system. Parts marked _(planned)_ are designed but not yet implemented.

## 1. Goals and non-goals

**The one feature that matters most:** a long-running client that reliably receives
messages, survives normal network interruptions, and never corrupts its session or emits
duplicate events.

Priorities, in order: correctness → reliability → maintainability → security →
performance → feature count.

**Non-goals:** bot framework, command system, mass messaging, password login,
security-control circumvention, "anti-detection", telemetry, built-in database or AI.

## 2. Shape of the system

```text
Application (e.g. the Windows personal monitor)
   │   typed events + async read API; no protocol knowledge
   ▼
MessengerClient ─────────────── façade: owns the lifecycle and wires everything
   ├── services/      messages, threads, users   (domain read API)
   ├── pipeline/      rows → domain events: order, normalize, dedup, reconcile
   ├── lifecycle/     ConnectionSupervisor: THE only reconnect loop
   └── protocol/      ProtocolClient: the only thing that knows Messenger
          ├── bootstrap/   load facebook.com/messages, extract config/tokens
          ├── graphql/     operation registry (doc_ids live here and nowhere else)
          ├── lightspeed/  payload decoder + procedure schemas (positional → typed rows)
          ├── sync/        per-database cursors, recursive sync, reconciliation
          └── uses:
              transport/http   fetch + cookie jar + timeouts/retries/classification
              transport/dgw    DGW frames + stream multiplexing over WebSocket
   ▲
session/  Session model + SessionStore interface (+ FileSessionStore, codecs)
errors/ logging/ events/ util/   cross-cutting, dependency-free
```

**Rule of dependencies (enforced by lint and review):** arrows only point downward.
`services` and `pipeline` see _typed rows_ and domain types, never frames, JSON
envelopes or `doc_id`s. `transport/*` knows nothing about Messenger semantics beyond its
wire format. When Meta changes a payload, the change should be confined to
`protocol/lightspeed/procedures/*` or `protocol/graphql/operations/*`.

## 3. Package and directory layout

One npm package, `fca-unofficial` (named 2026-09-30; the npm name is taken by an abandoned 2022 package, so publishing would need a scope), ESM-only, Node ≥ 24, zero
runtime dependencies. Rationale is in `architecture-options.md` §4, §6 and §7. It becomes
an npm workspace when `e2ee` or `fca-compat` exists.

```text
src/
├── index.ts                    public exports (the only supported import path)
├── client/                     MessengerClient, options, health
├── model/                      PUBLIC domain types: Message, Thread, User, Attachment,
│                               events, feature status. Stable API surface.
├── errors/                     error hierarchy
├── logging/                    Logger interface, console logger, redaction
├── events/                     TypedEmitter (safe dispatch, leak warnings)
├── lifecycle/                  state machine, backoff, ConnectionSupervisor
├── session/                    Session model/validation/import, SessionStore,
│                               MemorySessionStore, FileSessionStore, codecs
├── transport/
│   ├── http/                   HttpClient, CookieJar, retry policy
│   └── dgw/                    frame codec, DgwConnection, streams
├── protocol/                   bootstrap, lightspeed decoder; (planned) graphql, sync,
│                               ProtocolClient
├── pipeline/                   (planned) normalizers, ordering, dedup, reconciler
├── services/                   (planned) MessageService, ThreadService, UserService
└── util/                       abort/timer helpers, bounded caches
tests/
├── unit/  protocol/  realtime/  integration/  fixtures/
```

## 4. Public API

```ts
import { MessengerClient, FileSessionStore, createConsoleLogger } from "fca-unofficial";

const client = new MessengerClient({
  session: new FileSessionStore({ path: ".session/messenger.json" }),
  logger: createConsoleLogger({ level: "info" }), // default: silent
});

client.on("message", (message) => {
  /* normalized Message */
});
client.on("stateChange", ({ from, to, reason }) => {
  /* lifecycle */
});
client.on("error", (error) => {
  /* MessengerError; never thrown into the app */
});

await client.connect(); // resolves once connected AND initially synced
const threads = await client.threads.list({ limit: 20 }); // (planned)
const page = await client.messages.history(threadId, { limit: 50 }); // (planned)
const user = await client.users.get(userId); // (planned)
client.health(); // local snapshot, never sent anywhere

await client.disconnect(); // idempotent; connect() may be called again
await client.destroy(); // idempotent; terminal, releases everything
```

Why not `Messenger.login()`: the library never logs in. It **resumes a session the user
created in their own browser**. A constructor plus an explicit `connect()` makes the
lifecycle visible and testable.

Session import is explicit and local:

```ts
const { session, warnings } = sessionFromCookies(cookieHeaderOrBrowserExport); // validates, no network
await store.save(session);
```

### 4.1 Events

| Event                            | Payload                                                  | Source                                                   | Promise level                    |
| -------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- | -------------------------------- |
| `ready`                          | `{ userId, resumed }`                                    | after connect + initial sync                             | stable                           |
| `stateChange`                    | `{ from, to, reason?, attempt? }`                        | supervisor                                               | stable                           |
| `message`                        | `Message`                                                | LS `insertMessage`/`upsertMessage` (live, not history)   | experimental until verified live |
| `messageEdit`                    | `{ messageId, threadId?, text, editCount }`              | LS `editMessage`                                         | experimental                     |
| `messageDelete`                  | `{ threadId, messageId, reason: "unsent" \| "removed" }` | LS `deleteThenInsertMessage(isUnsent)` / `deleteMessage` | experimental                     |
| `reactionAdd` / `reactionRemove` | `{ threadId, messageId, actorId, reaction }`             | LS `upsertReaction` / `deleteReaction`                   | experimental                     |
| `typing`                         | `{ threadId, userId, isTyping }`                         | LS `updateTypingIndicator`                               | experimental                     |
| `readReceipt`                    | `{ threadId, userId, readUpTo }`                         | LS `updateReadReceipt`                                   | experimental                     |
| `threadUpdate`                   | `{ threadId, changes }`                                  | LS thread procedures                                     | experimental                     |
| `error`                          | `MessengerError`                                         | anywhere                                                 | stable                           |
| `raw`                            | `{ kind, data }`                                         | decoder (opt-in)                                         | **unstable, debugging only**     |

Deliberate deviations from the brief's list:

- `disconnect` and `reconnect` are not separate events. `stateChange` is the single
  source of truth, and two ways to observe the same thing drift apart.
- `typingStart` and `typingStop` are one `typing` event, because the protocol sends one
  boolean.
- `messageCreate` is not a separate event from `message`.

`raw` is off unless `debug.rawEvents: true`, because retaining raw payloads costs memory
and invites dependence on unstable shapes.

**Listener safety:** a throwing or rejecting listener never breaks the pipeline. The
error is logged and re-emitted as `error`, and a throwing `error` listener is only logged.
An `error` event with no listener is logged, not thrown. This differs from Node's
`EventEmitter`, deliberately, because a library must not crash its host.

Async iteration (planned): `client.events({ bufferSize, overflow: "drop-oldest" |
"error" })` returns a bounded async iterator built on the emitter.

## 5. Domain model (public, stable)

IDs are `string` (Messenger FBIDs and thread keys exceed 2^53; never `number`). Fields
exist only where `protocol-status.md` §6–8 shows a source; unknowns are optional and
documented.

```ts
interface Message {
  id: string; // messageId (e.g. "mid.$…")
  threadId: string; // thread key, decimal string
  senderId: string;
  text: string | null;
  timestamp: number; // ms since epoch (server timestampMs)
  isFromMe: boolean;
  kind: "user" | "admin"; // admin = system notices ("X named the group")
  attachments: Attachment[];
  mentions: Mention[];
  replyTo?: { messageId: string; senderId?: string; text?: string };
  isForwarded: boolean;
  editCount: number;
  channel: "lightspeed" | "e2ee"; // which protocol delivered it (honesty about coverage)
}
```

Reactions are events and history annotations, not a mutable field on `Message`: the
live stream delivers them separately, and a mutable aggregate would need a cache we do not
want. Thread, User and Attachment models are specified with the read API, against recorded
fixtures.

## 6. Lifecycle

### 6.1 States

```text
             connect()                    success
   idle ─────────────► connecting ───────────────────► connected
     ▲                   │  │                             │   │
     │       permanent   │  │ transient     lost/stale    │   │ disconnect()
     │         error     │  └──────────► reconnecting ◄───┘   │
     │                   ▼              │ ▲   │  (backoff,    │
     │                 failed ◄─────────┘ └───┘  retry)       │
     │                   │  permanent / maxAttempts           ▼
     │                   │ connect()                    disconnecting ──► disconnected
     │                   └──────────► connecting              ▲               │
     │                                                        │  disconnect() │ connect()
     └── (never returns to idle)       any non-final state ───┘               ▼
                                                                          connecting
```

- Exactly the seven states from the brief. `destroyed` is a flag, not a state:
  `destroy()` ends in `disconnected` and then refuses everything.
- The transition table lives in one pure module (`lifecycle/connection-state.ts`).
  Illegal transitions throw internally and are unit-tested exhaustively.

### 6.2 ConnectionSupervisor: the only reconnect loop

```text
run():
  while not stopping:
    attempt += 1
    connection = await connector(signal)          // bounded by connectTimeoutMs
      ├─ permanent error (auth, checkpoint, not-implemented) → FAILED, stop
      └─ transient error → RECONNECTING, sleep(backoff(attempt)) cancellable, continue
    CONNECTED  (first time: resolve connect())
    reason = await first-of(connection.closed, stop requested)
    if stopping → close connection, DISCONNECTED, stop
    if uptime ≥ stableAfterMs → attempt = 0      // a long healthy link resets backoff
    classify(reason) → FAILED | RECONNECTING (sleep, continue)
```

Guarantees, each covered by a test:

1. **One loop at a time.** `start()` while a run is active returns the same promise.
   A connection's `closed` is a single promise, so four "connection lost" signals from the
   transport produce **one** reconnect.
2. **No stray timers.** The only delay is a cancellable sleep owned by the loop.
   `stop()` aborts it and awaits the loop's exit.
3. **No infinite hot loop.** Backoff is exponential (1 s × 2ⁿ, capped at 5 min) with
   equal jitter. `maxAttempts` is configurable (default unlimited, because a monitor
   should outlive long outages), and permanent errors stop immediately.
4. **Reconnect-while-disconnecting is impossible.** `stop()` sets `stopping` before
   anything else, and every loop step checks it.

### 6.3 Health and liveness _(transport details planned)_

- **Transport liveness:** DGW ping every 10 s. The link counts as dead after 30 s with no
  inbound frame, which resolves `closed` with reason `heartbeat_timeout`.
- **Data liveness** (the silent-stall defence, `protocol-status.md` §3.6): see §7.3.
- `client.health()` returns `{ state, connectedSince, uptimeMs, reconnects,
lastEventAt, lastHeartbeatAt, eventCounts, protocolErrors, droppedFrames,
dedupSize, reconciliations }`. It is a plain local object with no network I/O.

## 7. Realtime pipeline _(planned)_

### 7.1 Transport _(implemented)_

`DgwConnection` (`src/transport/dgw/`) implements the frame layouts from
`protocol-status.md` §3.2 over the native `WebSocket`: one-off request/response streams
and persistent streams, per-stream acks, ping/pong, an inactivity watchdog, drain
notification, and close-code classification. Decisions are recorded in
`protocol-status.md` §14.

```ts
class DgwConnection {
  static open(options: DgwConnectionOptions): Promise<DgwConnection>;
  request(payload: Uint8Array, opts?: RequestOptions): Promise<Uint8Array | undefined>; // one-off
  openStream(opts: OpenStreamOptions): Promise<DgwStream>; // persistent, server pushes data
  readonly closed: Promise<DgwClosedInfo>; // settles exactly once, never rejects
  close(): Promise<void>; // idempotent
}
```

A pushed data frame is acknowledged only after its handler returns. If the handler throws,
the frame is not acknowledged and the connection closes (`handler_error`), so the
supervisor reconnects and cursor catch-up re-delivers the data.

The Lightspeed decoder (`src/protocol/lightspeed/`) turns payloads into ordered
stored-procedure calls, and `procedures.ts` maps those calls onto typed rows. That
positional schema file is the single place to edit when Meta changes a schema.

### 7.2 Protocol

`ProtocolClient.connect(context, signal)` receives a `ProtocolContext` from the client:
the session, the live cookie jar, an `HttpClient` bound to the client's shutdown signal, the
browser profile, a logger and a clock. The protocol layer never touches the session store.

_Implemented:_ bootstrap, i.e. load `/messages`, classify redirects and extract
config (`src/protocol/bootstrap/*`, `protocol-status.md` §13). Page tokens live in memory
for one attempt; caching across reconnects arrives with the realtime transport, together with
invalidation on DGW auth failures.

_Planned:_ open the DGW connection, open one persistent stream per sync database
`[1, 2, 95, 104]` with the stored `last_applied_cursor`, and recursively sync DB 1 until
its cursor stops advancing. Decoded LS payloads become **typed rows**
(`{ procedure: "insertMessage", row: InsertMessageRow }`). Unknown procedures are counted
and, if enabled, surfaced via `raw`. They are never guessed at.

### 7.3 Pipeline: ordering, normalization, dedup, reconciliation

1. **Ordering:** rows from one LS batch are dispatched in the fixed order documented in
   `protocol-status.md` §6, so an edit or reaction never precedes its message's insert.
2. **Normalization:** rows → domain events (§4.1). Edits carry no thread key, so a
   bounded `messageId → threadId` index (LRU, 10k entries) resolves it; when missing,
   `threadId` is `undefined`, never invented.
3. **Dedup:** a bounded TTL+LRU set keyed by semantic identity, for example
   `m:<messageId>`, `e:<messageId>:<editCount>`, `d:<messageId>`,
   `r:<messageId>:<actorId>:<reaction>:<add|rm>`, `t:<threadId>:<userId>:<bool>`
   (short TTL). Default capacity 20k and TTL 24 h. Timestamps are never used as identity.
4. **Reconciliation:** on every reconnect (cursor catch-up is part of `connect()`), and
   every `reconcileIntervalMs` (default 5 min) while connected, re-sync DB 1 from the
   stored cursor. Rows that were already seen are dropped by dedup; genuinely missed
   rows are emitted with `recovered: true` in their metadata. The count is exposed in
   `health().reconciliations`.
5. **History is not live:** rows from history fetches are routed to the requesting call,
   never emitted as `message` events.

### 7.4 Backpressure

Emission is synchronous per batch; listeners that need async work should queue it.
The optional async iterator has a bounded buffer with an explicit overflow policy. No
internal queue is unbounded.

## 8. Session subsystem

```ts
interface SessionStore {
  load(): Promise<SessionData | null>;
  save(data: SessionData): Promise<void>;
  clear(): Promise<void>;
}
```

`SessionData` (versioned, schema-validated on load and save):

| Field                                                               | Secret? | Notes                                             |
| ------------------------------------------------------------------- | ------- | ------------------------------------------------- |
| `version`                                                           | no      | schema version, for migrations                    |
| `userId`                                                            | PII     | from `c_user`                                     |
| `cookies[]` (name, value, domain, path, expires?, secure, httpOnly) | **yes** | `xs`, `c_user`, `datr`, `sb`, `fr`…               |
| `userAgent`                                                         | no      | fixed per session. Consistency beats randomness.  |
| `device.clientId` _(planned)_                                       | low     | stable across restarts once learned from the page |
| `sync.cursors{db → cursor}`, `updatedAt` _(planned)_                | low     | enables gap filling                               |
| `createdAt`, `updatedAt`                                            | no      |                                                   |

`FileSessionStore`:

- **Atomic writes:** write `<file>.<rand>.tmp` → fsync → rename over the target; the
  previous file is rotated to `<file>.bak` first. A crash mid-write leaves either the old
  file or the new one, never a torn file.
- **Corruption detection:** the on-disk envelope is
  `{ format, version, codec, checksum: sha256(payload), payload }`. A checksum mismatch,
  bad JSON or failed schema validation raises `SessionCorruptedError`, which names the
  file. The `.bak` file is **not** silently loaded; the application decides
  (`store.loadBackup()`), so a stale session is never resurrected unnoticed.
- **Permissions:** the directory is created with mode `0o700` and the file with `0o600`.
  On Windows, POSIX modes are ignored and the file inherits the user-profile ACL; the docs
  recommend keeping the file under `%LOCALAPPDATA%`.
- **Encryption at rest (optional):** `SessionCodec` interface. `AesGcmCodec(key)` uses
  AES-256-GCM with a fresh 96-bit IV per save, with the key supplied by the application
  (for example derived with `scryptKey(passphrase, salt)`). No OS keychain in the core.
- **Concurrency:** saves are serialized per store instance. A second process writing the
  same file is detected by an advisory lock file (planned) and not supported.
- `.gitignore` covers `.session/`, `appstate.json`, `*.session.json`,
  `*.session.json.bak`.

`SessionManager` (`src/client/session-manager.ts`, one per client) sits between the store
and the protocol. It loads the session once per connection run (re-reads it after
`disconnect()` or a failure, so a re-imported session is picked up) and owns the live
cookie jar. It persists cookie rotations debounced (2 s) through the store's atomic save,
and it refuses to persist an update that drops a required cookie. `reset()` clears its
state synchronously, so concurrent `connect()` calls cannot observe a half-reset manager.

Session _validity_ is a protocol question: the store only guarantees integrity.
`ProtocolClient` classifies "expired" (redirect to login, `ACCOUNT_ID == 0`),
"checkpoint", "consent" and "suspended" into the typed errors below, then clears
nothing by itself. Invalidating the session is the application's call.

## 9. HTTP transport

`HttpClient.request(req)` wraps `fetch`:

- **Timeouts and cancellation:** `AbortSignal.any([callerSignal, AbortSignal.timeout(ms)])`.
  Timeouts become `TimeoutError`; caller aborts become `OperationAbortedError`.
- **Retries** apply only when `idempotent: true` (GET, and read-only GraphQL, which is
  opt-in per operation). They cover network errors, 5xx, 408 and 429 (honouring
  `Retry-After`), using exponential backoff with jitter up to `maxAttempts`. Mutations
  never retry automatically.
- **Request ids** are local correlation ids used in logs and errors. They are **never sent
  to Facebook**: the wire must look like the browser, and extra headers are a fingerprint.
- **Cookies:** a minimal RFC 6265 jar (domain/path matching, expiry, deletion via
  `Max-Age<=0`) fed by `Headers.getSetCookie()`. Changes raise a callback so the session
  can be persisted (debounced).
- **Redirects:** `redirect: "manual"` by default, so the protocol layer can see redirects
  to `/login` or `/checkpoint`.
- **Response limits:** `maxResponseBytes` (default 16 MiB) guards memory.
- **Error classification:** `NetworkError`, `TimeoutError`, `HttpStatusError(status)`,
  `RateLimitError(retryAfterMs)`. Messenger-level meaning (auth, checkpoint) is decided
  one layer up.

## 10. Errors

```text
MessengerError                      code, retryable, safe `details`, `cause`
├── ConfigurationError              bad options
├── ClientStateError                e.g. used after destroy()
├── OperationAbortedError           caller cancelled
├── AuthenticationError
│   ├── InvalidSessionError         missing/malformed cookies (detected locally)
│   ├── SessionExpiredError         server says logged out
│   └── CheckpointRequiredError     kind: checkpoint | consent | challenge | suspended
├── SessionStoreError
│   └── SessionCorruptedError
├── NetworkError                    retryable
│   └── TimeoutError
├── HttpStatusError                 status
│   └── RateLimitError              retryAfterMs
├── ProtocolError                   unexpected/malformed payload (area, safe excerpt length only)
│   └── ProtocolNotImplementedError component not yet verified/implemented; permanent
└── RealtimeError                   connection-level failures (close code, reason)
```

Rules: messages and `details` never contain cookies, tokens, request bodies or payload
text. They carry sizes, codes, procedure names and request ids. Every error has a stable
`code` string for programmatic handling. `retryable` drives the supervisor's
permanent-vs-transient classification.

## 11. Logging and observability

- `Logger` interface with levels `silent | error | warn | info | debug | trace` and
  `child(bindings)`. The default is **silent**, so the library never writes to the
  console unless asked.
- **Every logger, including user-supplied ones, is wrapped in a redactor.** Known secret
  keys (`cookie`, `xs`, `fb_dtsg`, `lsd`, `authorization`, `password`, `token`, `appstate`,
  `session`, …) are replaced in structured fields, recursively and with depth and
  cycle limits. Secret-shaped substrings (`xs=…`, `fb_dtsg=…`) are masked in messages.
  `c_user` is shown only partially.
- No telemetry, no analytics, no outbound calls other than those listed in
  `protocol-status.md` §10.

## 12. Concurrency

| Race                                       | Mechanism                                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Reconnect while disconnecting              | Supervisor checks `stopping` at every await boundary; `stop()` aborts the sleep and awaits the loop                                      |
| Multiple reconnect attempts                | Single loop plus a single-settlement `closed` promise                                                                                    |
| Duplicate realtime and reconciliation rows | Semantic dedup (§7.3)                                                                                                                    |
| Session save storms                        | Per-store write serialization plus debounced cookie persistence                                                                          |
| Token refresh while requests run           | _(planned)_ single-flight refresh: concurrent callers await the same promise; requests are retried once after refresh only if idempotent |
| Shutdown with pending requests             | A client-wide `AbortController` aborts all in-flight HTTP/DGW operations with `OperationAbortedError`                                    |
| Out-of-order thread updates                | LS procedures carry authority levels and timestamps; the pipeline passes them through and does not cache thread state                    |

No `setTimeout`-based "wait and hope" anywhere. Every delay is owned, cancellable and
tested.

## 13. Memory safety

Every structure is bounded or scoped to one operation: the dedup cache and the
message→thread index are LRU+TTL; history pagination returns pages; raw payloads are
never retained unless `raw` is enabled; attachments are metadata only and downloads are
streamed on explicit request. `destroy()` aborts the client controller, stops the
supervisor, closes streams, clears caches, removes all listeners and flushes the session
(one final atomic save). A test asserts that no timers or handles remain afterwards.

## 14. Security posture

- The core contacts only the hosts listed in `protocol-status.md` §10.
- It performs no filesystem access outside `FileSessionStore`, and only when the
  application constructs one.
- No postinstall or lifecycle scripts. The repository `.npmrc` sets
  `ignore-scripts=true` for development installs.
- No code evaluation (`eval`, `Function`, `vm`), no dynamic `require`, no auto-update.
- UA and headers are fixed and consistent. No randomisation or "human emulation".
- Password, TOTP and checkpoint flows are out of scope; users log in with their browser.

## 15. Feature status registry

`src/model/status.ts` exports a machine-readable map, surfaced in the README:

| Feature                              | Status                                           |
| ------------------------------------ | ------------------------------------------------ |
| Session import/storage               | stable                                           |
| Lifecycle / reconnect supervisor     | stable                                           |
| Bootstrap / session validation       | experimental (not yet verified live)             |
| Realtime receive (Lightspeed/DGW)    | in development; experimental until verified live |
| History / threads / users            | planned                                          |
| Edits / unsends / reactions / typing | planned                                          |
| E2EE threads                         | unsupported (possible separate package)          |
| Sending                              | unsupported (planned after the read-only core)   |

## 16. Testing strategy

- **Unit:** state machine (exhaustive transition table), backoff and jitter, redaction,
  error classification, cookie jar, session validation/codec/store, emitter safety.
- **Realtime:** `FakeRealtimeConnection` driven by tests: lose the connection once and
  confirm a single reconnect; lose it four times in a row and confirm exactly one loop;
  `stop()` during backoff, during connect and while connected; long-uptime backoff reset;
  permanent-error stop. Timers use Vitest fake timers.
- **Protocol:** DGW frame encode/decode round-trips plus golden bytes; LS decoder on
  sanitized fixtures. Fixtures come **only** from recorded, sanitized live traces. None
  are hand-invented as "real".
- **Integration:** local HTTP/WebSocket test servers for transport behaviour. Live tests
  against Messenger are opt-in (`FCA_LIVE=1`), read-only, and use the owner's session
  from the environment. They never run in CI.

## 17. Delivery plan

Each milestone is done only when its exit criterion is met.

| Milestone          | Deliverable                                                               | Exit criterion                                                                                  |
| ------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Core               | tooling, errors, logging, emitter, lifecycle, session, HTTP, client shell | lint, type check and tests green; `connect()` fails honestly with `ProtocolNotImplementedError` |
| Bootstrap          | page parser, auth classification, session manager, read-only probe        | a live probe run: session validated, config extracted, secret-free structure recorded           |
| Realtime receiving | DGW transport, LS envelope/decoder, sync manager, realtime wiring         | live trace: connect, sync, receive one message, survive a forced disconnect                     |
| Read API           | threads, history, users                                                   | fixture-driven parsers plus a live read                                                         |
| Message events     | full event mapping, dedup, reconciliation                                 | fixture replay: duplicates suppressed, gaps recovered                                           |
| Reliability        | multi-hour soak, lock file, fault injection                               | no leaks, one loop, no duplicate emits                                                          |
| Later              | E2EE package (decision), sending, optional FCA-style compatibility layer  | each by its own design review; compatibility maps onto the stable API only                      |
