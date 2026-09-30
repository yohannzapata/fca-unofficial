import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigurationError, SessionCorruptedError, SessionStoreError } from "../../src/errors/errors.js";
import { createAesGcmCodec, createPassphraseCodec } from "../../src/session/codec.js";
import { FileSessionStore } from "../../src/session/file-session-store.js";
import { fakeSession } from "../helpers/fixtures.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fca-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FileSessionStore", () => {
  it("returns null when no file exists, then round-trips a session", async () => {
    const store = new FileSessionStore({ path: join(dir, "nested", "s.json") });
    expect(await store.load()).toBeNull();
    const session = fakeSession();
    await store.save(session);
    expect(await store.load()).toEqual(session);
  });

  it("writes atomically and leaves no temp files behind", async () => {
    const store = new FileSessionStore({ path: join(dir, "s.json") });
    await store.save(fakeSession(1));
    await store.save(fakeSession(2));
    const files = (await readdir(dir)).sort();
    expect(files).toEqual(["s.json", "s.json.bak"]);
  });

  it("rotates the previous valid file into .bak, never implicitly loaded", async () => {
    const store = new FileSessionStore({ path: join(dir, "s.json") });
    await store.save(fakeSession(1));
    await store.save(fakeSession(2));
    expect((await store.load())?.createdAt).toBe(2);
    expect((await store.loadBackup())?.createdAt).toBe(1);
  });

  it("does not overwrite a good backup with a corrupted main file", async () => {
    const path = join(dir, "s.json");
    const store = new FileSessionStore({ path });
    await store.save(fakeSession(1));
    await store.save(fakeSession(2)); // .bak = 1
    await writeFile(path, "{ broken");
    await store.save(fakeSession(3));
    expect((await store.load())?.createdAt).toBe(3);
    expect((await store.loadBackup())?.createdAt).toBe(1);
  });

  it("detects truncation, tampering and schema violations", async () => {
    const path = join(dir, "s.json");
    const store = new FileSessionStore({ path });
    await store.save(fakeSession());
    const good = await readFile(path, "utf8");

    await writeFile(path, good.slice(0, good.length / 2));
    await expect(store.load()).rejects.toBeInstanceOf(SessionCorruptedError);

    const envelope = JSON.parse(good) as { payload: string };
    const tampered = Buffer.from(envelope.payload, "base64");
    tampered[10] = (tampered[10] ?? 0) ^ 0xff;
    await writeFile(path, JSON.stringify({ ...envelope, payload: tampered.toString("base64") }));
    await expect(store.load()).rejects.toThrow(/checksum/);

    await writeFile(path, JSON.stringify({ hello: "world" }));
    await expect(store.load()).rejects.toThrow(/unrecognized format/);
  });

  it("refuses to save invalid session data", async () => {
    const store = new FileSessionStore({ path: join(dir, "s.json") });
    await expect(store.save({ ...fakeSession(), cookies: [] })).rejects.toBeInstanceOf(SessionCorruptedError);
    expect(await readdir(dir)).toEqual([]);
  });

  it("serializes concurrent saves; the last write wins and the file stays valid", async () => {
    const store = new FileSessionStore({ path: join(dir, "s.json") });
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.save(fakeSession(i + 1))));
    expect((await store.load())?.createdAt).toBe(20);
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("clear() removes the file and backup and is idempotent", async () => {
    const store = new FileSessionStore({ path: join(dir, "s.json") });
    await store.save(fakeSession(1));
    await store.save(fakeSession(2));
    await store.clear();
    await store.clear();
    expect(await readdir(dir)).toEqual([]);
    expect(await store.load()).toBeNull();
  });

  it.skipIf(process.platform === "win32")("creates owner-only file permissions on POSIX", async () => {
    const path = join(dir, "sub", "s.json");
    const store = new FileSessionStore({ path });
    await store.save(fakeSession());
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "sub"))).mode & 0o777).toBe(0o700);
  });

  it("encrypts at rest with AES-GCM; the wrong key or codec is detected", async () => {
    const path = join(dir, "s.json");
    const key = randomBytes(32);
    const store = new FileSessionStore({ path, codec: createAesGcmCodec({ key }) });
    await store.save(fakeSession());
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("FAKE-xs-value-for-tests");
    expect(raw).not.toContain("100000000000001");
    expect(await store.load()).toEqual(fakeSession());

    const wrongKey = new FileSessionStore({ path, codec: createAesGcmCodec({ key: randomBytes(32) }) });
    await expect(wrongKey.load()).rejects.toBeInstanceOf(SessionCorruptedError);

    const plain = new FileSessionStore({ path });
    await expect(plain.load()).rejects.toBeInstanceOf(SessionStoreError);
    await expect(plain.load()).rejects.toThrow(/codec/);
  });

  it("encrypts with a passphrase (scrypt), with a fresh salt per save", async () => {
    const path = join(dir, "s.json");
    const store = new FileSessionStore({
      path,
      codec: createPassphraseCodec({ passphrase: "correct horse battery" }),
    });
    await store.save(fakeSession());
    const first = await readFile(path, "utf8");
    await store.save(fakeSession());
    const second = await readFile(path, "utf8");
    expect(first).not.toBe(second);
    expect(await store.load()).toEqual(fakeSession());
    const wrong = new FileSessionStore({
      path,
      codec: createPassphraseCodec({ passphrase: "wrong passphrase!" }),
    });
    await expect(wrong.load()).rejects.toBeInstanceOf(SessionCorruptedError);
  });

  it("validates constructor and codec options", () => {
    expect(() => new FileSessionStore({ path: "  " })).toThrow(ConfigurationError);
    expect(() => createAesGcmCodec({ key: new Uint8Array(16) })).toThrow(/32 bytes/);
    expect(() => createPassphraseCodec({ passphrase: "short" })).toThrow(/at least 8/);
  });
});
