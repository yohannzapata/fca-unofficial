/**
 * Safety net: tests must never reach real Facebook (or any non-loopback host).
 * Real fetch is only allowed to loopback test servers; everything else throws.
 */
const realFetch = globalThis.fetch.bind(globalThis);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!LOOPBACK.has(url.hostname)) {
    return Promise.reject(new Error(`Blocked real network access in tests: ${url.host}`));
  }
  return realFetch(input, init);
};
