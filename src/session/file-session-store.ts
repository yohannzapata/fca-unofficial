import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ConfigurationError, SessionCorruptedError, SessionStoreError } from "../errors/errors.js";
import { plainCodec, type SessionCodec } from "./codec.js";
import { type SessionData, validateSessionData } from "./session.js";
import type { SessionStore } from "./session-store.js";

const ENVELOPE_FORMAT = "fca-unofficial-session";
const ENVELOPE_VERSION = 1;

interface Envelope {
  format: typeof ENVELOPE_FORMAT;
  version: typeof ENVELOPE_VERSION;
  codec: string;
  checksum: string;
  payload: string;
}

export interface FileSessionStoreOptions {
  /** File path, e.g. ".session/messenger.json". Parent directories are created (mode 0700). */
  path: string;
  /** Optional encryption at rest (see createAesGcmCodec / createPassphraseCodec). */
  codec?: SessionCodec;
  /** Keep the previous valid file as `<path>.bak`. Default true. */
  backup?: boolean;
}

/**
 * Stores the session in a local file.
 *
 *  - Atomic: write temp file → fsync → rename over the target (never a torn file).
 *  - Integrity: SHA-256 checksum over the (possibly encrypted) payload, plus schema validation.
 *  - Corruption is reported as SessionCorruptedError; the backup is never loaded implicitly
 *    (use `loadBackup()` deliberately).
 *  - Permissions: 0700 directory / 0600 file on POSIX. On Windows these modes are ignored and
 *    the file inherits the ACL of its directory; keep it under the user profile.
 *  - Operations on one instance are serialized. Multiple processes sharing one file are not supported.
 */
export class FileSessionStore implements SessionStore {
  readonly path: string;
  readonly backupPath: string;
  readonly #codec: SessionCodec;
  readonly #backup: boolean;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: FileSessionStoreOptions) {
    if (typeof options.path !== "string" || options.path.trim() === "") {
      throw new ConfigurationError("FileSessionStore requires a non-empty path");
    }
    this.path = resolve(options.path);
    this.backupPath = `${this.path}.bak`;
    this.#codec = options.codec ?? plainCodec;
    this.#backup = options.backup ?? true;
  }

  load(): Promise<SessionData | null> {
    return this.#enqueue(() => this.#read(this.path));
  }

  /** Loads the backup copy. Only call this deliberately, e.g. after the user confirms. */
  loadBackup(): Promise<SessionData | null> {
    return this.#enqueue(() => this.#read(this.backupPath));
  }

  save(data: SessionData): Promise<void> {
    const result = validateSessionData(data);
    if (!result.ok) {
      return Promise.reject(
        new SessionCorruptedError(`Refusing to save invalid session: ${result.problems.join("; ")}`),
      );
    }
    return this.#enqueue(() => this.#write(data));
  }

  clear(): Promise<void> {
    return this.#enqueue(async () => {
      await rm(this.path, { force: true });
      await rm(this.backupPath, { force: true });
    });
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #read(file: string): Promise<SessionData | null> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw new SessionStoreError("Could not read session file", "SESSION_STORE", {
        cause: error,
        details: { file: basename(file) },
      });
    }
    const envelope = parseEnvelope(text, file);
    if (envelope.codec !== this.#codec.id) {
      throw new SessionStoreError(
        `Session file was written with codec "${envelope.codec}" but this store uses "${this.#codec.id}"`,
        "SESSION_STORE",
        { details: { file: basename(file) } },
      );
    }
    const encoded = Buffer.from(envelope.payload, "base64");
    if (checksumOf(encoded) !== envelope.checksum) {
      throw new SessionCorruptedError("Session file checksum mismatch (file modified or damaged)", {
        details: { file: basename(file) },
      });
    }
    const plaintext = await this.#codec.decode(encoded);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(plaintext).toString("utf8"));
    } catch (error) {
      throw new SessionCorruptedError("Session payload is not valid JSON", {
        cause: error,
        details: { file: basename(file) },
      });
    }
    const validation = validateSessionData(parsed);
    if (!validation.ok) {
      throw new SessionCorruptedError(`Session data failed validation: ${validation.problems.join("; ")}`, {
        details: { file: basename(file) },
      });
    }
    return validation.value;
  }

  async #write(data: SessionData): Promise<void> {
    const encoded = await this.#codec.encode(Buffer.from(JSON.stringify(data), "utf8"));
    const envelope: Envelope = {
      format: ENVELOPE_FORMAT,
      version: ENVELOPE_VERSION,
      codec: this.#codec.id,
      checksum: checksumOf(encoded),
      payload: Buffer.from(encoded).toString("base64"),
    };
    const dir = dirname(this.path);
    const tmp = join(dir, `.${basename(this.path)}.${randomUUID()}.tmp`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (this.#backup) await this.#rotateBackup(dir);
      await renameWithRetry(tmp, this.path);
      await fsyncDirectory(dir);
    } catch (error) {
      throw new SessionStoreError("Could not write session file", "SESSION_STORE", {
        cause: error,
        details: { file: basename(this.path), errno: errnoCode(error) ?? null },
      });
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  /** Copies the current file to `.bak`, but only if its checksum verifies (never back up garbage). */
  async #rotateBackup(dir: string): Promise<void> {
    let current: string;
    try {
      current = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    try {
      const envelope = parseEnvelope(current, this.path);
      if (checksumOf(Buffer.from(envelope.payload, "base64")) !== envelope.checksum) return;
    } catch {
      return;
    }
    const tmp = join(dir, `.${basename(this.backupPath)}.${randomUUID()}.tmp`);
    try {
      await copyFile(this.path, tmp);
      await renameWithRetry(tmp, this.backupPath);
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}

function parseEnvelope(text: string, file: string): Envelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SessionCorruptedError("Session file is not valid JSON (truncated or damaged)", {
      cause: error,
      details: { file: basename(file) },
    });
  }
  const e = value as Partial<Envelope> | null;
  const valid =
    typeof e === "object" &&
    e !== null &&
    e.format === ENVELOPE_FORMAT &&
    e.version === ENVELOPE_VERSION &&
    typeof e.codec === "string" &&
    typeof e.checksum === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(e.checksum) &&
    typeof e.payload === "string" &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(e.payload);
  if (!valid) {
    throw new SessionCorruptedError("Session file has an unrecognized format", {
      details: { file: basename(file) },
    });
  }
  return e as Envelope;
}

function checksumOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * rename() over an existing file is atomic on POSIX and uses MoveFileEx(REPLACE_EXISTING)
 * on Windows, where a scanner or indexer briefly holding the target can cause a transient
 * EPERM/EACCES/EBUSY. Those (and only those, only on Windows) are retried a bounded number
 * of times, the same approach graceful-fs takes.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const transient = ["EPERM", "EACCES", "EBUSY"];
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errnoCode(error);
      if (process.platform !== "win32" || code === undefined || !transient.includes(code) || attempt >= 5)
        throw error;
      await new Promise((r) => setTimeout(r, 20 * 2 ** attempt));
    }
  }
}

/** Persists the rename itself (POSIX). Not supported on Windows, where it is skipped. */
async function fsyncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some filesystems do not support fsync on directories; the file itself is already synced.
  }
}

function errnoCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function isErrno(error: unknown, code: string): boolean {
  return errnoCode(error) === code;
}
