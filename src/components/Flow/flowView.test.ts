import { describe, expect, it } from "vitest";
import type { EntryTimeStats } from "@/engine/flow/flowStatsTypes";
import { C } from "@/components/shared/colors";
import { istAt } from "@/lib/ist";
import { REFRESH_CLOSED_MS, REFRESH_IMPORTANT_MS } from "@/lib/refresh";
import { FLOW } from "./__fixtures__/flow";
import {
  baselineVolumePerMin,
  bucketLabel,
  cheapestEntryTime,
  dataStale,
  decayMeter,
  entryTimeAt,
  fmtOi,
  fmtPctChg,
  fmtTimes,
  freshness,
  KIND_META,
  latestEvents,
  marketPollMs,
  maxAbsOiChg,
  nearAtm,
  oiP90Pct,
  parseWindow,
  pcrText,
  rankSides,
  strikeStep,
  unusualOi,
  volumeBaselineKeys,
  volVsNormal,
  writerLean,
  writerLine,
  writerTotals,
} from "./flowView";

describe("figures", () => {
  it("writes OI in lakh and crore, signed on request", () => {
    expect(fmtOi(1_840_000)).toBe("18.4L");
    expect(fmtOi(12_400_000)).toBe("1.24Cr");
    expect(fmtOi(8_200)).toBe("8.2k");
    expect(fmtOi(420_000, true)).toBe("+4.2L");
    expect(fmtOi(-110_000, true)).toBe("−1.1L");
    expect(fmtOi(0, true)).toBe("0");
    expect(fmtOi(null)).toBe("—");
    expect(fmtOi(Number.NaN)).toBe("—");
  });

  it("writes multiples of normal and percent changes", () => {
    expect(fmtTimes(2.44)).toBe("×2.4");
    expect(fmtTimes(0.31)).toBe("×0.3");
    expect(fmtTimes(12.6)).toBe("×13");
    expect(fmtTimes(null)).toBe("—");
    expect(fmtPctChg(6.24)).toBe("+6.2%");
    expect(fmtPctChg(-3)).toBe("−3.0%");
    expect(fmtPctChg(-0.01)).toBe("0.0%");
    expect(fmtPctChg(null)).toBe("—");
  });
});

describe("strikes near the money", () => {
  const rows = FLOW.windows["15m"].rows;

  it("finds the strike step and keeps ATM±5", () => {
    expect(strikeStep(rows.map((r) => r.strike))).toBe(50);
    expect(strikeStep([22500])).toBe(0);
    expect(nearAtm(rows, 22500).map((r) => r.strike)).toEqual([22300, 22350, 22400, 22450, 22500, 22550, 22600]);
    expect(nearAtm(rows, 22500, 1).map((r) => r.strike)).toEqual([22450, 22500, 22550]);
  });

  it("ranks every side by the size of its OI change, unknown changes last", () => {
    const ranked = rankSides(rows, 22500);
    expect(ranked.slice(0, 4).map((s) => `${s.strike}${s.side}`)).toEqual(["22550CE", "22400PE", "22500CE", "22450PE"]);
    expect(ranked.find((s) => s.strike === 22400 && s.side === "PE")?.offset).toBe(-2);
    expect(ranked.some((s) => s.strike === 23000)).toBe(false);
    expect(ranked.length).toBe(13);
    expect(maxAbsOiChg(ranked)).toBe(310_000);
    expect(maxAbsOiChg([])).toBe(1);
  });
});

describe("writers", () => {
  it("totals net call and put OI change", () => {
    const t = writerTotals(FLOW.windows["15m"].rows);
    expect(t).toEqual({ ce: 1_450_000, pe: 405_000, strikes: 8 });
  });

  it("reads the lean in plain words", () => {
    expect(writerLean(100, 400)).toEqual({ lean: "up", text: "put writers adding faster: support below, leans up" });
    expect(writerLean(-300, -50).lean).toBe("up");
    expect(writerLean(-300, -50).text).toBe("call writers covering faster: leans up");
    expect(writerLean(500, 100)).toEqual({ lean: "down", text: "call writers adding faster: resistance above, leans down" });
    expect(writerLean(-10, -400).text).toBe("put writers covering faster: leans down");
    expect(writerLean(100, 110).lean).toBe("flat");
    expect(writerLean(0, 0).text).toBe("no change on either side");
  });

  it("writes the totals line", () => {
    expect(writerLine(420_000, 680_000, "15m")).toBe("Call writers added 4.2L vs put writers added 6.8L in 15 min → put writers adding faster: support below, leans up");
    expect(writerLine(-110_000, 20_000, "5m")).toBe("Call writers removed 1.1L vs put writers added 20.0k in 5 min → call writers covering faster: leans up");
  });

  it("writes the PCR with its 15-minute change", () => {
    expect(pcrText(0.94, -0.06)).toBe("0.94 (−0.06 in 15 min)");
    expect(pcrText(1.1, 0.051)).toBe("1.10 (+0.05 in 15 min)");
    expect(pcrText(1.1, 0)).toBe("1.10 (±0.00 in 15 min)");
    expect(pcrText(1.1, null)).toBe("1.10");
    expect(pcrText(null, 0.1)).toBe("—");
  });
});

describe("events", () => {
  it("lists the newest first and keeps the last n", () => {
    expect(latestEvents(FLOW.events).map((e) => e.kind)).toEqual(["VOLUME_SPIKE", "SHORT_BUILDUP", "OI_WALL"]);
    expect(latestEvents(FLOW.events, 1)).toHaveLength(1);
    const many = Array.from({ length: 40 }, (_, i) => ({ ...FLOW.events[0], at: `2026-10-14T10:${String(i).padStart(2, "0")}:00+05:30` }));
    const last = latestEvents(many);
    expect(last).toHaveLength(30);
    expect(last[0].at).toBe("2026-10-14T10:39:00+05:30");
  });

  it("gives every build-up and event a colour and words", () => {
    expect(KIND_META.LONG_BUILDUP.color).toBe(C.green);
    expect(KIND_META.SHORT_BUILDUP.color).toBe(C.red);
    expect(KIND_META.SHORT_COVERING.label).toBe("Short covering");
    expect(KIND_META.DRY_UP.meaning).toMatch(/premium/i);
    for (const k of Object.values(KIND_META)) expect(k.label.length).toBeGreaterThan(0);
  });
});

describe("volume against normal", () => {
  const baselines = { volumeMedian: { "NIFTY|10:30|ATM": 2_000, "NIFTY|10:30|2": 500, "SENSEX:1030:3+": 40 }, oiChangeP90Pct: { NIFTY: 12 } };

  it("buckets the time of day by 15 minutes", () => {
    expect(bucketLabel(10 * 60 + 42)).toBe("10:30");
    expect(bucketLabel(9 * 60 + 15)).toBe("09:15");
    expect(volumeBaselineKeys("NIFTY", 642, 0)).toContain("NIFTY|10:30|ATM");
    expect(volumeBaselineKeys("NIFTY", 642, -2)).toContain("NIFTY:1030:±2");
  });

  it("looks the median up under any accepted spelling, and nothing when it is missing", () => {
    expect(baselineVolumePerMin(baselines, "NIFTY", 642, 0)).toBe(2_000);
    expect(baselineVolumePerMin(baselines, "NIFTY", 642, -2)).toBe(500);
    expect(baselineVolumePerMin(baselines, "SENSEX", 642, 5)).toBe(40);
    expect(baselineVolumePerMin(baselines, "NIFTY", 642, 1)).toBeNull();
    expect(baselineVolumePerMin({ volumeMedian: {}, oiChangeP90Pct: {} }, "NIFTY", 642, 0)).toBeNull();
  });

  it("uses the history first, then the side's own 15-minute pace", () => {
    expect(volVsNormal({ vol: 10_000, window: "5m", baselinePerMin: 1_000, vol15m: 9_000 })).toEqual({ x: 2, basis: "history" });
    expect(volVsNormal({ vol: 9_000, window: "1m", baselinePerMin: null, vol15m: 45_000 })).toEqual({ x: 3, basis: "pace" });
    expect(volVsNormal({ vol: 45_000, window: "15m", baselinePerMin: null, vol15m: 45_000 })).toBeNull();
    expect(volVsNormal({ vol: null, window: "1m", baselinePerMin: 100, vol15m: 1 })).toBeNull();
  });

  it("flags 15-minute OI changes beyond the measured P90", () => {
    expect(oiP90Pct(baselines, "NIFTY")).toBe(12);
    expect(oiP90Pct(baselines, "SENSEX")).toBeNull();
    expect(unusualOi(-15, "15m", 12)).toBe(true);
    expect(unusualOi(10, "15m", 12)).toBe(false);
    expect(unusualOi(30, "5m", 12)).toBe(false);
    expect(unusualOi(30, "15m", null)).toBe(false);
  });
});

describe("premium and entry times", () => {
  const rows: EntryTimeStats[] = [
    { window: "09:15–09:30 IST", avgPremiumDecayPctPerHour: 14, avgAbsIndexMovePct: 0.3, costPerPointMove: 9, sample: 40 },
    { window: "09:30-11:15", avgPremiumDecayPctPerHour: 4.8, avgAbsIndexMovePct: 0.4, costPerPointMove: 3.1, sample: 40 },
    { window: "11:15 to 14:15", avgPremiumDecayPctPerHour: 3.9, avgAbsIndexMovePct: 0.2, costPerPointMove: 5.5, sample: 40 },
    { window: "nonsense", avgPremiumDecayPctPerHour: 1, avgAbsIndexMovePct: 1, costPerPointMove: 0.1, sample: 0 },
  ];

  it("parses windows and finds the one holding a minute", () => {
    expect(parseWindow("09:45–11:15 IST")).toEqual([585, 675]);
    expect(parseWindow("0945-1115")).toEqual([585, 675]);
    expect(parseWindow("11:15 to 09:00")).toBeNull();
    expect(parseWindow("all day")).toBeNull();
    expect(entryTimeAt(rows, 10 * 60 + 42)?.window).toBe("09:30-11:15");
    expect(entryTimeAt(rows, 15 * 60)).toBeNull();
  });

  it("finds the cheapest window with a sample", () => {
    expect(cheapestEntryTime(rows)?.window).toBe("09:30-11:15");
    expect(cheapestEntryTime([])).toBeNull();
  });

  it("scales the decay meter on the history and says how it compares", () => {
    const m = decayMeter(6.4, 4.8);
    expect(m.fill).toBeCloseTo(6.4 / 9.6, 5);
    expect(m.ratio).toBeCloseTo(1.333, 2);
    expect(m.text).toBe("ATM premium losing 6.4%/hour: faster than the usual 4.8%/hour for this time of day.");
    expect(decayMeter(4.8, 4.8).text).toContain("about the usual");
    expect(decayMeter(2, 4.8).text).toContain("slower than");
    expect(decayMeter(3, null)).toEqual({ fill: 0.5, ratio: null, text: "ATM premium losing 3.0%/hour; no history for this time yet." });
    expect(decayMeter(null, 4.8).fill).toBe(0);
    expect(decayMeter(50, 4.8).fill).toBe(1);
  });
});

describe("polling and freshness", () => {
  it("polls fast only in market hours", () => {
    expect(marketPollMs(istAt("2026-10-14", "10:42"), REFRESH_IMPORTANT_MS)).toBe(REFRESH_IMPORTANT_MS);
    expect(marketPollMs(istAt("2026-10-14", "15:31"), REFRESH_IMPORTANT_MS)).toBe(REFRESH_CLOSED_MS);
    expect(marketPollMs(istAt("2026-10-17", "10:42"), REFRESH_IMPORTANT_MS)).toBe(REFRESH_CLOSED_MS);
  });

  it("calls a reading live, slow or stale from its age", () => {
    expect(freshness(800, 1_000)).toBe("live");
    expect(freshness(5_000, 1_000)).toBe("live");
    expect(freshness(20_000, 1_000)).toBe("slow");
    expect(freshness(31_000, 1_000)).toBe("stale");
    expect(freshness(null, 1_000)).toBe("stale");
    expect(freshness(9 * 60_000, REFRESH_CLOSED_MS)).toBe("live");
  });

  it("calls data older than 2 minutes stale only while the market is open", () => {
    const asOf = Date.parse(FLOW.asOf);
    expect(dataStale(asOf, asOf + 60_000, true)).toBe(false);
    expect(dataStale(asOf, asOf + 180_000, true)).toBe(true);
    expect(dataStale(asOf, asOf + 180_000, false)).toBe(false);
  });
});
