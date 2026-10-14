import { describe, expect, it } from "vitest";
import { NIFTY_CHAIN_SAMPLE } from "./upstoxChain.fixture";
import { NO_QUOTE_SOURCE, UpstoxLive } from "./upstoxLive";

const ist = (s: string) => Date.parse(`${s}+05:30`);

const CONTRACTS = {
  status: "success",
  data: [
    { expiry: "2026-10-14", lot_size: 65 },
    { expiry: "2026-10-19", lot_size: 65 },
    { expiry: "2026-10-27", lot_size: 65 },
  ],
};
const QUOTES = {
  status: "success",
  data: { "NSE_INDEX:Nifty 50": { last_price: 22622.7, net_change: -112.3, instrument_token: "NSE_INDEX|Nifty 50" } },
};

/** A fake Upstox: answers by path, counts calls, and can be told to fail. */
function harness(start = ist("2026-10-14T16:00:00"), budgetPerMinute?: number) {
  const clock = { t: start };
  const calls: string[] = [];
  const fail: { status: number | null } = { status: null };
  const gates: (() => void)[] = [];
  const hold = { on: false };
  const live = new UpstoxLive({
    token: "tok",
    now: () => clock.t,
    budgetPerMinute,
    fetch: async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (hold.on) await new Promise<void>((r) => gates.push(r));
      if (fail.status !== null) return Response.json({ status: "error", errors: [{ errorCode: "X", message: "nope" }] }, { status: fail.status });
      if (path === "/v2/option/contract") return Response.json(CONTRACTS);
      if (path === "/v2/option/chain") return Response.json(NIFTY_CHAIN_SAMPLE);
      return Response.json(QUOTES);
    },
  });
  const count = (p: string) => calls.filter((c) => c === p).length;
  return { live, clock, calls, fail, gates, hold, count };
}

describe("UpstoxLive", () => {
  it("returns the no-source views without a token and fetches nothing", async () => {
    const live = new UpstoxLive({
      fetch: async () => {
        throw new Error("no fetch expected");
      },
    });
    const chain = await live.getOptionChain("SENSEX");
    expect(chain).toMatchObject({ index: "SENSEX", rows: [], error: NO_QUOTE_SOURCE, source: "upstox" });
    const idx = await live.getLiveIndices();
    expect(idx).toMatchObject({ levels: [], error: NO_QUOTE_SOURCE });
    expect(live.requests).toBe(0);
  });

  it("defaults to the next expiry after today's 15:30 and builds the view", async () => {
    const h = harness();
    const v = await h.live.getOptionChain("NIFTY");
    expect(v.expiry).toBe("2026-10-19");
    expect(v.expiries).toEqual(["2026-10-14", "2026-10-19", "2026-10-27"]);
    expect(v.lotSize).toBe(65);
    expect(v.rows).toHaveLength(4);
    expect(v.atmStrike).toBe(22600);
    expect(v.error).toBeNull();
    expect(v.fetchedAt).toBe("2026-10-14T16:00:00+05:30");
  });

  it("collapses concurrent identical requests into one fetch each", async () => {
    const h = harness();
    h.hold.on = true;
    const all = Promise.all([h.live.getOptionChain("NIFTY"), h.live.getOptionChain("NIFTY"), h.live.getOptionChain("NIFTY", "2026-10-19")]);
    while (h.gates.length < 1) await new Promise((r) => setTimeout(r, 0));
    h.gates.shift()!();
    while (h.gates.length < 1) await new Promise((r) => setTimeout(r, 0));
    h.gates.shift()!();
    const views = await all;
    expect(views.every((v) => v.rows.length === 4)).toBe(true);
    expect(h.count("/v2/option/contract")).toBe(1);
    expect(h.count("/v2/option/chain")).toBe(1);
  });

  it("caches the chain 5 s and the expiries 30 min", async () => {
    const h = harness();
    await h.live.getOptionChain("NIFTY");
    h.clock.t += 4_999;
    await h.live.getOptionChain("NIFTY");
    expect(h.count("/v2/option/chain")).toBe(1);
    h.clock.t += 1;
    await h.live.getOptionChain("NIFTY");
    expect(h.count("/v2/option/chain")).toBe(2);
    expect(h.count("/v2/option/contract")).toBe(1);
    h.clock.t += 30 * 60_000;
    await h.live.getOptionChain("NIFTY");
    expect(h.count("/v2/option/contract")).toBe(2);
  });

  it("serves the last good chain for up to 60 s after a 429, and backs off", async () => {
    const h = harness();
    await h.live.getOptionChain("NIFTY");
    h.fail.status = 429;
    h.clock.t += 5_000;
    const v = await h.live.getOptionChain("NIFTY");
    expect(v.rows).toHaveLength(4);
    expect(v.error).toBe("Upstox rate limit (HTTP 429)");
    expect(v.fetchedAt).toBe("2026-10-14T16:00:00+05:30");
    // Within the 20 s cooldown nothing is sent.
    h.clock.t += 10_000;
    const during = await h.live.getOptionChain("NIFTY");
    expect(during.rows).toHaveLength(4);
    expect(during.error).toMatch(/429/);
    expect(h.count("/v2/option/chain")).toBe(2);
    // Past 60 s since the last good fetch the rows go.
    h.clock.t += 50_000;
    const gone = await h.live.getOptionChain("NIFTY");
    expect(gone.rows).toEqual([]);
    expect(gone.error).toMatch(/429/);
    expect(h.count("/v2/option/chain")).toBe(3);
    // Recovered, once the second 429's cooldown is over.
    h.fail.status = null;
    h.clock.t += 20_000;
    const back = await h.live.getOptionChain("NIFTY");
    expect(back.rows).toHaveLength(4);
    expect(back.error).toBeNull();
  });

  it("reports an error with no rows when the first fetch fails", async () => {
    const h = harness();
    h.fail.status = 500;
    const v = await h.live.getOptionChain("NIFTY");
    expect(v.rows).toEqual([]);
    expect(v.error).toMatch(/HTTP 500/);
    expect(v.error).not.toContain("tok");
  });

  it("refuses an expiry that is not listed without fetching its chain", async () => {
    const h = harness();
    const v = await h.live.getOptionChain("NIFTY", "2026-11-03");
    expect(v.rows).toEqual([]);
    expect(v.error).toBe("NIFTY has no listed expiry 2026-11-03");
    expect(v.expiries).toHaveLength(3);
    expect(h.count("/v2/option/chain")).toBe(0);
  });

  it("caches index levels 3 s", async () => {
    const h = harness();
    const a = await h.live.getLiveIndices();
    expect(a.levels).toEqual([{ key: "NIFTY", price: 22622.7, open: null, high: null, low: null, prevClose: 22735, change: -112.3, changePct: -0.49 }]);
    expect(a.error).toBeNull();
    h.clock.t += 2_999;
    await h.live.getLiveIndices();
    h.clock.t += 1;
    await h.live.getLiveIndices();
    expect(h.count("/v2/market-quote/quotes")).toBe(2);
  });

  it("never exceeds the request budget, serving cached values meanwhile", async () => {
    const h = harness(ist("2026-10-14T16:00:00"), 5);
    for (let i = 0; i < 120; i++) {
      await Promise.all([h.live.getLiveIndices(), h.live.getOptionChain("NIFTY"), h.live.getOptionChain("SENSEX")]);
      h.clock.t += 1_000;
    }
    // Two minutes at most 5 a minute (the SENSEX chain reuses the fake's NIFTY sample).
    expect(h.calls.length).toBeLessThanOrEqual(10);
    const v = await h.live.getLiveIndices();
    expect(v.levels).toHaveLength(1);
  });

  it("stays within the default budget under heavy polling", async () => {
    const h = harness();
    for (let i = 0; i < 600; i++) {
      await Promise.all([h.live.getLiveIndices(), h.live.getOptionChain("NIFTY"), h.live.getOptionChain("SENSEX"), h.live.getOptionChain("NIFTY", "2026-10-27")]);
      h.clock.t += 100;
    }
    expect(h.calls.length).toBeLessThanOrEqual(30);
  });
});
