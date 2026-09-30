import { InvalidSessionError, ProtocolError, SessionExpiredError } from "../../errors/errors.js";
import type { PageScan } from "./page-scanner.js";

/**
 * Configuration extracted from the messages page. Contains secrets (fbDtsg, lsd): never
 * log it or persist it in plain text.
 */
export interface BootstrapConfig {
  readonly userId: string;
  readonly accountId: string;
  /** CurrentUserInitialData.APP_ID: the app_id used in Lightspeed request envelopes. */
  readonly appId: string | undefined;
  readonly fbDtsg: string;
  readonly lsd: string;
  readonly jazoest: string | undefined;
  readonly cometReq: string | undefined;
  readonly site: {
    readonly spinR: number | undefined;
    readonly spinB: string | undefined;
    readonly spinT: number | undefined;
    readonly hsi: string | undefined;
    readonly serverRevision: number | undefined;
    readonly clientRevision: number | undefined;
    readonly hasteSession: string | undefined;
    readonly pixelRatio: number | undefined;
  };
  /** DGWWebConfig.appId → x-dgw-appid. */
  readonly dgwAppId: string | undefined;
  /** MqttWebDeviceID.clientID → x-dgw-deviceid. */
  readonly deviceClientId: string | undefined;
  readonly messengerWebAppId: string | undefined;
  readonly syncParams:
    { readonly mailbox?: string; readonly contact?: string; readonly e2ee?: string } | undefined;
  /** Lightspeed schema version ("versionId"), as a decimal string (may exceed 2^53). */
  readonly lsVersionId: string | undefined;
  readonly region: string | undefined;
  readonly defineIds: readonly number[];
  /** Fields that held integers too large for exact JSON parsing (> 2^53); treated as missing. */
  readonly lossyFields: readonly string[];
  readonly fetchedAt: number;
}

/** Fields the realtime transport will need, per protocol-status.md §3–§5. */
export const REALTIME_REQUIREMENTS = [
  "appId",
  "dgwAppId",
  "deviceClientId",
  "lsVersionId",
  "syncParams",
] as const;

export function missingForRealtime(config: BootstrapConfig): string[] {
  return REALTIME_REQUIREMENTS.filter((key) => config[key] === undefined);
}

/**
 * Validates a page scan against the session's user id and builds the config.
 * Throws SessionExpiredError (logged-out page), InvalidSessionError (different user),
 * or ProtocolError (page structure not recognised), never including token values.
 */
export function buildBootstrapConfig(scan: PageScan, expectedUserId: string, now: number): BootstrapConfig {
  const lossy: string[] = [];
  const str = (field: string, value: unknown): string | undefined => {
    if (typeof value === "string") return value === "" ? undefined : value;
    if (typeof value === "number" && Number.isFinite(value)) {
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        lossy.push(field);
        return undefined;
      }
      return String(value);
    }
    return undefined;
  };
  const config = (name: Parameters<typeof scan.modules.get>[0]) => scan.modules.get(name)?.config;

  const user = config("CurrentUserInitialData");
  const userId = str("USER_ID", user?.["USER_ID"]);
  const accountId = str("ACCOUNT_ID", user?.["ACCOUNT_ID"]);

  if (scan.loggedOutMarker || userId === "0" || accountId === "0") {
    throw new SessionExpiredError();
  }
  if (!user || userId === undefined || accountId === undefined) {
    throw new ProtocolError(
      "bootstrap",
      "CurrentUserInitialData not found in the messages page",
      "PROTOCOL",
      {
        details: { jsonScripts: scan.stats.jsonScripts, pageBytes: scan.stats.bytes },
      },
    );
  }
  if (userId !== expectedUserId && accountId !== expectedUserId) {
    throw new InvalidSessionError("The page belongs to a different account than the session's c_user cookie");
  }

  const fbDtsg =
    str("DTSGInitialData.token", config("DTSGInitialData")?.["token"]) ??
    str("DTSGInitData.token", config("DTSGInitData")?.["token"]) ??
    scan.eqmc?.fbDtsg;
  const lsd = str("LSD.token", config("LSD")?.["token"]);
  if (fbDtsg === undefined || lsd === undefined) {
    const missing = [fbDtsg === undefined ? "DTSGInitialData" : "", lsd === undefined ? "LSD" : ""].filter(
      Boolean,
    );
    throw new ProtocolError(
      "bootstrap",
      `Required tokens not found in the messages page: ${missing.join(", ")}`,
      "PROTOCOL",
      {
        details: { missing: missing.join(","), jsonScripts: scan.stats.jsonScripts },
      },
    );
  }

  const site = config("SiteData") ?? {};
  const syncConfig = config("LSPlatformMessengerSyncParams");
  let syncParams: BootstrapConfig["syncParams"];
  if (syncConfig) {
    const mailbox = str("sync.mailbox", syncConfig["mailbox"]);
    const contact = str("sync.contact", syncConfig["contact"]);
    const e2ee = str("sync.e2ee", syncConfig["e2ee"]);
    syncParams = {
      ...(mailbox === undefined ? {} : { mailbox }),
      ...(contact === undefined ? {} : { contact }),
      ...(e2ee === undefined ? {} : { e2ee }),
    };
  }

  return {
    userId,
    accountId,
    appId: str("APP_ID", user["APP_ID"]),
    fbDtsg,
    lsd,
    jazoest: scan.eqmc?.jazoest,
    cometReq: scan.eqmc?.cometReq,
    site: {
      spinR: num(site["__spin_r"]),
      spinB: str("SiteData.__spin_b", site["__spin_b"]),
      spinT: num(site["__spin_t"]),
      hsi: str("SiteData.hsi", site["hsi"]),
      serverRevision: num(site["server_revision"]),
      clientRevision: num(site["client_revision"]),
      hasteSession: str("SiteData.haste_session", site["haste_session"]),
      pixelRatio: num(site["pr"]),
    },
    dgwAppId: str("DGWWebConfig.appId", config("DGWWebConfig")?.["appId"]),
    deviceClientId: str("MqttWebDeviceID.clientID", config("MqttWebDeviceID")?.["clientID"]),
    messengerWebAppId: str("MessengerWebInitData.appId", config("MessengerWebInitData")?.["appId"]),
    syncParams,
    lsVersionId: scan.lsVersionId,
    region: str("MessengerWebRegion.regionNullable", config("MessengerWebRegion")?.["regionNullable"]),
    defineIds: scan.defineIds,
    lossyFields: lossy,
    fetchedAt: now,
  };
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return undefined;
}
