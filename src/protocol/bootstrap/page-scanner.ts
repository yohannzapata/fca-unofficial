/**
 * Extracts configuration from the facebook.com/messages HTML page.
 *
 * Facts (protocol-status.md §2; mautrix/meta httpclient/js_module_parser.go + modules.go
 * @ e012f9f8):
 *  - config lives in inline <script> JSON as "define" tuples [name, deps[], config{}, id];
 *  - the Lightspeed schema version is inside a GraphQL preloader whose preloaderID starts
 *    with "adp_LSPlatformGraphQLLightspeedRequest": variables.requestPayload → { version };
 *  - a logged-out page contains `"USER_ID":"0"`;
 *  - <script id="__eqmc"> holds { u: ajax URL (jazoest, __comet_req), f: fb_dtsg }.
 *
 * Design: rather than replicating the exact wrapper nesting (ScheduledServerJS → __bbox →
 * define …), every JSON script is walked generically and only whitelisted module names are
 * accepted. This survives wrapper reshuffles, which Meta changes more often than config
 * shapes. Non-JSON scripts (requireLazy/bigPipe JS) are counted but not interpreted.
 */

/** Config modules we read. Anything else in the page is ignored. */
export const CONFIG_MODULES = [
  "CurrentUserInitialData",
  "DTSGInitialData",
  "DTSGInitData",
  "LSD",
  "SiteData",
  "DGWWebConfig",
  "MqttWebDeviceID",
  "MqttWebConfig",
  "MessengerWebInitData",
  "LSPlatformMessengerSyncParams",
  "MessengerWebRegion",
] as const;

export type ConfigModuleName = (typeof CONFIG_MODULES)[number];

const WANTED = new Set<string>(CONFIG_MODULES);
const LS_PRELOADER_PREFIX = "adp_LSPlatformGraphQLLightspeedRequest";
const MAX_DEPTH = 200;

export interface DefinedModule {
  readonly id: number;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface EqmcData {
  readonly jazoest: string | undefined;
  readonly cometReq: string | undefined;
  readonly fbDtsg: string | undefined;
}

export interface PageScan {
  readonly modules: ReadonlyMap<ConfigModuleName, DefinedModule>;
  /** Config ids of every define tuple seen (used later for the __dyn parameter). */
  readonly defineIds: readonly number[];
  readonly lsVersionId: string | undefined;
  readonly eqmc: EqmcData | undefined;
  readonly loggedOutMarker: boolean;
  readonly stats: {
    readonly bytes: number;
    readonly scriptTags: number;
    readonly jsonScripts: number;
    readonly unparsableScripts: number;
  };
}

const SCRIPT_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const ID_ATTR = /\bid\s*=\s*["']([^"']+)["']/i;

export function scanMessagesPage(html: string): PageScan {
  const modules = new Map<ConfigModuleName, DefinedModule>();
  const defineIds = new Set<number>();
  let lsVersionId: string | undefined;
  let eqmc: EqmcData | undefined;
  let scriptTags = 0;
  let jsonScripts = 0;
  let unparsableScripts = 0;

  for (const match of html.matchAll(SCRIPT_PATTERN)) {
    scriptTags++;
    const attributes = match[1] ?? "";
    const content = (match[2] ?? "").trim();
    if (!content || !(content.startsWith("{") || content.startsWith("["))) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      unparsableScripts++;
      continue;
    }
    jsonScripts++;

    if (ID_ATTR.exec(attributes)?.[1] === "__eqmc") {
      eqmc = parseEqmc(parsed) ?? eqmc;
      continue;
    }

    walk(
      parsed,
      (array) => {
        const entry = asDefineEntry(array);
        if (!entry) return;
        defineIds.add(entry.id);
        if (WANTED.has(entry.name)) {
          modules.set(entry.name as ConfigModuleName, { id: entry.id, config: entry.config });
        }
      },
      (object) => {
        lsVersionId ??= lsVersionFromPreloader(object);
      },
    );
  }

  return {
    modules,
    defineIds: [...defineIds],
    lsVersionId,
    eqmc,
    loggedOutMarker: html.includes('"USER_ID":"0"'),
    stats: { bytes: html.length, scriptTags, jsonScripts, unparsableScripts },
  };
}

function asDefineEntry(
  array: unknown[],
): { name: string; config: Record<string, unknown>; id: number } | undefined {
  if (array.length < 4) return undefined;
  const [name, deps, config, id] = array;
  if (typeof name !== "string" || !Array.isArray(deps) || !isPlainObject(config)) return undefined;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return undefined;
  return { name, config, id };
}

/**
 * The version is a 64-bit integer that can exceed 2^53, so it is read from the raw
 * requestPayload text with a regex instead of JSON.parse (which would round it).
 */
function lsVersionFromPreloader(object: Record<string, unknown>): string | undefined {
  const preloaderID = object["preloaderID"];
  if (typeof preloaderID !== "string" || !preloaderID.startsWith(LS_PRELOADER_PREFIX)) return undefined;
  const variables = parseMaybeJson(object["variables"]);
  if (!isPlainObject(variables)) return undefined;
  const payload = variables["requestPayload"];
  if (typeof payload !== "string") return undefined;
  return LS_VERSION_PATTERN.exec(payload)?.[1];
}

const LS_VERSION_PATTERN = /"version"\s*:\s*"?(\d{1,20})"?/;

/**
 * A secret-free description of a scan: module names, their config KEYS (never values),
 * and ids. Safe to log, print, or share for protocol verification.
 */
export interface PageScanSummary {
  readonly bytes: number;
  readonly scriptTags: number;
  readonly jsonScripts: number;
  readonly unparsableScripts: number;
  readonly loggedOutMarker: boolean;
  readonly lsVersionId: string | undefined;
  readonly eqmcPresent: boolean;
  readonly modules: Readonly<Record<string, { readonly id: number; readonly keys: readonly string[] }>>;
  readonly modulesMissing: readonly string[];
}

export function summarizeScan(scan: PageScan): PageScanSummary {
  const modules: Record<string, { id: number; keys: string[] }> = {};
  for (const [name, module] of scan.modules) {
    modules[name] = { id: module.id, keys: Object.keys(module.config).sort() };
  }
  return {
    ...scan.stats,
    loggedOutMarker: scan.loggedOutMarker,
    lsVersionId: scan.lsVersionId,
    eqmcPresent: scan.eqmc !== undefined,
    modules,
    modulesMissing: CONFIG_MODULES.filter((name) => !scan.modules.has(name)),
  };
}

function parseEqmc(value: unknown): EqmcData | undefined {
  if (!isPlainObject(value)) return undefined;
  const ajaxUrl = value["u"];
  let jazoest: string | undefined;
  let cometReq: string | undefined;
  if (typeof ajaxUrl === "string") {
    try {
      const params = new URL(ajaxUrl, "https://www.facebook.com").searchParams;
      jazoest = params.get("jazoest") ?? undefined;
      cometReq = params.get("__comet_req") ?? undefined;
    } catch {
      // malformed URL: leave undefined
    }
  }
  const f = value["f"];
  return { jazoest, cometReq, fbDtsg: typeof f === "string" && f ? f : undefined };
}

/** Iterative depth-first walk (no recursion, so deeply nested pages cannot overflow the stack). */
function walk(
  root: unknown,
  onArray: (a: unknown[]) => void,
  onObject: (o: Record<string, unknown>) => void,
): void {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };
    if (depth > MAX_DEPTH) continue;
    if (Array.isArray(value)) {
      onArray(value);
      for (const child of value)
        if (child !== null && typeof child === "object") stack.push({ value: child, depth: depth + 1 });
    } else if (isPlainObject(value)) {
      onObject(value);
      for (const child of Object.values(value)) {
        if (child !== null && typeof child === "object") stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
