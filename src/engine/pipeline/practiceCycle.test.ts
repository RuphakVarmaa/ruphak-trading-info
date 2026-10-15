import { describe, expect, it } from "vitest";
import { PaperBroker } from "../broker/paperBroker";
import { istAt, MINUTE_MS } from "../clock";
import { DEFAULT_CONFIG, makeConfig, type EngineConfig } from "../config";
import type { EngineDeps } from "../ports";
import type { SetupsRecord } from "../strategy/setups";
import { loadMarketFixtures } from "../testing/fixtures";
import { createReplayDeps } from "../testing/replayHarness";
import type { Conviction, IndexId } from "../types";
import { runPositionCycle } from "./positionCycle";
import { practiceCandidates, practiceConfig, practiceKey, practiceQuotaOn, practiceWindow, PRACTICE_WINDOWS } from "./practiceCycle";
import { runTradingCycle } from "./tradingCycle";

const DAY = "2026-10-07";
const fixtures = loadMarketFixtures();

function conviction(index: IndexId, score: number): Conviction {
  return { index, t: istAt(DAY, "10:00"), score, components: [], regime: "RANGE", threshold: 0.55, passes: Math.abs(score) >= 0.55, sizeMult: 1, stance: score > 0 ? "BULLISH" : "BEARISH" };
}

const setups = (index: IndexId, rows: { status: string; score: number; side: "BULL" | "BEAR"; name: string }[]) =>
  ({ index, setups: rows }) as unknown as SetupsRecord;

/** Replay deps on a PAPER book, as the production loop runs (the harness books BACKTEST by default). */
function paperDeps(cfg: EngineConfig): EngineDeps & { clock: { set(t: number): void } } {
  const d = createReplayDeps({ cfg, startMs: istAt(DAY, "09:15"), candles: fixtures.candles, daily: fixtures.daily });
  const broker = new PaperBroker({ cfg, clock: d.clock, repo: d.repo, quotes: d.optionQuotes, marketContext: (i) => d.marketContext.get(i), newId: d.newId, mode: "PAPER", latencyMs: 0 });
  return { ...d, broker, mode: "PAPER" };
}

async function replay(cfg: EngineConfig, practice: boolean, before?: (deps: EngineDeps) => Promise<void>) {
  const deps = paperDeps(cfg);
  if (before) await before(deps);
  for (let t = istAt(DAY, "09:15"); t <= istAt(DAY, "15:30"); t += 5 * MINUTE_MS) {
    deps.clock.set(t);
    const r = await runTradingCycle(deps, { practice });
    await runPositionCycle(deps, { convictions: r.convictions as Partial<Record<IndexId, Conviction>> });
  }
  const closed = await deps.repo.positions.closedBetween(istAt(DAY, "09:00"), istAt(DAY, "16:00"), "PAPER");
  const plans = (await Promise.all(closed.map((p) => deps.repo.plans.get(p.planId)))).filter((p) => p !== null);
  return { deps, plans, practice: plans.filter((p) => p.gates.some((g) => g.gate === "practice")) };
}

describe("practice quota switch and windows", () => {
  it("is on for 'main', for 'main:<today>' only on that IST date, and off otherwise", () => {
    const t = istAt("2026-10-15", "10:00");
    expect(practiceQuotaOn("main", t)).toBe(true);
    expect(practiceQuotaOn("main:2026-10-15", t)).toBe(true);
    expect(practiceQuotaOn("main:2026-10-15", istAt("2026-10-16", "10:00"))).toBe(false);
    expect(practiceQuotaOn("off", t)).toBe(false);
    expect(practiceQuotaOn(undefined, t)).toBe(false);
    expect(practiceQuotaOn("small10k", t)).toBe(false);
  });

  it("has five hour windows from 09:30 to 14:30 and keys one entry per window and day", () => {
    expect(PRACTICE_WINDOWS).toHaveLength(5);
    expect(practiceWindow(istAt(DAY, "09:29"))).toBeNull();
    expect(practiceWindow(istAt(DAY, "09:30"))).toEqual([570, 630]);
    expect(practiceWindow(istAt(DAY, "12:59"))).toEqual([750, 810]);
    expect(practiceWindow(istAt(DAY, "14:30"))).toBeNull();
    expect(practiceKey(istAt(DAY, "11:10"), practiceWindow(istAt(DAY, "11:10"))!)).toBe(`practice:${DAY}:10:30`);
  });

  it("ranks setups by status then score, else the conviction's side", () => {
    const c = { NIFTY: conviction("NIFTY", 0.3), SENSEX: conviction("SENSEX", -0.45) };
    expect(practiceCandidates(["NIFTY", "SENSEX"], c, {}).map((x) => [x.index, x.side])).toEqual([
      ["SENSEX", -1],
      ["NIFTY", 1],
    ]);
    const s = {
      NIFTY: setups("NIFTY", [
        { name: "ORB", status: "WATCHING", score: 90, side: "BULL" },
        { name: "VWAP", status: "READY", score: 60, side: "BEAR" },
        { name: "Old", status: "EXPIRED", score: 99, side: "BULL" },
      ]),
      SENSEX: setups("SENSEX", [{ name: "Break", status: "TRIGGERED", score: 40, side: "BULL" }]),
    };
    const ranked = practiceCandidates(["NIFTY", "SENSEX"], c, s);
    expect(ranked.map((x) => [x.index, x.side])).toEqual([
      ["SENSEX", 1],
      ["NIFTY", -1],
    ]);
    expect(ranked[1].why).toBe("VWAP (READY, score 60)");
  });

  it("relaxes only the edge checks and the losing streak", () => {
    const p = practiceConfig(DEFAULT_CONFIG);
    expect(p.gates).toMatchObject({ expectedMoveModel: "legacy", minExpectedVsImplied: 0, volCheapness: { enabled: false } });
    expect(p.gates.minEdgeRatio).toBeLessThan(-1e6);
    expect(p.gates.stopOutCooldownMin).toBe(DEFAULT_CONFIG.gates.stopOutCooldownMin);
    expect(p.sizing).toBe(DEFAULT_CONFIG.sizing);
    expect(p.risk).toEqual({ ...DEFAULT_CONFIG.risk, maxConsecutiveLossesPerDay: PRACTICE_WINDOWS.length });
    expect(p.exits).toBe(DEFAULT_CONFIG.exits);
    expect(p.gates.noEntryBeforeIst).toBe(DEFAULT_CONFIG.gates.noEntryBeforeIst);
  });
});

describe("practice quota on a replay of 7 Oct 2026 (paper book)", () => {
  // The fixtures' option quotes are synthetic and their bars sparse, so data age and OI are relaxed
  // here as in the other replay tests; the engine's own edge checks stay at their defaults.
  const cfg = makeConfig({ gates: { maxDataAgeSec: 100_000, minOi: 0 } });

  it("takes one practice trade per hour window, labelled and kept out of the signal weights", async () => {
    const { deps, plans, practice } = await replay(cfg, true);
    const base = await replay(cfg, false);
    expect(base.practice).toEqual([]);
    // Practice trades share the open-position, daily-entry and loss caps with the engine's own entries.
    expect(plans.length - practice.length).toBeLessThanOrEqual(base.plans.length);
    expect(practice.length).toBeGreaterThanOrEqual(1);
    expect(practice.length).toBeLessThanOrEqual(PRACTICE_WINDOWS.length);
    const windows = practice.map((p) => practiceKey(p.t, practiceWindow(p.t)!));
    expect(new Set(windows).size).toBe(practice.length);
    for (const p of practice) {
      expect(p.dominantSource).toBe("VOL_REGIME");
      expect(p.gates.find((g) => g.gate === "practice")?.detail).toMatch(/^window \d\d:\d\d–\d\d:\d\d IST: /);
      expect(await deps.repo.state.get(practiceKey(p.t, practiceWindow(p.t)!))).toMatchObject({ planId: p.id });
    }
    // Stops and the square-off still close everything.
    expect(await deps.repo.positions.open("PAPER")).toEqual([]);
    expect(plans.length).toBeLessThanOrEqual(cfg.sizing.maxTradesPerDay);
  });

  it("fills all five windows under the main account's limits with the engine's own entries paused", async () => {
    const main = makeConfig({ gates: { maxDataAgeSec: 100_000, minOi: 0, expectedMoveModel: "calibrated" }, sizing: { maxOpenPerIndex: 2, maxTradesPerDay: 8 } });
    const { practice } = await replay(main, true);
    expect(practice.length).toBe(PRACTICE_WINDOWS.length);
  });

  it("takes nothing while the kill switch is on", async () => {
    const { practice } = await replay(cfg, true, async (deps) => {
      await deps.repo.settings.update({ killSwitch: true }, "test");
    });
    expect(practice).toEqual([]);
  });
});
