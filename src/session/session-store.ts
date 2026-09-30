import { SessionCorruptedError } from "../errors/errors.js";
import { type SessionData, validateSessionData } from "./session.js";

/**
 * Where session state lives. The core never assumes a filesystem: implement this for a
 * keychain, database, or anything else. Implementations must keep data local unless the
 * application explicitly chooses otherwise.
 */
export interface SessionStore {
  /** Returns the stored session, or null if none exists. Throws SessionCorruptedError on invalid data. */
  load(): Promise<SessionData | null>;
  /** Persists the session. Must be atomic: after a crash, either the old or the new data is readable. */
  save(data: SessionData): Promise<void>;
  /** Removes stored session material. Idempotent. */
  clear(): Promise<void>;
}

/** Keeps the session in memory only (tests, short-lived scripts). Stores copies to prevent aliasing. */
export class MemorySessionStore implements SessionStore {
  #data: SessionData | null;

  constructor(initial: SessionData | null = null) {
    this.#data = initial === null ? null : structuredClone(initial);
  }

  load(): Promise<SessionData | null> {
    return Promise.resolve(this.#data === null ? null : structuredClone(this.#data));
  }

  save(data: SessionData): Promise<void> {
    const result = validateSessionData(data);
    if (!result.ok) {
      return Promise.reject(
        new SessionCorruptedError(`Refusing to save invalid session: ${result.problems.join("; ")}`),
      );
    }
    this.#data = structuredClone(data);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#data = null;
    return Promise.resolve();
  }
}
