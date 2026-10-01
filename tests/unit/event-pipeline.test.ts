/**
 * EventPipeline over SYNTHETIC Lightspeed rows (tests/helpers/ls-builders.ts); the rows go
 * through the real decoder and procedure parser, so argument positions are exercised too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../src/logging/logger.js";
import { EventPipeline, type PipelineEvents } from "../../src/pipeline/event-pipeline.js";
import { decodeLightspeedPayload } from "../../src/protocol/lightspeed/decoder.js";
import { parseProcedureCall } from "../../src/protocol/lightspeed/procedures.js";
import type { BatchSource, RowBatch } from "../../src/protocol/realtime/realtime-session.js";
import {
  call,
  deleteMessage,
  deleteReaction,
  editMessage,
  insertMessage,
  lsPayload,
  type Step,
  typing,
  unsend,
  upsertReaction,
} from "../helpers/ls-builders.js";

const SELF = "100000000000001";
const FRIEND = "100000000000002";
const THREAD = "200000000000001";

function batch(source: BatchSource, steps: Step[]): RowBatch {
  const decoded = decodeLightspeedPayload(lsPayload(steps));
  return { source, database: 1, calls: decoded.calls.map(parseProcedureCall), decodeStats: decoded.stats };
}

type Recorded = { [K in keyof PipelineEvents]: [K, PipelineEvents[K]] }[keyof PipelineEvents];

function setup(options: { now?: () => number; dedupCapacity?: number; dedupTtlMs?: number } = {}) {
  const events: Recorded[] = [];
  const pipeline = new EventPipeline({
    selfUserId: () => SELF,
    emit: (event, payload) => {
      events.push([event, payload] as Recorded);
    },
    logger: silentLogger,
    typingTimeoutMs: 6_000,
    ...options,
  });
  return { pipeline, events, names: () => events.map(([name]) => name) };
}

const msg = (id: string, extra: Partial<Parameters<typeof insertMessage>[0]> = {}) =>
  insertMessage({ threadKey: THREAD, messageId: id, senderId: FRIEND, text: `text of ${id}`, ...extra });

describe("EventPipeline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes a new message", () => {
    const { pipeline, events } = setup();
    pipeline.process(
      batch("live", [
        msg("mid.$1", {
          text: "hi @Sam and @Ana",
          timestampMs: 1_700_000_000_123,
          mentions: { ids: "100000000000003,100000000000004", offsets: "3,12", lengths: "4,4", types: "p,p" },
          replySourceId: "mid.$0",
        }),
      ]),
    );
    expect(events).toEqual([
      [
        "message",
        {
          id: "mid.$1",
          threadId: THREAD,
          senderId: FRIEND,
          text: "hi @Sam and @Ana",
          timestamp: 1_700_000_000_123,
          isFromMe: false,
          kind: "user",
          mentions: [
            { userId: "100000000000003", offset: 3, length: 4, type: "p" },
            { userId: "100000000000004", offset: 12, length: 4, type: "p" },
          ],
          replyTo: { messageId: "mid.$0" },
          isForwarded: false,
          editCount: 0,
          offlineThreadingId: "otid-mid.$1",
          recovered: false,
        },
      ],
    ]);
  });

  it("marks own messages, admin messages, and empty text", () => {
    const { pipeline, events } = setup();
    pipeline.process(
      batch("live", [
        insertMessage({ threadKey: THREAD, messageId: "mid.$own", senderId: SELF, text: "" }),
        insertMessage({ threadKey: THREAD, messageId: "mid.$adm", senderId: FRIEND, isAdminMessage: true }),
      ]),
    );
    expect(events.map(([, e]) => e)).toMatchObject([
      { id: "mid.$own", isFromMe: true, text: null },
      { id: "mid.$adm", kind: "admin" },
    ]);
  });

  it("drops malformed mention lists instead of guessing", () => {
    const { pipeline, events } = setup();
    pipeline.process(
      batch("live", [
        msg("mid.$a", { mentions: { ids: "1,2", offsets: "0", lengths: "1,1", types: "p,p" } }), // length mismatch
        msg("mid.$b", { mentions: { ids: "x", offsets: "0", lengths: "1", types: "p" } }), // non-numeric id
        msg("mid.$c", { mentions: { ids: "1", offsets: "-1", lengths: "1", types: "p" } }), // negative offset
      ]),
    );
    expect(events.map(([, e]) => ("mentions" in e ? e.mentions : undefined))).toEqual([[], [], []]);
  });

  it("baseline and task batches seed state silently; history (upsertMessage) is never news", () => {
    const { pipeline, names } = setup();
    pipeline.process(batch("baseline", [msg("mid.$1"), upsertReaction(THREAD, "mid.$1", FRIEND, "👍")]));
    pipeline.process(batch("task", [msg("mid.$2")]));
    pipeline.process(
      batch("live", [
        insertMessage({ threadKey: THREAD, messageId: "mid.$h", senderId: FRIEND }, "upsertMessage"),
      ]),
    );
    expect(names()).toEqual([]);
    // what the baseline seeded is not reported again when it re-arrives as news
    pipeline.process(
      batch("sync", [msg("mid.$1"), msg("mid.$2"), upsertReaction(THREAD, "mid.$1", FRIEND, "👍")]),
    );
    expect(names()).toEqual([]);
    expect(pipeline.stats.duplicatesSuppressed).toBe(3);
  });

  it("flags catch-up (sync/reconcile) events as recovered", () => {
    const { pipeline, events } = setup();
    pipeline.process(batch("sync", [msg("mid.$1")]));
    pipeline.process(batch("reconcile", [msg("mid.$2")]));
    pipeline.process(batch("live", [msg("mid.$3")]));
    expect(events.map(([, e]) => (e as { recovered: boolean }).recovered)).toEqual([true, true, false]);
  });

  it("suppresses duplicates across batches and sources", () => {
    const { pipeline, names } = setup();
    pipeline.process(batch("live", [msg("mid.$1"), editMessage("mid.$1", "v2", 1)]));
    pipeline.process(batch("sync", [msg("mid.$1"), editMessage("mid.$1", "v2", 1)]));
    pipeline.process(batch("live", [msg("mid.$1")]));
    expect(names()).toEqual(["message", "messageEdit"]);
    pipeline.process(batch("live", [editMessage("mid.$1", "v3", 2)]));
    expect(names()).toEqual(["message", "messageEdit", "messageEdit"]);
  });

  it("dispatches in a fixed order within a batch, resolving an edit's thread from the message", () => {
    const { pipeline, events, names } = setup();
    // rows arrive "out of order": the reaction and edit precede the message in the payload
    pipeline.process(
      batch("live", [
        upsertReaction(THREAD, "mid.$1", FRIEND, "😂"),
        editMessage("mid.$1", "fixed", 1),
        msg("mid.$1"),
      ]),
    );
    expect(names()).toEqual(["message", "messageEdit", "reactionAdd"]);
    expect(events[1]).toEqual([
      "messageEdit",
      { messageId: "mid.$1", threadId: THREAD, text: "fixed", editCount: 1, recovered: false },
    ]);
  });

  it("reports an edit of an unknown message without a thread id", () => {
    const { pipeline, events } = setup();
    pipeline.process(batch("live", [editMessage("mid.$unknown", "x", 1)]));
    expect(events).toEqual([
      [
        "messageEdit",
        { messageId: "mid.$unknown", threadId: undefined, text: "x", editCount: 1, recovered: false },
      ],
    ]);
  });

  it("distinguishes unsends from removals and reports each once", () => {
    const { pipeline, events } = setup();
    pipeline.process(
      batch("live", [
        unsend(THREAD, "mid.$1"),
        deleteMessage(THREAD, "mid.$1"),
        deleteMessage(THREAD, "mid.$2"),
      ]),
    );
    pipeline.process(batch("sync", [deleteMessage(THREAD, "mid.$2")]));
    expect(events).toEqual([
      ["messageDelete", { messageId: "mid.$1", threadId: THREAD, reason: "unsent", recovered: false }],
      ["messageDelete", { messageId: "mid.$2", threadId: THREAD, reason: "removed", recovered: false }],
    ]);
  });

  it("ignores deleteThenInsertMessage rows that are not unsends", () => {
    const { pipeline, names } = setup();
    // the same row as an unsend, with the isUnsent argument (index 17) false
    const args = unsend(THREAD, "mid.$1").slice(2);
    const notUnsent = call("deleteThenInsertMessage", ...args.map((v, i) => (i === 17 ? false : v)));
    pipeline.process(batch("live", [notUnsent]));
    expect(names()).toEqual([]);
  });

  it("tracks reaction state: add, change, repeat, remove, repeated remove", () => {
    const { pipeline, events } = setup();
    pipeline.process(batch("live", [upsertReaction(THREAD, "mid.$1", FRIEND, "👍")]));
    pipeline.process(batch("live", [upsertReaction(THREAD, "mid.$1", FRIEND, "👍")])); // repeat
    pipeline.process(batch("live", [upsertReaction(THREAD, "mid.$1", FRIEND, "❤️")])); // change
    pipeline.process(batch("live", [deleteReaction(THREAD, "mid.$1", FRIEND)]));
    pipeline.process(batch("sync", [deleteReaction(THREAD, "mid.$1", FRIEND)])); // repeat
    pipeline.process(batch("live", [upsertReaction(THREAD, "mid.$1", SELF, "👍")]));
    expect(events).toEqual([
      [
        "reactionAdd",
        {
          messageId: "mid.$1",
          threadId: THREAD,
          actorId: FRIEND,
          reaction: "👍",
          isFromMe: false,
          recovered: false,
        },
      ],
      [
        "reactionAdd",
        {
          messageId: "mid.$1",
          threadId: THREAD,
          actorId: FRIEND,
          reaction: "❤️",
          isFromMe: false,
          recovered: false,
        },
      ],
      [
        "reactionRemove",
        {
          messageId: "mid.$1",
          threadId: THREAD,
          actorId: FRIEND,
          reaction: "❤️",
          isFromMe: false,
          recovered: false,
        },
      ],
      [
        "reactionAdd",
        {
          messageId: "mid.$1",
          threadId: THREAD,
          actorId: SELF,
          reaction: "👍",
          isFromMe: true,
          recovered: false,
        },
      ],
    ]);
  });

  it("reports removal of a reaction it never saw, with the reaction unknown", () => {
    const { pipeline, events } = setup();
    pipeline.process(batch("live", [deleteReaction(THREAD, "mid.$1", FRIEND)]));
    expect(events).toEqual([
      [
        "reactionRemove",
        {
          messageId: "mid.$1",
          threadId: THREAD,
          actorId: FRIEND,
          reaction: undefined,
          isFromMe: false,
          recovered: false,
        },
      ],
    ]);
  });

  it("reports typing on change only, and infers a stop when not refreshed", async () => {
    const { pipeline, events } = setup();
    const t = (on: boolean) => batch("live", [typing(THREAD, FRIEND, on)]);
    pipeline.process(t(true));
    await vi.advanceTimersByTimeAsync(4_000);
    pipeline.process(t(true)); // refresh: no event, timer restarts
    await vi.advanceTimersByTimeAsync(4_000);
    expect(events).toEqual([["typing", { threadId: THREAD, userId: FRIEND, isTyping: true }]]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events.at(-1)).toEqual(["typing", { threadId: THREAD, userId: FRIEND, isTyping: false }]);
    pipeline.process(t(false)); // already stopped: no event
    expect(events).toHaveLength(2);

    pipeline.process(t(true));
    pipeline.process(t(false));
    expect(events.slice(2).map(([, e]) => (e as { isTyping: boolean }).isTyping)).toEqual([true, false]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores typing rows outside live pushes", () => {
    const { pipeline, names } = setup();
    pipeline.process(batch("sync", [typing(THREAD, FRIEND, true)]));
    expect(names()).toEqual([]);
  });

  it("counts incomplete rows and unknown procedures instead of emitting partial events", () => {
    const { pipeline, names } = setup();
    pipeline.process(
      batch("live", [
        call("insertMessage", "text only"),
        call("editMessage", "mid.$1"),
        call("upsertReaction", [19, THREAD]),
        call("someFutureProcedure", 1, 2),
      ]),
    );
    expect(names()).toEqual([]);
    expect(pipeline.stats).toMatchObject({ incompleteRows: 3, unknownProcedures: 1, emitted: 0, batches: 1 });
  });

  it("dedup memory is bounded and expires", () => {
    let now = 0;
    const { pipeline, names } = setup({ now: () => now, dedupCapacity: 2, dedupTtlMs: 1_000 });
    pipeline.process(batch("live", [msg("mid.$1"), msg("mid.$2"), msg("mid.$3")]));
    pipeline.process(batch("live", [msg("mid.$1")])); // evicted by capacity: reported again
    expect(names()).toHaveLength(4);
    now = 5_000;
    pipeline.process(batch("live", [msg("mid.$1")])); // expired: reported again
    expect(names()).toHaveLength(5);
  });

  it("isolates a failing emit and keeps processing", () => {
    const seen: string[] = [];
    const pipeline = new EventPipeline({
      selfUserId: () => SELF,
      emit: (event) => {
        seen.push(event);
        if (event === "message") throw new Error("listener bug");
      },
      logger: silentLogger,
    });
    pipeline.process(batch("live", [msg("mid.$1"), editMessage("mid.$1", "v2", 1)]));
    expect(seen).toEqual(["message", "messageEdit"]);
  });

  it("dispose() clears pending typing timers and is idempotent", () => {
    const { pipeline, events } = setup();
    pipeline.process(batch("live", [typing(THREAD, FRIEND, true)]));
    expect(vi.getTimerCount()).toBe(1);
    pipeline.dispose();
    pipeline.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(events).toHaveLength(1);
  });
});
