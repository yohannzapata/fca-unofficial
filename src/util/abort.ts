import { OperationAbortedError, TimeoutError } from "../errors/errors.js";

/** Converts an abort reason into the library's error type. */
export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof OperationAbortedError || reason instanceof TimeoutError) return reason;
  return new OperationAbortedError();
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

/**
 * Cancellable delay. Rejects with the signal's abort error and clears its timer on abort,
 * so no timer outlives its owner.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface TimeoutScope {
  /** Aborts when the parent aborts or the timeout elapses (reason: TimeoutError). */
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  /** Clears the timer and detaches from the parent. Always call it (use try/finally). */
  dispose(): void;
}

/**
 * Creates a child signal with a timeout. Uses a regular timer rather than
 * AbortSignal.timeout(), so that it is cancellable, deterministic under fake timers,
 * and never keeps running after dispose().
 */
export function withTimeout(parent: AbortSignal | undefined, ms: number, what: string): TimeoutScope {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = (): void => {
    controller.abort(parent?.reason);
  };
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer =
    Number.isFinite(ms) && ms > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(
            new TimeoutError(`${what} timed out after ${ms} ms`, { details: { timeoutMs: ms } }),
          );
        }, ms)
      : undefined;
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

/** Resolves or rejects with `promise`, or rejects early if `signal` aborts. Detaches its listener either way. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
  readonly settled: () => boolean;
}

export function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve: (value) => {
      if (settled) return;
      settled = true;
      resolveFn(value);
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectFn(error);
    },
    settled: () => settled,
  };
}
