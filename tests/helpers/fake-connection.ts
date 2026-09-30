import type { MessengerError } from "../../src/errors/errors.js";
import type {
  ConnectionClosedInfo,
  Connector,
  SupervisedConnection,
} from "../../src/lifecycle/supervisor.js";

/** A controllable SupervisedConnection. `drop()` may be called many times; `closed` settles once. */
export class FakeConnection implements SupervisedConnection {
  readonly closed: Promise<ConnectionClosedInfo>;
  closeCalls = 0;
  dropCalls = 0;
  #resolve!: (info: ConnectionClosedInfo) => void;

  constructor(readonly id: number) {
    this.closed = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  /** Simulates the transport reporting that the connection was lost. */
  drop(reason = "network_lost", error?: MessengerError): void {
    this.dropCalls++;
    this.#resolve(error === undefined ? { reason } : { reason, error });
  }

  close(): Promise<void> {
    this.closeCalls++;
    this.#resolve({ reason: "closed_by_client" });
    return Promise.resolve();
  }
}

type Step =
  | { kind: "succeed" }
  | { kind: "fail"; error: MessengerError }
  | { kind: "hang" }
  | { kind: "hang-ignore-abort" };

/**
 * A scripted connector. Each call consumes the next step (the last step repeats).
 * Records every connection and every signal it was given.
 */
export class ScriptedConnector {
  readonly connections: FakeConnection[] = [];
  readonly signals: AbortSignal[] = [];
  /** Resolvers for "hang-ignore-abort" steps: lets a test complete a connection late. */
  readonly lateResolvers: ((c: FakeConnection) => void)[] = [];
  calls = 0;
  #steps: Step[];

  constructor(steps: Step[] = [{ kind: "succeed" }]) {
    this.#steps = steps;
  }

  get last(): FakeConnection | undefined {
    return this.connections.at(-1);
  }

  setSteps(steps: Step[]): void {
    this.#steps = steps;
  }

  readonly connector: Connector = (signal) => {
    this.calls++;
    this.signals.push(signal);
    const step = this.#steps.length > 1 ? this.#steps.shift()! : this.#steps[0]!;
    switch (step.kind) {
      case "succeed": {
        const connection = new FakeConnection(this.connections.length + 1);
        this.connections.push(connection);
        return Promise.resolve(connection);
      }
      case "fail":
        return Promise.reject(step.error);
      case "hang":
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          });
        });
      case "hang-ignore-abort":
        return new Promise((resolve) => {
          this.lateResolvers.push((c) => {
            resolve(c);
          });
        });
    }
  };
}
