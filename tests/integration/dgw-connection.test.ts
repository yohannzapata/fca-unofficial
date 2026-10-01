import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigurationError,
  NetworkError,
  OperationAbortedError,
  RealtimeError,
  TimeoutError,
} from "../../src/errors/errors.js";
import { silentLogger } from "../../src/logging/logger.js";
import { DgwConnection, type DgwConnectionOptions } from "../../src/transport/dgw/dgw-connection.js";
import type { DgwFrame } from "../../src/transport/dgw/frames.js";
import { DgwTestServer, text, utf8 } from "../helpers/dgw-test-server.js";

let server: DgwTestServer;
const open: DgwConnection[] = [];

beforeEach(async () => {
  server = await DgwTestServer.start();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
  await server.stop();
});

async function connect(options: Partial<DgwConnectionOptions> = {}): Promise<DgwConnection> {
  const connection = await DgwConnection.open({
    url: server.url,
    headers: {
      cookie: "c_user=1; xs=FAKE",
      origin: "https://www.facebook.com",
      "user-agent": "TestAgent/1.0",
    },
    logger: silentLogger,
    pingIntervalMs: 50,
    inactivityTimeoutMs: 1_000,
    ackTimeoutMs: 300,
    responseTimeoutMs: 300,
    ...options,
  });
  open.push(connection);
  return connection;
}

/** A server that confirms every establish and acks every data frame that requires it. */
function cooperative(extra?: (frame: DgwFrame, s: DgwTestServer) => void) {
  server.onFrame = (frame, s) => {
    if (frame.type === "ping") s.send([{ type: "pong" }]);
    if (frame.type === "establish")
      s.send([{ type: "establish", streamId: frame.streamId, parameters: '{"code":200}' }]);
    if (frame.type === "data" && frame.requiresAck)
      s.send([{ type: "ack", streamId: frame.streamId, ackId: frame.ackId }]);
    extra?.(frame, s);
  };
}

describe("DgwConnection", () => {
  it("sends handshake headers and keeps the query string", async () => {
    await connect();
    expect(server.upgradeHeaders[0]).toMatchObject({
      cookie: "c_user=1; xs=FAKE",
      origin: "https://www.facebook.com",
      "user-agent": "TestAgent/1.0",
    });
    expect(server.upgradeUrls[0]).toBe("/ws/lightspeed?x-dgw-appid=test&x-dgw-version=5");
  });

  it("pings periodically and answers server pings", async () => {
    await connect();
    await server.waitFor((f) => f.type === "ping");
    server.send([{ type: "ping" }]);
    await server.waitFor((f) => f.type === "pong");
  });

  it("closes as heartbeat_timeout when the server goes silent", async () => {
    server.onFrame = () => undefined; // swallow pings: no traffic at all
    const connection = await connect({ inactivityTimeoutMs: 200 });
    const info = await connection.closed;
    expect(info.reason).toBe("heartbeat_timeout");
    expect(info.error?.retryable).toBe(true);
    expect(connection.isOpen).toBe(false);
  });

  it("performs a one-off request: establish + data → ack → response → our ack + end-of-data", async () => {
    cooperative((frame, s) => {
      if (frame.type === "data") {
        s.send([
          {
            type: "data",
            streamId: frame.streamId,
            ackId: 5,
            requiresAck: true,
            payload: utf8(`echo:${text(frame.payload)}`),
          },
        ]);
      }
    });
    const connection = await connect();
    const response = await connection.request(utf8("hello"));
    expect(text(response!)).toBe("echo:hello");
    const est = await server.waitFor((f) => f.type === "establish");
    const ack = await server.waitFor((f) => f.type === "ack");
    const eod = await server.waitFor((f) => f.type === "endOfData");
    expect(ack).toMatchObject({ ackId: 5 });
    expect(est.type === "establish" && eod.type === "endOfData" && est.streamId === eod.streamId).toBe(true);
    expect(connection.stats.openStreams).toBe(0);
  });

  it("allocates distinct stream ids for concurrent requests", async () => {
    cooperative((frame, s) => {
      if (frame.type === "data")
        s.send([
          { type: "data", streamId: frame.streamId, ackId: 0, requiresAck: false, payload: frame.payload },
        ]);
    });
    const connection = await connect();
    const results = await Promise.all(["a", "b", "c"].map((p) => connection.request(utf8(p))));
    expect(results.map((r) => text(r!))).toEqual(["a", "b", "c"]);
    const ids = server.received.flatMap((f) => (f.type === "establish" ? [f.streamId] : []));
    expect(new Set(ids).size).toBe(3);
  });

  it("rejects when the server refuses the stream, and on timeout", async () => {
    server.onFrame = (frame, s) => {
      if (frame.type === "establish")
        s.send([{ type: "establish", streamId: frame.streamId, parameters: '{"code":500}' }]);
    };
    const connection = await connect();
    await expect(connection.request(utf8("x"))).rejects.toThrow(/code 500/);

    server.onFrame = () => undefined;
    const error = await connection.request(utf8("y")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    await server.waitFor((f) => f.type === "endOfData"); // the abandoned stream is closed
  });

  it("supports fire-and-forget requests (no ack requested)", async () => {
    cooperative();
    const connection = await connect();
    expect(await connection.request(utf8("ff"), { expectResponse: false })).toBeUndefined();
    const data = await server.waitFor((f) => f.type === "data");
    expect(data).toMatchObject({ requiresAck: false });
  });

  it("opens a persistent stream, delivers pushes in order, and acks them after processing", async () => {
    cooperative();
    const connection = await connect();
    const received: string[] = [];
    const stream = await connection.openStream({
      initPayload: utf8("sync db 1"),
      onData: (p) => received.push(text(p)),
    });
    const init = await server.waitFor((f) => f.type === "data");
    expect(init).toMatchObject({ streamId: stream.id, requiresAck: true });

    server.send([
      { type: "data", streamId: stream.id, ackId: 100, requiresAck: true, payload: utf8("one") },
      { type: "data", streamId: stream.id, ackId: 101, requiresAck: true, payload: utf8("two") },
    ]);
    server.send([
      { type: "data", streamId: stream.id, ackId: 102, requiresAck: false, payload: utf8("three") },
    ]);
    await server.waitFor((f) => f.type === "ack" && f.ackId === 101);
    await expect.poll(() => received).toEqual(["one", "two", "three"]);
    expect(server.received.flatMap((f) => (f.type === "ack" ? [f.ackId] : []))).toEqual([100, 101]);

    await stream.send(utf8("more"));
    stream.close();
    await server.waitFor((f) => f.type === "endOfData" && f.streamId === stream.id);
  });

  it("does not ack and closes the connection when a stream handler throws", async () => {
    cooperative();
    const connection = await connect();
    const stream = await connection.openStream({
      onData: () => {
        throw new Error("bug in handler");
      },
    });
    server.send([{ type: "data", streamId: stream.id, ackId: 7, requiresAck: true, payload: utf8("x") }]);
    const info = await connection.closed;
    expect(info.reason).toBe("handler_error");
    expect(info.error?.retryable).toBe(true);
    expect(server.received.some((f) => f.type === "ack" && f.ackId === 7)).toBe(false);
  });

  it("reports a server-ended stream and acks data for unknown streams", async () => {
    cooperative();
    const connection = await connect();
    const ended: string[] = [];
    const stream = await connection.openStream({ onData: () => undefined, onClose: (c) => ended.push(c) });
    server.send([{ type: "endOfData", streamId: stream.id, reason: 8 }]);
    await expect.poll(() => ended).toEqual(["server"]);
    await expect(stream.send(utf8("late"))).rejects.toBeInstanceOf(RealtimeError);

    server.send([{ type: "data", streamId: 999, ackId: 3, requiresAck: true, payload: utf8("?") }]);
    await server.waitFor((f) => f.type === "ack" && f.streamId === 999 && f.ackId === 3);
  });

  it("keeps earlier frames when a message contains an unsupported frame type", async () => {
    cooperative();
    const connection = await connect();
    const got: string[] = [];
    const stream = await connection.openStream({ onData: (p) => got.push(text(p)) });
    const good = new Uint8Array([13, stream.id & 0xff, stream.id >> 8, 3, 0, 0, 0, 0, 0x41]); // data "A", no ack
    server.sendRaw(Uint8Array.from([...good, 99, 1, 2, 3]));
    await expect.poll(() => got).toEqual(["A"]);
    await expect.poll(() => connection.stats.unsupportedFrames).toBe(1);
    expect(connection.stats.droppedBytes).toBe(4);
  });

  it("notifies drains without closing", async () => {
    cooperative();
    const drains: number[] = [];
    const connection = await connect({ onDrain: (r) => drains.push(r) });
    server.send([{ type: "drain", reason: 5 }]);
    await expect.poll(() => drains).toEqual([5]);
    expect(connection.isOpen).toBe(true);
  });

  it("classifies close code 4003 as unauthorized (non-retryable) and fails pending work", async () => {
    server.onFrame = (frame, s) => {
      if (frame.type === "establish")
        s.send([{ type: "establish", streamId: frame.streamId, parameters: '{"code":200}' }]);
    };
    const connection = await connect({ ackTimeoutMs: 2_000, responseTimeoutMs: 2_000 });
    const closes: string[] = [];
    await connection.openStream({ onData: () => undefined, onClose: (c) => closes.push(c) });
    const pending = connection.request(utf8("pending")).catch((e: unknown) => e);
    await server.waitFor((f) => f.type === "data");
    server.close(4003, "unauthorized");
    const info = await connection.closed;
    expect(info).toMatchObject({ reason: "unauthorized", code: 4003 });
    expect(info.error?.retryable).toBe(false);
    expect(await pending).toBeInstanceOf(RealtimeError);
    expect(closes).toEqual(["connection"]);
  });

  it("classifies other close codes as retryable server closes", async () => {
    const connection = await connect();
    server.close(4000, "graceful");
    const info = await connection.closed;
    expect(info).toMatchObject({ reason: "server_close", code: 4000 });
    expect(info.error?.retryable).toBe(true);
  });

  it("close() is idempotent and the connection refuses further work", async () => {
    const connection = await connect();
    await Promise.all([connection.close(), connection.close()]);
    expect(await connection.closed).toEqual({ reason: "closed_by_client" });
    await expect(connection.request(utf8("x"))).rejects.toBeInstanceOf(RealtimeError);
  });

  it("closes when the owner's signal aborts, and aborts a pending open", async () => {
    const controller = new AbortController();
    const connection = await connect({ signal: controller.signal });
    controller.abort();
    expect((await connection.closed).reason).toBe("closed_by_client");

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      DgwConnection.open({ url: server.url, logger: silentLogger, signal: aborted.signal }),
    ).rejects.toBeInstanceOf(OperationAbortedError);
  });

  it("refuses insecure non-loopback URLs and reports unreachable gateways as NetworkError", async () => {
    await expect(
      DgwConnection.open({ url: "ws://gateway.facebook.com/ws/lightspeed", logger: silentLogger }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      DgwConnection.open({ url: "ws://127.0.0.1:9/ws", logger: silentLogger }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});
