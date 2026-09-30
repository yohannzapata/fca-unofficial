import { ConfigurationError } from "../errors/errors.js";

export interface BackoffOptions {
  /** Delay before the first retry, in ms. */
  readonly initialDelayMs: number;
  /** Upper bound for any single delay, in ms. */
  readonly maxDelayMs: number;
  /** Growth factor per attempt (>= 1). */
  readonly multiplier: number;
  /**
   * Fraction of the delay that is randomized (0..1). "Equal jitter": the delay is uniformly
   * drawn from [base * (1 - jitter), base], so it never collapses to ~0.
   */
  readonly jitter: number;
}

export const DEFAULT_RECONNECT_BACKOFF: BackoffOptions = Object.freeze({
  initialDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
  multiplier: 2,
  jitter: 0.5,
});

export function resolveBackoffOptions(
  overrides: Partial<BackoffOptions> = {},
  base = DEFAULT_RECONNECT_BACKOFF,
): BackoffOptions {
  const options = { ...base, ...overrides };
  const { initialDelayMs, maxDelayMs, multiplier, jitter } = options;
  if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0) {
    throw new ConfigurationError("backoff.initialDelayMs must be a finite number >= 0");
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new ConfigurationError("backoff.maxDelayMs must be finite and >= initialDelayMs");
  }
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw new ConfigurationError("backoff.multiplier must be a finite number >= 1");
  }
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new ConfigurationError("backoff.jitter must be between 0 and 1");
  }
  return Object.freeze(options);
}

/**
 * Delay before retry number `attempt` (1-based): exponential, capped, with equal jitter.
 * `random` must return values in [0, 1); injectable for deterministic tests.
 */
export function computeBackoffDelay(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be an integer >= 1 (got ${attempt})`);
  }
  const exponential = options.initialDelayMs * options.multiplier ** (attempt - 1);
  const base = Math.min(options.maxDelayMs, exponential);
  const span = base * options.jitter;
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(base - span + r * span);
}
