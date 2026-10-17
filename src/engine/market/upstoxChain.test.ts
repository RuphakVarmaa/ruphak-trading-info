import { describe, expect, it } from "vitest";
import type { OptionChainRowView, OptionSideView } from "../api-types";
import {
  UpstoxChainClient,
  atmStrike,
  buildOptionChainView,
  defaultExpiry,
  maxPainStrike,
  parseUpstoxChain,
  parseUpstoxContracts,
  parseUpstoxIndexLevels,
  parseUpstoxOptionSide,
  putCallRatio,
  upstoxFailureMessage,
} from "./upstoxChain";
import { NIFTY_CHAIN_SAMPLE, SENSEX_CHAIN_SAMPLE } from "./upstoxChain.fixture";
import { UpstoxError } from "./upstoxQuotes";

const ist = (s: string) => Date.parse(`${s}+05:30`);

/** A side with only open interest set, for the PCR and max-pain arithmetic. */
const side = (oi: number): OptionSideView => ({
  instrumentKey: "NSE_FO|1",
  ltp: null,
  close: null,
  change: null,
  changePct: null,
  bid: null,
  ask: null,
  bidQty: null,
  askQty: null,
  volume: null,
  oi,
  prevOi: null,
  oiChange: null,
  iv: null,
  delta: null,
  gamma: null,
  theta: null,
  vega: null,
  pop: null,
});
const row = (strike: number, ceOi: number, peOi: number): OptionChainRowView => ({ strike, ce: side(ceOi), pe: side(peOi) });

/** An index entry shaped like Upstox's documented full-quote response. */
const indexEntry = (token: string, last: number, netChange: number | undefined, ohlc = { open: 1, high: 2, low: 0.5, close: last }) => ({
  ohlc,
  depth: { buy: [], sell: [] },
  timestamp: "2026-10-14T14:10:00.000+05:30",
  instrument_token: token,
  symbol: token.split("|")[1],
  last_price: last,
  volume: 0,
  average_price: 0,
  oi: 0,
  ...(netChange === undefined ? {} : { net_change: netChange }),
  total_buy_quantity: 0,
  total_sell_quantity: 0,
  lower_circuit_limit: 0,
  upper_circuit_limit: 0,
  last_trade_time: "1792141200000",
  oi_day_high: 0,
  oi_day_low: 0,
});

describe("parseUpstoxChain", () => {
  it("parses the real NIFTY sample into rows sorted by strike, with the spot", () => {
    const c = parseUpstoxChain(NIFTY_CHAIN_SAMPLE);
    expect(c.spot).toBe(22622.7);
    expect(c.rows.map((r) => r.strike)).toEqual([22550, 22600, 22650, 22700]);
    const ce = c.rows[1].ce!;
    expect(ce).toEqual({
      instrumentKey: "NSE_FO|47139",
      ltp: 145.85,
      close: 280.9,
      change: -135.05,
      changePct: -48.08,
      bid: 145.25,
      ask: 145.85,
      bidQty: 65,
      askQty: 975,
      volume: 126185345,
      oi: 4482270,
      prevOi: 2798315,
      oiChange: 1683955,
      iv: 12.21,
      delta: 0.5443,
      gamma: 0.0012,
      theta: -12.8301,
      vega: 10.4958,
      pop: 36.12,
    });
    expect(c.rows[1].pe!.instrumentKey).toBe("NSE_FO|47140");
    expect(c.rows[1].pe!.change).toBe(58.15);
  });

  it("parses the real SENSEX sample", () => {
    const c = parseUpstoxChain(SENSEX_CHAIN_SAMPLE);
    expect(c.spot).toBe(72781.89);
    expect(c.rows.map((r) => r.strike)).toEqual([72700, 72800]);
    expect(c.rows[0].ce!.instrumentKey).toBe("BSE_FO|1115616");
    expect(atmStrike(c.rows, c.spot)).toBe(72800);
  });

  it("treats zero or missing bids, asks, prices and IV as not reported", () => {
    const s = parseUpstoxOptionSide({
      instrument_key: "BSE_FO|9",
      market_data: { ltp: 0, volume: 0, oi: 120, close_price: 0, bid_price: 0, bid_qty: 0, ask_price: 12.5, ask_qty: 40 },
      option_greeks: { vega: 0, theta: 0, gamma: 0, delta: 1, iv: 0, pop: 99 },
    })!;
    expect(s.ltp).toBeNull();
    expect(s.close).toBeNull();
    expect(s.change).toBeNull();
    expect(s.changePct).toBeNull();
    expect(s.bid).toBeNull();
    expect(s.bidQty).toBeNull();
    expect(s.ask).toBe(12.5);
    expect(s.askQty).toBe(40);
    expect(s.prevOi).toBeNull();
    expect(s.oiChange).toBeNull();
    expect(s.iv).toBeNull();
    expect(s.delta).toBe(1);
    expect(s.volume).toBe(0);
    expect(parseUpstoxOptionSide({ market_data: {} })).toBeNull();
    expect(parseUpstoxOptionSide(undefined)).toBeNull();
  });

  it("keeps a row with one side and drops rows without a strike or any side", () => {
    const c = parseUpstoxChain({
      status: "success",
      data: [
        { strike_price: 100, underlying_spot_price: 101, call_options: { instrument_key: "NSE_FO|1", market_data: { ltp: 2 } } },
        { strike_price: 0, call_options: { instrument_key: "NSE_FO|2" } },
        { strike_price: 110 },
        "junk",
      ],
    });
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0].pe).toBeNull();
    expect(parseUpstoxChain({ status: "error" })).toEqual({ spot: 0, rows: [] });
  });
});

describe("chain figures", () => {
  const rows = [row(100, 10, 0), row(110, 20, 5), row(120, 0, 40)];

  it("ATM is the strike nearest the spot, the lower one on a tie", () => {
    expect(atmStrike(rows, 113)).toBe(110);
    expect(atmStrike(rows, 115)).toBe(110);
    expect(atmStrike(rows, 116)).toBe(120);
    expect(atmStrike([], 116)).toBe(0);
  });

  it("PCR is total PE OI over total CE OI, null without CE OI", () => {
    expect(putCallRatio(rows)).toBe(1.5);
    expect(putCallRatio([row(100, 0, 5)])).toBeNull();
  });

  it("max pain minimises the OI-weighted intrinsic payout", () => {
    // Settle 100: PE 110 5x10 + PE 120 40x20 = 850; 110: CE 100 10x10 + PE 120 40x10 = 500; 120: CE 10x20 + 20x10 = 400.
    expect(maxPainStrike(rows)).toBe(120);
    // Settle 100: 50 + 600 = 650; 110 and 120 both 400: the lower wins.
    expect(maxPainStrike([row(100, 10, 0), row(110, 20, 5), row(120, 0, 30)])).toBe(110);
    expect(maxPainStrike([row(100, 0, 0)])).toBeNull();
    expect(maxPainStrike([])).toBeNull();
  });

  it("builds the view", () => {
    const v = buildOptionChainView({
      index: "NIFTY",
      expiry: "2026-10-19",
      meta: { expiries: ["2026-10-19"], lotSize: 65 },
      chain: parseUpstoxChain(NIFTY_CHAIN_SAMPLE),
      fetchedMs: ist("2026-10-14T14:10:00"),
    });
    expect(v.atmStrike).toBe(22600);
    expect(v.lotSize).toBe(65);
    expect(v.pcr).toBeGreaterThan(0);
    expect(v.maxPain).not.toBeNull();
    expect(v.fetchedAt).toBe("2026-10-14T14:10:00+05:30");
    expect(v.source).toBe("upstox");
    expect(v.error).toBeNull();
  });
});

describe("contracts and default expiry", () => {
  it("lists unique sorted expiries and the most common lot size", () => {
    const meta = parseUpstoxContracts({
      status: "success",
      data: [
        { expiry: "2026-10-27", lot_size: 65, instrument_type: "CE", strike_price: 22600 },
        { expiry: "2026-10-20", lot_size: 65, instrument_type: "PE", strike_price: 22600 },
        { expiry: "2026-10-20", lot_size: 65, instrument_type: "CE", strike_price: 22650 },
        { expiry: "2026-12-29", lot_size: 75 },
        { expiry: "bad" },
      ],
    });
    expect(meta).toEqual({ expiries: ["2026-10-20", "2026-10-27", "2026-12-29"], lotSize: 65 });
    expect(parseUpstoxContracts(null)).toEqual({ expiries: [], lotSize: 0 });
  });

  it("is the nearest expiry not before today, skipping today's after 15:30 IST", () => {
    const ex = ["2026-10-20", "2026-10-14", "2026-10-15"];
    expect(defaultExpiry(ex, ist("2026-10-14T09:00:00"))).toBe("2026-10-14");
    expect(defaultExpiry(ex, ist("2026-10-14T15:29:59"))).toBe("2026-10-14");
    expect(defaultExpiry(ex, ist("2026-10-14T15:30:00"))).toBe("2026-10-15");
    expect(defaultExpiry(ex, ist("2026-10-16T09:00:00"))).toBe("2026-10-20");
    expect(defaultExpiry(ex, ist("2026-10-21T09:00:00"))).toBeNull();
  });
});

describe("parseUpstoxIndexLevels", () => {
  it("maps the four indices from the full-quote response", () => {
    const levels = parseUpstoxIndexLevels({
      status: "success",
      data: {
        "NSE_INDEX:Nifty 50": indexEntry("NSE_INDEX|Nifty 50", 22622.7, -112.3, { open: 22700, high: 22750.5, low: 22580, close: 22622.7 }),
        "BSE_INDEX:SENSEX": indexEntry("BSE_INDEX|SENSEX", 72781.89, 250.11),
        "NSE_INDEX:Nifty Bank": indexEntry("NSE_INDEX|Nifty Bank", 51000, undefined),
        // Without instrument_token the data key's first ":" is read as "|".
        "NSE_INDEX:India VIX": { last_price: 14.2, net_change: 0.4, ohlc: { open: 13.8, high: 14.5, low: 13.6, close: 14.2 } },
      },
    });
    expect(levels.map((l) => l.key)).toEqual(["NIFTY", "SENSEX", "BANKNIFTY", "INDIAVIX"]);
    expect(levels[0]).toEqual({ key: "NIFTY", price: 22622.7, open: 22700, high: 22750.5, low: 22580, prevClose: 22735, change: -112.3, changePct: -0.49 });
    expect(levels[1].prevClose).toBe(72531.78);
    expect(levels[2]).toMatchObject({ price: 51000, prevClose: null, change: null, changePct: null });
    expect(levels[3]).toMatchObject({ price: 14.2, prevClose: 13.8, change: 0.4, changePct: 2.9 });
  });

  it("parses the LTP shape and skips indices without a price", () => {
    const levels = parseUpstoxIndexLevels({
      status: "success",
      data: { "NSE_INDEX:Nifty 50": { last_price: 22622.7, instrument_token: "NSE_INDEX|Nifty 50" }, "BSE_INDEX:SENSEX": { last_price: 0 } },
    });
    expect(levels).toEqual([{ key: "NIFTY", price: 22622.7, open: null, high: null, low: null, prevClose: null, change: null, changePct: null }]);
    expect(parseUpstoxIndexLevels({})).toEqual([]);
  });
});

describe("UpstoxChainClient", () => {
  it("sends the token only in the Authorization header and classifies failures", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new UpstoxChainClient({
      token: "secret-token",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ status: "error", errors: [{ errorCode: "UDAPI100050", message: "Too many requests" }] }), { status: 429 });
      },
    });
    const err = await client.chain("NIFTY", "2026-10-19").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstoxError);
    expect((err as UpstoxError).kind).toBe("rate_limited");
    expect(upstoxFailureMessage(err)).toBe("Upstox rate limit (HTTP 429)");
    expect(calls[0].url).toBe("https://api.upstox.com/v2/option/chain?instrument_key=NSE_INDEX%7CNifty%2050&expiry_date=2026-10-19");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    expect(String(err)).not.toContain("secret-token");
  });

  it("asks for the four index keys in one quotes call", async () => {
    let seen = "";
    const client = new UpstoxChainClient({
      token: "t",
      fetch: async (url) => {
        seen = url;
        return Response.json({ status: "success", data: {} });
      },
    });
    expect(await client.indexLevels()).toEqual([]);
    expect(seen).toBe(
      "https://api.upstox.com/v2/market-quote/quotes?instrument_key=NSE_INDEX%7CNifty%2050,BSE_INDEX%7CSENSEX,NSE_INDEX%7CNifty%20Bank,NSE_INDEX%7CIndia%20VIX",
    );
  });
});
