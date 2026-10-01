import { ClientStateError, InvalidSessionError } from "../errors/errors.js";
import type { Logger } from "../logging/logger.js";
import { type SessionData, type StoredSyncState, validateSessionData } from "../session/session.js";
import type { SessionStore } from "../session/session-store.js";
import { CookieJar } from "../transport/http/cookie-jar.js";

export interface SessionManagerOptions {
  store: SessionStore;
  logger: Logger;
  now?: () => number;
  /** Cookie updates are batched for this long before being written. Default 2 s. */
  saveDebounceMs?: number;
}

/**
 * Bridges the SessionStore and the live cookie jar for one connection run.
 *
 *  - Loads the session once per run (reset() forces a re-read, e.g. after re-import).
 *  - Persists cookie rotations from Facebook, debounced, through the store's atomic save.
 *  - Never persists a session that lost a required cookie (e.g. `xs` deleted on logout):
 *    the last good session stays on disk, and the protocol layer reports the expiry.
 *  - Owns exactly one timer, cleared by flush()/reset().
 */
export class SessionManager {
  readonly #store: SessionStore;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #debounceMs: number;
  #current: SessionData | undefined;
  #jar: CookieJar | undefined;
  #dirty = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #writes: Promise<void> = Promise.resolve();

  constructor(options: SessionManagerOptions) {
    this.#store = options.store;
    this.#log = options.logger;
    this.#now = options.now ?? Date.now;
    this.#debounceMs = options.saveDebounceMs ?? 2_000;
  }

  /** The loaded session, or undefined before load(). */
  get current(): SessionData | undefined {
    return this.#current;
  }

  async load(): Promise<SessionData> {
    if (this.#current) return this.#current;
    const data = await this.#store.load();
    if (data === null) {
      throw new InvalidSessionError(
        "No session found in the session store. Import cookies with sessionFromCookies() and save them first.",
      );
    }
    this.#current = data;
    return data;
  }

  /** The live jar for the loaded session (one per run). */
  cookieJar(): CookieJar {
    const current = this.#current;
    if (!current) throw new ClientStateError("Session not loaded");
    this.#jar ??= new CookieJar({
      cookies: current.cookies,
      now: this.#now,
      onChange: () => {
        this.#dirty = true;
        this.#schedule();
      },
    });
    return this.#jar;
  }

  /** Records new sync cursors; persisted with the next (debounced) save. */
  updateSync(databases: StoredSyncState["databases"]): void {
    if (!this.#current) return;
    this.#current = { ...this.#current, sync: { databases, updatedAt: this.#now() } };
    this.#dirty = true;
    this.#schedule();
  }

  /** Writes pending cookie and cursor changes now. Safe to call at any time; never throws. */
  async flush(): Promise<void> {
    this.#clearTimer();
    if (this.#dirty && this.#current) {
      this.#dirty = false;
      const next: SessionData = {
        ...this.#current,
        cookies: this.#jar ? this.#jar.toSessionCookies() : this.#current.cookies,
        updatedAt: this.#now(),
      };
      const validation = validateSessionData(next);
      if (!validation.ok) {
        this.#log.warn("not persisting session update: it failed validation (e.g. lost required cookies)", {
          problems: validation.problems,
        });
      } else {
        this.#current = next;
        this.#writes = this.#writes
          .then(() => this.#store.save(next))
          .catch((error: unknown) => {
            this.#log.error("failed to persist session cookies", { error });
          });
      }
    }
    await this.#writes;
  }

  /**
   * Forgets the loaded session so the next load() re-reads the store. The state is cleared
   * synchronously (no window for a concurrent run to observe a half-reset manager); pending
   * cookie changes are queued for writing first, and the returned promise settles when written.
   */
  reset(): Promise<void> {
    const flushed = this.flush(); // snapshots and queues synchronously before its first await
    this.#current = undefined;
    this.#jar = undefined;
    return flushed;
  }

  #schedule(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, this.#debounceMs);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
