/**
 * SYNTHETIC Lightspeed payloads. Their shape follows protocol-status.md §5 (opcodes and
 * positional arguments per mautrix/meta @ e012f9f8); the values are invented. They are
 * not recorded traffic.
 */
import { describe, expect, it } from "vitest";
import { decodeLightspeedPayload, decodeSteps, I64 } from "../../src/protocol/lightspeed/decoder.js";
import { isKnownProcedure, parseProcedureCall } from "../../src/protocol/lightspeed/procedures.js";

const i64 = (v: string) => [19, v];
const U = [9]; // undefined
const call = (name: string, ...args: unknown[]) => [5, name, ...args];

/** Builds a positional argument list from an index → value map (gaps are undefined). */
function args(fields: Record<number, unknown>, length: number): unknown[] {
  return Array.from({ length }, (_, idx) => (idx in fields ? fields[idx] : U));
}

describe("Lightspeed decoder", () => {
  it("returns stored-procedure calls in order, with 64-bit ints as exact decimal text", () => {
    const step = [
      1,
      call("updateTypingIndicator", i64("9223372036854775807"), i64("100000000000001"), true),
      call("deleteMessage", i64("5"), "mid.$x"),
    ];
    const { calls, stats } = decodeSteps(step);
    expect(calls.map((c) => c.name)).toEqual(["updateTypingIndicator", "deleteMessage"]);
    expect(calls[0]!.args[0]).toEqual(new I64("9223372036854775807"));
    expect(calls[0]!.args[2]).toBe(true);
    expect(stats.procedureCalls).toBe(2);
  });

  it("evaluates STORE/LOAD references used as arguments", () => {
    const { calls } = decodeSteps([1, [3, 0, i64("42")], call("deleteMessage", [2, 0], "mid.$y")]);
    expect(calls[0]!.args[0]).toEqual(new I64("42"));
  });

  it("follows IF only when the condition is definite, and counts skipped branches", () => {
    const definite = decodeSteps([23, i64("1"), call("a"), call("b")]);
    expect(definite.calls.map((c) => c.name)).toEqual(["a"]);
    const falsy = decodeSteps([23, false, call("a"), call("b")]);
    expect(falsy.calls.map((c) => c.name)).toEqual(["b"]);
    const unknown = decodeSteps([23, [21, "gatekeeper"], call("a"), call("b")]); // READ_GK: unsupported
    expect(unknown.calls).toEqual([]);
    expect(unknown.stats.skippedBranches).toBe(1);
    expect(unknown.stats.unsupportedOps[21]).toBe(1);
  });

  it("counts unsupported opcodes and malformed steps instead of guessing", () => {
    const { calls, stats } = decodeSteps([1, [113, "rows"], [19, "not-a-number"], [5, 123], call("ok")]);
    expect(calls.map((c) => c.name)).toEqual(["ok"]);
    expect(stats.unsupportedOps[113]).toBe(1);
    expect(stats.malformed).toBe(2);
  });

  it("supports the native array/map helpers and I64 arithmetic", () => {
    const step = [
      1,
      [3, 0, [53]],
      [55, [2, 0], "k", "v"],
      [3, 1, [51, [50], i64("7")]],
      call("p", [2, 0], [2, 1], [69, i64("2"), i64("3")], [30, i64("4"), i64("4")]),
    ];
    const { calls } = decodeSteps(step);
    expect(calls[0]!.args).toEqual([{ k: "v" }, [new I64("7")], new I64("5"), true]);
  });

  it("decodes a payload document and survives pathological nesting", () => {
    const doc = JSON.stringify({ name: "SyntheticPayload", step: [1, call("x")] });
    expect(decodeLightspeedPayload(doc)).toMatchObject({
      name: "SyntheticPayload",
      calls: [{ name: "x", args: [] }],
    });
    let deep: unknown = call("too-deep");
    for (let d = 0; d < 400; d++) deep = [1, deep];
    const result = decodeSteps(deep);
    expect(result.calls).toEqual([]);
    expect(result.stats.malformed).toBeGreaterThan(0);
  });
});

describe("procedure schemas", () => {
  it("maps insertMessage positional arguments onto a typed row", () => {
    const step = call(
      "insertMessage",
      ...args(
        {
          0: "hello",
          3: i64("100000000000099"),
          5: i64("1700000000123"),
          8: "mid.$synthetic",
          9: "7000000000000000001",
          10: i64("100000000000002"),
          12: false,
          17: false,
          23: "mid.$replied",
          43: true,
          68: i64("0"),
          75: "unmapped extra value",
        },
        82,
      ),
    );
    const parsed = parseProcedureCall(decodeSteps(step).calls[0]!);
    expect(parsed).toEqual({
      procedure: "insertMessage",
      row: {
        text: "hello",
        threadKey: "100000000000099",
        timestampMs: "1700000000123",
        messageId: "mid.$synthetic",
        offlineThreadingId: "7000000000000000001",
        senderId: "100000000000002",
        isAdminMessage: false,
        isUnsent: false,
        replySourceId: "mid.$replied",
        isForwarded: true,
        editCount: "0",
      },
      unrecognizedArgs: 1,
      typeMismatches: [],
    });
  });

  it("uses the shifted positions of deleteThenInsertMessage", () => {
    const row = parseProcedureCall(
      decodeSteps(
        call("deleteThenInsertMessage", ...args({ 8: "mid.$u", 17: true, 42: true, 67: i64("2") }, 80)),
      ).calls[0]!,
    );
    expect(row).toMatchObject({
      procedure: "deleteThenInsertMessage",
      row: { messageId: "mid.$u", isUnsent: true, isForwarded: true, editCount: "2" },
    });
  });

  it("maps edits, reactions, typing and sync cursors", () => {
    const parse = (step: unknown[]) => parseProcedureCall(decodeSteps(step).calls[0]!);
    expect(parse(call("editMessage", "mid.$e", i64("1"), "edited", i64("3")))).toMatchObject({
      row: { messageId: "mid.$e", text: "edited", editCount: "3" },
    });
    expect(
      parse(call("upsertReaction", i64("10"), i64("1700000000000"), "mid.$r", i64("20"), "👍", i64("1"))),
    ).toMatchObject({
      row: { threadKey: "10", messageId: "mid.$r", actorId: "20", reaction: "👍" },
    });
    expect(parse(call("deleteReaction", i64("10"), "mid.$r", i64("20")))).toMatchObject({
      row: { actorId: "20" },
    });
    expect(parse(call("updateTypingIndicator", i64("10"), i64("20"), true))).toMatchObject({
      row: { isTyping: true },
    });
    expect(
      parse(
        call(
          "executeFirstBlockForSyncTransactionV4",
          i64("1"),
          i64("5"),
          "cur-1",
          "cur-2",
          i64("9"),
          i64("0"),
          false,
          i64("0"),
          false,
          i64("1"),
        ),
      ),
    ).toMatchObject({
      row: {
        databaseId: "1",
        currentCursor: "cur-1",
        nextCursor: "cur-2",
        syncChannel: "1",
        sendSyncParams: false,
      },
    });
  });

  it("records type mismatches instead of coercing, and flags unknown procedures", () => {
    const parsed = parseProcedureCall({ name: "deleteMessage", args: ["not-an-i64", 12] });
    expect(parsed).toEqual({
      procedure: "deleteMessage",
      row: {},
      unrecognizedArgs: 0,
      typeMismatches: ["threadKey", "messageId"],
    });
    expect(parseProcedureCall({ name: "deleteMessage", args: [12, "mid"] })).toMatchObject({
      row: { threadKey: "12" },
    });
    expect(parseProcedureCall({ name: "somethingNew", args: [] })).toEqual({
      procedure: "somethingNew",
      unknown: true,
    });
    expect(isKnownProcedure("toString")).toBe(false);
  });
});
