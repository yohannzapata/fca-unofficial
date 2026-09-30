/**
 * SYNTHETIC test input — NOT a recorded Facebook page.
 *
 * Builds HTML whose structure follows what the reference implementation parses
 * (mautrix/meta httpclient/js_module_parser.go + modules.go @ e012f9f8, see
 * docs/research/protocol-status.md §2): inline JSON scripts with
 * ScheduledServerJS → __bbox → define tuples [name, deps, config, id], a
 * CometPlatformRootClient preloader carrying the Lightspeed version, and a __eqmc script.
 * All values are obviously fake. Replace/augment with sanitized recorded fixtures once the
 * live probe has confirmed the real structure.
 */

export interface SyntheticPageOptions {
  userId?: string;
  loggedOut?: boolean;
  /** Module names to leave out. */
  omit?: string[];
  /** Lightspeed version (as a string, may exceed 2^53). */
  lsVersion?: string | null;
  /** Put the defines in a flat top-level "define" list instead of ScheduledServerJS/__bbox. */
  layout?: "ssjs" | "flat";
  includeEqmc?: boolean;
}

export const SYNTH = {
  dtsg: "SYNTH-DTSG-VALUE",
  lsd: "SYNTH-LSD-VALUE",
  eqmcDtsg: "SYNTH-EQMC-DTSG",
  appId: "1000000000000001",
  dgwAppId: "1000000000000002",
  messengerWebAppId: 1000000000000003,
  deviceClientId: "synthetic-device-client-id",
  lsVersion: "9123456789012345678", // deliberately > 2^53
  jazoest: "21000",
} as const;

export function syntheticMessagesPage(options: SyntheticPageOptions = {}): string {
  const userId = options.loggedOut ? "0" : (options.userId ?? "100000000000001");
  const omit = new Set(options.omit ?? []);
  const defines: [string, unknown[], Record<string, unknown>, number][] = [
    [
      "CurrentUserInitialData",
      [],
      {
        ACCOUNT_ID: userId,
        USER_ID: userId,
        NAME: "Synthetic Person",
        SHORT_NAME: "Synthetic",
        APP_ID: SYNTH.appId,
      },
      270,
    ],
    ["DTSGInitialData", [], { token: SYNTH.dtsg }, 258],
    ["LSD", [], { token: SYNTH.lsd }, 323],
    [
      "SiteData",
      [],
      {
        __spin_r: 1000001,
        __spin_b: "trunk",
        __spin_t: 1700000000,
        hsi: "7000000000000000001",
        server_revision: 1000001,
        client_revision: 1000001,
        haste_session: "20000.HYP:comet_pkg.2.1..2.1",
        pr: 1,
      },
      317,
    ],
    [
      "DGWWebConfig",
      [],
      { appId: SYNTH.dgwAppId, appVersion: "0", dgwVersion: "2", endpoint: "", fbId: "0", authType: "" },
      6000,
    ],
    ["MqttWebDeviceID", [], { clientID: SYNTH.deviceClientId }, 5003],
    [
      "MessengerWebInitData",
      [],
      { appId: SYNTH.messengerWebAppId, cryptoAuthToken: { encrypted_serialized_cat: "SYNTH-CAT" } },
      4765,
    ],
    [
      "LSPlatformMessengerSyncParams",
      [],
      { mailbox: '{"locale":"en_US"}', contact: '{"locale":"en_US"}', e2ee: '{"locale":"en_US"}' },
      5237,
    ],
    ["MessengerWebRegion", [], { regionNullable: "SYN" }, 5100],
    ["SomethingIrrelevant", [], { token: "NOT-A-WANTED-MODULE" }, 9999],
  ].filter(([name]) => !omit.has(name as string)) as [string, unknown[], Record<string, unknown>, number][];

  const definesJson =
    options.layout === "flat"
      ? JSON.stringify({ define: defines })
      : JSON.stringify({
          require: [["ScheduledServerJS", "handle", null, [{ __bbox: { define: defines, require: [] } }]]],
        });

  const lsVersion = options.lsVersion === undefined ? SYNTH.lsVersion : options.lsVersion;
  // The version is written into requestPayload text verbatim (not via JSON numbers) so it keeps all digits.
  const requestPayload =
    lsVersion === null ? '{"database":1,"epoch_id":0}' : `{"database":1,"version":${lsVersion},"epoch_id":0}`;
  const preloaderJson = JSON.stringify({
    require: [
      [
        "CometPlatformRootClient",
        "init",
        [],
        [
          null,
          null,
          null,
          null,
          [
            {
              preloaderID: "adp_LSPlatformGraphQLLightspeedRequestQueryRelayPreloader_synthetic",
              queryID: "synthetic-query",
              variables: { deviceId: "synthetic", requestId: 0, requestPayload, requestType: 1 },
            },
          ],
        ],
      ],
    ],
  });

  const eqmc =
    options.includeEqmc === false
      ? ""
      : `<script type="application/json" id="__eqmc">${JSON.stringify({
          u: `/ajax/qm/?__a=1&__user=${userId}&__comet_req=15&jazoest=${SYNTH.jazoest}`,
          e: "synthetic",
          s: "synthetic",
          w: 0,
          f: SYNTH.eqmcDtsg,
        })}</script>`;

  return [
    "<!DOCTYPE html><html><head><title>Messenger</title>",
    '<script nonce="x">requireLazy(["Bootloader"], function(b){b.handlePayload({});});</script>',
    '<script type="application/json" data-sjs>{ this is not json </script>',
    `<script type="application/json" data-content-len="1" data-sjs>${definesJson}</script>`,
    `<script type="application/json" data-sjs>${preloaderJson}</script>`,
    eqmc,
    "</head><body></body></html>",
  ].join("\n");
}
