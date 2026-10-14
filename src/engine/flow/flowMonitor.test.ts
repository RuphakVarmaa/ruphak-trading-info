import { describe, expect, it } from "vitest";
import { istAt, istIso } from "../clock";
import type { FlowStatsFile } from "./flowStatsTypes";
import {
  FlowMonitor,
  atmDecayPctPerHour,
  buildupActor,
  classifyBuildup,
  fmtQty,
  nearestStrike,
  packSnapshot,
  strikeStep,
  unpackSnapshot,
  type ChainRow,
  type ChainSnapshot,
  type SideQuote,
} from "./flowMonitor";
import { KeyedBaseline, entryWindowVerdict, parseBaselineKey, parseWindow } from "./flowStats";

const DAY = "2026-10-14";
const EMPTY_STATS: FlowStatsFile = {
  generatedAt: "",
  source: "test",
  method: "",
  rules: [],
  entryTimes: { NIFTY: [], SENSEX: [] },
  baselines: { volumeMedian: {}, oiChangeP90Pct: {} },
  honestSummary: ["Test statistics."],
};

const t0 = istAt(DAY, "10:00") + 2_000;
const tAt = (m: number) => t0 + m * 60_000;

function q(o: Partial<SideQuote> = {}): SideQuote {
  return { ltp: 100, volume: 0, oi: 100_000, bid: 99.95, ask: 100.05, iv: 12, delta: 0.5, ...o };
}

const STRIKES = [22350, 22400, 22450, 22500, 22550, 22600, 22650];

/** A chain at minute m, every strike with the given sides (defaults otherwise). */
function snap(m: number, spot: number, f: (strike: number) => Partial<ChainRow> = () => ({}), lotSize: number | null = 65): ChainSnapshot {
  const rows: ChainRow[] = STRIKES.map((strike) => ({ strike, ce: q({ delta: 0.5 }), pe: q({ delta: -0.5 }), ...f(strike) }));
  return { t: tAt(m), index: "NIFTY", expiry: "2026-10-20", lotSize, spot, rows };
}

describe("build-up classification", () => {
  it("reads price and OI together", () => {
    expect(classifyBuildup(5, 3, 1, 1)).toBe("LONG_BUILDUP");
    expect(classifyBuildup(5, -3, 1, 1)).toBe("SHORT_BUILDUP");
    expect(classifyBuildup(-5, 3, 1, 1)).toBe("SHORT_COVERING");
    expect(classifyBuildup(-5, -3, 1, 1)).toBe("LONG_UNWINDING");
  });

  it("is neutral under either threshold or without data", () => {
    expect(classifyBuildup(0.5, 3, 1, 1)).toBe("NEUTRAL");
    expect(classifyBuildup(5, 0.2, 1, 1)).toBe("NEUTRAL");
    expect(classifyBuildup(null, 3, 1, 1)).toBe("NEUTRAL");
    expect(buildupActor("SHORT_BUILDUP", "PE")).toBe("put writers adding");
    expect(buildupActor("SHORT_COVERING", "CE")).toBe("call writers covering");
  });

  it("formats quantities in lakh and crore", () => {
    expect(fmtQty(1_840_000)).toBe("18.4L");
    expect(fmtQty(12_300_000)).toBe("1.23Cr");
    expect(fmtQty(4_500)).toBe("4.5K");
  });

  it("finds the strike step and ATM", () => {
    const rows = STRIKES.map((strike) => ({ strike }));
    expect(strikeStep(rows)).toBe(50);
    expect(nearestStrike(rows, 22512)).toBe(22500);
  });
});

/** Put writers adding at 22500 while the put falls; the call is flat. */
function putWriting(mon: FlowMonitor, minutes: number): void {
  for (let m = 0; m < minutes; m++) {
    mon.ingest(
      snap(m, 22510, (strike) =>
        strike === 22500
          ? { ce: q({ ltp: 100 + 0.2 * m, volume: 1000 * m, delta: 0.5 }), pe: q({ ltp: 100 - 0.5 * m, volume: 1000 * m, oi: 100_000 + 2000 * m, delta: -0.5 }) }
          : { ce: q({ volume: 1000 * m, oi: strike === 22600 ? 900_000 : 100_000 }), pe: q({ volume: 1000 * m, oi: strike === 22400 ? 800_000 : 100_000, delta: -0.5 }) },
      ),
    );
  }
}

describe("windows", () => {
  it("measures 1, 5 and 15-minute changes and classifies them", () => {
    const mon = new FlowMonitor({ stats: EMPTY_STATS });
    putWriting(mon, 20);
    const v = mon.view("NIFTY", tAt(19) + 5_000);
    expect(v.minutes).toBe(20);
    expect(v.atm).toBe(22500);
    expect(v.step).toBe(50);
    expect(v.source).toBe("feed");
    const row = (k: "1m" | "5m" | "15m") => v.windows[k].rows.find((r) => r.strike === 22500)!;
    expect(v.windows["1m"].from).toBe(istIso(tAt(18)));
    expect(row("1m").pe).toMatchObject({ oiChg: 2000, vol: 1000, buildup: "SHORT_BUILDUP" });
    expect(row("5m").pe).toMatchObject({ oiChg: 10_000, vol: 5000, buildup: "SHORT_BUILDUP" });
    expect(row("5m").pe!.ltpChgPct).toBeCloseTo((90.5 / 93 - 1) * 100, 1);
    expect(v.windows["15m"].from).toBe(istIso(tAt(4)));
    expect(row("15m").pe!.oiChg).toBe(30_000);
    expect(row("15m").ce!.buildup).toBe("NEUTRAL");
    // The latest quote travels with every window.
    expect(row("1m").pe).toMatchObject({ bid: 99.95, ask: 100.05, iv: 12, delta: -0.5 });
  });

  it("summarises writers, PCR, walls and the fastest OI", () => {
    const mon = new FlowMonitor({ stats: EMPTY_STATS });
    putWriting(mon, 20);
    const s = mon.view("NIFTY", tAt(19)).summary;
    expect(s.callWritersVsPutWriters).toMatchObject({ window: "15m", ceOiAdded: 0, peOiAdded: 30_000, lean: "PUT_WRITERS" });
    expect(s.callWritersVsPutWriters.text).toContain("put writers adding faster");
    expect(s.pcrChg15m).toBeGreaterThan(0);
    expect(s.pcr).toBeGreaterThan(0);
    expect(s.resistance).toEqual({ strike: 22600, oi: 900_000 });
    expect(s.support).toEqual({ strike: 22400, oi: 800_000 });
    expect(s.fastestOiAdd.pe).toEqual({ strike: 22500, oiChg: 30_000 });
    expect(s.fastestOiAdd.ce).toBeNull();
  });

  it("raises a plain-words event for a notable 5-minute build-up", () => {
    const mon = new FlowMonitor({ stats: EMPTY_STATS });
    putWriting(mon, 20);
    const v = mon.view("NIFTY", tAt(19));
    const e = v.events.find((x) => x.kind === "OI_BUILDUP");
    expect(e).toBeDefined();
    expect(e!.text).toMatch(/^\d\d:\d\d · NIFTY 22500 PE · \+\d+(\.\d)?K OI in 5 min \(\+[\d.]+%\), price −[\d.]+% → SHORT BUILD-UP \(put writers adding\)$/);
    // Deduplicated: one event per 5 minutes for the same strike and class.
    const times = v.events.filter((x) => x.kind === "OI_BUILDUP").map((x) => Date.parse(x.at));
    for (let i = 1; i < times.length; i++) expect(times[i - 1] - times[i]).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("keeps one snapshot a minute, starts a new session on a new date and caps the history", () => {
    const mon = new FlowMonitor({ stats: EMPTY_STATS, maxSnaps: 10 });
    expect(mon.ingest(snap(0, 22500))).toBe(true);
    expect(mon.ingest({ ...snap(0, 22500), t: tAt(0) + 30_000 })).toBe(false);
    expect(mon.ingest({ ...snap(0, 22500), t: tAt(0) - 60_000 })).toBe(false);
    for (let m = 1; m < 15; m++) mon.ingest(snap(m, 22500));
    expect(mon.snapshots("NIFTY")).toHaveLength(10);
    mon.ingest({ ...snap(0, 22500), t: istAt("2026-10-15", "09:20") });
    expect(mon.snapshots("NIFTY")).toHaveLength(1);
    expect(mon.session("NIFTY")).toBe("2026-10-15");
  });

  it("measures no window across a gap in the data", () => {
    const mon = new FlowMonitor({ stats: EMPTY_STATS });
    for (let m = 0; m <= 5; m++) mon.ingest(snap(m, 22500));
    mon.ingest(snap(30, 22500));
    const v = mon.view("NIFTY", tAt(30));
    expect(v.windows["1m"].from).toBeNull();
    expect(v.windows["5m"].from).toBeNull();
    expect(v.windows["15m"].from).toBe(istIso(tAt(5)));
    expect(v.windows["1m"].rows[0].ce!.oiChg).toBeNull();
  });

  it("is empty with a note before the first snapshot and says when the last one is stale", () => {
    const mon = new FlowMonitor({ stats: EMPTY_STATS });
    const empty = mon.view("SENSEX", tAt(0));
    expect(empty.minutes).toBe(0);
    expect(empty.asOf).toBeNull();
    expect(empty.note).toContain("No option-flow snapshot yet");
    expect(empty.honestSummary).toEqual(["Test statistics."]);
    mon.ingest(snap(0, 22500));
    expect(mon.view("NIFTY", tAt(10)).note).toContain("10 min old");
  });
});

describe("volume spikes", () => {
  function steadyThenSpike(mon: FlowMonitor, quietMin: number) {
    let vol = 0;
    for (let m = 0; m <= quietMin; m++) {
      vol += m === quietMin ? 800 : 100;
      const ltp = m === quietMin ? 112 : 100;
      mon.ingest(snap(m, 22500, (strike) => (strike === 22550 ? { ce: q({ volume: vol, ltp }) } : {})));
    }
  }

  it("flags a minute at 5× the session's own running median", () => {
    const mon = new FlowMonitor({ stats: EMPTY_STATS });
    steadyThenSpike(mon, 15);
    const v = mon.view("NIFTY", tAt(15));
    const e = v.events.find((x) => x.kind === "VOLUME_SPIKE");
    expect(e).toMatchObject({ strike: 22550, side: "CE", volMultiple: 8 });
    expect(e!.text).toContain("NIFTY 22550 CE · volume 8× normal (800 in 1 min)");
    expect(e!.text).toContain("aggressive call buying");
    expect(v.summary.volumeBaseline).toBe("session");
    const row = v.windows["1m"].rows.find((r) => r.strike === 22550)!;
    expect(row.ce!.volMultiple).toBeGreaterThan(5);
  });

  it("needs ten minutes of its own history without a research baseline", () => {
    const mon = new FlowMonitor({ stats: EMPTY_STATS });
    steadyThenSpike(mon, 5);
    expect(mon.view("NIFTY", tAt(5)).events.filter((x) => x.kind === "VOLUME_SPIKE")).toHaveLength(0);
  });

  it("uses the research's median 1-minute volume when the stats carry one", () => {
    const stats: FlowStatsFile = { ...EMPTY_STATS, baselines: { volumeMedian: { "NIFTY|10:00|1|CE": 100, "NIFTY|10:00|ATM": 400 }, oiChangeP90Pct: {} } };
    const mon = new FlowMonitor({ stats });
    steadyThenSpike(mon, 5);
    const v = mon.view("NIFTY", tAt(5));
    expect(v.events.find((x) => x.kind === "VOLUME_SPIKE")).toMatchObject({ strike: 22550, volMultiple: 8 });
    expect(v.summary.volumeBaseline).toBe("research");
  });
});

describe("premium dry-up and decay", () => {
  it("flags 15 quiet minutes against the session's normal volume and OI activity", () => {
    const mon = new FlowMonitor({ stats: EMPTY_STATS });
    let vol = 0;
    let oi = 100_000;
    for (let m = 0; m <= 50; m++) {
      const active = m < 30;
      vol += active ? 1000 : 100;
      if (active) oi += 1000;
      mon.ingest(snap(m, 22500, () => ({ ce: q({ volume: vol, oi }), pe: q({ volume: vol, oi, delta: -0.5 }) })));
    }
    const v = mon.view("NIFTY", tAt(50));
    expect(v.summary.premiumDryUp).toBe(true);
    expect(v.summary.dryUpDetail).toMatch(/volume \d+% of normal, \|ΔOI\| 0% of the session's median/);
    expect(v.events.some((e) => e.kind === "DRY_UP")).toBe(true);

    const busy = new FlowMonitor({ stats: EMPTY_STATS });
    for (let m = 0; m <= 50; m++) busy.ingest(snap(m, 22500, () => ({ ce: q({ volume: 1000 * m, oi: 100_000 + 1000 * m }), pe: q({ volume: 1000 * m, oi: 100_000 + 1000 * m }) })));
    expect(busy.view("NIFTY", tAt(50)).summary.premiumDryUp).toBe(false);
  });

  it("measures the ATM straddle's decay beyond what delta × the index move explains", () => {
    const mon = new FlowMonitor({ stats: EMPTY_STATS });
    for (let m = 0; m <= 15; m++) {
      const spot = 22500 + 10 * m;
      // Delta 0.6 / −0.4: the straddle gains 0.2 × the move; it also bleeds 0.2 a minute.
      mon.ingest(snap(m, spot, (strike) => (strike === 22500 ? { ce: q({ ltp: 100 + 6 * m - 0.1 * m, delta: 0.6 }), pe: q({ ltp: 100 - 4 * m - 0.1 * m, delta: -0.4 }) } : {})));
    }
    // ATM moved to 22650 by the end; check the pure helper on the 22500 straddle directly.
    const snaps = mon.snapshots("NIFTY");
    expect(atmDecayPctPerHour(snaps[15], snaps[0], 22500)).toBeCloseTo(6, 1);
    // Flat index, straddle 200 → 197 in 15 minutes: 6% an hour.
    const flat = new FlowMonitor({ stats: EMPTY_STATS });
    for (let m = 0; m <= 15; m++) flat.ingest(snap(m, 22500, (strike) => (strike === 22500 ? { ce: q({ ltp: 100 - 0.1 * m }), pe: q({ ltp: 100 - 0.1 * m, delta: -0.5 }) } : {})));
    expect(flat.view("NIFTY", tAt(15)).summary.decayPctPerHourAtm).toBeCloseTo(6, 1);
  });
});

describe("thresholds from the research", () => {
  it("scales the OI threshold from the measured 15-minute P90", () => {
    const stats: FlowStatsFile = { ...EMPTY_STATS, baselines: { volumeMedian: {}, oiChangeP90Pct: { NIFTY: 8 } } };
    const mon = new FlowMonitor({ stats });
    expect(mon.minOiPct("NIFTY", "15m")).toBe(4);
    expect(mon.minOiPct("NIFTY", "5m")).toBeCloseTo(4 * Math.sqrt(5 / 15), 2);
    expect(mon.minOiPct("SENSEX", "15m")).toBe(2);
  });
});

describe("storage form", () => {
  it("round-trips a snapshot, missing sides included", () => {
    const s = snap(3, 22512.5, (strike) => (strike === 22350 ? { pe: null } : {}));
    const back = unpackSnapshot(JSON.parse(JSON.stringify(packSnapshot(s))));
    expect(back).toEqual(s);
    expect(unpackSnapshot({ v: 2 } as never)).toBeNull();
  });
});

describe("research keys and windows", () => {
  it("reads baseline keys in several spellings", () => {
    expect(parseBaselineKey("NIFTY|09:30|ATM")).toEqual({ index: "NIFTY", bucket: 570, moneyness: "ATM", side: null });
    expect(parseBaselineKey("SENSEX:0945:±2:PE")).toEqual({ index: "SENSEX", bucket: 585, moneyness: "2", side: "PE" });
    expect(parseBaselineKey("NIFTY_10:15_3+")).toEqual({ index: "NIFTY", bucket: 615, moneyness: "3+", side: null });
    expect(parseBaselineKey("NIFTY|600|1")).toEqual({ index: "NIFTY", bucket: 600, moneyness: "1", side: null });
  });

  it("prefers the most specific baseline and ignores unreadable keys", () => {
    const b = new KeyedBaseline({ "NIFTY|09:30|ATM": 100, "NIFTY|09:30|ATM|CE": 140, NIFTY: 10, junk: 5, "NIFTY|09:30|1": -3 });
    expect(b.lookup({ index: "NIFTY", bucket: 570, moneyness: "ATM", side: "CE" })).toBe(140);
    expect(b.lookup({ index: "NIFTY", bucket: 570, moneyness: "ATM", side: "PE" })).toBe(100);
    expect(b.lookup({ index: "NIFTY", bucket: 585, moneyness: "ATM" })).toBe(10);
    expect(b.lookup({ index: "SENSEX", bucket: 570, moneyness: "ATM" })).toBeNull();
    expect(b.size).toBe(3);
  });

  it("parses entry windows with a DTE tag", () => {
    expect(parseWindow("09:30–10:30 IST")).toEqual({ from: 570, to: 630, dteMin: null, dteMax: null });
    expect(parseWindow("10:30-11:15 · DTE 2–5")).toEqual({ from: 630, to: 675, dteMin: 2, dteMax: 5 });
    expect(parseWindow("14:00 to 15:00 expiry day")).toEqual({ from: 840, to: 900, dteMin: 0, dteMax: 0 });
    expect(parseWindow("all day")).toBeNull();
  });

  it("judges now against the cheapest measured window", () => {
    const stats: FlowStatsFile = {
      ...EMPTY_STATS,
      entryTimes: {
        NIFTY: [
          { window: "09:30–10:30", avgPremiumDecayPctPerHour: 4, avgAbsIndexMovePct: 0.3, costPerPointMove: 1.0, sample: 40 },
          { window: "11:15–14:15", avgPremiumDecayPctPerHour: 5, avgAbsIndexMovePct: 0.15, costPerPointMove: 2.0, sample: 40 },
        ],
        SENSEX: [],
      },
    };
    expect(entryWindowVerdict(stats, "NIFTY", 600, 3).verdict).toBe("good");
    const midday = entryWindowVerdict(stats, "NIFTY", 720, 3);
    expect(midday.verdict).toBe("expensive");
    expect(midday.text).toContain("2× the cost in 09:30–10:30");
    expect(entryWindowVerdict(stats, "NIFTY", 660, 3).verdict).toBe("unknown");
    expect(entryWindowVerdict(stats, "SENSEX", 600, 3)).toMatchObject({ verdict: "unknown", text: "No measured entry-time statistics yet." });
    expect(entryWindowVerdict(stats, "NIFTY", 960, 3).verdict).toBe("closed");
  });
});
