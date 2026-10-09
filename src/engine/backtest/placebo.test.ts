import { describe, expect, it } from "vitest";
import { accountConfig } from "../accounts";
import { TradingCalendar } from "../calendar/calendar";
import { addDays, istAt, istMinutes, istParts, MINUTE_MS, weekdayOf } from "../clock";
import { DEFAULT_CONFIG, premiumBand, withOverrides } from "../config";
import { ReplayMarketDataSource, YAHOO_LAG_MS } from "../market/replayMarketData";
import { publishedSignal } from "../strategy/published";
import { loadMarketFixtures } from "../testing/fixtures";
import { MARKET_SYMBOLS } from "../types";
import { entrySlots, randomEntryPlacebo, regimeLookup, sessionsWithData } from "./placebo";

const fixtures = loadMarketFixtures();
const calendar = new TradingCalendar();
const base = { cfg: DEFAULT_CONFIG, candles: fixtures.candles, daily: fixtures.daily, from: "2026-10-01", to: "2026-10-07", draws: 150, seed: 7 };
const MECHANICAL = ["STOP", "TARGET", "TRAIL", "TIME_STOP", "SQUARE_OFF"];
const sameDraws = (a: { day: string; index: string; side: string; entryMs: number }[]) => a.map((t) => [t.day, t.index, t.side, t.entryMs]);

describe("random-entry placebo", () => {
  it("draws the backtest's sessions and the engine's entry slots", () => {
    expect(sessionsWithData(fixtures.candles, ["NIFTY", "SENSEX"], "2026-10-01", "2026-10-07", calendar)).toEqual(["2026-10-01", "2026-10-05", "2026-10-06", "2026-10-07"]);
    const slots = entrySlots(DEFAULT_CONFIG, YAHOO_LAG_MS);
    // Bar closes 09:25..14:25: decided at 09:26:30..14:26:30, inside the 09:25-14:30 entry gate.
    expect([slots[0], slots[slots.length - 1], slots.length]).toEqual([9 * 60 + 25, 14 * 60 + 25, 61]);
    expect(entrySlots(DEFAULT_CONFIG, YAHOO_LAG_MS, 5 * MINUTE_MS, { from: "09:25", to: "14:30" })).toHaveLength(62);
  });

  it("is reproducible for a seed and trades as the engine would: nearest weekly not expiring today, ATM, one lot, mechanical exits", async () => {
    const a = await randomEntryPlacebo(base);
    expect((await randomEntryPlacebo(base)).trades).toEqual(a.trades);
    expect(sameDraws((await randomEntryPlacebo({ ...base, seed: 8 })).trades)).not.toEqual(sameDraws(a.trades));
    expect(a.trades).toHaveLength(150);
    expect(a.summary.n).toBe(150);
    expect(a.summary.mean).toBeCloseTo(a.trades.reduce((s, t) => s + t.pnl, 0) / 150, 1);
    for (const t of a.trades) {
      expect(t.lots).toBe(1); // main's settings allow one lot per order, as in every backtest trade
      expect(MECHANICAL).toContain(t.exitReason);
      const m = istMinutes(t.entryMs);
      expect(m >= 9 * 60 + 25 && m <= 14 * 60 + 30).toBe(true);
      expect(t.exitMs).toBeLessThanOrEqual(istAt(t.day, "15:05") + 5 * MINUTE_MS);
      const next = calendar.nextExpiry(t.index, t.entryMs);
      expect(t.expiry).toBe(next === t.day ? calendar.followingExpiry(t.index, next) : next);
      expect(t.strike % DEFAULT_CONFIG.indexSpecs[t.index].strikeStep).toBe(0);
      expect(t.pnl).toBeCloseTo(t.grossPnl - t.charges, 1);
      expect(t.charges).toBeGreaterThan(0);
    }
  });

  it("takes the time stop from the regime the engine saw, or a fixed horizon", async () => {
    const trend = await randomEntryPlacebo({ ...base, regimeAt: () => "TREND_UP" });
    for (const t of trend.trades) {
      expect(t.regime).toBe("TREND_UP");
      expect(t.horizonMin).toBe(Math.min(120, Math.floor((istAt(t.day, "15:05") - t.entryMs) / MINUTE_MS)));
    }
    const fixed = await randomEntryPlacebo({ ...base, horizonMin: 45 });
    for (const t of fixed.trades) {
      expect(t.horizonMin).toBeLessThanOrEqual(45);
      if (t.exitReason === "TIME_STOP") expect(t.holdingMin).toBeGreaterThanOrEqual(t.horizonMin);
    }
    expect(fixed.summary.avgHoldingMin).toBeLessThan(trend.summary.avgHoldingMin);
    const lookup = regimeLookup([{ t: 5, index: "NIFTY", regime: "HIGH_VOL", score: 0.1, threshold: 0.5 }]);
    expect(lookup("NIFTY", 5)).toBe("HIGH_VOL");
    expect(lookup("SENSEX", 5)).toBeNull();
  });

  it("reproduces the planning script's sizing and slots when asked", async () => {
    const r = await randomEntryPlacebo({ ...base, sizing: "uncapped", horizonMin: 90, window: { from: "09:25", to: "14:30" } });
    expect(r.settings.slots).toBe(62);
    for (const t of r.trades) {
      const unit = t.entryPremium * DEFAULT_CONFIG.indexSpecs[t.index].lotSize;
      expect(t.lots).toBe(Math.max(1, Math.min(Math.floor(3750 / (0.3 * unit)), Math.floor(20_000 / unit), 10)));
    }
  });

  it("charges the copy delay on the same draws", async () => {
    const plain = await randomEntryPlacebo(base);
    const ticks = await randomEntryPlacebo({ ...base, extraTicks: 2 });
    expect(sameDraws(ticks.trades)).toEqual(sameDraws(plain.trades));
    ticks.trades.forEach((t, i) => {
      const p = plain.trades[i];
      expect(t.entryPremium).toBeCloseTo(p.entryPremium + 0.1, 6);
      if (t.exitMs === p.exitMs) expect(t.exitPremium).toBeCloseTo(Math.max(0.05, p.exitPremium - 0.1), 6);
    });
    expect(ticks.summary.mean).toBeLessThan(plain.summary.mean);
    expect(ticks.settings.copyDelay).toMatch(/2 extra tick/);
    const delayed = await randomEntryPlacebo({ ...base, fillDelayBars: 1 });
    expect(sameDraws(delayed.trades)).toEqual(sameDraws(plain.trades));
    expect(delayed.trades.filter((t, i) => t.entryPremium !== plain.trades[i].entryPremium).length).toBeGreaterThan(100);
  });

  it("buys a small account's premium band, one lot", async () => {
    const cfg = accountConfig(DEFAULT_CONFIG, "small10k");
    const r = await randomEntryPlacebo({ ...base, cfg, draws: 60 });
    expect(r.trades).toHaveLength(60);
    for (const t of r.trades) {
      const band = premiumBand(cfg, t.index);
      expect(t.lots).toBe(1);
      expect(t.entryPremium).toBeGreaterThanOrEqual(band.minPremium);
      expect(t.entryPremium).toBeLessThanOrEqual(band.maxPremium);
    }
    expect(r.settings.exits).toMatchObject({ stopPct: -35, targetPct: 60 });
  });

  it("refuses impossible inputs", async () => {
    await expect(randomEntryPlacebo({ ...base, draws: 0 })).rejects.toThrow(/draws/);
    await expect(randomEntryPlacebo({ ...base, from: "2026-12-01", to: "2026-12-05" })).rejects.toThrow(/no session/);
  });
});

// --- WP9b: the placebo trades under the variant's rules ---
describe("random-entry placebo under the plan's rules and the published rules", () => {
  const n3 = withOverrides(DEFAULT_CONFIG, { rules: { n3: { enabled: true } } });
  const fc = withOverrides(DEFAULT_CONFIG, { strategy: { mode: "FIRST_CANDLE" }, sizing: { maxOpenPerIndex: 1 } });
  const na = withOverrides(DEFAULT_CONFIG, { strategy: { mode: "NOISE_AREA" }, sizing: { maxOpenPerIndex: 1 } });

  it("draws only the rule's slots: N3's morning, the first candle's close, the noise area's half-hours", () => {
    const morning = entrySlots(n3, YAHOO_LAG_MS);
    expect([morning[0], morning[morning.length - 1], morning.length]).toEqual([9 * 60 + 30, 11 * 60 + 10, 21]);
    expect(entrySlots(fc, YAHOO_LAG_MS)).toEqual([9 * 60 + 30]);
    expect(entrySlots(withOverrides(fc, { rules: { n3: { enabled: true } } }), YAHOO_LAG_MS)).toEqual([9 * 60 + 30]);
    const half = entrySlots(na, YAHOO_LAG_MS);
    expect([half[0], half[half.length - 1], half.length]).toEqual([9 * 60 + 30, 14 * 60, 10]);
    expect(entrySlots(withOverrides(na, { rules: { n3: { enabled: true } } }), YAHOO_LAG_MS)).toEqual([570, 600, 630, 660]);
    expect(entrySlots(DEFAULT_CONFIG, YAHOO_LAG_MS)).toHaveLength(61);
  });

  it("N3: every draw enters in the morning window and is out at the 11:15 bar", async () => {
    const r = await randomEntryPlacebo({ ...base, cfg: n3, draws: 80 });
    for (const t of r.trades) {
      const m = istMinutes(t.entryMs);
      expect(m >= 9 * 60 + 30 && m < 11 * 60 + 15).toBe(true);
      expect(t.exitMs).toBeLessThanOrEqual(istAt(t.day, "11:16") + 30_000);
    }
    expect(r.trades.some((t) => t.exitReason === "SQUARE_OFF")).toBe(true);
    expect(r.settings.horizon).toMatch(/N3/);
  });

  it("first candle: draws only where the rule enters, at 09:31:30, held under the rule's exits", async () => {
    const r = await randomEntryPlacebo({ ...base, cfg: fc, draws: 60 });
    expect(r.rejected["no rule entry"]).toBeGreaterThan(0);
    const market = new ReplayMarketDataSource({ candles: fixtures.candles, daily: fixtures.daily }, { lagMs: YAHOO_LAG_MS });
    for (const t of r.trades) {
      expect(istParts(t.entryMs)).toMatchObject({ hour: 9, minute: 31, second: 30 });
      expect(publishedSignal(t.index, t.entryMs, market.snapshotSync(t.entryMs), calendar, fc).entry).not.toBeNull();
      expect(["STOP", "SQUARE_OFF"]).toContain(t.exitReason);
    }
    // Both sides are drawn, whatever the candle said.
    expect(new Set(r.trades.map((t) => t.side)).size).toBe(2);
    const any = await randomEntryPlacebo({ ...base, cfg: fc, draws: 60, whenRuleFires: false });
    expect(any.rejected["no rule entry"]).toBeUndefined();
  });

  it("N2: redraws what the gate blocks (here 5 Oct, after a 13% VIX jump to the top of its year)", async () => {
    // Synthetic daily closes: VIX 15 for 300 sessions, 17 on 1 Oct; flat indices. N2 blocks 5 Oct only (on the daily rules).
    const days: string[] = [];
    for (let d = "2026-10-07"; days.length < 300; ) {
      d = addDays(d, -1);
      if (weekdayOf(d) <= 5 && d !== "2026-10-02") days.unshift(d);
    }
    const bar = (date: string, c: number) => ({ t: istAt(date, "09:15"), o: c, h: c, l: c, c, v: 0 });
    const daily = {
      ...fixtures.daily,
      [MARKET_SYMBOLS.INDIAVIX]: days.map((d) => bar(d, d === "2026-10-01" ? 17 : 15)),
      [MARKET_SYMBOLS.NIFTY]: days.map((d) => bar(d, 22_500)),
      [MARKET_SYMBOLS.SENSEX]: days.map((d) => bar(d, 72_500)),
    };
    const n2 = withOverrides(DEFAULT_CONFIG, { rules: { n2: { enabled: true } } });
    const r = await randomEntryPlacebo({ ...base, cfg: n2, daily, draws: 60 });
    expect(r.rejected["N2 blocks"]).toBeGreaterThan(0);
    expect(r.trades.filter((t) => t.day === "2026-10-05")).toEqual([]);
    expect(r.trades.length).toBe(60);
    expect(r.settings.horizon).toMatch(/N2/);
  });
});
