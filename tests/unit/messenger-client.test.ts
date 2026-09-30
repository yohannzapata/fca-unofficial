import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessengerClient } from "../../src/client/messenger-client.js";
import {
  ClientStateError,
  ConfigurationError,
  InvalidSessionError,
  type MessengerError,
  ProtocolNotImplementedError,
  SessionCorruptedError,
  SessionExpiredError,
} from "../../src/errors/errors.js";
import type { StateChangeEvent } from "../../src/model/events.js";
import type { ProtocolClient } from "../../src/protocol/protocol-client.js";
import type { SessionData } from "../../src/session/session.js";
import { MemorySessionStore, type SessionStore } from "../../src/session/session-store.js";
import { ScriptedConnector } from "../helpers/fake-connection.js";
import { fakeFetch } from "../helpers/fake-fetch.js";
import { fakeSession } from "../helpers/fixtures.js";
import { syntheticMessagesPage } from "../helpers/synthetic-page.js";

const MESSAGES = "www.facebook.com/messages";

function fakeProtocol(scripted: ScriptedConnector): ProtocolClient & { sessions: SessionData[] } {
  const sessions: SessionData[] = [];
  return {
    sessions,
    connect: (context, signal) => {
      sessions.push(context.session);
      return scripted.connector(signal);
    },
  };
}

function observe(client: MessengerClient) {
  const states: StateChangeEvent[] = [];
  const errors: MessengerError[] = [];
  const ready: string[] = [];
  client.on("stateChange", (c) => states.push(c));
  client.on("error", (e) => errors.push(e));
  client.on("ready", (r) => ready.push(r.userId));
  return { states, errors, ready, path: () => states.map((s) => s.to).join(">") };
}

describe("MessengerClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires a session store", () => {
    expect(() => new MessengerClient({} as never)).toThrow(ConfigurationError);
    expect(() => new MessengerClient({ session: { load: () => null } as unknown as SessionStore })).toThrow(
      ConfigurationError,
    );
  });

  it("fails permanently with InvalidSessionError when the store is empty", async () => {
    const client = new MessengerClient({ session: new MemorySessionStore() });
    const obs = observe(client);
    await expect(client.connect()).rejects.toBeInstanceOf(InvalidSessionError);
    expect(client.state).toBe("failed");
    expect(obs.path()).toBe("connecting>failed");
    expect(obs.errors).toHaveLength(1);
    expect(obs.errors[0]!.code).toBe("INVALID_SESSION");
    expect(client.health().lastError?.code).toBe("INVALID_SESSION");
  });

  it("connect() validates the session, then fails honestly (no realtime yet)", async () => {
    const { fetch, requests } = fakeFetch({ [MESSAGES]: { body: syntheticMessagesPage() } });
    const client = new MessengerClient({ session: new MemorySessionStore(fakeSession()) }, { fetch });
    const error = await client.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProtocolNotImplementedError);
    expect((error as ProtocolNotImplementedError).message).toContain("Session verified");
    expect(client.state).toBe("failed");
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(client.health().connects).toBe(0); // no retry loop
    expect(requests).toHaveLength(1);
  });

  it("surfaces an expired session from the server as a permanent SessionExpiredError", async () => {
    const { fetch } = fakeFetch({
      [MESSAGES]: { status: 302, headers: [["location", "https://www.facebook.com/login.php"]] },
    });
    const client = new MessengerClient({ session: new MemorySessionStore(fakeSession()) }, { fetch });
    const obs = observe(client);
    await expect(client.connect()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(client.state).toBe("failed");
    expect(obs.errors.map((e) => e.code)).toEqual(["SESSION_EXPIRED"]);
  });

  it("retries transient server errors during bootstrap with backoff", async () => {
    const { fetch, requests } = fakeFetch({
      [MESSAGES]: [{ status: 503 }, { status: 503 }, { status: 503 }, { body: syntheticMessagesPage() }],
    });
    const client = new MessengerClient(
      { session: new MemorySessionStore(fakeSession()) },
      { fetch, random: () => 0.5 },
    );
    const result = client.connect().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toBeInstanceOf(ProtocolNotImplementedError);
    expect(requests.length).toBeGreaterThanOrEqual(4);
  });

  it("persists cookies rotated during connect when disconnecting", async () => {
    const store = new MemorySessionStore(fakeSession());
    const { fetch } = fakeFetch({
      [MESSAGES]: {
        body: syntheticMessagesPage(),
        headers: [["set-cookie", "fr=ROTATED; Max-Age=7776000; Path=/; Domain=.facebook.com; Secure"]],
      },
    });
    const client = new MessengerClient({ session: store }, { fetch });
    await client.connect().catch(() => undefined);
    await client.disconnect();
    expect((await store.load())?.cookies.find((c) => c.name === "fr")?.value).toBe("ROTATED");
  });

  it("surfaces a corrupted session store as a permanent failure", async () => {
    const store: SessionStore = {
      load: () => Promise.reject(new SessionCorruptedError("bad checksum")),
      save: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    };
    const client = new MessengerClient({ session: store });
    await expect(client.connect()).rejects.toBeInstanceOf(SessionCorruptedError);
    expect(client.state).toBe("failed");
  });

  it("connects, emits ready once, reconnects after loss, and reports health", async () => {
    const scripted = new ScriptedConnector();
    const protocol = fakeProtocol(scripted);
    const client = new MessengerClient(
      { session: new MemorySessionStore(fakeSession()) },
      { protocol, random: () => 0.5 },
    );
    const obs = observe(client);

    await client.connect();
    expect(client.state).toBe("connected");
    expect(obs.ready).toEqual(["100000000000001"]);
    expect(protocol.sessions[0]!.userId).toBe("100000000000001");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.health()).toMatchObject({
      state: "connected",
      connects: 1,
      reconnects: 0,
      uptimeMs: 5_000,
    });

    scripted.last!.drop("network_lost");
    await vi.advanceTimersByTimeAsync(750);
    expect(client.state).toBe("connected");
    expect(obs.ready).toHaveLength(1); // ready is not re-emitted on reconnect
    expect(obs.path()).toBe("connecting>connected>reconnecting>connected");
    expect(client.health()).toMatchObject({ connects: 2, reconnects: 1 });
    expect(client.health().eventCounts).toMatchObject({ stateChange: 4, ready: 1 });

    await client.disconnect();
    expect(client.state).toBe("disconnected");
  });

  it("disconnect() and destroy() are idempotent; destroy() is terminal", async () => {
    const scripted = new ScriptedConnector();
    const client = new MessengerClient(
      { session: new MemorySessionStore(fakeSession()) },
      { protocol: fakeProtocol(scripted) },
    );
    const obs = observe(client);
    await client.connect();

    await Promise.all([client.disconnect(), client.disconnect()]);
    await client.disconnect();
    expect(scripted.connections[0]!.closeCalls).toBe(1);

    await client.connect();
    const d1 = client.destroy();
    const d2 = client.destroy();
    expect(d2).toBe(d1);
    await d1;
    expect(client.destroyed).toBe(true);
    expect(client.state).toBe("disconnected");
    expect(obs.states.at(-1)?.to).toBe("disconnected"); // listeners saw the final transition
    await expect(client.connect()).rejects.toBeInstanceOf(ClientStateError);
    expect(() => client.on("error", () => undefined)).toThrow(ClientStateError);
    await client.disconnect(); // still safe
    expect(client.health().destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("destroy() while reconnecting cancels the pending retry", async () => {
    const scripted = new ScriptedConnector();
    const client = new MessengerClient(
      { session: new MemorySessionStore(fakeSession()) },
      { protocol: fakeProtocol(scripted) },
    );
    await client.connect();
    scripted.last!.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.state).toBe("reconnecting");
    await client.destroy();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(scripted.calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a throwing listener is reported as an error event and does not break the lifecycle", async () => {
    const scripted = new ScriptedConnector();
    const client = new MessengerClient(
      { session: new MemorySessionStore(fakeSession()) },
      { protocol: fakeProtocol(scripted) },
    );
    const errors: MessengerError[] = [];
    client.on("error", (e) => errors.push(e));
    client.on("stateChange", () => {
      throw new Error("app bug");
    });
    await client.connect();
    expect(client.state).toBe("connected");
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors[0]!.message).toContain("app bug");
    await client.disconnect();
  });

  it("a throwing error listener does not recurse or crash", async () => {
    const client = new MessengerClient({ session: new MemorySessionStore() });
    client.on("error", () => {
      throw new Error("error handler bug");
    });
    await expect(client.connect()).rejects.toBeInstanceOf(InvalidSessionError);
    expect(client.state).toBe("failed");
  });

  it("re-reads the store on a new run, so a re-imported session is picked up", async () => {
    const store = new MemorySessionStore();
    const scripted = new ScriptedConnector();
    const protocol = fakeProtocol(scripted);
    const client = new MessengerClient({ session: store }, { protocol });
    await expect(client.connect()).rejects.toBeInstanceOf(InvalidSessionError);
    await store.save(fakeSession());
    await client.connect();
    expect(client.state).toBe("connected");
    expect(protocol.sessions).toHaveLength(1);
    await client.destroy();
  });
});
