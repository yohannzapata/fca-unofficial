import type { MessengerError } from "../errors/errors.js";
import type {
  Message,
  MessageDeleteEvent,
  MessageEditEvent,
  ReactionEvent,
  TypingEvent,
} from "./messages.js";

/** Mirrors lifecycle/connection-state.ts; duplicated here so the public model has no internal imports. */
export type ConnectionState =
  "idle" | "connecting" | "connected" | "reconnecting" | "disconnecting" | "disconnected" | "failed";

export interface StateChangeEvent {
  readonly from: ConnectionState;
  readonly to: ConnectionState;
  readonly reason?: string;
  readonly attempt?: number;
  readonly at: number;
}

export interface ReadyEvent {
  readonly userId: string;
}

/**
 * Events emitted by MessengerClient. Only events that are actually implemented appear here
 * (see FEATURE_STATUS and docs/architecture.md §4.1).
 */
export type ClientEvents = {
  /** The client connected and completed its initial sync (once per connect() call). */
  ready: [event: ReadyEvent];
  /** Every lifecycle transition. The single source of truth for connectivity. */
  stateChange: [event: StateChangeEvent];
  /** Fatal lifecycle failures and failures inside event listeners. Never thrown into the app. */
  error: [error: MessengerError];
  /** A new message (live, or recovered by catch-up synchronization). */
  message: [message: Message];
  messageEdit: [event: MessageEditEvent];
  /** A message was unsent or removed. */
  messageDelete: [event: MessageDeleteEvent];
  reactionAdd: [event: ReactionEvent];
  reactionRemove: [event: ReactionEvent];
  /** Typing started or stopped (stops are inferred when no refresh arrives within ~6 s). */
  typing: [event: TypingEvent];
};
