# Architecture options

**Date:** 2026-09-30. Inputs: `protocol-status.md` and `existing-projects.md`.
Each section lists the options, their trade-offs and a recommendation. Decisions that
belong to the project owner are marked **DECISION NEEDED**.

---

## 1. Which realtime protocol?

| Option                                                            | For                                                                                                                                                                          | Against                                                                                                                                                           |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Lightspeed over DGW** (`gateway.facebook.com/ws/lightspeed`) | What the maintained reference switched to in 2026-07; LS is the web client's own sync model; per-database cursors give built-in gap filling; one socket, multiplexed streams | Binary framing to implement; newest, so least battle-tested; only one implementation of the lightspeed path                                                       |
| B. Legacy MQTT + Iris `/t_ms` (FCA)                               | Many implementations; JSON deltas are simple                                                                                                                                 | Older protocol that Meta can retire at any time; the reference client dropped it; needs a sequence id from ageing GraphQL doc_ids; carries no E2EE content either |
| C. Both behind an adapter                                         | Fallback if one breaks                                                                                                                                                       | Doubles the protocol surface to test and maintain; conflicts with KISS                                                                                            |

**Recommendation: A only.** Keep the `RealtimeTransport` boundary so that B _could_ be
added as a contingency adapter without touching domain code, but do not build it
speculatively.

## 2. Where does the protocol engine live?

| Option                                                                  | For                                                                                                       | Against                                                                                                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Native TypeScript, clean-room**                                    | What the brief asks for; auditable; no native binaries; fits the Windows desktop target; typed end to end | We carry the protocol-maintenance burden ourselves, following Meta's changes (the reference project needs about weekly fixes)                 |
| B. TS façade over a local Go sidecar built from mautrix-meta `messagix` | Inherits a maintained, E2EE-capable engine immediately                                                    | AGPL; Go toolchain; IPC layer; two languages; opaque to TS debugging; this is what the unsafe forks do, but at least ours would be self-built |
| C. Run mautrix-meta as a Matrix bridge and consume Matrix               | Most mature path, with E2EE included                                                                      | Requires a Matrix homeserver; heavy for one personal user; the "library" becomes a Matrix client                                              |

**Recommendation: A**, with the domain API designed so that the _protocol engine_ is an
internal module boundary (`ProtocolClient`). If native E2EE turns out to be
disproportionate, option B for **E2EE only** remains open, behind the same boundary.

## 3. End-to-end encryption strategy (**DECISION NEEDED: priority**)

Facts: 1:1 chats are E2EE by default, so without E2EE a personal monitor sees
E2EE DMs only as thread activity, not content. The E2EE stack is Noise, WA-binary,
Signal (1:1 and sender keys), Meta protobufs and ICDC device registration, plus
long-lived private keys stored on disk.

| Option                                                                                 | For                                                                                           | Against                                                                                                    |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A. Defer; ship Lightspeed-only first                                                   | Smallest, most reliable foundation; covers non-E2EE groups plus thread metadata for all chats | Misses the content of most DMs, which may defeat the monitor's purpose                                     |
| **B. Separate `e2ee` package on `@signalapp/libsignal-client`**                        | Official Signal implementation (audited, maintained); what `fme` uses                         | Native prebuilt binary (~tens of MB); AGPL-3.0 license                                                     |
| C. Separate `e2ee` package implementing Signal on `@noble/*` (MIT, audited primitives) | Pure JS, permissive license, no native code                                                   | We would own a Double Ratchet + sender-key implementation. That is a big, security-critical piece of code. |
| D. E2EE-only sidecar (see §2B)                                                         | Fastest to "works"                                                                            | See §2B                                                                                                    |

**Recommendation:** build the core with the E2EE channel as a first-class _second
message source_ in the architecture (same normalized events, same dedup, same session
store), but ship it as a separate package after the Lightspeed core is reliable.
Choose B vs C when we get there. **How soon is the owner's call.** It depends on how many
of their important chats are E2EE (see the question list in the first response).

## 4. Package structure

The brief proposes `core / messenger / types / fca-compat`. Evidence says:

- `types` as a separate package adds nothing. Types ship with the code that produces them.
- `core` vs `messenger` would split one cohesive client along an arbitrary line. Every
  Messenger service needs the protocol client, and nothing else uses `core`.
- Separate packages are justified by **dependency boundaries**. E2EE will pull in native
  or large crypto; `fca-compat` is a legacy surface most users should never load.

**Recommendation:** one package now (`fca-unofficial`) with strict internal
module boundaries, enforced by an ESLint import rule and the tests. Convert to npm
workspaces when the second package (`e2ee` or `fca-compat`) actually exists.

## 5. License (**DECISION NEEDED**)

| Option                                   | Consequence                                                                                                                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MIT, clean-room** (default assumption) | We may use protocol _facts_ learned from AGPL sources, but must not translate their code. Slower. We describe layouts in our own words (as `protocol-status.md` does) and write implementations from that description. |
| AGPL-3.0                                 | We could port `messagix` logic directly; faster and closer to a proven implementation. For a personal, non-distributed monitor, AGPL obligations are negligible. For others reusing the library, AGPL is restrictive.  |

We proceed with **MIT + clean-room** unless told otherwise. It keeps both doors open,
because relicensing to AGPL later is easy while the reverse is not.

## 6. Runtime dependencies

Node ≥ 24 provides `fetch` (undici), a `WebSocket` that accepts custom handshake
headers (verified locally), `AbortSignal.any/timeout`, `Headers.getSetCookie`,
`node:crypto` (AES-GCM, scrypt, randomUUID) and `EventEmitter`.

**Recommendation:** the core ships with **zero runtime dependencies**. Every future
addition must pass the dependency policy (brief §40). Candidates we may need later:
none for the read-only core; `@signalapp/libsignal-client` or `@noble/*` + `protobufjs` for E2EE.

## 7. Target runtime

Node 22 reaches end of life in 2027-04, and its bundled undici 6 is unverified for
WebSocket headers. Node 24 ("Krypton") is the active LTS until 2028-04.
**Recommendation:** `engines.node >= 24`. ESM-only.

## 8. Public API style

| Option                                                  | Notes                                                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Typed `EventEmitter`-style `on/off/once`**            | Familiar; the brief's examples use it                                                           |
| Async iterator `for await (const e of client.events())` | Natural for "consume and store" apps; provides backpressure; the buffer must be bounded         |
| Both                                                    | Iterator implemented on top of the emitter with a bounded queue and an explicit overflow policy |

**Recommendation:** typed emitter as the primitive (`client.on("message", …)`), plus an
optional bounded async iterator. A static `Messenger.login()` factory does not fit,
because we do not log in; we _resume a user-provided session_. Use
`new MessengerClient({ session })` + `await client.connect()`.

## 9. Reliability model (the core requirement)

The protocol gives us three tools. We use all three, deliberately:

1. **Realtime push** on persistent DGW streams: low latency.
2. **Cursor catch-up** on every (re)connect: sending the stored `last_applied_cursor`
   per database closes gaps caused by disconnects.
3. **Periodic reconciliation** while connected: a scheduled re-sync of DB 1 with the
   current cursor defends against the documented _silent stall_ (mautrix #352), where the
   socket is healthy but events stop.

Because (2) and (3) can re-deliver data already seen via (1), **every emitted event goes
through a bounded deduplicator keyed by semantic identity** (e.g.
`message:<messageId>`, `edit:<messageId>:<editCount>`,
`reaction:<messageId>:<actorId>:<emoji>:<op>`), not by timestamps.

## 10. Session storage

**Recommendation:** a `SessionStore` interface (`load/save/clear`). The core never
touches the filesystem itself. A separate `FileSessionStore` does atomic writes
(temp + fsync + rename), keeps a checksummed envelope, validates the schema, rotates one
`.bak` file and applies owner-only permissions where the OS supports them. It accepts an
optional `SessionCodec` for encryption at rest (AES-256-GCM with a key the application
supplies). No OS keychain integration in the core: that needs native modules.
