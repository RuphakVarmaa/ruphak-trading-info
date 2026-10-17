import { describe, expect, it, vi } from "vitest";
import { MINUTE_MS, istAt, istIso } from "../clock";
import { FlowMonitor, type ChainRow, type ChainSnapshot, type SideQuote } from "../flow/flowMonitor";
import { FLOW_STATS } from "../flow/flowStats";
import type { OptionFlowView } from "../api-types";
import type { FlowStatsFile } from "../flow/flowStatsTypes";
import type { IndexId } from "../types";
import { FlowAsOfCache, flowViewAsOf } from "./flowAsOf";
import { optionBlock } from "./snapshot";

const DAY = "2026-10-14";
/** No research baselines: the monitor's documented default thresholds apply (5 minutes: |ΔOI| ≥ 1%, |ΔLTP| ≥ 1%). */
const EMPTY_STATS: FlowStatsFile = {
  generatedAt: "",
  source: "test",
  method: "",
  rules: [],
  entryTimes: { NIFTY: [], SENSEX: [] },
  baselines: { volumeMedian: {}, oiChangeP90Pct: {} },
  honestSummary: ["Test statistics."],
};

/** Samples are taken 1.5 s after each minute, as the market feed does. */
const t0 = istAt(DAY, "10:00") + 1_500;
const tAt = (m: number, day = DAY) => istAt(day, "10:00") + 1_500 + m * MINUTE_MS;
const STRIKES = Array.from({ length: 13 }, (_, i) => 22_200 + 50 * i); // 22200..22800, ATM 22500

const q = (o: Partial<SideQuote> = {}): SideQuote => ({ ltp: 100, volume: 0, oi: 100_000, bid: 99.9, ask: 100.1, iv: 12, delta: 0.5, ...o });

/** OI and price paths per strike and side over minutes m: +2,000 or −2,000 OI and ±1 rupee a minute. */
type Path = { oi: 1 | -1; px: 1 | -1 };
const PATHS: Record<string, Path> = {
  "22500 PE": { oi: 1, px: -1 }, // short build-up (put writers adding)
  "22450 PE": { oi: 1, px: 1 }, // long build-up
  "22550 CE": { oi: -1, px: 1 }, // short covering
  "22600 CE": { oi: -1, px: -1 }, // long unwinding
  "22650 CE": { oi: 1, px: -1 }, // short build-up (call writers adding)
  // Beyond ATM ±5 strikes: never counted.
  "22800 CE": { oi: 1, px: -1 },
  "22200 PE": { oi: 1, px: 1 },
};

function side(strike: number, type: "CE" | "PE", m: number): SideQuote {
  const p = PATHS[`${strike} ${type}`];
  if (!p) return q({ delta: type === "CE" ? 0.5 : -0.5 });
  const ltp = 100 + p.px * m;
  return q({ oi: 100_000 + p.oi * 2_000 * m, ltp, bid: ltp - 0.1, ask: ltp + 0.1, delta: type === "CE" ? 0.5 : -0.5 });
}

function sample(m: number, index: IndexId = "NIFTY", day = DAY, tweak: (r: ChainRow) => ChainRow = (r) => r): ChainSnapshot {
  const rows = STRIKES.map((strike) => tweak({ strike, ce: side(strike, "CE", m), pe: side(strike, "PE", m) }));
  return { t: tAt(m, day), index, expiry: "2026-10-19", lotSize: 65, spot: 22_510, rows };
}

const minutes = (from: number, to: number, f = (m: number) => sample(m)) => Array.from({ length: to - from + 1 }, (_, i) => f(from + i));

describe("flowViewAsOf", () => {
  const asOf = istAt(DAY, "10:12") + 30_000;
  const upTo = minutes(0, 12);
  // Later samples with different OI and prices, and another index's samples.
  const later = minutes(13, 30, (m) => sample(m, "NIFTY", DAY, (r) => ({ ...r, ce: q({ oi: 9_000_000, ltp: 5 }), pe: q({ oi: 1, ltp: 900 }) })));
  const sensex = minutes(0, 30, (m) => sample(m, "SENSEX"));

  it("ignores samples taken after asOf, in any order", () => {
    const view = flowViewAsOf(upTo, "NIFTY", asOf, { stats: EMPTY_STATS });
    expect(view).not.toBeNull();
    expect(view!.asOf).toBe(istIso(tAt(12)));
    expect(view!.minutes).toBe(13);
    expect(view!.source).toBe("feed");
    const all = [...later, ...sensex, ...upTo].reverse();
    expect(flowViewAsOf(all, "NIFTY", asOf, { stats: EMPTY_STATS })).toEqual(view);
    // A sample exactly at asOf counts; one a millisecond later does not.
    expect(flowViewAsOf(upTo, "NIFTY", tAt(12), { stats: EMPTY_STATS })!.minutes).toBe(13);
    expect(flowViewAsOf(upTo, "NIFTY", tAt(12) - 1, { stats: EMPTY_STATS })!.minutes).toBe(12);
  });

  it("is the monitor's own view of the same samples", () => {
    const m = new FlowMonitor({ stats: EMPTY_STATS });
    for (const s of upTo) m.ingest(s);
    expect(flowViewAsOf([...upTo, ...later], "NIFTY", asOf, { stats: EMPTY_STATS })).toEqual(m.view("NIFTY", asOf, { source: "feed", dte: null }));
  });

  it("FlowAsOfCache.viewAt gives flowViewAsOf's view", () => {
    const cache = new FlowAsOfCache({ stats: EMPTY_STATS });
    const all = [...upTo, ...later, ...sensex];
    expect(cache.viewAt(all, "NIFTY", asOf, 3)).toEqual(flowViewAsOf(all, "NIFTY", asOf, { stats: EMPTY_STATS, dte: 3 }));
    expect(cache.viewAt(all, "SENSEX", asOf, null)).toEqual(flowViewAsOf(all, "SENSEX", asOf, { stats: EMPTY_STATS, dte: null }));
    expect(cache.viewAt([], "NIFTY", asOf, null)).toBeNull();
  });

  it("is null without a sample of the index at or before asOf on asOf's date", () => {
    expect(flowViewAsOf([], "NIFTY", asOf)).toBeNull();
    expect(flowViewAsOf(later, "NIFTY", asOf)).toBeNull();
    expect(flowViewAsOf(sensex, "NIFTY", t0 - 1)).toBeNull();
    expect(flowViewAsOf(upTo, "SENSEX", asOf)).toBeNull();
    // Yesterday's samples say nothing about today.
    const yesterday = minutes(0, 30, (m) => sample(m, "NIFTY", "2026-10-13"));
    expect(flowViewAsOf(yesterday, "NIFTY", asOf)).toBeNull();
    expect(flowViewAsOf([...yesterday, ...upTo], "NIFTY", asOf, { stats: EMPTY_STATS })).toEqual(flowViewAsOf(upTo, "NIFTY", asOf, { stats: EMPTY_STATS }));
  });

  it("classifies the 5-minute build-ups and the option block counts them at ATM ±5 strikes", () => {
    const T = istAt(DAY, "10:15");
    const view = flowViewAsOf(minutes(0, 14), "NIFTY", T, { stats: EMPTY_STATS })!;
    expect(view.atm).toBe(22_500);
    expect(view.step).toBe(50);
    const row = (strike: number) => view.windows["5m"].rows.find((r) => r.strike === strike)!;
    // 10:14 against 10:09: ±10,000 OI on about 118,000-128,000 (8-9%) and ±5 rupees on about 105 (4-5%).
    expect(row(22_500).pe!.buildup).toBe("SHORT_BUILDUP");
    expect(row(22_450).pe!.buildup).toBe("LONG_BUILDUP");
    expect(row(22_550).ce!.buildup).toBe("SHORT_COVERING");
    expect(row(22_600).ce!.buildup).toBe("LONG_UNWINDING");
    expect(row(22_650).ce!.buildup).toBe("SHORT_BUILDUP");
    expect(row(22_800).ce!.buildup).toBe("SHORT_BUILDUP");
    expect(row(22_200).pe!.buildup).toBe("LONG_BUILDUP");
    expect(row(22_500).ce!.buildup).toBe("NEUTRAL");

    const o = optionBlock(view, 22_510, 12, T)!;
    // [long build-up, short build-up, short covering, long unwinding]; 22800 CE and 22200 PE are 6 strikes out.
    expect(o.bc).toEqual([0, 1, 1, 1]);
    expect(o.bp).toEqual([1, 1, 0, 0]);
    // The ATM row: call flat at 100, put at 100 − 14 = 86 (bid 85.9, ask 86.1). The sample at 10:14:01.5 is stamped
    // to the second (asOf), so its age at 10:15 reads 59 s, never less than the true 58.5 s.
    expect(o).toMatchObject({ k: 22_500, cm: 100, cs: 0.2, pm: 86, ps: 0.23, iv: 12, ivx: 0, oa: 59 });
  });
});

describe("FlowAsOfCache (O2: incremental)", () => {
  const SESSION = "2026-10-19";
  const wave = (m: number, k: number, ce: boolean): SideQuote => ({
    ltp: 100 + Math.sin(m / 7 + k) * 5,
    volume: 1000 * m + ((m * 7919 + k) % 13) * 400,
    oi: 100_000 + 500 * m * (ce ? 1 : -1) + k * 100 + ((m * k) % 17) * 300,
    bid: 99,
    ask: 101,
    iv: 12 + (m % 5) / 10,
    delta: ce ? 0.5 : -0.5,
  });
  /** A whole session of minute samples (09:15 to 15:29) on 7 strikes (ATM ±3), for one index. */
  const session = (index: IndexId = "NIFTY", day = SESSION): ChainSnapshot[] =>
    Array.from({ length: 375 }, (_, m) => ({
      t: istAt(day, "09:15") + 1_500 + m * MINUTE_MS,
      index,
      expiry: "2026-10-20",
      lotSize: 65,
      spot: 25_000 + 3 * Math.sin(m / 9) * 20,
      rows: Array.from({ length: 7 }, (_, k) => ({ strike: 24_850 + 50 * k, ce: wave(m, k, true), pe: wave(m, k, false) })),
    }));

  it("equals flowViewAsOf at every bar close of a session and ingests each sample once (flowasof-incremental)", () => {
    const samples = [...session("NIFTY"), ...session("SENSEX")];
    const closes = Array.from({ length: 75 }, (_, i) => istAt(SESSION, "09:20") + i * 5 * MINUTE_MS);
    const cache = new FlowAsOfCache({ stats: FLOW_STATS });
    const got: (OptionFlowView | null)[] = [];
    const ingest = vi.spyOn(FlowMonitor.prototype, "ingest");
    try {
      for (const close of closes) {
        for (const index of ["NIFTY", "SENSEX"] as const) {
          const v = cache.viewAt(samples, index, close, 1);
          if (index === "NIFTY") got.push(structuredClone(v));
        }
      }
      // 375 samples per index, each ingested once; a fresh replay at every close would ingest about 28,000.
      expect(ingest).toHaveBeenCalledTimes(2 * 375);
    } finally {
      ingest.mockRestore();
    }
    closes.forEach((close, i) => expect(got[i]).toEqual(flowViewAsOf(samples, "NIFTY", close, { stats: FLOW_STATS, dte: 1 })));
  }, 60_000);

  it("equals flowViewAsOf for out-of-order calls, after a late, dropped or replaced sample, and across a date change", () => {
    const stats = EMPTY_STATS;
    const all = session("NIFTY");
    const cache = new FlowAsOfCache({ stats });
    const check = (snaps: readonly ChainSnapshot[], at: number, index: IndexId = "NIFTY") =>
      expect(cache.viewAt(snaps, index, at, 2)).toEqual(flowViewAsOf(snaps, index, at, { stats, dte: 2 }));
    const at = (hhmm: string, day = SESSION) => istAt(day, hhmm);

    // Forward, then back to an earlier close, then forward again.
    for (const hhmm of ["10:00", "10:30", "10:05", "11:00", "11:00"]) check(all, at(hhmm));
    // A late sample: the 10:40 minute arrives after the 11:00 call.
    const gap = all.filter((s) => s.t !== at("10:40") + 1_500);
    const g = new FlowAsOfCache({ stats });
    expect(g.viewAt(gap, "NIFTY", at("11:00"), 2)).toEqual(flowViewAsOf(gap, "NIFTY", at("11:00"), { stats, dte: 2 }));
    expect(g.viewAt(all, "NIFTY", at("11:05"), 2)).toEqual(flowViewAsOf(all, "NIFTY", at("11:05"), { stats, dte: 2 }));
    expect(g.viewAt(all, "NIFTY", at("11:05"), 2)).not.toEqual(flowViewAsOf(gap, "NIFTY", at("11:05"), { stats, dte: 2 }));
    // A dropped sample (the feed trimmed its oldest), and a replaced one (same count, different data).
    check(all.slice(1), at("11:10"));
    const bump = (s: ChainSnapshot): ChainSnapshot => ({ ...s, spot: s.spot + 40, rows: s.rows.map((r) => ({ ...r, ce: r.ce ? { ...r.ce, oi: (r.ce.oi ?? 0) * 2 } : r.ce })) });
    // 10:59 is the 15-minute base of the 11:15 view, so its data shows in the answer.
    const replaced = all.slice(1).map((s) => (s.t === at("10:59") + 1_500 ? bump(s) : s));
    expect(flowViewAsOf(replaced, "NIFTY", at("11:15"), { stats, dte: 2 })).not.toEqual(flowViewAsOf(all.slice(1), "NIFTY", at("11:15"), { stats, dte: 2 }));
    check(replaced, at("11:15"));
    // Samples arrive in any order; another day's samples say nothing about this one.
    check([...replaced].reverse(), at("11:20"));
    const tomorrow = session("NIFTY", "2026-10-20");
    check([...replaced, ...tomorrow], at("09:40", "2026-10-20"));
    check([...replaced, ...tomorrow], at("11:25"));
    // No sample of the index at or before asOf: null, as flowViewAsOf.
    expect(cache.viewAt(all, "SENSEX", at("11:30"), 2)).toBeNull();
    expect(cache.viewAt(all, "NIFTY", at("09:15"), 2)).toBeNull();
  });
});
