import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TradingCalendar } from "../calendar/calendar";
import { istAt } from "../clock";
import { DEFAULT_CONFIG, makeConfig } from "../config";
import { GLOBAL_KEYS, type Candle, type MarketSnapshot } from "../types";
import { logRetPct } from "../util/math";
import {
  fixtureCandles5m,
  fixtureDaily,
  normalSampler,
  readMarketFixture,
  sessionFromCloses,
  zigzagSession,
} from "../__fixtures__/market/loadFixtures";
import { barsOnDate, sessionBars } from "./candles";
import { globalMoves } from "./crossAsset";
import {
  barBodyPct,
  bodyClip,
  clipWicks,
  computeFeatures,
  NEUTRAL_OPENING_RANGE,
  NO_DATA_AGE_SEC,
  setBodyClipListener,
  type BodyClip,
} from "./features";
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
    // The 10:55 bar is the first close above the range after an earlier downside break.
    expect(f.openingRange.lastBreak).toBe("UP");
    expect(f.openingRange.barsOutside).toBe(1);
    expect(f.openingRange.barsSinceReentry).toBe(0);
    expect(f.openingRange.strengthAtr).toBeGreaterThan(0.3);
    expect(f.openingRange.strengthAtr).toBeLessThan(0.6);
  });

  it("computes the classic indicators across sessions", () => {
    const ind = f.indicators;
    expect(ind.rsi14).toBeGreaterThan(50);
    expect(ind.rsi14).toBeLessThan(70);
    expect(ind.adx14).toBeGreaterThan(10);
    expect(ind.adx14).toBeLessThan(25);
    expect(ind.supertrendDir).toBe(1);
    expect(ind.ema9).toBeGreaterThan(ind.ema21);
    expect(ind.ema21).toBeGreaterThan(22500);
    expect(ind.vwap).toBeGreaterThan(0);
    expect(ind.vwap).toBeLessThan(f.spot);
    expect(ind.vwapZ).toBeGreaterThan(2); // stretched above VWAP after the RBI rally
    expect(ind.bbPctB).toBeGreaterThan(0.9);
    expect(ind.dailyBias).toBe(-1); // the daily EMA20 is below the EMA50 on the 3-month fixture
    expect(ind.prevDayClose).toBeCloseTo(22776.1, 0);
    expect(ind.prevDayHigh).toBeGreaterThan(ind.prevDayLow);
    expect(ind.prevDayLow).toBeGreaterThan(0);
  });

  it("tracks a failed break back into the range", () => {
    const later = computeFeatures("NIFTY", fixture.snapshotSync(istAt("2026-10-07", "11:20")), cal, cfg);
    expect(later.openingRange).toMatchObject({ state: "INSIDE", lastBreak: "UP", barsOutside: 0, barsSinceReentry: 1, strengthAtr: 0 });
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
    expect(f.openingRange).toEqual(NEUTRAL_OPENING_RANGE);
    expect(f.indicators.vwapZ).toBe(0); // no session bars yet
    expect(f.indicators.adx14).toBeGreaterThan(0); // carried over from the previous session's bars
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
    expect(at0935.openingRange).toMatchObject({ high: 101.05, low: 99.95, state: "BROKE_UP", lastBreak: "UP", barsOutside: 1, barsSinceReentry: 0 });
    expect(at0935.openingRange.strengthAtr).toBeGreaterThan(0);
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

describe("bad prints", () => {
  it("clips wicks more than 0.3% beyond the bar body (Yahoo SENSEX, 7 Oct 2026 15:20)", () => {
    const spike = { t: 0, o: 72570, h: 73477.3, l: 72570, c: 72767.8, v: 0 };
    const clean = clipWicks(spike);
    expect(clean.h).toBeCloseTo(72767.8 * 1.003, 6);
    expect(clean.l).toBe(72570);
    expect(clean.o).toBe(72570);
    expect(clean.c).toBe(72767.8);
    const normal = { t: 0, o: 22690.4, h: 22690.4, l: 22602.1, c: 22622.8, v: 0 };
    expect(clipWicks(normal)).toBe(normal);
    const down = clipWicks({ t: 0, o: 100, h: 100.1, l: 98, c: 99.9, v: 0 });
    expect(down.l).toBeCloseTo(99.9 * 0.997, 9);
  });
});

describe("per-index data age", () => {
  it("does not let a frozen SENSEX borrow NIFTY's freshness", () => {
    // 9 Oct 2026: Yahoo kept serving SENSEX's previous close into the session while NIFTY updated.
    const t = istAt("2026-10-07", "11:00");
    const all = fixtureCandles5m();
    const frozen = { ...all, "^BSESN": all["^BSESN"].filter((c) => c.t < istAt("2026-10-07", "00:00")) };
    const snap = new ReplayMarketDataSource({ candles: frozen, daily: fixtureDaily() }).snapshotSync(t);
    const nifty = computeFeatures("NIFTY", snap, cal, cfg);
    const sensex = computeFeatures("SENSEX", snap, cal, cfg);
    expect(nifty.dataAgeSec).toBeLessThanOrEqual(300);
    expect(sensex.dataAgeSec).toBeGreaterThan(17 * 3600);
    expect(sensex.dataAgeSec).toBeGreaterThan(cfg.gates.maxDataAgeSec);
    // The snapshot-wide age still reports the freshest index.
    expect(snap.dataAgeSec).toBe(nifty.dataAgeSec);
  });

  it("matches the snapshot-wide age when both indices are fresh", () => {
    const snap = fixture.snapshotSync(istAt("2026-10-07", "11:00"));
    expect(computeFeatures("NIFTY", snap, cal, cfg).dataAgeSec).toBe(snap.dataAgeSec);
    expect(computeFeatures("SENSEX", snap, cal, cfg).dataAgeSec).toBe(snap.dataAgeSec);
  });

  it("falls back to the snapshot-wide age when per-index ages are absent, and never reports fresher than it", () => {
    const daily = fixtureDaily();
    const snap: MarketSnapshot = {
      t: istAt("2026-10-07", "11:00"),
      candles: {},
      daily: Object.fromEntries(Object.entries(daily).map(([k, v]) => [k, v.filter((c) => c.t < istAt("2026-10-07", "00:00"))])),
      ltp: {},
      dataAgeSec: 120,
    };
    expect(computeFeatures("SENSEX", snap, cal, cfg).dataAgeSec).toBe(120);
    expect(computeFeatures("SENSEX", { ...snap, dataAgeSecByIndex: { SENSEX: 30 } }, cal, cfg).dataAgeSec).toBe(120);
    expect(computeFeatures("SENSEX", { ...snap, dataAgeSecByIndex: { SENSEX: 4000 } }, cal, cfg).dataAgeSec).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// Closing-auction cleaning (WP1) on real bars
// ---------------------------------------------------------------------------

/** Every bar kept: the engine's config before the closing-auction cutoff became the default. */
const rawCfg = makeConfig({ features: { indicatorCutoffIst: null } });

/**
 * Real Yahoo 5m bars of NIFTY, SENSEX, BANKNIFTY and India VIX for 9-11 Sep 2026, copied unchanged from
 * the backtest history snapshot. Since 3 Aug 2026 the last 15 minutes are a closing auction; on 10 Sep
 * NIFTY's 15:15 and 15:20 bars are flat and its 15:25 bar jumps to the official close (+0.38%), while
 * SENSEX's 15:20 bar prints +1.27% (high 75,803.8) and its 15:25 bar falls back -0.89%. Yahoo's daily
 * SENSEX bar for the day: high 74,910.96, low 74,598.47, close 74,902.59.
 */
function auctionFixture(): Record<string, Candle[]> {
  const doc = readMarketFixture("snapshot-5m-2026-09-09_11.json") as { candles: Record<string, number[][]> };
  const out: Record<string, Candle[]> = {};
  for (const [sym, rows] of Object.entries(doc.candles)) out[sym] = rows.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  return out;
}

describe("closing-auction cleaning on real bars (Yahoo 5m, 10 Sep 2026)", () => {
  const bars = auctionFixture();
  const src = new ReplayMarketDataSource({ candles: bars });
  const bar = (symbol: string, date: string, time: string): Candle => {
    const found = bars[symbol].find((c) => c.t === istAt(date, time));
    if (!found) throw new Error(`no ${symbol} bar at ${date} ${time}`);
    return found;
  };
  const sensex1520 = bar("^BSESN", "2026-09-10", "15:20");
  const nifty1520 = bar("^NSEI", "2026-09-10", "15:20");
  const cutoffCfg = makeConfig({ features: { indicatorCutoffIst: "15:15" } });
  const clipCfg = makeConfig({ features: { indicatorCutoffIst: null, bodyClip: true } });
  const nextMorning = istAt("2026-09-11", "09:30"); // three bars of 11 Sep closed
  let clips: BodyClip[] = [];

  beforeEach(() => {
    clips = [];
    setBodyClipListener((c) => clips.push(c));
  });
  afterEach(() => setBodyClipListener(null));

  it("the SENSEX 15:20 print gets past clipWicks: the close is wrong, the wick is inside 0.3%", () => {
    expect(sensex1520).toMatchObject({ o: 74630.5, h: 75803.7578125, l: 74482.4765625, c: 75577.7421875 });
    expect(clipWicks(sensex1520)).toBe(sensex1520);
    expect(barBodyPct(sensex1520)).toBeCloseTo(1.2692, 4);
    expect(nifty1520).toMatchObject({ o: 23389.25, h: 23389.25, l: 23389.25, c: 23389.25 });
  });

  it("the body clip flattens it to its open because NIFTY did not move", () => {
    const v = bodyClip(sensex1520, nifty1520);
    expect(v).not.toBeNull();
    expect(v!.clipped).toEqual({ ...sensex1520, h: 74630.5, l: 74630.5, c: 74630.5 });
    expect(v!.bodyPct).toBeCloseTo(1.2692, 4);
    expect(v!.otherBodyPct).toBe(0);
  });

  it("the body clip keeps confirmed or uncheckable bars, and flags nothing else in the three sessions", () => {
    // SENSEX 15:25 falls 0.89% while NIFTY's 15:25 bar carries the +0.38% auction close: confirmed, kept.
    expect(bodyClip(bar("^BSESN", "2026-09-10", "15:25"), bar("^NSEI", "2026-09-10", "15:25"))).toBeNull();
    // NIFTY's +0.38% is below the 0.6% threshold.
    expect(bodyClip(bar("^NSEI", "2026-09-10", "15:25"), bar("^BSESN", "2026-09-10", "15:25"))).toBeNull();
    // Nothing to compare with: kept.
    expect(bodyClip(sensex1520, undefined)).toBeNull();
    expect(bodyClip(sensex1520, { ...nifty1520, t: nifty1520.t + 300_000 })).toBeNull();
    const flagged: string[] = [];
    for (const [sym, other] of [["^NSEI", "^BSESN"], ["^BSESN", "^NSEI"]]) {
      for (const c of bars[sym]) {
        if (bodyClip(c, bars[other].find((o) => o.t === c.t))) flagged.push(`${sym}@${c.t}`);
      }
    }
    expect(flagged).toEqual([`^BSESN@${sensex1520.t}`]);
  });

  it("by default the auction prints become the next morning's previous-day high and low", () => {
    const f = computeFeatures("SENSEX", src.snapshotSync(nextMorning), cal, rawCfg);
    expect(f.indicators.prevDayHigh).toBe(75803.7578125);
    expect(f.indicators.prevDayLow).toBe(74482.4765625);
    expect(f.indicators.prevDayClose).toBe(74902.59375);
    expect(clips).toHaveLength(0);
  });

  it("the 15:15 cutoff restores the day's real range and keeps the official close", () => {
    const snap = src.snapshotSync(nextMorning);
    const base = computeFeatures("SENSEX", snap, cal, rawCfg);
    const cut = computeFeatures("SENSEX", snap, cal, cutoffCfg);
    expectAllFinite(cut);
    // Within 0.002% of Yahoo's daily bar (74,910.96 / 74,598.47).
    expect(cut.indicators.prevDayHigh).toBe(74909.6796875);
    expect(cut.indicators.prevDayLow).toBe(74600.59375);
    // Rule 2: the previous close stays the official close, so the gap and daily vol do not move.
    expect(cut.indicators.prevDayClose).toBe(74902.59375);
    expect(cut.gapPct).toBe(base.gapPct);
    expect(cut.realizedVol20d).toBe(base.realizedVol20d);
    expect(cut.spot).toBe(base.spot);
    // Early in the session realized vol borrows the previous session's last bars: no more +1.27% / -0.89%.
    expect(base.realizedVol2h).toBeGreaterThan(2 * cut.realizedVol2h);
    expect(cut.indicators.bbWidthPct).toBeLessThan(base.indicators.bbWidthPct);
    expect(cut.indicators.rsi14).not.toBeCloseTo(base.indicators.rsi14, 3);
    // Today's bars before the cutoff are untouched.
    expect(cut.retFromOpen).toBe(base.retFromOpen);
    expect(cut.ret5m).toBe(base.ret5m);
    expect(cut.openingRange).toEqual(base.openingRange);
  });

  it("the cutoff drops NIFTY's flat 15:15/15:20 bars and the 15:25 jump from the indicators", () => {
    const snap = src.snapshotSync(nextMorning);
    const base = computeFeatures("NIFTY", snap, cal, rawCfg);
    const cut = computeFeatures("NIFTY", snap, cal, cutoffCfg);
    expect(cut.indicators.prevDayClose).toBe(23477.80078125); // the 15:25 auction close, kept
    expect(cut.indicators.prevDayClose).toBe(base.indicators.prevDayClose);
    expect(cut.gapPct).toBe(base.gapPct);
    expect(cut.indicators.prevDayHigh).toBe(base.indicators.prevDayHigh); // flat bars never set the range
    expect(cut.indicators.rsi14).not.toBeCloseTo(base.indicators.rsi14, 3);
    expect(cut.realizedVol2h).toBeLessThan(base.realizedVol2h);
  });

  it("the cutoff holds for today's bars too: after 15:15 the indicators stop at the 15:10 bar", () => {
    // At 15:15 the 15:10 bar is the last closed one, so the cutoff has nothing of today's to drop yet.
    const at1515 = computeFeatures("SENSEX", src.snapshotSync(istAt("2026-09-10", "15:15")), cal, cutoffCfg);
    const late = istAt("2026-09-10", "15:31");
    const cut = computeFeatures("SENSEX", src.snapshotSync(late), cal, cutoffCfg);
    const base = computeFeatures("SENSEX", src.snapshotSync(late), cal, rawCfg);
    expect(cut.spot).toBe(base.spot); // the price itself is never cut
    expect(cut.spot).toBe(74902.59375);
    for (const k of ["rsi14", "adx14", "ema9", "ema21", "supertrendLine", "bbPctB", "bbWidthPct"] as const) {
      expect(cut.indicators[k]).toBe(at1515.indicators[k]);
    }
    expect(base.indicators.rsi14).not.toBe(cut.indicators.rsi14);
  });

  it("with the body clip alone the 15:20 print goes, but the 15:25 bar still opens at it", () => {
    const snap = src.snapshotSync(nextMorning);
    const f = computeFeatures("SENSEX", snap, cal, clipCfg);
    computeFeatures("NIFTY", snap, cal, clipCfg); // prepares SENSEX again as NIFTY's other index
    computeFeatures("SENSEX", src.snapshotSync(istAt("2026-09-11", "09:35")), cal, clipCfg);
    expect(f.indicators.prevDayHigh).toBe(75575.28125); // the 15:25 bar's open
    expect(f.indicators.prevDayLow).toBe(74600.59375);
    expect(f.indicators.prevDayClose).toBe(74902.59375);
    // Reported once, however often the bar is cleaned.
    expect(clips.map((c) => [c.symbol, c.otherSymbol, c.t, c.clipped.c])).toEqual([["^BSESN", "^NSEI", sensex1520.t, 74630.5]]);
  });

  it("logs every clip as a console warning by default", () => {
    setBodyClipListener(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      computeFeatures("SENSEX", src.snapshotSync(nextMorning), cal, clipCfg);
      computeFeatures("NIFTY", src.snapshotSync(nextMorning), cal, clipCfg);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(
        "[features] body clip ^BSESN 2026-09-10 15:20 IST bar: body +1.269% while ^NSEI moved +0.000%; o 74630.50 h 75803.76 l 74482.48 c 75577.74 -> flat at 74630.50",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("a failing listener neither hides the clip nor breaks the features", () => {
    setBodyClipListener(() => {
      throw new Error("listener down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const f = computeFeatures("SENSEX", src.snapshotSync(nextMorning), cal, clipCfg);
      expect(f.dataAgeSec).not.toBe(NO_DATA_AGE_SEC);
      expect(f.indicators.prevDayHigh).toBe(75575.28125);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("changes nothing where there is nothing to clean", () => {
    const snap = src.snapshotSync(istAt("2026-09-10", "11:00"));
    const base = computeFeatures("NIFTY", snap, cal, rawCfg);
    expect(computeFeatures("NIFTY", snap, cal, makeConfig({ features: { indicatorCutoffIst: "15:30" } }))).toEqual(base);
    expect(computeFeatures("NIFTY", snap, cal, clipCfg)).toEqual(base); // no flagged bar before 10 Sep 15:20
    expect(clips).toHaveLength(0);
  });

  it("keeps cached series of different cleaning rules apart", () => {
    const snap = src.snapshotSync(nextMorning);
    expect(computeFeatures("SENSEX", snap, cal, cutoffCfg).indicators.prevDayHigh).toBe(74909.6796875);
    expect(computeFeatures("SENSEX", snap, cal, rawCfg).indicators.prevDayHigh).toBe(75803.7578125);
    expect(computeFeatures("SENSEX", snap, cal, clipCfg).indicators.prevDayHigh).toBe(75575.28125);
    expect(computeFeatures("SENSEX", snap, cal, cutoffCfg).indicators.prevDayHigh).toBe(74909.6796875);
  });
});

describe("body clip on a session's last bar (synthetic)", () => {
  afterEach(() => setBodyClipListener(null));

  it("still takes the previous close from the bar as published (the official close)", () => {
    setBodyClipListener(() => {});
    // Synthetic: NIFTY's last bar jumps 0.8% (an auction close) while SENSEX's last bar is flat.
    const nifty = sessionFromCloses("2026-10-06", [...Array(74).fill(100), 100.8], 100, 0);
    const sensex = sessionFromCloses("2026-10-06", Array(75).fill(300), 300, 0);
    const morning = [...nifty, ...sessionFromCloses(TODAY, [100.9, 101], 100.9, 0)];
    const src = replay({ "^NSEI": morning, "^BSESN": [...sensex, ...sessionFromCloses(TODAY, [300.2, 300.3], 300.2, 0)] });
    const t = istAt(TODAY, "09:25");
    const base = computeFeatures("NIFTY", src.snapshotSync(t), cal, rawCfg);
    const clipped = computeFeatures("NIFTY", src.snapshotSync(t), cal, makeConfig({ features: { indicatorCutoffIst: null, bodyClip: true } }));
    expect(base.indicators.prevDayClose).toBe(100.8);
    expect(clipped.indicators.prevDayClose).toBe(100.8);
    expect(clipped.gapPct).toBe(base.gapPct);
    expect(clipped.indicators.prevDayHigh).toBe(100); // the jump no longer sets the range
    expect(base.indicators.prevDayHigh).toBe(100.8);
  });
});

describe("cleaning config", () => {
  it("cuts the closing auction at 15:15 by default and keeps the body clip off", () => {
    expect(DEFAULT_CONFIG.features.indicatorCutoffIst).toBe("15:15");
    expect(DEFAULT_CONFIG.features.bodyClip).toBe(false);
  });

  it("validates the cutoff time", () => {
    expect(makeConfig({ features: { indicatorCutoffIst: "15:15" } }).features.indicatorCutoffIst).toBe("15:15");
    expect(makeConfig({ features: { indicatorCutoffIst: null } }).features.indicatorCutoffIst).toBeNull();
    expect(() => makeConfig({ features: { indicatorCutoffIst: "3:15pm" } })).toThrow(/indicatorCutoffIst/);
    // Before the square-off it would freeze the features that manage open positions.
    expect(() => makeConfig({ features: { indicatorCutoffIst: "14:00" } })).toThrow(/indicatorCutoffIst/);
    expect(() => makeConfig({ features: { indicatorCutoffIst: "15:45" } })).toThrow(/indicatorCutoffIst/);
    expect(() => makeConfig({ features: { bodyClip: "yes" as unknown as boolean } })).toThrow(/bodyClip/);
  });
});
