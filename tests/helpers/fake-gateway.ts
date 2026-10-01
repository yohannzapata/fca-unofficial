import { DgwTestServer, text, utf8 } from "./dgw-test-server.js";
import { firstBlock, lsPayload, type Step } from "./ls-builders.js";

export interface ReceivedQuery {
  readonly database: number;
  readonly lastAppliedCursor: string | null;
  readonly type: number;
  /** 1 for the first client connection, 2 after the first reconnect, … */
  readonly connection: number;
}

/**
 * A SYNTHETIC stand-in for the Lightspeed gateway, sufficient to exercise the client:
 * it confirms streams, acknowledges data, answers database sync queries with scripted rows
 * and cursors, answers tasks, and can push live batches on a database's stream. It models
 * only what protocol-status.md §3.4–3.5 describes; it is not recorded Facebook behaviour.
 *
 * Cursor model: a database's first sync (cursor null) returns `baseline` rows and the cursor
 * "cur-<db>"; a sync from that cursor returns any queued `catchUp` rows and does not advance.
 */
export class FakeGateway {
  readonly queries: ReceivedQuery[] = [];
  /** Connection number of each task (thread-list) request. */
  readonly taskRequests: number[] = [];
  readonly baseline = new Map<number, Step[]>();
  readonly catchUp = new Map<number, Step[]>();
  readonly #streamsByDb = new Map<number, number>();
  #connection = 0;

  private constructor(readonly server: DgwTestServer) {}

  static async start(): Promise<FakeGateway> {
    const gateway = new FakeGateway(await DgwTestServer.start());
    gateway.#install();
    return gateway;
  }

  /** Base URL; the client appends the x-dgw-* query itself. */
  get url(): string {
    return this.server.url.split("?")[0] as string;
  }

  get connections(): number {
    return this.#connection;
  }

  /** Pushes a live batch on the stream of `database` (no request_id → a live push). */
  push(database: number, steps: Step[]): void {
    const streamId = this.#streamsByDb.get(database);
    if (streamId === undefined) throw new Error(`no stream for database ${database}`);
    const envelope = JSON.stringify({ payload: lsPayload(steps), sp: [], target: 0 });
    this.server.send([{ type: "data", streamId, ackId: 1, requiresAck: true, payload: utf8(envelope) }]);
  }

  /** Closes the current client connection with a WebSocket close code. */
  drop(code = 4000): void {
    this.server.close(code, "test");
  }

  stop(): Promise<void> {
    return this.server.stop();
  }

  #install(): void {
    this.server.onConnection = () => {
      this.#connection++;
      this.#streamsByDb.clear();
    };
    this.server.onFrame = (frame, s) => {
      if (frame.type === "ping") s.send([{ type: "pong" }]);
      if (frame.type === "establish") {
        s.send([{ type: "establish", streamId: frame.streamId, parameters: '{"code":200}' }]);
        return;
      }
      if (frame.type !== "data") return;
      if (frame.requiresAck) s.send([{ type: "ack", streamId: frame.streamId, ackId: frame.ackId }]);

      const envelope = JSON.parse(text(frame.payload)) as {
        payload: string;
        request_id: number;
        type: number;
      };
      if (envelope.type === 3) {
        this.taskRequests.push(this.#connection);
        this.#reply(frame.streamId, envelope.request_id, []);
        return;
      }
      if (envelope.type !== 1 && envelope.type !== 2) return;
      const query = JSON.parse(envelope.payload) as { database: number; last_applied_cursor: string | null };
      const db = query.database;
      this.#streamsByDb.set(db, frame.streamId);
      this.queries.push({
        database: db,
        lastAppliedCursor: query.last_applied_cursor,
        type: envelope.type,
        connection: this.#connection,
      });

      const current = query.last_applied_cursor;
      if (current === null) {
        this.#reply(frame.streamId, envelope.request_id, [
          ...(this.baseline.get(db) ?? []),
          firstBlock(db, "", `cur-${db}`),
        ]);
      } else {
        const rows = this.catchUp.get(db) ?? [];
        this.catchUp.delete(db);
        this.#reply(frame.streamId, envelope.request_id, [...rows, firstBlock(db, current, current)]);
      }
    };
  }

  #reply(streamId: number, requestId: number, steps: Step[]): void {
    const envelope = JSON.stringify({ request_id: requestId, payload: lsPayload(steps), sp: [], target: 0 });
    this.server.send([{ type: "data", streamId, ackId: 2, requiresAck: true, payload: utf8(envelope) }]);
  }
}
