// Public API. Anything not exported here is internal and may change without notice.

export {
  MessengerClient,
  type ClientHealth,
  type MessengerClientOptions,
  type ReconnectOptions,
} from "./client/messenger-client.js";

export {
  probeSession,
  type ProbeOptions,
  type ProbeOutcome,
  type SessionProbeReport,
} from "./client/probe.js";
export { DEFAULT_USER_AGENT } from "./protocol/bootstrap/browser-profile.js";

export type { ClientEvents, ConnectionState, ReadyEvent, StateChangeEvent } from "./model/events.js";
export type {
  Mention,
  Message,
  MessageDeleteEvent,
  MessageEditEvent,
  MessageReference,
  ReactionEvent,
  TypingEvent,
} from "./model/messages.js";
export type { PipelineStats } from "./pipeline/event-pipeline.js";
export { FEATURE_STATUS, type FeatureInfo, type FeatureName, type FeatureStatus } from "./model/status.js";

export {
  AuthenticationError,
  CheckpointRequiredError,
  ClientStateError,
  ConfigurationError,
  HttpStatusError,
  InvalidSessionError,
  MessengerError,
  NetworkError,
  OperationAbortedError,
  ProtocolError,
  ProtocolNotImplementedError,
  RateLimitError,
  RealtimeError,
  SessionCorruptedError,
  SessionExpiredError,
  SessionStoreError,
  TimeoutError,
  isMessengerError,
  type CheckpointKind,
  type ErrorCode,
  type ErrorDetails,
} from "./errors/errors.js";

export {
  createConsoleLogger,
  silentLogger,
  type ConsoleLoggerOptions,
  type LogFields,
  type Logger,
  type LogLevel,
} from "./logging/logger.js";

export {
  REQUIRED_COOKIES,
  sessionFromCookies,
  validateSessionData,
  type CookieInput,
  type CookieLike,
  type SessionCookie,
  type SessionData,
  type SessionFromCookiesOptions,
  type SessionFromCookiesResult,
} from "./session/session.js";
export { MemorySessionStore, type SessionStore } from "./session/session-store.js";
export { FileSessionStore, type FileSessionStoreOptions } from "./session/file-session-store.js";
export { createAesGcmCodec, createPassphraseCodec, plainCodec, type SessionCodec } from "./session/codec.js";
