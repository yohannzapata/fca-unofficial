import { describe, expect, it, vi } from "vitest";
import { TypedEmitter } from "../../src/events/typed-emitter.js";

type Events = { a: [n: number]; b: [s: string, t: string]; error: [e: Error] };

function make(maxListeners?: number) {
  const listenerErrors: { error: unknown; event: string }[] = [];
  const leaks: { event: string; count: number }[] = [];
  const emitter = new TypedEmitter<Events>({
    onListenerError: (error, event) => listenerErrors.push({ error, event }),
    onLeakWarning: (event, count) => leaks.push({ event, count }),
    ...(maxListeners === undefined ? {} : { maxListeners }),
  });
  return { emitter, listenerErrors, leaks };
}

describe("TypedEmitter", () => {
  it("delivers typed arguments and supports unsubscribe functions", () => {
    const { emitter } = make();
    const seen: number[] = [];
    const off = emitter.on("a", (n) => seen.push(n));
    emitter.emit("a", 1);
    off();
    emitter.emit("a", 2);
    expect(seen).toEqual([1]);
    expect(emitter.listenerCount("a")).toBe(0);
  });

  it("once() fires a single time", () => {
    const { emitter } = make();
    const fn = vi.fn();
    emitter.once("b", fn);
    emitter.emit("b", "x", "y");
    emitter.emit("b", "x", "y");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("x", "y");
  });

  it("a throwing listener does not stop other listeners", () => {
    const { emitter, listenerErrors } = make();
    const after = vi.fn();
    emitter.on("a", () => {
      throw new Error("listener bug");
    });
    emitter.on("a", after);
    expect(() => emitter.emit("a", 1)).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
    expect(listenerErrors).toHaveLength(1);
    expect(listenerErrors[0]!.event).toBe("a");
  });

  it("reports rejected promises from async listeners", async () => {
    const { emitter, listenerErrors } = make();
    emitter.on("a", async () => {
      await Promise.resolve();
      throw new Error("async bug");
    });
    emitter.emit("a", 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(listenerErrors).toHaveLength(1);
  });

  it("emitting error without listeners does not throw", () => {
    const { emitter } = make();
    expect(emitter.emit("error", new Error("x"))).toBe(false);
  });

  it("dispatches over a snapshot so listeners can unsubscribe during emit", () => {
    const { emitter } = make();
    const calls: string[] = [];
    const offSecond = emitter.on("a", () => {
      calls.push("first");
      offSecond2();
    });
    const offSecond2 = emitter.on("a", () => calls.push("second"));
    emitter.emit("a", 1);
    emitter.emit("a", 1);
    expect(calls).toEqual(["first", "second", "first"]);
    offSecond();
  });

  it("warns once when listeners exceed the limit", () => {
    const { emitter, leaks } = make(2);
    for (let i = 0; i < 5; i++) emitter.on("a", () => undefined);
    expect(leaks).toEqual([{ event: "a", count: 3 }]);
  });

  it("removeAllListeners clears one or all events", () => {
    const { emitter } = make();
    emitter.on("a", () => undefined);
    emitter.on("b", () => undefined);
    emitter.removeAllListeners("a");
    expect(emitter.listenerCount("a")).toBe(0);
    expect(emitter.listenerCount("b")).toBe(1);
    emitter.removeAllListeners();
    expect(emitter.listenerCount("b")).toBe(0);
  });

  it("rejects non-function listeners", () => {
    const { emitter } = make();
    expect(() => emitter.on("a", 5 as unknown as () => void)).toThrow(TypeError);
  });
});
