import { describe, expect, it } from "vitest";
import { TradingCalendar } from "../calendar/calendar";
import { istAt } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import { GLOBAL_KEYS, type Candle, type MarketSnapshot } from "../types";
import { logRetPct } from "../util/math";
import {
  fixtureCandles5m,
  fixtureDaily,
  normalSampler,
  sessionFromCloses,
  zigzagSession,
} from "../__fixtures__/market/loadFixtures";
import { barsOnDate, sessionBars } from "./candles";
import { globalMoves } from "./crossAsset";
import { computeFeatures, NO_DATA_AGE_SEC } from "./features";
import { ReplayMarketDataSource } from "./replayMarketData";

const cal = new TradingCalendar();
const cfg = DEFAULT_CONFIG;
const fixture = new ReplayMarketDataSource({ candles: fixtureCandles5m(), daily: fixtureDaily() });

/** Every number anywhere in the object must be finite. */
function expectAllFinite(obj: unknown, path = "features"): void {
  if (typeof obj === "number") {
    expect(Number.isFinite(obj), `${path} = ${obj}`).toBe(true);
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => expectAllFinite(v, `${path}[${i}]`));
  } else if (obj !== null && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) expectAllFinite(v, `${path}.${k}`);
  }
}

function emptySnapshot(t: number, dataAgeSec = NO_DATA_AGE_SEC): MarketSnapshot {
  return { t, candles: {}, daily: {}, ltp: {}, dataAgeSec };
}

describe("computeFeatures on recorded data (2026-10-07, RBI policy day)", () => {
  const t = istAt("2026-10-07", "11:00");
  const snap = fixture.snapshotSync(t);
  const f = computeFeatures("NIFTY", snap, cal, cfg);
  const niftyToday = sessionBars(barsOnDate(fixtureCandles5m()["^NSEI"], "2026-10-07"), cal);
  const closedToday = niftyToday.filter((c) => c.t + 300_000 <= t);

  it("produces sane, finite features mid-session", () => {
    expectAllFinite(f);
    expect(f.index).toBe("NIFTY");
    expect(f.t).toBe(t);
    expect(closedToday.length).toBe(21); // 09:15 ... 10:55
    expect(f.spot).toBe(closedToday[20].c);
    expect(f.spot).toBeGreaterThan(22546);
    expect(f.spot).toBeLessThan(22718);
    expect(f.dataAgeSec).toBe(0);
    expect(f.minutesSinceOpen).toBe(105);
    expect(f.minutesToClose).toBe(270);
  });

  it("measures returns from closes k bars back and from the open", () => {
    expect(f.ret5m).toBeCloseTo(logRetPct(closedToday[19].c, f.spot), 12);
    expect(f.ret15m).toBeCloseTo(logRetPct(closedToday[17].c, f.spot), 12);
    expect(f.ret60m).toBeCloseTo(logRetPct(closedToday[8].c, f.spot), 12);
    expect(f.retFromOpen).toBeCloseTo(logRetPct(closedToday[0].o, f.spot), 12);
  });

  it("builds the opening range from 09:15-09:30", () => {
    const or = closedToday.slice(0, 3);
    expect(f.openingRange.high).toBe(Math.max(...or.map((c) => c.h)));
    expect(f.openingRange.low).toBe(Math.min(...or.map((c) => c.l)));
    expect(f.openingRange.state).toBe("BROKE_UP");
  });

  it("explains the gap with overnight global moves", () => {
    // Values cross-checked with an independent Python scan of the raw JSON.
    expect(f.gapPct).toBeCloseTo(-0.3760538112054346, 9);
    expect(f.expectedGapPct).toBeCloseTo(0.294804422192102, 6);
    expect(f.gapResidualPct).toBeCloseTo(f.gapPct - f.expectedGapPct, 12);
    const g = globalMoves(snap, istAt("2026-10-06", "15:30"), t);
    expect(f.global).toEqual(g);
    expect(f.global.NQ).toBeNull();
    expect(Object.keys(f.global).sort()).toEqual([...GLOBAL_KEYS].sort());
  });

  it("reads India VIX and volatility ratios", () => {
    const vix = fixtureCandles5m()["^INDIAVIX"].find((c) => c.t === istAt("2026-10-07", "10:55"));
    expect(f.vix).toBe(vix?.c);
    expect(f.vixChangePct).toBeGreaterThan(0);
    expect(f.realizedVol2h).toBeGreaterThan(3);
    expect(f.realizedVol2h).toBeLessThan(60);
    expect(f.realizedVol20d).toBeGreaterThan(3);
    expect(f.rvIvRatio).toBeCloseTo(f.realizedVol2h / f.vix, 12);
    // Only 3 prior sessions in the fixture: below the 5-session minimum, so neutral.
    expect(f.atrPctile20d).toBe(50);
    expect(f.atrPct5m).toBeGreaterThan(0);
  });

  it("reports calendar context", () => {
    expect(f.isExpiryDay).toBe(false);
    expect(f.tradingDaysToExpiry).toBe(4); // NIFTY expires Tuesday 2026-10-13
    expect(f.nextScheduledEvent?.id).toBe("incpi-2026-10");
    expect(f.recentScheduledEvent).toBeNull();
    const at1015 = computeFeatures("NIFTY", fixture.snapshotSync(istAt("2026-10-07", "10:15")), cal, cfg);
    expect(at1015.recentScheduledEvent).toMatchObject({ id: "rbi-2026-10", impact: "HIGH", minutesAgo: 15 });
    const sensex = computeFeatures("SENSEX", snap, cal, cfg);
    expect(sensex.tradingDaysToExpiry).toBe(1); // SENSEX expires Thursday 2026-10-08
  });

  it("measures divergence symmetrically between NIFTY and SENSEX", () => {
    const sensex = computeFeatures("SENSEX", snap, cal, cfg);
    expectAllFinite(sensex);
    expect(sensex.divergence.vsOtherIndexZ).toBeCloseTo(-f.divergence.vsOtherIndexZ, 12);
    expect(sensex.divergence.selfRet30m).toBeCloseTo(f.divergence.otherIndexRet30m, 12);
    expect(sensex.divergence.vsBankNiftyZ).toBe(0);
    expect(f.divergence.bankNiftyRet15m).toBe(sensex.divergence.bankNiftyRet15m);
  });

  it("reports honest data age with a publication lag", () => {
    const lagged = new ReplayMarketDataSource({ candles: fixtureCandles5m(), daily: fixtureDaily() }, { lagMs: 90_000 });
    const fl = computeFeatures("NIFTY", lagged.snapshotSync(t), cal, cfg);
    expect(fl.dataAgeSec).toBe(300); // 10:50 bar closed at 10:55; the 10:55 bar is not published yet
    expect(fl.spot).toBe(closedToday[19].c);
  });
});

describe("computeFeatures before the first bar closes", () => {
  it("is neutral except the pre-market gap estimate", () => {
    const f = computeFeatures("NIFTY", fixture.snapshotSync(istAt("2026-10-07", "09:16")), cal, cfg);
    expectAllFinite(f);
    expect([f.ret5m, f.ret15m, f.ret60m, f.retFromOpen, f.vwapDistPct, f.barsSameSideOfVwap]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(f.gapPct).toBe(0);
    expect(f.gapResidualPct).toBe(0);
    expect(f.expectedGapPct).toBeCloseTo(0.294804422192102, 6);
    expect(f.openingRange).toEqual({ high: 0, low: 0, state: "FORMING" });
    expect(f.spot).toBeCloseTo(22776.1, 1); // previous close
    expect(f.vixChangePct).toBe(0);
    expect(f.nextScheduledEvent).toMatchObject({ id: "rbi-2026-10", minutesAway: 44 });
    expect(f.dataAgeSec).toBeGreaterThan(17 * 3600);
  });

  it("works pre-market", () => {
    const f = computeFeatures("SENSEX", fixture.snapshotSync(istAt("2026-10-07", "08:30")), cal, cfg);
    expectAllFinite(f);
    expect(f.expectedGapPct).not.toBe(0);
    expect(f.minutesSinceOpen).toBe(0);
    expect(f.minutesToClose).toBe(420);
  });

  it("uses LTP against today's open while the first bar is still forming (live data)", () => {
    const t = istAt("2026-10-07", "09:17");
    const all = fixtureCandles5m();
    const live: MarketSnapshot = {
      t,
      candles: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.filter((c) => c.t <= t)])),
      daily: Object.fromEntries(Object.entries(fixtureDaily()).map(([k, v]) => [k, v.filter((c) => c.t < istAt("2026-10-07", "00:00"))])),
      ltp: { NIFTY: 22650 },
      dataAgeSec: 0,
    };
    const open = all["^NSEI"].find((c) => c.t === istAt("2026-10-07", "09:15"))!.o;
    const f = computeFeatures("NIFTY", live, cal, cfg);
    expectAllFinite(f);
    expect(f.spot).toBe(22650);
    expect(f.retFromOpen).toBeCloseTo(logRetPct(open, 22650), 12);
    expect(f.ret5m).toBe(0);
    expect(f.gapPct).toBeCloseTo((open / 22776.099609375 - 1) * 100, 9);
    expect(f.openingRange.state).toBe("FORMING");
  });
});

describe("computeFeatures on sparse or broken input", () => {
  it("returns neutral values for an empty snapshot", () => {
    const f = computeFeatures("NIFTY", emptySnapshot(istAt("2026-10-07", "11:00")), cal, cfg);
    expectAllFinite(f);
    expect(f.spot).toBe(0);
    expect(f.atrPctile20d).toBe(50);
    expect(f.openingRange.state).toBe("FORMING");
    expect(Object.values(f.global).every((v) => v === null)).toBe(true);
    expect(f.dataAgeSec).toBe(NO_DATA_AGE_SEC);
    expect(f.tradingDaysToExpiry).toBe(4);
  });

  it("uses daily data alone when that is all there is", () => {
    const daily = fixtureDaily();
    const t = istAt("2026-10-07", "11:00");
    const snap: MarketSnapshot = {
      t,
      candles: {},
      daily: Object.fromEntries(Object.entries(daily).map(([k, v]) => [k, v.filter((c) => c.t < istAt("2026-10-07", "00:00"))])),
      ltp: {},
      dataAgeSec: 3600,
    };
    const f = computeFeatures("NIFTY", snap, cal, cfg);
    expectAllFinite(f);
    expect(f.spot).toBeCloseTo(22776.1, 1);
    expect(f.realizedVol20d).toBeGreaterThan(0);
    expect(f.vix).toBeGreaterThan(5);
    expect(f.gapPct).toBe(0);
    expect(f.dataAgeSec).toBe(3600);
  });

  it("never leaks NaN from corrupt candles or timestamps", () => {
    const t = istAt("2026-10-07", "10:00");
    const bad: Candle[] = [
      { t: istAt("2026-10-07", "09:15"), o: NaN, h: NaN, l: NaN, c: NaN, v: NaN },
      { t: istAt("2026-10-07", "09:20"), o: 0, h: 0, l: 0, c: 0, v: 0 },
      { t: istAt("2026-10-07", "09:25"), o: 100, h: 101, l: 99, c: 100, v: Infinity },
    ];
    const f = computeFeatures("NIFTY", { t, candles: { "^NSEI": bad }, daily: {}, ltp: { NIFTY: NaN }, dataAgeSec: NaN }, cal, cfg);
    expectAllFinite(f);
    expect(f.dataAgeSec).toBe(NO_DATA_AGE_SEC);
    const g = computeFeatures("NIFTY", { t: NaN, candles: {}, daily: {}, ltp: {}, dataAgeSec: 0 }, cal, cfg);
    expectAllFinite(g);
    expect(g.dataAgeSec).toBe(NO_DATA_AGE_SEC);
  });
});

// ---------------------------------------------------------------------------
// Synthetic scenarios
// ---------------------------------------------------------------------------

/** The `n` trading days before `date` (ascending). */
function priorTradingDays(date: string, n: number): string[] {
  const out: string[] = [];
  let d = date;
  while (out.length < n) {
    d = cal.prevTradingDay(d);
    out.unshift(d);
  }
  return out;
}

const TODAY = "2026-10-07";

function replay(candles: Record<string, Candle[]>): ReplayMarketDataSource {
  return new ReplayMarketDataSource({ candles });
}

describe("opening range, efficiency and short returns (synthetic)", () => {
  const prev = zigzagSession("2026-10-06", 100, 0.1);
  const today = sessionFromCloses(TODAY, [100.5, 101, 100.8, 102, 103, 103.5], 100, 0.05);
  const src = replay({ "^NSEI": [...prev, ...today] });

  it("is FORMING until 09:30 and then reports the breakout", () => {
    const at0925 = computeFeatures("NIFTY", src.snapshotSync(istAt(TODAY, "09:25")), cal, cfg);
    expect(at0925.openingRange.state).toBe("FORMING");
    expect(at0925.openingRange.high).toBeCloseTo(101.05, 12);
    const at0935 = computeFeatures("NIFTY", src.snapshotSync(istAt(TODAY, "09:35")), cal, cfg);
    expect(at0935.openingRange).toEqual({ high: 101.05, low: 99.95, state: "BROKE_UP" });
    const at0930 = computeFeatures("NIFTY", src.snapshotSync(istAt(TODAY, "09:30")), cal, cfg);
    expect(at0930.openingRange.state).toBe("INSIDE");
  });

  it("reports BROKE_DOWN below the range", () => {
    const down = sessionFromCloses(TODAY, [99.5, 99.8, 99.6, 98.9], 100, 0.05);
    const f = computeFeatures("NIFTY", replay({ "^NSEI": [...prev, ...down] }).snapshotSync(istAt(TODAY, "09:35")), cal, cfg);
    expect(f.openingRange.state).toBe("BROKE_DOWN");
  });

  it("measures short returns from the first open when the session is young", () => {
    const f = computeFeatures("NIFTY", src.snapshotSync(istAt(TODAY, "09:30")), cal, cfg);
    // Closed bars: 100.5, 101, 100.8; spot = 100.8.
    expect(f.ret5m).toBeCloseTo(logRetPct(101, 100.8), 12);
    expect(f.ret15m).toBeCloseTo(logRetPct(100, 100.8), 12); // fewer than 4 bars: from the open
    expect(f.ret60m).toBeCloseTo(logRetPct(100, 100.8), 12);
    expect(f.efficiencyRatio60m).toBeCloseTo(0.3 / 0.7, 12);
    const at0925 = computeFeatures("NIFTY", src.snapshotSync(istAt(TODAY, "09:25")), cal, cfg);
    expect(at0925.efficiencyRatio60m).toBe(0); // needs 3 bars
  });
});

describe("ATR percentile (synthetic)", () => {
  const days = priorTradingDays(TODAY, 25);
  const history = days.flatMap((d) => zigzagSession(d, 1000, 1, 75));
  const at = istAt(TODAY, "10:15");

  it("ranks today's true range against the same window of prior sessions", () => {
    const wild = zigzagSession(TODAY, 1000, 5, 12);
    const calm = zigzagSession(TODAY, 1000, 0.2, 12);
    const same = zigzagSession(TODAY, 1000, 1, 12);
    expect(computeFeatures("NIFTY", replay({ "^NSEI": [...history, ...wild] }).snapshotSync(at), cal, cfg).atrPctile20d).toBe(100);
    expect(computeFeatures("NIFTY", replay({ "^NSEI": [...history, ...calm] }).snapshotSync(at), cal, cfg).atrPctile20d).toBe(0);
    expect(computeFeatures("NIFTY", replay({ "^NSEI": [...history, ...same] }).snapshotSync(at), cal, cfg).atrPctile20d).toBe(50);
  });

  it("needs five prior sessions", () => {
    const short = days.slice(-4).flatMap((d) => zigzagSession(d, 1000, 1, 75));
    const wild = zigzagSession(TODAY, 1000, 5, 12);
    expect(computeFeatures("NIFTY", replay({ "^NSEI": [...short, ...wild] }).snapshotSync(at), cal, cfg).atrPctile20d).toBe(50);
  });
});

describe("realized volatility (synthetic)", () => {
  it("does not count the overnight gap as a 5-minute return", () => {
    const prev = zigzagSession("2026-10-06", 100, 0.01, 75);
    const today = sessionFromCloses(TODAY, [103.01, 102.99, 103.01], 103, 0); // opens 3% higher
    const f = computeFeatures("NIFTY", replay({ "^NSEI": [...prev, ...today] }).snapshotSync(istAt(TODAY, "09:30")), cal, cfg);
    // Per-bar moves are ~0.01-0.02%: annualized ~2-3%. Including the 3% gap would give > 100%.
    expect(f.realizedVol2h).toBeGreaterThan(0.5);
    expect(f.realizedVol2h).toBeLessThan(5);
    expect(f.gapPct).toBeCloseTo(3 / 100.01 * 100, 1);
  });

  it("annualizes with 75 bars x 252 days", () => {
    const z = normalSampler(5);
    const closes: number[] = [];
    let p = 20000;
    for (let i = 0; i < 24; i++) closes.push((p *= Math.exp(0.001 * z())));
    const today = sessionFromCloses(TODAY, closes, 20000);
    const f = computeFeatures("NIFTY", replay({ "^NSEI": today }).snapshotSync(istAt(TODAY, "11:15")), cal, cfg);
    const rets = today.map((c) => logRetPct(c.o, c.c));
    const m = rets.reduce((s, r) => s + r, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - m) ** 2, 0) / (rets.length - 1));
    expect(f.realizedVol2h).toBeCloseTo(sd * Math.sqrt(75 * 252), 9);
  });
});

describe("divergence z-scores (synthetic)", () => {
  const days = priorTradingDays(TODAY, 20);
  const z = normalSampler(9);
  function noisySession(date: string, level: number): Candle[] {
    let p = level;
    const closes = Array.from({ length: 75 }, () => (p *= Math.exp(0.0005 * z())));
    return sessionFromCloses(date, closes, level, 0.01);
  }
  const niftyHist = days.flatMap((d) => noisySession(d, 22000));
  const sensexHist = days.flatMap((d) => noisySession(d, 72000));
  const bankHist = days.flatMap((d) => noisySession(d, 51000));
  const flat = (level: number) => sessionFromCloses(TODAY, Array(24).fill(level), level);
  const rally = (level: number, lastN: number, pct: number) =>
    sessionFromCloses(
      TODAY,
      Array.from({ length: 24 }, (_, i) => (i >= 24 - lastN ? level * (1 + (pct / 100) * ((i - (24 - lastN) + 1) / lastN)) : level)),
      level,
    );
  const t = istAt(TODAY, "11:15");

  it("flags NIFTY outrunning SENSEX over 30 minutes", () => {
    const src = replay({ "^NSEI": [...niftyHist, ...rally(22000, 6, 1)], "^BSESN": [...sensexHist, ...flat(72000)], "^NSEBANK": [...bankHist, ...flat(51000)] });
    const n = computeFeatures("NIFTY", src.snapshotSync(t), cal, cfg);
    const s = computeFeatures("SENSEX", src.snapshotSync(t), cal, cfg);
    expect(n.divergence.selfRet30m).toBeCloseTo(Math.log(1.01) * 100, 9);
    expect(n.divergence.otherIndexRet30m).toBeCloseTo(0, 12);
    expect(n.divergence.vsOtherIndexZ).toBeGreaterThan(3);
    expect(s.divergence.vsOtherIndexZ).toBeLessThan(-3);
  });

  it("flags BANKNIFTY leading NIFTY over 15 minutes (NIFTY only)", () => {
    const src = replay({ "^NSEI": [...niftyHist, ...flat(22000)], "^BSESN": [...sensexHist, ...flat(72000)], "^NSEBANK": [...bankHist, ...rally(51000, 3, 1)] });
    const n = computeFeatures("NIFTY", src.snapshotSync(t), cal, cfg);
    const s = computeFeatures("SENSEX", src.snapshotSync(t), cal, cfg);
    expect(n.divergence.bankNiftyRet15m).toBeCloseTo(Math.log(1.01) * 100, 9);
    expect(n.divergence.vsBankNiftyZ).toBeGreaterThan(3);
    expect(s.divergence.vsBankNiftyZ).toBe(0);
    expect(s.divergence.bankNiftyRet15m).toBeCloseTo(Math.log(1.01) * 100, 9);
  });

  it("aligns windows when one series is a bar behind", () => {
    const nifty = [...niftyHist, ...rally(22000, 6, 1)];
    const sensexLate = [...sensexHist, ...flat(72000).slice(0, 23)]; // last SENSEX bar missing
    const f = computeFeatures("NIFTY", replay({ "^NSEI": nifty, "^BSESN": sensexLate }).snapshotSync(t), cal, cfg);
    // Window ends at the last bar both have (11:10): NIFTY's return excludes its final bar.
    expect(f.divergence.selfRet30m).toBeCloseTo(logRetPct(22000, 22000 * (1 + 0.01 * (5 / 6))), 9);
  });
});
