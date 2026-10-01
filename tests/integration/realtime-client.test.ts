/**
 * End-to-end client tests against SYNTHETIC peers: the bootstrap page comes from
 * tests/helpers/synthetic-page.ts (via a fake fetch) and the gateway is a local WebSocket
 * server (tests/helpers/fake-gateway.ts). Nothing here is recorded Facebook traffic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessengerClient } from "../../src/client/messenger-client.js";
import { HttpStatusError, ProtocolError } from "../../src/errors/errors.js";
import type {
  Message,
  MessageDeleteEvent,
  MessageEditEvent,
  ReactionEvent,
  TypingEvent,
} from "../../src/model/messages.js";
import { MemorySessionStore } from "../../src/session/session-store.js";
import { FakeGateway } from "../helpers/fake-gateway.js";
import { fakeFetch, type FakeRoute } from "../helpers/fake-fetch.js";
import { fakeSession } from "../helpers/fixtures.js";
import {
  deleteMessage,
  deleteReaction,
  editMessage,
  insertMessage,
  typing,
  unsend,
  upsertReaction,
} from "../helpers/ls-builders.js";
import { SYNTH, syntheticMessagesPage } from "../helpers/synthetic-page.js";

const SELF = "100000000000001";
const FRIEND = "100000000000002";
const THREAD = "200000000000001";
const MESSAGES = "www.facebook.com/messages";

let gateway: FakeGateway;
const clients: MessengerClient[] = [];

beforeEach(async () => {
  gateway = await FakeGateway.start();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.destroy()));
  await gateway.stop();
});

function makeClient(
  store = new MemorySessionStore(fakeSession()),
  page: FakeRoute | FakeRoute[] = { body: syntheticMessagesPage() },
) {
  const { fetch, requests } = fakeFetch({ [MESSAGES]: page });
  const client = new MessengerClient(
    { session: store, reconnect: { initialDelayMs: 20, maxDelayMs: 50 } },
    {
      fetch,
      saveDebounceMs: 0,
      typingTimeoutMs: 150,
      realtime: { gatewayUrl: gateway.url, pingIntervalMs: 200, reconcileIntervalMs: 0 },
    },
  );
  clients.push(client);
  const events = {
    message: [] as Message[],
    messageEdit: [] as MessageEditEvent[],
    messageDelete: [] as MessageDeleteEvent[],
    reactionAdd: [] as ReactionEvent[],
    reactionRemove: [] as ReactionEvent[],
    typing: [] as TypingEvent[],
    states: [] as string[],
  };
  client.on("message", (m) => events.message.push(m));
  client.on("messageEdit", (e) => events.messageEdit.push(e));
  client.on("messageDelete", (e) => events.messageDelete.push(e));
  client.on("reactionAdd", (e) => events.reactionAdd.push(e));
  client.on("reactionRemove", (e) => events.reactionRemove.push(e));
  client.on("typing", (e) => events.typing.push(e));
  client.on("stateChange", (c) => events.states.push(c.to));
  return { client, store, events, requests };
}

describe("realtime receiving (synthetic gateway)", () => {
  it("connects: thread fetch, then syncs all four databases following cursors", async () => {
    const { client } = makeClient();
    await client.connect();
    expect(client.state).toBe("connected");
    expect(gateway.taskRequests).toEqual([1]);
    const firstSyncs = gateway.queries
      .filter((q) => q.lastAppliedCursor === null)
      .map((q) => q.database)
      .sort((a, b) => a - b);
    expect(firstSyncs).toEqual([1, 2, 95, 104]);
    // each database re-queried once from its new cursor, then stopped
    for (const db of [1, 2, 95, 104]) {
      expect(gateway.queries.filter((q) => q.database === db).map((q) => q.lastAppliedCursor)).toEqual([
        null,
        `cur-${db}`,
      ]);
    }
    // databases 2 and 104 start with sync params (type 1), then switch to cursors (type 2)
    expect(gateway.queries.find((q) => q.database === 2)?.type).toBe(1);
    expect(gateway.queries.find((q) => q.database === 1)?.type).toBe(2);
  });

  it("does not report the initial inbox (baseline) as new messages, then reports live pushes once", async () => {
    gateway.baseline.set(1, [
      insertMessage({ threadKey: THREAD, messageId: "mid.$old", senderId: FRIEND, text: "old news" }),
    ]);
    const { client, events } = makeClient();
    await client.connect();
    expect(events.message).toEqual([]);

    const live = insertMessage({
      threadKey: THREAD,
      messageId: "mid.$new",
      senderId: FRIEND,
      text: "hello @me",
      timestampMs: 1_700_000_001_000,
      mentions: { ids: SELF, offsets: "6", lengths: "3", types: "p" },
      replySourceId: "mid.$old",
    });
    gateway.push(1, [live]);
    gateway.push(1, [live]); // duplicate delivery
    gateway.push(1, [insertMessage({ threadKey: THREAD, messageId: "mid.$old", senderId: FRIEND })]); // already seen
    await expect.poll(() => events.message.length).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(events.message).toEqual([
      {
        id: "mid.$new",
        threadId: THREAD,
        senderId: FRIEND,
        text: "hello @me",
        timestamp: 1_700_000_001_000,
        isFromMe: false,
        kind: "user",
        mentions: [{ userId: SELF, offset: 6, length: 3, type: "p" }],
        replyTo: { messageId: "mid.$old" },
        isForwarded: false,
        editCount: 0,
        offlineThreadingId: "otid-mid.$new",
        recovered: false,
      },
    ]);
    expect(client.health().events.duplicatesSuppressed).toBeGreaterThanOrEqual(2);
  });

  it("reports own messages, edits, unsends, reactions and typing from live pushes", async () => {
    const { client, events } = makeClient();
    await client.connect();
    gateway.push(1, [
      insertMessage({ threadKey: THREAD, messageId: "mid.$a", senderId: SELF, text: "mine" }),
      editMessage("mid.$a", "mine (edited)", 1),
      upsertReaction(THREAD, "mid.$a", FRIEND, "❤️"),
      typing(THREAD, FRIEND, true),
    ]);
    await expect.poll(() => events.typing.length).toBe(1);
    expect(events.message[0]).toMatchObject({ id: "mid.$a", isFromMe: true });
    expect(events.messageEdit).toEqual([
      { messageId: "mid.$a", threadId: THREAD, text: "mine (edited)", editCount: 1, recovered: false },
    ]);
    expect(events.reactionAdd).toEqual([
      {
        messageId: "mid.$a",
        threadId: THREAD,
        actorId: FRIEND,
        reaction: "❤️",
        isFromMe: false,
        recovered: false,
      },
    ]);
    expect(events.typing).toEqual([{ threadId: THREAD, userId: FRIEND, isTyping: true }]);
    await expect.poll(() => events.typing.length, { timeout: 2_000 }).toBe(2); // inferred stop
    expect(events.typing[1]).toEqual({ threadId: THREAD, userId: FRIEND, isTyping: false });

    gateway.push(1, [
      deleteReaction(THREAD, "mid.$a", FRIEND),
      unsend(THREAD, "mid.$a"),
      deleteMessage(THREAD, "mid.$a"),
    ]);
    await expect.poll(() => events.messageDelete.length).toBe(1);
    expect(events.reactionRemove[0]).toMatchObject({ reaction: "❤️", actorId: FRIEND });
    expect(events.messageDelete).toEqual([
      { messageId: "mid.$a", threadId: THREAD, reason: "unsent", recovered: false },
    ]);
  });

  it("persists cursors and catches up from them after a dropped connection", async () => {
    const { client, store, events } = makeClient();
    await client.connect();
    gateway.push(1, [insertMessage({ threadKey: THREAD, messageId: "mid.$before", senderId: FRIEND })]);
    await expect.poll(() => events.message.length).toBe(1);

    gateway.catchUp.set(1, [
      insertMessage({ threadKey: THREAD, messageId: "mid.$before", senderId: FRIEND }), // seen before the drop
      insertMessage({ threadKey: THREAD, messageId: "mid.$missed", senderId: FRIEND, text: "while offline" }),
    ]);
    gateway.drop(4000);
    await expect
      .poll(() => events.states.filter((s) => s === "connected").length, { timeout: 3_000 })
      .toBe(2);
    await expect.poll(() => events.message.length).toBe(2);

    expect(events.message[1]).toMatchObject({ id: "mid.$missed", text: "while offline", recovered: true });
    const reconnectQueries = gateway.queries.filter((q) => q.connection === 2 && q.database === 1);
    expect(reconnectQueries[0]?.lastAppliedCursor).toBe("cur-1");
    expect(gateway.taskRequests).toEqual([1]); // the thread fetch is not repeated on reconnect

    await client.disconnect();
    expect((await store.load())?.sync?.databases["1"]).toMatchObject({ cursor: "cur-1" });
  });

  it("a new client resumes from persisted cursors (catch-up is reported as recovered)", async () => {
    const first = makeClient();
    await first.client.connect();
    await first.client.disconnect();

    gateway.catchUp.set(1, [
      insertMessage({ threadKey: THREAD, messageId: "mid.$overnight", senderId: FRIEND }),
    ]);
    const second = makeClient(first.store);
    await second.client.connect();
    expect(gateway.queries.filter((q) => q.connection === 2 && q.database === 1)[0]?.lastAppliedCursor).toBe(
      "cur-1",
    );
    await expect
      .poll(() => second.events.message.map((m) => [m.id, m.recovered]))
      .toEqual([["mid.$overnight", true]]);
  });

  it("reconciles periodically and reports messages the push stream missed", async () => {
    const { fetch } = fakeFetch({ [MESSAGES]: { body: syntheticMessagesPage() } });
    const client = new MessengerClient(
      { session: new MemorySessionStore(fakeSession()) },
      { fetch, saveDebounceMs: 0, realtime: { gatewayUrl: gateway.url, reconcileIntervalMs: 100 } },
    );
    clients.push(client);
    const messages: Message[] = [];
    client.on("message", (m) => messages.push(m));
    await client.connect();
    gateway.catchUp.set(1, [
      insertMessage({ threadKey: THREAD, messageId: "mid.$stalled", senderId: FRIEND }),
    ]);
    await expect
      .poll(() => messages.map((m) => [m.id, m.recovered]), { timeout: 2_000 })
      .toEqual([["mid.$stalled", true]]);
    expect(gateway.queries.filter((q) => q.database === 1).length).toBeGreaterThanOrEqual(3);
  });

  it("treats a gateway 4003 close as a permanent failure", async () => {
    const { client } = makeClient();
    const errors: string[] = [];
    client.on("error", (e) => errors.push(e.code));
    await client.connect();
    gateway.drop(4003);
    await expect.poll(() => client.state).toBe("failed");
    expect(client.health().lastError).toMatchObject({ code: "REALTIME", retryable: false });
    expect(errors).toEqual(["REALTIME"]);
  });

  it("fails permanently when the page lacks realtime configuration", async () => {
    const { client } = makeClient(new MemorySessionStore(fakeSession()), {
      body: syntheticMessagesPage({ omit: ["DGWWebConfig"] }),
    });
    const error = await client.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).message).toContain("dgwAppId");
    expect(client.state).toBe("failed");
  });

  it("retries transient bootstrap errors with backoff, then connects", async () => {
    const { client, requests } = makeClient(new MemorySessionStore(fakeSession()), [
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { body: syntheticMessagesPage() },
    ]);
    const states: string[] = [];
    client.on("stateChange", (c) => states.push(c.to));
    await client.connect();
    expect(client.state).toBe("connected");
    expect(states).toContain("reconnecting");
    expect(requests.length).toBe(5);
    expect(client.health().lastError?.code).toBe(new HttpStatusError(503, "x").code);
  });

  it("persists cookies rotated during bootstrap", async () => {
    const store = new MemorySessionStore(fakeSession());
    const { client } = makeClient(store, {
      body: syntheticMessagesPage(),
      headers: [["set-cookie", "fr=ROTATED; Max-Age=7776000; Path=/; Domain=.facebook.com; Secure"]],
    });
    await client.connect();
    await client.disconnect();
    expect((await store.load())?.cookies.find((c) => c.name === "fr")?.value).toBe("ROTATED");
  });

  it("sends browser headers and the sorted x-dgw-* query in the gateway handshake", async () => {
    const { client } = makeClient();
    await client.connect();
    const headers = gateway.server.upgradeHeaders[0]!;
    expect(headers["origin"]).toBe("https://www.facebook.com");
    expect(headers["user-agent"]).toBe("TestAgent/1.0");
    expect(headers["sec-fetch-site"]).toBe("same-site");
    // Session cookies are scoped to .facebook.com; the loopback test gateway must not receive them.
    expect(headers["cookie"]).toBeUndefined();
    const url = new URL(`http://x${gateway.server.upgradeUrls[0]!}`);
    expect([...url.searchParams.keys()]).toEqual([
      "x-dgw-appid",
      "x-dgw-appversion",
      "x-dgw-authtype",
      "x-dgw-deviceid",
      "x-dgw-loggingid",
      "x-dgw-tier",
      "x-dgw-uuid",
      "x-dgw-version",
    ]);
    expect(url.searchParams.get("x-dgw-appid")).toBe(SYNTH.dgwAppId);
    expect(url.searchParams.get("x-dgw-deviceid")).toBe(SYNTH.deviceClientId);
    expect(url.searchParams.get("x-dgw-uuid")).toBe(SELF);
    expect(url.searchParams.get("x-dgw-authtype")).toBe("1:0");
  });

  it("disconnect() closes the gateway connection and does not reconnect", async () => {
    const { client, events } = makeClient();
    await client.connect();
    await client.disconnect();
    expect(client.state).toBe("disconnected");
    await new Promise((r) => setTimeout(r, 150));
    expect(gateway.connections).toBe(1);
    expect(events.states.at(-1)).toBe("disconnected");
  });
});
