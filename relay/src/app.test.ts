import { describe, expect, it } from "vitest";
import { isAllowedProxyPath } from "./app.js";
import { ConfigError, describeConfig, loadConfig } from "./config.js";
import { harness, json, TEST_SECRET } from "./test-helpers.js";

describe("GET /health", () => {
  it("reports ok=false (not a crash) when no Groww token can be obtained", async () => {
    const h = harness({ RELAY_LIVE: "false" });
    h.groww.tokenOk = false;
    const res = await h.call("GET", "/health");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({
      ok: false,
      live: false,
      publicIp: null,
      tokenValidUntil: null,
      ordersToday: 0,
      buyPremiumToday: 0,
      growwReachable: false,
      clockIso: "2026-10-06T05:10:00.000Z",
      clockSkewMs: 0,
      dataProxy: false,
    });
    expect(body.tokenError).toMatch(/not configured/);
    expect(body.caps).toMatchObject({ maxLotsPerOrder: 2, maxOrdersPerDay: 12, tradingWindowIst: "09:16-15:12", exitWindowEndIst: "15:25", allowShort: false });
    expect(typeof body.version).toBe("string");
  });

  it("reports the public IP and Groww reachability, with caching", async () => {
    let ipCalls = 0;
    const h = harness(
      {},
      {
        fetch: async (url: string) => {
          if (url.startsWith("https://api.ipify.org")) {
            ipCalls++;
            return new Response(JSON.stringify({ ip: "203.0.113.7" }), { status: 200 });
          }
          throw new Error(`unexpected ${url}`);
        },
      },
    );
    const first = await json(await h.call("GET", "/health"));
    expect(first).toMatchObject({ ok: true, live: true, publicIp: "203.0.113.7", growwReachable: true });
    expect(first.tokenValidUntil).toBe(new Date(h.clock.now() + 3_600_000).toISOString());

    h.groww.marginsFail = true;
    h.clock.advance(30_000);
    const cached = await json(await h.call("GET", "/health"));
    expect(cached.growwReachable).toBe(true); // cached for 60 s
    h.clock.advance(31_000);
    const fresh = await json(await h.call("GET", "/health"));
    expect(fresh.growwReachable).toBe(false);
    expect(ipCalls).toBe(1); // cached for 10 minutes
  });

  it("counts today's orders and BUY premium", async () => {
    const h = harness();
    await h.call("POST", "/v1/orders", {
      idempotencyKey: "HEALTH0001",
      underlying: "NIFTY",
      tradingSymbol: "NIFTY26O1325000CE",
      exchange: "NSE",
      segment: "FNO",
      side: "BUY",
      qty: 65,
      lotSize: 65,
      orderType: "LIMIT",
      price: 100,
      product: "MIS",
      validity: "DAY",
    });
    const body = await json(await h.call("GET", "/health"));
    expect(body).toMatchObject({ ordersToday: 1, buyPremiumToday: 6500 });
  });
});

describe("GET /v1/groww/* data proxy", () => {
  it("is off unless RELAY_DATA_PROXY=true", async () => {
    const h = harness();
    const res = await h.call("GET", "/v1/groww/live-data/ltp?segment=FNO&exchange_symbols=NSE_NIFTY");
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ code: "DATA_PROXY_DISABLED" });
    expect(h.groww.count("proxyGet")).toBe(0);
  });

  it("forwards allowlisted GETs with their query string", async () => {
    const h = harness({ RELAY_DATA_PROXY: "true" });
    for (const path of [
      "/v1/groww/live-data/ltp?segment=CASH&exchange_symbols=NSE_NIFTY,BSE_SENSEX",
      "/v1/groww/option-chain/exchange/NSE/underlying/NIFTY?expiry_date=2026-10-13",
      "/v1/groww/historical/candles?exchange=NSE&segment=CASH",
      "/v1/groww/positions/user?segment=FNO",
      "/v1/groww/margins/detail/user",
    ]) {
      const res = await h.call("GET", path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("x-groww-status")).toBe("200");
      expect(await json(res)).toEqual({ status: "SUCCESS", payload: { echoed: path.slice("/v1/groww".length) } });
    }
  });

  it("refuses order endpoints, other paths and non-GET methods", async () => {
    const h = harness({ RELAY_DATA_PROXY: "true" });
    for (const path of ["/v1/groww/order/list?segment=FNO", "/v1/groww/order/create", "/v1/groww/token/api/access", "/v1/groww/live-dataX/ltp", "/v1/groww/"]) {
      const res = await h.call("GET", path);
      expect(res.status, path).toBe(403);
      expect(await json(res)).toMatchObject({ code: "PATH_NOT_ALLOWED" });
    }
    const post = await h.call("POST", "/v1/groww/live-data/ltp", {});
    expect(post.status).toBe(405);
    expect(h.groww.count("proxyGet")).toBe(0);
  });

  it("maps Groww's own 401/403 to 502 so they are not mistaken for relay auth failures", async () => {
    const h = harness({ RELAY_DATA_PROXY: "true" });
    h.groww.proxyGet = async () => ({ status: 403, body: { status: "FAILURE", error: { code: "GA005", message: "User not authorised" } } });
    const res = await h.call("GET", "/v1/groww/margins/detail/user");
    expect(res.status).toBe(502);
    expect(res.headers.get("x-groww-status")).toBe("403");
    expect(await json(res)).toMatchObject({ status: "FAILURE" });
  });

  it("rejects traversal and encoded paths in the allowlist check", () => {
    expect(isAllowedProxyPath("live-data/ltp")).toBe(true);
    expect(isAllowedProxyPath("live-data/../order/list")).toBe(false);
    expect(isAllowedProxyPath("live-data/./ltp")).toBe(false);
    expect(isAllowedProxyPath("live-data//ltp")).toBe(false);
    expect(isAllowedProxyPath("live-data/%2e%2e/order/list")).toBe(false);
    expect(isAllowedProxyPath("live-data\\..\\order")).toBe(false);
    expect(isAllowedProxyPath("order/list")).toBe(false);
  });
});

describe("misc routes", () => {
  it("returns JSON errors for unknown routes (after auth)", async () => {
    const h = harness();
    const unsigned = await h.app.request("/v1/nope");
    expect(unsigned.status).toBe(401);
    const signed = await h.call("GET", "/v1/nope");
    expect(signed.status).toBe(404);
    expect(await json(signed)).toEqual({ error: "not found", code: "NOT_FOUND" });
  });

  it("passes the margins payload through", async () => {
    const h = harness();
    expect(await json(await h.call("GET", "/v1/margin"))).toMatchObject({ clear_cash: 500_000 });
  });
});

describe("config", () => {
  const base = { RELAY_HMAC_SECRET: TEST_SECRET };

  it("has conservative defaults", () => {
    const { config } = loadConfig(base);
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 8790,
      live: false,
      dataProxy: false,
      allowedUnderlyings: ["NIFTY", "SENSEX"],
      productAllowlist: ["MIS"],
      maxLotsPerOrder: 2,
      maxOrdersPerDay: 12,
      tradingWindow: { startMin: 556, endMin: 912 },
      exitWindowEndMin: 925,
      allowShort: false,
      maxPremiumPerOrderInr: 25_000,
      maxDailyPremiumInr: 60_000,
      lotSizes: { NIFTY: 65, SENSEX: 20 },
      orderMinIntervalMs: 250,
      cfAccess: null,
    });
    expect(config.holidays.has("2026-10-20")).toBe(true);
    expect(loadConfig({ ...base, MARKET_HOLIDAYS: "" }).config.holidays.size).toBe(0);
    expect(loadConfig({ ...base, LOT_SIZES: "off" }).config.lotSizes).toEqual({});
  });

  it("fails fast on unsafe or broken settings", () => {
    const problems = (env: Record<string, string>) => {
      try {
        loadConfig(env);
        return [];
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        return (e as ConfigError).problems;
      }
    };
    expect(problems({})).toEqual([expect.stringMatching(/RELAY_HMAC_SECRET is required/)]);
    expect(problems({ RELAY_HMAC_SECRET: "short" })[0]).toMatch(/at least 16/);
    expect(problems({ ...base, RELAY_LIVE: "true" }).join()).toMatch(/requires GROWW_API_KEY/);
    expect(problems({ RELAY_HMAC_SECRET: "sixteen-chars-ok", RELAY_LIVE: "true", GROWW_API_KEY: "k", GROWW_TOTP_SECRET: "GEZDGNBV" }).join()).toMatch(
      /at least 32 characters/,
    );
    expect(problems({ ...base, RELAY_LIVE: "yes" }).join()).toMatch(/"true" or "false"/);
    expect(problems({ ...base, GROWW_API_KEY: "k", GROWW_TOTP_SECRET: "not base32!" }).join()).toMatch(/base32/);
    expect(problems({ ...base, CF_ACCESS_AUD: "aud" }).join()).toMatch(/CF_ACCESS_TEAM_DOMAIN/);
    expect(problems({ ...base, ALLOWED_UNDERLYINGS: "NIFTY,BANKNIFTY" }).join()).toMatch(/BANKNIFTY/);
    expect(problems({ ...base, TRADING_WINDOW_IST: "15:00-09:00" }).join()).toMatch(/TRADING_WINDOW_IST/);
    expect(problems({ ...base, EXIT_WINDOW_END_IST: "15:00" }).join()).toMatch(/EXIT_WINDOW_END_IST/);
    expect(problems({ ...base, ORDER_MIN_INTERVAL_MS: "50" }).join()).toMatch(/ORDER_MIN_INTERVAL_MS/);
    expect(problems({ ...base, MAX_PREMIUM_PER_ORDER_INR: "-5" }).join()).toMatch(/MAX_PREMIUM_PER_ORDER_INR/);
  });

  it("normalizes the Cloudflare Access team domain", () => {
    for (const team of ["ruphak", "ruphak.cloudflareaccess.com", "https://ruphak.cloudflareaccess.com/"]) {
      expect(loadConfig({ ...base, CF_ACCESS_TEAM_DOMAIN: team, CF_ACCESS_AUD: "aud" }).config.cfAccess).toEqual({
        teamDomain: "ruphak.cloudflareaccess.com",
        certsUrl: "https://ruphak.cloudflareaccess.com/cdn-cgi/access/certs",
        issuer: "https://ruphak.cloudflareaccess.com",
        aud: "aud",
      });
    }
  });

  it("never puts secrets in the startup description", () => {
    const { config } = loadConfig({
      ...base,
      RELAY_LIVE: "true",
      GROWW_API_KEY: "super-secret-api-key",
      GROWW_TOTP_SECRET: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      CF_ACCESS_TEAM_DOMAIN: "ruphak",
      CF_ACCESS_AUD: "0123456789abcdef0123456789abcdef",
    });
    const text = JSON.stringify(describeConfig(config));
    for (const secret of [TEST_SECRET, "super-secret-api-key", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "0123456789abcdef0123456789abcdef"]) {
      expect(text).not.toContain(secret);
    }
  });
});
