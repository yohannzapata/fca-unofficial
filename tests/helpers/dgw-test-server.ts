import type { AddressInfo } from "node:net";
import { WebSocket as WsSocket, WebSocketServer } from "ws";
import { decodeFrames, type DgwFrame, encodeFrames } from "../../src/transport/dgw/frames.js";

/**
 * A local DGW peer for tests (ws:// on 127.0.0.1). It decodes what the client sends and
 * lets each test script the server side. It does not imitate Facebook beyond the frame
 * layouts documented in protocol-status.md §3.
 */
export class DgwTestServer {
  readonly received: DgwFrame[] = [];
  readonly upgradeHeaders: Record<string, string | string[] | undefined>[] = [];
  readonly upgradeUrls: string[] = [];
  #server!: WebSocketServer;
  #socket: WsSocket | undefined;
  #waiters: { predicate: (f: DgwFrame) => boolean; resolve: (f: DgwFrame) => void }[] = [];
  /** Called for every frame the client sends; may reply via `send`. */
  onFrame: (frame: DgwFrame, server: DgwTestServer) => void = (frame, server) => {
    if (frame.type === "ping") server.send([{ type: "pong" }]);
  };

  static async start(): Promise<DgwTestServer> {
    const server = new DgwTestServer();
    await server.#listen();
    return server;
  }

  get url(): string {
    const port = (this.#server.address() as AddressInfo).port;
    return `ws://127.0.0.1:${port}/ws/lightspeed?x-dgw-appid=test&x-dgw-version=5`;
  }

  #listen(): Promise<void> {
    return new Promise((resolve) => {
      this.#server = new WebSocketServer({ host: "127.0.0.1", port: 0 }, resolve);
      this.#server.on("connection", (socket, request) => {
        this.#socket = socket;
        this.upgradeHeaders.push(request.headers);
        this.upgradeUrls.push(request.url ?? "");
        socket.on("message", (data: Buffer, isBinary: boolean) => {
          if (!isBinary) return;
          for (const frame of decodeFrames(new Uint8Array(data)).frames) {
            this.received.push(frame);
            this.onFrame(frame, this);
            this.#waiters = this.#waiters.filter((w) => {
              if (!w.predicate(frame)) return true;
              w.resolve(frame);
              return false;
            });
          }
        });
      });
    });
  }

  send(frames: DgwFrame[]): void {
    this.#socket?.send(encodeFrames(frames));
  }

  sendRaw(bytes: Uint8Array): void {
    this.#socket?.send(bytes);
  }

  close(code: number, reason = ""): void {
    this.#socket?.close(code, reason);
  }

  /** Resolves with the next client frame matching the predicate (or an already-received one). */
  waitFor(predicate: (f: DgwFrame) => boolean, timeoutMs = 2_000): Promise<DgwFrame> {
    const existing = this.received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for client frame"));
      }, timeoutMs);
      this.#waiters.push({
        predicate,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.#server.clients) client.terminate();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }
}

export const utf8 = (text: string) => new TextEncoder().encode(text);
export const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
