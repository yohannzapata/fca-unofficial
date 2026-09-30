export const CONNECTION_STATES = [
  "idle",
  "connecting",
  "connected",
  "reconnecting",
  "disconnecting",
  "disconnected",
  "failed",
] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];

/**
 * The complete set of legal transitions (docs/architecture.md §6.1).
 * Anything not listed here is a bug and throws.
 */
const TRANSITIONS: Readonly<Record<ConnectionState, readonly ConnectionState[]>> = {
  idle: ["connecting", "disconnected"],
  connecting: ["connected", "reconnecting", "failed", "disconnecting"],
  connected: ["reconnecting", "failed", "disconnecting"],
  reconnecting: ["connected", "failed", "disconnecting"],
  disconnecting: ["disconnected"],
  disconnected: ["connecting"],
  failed: ["connecting", "disconnected"],
};

export function canTransition(from: ConnectionState, to: ConnectionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface StateChange {
  readonly from: ConnectionState;
  readonly to: ConnectionState;
  /** Short machine-readable cause, e.g. "heartbeat_timeout", "NETWORK", "user". */
  readonly reason?: string;
  /** Consecutive failed attempt count, when relevant. */
  readonly attempt?: number;
  readonly at: number;
}

export class IllegalTransitionError extends Error {
  constructor(from: ConnectionState, to: ConnectionState) {
    super(`Illegal connection state transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

/** Holds the current state and enforces the transition table. Pure; no timers, no I/O. */
export class ConnectionStateMachine {
  #state: ConnectionState = "idle";
  #since: number;
  readonly #now: () => number;
  readonly #onChange: (change: StateChange) => void;

  constructor(options: { now?: () => number; onChange?: (change: StateChange) => void } = {}) {
    this.#now = options.now ?? Date.now;
    this.#onChange = options.onChange ?? (() => undefined);
    this.#since = this.#now();
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** Timestamp (ms) of the last transition. */
  get since(): number {
    return this.#since;
  }

  transition(to: ConnectionState, details: { reason?: string; attempt?: number } = {}): StateChange {
    const from = this.#state;
    if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
    this.#state = to;
    this.#since = this.#now();
    const change: StateChange = {
      from,
      to,
      at: this.#since,
      ...(details.reason === undefined ? {} : { reason: details.reason }),
      ...(details.attempt === undefined ? {} : { attempt: details.attempt }),
    };
    this.#onChange(change);
    return change;
  }
}
