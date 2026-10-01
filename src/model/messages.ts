/**
 * Public, normalized message-level types. IDs are strings: Messenger ids exceed 2^53.
 * These shapes are the stable API; Messenger's own payload formats never leak into them.
 */

export interface Mention {
  readonly userId: string;
  /** Offset in UTF-16 code units, i.e. JavaScript string indices into `text`. */
  readonly offset: number;
  readonly length: number;
  /** Raw mention type as sent by Messenger (meaning not fully documented). */
  readonly type: string;
}

export interface MessageReference {
  readonly messageId: string;
  readonly senderId?: string;
  /** Text (or snippet) of the replied-to message, as sent by Messenger. */
  readonly text?: string;
}

export interface Message {
  readonly id: string;
  readonly threadId: string;
  readonly senderId: string;
  /**
   * Message text. `null` when the message has no text: for example a photo, sticker or
   * file (attachment details are not reported yet).
   */
  readonly text: string | null;
  /** Server timestamp, milliseconds since the Unix epoch. */
  readonly timestamp: number;
  readonly isFromMe: boolean;
  /** "admin" for system notices such as "X named the group". */
  readonly kind: "user" | "admin";
  readonly mentions: readonly Mention[];
  readonly replyTo?: MessageReference;
  readonly isForwarded: boolean;
  readonly editCount: number;
  readonly stickerId?: string;
  /** Client-generated id that the sender's device attached (useful to match own sends). */
  readonly offlineThreadingId?: string;
  /**
   * true when the message was delivered by catch-up synchronization (after a reconnect or
   * by periodic reconciliation) rather than pushed live.
   */
  readonly recovered: boolean;
}

export interface MessageEditEvent {
  readonly messageId: string;
  /** Known when the edited message was seen by this client; edits do not carry a thread id. */
  readonly threadId: string | undefined;
  readonly text: string;
  readonly editCount: number;
  readonly recovered: boolean;
}

export interface MessageDeleteEvent {
  readonly messageId: string;
  readonly threadId: string;
  /** "unsent": removed for everyone. "removed": the message disappeared (exact cause not reported). */
  readonly reason: "unsent" | "removed";
  readonly recovered: boolean;
}

export interface ReactionEvent {
  readonly messageId: string;
  readonly threadId: string;
  readonly actorId: string;
  /** The emoji. For removals, the previous reaction when known. */
  readonly reaction: string | undefined;
  readonly isFromMe: boolean;
  readonly recovered: boolean;
}

export interface TypingEvent {
  readonly threadId: string;
  readonly userId: string;
  readonly isTyping: boolean;
}
