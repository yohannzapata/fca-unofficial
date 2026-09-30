import { describe, expect, it } from "vitest";
import {
  computeBackoffDelay,
  DEFAULT_RECONNECT_BACKOFF,
  resolveBackoffOptions,
} from "../../src/lifecycle/backoff.js";
import {
  canTransition,
  CONNECTION_STATES,
  type ConnectionState,
  ConnectionStateMachine,
  IllegalTransitionError,
  type StateChange,
} from "../../src/lifecycle/connection-state.js";

const LEGAL: Record<ConnectionState, ConnectionState[]> = {
  idle: ["connecting", "disconnected"],
  connecting: ["connected", "reconnecting", "failed", "disconnecting"],
  connected: ["reconnecting", "failed", "disconnecting"],
  reconnecting: ["connected", "failed", "disconnecting"],
  disconnecting: ["disconnected"],
  disconnected: ["connecting"],
  failed: ["connecting", "disconnected"],
};

describe("connection state machine", () => {
  it("matches the documented transition table exhaustively (49 pairs)", () => {
    for (const from of CONNECTION_STATES) {
      for (const to of CONNECTION_STATES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(LEGAL[from].includes(to));
      }
    }
  });

  it("never allows returning to idle, and never leaves disconnecting except to disconnected", () => {
    for (const from of CONNECTION_STATES) expect(canTransition(from, "idle")).toBe(false);
    expect(CONNECTION_STATES.filter((to) => canTransition("disconnecting", to))).toEqual(["disconnected"]);
  });

  it("records changes and rejects illegal ones", () => {
    const changes: StateChange[] = [];
    let t = 1000;
    const machine = new ConnectionStateMachine({ now: () => t, onChange: (c) => changes.push(c) });
    expect(machine.state).toBe("idle");
    t = 2000;
    machine.transition("connecting", { reason: "start" });
    expect(machine.since).toBe(2000);
    expect(() => machine.transition("idle")).toThrow(IllegalTransitionError);
    expect(machine.state).toBe("connecting");
    expect(changes).toEqual([{ from: "idle", to: "connecting", reason: "start", at: 2000 }]);
  });
});

describe("backoff", () => {
  const opts = DEFAULT_RECONNECT_BACKOFF;

  it("grows exponentially and caps at maxDelayMs", () => {
    const top = (attempt: number) => computeBackoffDelay(attempt, opts, () => 0.999999);
    expect(top(1)).toBe(1000);
    expect(top(2)).toBe(2000);
    expect(top(5)).toBe(16000);
    expect(top(20)).toBe(300000);
    expect(top(10_000)).toBe(300000); // no overflow to Infinity/NaN
  });

  it("applies equal jitter within [base*(1-j), base]", () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const base = Math.min(opts.maxDelayMs, opts.initialDelayMs * 2 ** (attempt - 1));
      expect(computeBackoffDelay(attempt, opts, () => 0)).toBe(Math.round(base * 0.5));
      for (let i = 0; i < 50; i++) {
        const d = computeBackoffDelay(attempt, opts);
        expect(d).toBeGreaterThanOrEqual(Math.round(base * 0.5));
        expect(d).toBeLessThanOrEqual(base);
      }
    }
  });

  it("never returns zero for a positive initial delay", () => {
    expect(computeBackoffDelay(1, opts, () => 0)).toBeGreaterThan(0);
  });

  it("rejects invalid attempts and options", () => {
    expect(() => computeBackoffDelay(0, opts)).toThrow(RangeError);
    expect(() => computeBackoffDelay(1.5, opts)).toThrow(RangeError);
    expect(() => resolveBackoffOptions({ multiplier: 0.5 })).toThrow(/multiplier/);
    expect(() => resolveBackoffOptions({ initialDelayMs: 10, maxDelayMs: 5 })).toThrow(/maxDelayMs/);
    expect(() => resolveBackoffOptions({ initialDelayMs: -1 })).toThrow(/initialDelayMs/);
    expect(() => resolveBackoffOptions({ jitter: 1.1 })).toThrow(/jitter/);
  });
});
