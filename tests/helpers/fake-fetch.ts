export interface FakeRoute {
  status?: number;
  body?: string;
  headers?: [string, string][];
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * A scripted fetch. Each call to a URL (matched by `${host}${pathname}`) consumes the next
 * response for that key; the last one repeats. Unknown URLs fail like a network error.
 */
export function fakeFetch(routes: Record<string, FakeRoute | FakeRoute[]>) {
  const requests: RecordedRequest[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({ url: url.toString(), method: init?.method ?? "GET", headers });
    const queue = queues.get(`${url.host}${url.pathname}`);
    const route = queue && (queue.length > 1 ? queue.shift() : queue[0]);
    if (!route)
      return Promise.reject(new TypeError(`fetch failed: no fake route for ${url.host}${url.pathname}`));
    const h = new Headers();
    for (const [key, value] of route.headers ?? []) h.append(key, value);
    const status = route.status ?? 200;
    const body = status === 204 || status === 304 ? null : (route.body ?? "");
    return Promise.resolve(new Response(body, { status, headers: h }));
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}
