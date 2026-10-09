/** The published strategies through the production trading and position cycles (fixture week, 1-7 Oct 2026). */
import { describe, expect, it } from "vitest";
import { accountConfig } from "../../accounts";
import { runBacktestAccounts } from "../../backtest/runBacktest";
import { istAt, istDate, istParts } from "../../clock";
import { DEFAULT_CONFIG, makeConfig, type DeepPartial, type EngineConfig } from "../../config";
import { runTradingCycle } from "../../pipeline/tradingCycle";
import { loadMarketFixtures } from "../../testing/fixtures";
import { createReplayDeps } from "../../testing/replayHarness";
import type { TradeRecord } from "../../types";

const fixtures = loadMarketFixtures();
const mmss = (ms: number) => {
  const p = istParts(ms);
  return `${String(p.minute % 30).padStart(2, "0")}:${String(p.second).padStart(2, "0")}`;
};

async function replay(patch: DeepPartial<EngineConfig>) {
  const cfg = makeConfig(patch);
  const followers = (["small10k", "small5k"] as const).map((account) => ({ account, cfg: accountConfig(cfg, account) }));
  const r = await runBacktestAccounts({ cfg, from: "2026-10-01", to: "2026-10-07", candles: fixtures.candles, daily: fixtures.daily, noEvents: true, followers });
  return { cfg, main: r.main.trades, books: [r.main.trades, r.followers.small10k!.trades, r.followers.small5k!.trades] };
}

/** Never two positions on one index at once, and every book flat after the square-off. */
function expectOnePerIndex(trades: TradeRecord[]) {
  for (const idx of ["NIFTY", "SENSEX"]) {
    const ts = trades.filter((t) => t.index === idx).sort((a, b) => a.entryMs - b.entryMs);
    for (let i = 1; i < ts.length; i++) expect(ts[i].entryMs).toBeGreaterThanOrEqual(ts[i - 1].exitMs);
  }
  for (const t of trades) expect(t.exitMs).toBeLessThanOrEqual(istAt(istDate(t.entryMs), "15:10"));
}

describe("noise area through the engine", () => {
  for (const stop of ["OPPOSITE_BAND", "BAND_VWAP"] as const) {
    it(`${stop}: enters on HH:00/HH:30 bars (or the next bar), exits on the index rule, stops or square-off`, async () => {
      const { books, main } = await replay({ strategy: { mode: "NOISE_AREA", noiseArea: { lookbackSessions: 2, stop } }, sizing: { maxOpenPerIndex: 1 } });
      expect(main.length).toBeGreaterThan(0);
      for (const trades of books) {
        expectOnePerIndex(trades);
        for (const t of trades) {
          // Decided at the bar ending HH:00/HH:30 (seen 90 s later), or carried to the next bar.
          expect(["01:30", "06:30"]).toContain(mmss(t.entryMs));
          expect(["SIGNAL_FLIP", "TRAIL", "STOP", "SQUARE_OFF", "DAILY_LOSS_CAP"]).toContain(t.exitReason);
          if (t.exitReason === "SIGNAL_FLIP" || t.exitReason === "TRAIL") expect(mmss(t.exitMs)).toBe("01:30");
          if (stop === "OPPOSITE_BAND") expect(t.exitReason).not.toBe("TRAIL");
          else expect(t.exitReason).not.toBe("SIGNAL_FLIP");
        }
      }
      // Followers buy one lot.
      for (const t of [...books[1], ...books[2]]) expect(t.qty).toBe(DEFAULT_CONFIG.indexSpecs[t.index].lotSize);
    }, 120_000);
  }
});

describe("5-minute ORB through the engine", () => {
  it("engine window: one entry per index a day at 09:26:30, exits at the index stop/target or square-off", async () => {
    const { books, main } = await replay({ strategy: { mode: "ORB5" }, sizing: { maxOpenPerIndex: 1 } });
    expect(main.length).toBeGreaterThan(0);
    for (const trades of books) {
      expectOnePerIndex(trades);
      const perDay = new Set<string>();
      for (const t of trades) {
        expect(istParts(t.entryMs)).toMatchObject({ hour: 9, minute: 26, second: 30 });
        expect(["STOP", "TARGET", "SQUARE_OFF", "DAILY_LOSS_CAP"]).toContain(t.exitReason);
        const key = `${istDate(t.entryMs)}:${t.index}`;
        expect(perDay.has(key)).toBe(false);
        perDay.add(key);
      }
    }
  }, 120_000);

  it("as published: enters at 09:21:30 when the run opens the entry window at 09:20", async () => {
    const { main } = await replay({ strategy: { mode: "ORB5", orb5: { entry: "PUBLISHED" } }, sizing: { maxOpenPerIndex: 1 }, gates: { noEntryBeforeIst: "09:20" } });
    expect(main.length).toBeGreaterThan(0);
    for (const t of main) expect(istParts(t.entryMs)).toMatchObject({ hour: 9, minute: 21, second: 30 });
  }, 120_000);
});

describe("published modes leave the default engine alone", () => {
  it("CONVICTION convictions carry no published signal", async () => {
    const t = istAt("2026-10-07", "10:01") + 30_000;
    const deps = createReplayDeps({ cfg: DEFAULT_CONFIG, startMs: t, candles: fixtures.candles, daily: fixtures.daily, lagMs: 90_000 });
    const r = await runTradingCycle(deps, { noEvents: true });
    expect(Object.keys(r.convictions).length).toBe(2);
    for (const c of Object.values(r.convictions)) expect(c?.published).toBeUndefined();
  });

  it("takes no entries on a LIVE book", async () => {
    const cfg = makeConfig({ strategy: { mode: "NOISE_AREA", noiseArea: { lookbackSessions: 2 } }, sizing: { maxOpenPerIndex: 1 } });
    const t = istAt("2026-10-06", "10:01") + 30_000;
    const deps = createReplayDeps({ cfg, startMs: t, candles: fixtures.candles, daily: fixtures.daily, lagMs: 90_000 });
    const r = await runTradingCycle({ ...deps, mode: "LIVE" }, { noEvents: true });
    expect(r.entries).toEqual([]);
    expect(r.halted).toContain("paper books only");
    // The same tick on a paper book does enter (the 10:00 breakout above).
    const paper = await runTradingCycle(createReplayDeps({ cfg, startMs: t, candles: fixtures.candles, daily: fixtures.daily, lagMs: 90_000 }), { noEvents: true });
    expect(paper.entries.length).toBeGreaterThan(0);
  });
});
