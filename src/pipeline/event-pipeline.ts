import type { Logger } from "../logging/logger.js";
import type {
  Mention,
  Message,
  MessageDeleteEvent,
  MessageEditEvent,
  ReactionEvent,
  TypingEvent,
} from "../model/messages.js";
import type { ParsedCall, RowOf } from "../protocol/lightspeed/procedures.js";
import type { BatchSource, RowBatch } from "../protocol/realtime/realtime-session.js";
import { BoundedCache } from "../util/bounded-cache.js";

export interface PipelineEvents {
  message: Message;
  messageEdit: MessageEditEvent;
  messageDelete: MessageDeleteEvent;
  reactionAdd: ReactionEvent;
  reactionRemove: ReactionEvent;
  typing: TypingEvent;
}

export type PipelineEmit = <K extends keyof PipelineEvents>(event: K, payload: PipelineEvents[K]) => void;

export interface EventPipelineOptions {
  /** The account's own user id (for isFromMe). */
  selfUserId: () => string | undefined;
  emit: PipelineEmit;
  logger: Logger;
  now?: () => number;
  /** Dedup memory. Defaults: 20 000 keys for 24 h. */
  dedupCapacity?: number;
  dedupTtlMs?: number;
  /** A typing indicator not refreshed within this window is reported as stopped. Default 6 s. */
  typingTimeoutMs?: number;
}

export interface PipelineStats {
  readonly batches: number;
  readonly emitted: number;
  readonly duplicatesSuppressed: number;
  readonly incompleteRows: number;
  readonly unknownProcedures: number;
}

/** Batches whose rows describe news (and may produce events). */
const NEWS: ReadonlySet<BatchSource> = new Set(["live", "sync", "reconcile"]);

type Row<N extends Exclude<ParsedCall, { unknown: true }>["procedure"]> = RowOf<N>;

/**
 * Turns protocol row batches into normalized public events (docs/architecture.md §7.3):
 *  - fixed dispatch order inside a batch, so edits/reactions never precede their message;
 *  - "baseline" and "task" batches only seed state (no events): they describe the current
 *    inbox, not news;
 *  - semantic deduplication with bounded memory: realtime pushes and catch-up syncs may
 *    deliver the same change twice, and timestamps are never used as identity.
 */
export class EventPipeline {
  readonly #options: EventPipelineOptions;
  readonly #seen: BoundedCache<string, true>;
  readonly #messageThreads: BoundedCache<string, string>;
  readonly #reactions: BoundedCache<string, string | null>;
  readonly #typing = new Map<string, ReturnType<typeof setTimeout>>();
  #stats = { batches: 0, emitted: 0, duplicatesSuppressed: 0, incompleteRows: 0, unknownProcedures: 0 };

  constructor(options: EventPipelineOptions) {
    this.#options = options;
    const now = options.now ?? Date.now;
    const ttlMs = options.dedupTtlMs ?? 24 * 60 * 60_000;
    this.#seen = new BoundedCache({ capacity: options.dedupCapacity ?? 20_000, ttlMs, now });
    this.#messageThreads = new BoundedCache({ capacity: 10_000, ttlMs, now });
    this.#reactions = new BoundedCache({ capacity: 10_000, ttlMs, now });
  }

  get stats(): PipelineStats {
    return { ...this.#stats };
  }

  /** Processes one batch. Synchronous; events are emitted in dispatch order. */
  process(batch: RowBatch): void {
    this.#stats.batches++;
    const news = NEWS.has(batch.source);
    const recovered = batch.source !== "live";
    const byProcedure = groupCalls(batch.calls);
    this.#stats.unknownProcedures += byProcedure.unknown;

    // 1. Messages: index every message (history included); only new inserts are news.
    for (const row of byProcedure.upsertMessage) this.#indexMessage(row, false, recovered);
    for (const row of byProcedure.insertMessage) this.#indexMessage(row, news, recovered);

    // 2. Edits (they carry no thread id: resolved from the index when known).
    for (const row of byProcedure.editMessage) {
      if (row.messageId === undefined || row.text === undefined) {
        this.#stats.incompleteRows++;
        continue;
      }
      const editCount = toInt(row.editCount) ?? 0;
      if (!this.#firstSighting(`e:${row.messageId}:${editCount}`) || !news) continue;
      this.#emit("messageEdit", {
        messageId: row.messageId,
        threadId: this.#messageThreads.get(row.messageId),
        text: row.text,
        editCount,
        recovered,
      });
    }

    // 3. Typing (only meaningful when pushed live).
    if (batch.source === "live") {
      for (const row of byProcedure.updateTypingIndicator) this.#typingRow(row);
    }

    // 4. Unsends and removals.
    for (const row of byProcedure.deleteThenInsertMessage) {
      if (row.isUnsent === true) this.#deleted(row.threadKey, row.messageId, "unsent", news, recovered);
    }
    for (const row of byProcedure.deleteMessage)
      this.#deleted(row.threadKey, row.messageId, "removed", news, recovered);

    // 5. Reactions.
    for (const row of byProcedure.upsertReaction) {
      if (
        row.threadKey === undefined ||
        row.messageId === undefined ||
        row.actorId === undefined ||
        row.reaction === undefined
      ) {
        this.#stats.incompleteRows++;
        continue;
      }
      const key = `${row.messageId}:${row.actorId}`;
      if (this.#reactions.get(key) === row.reaction) {
        this.#stats.duplicatesSuppressed++;
        continue;
      }
      this.#reactions.set(key, row.reaction);
      if (news)
        this.#emit(
          "reactionAdd",
          this.#reaction(row.threadKey, row.messageId, row.actorId, row.reaction, recovered),
        );
    }
    for (const row of byProcedure.deleteReaction) {
      if (row.threadKey === undefined || row.messageId === undefined || row.actorId === undefined) {
        this.#stats.incompleteRows++;
        continue;
      }
      const key = `${row.messageId}:${row.actorId}`;
      const previous = this.#reactions.get(key);
      if (previous === null) {
        this.#stats.duplicatesSuppressed++;
        continue;
      }
      this.#reactions.set(key, null);
      if (news)
        this.#emit(
          "reactionRemove",
          this.#reaction(row.threadKey, row.messageId, row.actorId, previous, recovered),
        );
    }
  }

  /** Clears timers and memory. Idempotent. */
  dispose(): void {
    for (const timer of this.#typing.values()) clearTimeout(timer);
    this.#typing.clear();
    this.#seen.clear();
    this.#messageThreads.clear();
    this.#reactions.clear();
  }

  #indexMessage(row: Row<"insertMessage">, news: boolean, recovered: boolean): void {
    const message = this.#normalizeMessage(row, recovered);
    if (!message) {
      this.#stats.incompleteRows++;
      return;
    }
    this.#messageThreads.set(message.id, message.threadId);
    if (this.#firstSighting(`m:${message.id}`) && news) this.#emit("message", message);
  }

  #normalizeMessage(row: Row<"insertMessage">, recovered: boolean): Message | undefined {
    const timestamp = toInt(row.timestampMs);
    if (
      row.messageId === undefined ||
      row.threadKey === undefined ||
      row.senderId === undefined ||
      timestamp === undefined
    ) {
      return undefined;
    }
    const self = this.#options.selfUserId();
    return {
      id: row.messageId,
      threadId: row.threadKey,
      senderId: row.senderId,
      text: row.text === undefined || row.text === "" ? null : row.text,
      timestamp,
      isFromMe: self !== undefined && row.senderId === self,
      kind: row.isAdminMessage === true ? "admin" : "user",
      mentions: parseMentions(row),
      ...(row.replySourceId
        ? {
            replyTo: {
              messageId: row.replySourceId,
              ...(row.replyToUserId === undefined ? {} : { senderId: row.replyToUserId }),
              ...((row.replyMessageText ?? row.replySnippet) === undefined
                ? {}
                : { text: (row.replyMessageText ?? row.replySnippet) as string }),
            },
          }
        : {}),
      isForwarded: row.isForwarded === true,
      editCount: toInt(row.editCount) ?? 0,
      ...(row.stickerId === undefined ? {} : { stickerId: row.stickerId }),
      ...(row.offlineThreadingId === undefined ? {} : { offlineThreadingId: row.offlineThreadingId }),
      recovered,
    };
  }

  #deleted(
    threadId: string | undefined,
    messageId: string | undefined,
    reason: "unsent" | "removed",
    news: boolean,
    recovered: boolean,
  ): void {
    if (threadId === undefined || messageId === undefined) {
      this.#stats.incompleteRows++;
      return;
    }
    if (this.#firstSighting(`d:${messageId}`) && news) {
      this.#emit("messageDelete", { messageId, threadId, reason, recovered });
    }
  }

  #typingRow(row: Row<"updateTypingIndicator">): void {
    if (row.threadKey === undefined || row.senderId === undefined || row.isTyping === undefined) {
      this.#stats.incompleteRows++;
      return;
    }
    const key = `${row.threadKey}:${row.senderId}`;
    const wasTyping = this.#typing.has(key);
    const existing = this.#typing.get(key);
    if (existing !== undefined) clearTimeout(existing);
    this.#typing.delete(key);
    const event = { threadId: row.threadKey, userId: row.senderId };
    if (row.isTyping) {
      const timeout = this.#options.typingTimeoutMs ?? 6_000;
      this.#typing.set(
        key,
        setTimeout(() => {
          this.#typing.delete(key);
          this.#emit("typing", { ...event, isTyping: false });
        }, timeout),
      );
      if (!wasTyping) this.#emit("typing", { ...event, isTyping: true });
    } else if (wasTyping) {
      this.#emit("typing", { ...event, isTyping: false });
    }
  }

  #reaction(
    threadId: string,
    messageId: string,
    actorId: string,
    reaction: string | undefined,
    recovered: boolean,
  ): ReactionEvent {
    const self = this.#options.selfUserId();
    return {
      messageId,
      threadId,
      actorId,
      reaction,
      isFromMe: self !== undefined && actorId === self,
      recovered,
    };
  }

  #firstSighting(key: string): boolean {
    if (this.#seen.addIfAbsent(key, true)) return true;
    this.#stats.duplicatesSuppressed++;
    return false;
  }

  #emit<K extends keyof PipelineEvents>(event: K, payload: PipelineEvents[K]): void {
    this.#stats.emitted++;
    try {
      this.#options.emit(event, payload);
    } catch (error) {
      // The client's emitter already isolates listener failures; this guards the pipeline itself.
      this.#options.logger.error("event emission failed", { event, error });
    }
  }
}

interface Grouped {
  insertMessage: Row<"insertMessage">[];
  upsertMessage: Row<"upsertMessage">[];
  deleteThenInsertMessage: Row<"deleteThenInsertMessage">[];
  editMessage: Row<"editMessage">[];
  deleteMessage: Row<"deleteMessage">[];
  upsertReaction: Row<"upsertReaction">[];
  deleteReaction: Row<"deleteReaction">[];
  updateTypingIndicator: Row<"updateTypingIndicator">[];
  unknown: number;
}

function groupCalls(calls: readonly ParsedCall[]): Grouped {
  const grouped: Grouped = {
    insertMessage: [],
    upsertMessage: [],
    deleteThenInsertMessage: [],
    editMessage: [],
    deleteMessage: [],
    upsertReaction: [],
    deleteReaction: [],
    updateTypingIndicator: [],
    unknown: 0,
  };
  for (const call of calls) {
    if ("unknown" in call) {
      grouped.unknown++;
      continue;
    }
    switch (call.procedure) {
      case "insertMessage":
        grouped.insertMessage.push(call.row);
        break;
      case "upsertMessage":
        grouped.upsertMessage.push(call.row);
        break;
      case "deleteThenInsertMessage":
        grouped.deleteThenInsertMessage.push(call.row);
        break;
      case "editMessage":
        grouped.editMessage.push(call.row);
        break;
      case "deleteMessage":
        grouped.deleteMessage.push(call.row);
        break;
      case "upsertReaction":
        grouped.upsertReaction.push(call.row);
        break;
      case "deleteReaction":
        grouped.deleteReaction.push(call.row);
        break;
      case "updateTypingIndicator":
        grouped.updateTypingIndicator.push(call.row);
        break;
      default:
        break;
    }
  }
  return grouped;
}

/** Parses the four parallel comma-separated mention lists; malformed data yields no mentions. */
function parseMentions(row: Row<"insertMessage">): Mention[] {
  if (!row.mentionIds) return [];
  const ids = row.mentionIds.split(",");
  const offsets = (row.mentionOffsets ?? "").split(",");
  const lengths = (row.mentionLengths ?? "").split(",");
  const types = (row.mentionTypes ?? "").split(",");
  if (offsets.length !== ids.length || lengths.length !== ids.length || types.length !== ids.length)
    return [];
  const mentions: Mention[] = [];
  for (let index = 0; index < ids.length; index++) {
    const userId = (ids[index] ?? "").trim();
    const offset = Number(offsets[index]);
    const length = Number(lengths[index]);
    if (
      !/^\d+$/.test(userId) ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0
    ) {
      return [];
    }
    mentions.push({ userId, offset, length, type: (types[index] ?? "").trim() });
  }
  return mentions;
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}
