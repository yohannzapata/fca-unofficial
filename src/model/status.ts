/**
 * Machine-readable reliability status of every feature. Kept honest: a feature is only
 * "experimental" once implemented, and only "stable" once verified against live Messenger
 * and covered by tests.
 */
export type FeatureStatus = "stable" | "experimental" | "unimplemented" | "unsupported" | "deprecated";

export interface FeatureInfo {
  readonly status: FeatureStatus;
  readonly note: string;
}

export const FEATURE_STATUS = Object.freeze({
  sessionImport: { status: "stable", note: "Local cookie import and validation; no network access." },
  sessionStorage: {
    status: "stable",
    note: "Atomic, checksummed file store with optional AES-256-GCM encryption.",
  },
  connectionLifecycle: {
    status: "stable",
    note: "Single supervised reconnect loop with backoff and jitter.",
  },
  authValidation: {
    status: "experimental",
    note: "Loads facebook.com/messages to validate the session and detect expiry/checkpoints. Not yet verified live.",
  },
  realtimeReceive: {
    status: "experimental",
    note: "New messages over the DGW gateway with Lightspeed sync; cursors are persisted, so gaps after reconnects and restarts are filled. Not yet verified live. Text and metadata only (attachment details are not reported).",
  },
  messageEdits: {
    status: "experimental",
    note: "Edit events with the new text and edit count. Not yet verified live.",
  },
  messageUnsends: {
    status: "experimental",
    note: "Unsends and removals as messageDelete events. Not yet verified live.",
  },
  reactions: {
    status: "experimental",
    note: "Reaction add/change/remove, deduplicated per message and actor. Not yet verified live.",
  },
  typingIndicators: {
    status: "experimental",
    note: "Live typing start/stop; a stop is inferred after ~6 s without a refresh. Not yet verified live.",
  },
  threadList: { status: "unimplemented", note: "Planned." },
  messageHistory: { status: "unimplemented", note: "Planned." },
  users: { status: "unimplemented", note: "Planned." },
  encryptedChats: {
    status: "unsupported",
    note: "End-to-end encrypted chats use a separate protocol; planned as a separate optional package.",
  },
  sending: { status: "unsupported", note: "Planned after the read-only core is reliable." },
  presence: { status: "unsupported", note: "Not verified in any maintained implementation." },
} satisfies Record<string, FeatureInfo>);

export type FeatureName = keyof typeof FEATURE_STATUS;
