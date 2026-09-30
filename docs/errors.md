# Errors

Every error is a `MessengerError` with a stable `code`, a `retryable` flag and
secret-free `details`. `JSON.stringify(error)` is safe to log or store, because it never
includes the cause chain.

```ts
try {
  await client.connect();
} catch (error) {
  if (isMessengerError(error) && error.code === "CHECKPOINT_REQUIRED") {
    /* … */
  }
}
```

| Code                       | Class                         | Retryable    | Meaning                                                                | What to do                                  |
| -------------------------- | ----------------------------- | ------------ | ---------------------------------------------------------------------- | ------------------------------------------- |
| `CONFIGURATION`            | `ConfigurationError`          | no           | Invalid options                                                        | Fix the code                                |
| `CLIENT_STATE`             | `ClientStateError`            | no           | e.g. used after `destroy()`                                            | Create a new client                         |
| `ABORTED`                  | `OperationAbortedError`       | no           | You (or shutdown) cancelled                                            | Nothing                                     |
| `INVALID_SESSION`          | `InvalidSessionError`         | no           | Missing or malformed cookies, or empty store                           | Import a session                            |
| `SESSION_EXPIRED`          | `SessionExpiredError`         | no           | Facebook no longer accepts the session                                 | Re-export cookies                           |
| `CHECKPOINT_REQUIRED`      | `CheckpointRequiredError`     | no           | Interactive check needed (`kind`)                                      | Resolve it in a browser                     |
| `SESSION_STORE`            | `SessionStoreError`           | no           | Store I/O failed, or codec mismatch                                    | Check the path, permissions, codec          |
| `SESSION_CORRUPTED`        | `SessionCorruptedError`       | no           | Checksum, JSON, schema or decryption failed                            | Re-import, or `loadBackup()`                |
| `NETWORK`                  | `NetworkError`                | yes          | Connection-level failure                                               | Automatic retry or reconnect                |
| `TIMEOUT`                  | `TimeoutError`                | yes          | An operation exceeded its timeout                                      | Automatic retry or reconnect                |
| `HTTP_STATUS`              | `HttpStatusError`             | 5xx/408: yes | Unexpected HTTP status (`status`)                                      | Usually transient                           |
| `RATE_LIMITED`             | `RateLimitError`              | yes          | HTTP 429 (`retryAfterMs`)                                              | Back off; honoured automatically when short |
| `PROTOCOL`                 | `ProtocolError`               | no           | Unexpected payload (`area`), likely a Messenger change                 | Report it with the `raw` debug output       |
| `PROTOCOL_NOT_IMPLEMENTED` | `ProtocolNotImplementedError` | no           | That protocol component does not exist yet                             | See the roadmap                             |
| `REALTIME`                 | `RealtimeError`               | usually      | Realtime connection problem, or gave up after `maxConsecutiveFailures` | Automatic, or `connect()` again             |
| `INTERNAL`                 | `MessengerError`              | no           | Unexpected bug                                                         | Please report                               |

## How errors reach you

- **Rejected promises** from the method you called (`connect()`, and later the read API).
- **`error` events** for things that happen in the background: permanent connection
  failure, or an exception thrown by one of your listeners. An `error` event with no
  listener is logged, never thrown, so it cannot crash your process.
- **`stateChange` events** carry the `reason` code of every transient failure, for
  example `connected -> reconnecting (heartbeat_timeout)`.
