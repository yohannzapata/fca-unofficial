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
    status: "unimplemented",
    note: "Planned: Lightspeed over the DGW gateway. Experimental until verified against live Messenger.",
  },
  messageEdits: { status: "unimplemented", note: "Planned." },
  messageUnsends: { status: "unimplemented", note: "Planned." },
  reactions: { status: "unimplemented", note: "Planned." },
  typingIndicators: { status: "unimplemented", note: "Planned." },
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
