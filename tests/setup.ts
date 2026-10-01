/**
 * Safety net: tests must never reach real Facebook (or any non-loopback host).
 * Real fetch and WebSocket are only allowed to loopback test servers; everything else throws.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!LOOPBACK.has(url.hostname)) {
    return Promise.reject(new Error(`Blocked real network access in tests: ${url.host}`));
  }
  return realFetch(input, init);
};

const RealWebSocket = globalThis.WebSocket;
class GuardedWebSocket extends RealWebSocket {
  constructor(url: string | URL, protocols?: string | string[] | WebSocketInit) {
    const target = new URL(url);
    if (!LOOPBACK.has(target.hostname)) {
      throw new Error(`Blocked real WebSocket access in tests: ${target.host}`);
    }
    super(url, protocols);
  }
}
globalThis.WebSocket = GuardedWebSocket;
