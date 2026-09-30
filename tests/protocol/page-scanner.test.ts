import { describe, expect, it } from "vitest";
import { InvalidSessionError, ProtocolError, SessionExpiredError } from "../../src/errors/errors.js";
import { buildBootstrapConfig, missingForRealtime } from "../../src/protocol/bootstrap/bootstrap-config.js";
import { scanMessagesPage, summarizeScan } from "../../src/protocol/bootstrap/page-scanner.js";
import { SYNTH, syntheticMessagesPage } from "../helpers/synthetic-page.js";

const USER = "100000000000001";

describe("scanMessagesPage (synthetic input)", () => {
  it("extracts whitelisted define modules, the LS version, and __eqmc", () => {
    const scan = scanMessagesPage(syntheticMessagesPage());
    expect([...scan.modules.keys()].sort()).toEqual([
      "CurrentUserInitialData",
      "DGWWebConfig",
      "DTSGInitialData",
      "LSD",
      "LSPlatformMessengerSyncParams",
      "MessengerWebInitData",
      "MessengerWebRegion",
      "MqttWebDeviceID",
      "SiteData",
    ]);
    expect(scan.modules.has("SomethingIrrelevant" as never)).toBe(false);
    expect(scan.defineIds).toContain(9999); // ids of all define tuples are kept (for __dyn later)
    expect(scan.lsVersionId).toBe(SYNTH.lsVersion); // > 2^53, all digits preserved
    expect(scan.eqmc).toEqual({ jazoest: SYNTH.jazoest, cometReq: "15", fbDtsg: SYNTH.eqmcDtsg });
    expect(scan.loggedOutMarker).toBe(false);
    expect(scan.stats).toMatchObject({ scriptTags: 5, jsonScripts: 3, unparsableScripts: 1 });
  });

  it("does not depend on the wrapper layout", () => {
    const flat = scanMessagesPage(syntheticMessagesPage({ layout: "flat" }));
    expect(flat.modules.get("LSD")?.config["token"]).toBe(SYNTH.lsd);
  });

  it("flags logged-out pages", () => {
    expect(scanMessagesPage(syntheticMessagesPage({ loggedOut: true })).loggedOutMarker).toBe(true);
  });

  it("ignores define-like arrays with invalid shapes", () => {
    const html = `<script type="application/json">${JSON.stringify({
      a: [
        ["LSD", "not-an-array", { token: "x" }, 1],
        ["LSD", [], { token: "y" }, 0],
        ["LSD", [], "str", 2],
      ],
    })}</script>`;
    expect(scanMessagesPage(html).modules.size).toBe(0);
  });

  it("survives very deep nesting without stack overflow", () => {
    const depth = 5000;
    const json = `${"[".repeat(depth)}["LSD",[],{"token":"deep"},5]${"]".repeat(depth)}`;
    const scan = scanMessagesPage(`<script type="application/json">${json}</script>`);
    expect(scan.modules.size).toBe(0); // beyond MAX_DEPTH: ignored (or unparsable), but no crash
  });

  it("summaries contain module names and keys, never values", () => {
    const summary = summarizeScan(scanMessagesPage(syntheticMessagesPage({ omit: ["MessengerWebRegion"] })));
    const json = JSON.stringify(summary);
    for (const secret of [
      SYNTH.dtsg,
      SYNTH.lsd,
      SYNTH.eqmcDtsg,
      "SYNTH-CAT",
      "Synthetic Person",
      SYNTH.deviceClientId,
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(summary.modules["LSD"]).toEqual({ id: 323, keys: ["token"] });
    expect(summary.modulesMissing).toEqual(["DTSGInitData", "MqttWebConfig", "MessengerWebRegion"]);
  });
});

describe("buildBootstrapConfig", () => {
  const scanOf = (options?: Parameters<typeof syntheticMessagesPage>[0]) =>
    scanMessagesPage(syntheticMessagesPage(options));

  it("builds a complete config from a full page", () => {
    const config = buildBootstrapConfig(scanOf(), USER, 42);
    expect(config).toMatchObject({
      userId: USER,
      accountId: USER,
      appId: SYNTH.appId,
      fbDtsg: SYNTH.dtsg,
      lsd: SYNTH.lsd,
      jazoest: SYNTH.jazoest,
      cometReq: "15",
      dgwAppId: SYNTH.dgwAppId,
      deviceClientId: SYNTH.deviceClientId,
      messengerWebAppId: String(SYNTH.messengerWebAppId),
      lsVersionId: SYNTH.lsVersion,
      region: "SYN",
      syncParams: {
        mailbox: '{"locale":"en_US"}',
        contact: '{"locale":"en_US"}',
        e2ee: '{"locale":"en_US"}',
      },
      lossyFields: [],
      fetchedAt: 42,
    });
    expect(config.site).toMatchObject({ spinR: 1000001, spinB: "trunk", hsi: "7000000000000000001" });
    expect(missingForRealtime(config)).toEqual([]);
  });

  it("falls back to the __eqmc fb_dtsg when DTSGInitialData is absent", () => {
    expect(buildBootstrapConfig(scanOf({ omit: ["DTSGInitialData"] }), USER, 0).fbDtsg).toBe(SYNTH.eqmcDtsg);
  });

  it("reports what realtime would be missing without failing the bootstrap", () => {
    const config = buildBootstrapConfig(
      scanOf({ omit: ["DGWWebConfig", "MqttWebDeviceID"], lsVersion: null }),
      USER,
      0,
    );
    expect(missingForRealtime(config)).toEqual(["dgwAppId", "deviceClientId", "lsVersionId"]);
  });

  it("throws SessionExpiredError for a logged-out page", () => {
    expect(() => buildBootstrapConfig(scanOf({ loggedOut: true }), USER, 0)).toThrow(SessionExpiredError);
  });

  it("throws InvalidSessionError when the page belongs to another account", () => {
    expect(() => buildBootstrapConfig(scanOf({ userId: "100000000000999" }), USER, 0)).toThrow(
      InvalidSessionError,
    );
  });

  it("throws ProtocolError naming missing tokens, without values", () => {
    try {
      buildBootstrapConfig(scanOf({ omit: ["LSD"] }), USER, 0);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).message).toContain("LSD");
      expect(JSON.stringify(error)).not.toContain(SYNTH.dtsg);
    }
    expect(() => buildBootstrapConfig(scanOf({ omit: ["CurrentUserInitialData"] }), USER, 0)).toThrow(
      /CurrentUserInitialData not found/,
    );
  });

  it("treats integers beyond 2^53 as lossy instead of silently rounding them", () => {
    const html = `<script type="application/json">${JSON.stringify({
      define: [
        ["CurrentUserInitialData", [], { ACCOUNT_ID: USER, USER_ID: USER, APP_ID: "1" }, 1],
        ["DTSGInitialData", [], { token: "t" }, 2],
        ["LSD", [], { token: "l" }, 3],
      ],
    }).replace("]]}", `],["MessengerWebInitData",[],{"appId":9123456789012345678},4]]}`)}</script>`;
    const config = buildBootstrapConfig(scanMessagesPage(html), USER, 0);
    expect(config.messengerWebAppId).toBeUndefined();
    expect(config.lossyFields).toEqual(["MessengerWebInitData.appId"]);
  });
});
