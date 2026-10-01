/**
 * Builders for SYNTHETIC Lightspeed steps used in tests. Argument positions follow
 * src/protocol/lightspeed/procedures.ts (protocol-status.md §5–§6); values are invented.
 */
export type Step = unknown[];

export const i64 = (value: string | number): Step => [19, String(value)];
const U: Step = [9];

export function call(name: string, ...args: unknown[]): Step {
  return [5, name, ...args];
}

function positional(fields: Record<number, unknown>, length: number): unknown[] {
  return Array.from({ length }, (_, index) => (index in fields ? fields[index] : U));
}

export interface SyntheticMessage {
  threadKey: string;
  messageId: string;
  senderId: string;
  text?: string;
  timestampMs?: number;
  mentions?: { ids: string; offsets: string; lengths: string; types: string };
  replySourceId?: string;
  isAdminMessage?: boolean;
}

export function insertMessage(
  m: SyntheticMessage,
  procedure: "insertMessage" | "upsertMessage" = "insertMessage",
): Step {
  return call(
    procedure,
    ...positional(
      {
        0: m.text ?? "",
        3: i64(m.threadKey),
        5: i64(m.timestampMs ?? 1_700_000_000_000),
        8: m.messageId,
        9: `otid-${m.messageId}`,
        10: i64(m.senderId),
        12: m.isAdminMessage ?? false,
        17: false,
        ...(m.mentions
          ? { 19: m.mentions.offsets, 20: m.mentions.lengths, 21: m.mentions.ids, 22: m.mentions.types }
          : {}),
        ...(m.replySourceId ? { 23: m.replySourceId } : {}),
        43: false,
        68: i64(0),
      },
      82,
    ),
  );
}

export function unsend(threadKey: string, messageId: string): Step {
  return call(
    "deleteThenInsertMessage",
    ...positional({ 3: i64(threadKey), 8: messageId, 10: i64("1"), 17: true }, 80),
  );
}

export const editMessage = (messageId: string, text: string, editCount: number): Step =>
  call("editMessage", messageId, i64(1), text, i64(editCount));
export const deleteMessage = (threadKey: string, messageId: string): Step =>
  call("deleteMessage", i64(threadKey), messageId);
export const upsertReaction = (
  threadKey: string,
  messageId: string,
  actorId: string,
  reaction: string,
): Step =>
  call("upsertReaction", i64(threadKey), i64(1_700_000_000_000), messageId, i64(actorId), reaction, i64(1));
export const deleteReaction = (threadKey: string, messageId: string, actorId: string): Step =>
  call("deleteReaction", i64(threadKey), messageId, i64(actorId));
export const typing = (threadKey: string, senderId: string, isTyping: boolean): Step =>
  call("updateTypingIndicator", i64(threadKey), i64(senderId), isTyping);

export function firstBlock(database: number, currentCursor: string, nextCursor: string): Step {
  return call(
    "executeFirstBlockForSyncTransactionV4",
    i64(database),
    i64(1),
    currentCursor,
    nextCursor,
    i64(1),
    i64(0),
    false,
    i64(0),
    false,
    i64(database === 1 ? 1 : 2),
  );
}

/** A Lightspeed payload document (JSON text) running the given steps in one block. */
export function lsPayload(steps: Step[]): string {
  return JSON.stringify({ name: "SyntheticPayload", step: [1, ...steps] });
}
