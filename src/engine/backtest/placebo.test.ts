import { describe, expect, it } from "vitest";
import { accountConfig } from "../accounts";
import { TradingCalendar } from "../calendar/calendar";
import { istAt, istMinutes, MINUTE_MS } from "../clock";
import { DEFAULT_CONFIG, premiumBand } from "../config";
import { YAHOO_LAG_MS } from "../market/replayMarketData";
import { loadMarketFixtures } from "../testing/fixtures";
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
