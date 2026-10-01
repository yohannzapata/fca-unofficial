/**
 * Lightspeed request builders and sync-cursor rules (protocol-status.md §3.4–3.5). Expected
 * strings are hand-written from the documented field order; all values are synthetic.
 */
import { describe, expect, it } from "vitest";
import { ProtocolError } from "../../src/errors/errors.js";
import {
  buildDatabaseQuery,
  buildEnvelope,
  buildTaskBatch,
  createEpochIdGenerator,
  fetchThreadsTask,
  LsRequestType,
  parseLsResponse,
} from "../../src/protocol/lightspeed/requests.js";
import { gatewayUrl } from "../../src/protocol/realtime/realtime-session.js";
import {
  applyFirstBlock,
  INITIAL_SYNC_STATE,
  restoreSyncState,
  SYNC_DATABASES,
  type SyncDatabaseState,
  syncParamsFor,
} from "../../src/protocol/sync/sync-state.js";

const VERSION = "9123456789012345678"; // > 2^53: must survive as raw digits

describe("Lightspeed requests", () => {
  it("epoch ids encode (ms << 22) | (counter << 12) | 42, exactly", () => {
    let now = 1_700_000_000_000;
    const next = createEpochIdGenerator(() => now);
    const base = (1_700_000_000_000n << 22n) | 42n;
    expect(next()).toBe(base.toString());
    expect(next()).toBe((base | (1n << 12n)).toString()); // same millisecond → counter 1
    expect(next()).toBe((base | (2n << 12n)).toString());
    now += 1;
    expect(next()).toBe(((1_700_000_000_001n << 22n) | 42n).toString()); // counter resets
    expect(BigInt(next())).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it("builds a cursor query with 64-bit values as raw JSON digits", () => {
    const json = buildDatabaseQuery({
      database: 1,
      version: VERSION,
      epochId: "7130000000000004138",
      lastAppliedCursor: 'abc"d',
    });
    expect(json).toBe(
      `{"database":1,"last_applied_cursor":"abc\\"d","sync_params":null,"epoch_id":7130000000000004138,"version":${VERSION},"failure_count":null}`,
    );
    // JSON.parse would lose precision; the text keeps every digit
    expect(json).toContain(`"version":${VERSION},`);
  });

  it("builds a first-sync and a sync-params query", () => {
    expect(buildDatabaseQuery({ database: 95, version: "1", epochId: "2", lastAppliedCursor: null })).toBe(
      `{"database":95,"last_applied_cursor":null,"sync_params":null,"epoch_id":2,"version":1,"failure_count":null}`,
    );
    expect(
      buildDatabaseQuery({ database: 2, version: "1", epochId: "2", syncParams: '{"locale":"en_US"}' }),
    ).toBe(
      `{"database":2,"last_applied_cursor":null,"sync_params":"{\\"locale\\":\\"en_US\\"}","epoch_id":2,"version":1,"failure_count":null}`,
    );
  });

  it("rejects non-integer 64-bit fields rather than emitting invalid JSON", () => {
    expect(() => buildDatabaseQuery({ database: 1, version: "1e5", epochId: "1" })).toThrow(RangeError);
    expect(() => buildDatabaseQuery({ database: 1, version: "1", epochId: "1,2" })).toThrow(RangeError);
    expect(() => buildTaskBatch({ epochId: "1", versionId: "x", tasks: [] })).toThrow(RangeError);
  });

  it("builds the thread-list task batch", () => {
    const json = buildTaskBatch({
      epochId: "5",
      versionId: VERSION,
      tasks: [
        fetchThreadsTask({ syncGroup: 1, cursor: "c1", taskId: 0 }),
        fetchThreadsTask({ syncGroup: 95, cursor: null, taskId: 1 }),
      ],
    });
    const parsed = JSON.parse(json) as {
      epoch_id: number;
      version_id: string;
      tasks: { label: string; queue_name: string; task_id: number; payload: string }[];
    };
    expect(parsed.version_id).toBe(VERSION);
    expect(parsed.tasks.map((t) => [t.label, t.queue_name, t.task_id])).toEqual([
      ["145", "trq", 0],
      ["145", "trq", 1],
    ]);
    expect(JSON.parse(parsed.tasks[0]!.payload)).toMatchObject({
      cursor: "c1",
      sync_group: 1,
      is_after: 0,
      parent_thread_key: -1,
    });
    expect(JSON.parse(parsed.tasks[1]!.payload)).toMatchObject({ cursor: null, sync_group: 95 });
    expect(json.startsWith(`{"epoch_id":5,"tasks":[{"failure_count":null,"label":"145",`)).toBe(true);
  });

  it("wraps payloads in the request envelope and validates request ids", () => {
    expect(
      buildEnvelope({ appId: "123", payload: "{}", requestId: 7, type: LsRequestType.SyncWithCursor }),
    ).toBe(`{"app_id":"123","payload":"{}","request_id":7,"type":2}`);
    expect(() => buildEnvelope({ appId: "1", payload: "", requestId: 0, type: 1 })).toThrow(RangeError);
    expect(() => buildEnvelope({ appId: "1", payload: "", requestId: 65_536, type: 1 })).toThrow(RangeError);
  });

  it("parses responses and live pushes", () => {
    expect(parseLsResponse(`{"request_id":3,"payload":"{\\"step\\":[]}","sp":["a",1],"target":0}`)).toEqual({
      requestId: 3,
      payload: `{"step":[]}`,
      dependencies: ["a"],
    });
    expect(parseLsResponse(`{"payload":"","sp":null}`)).toEqual({
      requestId: undefined,
      payload: undefined,
      dependencies: [],
    });
    expect(() => parseLsResponse("not json")).toThrow(ProtocolError);
    expect(() => parseLsResponse("[1]")).toThrow(ProtocolError);
  });

  it("builds the gateway URL with sorted x-dgw-* parameters", () => {
    const url = new URL(
      gatewayUrl("wss://gateway.facebook.com/ws/lightspeed", { appId: "A", userId: "U", deviceId: "D" }),
    );
    expect(url.origin + url.pathname).toBe("wss://gateway.facebook.com/ws/lightspeed");
    const keys = [...url.searchParams.keys()];
    expect(keys).toEqual([...keys].sort());
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      "x-dgw-appid": "A",
      "x-dgw-appversion": "0",
      "x-dgw-authtype": "1:0",
      "x-dgw-deviceid": "D",
      "x-dgw-tier": "prod",
      "x-dgw-uuid": "U",
      "x-dgw-version": "5",
    });
    expect(url.searchParams.get("x-dgw-loggingid")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("sync cursor state", () => {
  const db1: SyncDatabaseState = { cursor: null, sendSyncParams: false, syncChannel: 1 };

  it("starts from the reference client's per-database settings", () => {
    expect(SYNC_DATABASES).toEqual([1, 2, 95, 104]);
    expect(INITIAL_SYNC_STATE[2]).toEqual({ cursor: null, sendSyncParams: true, syncChannel: 2 });
    expect(INITIAL_SYNC_STATE[104]).toEqual({ cursor: null, sendSyncParams: true, syncChannel: 0 });
  });

  it("advances only to a new, real cursor", () => {
    expect(applyFirstBlock(db1, { currentCursor: "", nextCursor: "c1" })).toEqual({
      advanced: true,
      state: { ...db1, cursor: "c1" },
    });
    const at = { ...db1, cursor: "c1" };
    expect(applyFirstBlock(at, { currentCursor: "c1", nextCursor: "c1" }).advanced).toBe(false);
    expect(applyFirstBlock(at, { currentCursor: "c0", nextCursor: "c1" }).advanced).toBe(false); // equals stored
    expect(applyFirstBlock(at, { currentCursor: "c2", nextCursor: "c2" })).toEqual({
      advanced: false,
      state: at,
    }); // no progress
    expect(applyFirstBlock(at, { currentCursor: "c1", nextCursor: "" }).state.cursor).toBe("c1");
    expect(applyFirstBlock(at, { currentCursor: "c1", nextCursor: "dummy_cursor" }).advanced).toBe(false);
    expect(applyFirstBlock(at, { currentCursor: "c1" }).advanced).toBe(false);
  });

  it("takes sendSyncParams and the sync channel from the block when present", () => {
    const { state } = applyFirstBlock(
      { cursor: null, sendSyncParams: true, syncChannel: 2 },
      { nextCursor: "c", sendSyncParams: false, syncChannel: "1" },
    );
    expect(state).toEqual({ cursor: "c", sendSyncParams: false, syncChannel: 1 });
    expect(applyFirstBlock(db1, { syncChannel: "not a number" }).state.syncChannel).toBe(1);
  });

  it("selects sync params by channel", () => {
    const params = { mailbox: "M", contact: "C", e2ee: "E" };
    expect(syncParamsFor({ ...db1, syncChannel: 1 }, params)).toBe("M");
    expect(syncParamsFor({ ...db1, syncChannel: 2 }, params)).toBe("C");
    expect(syncParamsFor({ ...db1, syncChannel: 0 }, params)).toBe("E");
    expect(syncParamsFor(db1, undefined)).toBeUndefined();
  });

  it("restores stored cursors over the defaults and drops unknown databases", () => {
    const restored = restoreSyncState({
      1: { cursor: "c1", sendSyncParams: false, syncChannel: 1 },
      7: { cursor: "x", sendSyncParams: false, syncChannel: 1 },
    });
    expect(Object.keys(restored).map(Number)).toEqual([1, 2, 95, 104]);
    expect(restored[1]?.cursor).toBe("c1");
    expect(restored[2]).toEqual(INITIAL_SYNC_STATE[2]);
    expect(restoreSyncState(undefined)).toEqual({ ...INITIAL_SYNC_STATE });
  });
});
