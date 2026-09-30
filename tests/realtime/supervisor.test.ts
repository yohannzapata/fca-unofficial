import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvalidSessionError,
  NetworkError,
  OperationAbortedError,
  ProtocolNotImplementedError,
  RealtimeError,
  TimeoutError,
} from "../../src/errors/errors.js";
import type { StateChange } from "../../src/lifecycle/connection-state.js";
import { ConnectionSupervisor, type SupervisorOptions } from "../../src/lifecycle/supervisor.js";
import { FakeConnection, ScriptedConnector } from "../helpers/fake-connection.js";

// With random() = 0.5 and jitter 0.5, each delay is 0.75 × (1000 × 2^(attempt-1)).
const DELAY = (attempt: number): number => 0.75 * 1000 * 2 ** (attempt - 1);

function setup(scripted: ScriptedConnector, overrides: Partial<SupervisorOptions> = {}) {
  const changes: StateChange[] = [];
  const errors: { code: string; fatal: boolean }[] = [];
  const supervisor = new ConnectionSupervisor({
    connector: scripted.connector,
    random: () => 0.5,
    now: () => Date.now(),
    onStateChange: (c) => changes.push(c),
    onError: (e, ctx) => errors.push({ code: e.code, fatal: ctx.fatal }),
    ...overrides,
  });
  const path = (): string => changes.map((c) => c.to).join(">");
  return { supervisor, changes, errors, path };
}

/** Lets pending promise continuations run without advancing time. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("ConnectionSupervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects and resolves start()", async () => {
    const scripted = new ScriptedConnector();
    const { supervisor, path } = setup(scripted);
    await supervisor.start();
    expect(supervisor.state).toBe("connected");
    expect(path()).toBe("connecting>connected");
    expect(scripted.calls).toBe(1);
    await supervisor.stop();
  });

  it("shares one run between concurrent start() calls", async () => {
    const scripted = new ScriptedConnector();
    const { supervisor } = setup(scripted);
    const a = supervisor.start();
    const b = supervisor.start();
    const c = supervisor.start();
    await Promise.all([a, b, c]);
    expect(scripted.calls).toBe(1);
    await supervisor.stop();
  });

  it("reconnects after the connection is lost, and the new connection keeps working", async () => {
    const scripted = new ScriptedConnector();
    const { supervisor, path } = setup(scripted);
    await supervisor.start();

    scripted.connections[0]!.drop("network_lost");
    await flush();
    expect(supervisor.state).toBe("reconnecting");
    expect(scripted.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(DELAY(1));
    expect(supervisor.state).toBe("connected");
    expect(scripted.calls).toBe(2);
    expect(scripted.connections[0]!.closeCalls).toBe(1); // old connection released
    expect(supervisor.stats.reconnects).toBe(1);
    expect(path()).toBe("connecting>connected>reconnecting>connected");

    await supervisor.stop();
  });

  it("turns repeated loss signals from one connection into exactly one reconnect", async () => {
    const scripted = new ScriptedConnector();
    const { supervisor } = setup(scripted);
    await supervisor.start();

    const conn = scripted.connections[0]!;
    conn.drop("network_lost");
    conn.drop("heartbeat_timeout");
    conn.drop("socket_error");
    conn.drop("server_close");
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(conn.dropCalls).toBe(4);
    expect(scripted.calls).toBe(2); // one reconnect, not four
    expect(supervisor.state).toBe("connected");
    await supervisor.stop();
  });

  it("handles back-to-back losses with a single loop and escalating backoff", async () => {
    const scripted = new ScriptedConnector();
    const { supervisor, changes } = setup(scripted);
    await supervisor.start();

    for (let loss = 1; loss <= 4; loss++) {
      scripted.last!.drop("network_lost");
      await flush();
      expect(supervisor.state).toBe("reconnecting");
      const callsBefore = scripted.calls;
      // Just before the delay elapses: no new attempt yet.
      await vi.advanceTimersByTimeAsync(DELAY(loss) - 1);
      expect(scripted.calls).toBe(callsBefore);
      await vi.advanceTimersByTimeAsync(1);
      expect(scripted.calls).toBe(callsBefore + 1);
      expect(supervisor.state).toBe("connected");
    }

    expect(scripted.calls).toBe(5);
    expect(changes.filter((c) => c.to === "reconnecting").map((c) => c.attempt)).toEqual([1, 2, 3, 4]);
    // Only one pending timer at most while connected (none here).
    expect(vi.getTimerCount()).toBe(0);
    await supervisor.stop();
  });

  it("resets backoff after a connection that stayed up longer than stableAfterMs", async () => {
    const scripted = new ScriptedConnector();
    const { supervisor, changes } = setup(scripted, { stableAfterMs: 120_000 });
    await supervisor.start();
    scripted.last!.drop();
    await vi.advanceTimersByTimeAsync(DELAY(1));
    scripted.last!.drop();
    await vi.advanceTimersByTimeAsync(DELAY(2));
    expect(supervisor.state).toBe("connected");

    await vi.advanceTimersByTimeAsync(200_000); // healthy for a long time
    scripted.last!.drop();
    await flush();
    expect(changes.at(-1)).toMatchObject({ to: "reconnecting", attempt: 1 });
    await vi.advanceTimersByTimeAsync(DELAY(1));
    expect(supervisor.state).toBe("connected");
    await supervisor.stop();
  });

  it("retries transient connect errors, then connects", async () => {
    const scripted = new ScriptedConnector([
      { kind: "fail", error: new NetworkError("down") },
      { kind: "fail", error: new NetworkError("down") },
      { kind: "succeed" },
    ]);
    const { supervisor, path, errors } = setup(scripted);
    const started = supervisor.start();
    await vi.advanceTimersByTimeAsync(DELAY(1) + DELAY(2));
    await started;
    expect(scripted.calls).toBe(3);
    expect(path()).toBe("connecting>reconnecting>connected");
    expect(errors).toEqual([
      { code: "NETWORK", fatal: false },
      { code: "NETWORK", fatal: false },
    ]);
    await supervisor.stop();
  });

  it("stops immediately on a permanent error and rejects start()", async () => {
    const error = new InvalidSessionError("bad session");
    const scripted = new ScriptedConnector([{ kind: "fail", error }]);
    const { supervisor, path, errors } = setup(scripted);
    await expect(supervisor.start()).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(scripted.calls).toBe(1);
    expect(supervisor.state).toBe("failed");
    expect(path()).toBe("connecting>failed");
    expect(errors).toEqual([{ code: "INVALID_SESSION", fatal: true }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails when a live connection closes with a non-retryable error", async () => {
    const scripted = new ScriptedConnector();
    const { supervisor } = setup(scripted);
    await supervisor.start();
    scripted.last!.drop("unauthorized", new InvalidSessionError("revoked"));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(supervisor.state).toBe("failed");
    expect(scripted.calls).toBe(1);
  });

  it("gives up after maxConsecutiveFailures", async () => {
    const scripted = new ScriptedConnector([{ kind: "fail", error: new NetworkError("down") }]);
    const { supervisor } = setup(scripted, { maxConsecutiveFailures: 3 });
    const started = supervisor.start();
    const assertion = expect(started).rejects.toBeInstanceOf(RealtimeError);
    await vi.advanceTimersByTimeAsync(DELAY(1) + DELAY(2) + 10);
    await assertion;
    expect(scripted.calls).toBe(3);
    expect(supervisor.state).toBe("failed");
    expect(supervisor.stats.lastError?.retryable).toBe(false);
  });

  it("times out a hanging connect attempt, aborts its signal, and retries", async () => {
    const scripted = new ScriptedConnector([{ kind: "hang" }, { kind: "succeed" }]);
    const { supervisor, changes } = setup(scripted, { connectTimeoutMs: 5_000 });
    const started = supervisor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(scripted.signals[0]!.aborted).toBe(true);
    expect(scripted.signals[0]!.reason).toBeInstanceOf(TimeoutError);
    expect(changes.at(-1)).toMatchObject({ to: "reconnecting", reason: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(DELAY(1));
    await started;
    expect(supervisor.state).toBe("connected");
    await supervisor.stop();
  });

  it("closes a connection that arrives after its attempt timed out", async () => {
    const scripted = new ScriptedConnector([{ kind: "hang-ignore-abort" }, { kind: "succeed" }]);
    const { supervisor } = setup(scripted, { connectTimeoutMs: 1_000 });
    const started = supervisor.start();
    await vi.advanceTimersByTimeAsync(1_000 + DELAY(1));
    await started;
    const late = new FakeConnection(99);
    scripted.lateResolvers[0]!(late);
    await flush();
    expect(late.closeCalls).toBe(1);
    expect(scripted.connections).toHaveLength(1);
    await supervisor.stop();
  });

  it("stop() during backoff cancels the pending retry and leaves no timers", async () => {
    const scripted = new ScriptedConnector();
    const { supervisor, path } = setup(scripted);
    await supervisor.start();
    scripted.last!.drop();
    await flush();
    expect(vi.getTimerCount()).toBe(1); // the backoff sleep
    const first = supervisor.stop();
    const second = supervisor.stop();
    expect(second).toBe(first);
    await first;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(scripted.calls).toBe(1);
    expect(supervisor.state).toBe("disconnected");
    expect(path()).toBe("connecting>connected>reconnecting>disconnecting>disconnected");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop() during a pending connect aborts it and rejects start()", async () => {
    const scripted = new ScriptedConnector([{ kind: "hang" }]);
    const { supervisor } = setup(scripted);
    const started = supervisor.start();
    const assertion = expect(started).rejects.toBeInstanceOf(OperationAbortedError);
    await flush();
    await supervisor.stop();
    await assertion;
    expect(scripted.signals[0]!.aborted).toBe(true);
    expect(supervisor.state).toBe("disconnected");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop() while connected closes the connection exactly once", async () => {
    const scripted = new ScriptedConnector();
    const { supervisor } = setup(scripted);
    await supervisor.start();
    await supervisor.stop();
    await supervisor.stop();
    expect(scripted.connections[0]!.closeCalls).toBe(1);
    expect(supervisor.state).toBe("disconnected");
  });

  it("a loss signal racing with stop() does not trigger a reconnect", async () => {
    const scripted = new ScriptedConnector();
    const { supervisor } = setup(scripted);
    await supervisor.start();
    const stopping = supervisor.stop();
    scripted.last!.drop("network_lost");
    await stopping;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(scripted.calls).toBe(1);
    expect(supervisor.state).toBe("disconnected");
  });

  it("can be started again after stop() and after failure", async () => {
    const scripted = new ScriptedConnector([
      { kind: "succeed" },
      { kind: "fail", error: new ProtocolNotImplementedError("x", "not yet") },
      { kind: "succeed" },
    ]);
    const { supervisor } = setup(scripted);
    await supervisor.start();
    await supervisor.stop();
    await expect(supervisor.start()).rejects.toBeInstanceOf(ProtocolNotImplementedError);
    expect(supervisor.state).toBe("failed");
    await supervisor.start();
    expect(supervisor.state).toBe("connected");
    await supervisor.stop();
    expect(supervisor.state).toBe("disconnected");
  });

  it("stop() in failed state moves to disconnected; stop() when idle is a no-op", async () => {
    const idle = setup(new ScriptedConnector());
    await idle.supervisor.stop();
    expect(idle.supervisor.state).toBe("idle");

    const scripted = new ScriptedConnector([{ kind: "fail", error: new InvalidSessionError("x") }]);
    const { supervisor } = setup(scripted);
    await expect(supervisor.start()).rejects.toThrow();
    await supervisor.stop();
    expect(supervisor.state).toBe("disconnected");
  });

  it("start() during disconnecting waits for the stop, then starts a fresh run", async () => {
    const scripted = new ScriptedConnector();
    const { supervisor, path } = setup(scripted);
    await supervisor.start();
    const stopping = supervisor.stop();
    const restarted = supervisor.start();
    await stopping;
    await restarted;
    expect(supervisor.state).toBe("connected");
    expect(scripted.calls).toBe(2);
    expect(path()).toBe("connecting>connected>disconnecting>disconnected>connecting>connected");
    await supervisor.stop();
  });

  it("validates its options", () => {
    const connector = new ScriptedConnector().connector;
    expect(() => new ConnectionSupervisor({ connector, maxConsecutiveFailures: 0 })).toThrow(
      /maxConsecutiveFailures/,
    );
    expect(() => new ConnectionSupervisor({ connector, connectTimeoutMs: 0 })).toThrow(/connectTimeoutMs/);
    expect(() => new ConnectionSupervisor({ connector, backoff: { jitter: 2 } })).toThrow(/jitter/);
  });
});
