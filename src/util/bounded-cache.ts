/**
 * A bounded map with least-recently-set eviction and an optional time-to-live.
 * Used for deduplication keys and small indexes, so no structure grows without bound in a
 * long-running process. Map insertion order provides the LRU order.
 */
export class BoundedCache<K, V> {
  readonly #entries = new Map<K, { value: V; expiresAt: number }>();
  readonly #capacity: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: { capacity: number; ttlMs?: number; now?: () => number }) {
    if (!(options.capacity >= 1)) throw new RangeError("capacity must be >= 1");
    this.#capacity = options.capacity;
    this.#ttlMs = options.ttlMs ?? Number.POSITIVE_INFINITY;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined || this.#hasUndefinedValue(key);
  }

  set(key: K, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  /** Records `key` and returns true if it was not already present (i.e. first sighting). */
  addIfAbsent(key: K, value: V): boolean {
    if (this.has(key)) return false;
    this.set(key, value);
    return true;
  }

  delete(key: K): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  #hasUndefinedValue(key: K): boolean {
    const entry = this.#entries.get(key);
    return entry !== undefined && entry.value === undefined && entry.expiresAt > this.#now();
  }
}
