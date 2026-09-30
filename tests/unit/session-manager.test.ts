import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/client/session-manager.js";
import { InvalidSessionError } from "../../src/errors/errors.js";
import { silentLogger } from "../../src/logging/logger.js";
import type { SessionData } from "../../src/session/session.js";
import { MemorySessionStore } from "../../src/session/session-store.js";
import { fakeSession } from "../helpers/fixtures.js";

const WWW = new URL("https://www.facebook.com/messages");

class CountingStore extends MemorySessionStore {
  saves = 0;
  override save(data: SessionData): Promise<void> {
    this.saves++;
    return super.save(data);
  }
}

describe("SessionManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws InvalidSessionError when the store is empty", async () => {
    const manager = new SessionManager({ store: new MemorySessionStore(), logger: silentLogger });
    await expect(manager.load()).rejects.toBeInstanceOf(InvalidSessionError);
  });

  it("debounces cookie rotations into one atomic save", async () => {
    const store = new CountingStore(fakeSession(1));
    const manager = new SessionManager({ store, logger: silentLogger, now: () => 5, saveDebounceMs: 2_000 });
    await manager.load();
    const jar = manager.cookieJar();
    jar.setFromResponse(WWW, ["fr=NEW1; Domain=.facebook.com; Path=/; Secure"]);
    jar.setFromResponse(WWW, ["sb=NEW2; Domain=.facebook.com; Path=/; Secure"]);
    expect(store.saves).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.saves).toBe(1);
    const saved = await store.load();
    expect(saved?.cookies.find((c) => c.name === "fr")?.value).toBe("NEW1");
    expect(saved?.cookies.find((c) => c.name === "sb")?.value).toBe("NEW2");
    expect(saved?.updatedAt).toBe(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never persists a session that lost a required cookie", async () => {
    const store = new CountingStore(fakeSession(1));
    const manager = new SessionManager({ store, logger: silentLogger });
    await manager.load();
    manager.cookieJar().setFromResponse(WWW, ["xs=; Max-Age=0; Domain=.facebook.com; Path=/"]);
    await manager.flush();
    expect(store.saves).toBe(0);
    expect((await store.load())?.cookies.some((c) => c.name === "xs")).toBe(true);
  });

  it("reset() flushes pending changes, clears state synchronously, and forces a re-read", async () => {
    const store = new CountingStore(fakeSession(1));
    const manager = new SessionManager({ store, logger: silentLogger });
    await manager.load();
    manager.cookieJar().setFromResponse(WWW, ["fr=NEW; Domain=.facebook.com; Path=/; Secure"]);
    const pending = manager.reset();
    expect(manager.current).toBeUndefined();
    await pending;
    expect(store.saves).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await store.save(fakeSession(99));
    expect((await manager.load()).createdAt).toBe(99);
  });

  it("flush() with nothing pending is a no-op and never throws on store failure", async () => {
    const store = new MemorySessionStore(fakeSession(1));
    const manager = new SessionManager({ store, logger: silentLogger });
    await manager.flush();
    await manager.load();
    vi.spyOn(store, "save").mockRejectedValueOnce(new Error("disk full"));
    manager.cookieJar().setFromResponse(WWW, ["fr=NEW; Domain=.facebook.com; Path=/; Secure"]);
    await expect(manager.flush()).resolves.toBeUndefined();
  });
});
