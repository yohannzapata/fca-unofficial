import { describe, expect, it } from "vitest";
import { BoundedCache } from "../../src/util/bounded-cache.js";

describe("BoundedCache", () => {
  it("evicts the least recently set entry beyond capacity", () => {
    const cache = new BoundedCache<string, number>({ capacity: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 3); // refreshes "a"
    cache.set("c", 4); // evicts "b"
    expect(cache.get("a")).toBe(3);
    expect(cache.has("b")).toBe(false);
    expect(cache.get("c")).toBe(4);
    expect(cache.size).toBe(2);
  });

  it("expires entries after the TTL", () => {
    let now = 0;
    const cache = new BoundedCache<string, string>({ capacity: 10, ttlMs: 100, now: () => now });
    cache.set("k", "v");
    now = 99;
    expect(cache.get("k")).toBe("v");
    now = 100;
    expect(cache.get("k")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("addIfAbsent reports first sightings only", () => {
    const cache = new BoundedCache<string, true>({ capacity: 10 });
    expect(cache.addIfAbsent("x", true)).toBe(true);
    expect(cache.addIfAbsent("x", true)).toBe(false);
  });

  it("treats a stored undefined value as present", () => {
    const cache = new BoundedCache<string, undefined>({ capacity: 10 });
    cache.set("u", undefined);
    expect(cache.has("u")).toBe(true);
    expect(cache.addIfAbsent("u", undefined)).toBe(false);
  });

  it("supports delete and clear, and rejects a zero capacity", () => {
    const cache = new BoundedCache<number, number>({ capacity: 3 });
    cache.set(1, 1);
    cache.set(2, 2);
    cache.delete(1);
    expect(cache.has(1)).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(() => new BoundedCache({ capacity: 0 })).toThrow(RangeError);
  });
});
