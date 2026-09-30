/**
 * A small typed event emitter.
 *
 * Differences from node:events, all deliberate:
 *  - a throwing listener, or one returning a rejected promise, never interrupts dispatch;
 *    the failure is reported through `onListenerError`;
 *  - emitting "error" with no listener does not throw;
 *  - `on()` returns an unsubscribe function;
 *  - dispatch iterates over a snapshot, so listeners may (un)subscribe during emit.
 */

export type EventMap = { [event: string]: unknown[] };
export type Listener<Args extends unknown[]> = (...args: Args) => unknown;

interface Registration {
  readonly fn: Listener<never[]>;
  readonly once: boolean;
}

export interface TypedEmitterOptions<Events extends EventMap> {
  onListenerError: (error: unknown, event: keyof Events & string) => void;
  /** Warn when an event has more listeners than this (listener leak detection). Default 50. */
  maxListeners?: number;
  onLeakWarning?: (event: keyof Events & string, count: number) => void;
}

export class TypedEmitter<Events extends EventMap> {
  readonly #listeners = new Map<keyof Events & string, Registration[]>();
  readonly #warned = new Set<string>();
  readonly #options: TypedEmitterOptions<Events>;

  constructor(options: TypedEmitterOptions<Events>) {
    this.#options = options;
  }

  on<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): () => void {
    return this.#add(event, listener, false);
  }

  once<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): () => void {
    return this.#add(event, listener, true);
  }

  off<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): void {
    const list = this.#listeners.get(event);
    if (!list) return;
    const index = list.findIndex((reg) => reg.fn === (listener as Listener<never[]>));
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.#listeners.delete(event);
  }

  /** Synchronously invokes listeners. Returns whether any listener was registered. */
  emit<K extends keyof Events & string>(event: K, ...args: Events[K]): boolean {
    const list = this.#listeners.get(event);
    if (!list || list.length === 0) return false;
    const snapshot = [...list];
    for (const reg of snapshot) {
      if (reg.once) this.off(event, reg.fn as Listener<Events[K]>);
      try {
        const result = (reg.fn as Listener<Events[K]>)(...args);
        if (isPromiseLike(result)) {
          result.then(undefined, (error: unknown) => {
            this.#reportListenerError(error, event);
          });
        }
      } catch (error) {
        this.#reportListenerError(error, event);
      }
    }
    return true;
  }

  listenerCount(event: keyof Events & string): number {
    return this.#listeners.get(event)?.length ?? 0;
  }

  removeAllListeners(event?: keyof Events & string): void {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
  }

  #add<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>, once: boolean): () => void {
    if (typeof listener !== "function") {
      throw new TypeError(`Listener for "${event}" must be a function`);
    }
    const list = this.#listeners.get(event) ?? [];
    list.push({ fn: listener, once });
    this.#listeners.set(event, list);
    const max = this.#options.maxListeners ?? 50;
    if (list.length > max && !this.#warned.has(event)) {
      this.#warned.add(event);
      this.#options.onLeakWarning?.(event, list.length);
    }
    return () => {
      this.off(event, listener);
    };
  }

  #reportListenerError(error: unknown, event: keyof Events & string): void {
    try {
      this.#options.onListenerError(error, event);
    } catch {
      // The error reporter itself failed; nothing sensible left to do.
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function"
  );
}
