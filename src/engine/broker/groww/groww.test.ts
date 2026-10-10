import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../../clock";
import { DEFAULT_CONFIG } from "../../config";
import { silentLogger, sequentialIds } from "../../ports";
import { InMemoryRepository } from "../../repo/memory";
import type { OptionContract, OrderRequest, Quote } from "../../types";
import { GrowwTokenManager, mintTotpToken, nextTokenExpiry, parseGrowwExpiry } from "./auth";
import { parseGrowwTime, parseHistoricalCandles, parseOptionChain, parsePositions, parseQuote, GrowwDataClient } from "./data";
import { GrowwError, classifyGrowwFailure } from "./errors";
import { GrowwBroker, toRelayOrder, type OrderRelay } from "./growwBroker";
import { GrowwHttp, buildQuery, unwrapEnvelope } from "./http";
import { FallbackOptionQuotes, GrowwOptionQuotes, unusableQuote } from "./optionQuotes";
import { canonicalString, signRelayRequest, requestTarget, RelayClient, type RelayCreateResult, type RelayOrderStatus, type RelayTrade } from "./relayClient";
import { mapGrowwStatus } from "./status";
import { base32Decode, totp } from "./totp";

const IST = (s: string) => Date.parse(`${s}+05:30`);

describe("TOTP (RFC 6238)", () => {
  // RFC 6238 appendix B, SHA-1, secret "12345678901234567890" (base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ).
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  it.each(vectors)("t=%i -> %s", async (t, code) => {
    expect(await totp(secret, t * 1000, { digits: 8 })).toBe(code);
  });

  it("decodes base32 leniently and rejects junk", () => {
    expect(new TextDecoder().decode(base32Decode("gezd gnbv-gy3t qojq======"))).toBe("1234567890");
    expect(() => base32Decode("1!!")).toThrow();
  });

  it("produces 6-digit codes by default", async () => {
    expect(await totp(secret, 59_000)).toBe("287082");
  });
});

describe("Groww token handling", () => {
  it("expires tokens at the next 06:00 IST", () => {
    expect(nextTokenExpiry(IST("2026-10-07T05:59:00"))).toBe(IST("2026-10-07T06:00:00"));
    expect(nextTokenExpiry(IST("2026-10-07T08:00:00"))).toBe(IST("2026-10-08T06:00:00"));
  });

  it("parses expiry formats and caps them at the next 06:00 IST", () => {
    const now = IST("2026-10-07T08:00:00");
    expect(parseGrowwExpiry("2026-10-08T06:00:00", now)).toBe(IST("2026-10-08T06:00:00"));
    expect(parseGrowwExpiry("2026-10-08 05:00:00", now)).toBe(IST("2026-10-08T05:00:00"));
    expect(parseGrowwExpiry("2026-10-09T06:00:00+05:30", now)).toBe(IST("2026-10-08T06:00:00"));
    expect(parseGrowwExpiry(Math.floor(IST("2026-10-07T20:00:00") / 1000), now)).toBe(IST("2026-10-07T20:00:00"));
    expect(parseGrowwExpiry("garbage", now)).toBe(IST("2026-10-08T06:00:00"));
    expect(parseGrowwExpiry(null, now)).toBe(IST("2026-10-08T06:00:00"));
  });

  it("mints a token with the TOTP body and bare response shape", async () => {
    const now = IST("2026-10-07T08:00:10");
    let seen: { url: string; auth: string | null; body: unknown } | null = null;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ token: "tok-1", tokenRefId: "r", sessionName: "s", expiry: "2026-10-08T06:00:00", isActive: true }));
    };
    const t = await mintTotpToken({ apiKey: "KEY", totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", nowMs: () => now, fetchImpl });
    expect(t.token).toBe("tok-1");
    expect(t.expiryMs).toBe(IST("2026-10-08T06:00:00"));
    expect(seen!.url).toBe("https://api.groww.in/v1/token/api/access");
    expect(seen!.auth).toBe("Bearer KEY");
    expect(seen!.body).toEqual({ key_type: "totp", totp: await totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", now) });
  });

  it("classifies a failed mint", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ status: "FAILURE", error: { code: "GA005", message: "bad totp" } }), { status: 401 });
    await expect(mintTotpToken({ apiKey: "K", totpSecret: "GEZDGNBV", nowMs: () => 1_000, fetchImpl })).rejects.toMatchObject({ kind: "auth" });
  });

  it("caches, single-flights and throttles re-mints", async () => {
    let now = IST("2026-10-07T08:00:00");
    let mints = 0;
    const tm = new GrowwTokenManager({
      now: () => now,
      mint: async () => {
        mints++;
        return { token: `t${mints}`, expiryMs: nextTokenExpiry(now), mintedMs: now };
      },
    });
    const [a, b] = await Promise.all([tm.token(), tm.token()]);
    expect([a, b, mints]).toEqual(["t1", "t1", 1]);
    tm.invalidate("t1");
    await expect(tm.token()).rejects.toBeInstanceOf(GrowwError); // re-mint within 5 min is throttled
    now += 6 * 60_000;
    expect(await tm.token()).toBe("t2");
    now = IST("2026-10-08T05:57:00"); // under 5 minutes of life left
    expect(await tm.token()).toBe("t3");
  });

  it("backs off after a failed mint instead of minting on every data call (5 min doubling to 30 min); force tries anyway", async () => {
    let now = IST("2026-10-07T08:00:00");
    let attempts = 0;
    let accept = false;
    const tm = new GrowwTokenManager({
      now: () => now,
      mint: async () => {
        attempts++;
        if (!accept) throw new GrowwError("Groww token: approve the API key in the app", "auth", 401);
        return { token: `t${attempts}`, expiryMs: nextTokenExpiry(now), mintedMs: now };
      },
    });
    await expect(tm.token()).rejects.toThrow(/approve the API key/);
    // Every data call during the backoff fails at once, without another token request.
    for (let i = 0; i < 20; i++) await expect(tm.token()).rejects.toThrow(/minting paused for 300 s after 1 failed attempt\(s\): Groww token: approve/);
    expect(attempts).toBe(1);
    now += 5 * 60_000;
    await expect(tm.token()).rejects.toThrow(/approve/);
    expect(attempts).toBe(2);
    expect(tm.status()).toMatchObject({ valid: false, failures: 2, retryAtMs: now + 10 * 60_000 });
    now += 10 * 60_000;
    await expect(tm.token()).rejects.toThrow(/approve/);
    now += 20 * 60_000;
    await expect(tm.token()).rejects.toThrow(/approve/);
    expect(tm.status().retryAtMs).toBe(now + 30 * 60_000); // capped at 30 min
    expect(attempts).toBe(4);
    // The owner approves the key; the 08:00 job (or POST /ops/token) forces an attempt at once.
    accept = true;
    await expect(tm.token()).rejects.toThrow(/minting paused/);
    expect((await tm.refresh({ force: true })).token).toBe("t5");
    expect(await tm.token()).toBe("t5");
    expect(tm.status()).toMatchObject({ valid: true, failures: 0, retryAtMs: null });
  });
});

describe("Groww HTTP envelope", () => {
  it("unwraps SUCCESS and maps FAILURE codes", () => {
    expect(unwrapEnvelope(200, JSON.stringify({ status: "SUCCESS", payload: { a: 1 } }), "x")).toEqual({ a: 1 });
    expect(() => unwrapEnvelope(400, JSON.stringify({ status: "FAILURE", error: { code: "GA007", message: "dup" } }), "x")).toThrow(/dup/);
    try {
      unwrapEnvelope(400, JSON.stringify({ status: "FAILURE", error: { code: "GA007", message: "dup" } }), "x");
    } catch (e) {
      expect((e as GrowwError).kind).toBe("duplicate");
    }
    expect(classifyGrowwFailure(503)).toBe("transient");
    expect(classifyGrowwFailure(429)).toBe("rate_limited");
    expect(classifyGrowwFailure(403, "GA005")).toBe("forbidden");
    expect(buildQuery({ a: "x y", b: undefined, c: 3 })).toBe("?a=x%20y&c=3");
  });

  it("re-authenticates once after a 401", async () => {
    const tokens: string[] = [];
    let n = 0;
    const tm = { token: async () => `tok${n}`, invalidate: (t: string) => { tokens.push(t); n++; } };
    const fetchImpl = async (_: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth === "Bearer tok0") return new Response(JSON.stringify({ status: "FAILURE", error: { code: "GA005", message: "expired" } }), { status: 401 });
      return new Response(JSON.stringify({ status: "SUCCESS", payload: { NSE_NIFTY: 22600.5 } }));
    };
    const http = new GrowwHttp({ tokens: tm, fetchImpl, minIntervalMs: { live: 0, nontrading: 0, orders: 0 } });
    const data = new GrowwDataClient(http);
    expect(await data.ltp("CASH", ["NSE_NIFTY"])).toEqual({ NSE_NIFTY: 22600.5 });
    expect(tokens).toEqual(["tok0"]);
  });
});

describe("Groww payload parsers", () => {
  it("parses naive timestamps as IST", () => {
    expect(parseGrowwTime("2026-10-07T10:30:00")).toBe(IST("2026-10-07T10:30:00"));
    expect(parseGrowwTime("2026-10-07 10:30:00")).toBe(IST("2026-10-07T10:30:00"));
    expect(parseGrowwTime(1791354600)).toBe(1791354600_000);
    expect(parseGrowwTime("2026-10-07T05:00:00Z")).toBe(Date.parse("2026-10-07T05:00:00Z"));
  });

  it("parses a quote with depth", () => {
    const q = parseQuote(
      "NIFTY26O1322600CE",
      {
        last_price: 142.5,
        bid_price: 142.3,
        offer_price: 142.7,
        bid_quantity: 650,
        offer_quantity: 1300,
        open_interest: 1_250_000,
        implied_volatility: 13.2,
        volume: 4_000_000,
        depth: { buy: [{ price: 142.3, quantity: 650 }], sell: [{ price: 142.7, quantity: 1300 }, { price: 142.8, quantity: 2000 }] },
      },
      1_000,
    );
    expect(q).toMatchObject({ ltp: 142.5, bid: 142.3, ask: 142.7, bidQty: 650, askQty: 1300, oi: 1_250_000, source: "groww", t: 1_000 });
    // Percent, like synthetic quotes: the planner divides Quote.iv by 100.
    expect(q.iv).toBeCloseTo(13.2);
    expect(parseQuote("X", { implied_volatility: 0.132 }, 1).iv).toBeCloseTo(13.2);
    expect(q.depth?.sell).toHaveLength(2);
  });

  it("parses an option chain", () => {
    const c = parseOptionChain({
      underlying_ltp: 22603.2,
      strikes: {
        "22600": {
          CE: { trading_symbol: "NIFTY26O1322600CE", ltp: 142.5, open_interest: 10, greeks: { delta: 0.52, iv: 13.1 } },
          PE: { trading_symbol: "NIFTY26O1322600PE", ltp: 120.1, open_interest: 12, greeks: { delta: -0.48, iv: 13.4 } },
        },
        "22550": { CE: { trading_symbol: "NIFTY26O1322550CE", ltp: 170 } },
      },
    });
    expect(c.underlyingLtp).toBe(22603.2);
    expect(c.rows.map((r) => `${r.strike}${r.type}`)).toEqual(["22550CE", "22600CE", "22600PE"]);
    expect(c.rows[1].iv).toBeCloseTo(0.131);
  });

  it("parses historical candles, sorted and de-duplicated", () => {
    const candles = parseHistoricalCandles({
      candles: [
        ["2026-10-07T09:20:00", 2, 3, 1, 2.5, 100, 5000],
        ["2026-10-07T09:15:00", 1, 2, 0.5, 1.5, 50, null],
        ["2026-10-07T09:20:00", 2, 3, 1, 2.5, 100, 5000],
        ["bad"],
      ],
    });
    expect(candles.map((c) => c.t)).toEqual([IST("2026-10-07T09:15:00"), IST("2026-10-07T09:20:00")]);
    expect(candles[1].oi).toBe(5000);
    expect(candles[0].oi).toBeUndefined();
  });

  it("parses positions", () => {
    expect(parsePositions({ positions: [{ trading_symbol: "NIFTY26O1322600CE", exchange: "NSE", product: "MIS", quantity: 65, net_price: 142.5 }] })).toEqual([
      { tradingSymbol: "NIFTY26O1322600CE", exchange: "NSE", product: "MIS", qty: 65, avgPrice: 142.5, realisedPnl: null },
    ]);
  });

  it("maps order statuses", () => {
    expect(mapGrowwStatus("ACKED", 0, 65)).toBe("OPEN");
    expect(mapGrowwStatus("OPEN", 65, 130)).toBe("PARTIAL");
    expect(mapGrowwStatus("EXECUTED", 65, 65)).toBe("FILLED");
    expect(mapGrowwStatus("REJECTED", 0, 65)).toBe("REJECTED");
    expect(mapGrowwStatus("CANCELLED", 65, 130)).toBe("CANCELLED");
    expect(mapGrowwStatus("SOMETHING_NEW", 0, 65)).toBe("UNKNOWN");
  });
});

describe("paper quotes on Groww (the fallback to synthetic quotes)", () => {
  const leg: OptionContract = {
    index: "NIFTY",
    exchange: "NSE",
    tradingSymbol: "NIFTY26O1324500CE",
    growwSymbol: "NSE-NIFTY-13Oct26-24500-CE",
    exchangeToken: "1",
    expiry: "2026-10-13",
    strike: 24_500,
    type: "CE",
    lotSize: 65,
    tickSize: 0.05,
  };
  const ctx = { t: 1, spot: 24_500, vix: 14 };
  const synthetic = { kind: "synthetic" as const, quote: async (): Promise<Quote> => ({ symbol: leg.tradingSymbol, t: 1, ltp: 100, bid: 99.8, ask: 100.2, bidQty: 650, askQty: 650, source: "synthetic" }) };

  /** A Groww data client over a fake transport: `reply` decides each /live-data/quote answer. */
  function groww(reply: () => unknown) {
    let calls = 0;
    const transport = {
      request: async <T,>(): Promise<T> => {
        calls++;
        const r = reply();
        if (r instanceof Error) throw r;
        return r as T;
      },
    };
    return { data: new GrowwDataClient(transport), calls: () => calls };
  }

  it("uses a real two-sided quote as it is", async () => {
    const g = groww(() => ({ last_price: 101, bid_price: 100.9, offer_price: 101.1 }));
    const q = await new FallbackOptionQuotes(new GrowwOptionQuotes(g.data, DEFAULT_CONFIG), synthetic).quote(leg, ctx);
    expect(q).toMatchObject({ source: "groww", bid: 100.9, ask: 101.1 });
  });

  it("falls back when Groww's answer cannot price a fill or an exit: empty, one-sided or crossed", async () => {
    expect(unusableQuote({ symbol: "x", t: 1, ltp: 0, bid: 0, ask: 0, bidQty: 0, askQty: 0, source: "groww" })).toMatch(/no two-sided quote/);
    for (const payload of [{}, { last_price: 101, bid_price: 100.9, offer_price: 0 }, { last_price: 101, bid_price: 0, offer_price: 101.1 }, { bid_price: 102, offer_price: 101 }]) {
      const seen: unknown[] = [];
      const q = await new FallbackOptionQuotes(new GrowwOptionQuotes(groww(() => payload).data, DEFAULT_CONFIG), synthetic, (e) => seen.push(e)).quote(leg, ctx);
      expect(q.source).toBe("synthetic");
      expect(String(seen[0])).toMatch(/groww quote for NIFTY26O1324500CE unusable: (no two-sided|crossed) quote/);
    }
  });

  it("pauses Groww for paper after a failure that is not about the symbol, so later quotes skip the wait", async () => {
    let now = 1_000_000;
    let fail: Error | null = new GrowwError("Groww GET /live-data/quote: The operation timed out", "transient", 0);
    const g = groww(() => fail ?? { last_price: 101, bid_price: 100.9, offer_price: 101.1 });
    const paper = new GrowwOptionQuotes(g.data, DEFAULT_CONFIG, { pauseAfterErrorMs: 30_000, cacheMs: 0, now: () => now });
    const fb = new FallbackOptionQuotes(paper, synthetic);
    expect((await fb.quote(leg, ctx)).source).toBe("synthetic");
    fail = null;
    for (let i = 0; i < 5; i++) expect((await fb.quote(leg, ctx)).source).toBe("synthetic");
    expect(g.calls()).toBe(1); // no Groww call during the pause
    await expect(paper.quote(leg)).rejects.toThrow(/paused for 30 s after: Groww GET \/live-data\/quote: The operation timed out/);
    now += 30_000;
    expect((await fb.quote(leg, ctx)).source).toBe("groww");
    expect(g.calls()).toBe(2);
    // A bad symbol is not a reason to stop quoting the others.
    fail = new GrowwError("Groww GET /live-data/quote: invalid symbol (GA001)", "bad_request", 400);
    await expect(paper.quote({ ...leg, tradingSymbol: "BAD" })).rejects.toThrow(/invalid symbol/);
    fail = null;
    expect((await paper.quote({ ...leg, tradingSymbol: "OTHER" })).source).toBe("groww");
  });

  it("never pauses the LIVE instance (no pause option)", async () => {
    let fail = true;
    const g = groww(() => (fail ? new GrowwError("Groww: 503", "transient", 503) : { last_price: 101, bid_price: 100.9, offer_price: 101.1 }));
    const live = new GrowwOptionQuotes(g.data, DEFAULT_CONFIG, { cacheMs: 0 });
    await expect(live.quote(leg)).rejects.toThrow(/503/);
    fail = false;
    expect((await live.quote(leg)).bid).toBe(100.9);
    expect(g.calls()).toBe(2);
  });
});

describe("relay request signing", () => {
  it("matches the relay's canonical string and HMAC", async () => {
    const body = JSON.stringify({ a: 1 });
    const url = "https://relay.example.com/v1/orders/ref/RT123ABCD?segment=FNO";
    const h = await signRelayRequest("s3cret", "get", url, body, 1_791_354_600_000, "0123456789abcdef0123456789abcdef");
    const canonical = canonicalString(h["x-relay-ts"], h["x-relay-nonce"], "GET", "/v1/orders/ref/RT123ABCD?segment=FNO", createHash("sha256").update(body).digest("hex"));
    expect(canonical).toBe(`1791354600000\n0123456789abcdef0123456789abcdef\nGET\n/v1/orders/ref/RT123ABCD?segment=FNO\n${createHash("sha256").update(body).digest("hex")}`);
    expect(h["x-relay-sig"]).toBe(createHmac("sha256", "s3cret").update(canonical, "utf8").digest("hex"));
    expect(requestTarget("https://r.example.com")).toBe("/");
    expect(requestTarget("https://r.example.com/a?b=1#c")).toBe("/a?b=1");
  });

  it("sends signed headers and Access headers, and maps create outcomes", async () => {
    const calls: { url: string; headers: Headers; body: string }[] = [];
    const replies = [
      new Response(JSON.stringify({ status: "ACCEPTED", growwOrderId: "GMK1", orderStatus: "ACKED" })),
      new Response(JSON.stringify({ status: "REJECTED", reason: "max lots", rejectedBy: "RELAY" }), { status: 422 }),
      new Response(JSON.stringify({ error: "timeout", code: "ORDER_OUTCOME_UNKNOWN" }), { status: 502 }),
    ];
    const relay = new RelayClient({
      baseUrl: "https://relay.example.com/",
      hmacSecret: "s",
      accessClientId: "id",
      accessClientSecret: "sec",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
        return replies.shift()!;
      },
    });
    const req = toRelayOrder(order());
    expect(await relay.createOrder(req)).toEqual({ kind: "accepted", growwOrderId: "GMK1", orderStatus: "ACKED", duplicate: false, reason: undefined });
    expect(await relay.createOrder(req)).toEqual({ kind: "rejected", reason: "max lots", by: "RELAY" });
    expect((await relay.createOrder(req)).kind).toBe("unknown");
    expect(calls[0].url).toBe("https://relay.example.com/v1/orders");
    expect(calls[0].headers.get("cf-access-client-id")).toBe("id");
    expect(calls[0].headers.get("x-relay-sig")).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(calls[0].body)).toMatchObject({ idempotencyKey: "RTESTREF0001", underlying: "NIFTY", orderType: "LIMIT", price: 142.9, validity: "DAY", segment: "FNO" });
  });
});

// ---------------------------------------------------------------------------
// Live broker over a fake relay
// ---------------------------------------------------------------------------

const contract: OptionContract = {
  index: "NIFTY",
  exchange: "NSE",
  tradingSymbol: "NIFTY26O1322600CE",
  growwSymbol: "NSE-NIFTY-13Oct26-22600-CE",
  exchangeToken: "44388",
  expiry: "2026-10-13",
  strike: 22600,
  type: "CE",
  lotSize: 65,
  tickSize: 0.05,
};

function order(over: Partial<OrderRequest> = {}): OrderRequest {
  return { refId: "RTESTREF0001", contract, side: "BUY", qty: 130, type: "LIMIT", limitPrice: 142.9, product: "MIS", reason: "ENTRY", planId: "p1", ...over };
}

class FakeRelay implements OrderRelay {
  create: RelayCreateResult = { kind: "accepted", growwOrderId: "G1", orderStatus: "ACKED", duplicate: false };
  statuses: (RelayOrderStatus | null)[] = [];
  tradeList: RelayTrade[] = [];
  cancelled: string[] = [];
  async createOrder(): Promise<RelayCreateResult> {
    return this.create;
  }
  async statusByRef(): Promise<RelayOrderStatus | null> {
    return this.statuses.length > 1 ? this.statuses.shift()! : (this.statuses[0] ?? null);
  }
  async trades(): Promise<RelayTrade[]> {
    return this.tradeList;
  }
  async cancel(id: string) {
    this.cancelled.push(id);
    return { orderStatus: "CANCELLATION_REQUESTED" };
  }
  async positions() {
    return [];
  }
  async health() {
    return { reachable: true, ok: true, live: true, growwReachable: true, publicIp: "1.2.3.4", tokenValidUntil: null, ordersToday: 0, detail: "ok" };
  }
}

function broker(relay: FakeRelay) {
  const clock = new FixedClock(IST("2026-10-07T10:00:00"));
  const repo = new InMemoryRepository(DEFAULT_CONFIG, clock.now());
  return { clock, repo, b: new GrowwBroker({ relay, repo, clock, newId: sequentialIds("o"), logger: silentLogger, postCreatePollsMs: [1000] }) };
}

describe("GrowwBroker", () => {
  it("records fills from trades, capped by the filled quantity", async () => {
    const relay = new FakeRelay();
    relay.statuses = [{ growwOrderId: "G1", orderStatus: "EXECUTED", filledQty: 130, avgFillPrice: 142.75, remark: null }];
    relay.tradeList = [
      { tradeId: "T1", price: 142.7, qty: 65, time: "2026-10-07T10:00:01" },
      { tradeId: "T2", price: 142.8, qty: 65, time: "2026-10-07T10:00:01" },
      { tradeId: "T3", price: 150, qty: 65, time: "2026-10-07T10:00:02" }, // beyond the filled quantity
    ];
    const { b } = broker(relay);
    const res = await b.placeOrder(order());
    expect(res.order).toMatchObject({ status: "FILLED", filledQty: 130, avgFillPrice: 142.75, brokerOrderId: "G1", mode: "LIVE" });
    expect(res.fills.map((f) => [f.brokerTradeId, f.qty, f.price])).toEqual([
      ["T1", 65, 142.7],
      ["T2", 65, 142.8],
    ]);
    expect(res.fills[0].charges.total).toBeGreaterThan(0);
  });

  it("falls back to the average-price delta when trades are unavailable, then de-duplicates", async () => {
    const relay = new FakeRelay();
    relay.statuses = [
      { growwOrderId: "G1", orderStatus: "OPEN", filledQty: 65, avgFillPrice: 142.7, remark: null },
      { growwOrderId: "G1", orderStatus: "EXECUTED", filledQty: 130, avgFillPrice: 142.8, remark: null },
    ];
    const { b, repo } = broker(relay);
    const first = await b.placeOrder(order());
    expect(first.order).toMatchObject({ status: "PARTIAL", filledQty: 65 });
    expect(first.fills).toHaveLength(1);
    expect(first.fills[0].price).toBe(142.7);
    await repo.orders.save(first.order);
    for (const f of first.fills) await repo.fills.append(f);
    const second = await b.refreshOrder(first.order);
    expect(second.order).toMatchObject({ status: "FILLED", filledQty: 130, avgFillPrice: 142.8 });
    expect(second.fills).toHaveLength(1);
    expect(second.fills[0].price).toBeCloseTo(142.9, 2); // (142.8 * 130 - 142.7 * 65) / 65
    const third = await b.refreshOrder(second.order);
    expect(third.fills).toHaveLength(0);
  });

  it("rejects without retrying when the relay refuses", async () => {
    const relay = new FakeRelay();
    relay.create = { kind: "rejected", reason: "relay not live", by: "RELAY" };
    const { b } = broker(relay);
    const res = await b.placeOrder(order());
    expect(res.order.status).toBe("REJECTED");
    expect(res.order.error).toMatch(/relay not live/);
  });

  it("keeps an unknown outcome open, then recovers it by reference", async () => {
    const relay = new FakeRelay();
    relay.create = { kind: "unknown", reason: "timeout" };
    relay.statuses = [null, { growwOrderId: "G9", orderStatus: "EXECUTED", filledQty: 130, avgFillPrice: 143, remark: null }];
    const { b } = broker(relay);
    const res = await b.placeOrder(order());
    expect(res.order.status).toBe("UNKNOWN");
    const later = await b.refreshOrder(res.order);
    expect(later.order).toMatchObject({ status: "FILLED", brokerOrderId: "G9", filledQty: 130 });
    expect(later.order.error).toBeUndefined();
  });

  it("gives up on an order the broker never saw", async () => {
    const relay = new FakeRelay();
    relay.create = { kind: "unknown", reason: "timeout" };
    relay.statuses = [null];
    const { b, clock } = broker(relay);
    const res = await b.placeOrder(order());
    clock.advance(5 * 60_000);
    expect((await b.refreshOrder(res.order)).order.status).toBe("REJECTED");
  });

  it("cancels by broker id and reads the final state", async () => {
    const relay = new FakeRelay();
    relay.statuses = [
      { growwOrderId: "G1", orderStatus: "OPEN", filledQty: 0, avgFillPrice: null, remark: null },
      { growwOrderId: "G1", orderStatus: "CANCELLED", filledQty: 0, avgFillPrice: null, remark: null },
    ];
    const { b } = broker(relay);
    const placed = await b.placeOrder(order());
    expect(placed.order.status).toBe("OPEN");
    const res = await b.cancelOrder(placed.order);
    expect(relay.cancelled).toEqual(["G1"]);
    expect(res.order.status).toBe("CANCELLED");
  });

  it("reports health from the relay", async () => {
    const { b } = broker(new FakeRelay());
    expect(await b.health()).toEqual({ ok: true, detail: "ok" });
  });
});
