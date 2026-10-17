import { describe, expect, it } from "vitest";
import { dayBlockBootstrap } from "./metrics";
import { blockBootstrap, extremeBucket, fiiDiiLabelsSwapped, INDEX_COLUMNS, longShare, optionsNetDirection, parseCount, parseParticipantOi, rowLabel, runsOf, splitCsvLine, titleDate, trailingRank, wilson } from "./positioning";

// The layout of NSE's file on 8 Oct 2026 (values as published; trailing spaces in two headers as in the file).
const OCT_8_2026 = [
  '""Participant wise Open Interest (no. of contracts) in Equity Derivatives as on Oct 08, 2026"",,,,,,,,,,,,,,',
  "Client Type,Future Index Long,Future Index Short,Future Stock Long,Future Stock Short       ,Option Index Call Long,Option Index Put Long,Option Index Call Short,Option Index Put Short,Option Stock Call Long,Option Stock Put Long,Option Stock Call Short,Option Stock Put Short,Total Long Contracts      ,Total Short Contracts",
  "Client,307664,60271,3430012,176882,4193869,2453187,3783838,3279806,2160215,729782,1145270,1068609,13274729,9514675",
  "DII,47792,11542,284136,4606853,87660,57284,2761,900,10859,43545,336038,32779,531276,4990873",
  "FII,31583,338692,3504994,2895148,737159,1122843,1141437,456760,169574,305913,330052,155092,5872066,5317181",
  "Pro,53159,29693,826033,366292,1365145,1083333,1455797,979181,828297,994878,1357585,817638,5150845,5006187",
  "TOTAL,440198,440198,8045175,8045175,6383833,4716647,6383833,4716647,3168945,2074118,3168945,2074118,24828916,24828916",
].join("\n");

describe("parseParticipantOi", () => {
  it("reads the title date, every category and every column of the 2026 layout", () => {
    const f = parseParticipantOi(OCT_8_2026);
    expect(f.problems).toEqual([]);
    expect(f.asOf).toBe("2026-10-08");
    expect(f.firstHeader).toBe("Client Type");
    expect(f.order).toEqual(["Client", "DII", "FII", "Pro", "TOTAL"]);
    expect(f.rows.FII?.futIdxLong).toBe(31_583);
    expect(f.rows.FII?.futIdxShort).toBe(338_692);
    expect(f.rows.FII?.optIdxPutShort).toBe(456_760);
    expect(f.rows.Client?.futIdxShort).toBe(60_271);
    expect(f.rows.TOTAL?.totalShort).toBe(24_828_916);
  });

  // Synthetic counts in the early-2012 layout (CLIENT_TYPE header, "FII " with a space, FII before DII,
  // "Total"), consistent in every sum; the FII and DII rows carry each other's profiles, as on 2 Jan 2012.
  const HEAD_2012 =
    "CLIENT_TYPE,Future Index Long,Future Index Short,Future Stock Long,Future Stock Short,Option Index Call Long,Option Index Put Long,Option Index Call Short,Option Index Put Short,Option Stock Call Long,Option Stock Put Long,Option Stock Call Short,Option Stock Put Short,Total Long Contracts,Total Short Contracts";
  const EARLY_2012 = [
    '"Participant wise Open Interest (no. of contracts) in Equity Derivatives as on January 02, 2012",,,,,,,,,,,,,,',
    HEAD_2012,
    "Client,1000,900,500,200,400,300,350,450,50,30,40,20,2280,1960",
    "FII ,100,10,40,30,70,50,0,0,5,0,0,0,265,40",
    "DII,200,250,300,600,200,400,220,150,7,5,8,6,1112,1234",
    "Pro,60,200,100,110,180,210,280,360,12,11,26,20,573,996",
    "Total,1360,1360,940,940,850,960,850,960,74,46,74,46,4230,4230",
  ].join("\r\n");

  it("matches columns by name, so the 2012 header and a reordered row list read the same", () => {
    const f = parseParticipantOi(EARLY_2012);
    expect(f.problems).toEqual([]);
    expect(f.asOf).toBe("2012-01-02");
    expect(f.firstHeader).toBe("CLIENT_TYPE");
    expect(f.order).toEqual(["Client", "FII", "DII", "Pro", "Total"]);
    // The parser reports the labels as written; deciding whether they are right is fiiDiiLabelsSwapped's job.
    expect(f.rows.FII?.futIdxLong).toBe(100);
    expect(f.rows.DII?.optIdxCallShort).toBe(220);
    expect(fiiDiiLabelsSwapped(f.rows.FII!, f.rows.DII!)).toBe(true);
    const oct = parseParticipantOi(OCT_8_2026);
    expect(fiiDiiLabelsSwapped(oct.rows.FII!, oct.rows.DII!)).toBe(false);
  });

  it('reads "NA" as no position and quoted Indian-grouped counts with zero decimals', () => {
    // 3 Jan 2012 style: "NA" where a category holds nothing; the TOTAL row confirms it as 0.
    const na = parseParticipantOi(EARLY_2012.replace("FII ,100,10,40,30,70,50,0,0,5,0,0,0,265,40", "FII ,100,10,40,30,70,50,NA,NA,5,NA,NA,NA,265,40"));
    expect(na.problems).toEqual([]);
    expect(na.rows.FII?.optIdxCallShort).toBe(0);
    expect(na.warnings).toContain('5 "NA" cells read as 0');
    // 20 Jan 2012 style: every count quoted as "1,360.00".
    const grouped = EARLY_2012.split("\r\n")
      .map((l, i) => (i < 2 ? l : l.split(",").map((c, j) => (j === 0 ? c : `"${Number(c).toLocaleString("en-IN")}.00"`)).join(",")))
      .join("\r\n");
    const g = parseParticipantOi(grouped);
    expect(g.problems).toEqual([]);
    expect(g.rows.TOTAL?.totalLong).toBe(4230);
    expect(g.rows.Client?.futIdxLong).toBe(1000);
    expect(parseCount("2,38,483.00")).toEqual({ value: 238_483, na: false, fractional: false });
    // 28 Mar 2012 style: stock futures in fractions of a contract (the sums still tie out).
    expect(parseCount("679462.5846")).toEqual({ value: 679_462.5846, na: false, fractional: true });
    expect(Number.isNaN(parseCount("-5").value)).toBe(true);
    expect(Number.isNaN(parseCount("").value)).toBe(true);
  });

  it("scopes the excluding checks to the strict columns: miscomputed Total columns (2016–2017 style) only warn", () => {
    // Every instrument column consistent; the Total Long/Short columns are not (long 4230 → 4000 for Client and TOTAL).
    const badTotals = EARLY_2012.replace("Client,1000,900,500,200,400,300,350,450,50,30,40,20,2280,1960", "Client,1000,900,500,200,400,300,350,450,50,30,40,20,2050,1960").replace(
      "Total,1360,1360,940,940,850,960,850,960,74,46,74,46,4230,4230",
      "Total,1360,1360,940,940,850,960,850,960,74,46,74,46,4000,4230",
    );
    const strictAll = parseParticipantOi(badTotals);
    expect(strictAll.problems).toEqual(["TOTAL totalLong 4000 ≠ totalShort 4230"]);
    const scoped = parseParticipantOi(badTotals, { strict: INDEX_COLUMNS });
    expect(scoped.problems).toEqual([]);
    expect(scoped.warnings).toContain("TOTAL totalLong 4000 ≠ totalShort 4230");
    // An index column that does not tie out is still a problem when scoped.
    const badIndex = badTotals.replace("Pro,60,200,", "Pro,60,300,");
    expect(parseParticipantOi(badIndex, { strict: INDEX_COLUMNS }).problems).toEqual(expect.arrayContaining([expect.stringContaining("futIdxShort: categories add to 1460")]));
  });

  it("reads a file that starts at its header row, and rejects a header merged into the title with shifted rows", () => {
    // 17 Jul 2014 / 13 Jun 2018 style: no title row.
    const noTitle = parseParticipantOi(EARLY_2012.split("\r\n").slice(1).join("\r\n"));
    expect(noTitle.problems).toEqual([]);
    expect(noTitle.asOf).toBeNull();
    expect(noTitle.warnings).toContain("no title row");
    expect(noTitle.rows.Pro?.futIdxShort).toBe(200);
    // 22 Aug 2013 style: the column names follow the title on line 1 and every row label sits one row too high.
    const lines = EARLY_2012.split("\r\n");
    const values = lines.slice(2).map((l) => l.split(",").slice(1).join(","));
    const shifted = [`${lines[0].split(",")[0]},${lines[1].split(",").slice(1).join(",")}`, ...["Client Type", "Client", "DII", "FII", "Pro"].map((label, i) => `${label},${values[i]}`), "TOTAL,,,,,,,,,,,,,,"].join("\r\n");
    expect(parseParticipantOi(shifted).problems.length).toBeGreaterThan(0);
  });

  it("reads a file whose lines end in a bare carriage return (4 Oct 2017 style)", () => {
    const cr = parseParticipantOi(EARLY_2012.split("\r\n").join("\r"));
    expect(cr.problems).toEqual([]);
    expect(cr.rows.TOTAL?.optIdxPutShort).toBe(960);
  });

  it("splits CSV lines with quoted cells", () => {
    expect(splitCsvLine('Client,"2,38,483.00",5')).toEqual(["Client", "2,38,483.00", "5"]);
    expect(splitCsvLine('"Future Stock Short\t",x')).toEqual(["Future Stock Short\t", "x"]);
    expect(splitCsvLine('a,"say ""hi""",b')).toEqual(["a", 'say "hi"', "b"]);
  });

  it("flags categories that do not add up, unbalanced index futures, missing rows and bad numbers", () => {
    // Off by one contract (as in some 2026 files): a rounding warning, not a problem.
    const rounding = parseParticipantOi(OCT_8_2026.replace("FII,31583,", "FII,31584,"));
    expect(rounding.problems).toEqual([]);
    expect(rounding.warnings).toEqual(expect.arrayContaining([expect.stringContaining("futIdxLong: categories add to 440199")]));
    const broken = parseParticipantOi(OCT_8_2026.replace("FII,31583,", "FII,41583,"));
    expect(broken.problems).toEqual(expect.arrayContaining([expect.stringContaining("futIdxLong: categories add to 450198")]));
    // TOTAL calls long ≠ calls short (and the categories still add up): every contract has two sides.
    const unbalanced = OCT_8_2026.replace("Pro,53159,29693,826033,366292,1365145,", "Pro,53159,29693,826033,366292,1465145,").replace("TOTAL,440198,440198,8045175,8045175,6383833,", "TOTAL,440198,440198,8045175,8045175,6483833,");
    expect(parseParticipantOi(unbalanced).problems).toEqual(expect.arrayContaining([expect.stringContaining("TOTAL optIdxCallLong 6483833 ≠ optIdxCallShort 6383833")]));
    const noPro = OCT_8_2026.split("\n").filter((l) => !l.startsWith("Pro")).join("\n");
    expect(parseParticipantOi(noPro).problems).toContain("missing row Pro");
    const bad = OCT_8_2026.replace("DII,47792,", "DII,-47792,");
    expect(parseParticipantOi(bad).problems).toContain("non-numeric value in row DII");
    expect(parseParticipantOi("<!DOCTYPE html><html></html>").problems.length).toBeGreaterThan(0);
  });

  it("reads row labels and title dates in their written variants", () => {
    expect(rowLabel(" FII ")).toBe("FII");
    expect(rowLabel("FPI")).toBe("FII");
    expect(rowLabel("Total")).toBe("TOTAL");
    expect(rowLabel("Prop")).toBeNull();
    expect(titleDate("... as on Jul 01, 2014")).toBe("2014-07-01");
    expect(titleDate("... as on September 9, 2013")).toBe("2013-09-09");
    expect(titleDate('""... as on Jan 06,2020""')).toBe("2020-01-06");
    expect(titleDate("... as on Jan 02 2020,,,")).toBe("2020-01-02");
    expect(titleDate('... as on Mar 30,"2021""""",,,')).toBe("2021-03-30");
    expect(titleDate("no date here")).toBeNull();
  });
});

describe("positioning ratios", () => {
  it("computes the long share and the options net direction", () => {
    expect(longShare(31_583, 338_692)).toBeCloseTo(0.0853, 4);
    expect(longShare(0, 0)).toBeNull();
    // 8 Oct 2026 FII index options: (737,159 − 1,141,437) − (1,122,843 − 456,760) over the four.
    const r = { optIdxCallLong: 737_159, optIdxCallShort: 1_141_437, optIdxPutLong: 1_122_843, optIdxPutShort: 456_760 };
    expect(optionsNetDirection(r)).toBeCloseTo((737_159 - 1_141_437 - (1_122_843 - 456_760)) / 3_458_199, 12);
    expect(optionsNetDirection({ optIdxCallLong: 10, optIdxCallShort: 0, optIdxPutLong: 0, optIdxPutShort: 0 })).toBe(1);
    expect(optionsNetDirection({ optIdxCallLong: 0, optIdxCallShort: 0, optIdxPutLong: 10, optIdxPutShort: 0 })).toBe(-1);
    expect(optionsNetDirection({ optIdxCallLong: 0, optIdxCallShort: 0, optIdxPutLong: 0, optIdxPutShort: 0 })).toBeNull();
  });
});

describe("trailingRank and extremeBucket", () => {
  it("ranks each value among the last `window` readings including itself, skipping nulls", () => {
    const r = trailingRank([1, 2, null, 3, 0, 5], 3);
    expect(r[0]).toBeNull();
    expect(r[1]).toBeNull();
    expect(r[2]).toBeNull();
    expect(r[3]).toBeCloseTo(2.5 / 3, 12); // window 1, 2, 3: two below, itself half
    expect(r[4]).toBeCloseTo(0.5 / 3, 12); // window 2, 3, 0
    expect(r[5]).toBeCloseTo(2.5 / 3, 12); // window 3, 0, 5
  });

  it("never looks ahead: a later value cannot change an earlier rank", () => {
    const a = trailingRank([3, 1, 4, 1, 5, 9, 2, 6], 4);
    const b = trailingRank([3, 1, 4, 1, 5, 9, 2, 6, -100, 100], 4);
    expect(b.slice(0, 8)).toEqual(a);
  });

  it("buckets terciles, quartiles and quintiles", () => {
    expect(extremeBucket(0.2, 3)).toBe(-1);
    expect(extremeBucket(0.5, 3)).toBe(0);
    expect(extremeBucket(0.7, 3)).toBe(1);
    expect(extremeBucket(0.3, 4)).toBe(0);
    expect(extremeBucket(0.24, 4)).toBe(-1);
    expect(extremeBucket(0.81, 5)).toBe(1);
    expect(extremeBucket(0.79, 5)).toBe(0);
  });
});

describe("blockBootstrap", () => {
  it("with blocks of one session matches the day-block bootstrap's estimates and is seeded", () => {
    const x = [10, -5, 0, 3, -2, 8, 0, -1, 4, 6];
    const trade = x.map((v) => v !== 0);
    const a = blockBootstrap(x, trade, { block: 1, resamples: 5_000, seed: 3 });
    const b = blockBootstrap(x, trade, { block: 1, resamples: 5_000, seed: 3 });
    expect(a).toEqual(b);
    expect(a.trades).toBe(8);
    expect(a.perTrade.estimate).toBeCloseTo(23 / 8, 12);
    expect(a.perSession.estimate).toBeCloseTo(2.3, 12);
    const d = dayBlockBootstrap(x.map((v, i) => ({ day: String(i).padStart(2, "0"), pnls: trade[i] ? [v] : [] })), { resamples: 5_000, seed: 3 });
    expect(a.perSession.se).toBeCloseTo(d.perSession.se, 0);
    expect(a.perSession.lo).toBeLessThan(a.perSession.estimate);
    expect(a.perSession.hi).toBeGreaterThan(a.perSession.estimate);
  });

  it("widens the interval of a strongly autocorrelated series as the block grows", () => {
    // Overlapping 20-session sums of an i.i.d. series: neighbours share 19 of 20 terms.
    const rnd = (() => {
      let s = 1;
      return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
    })();
    const e = Array.from({ length: 2_020 }, rnd);
    const x = Array.from({ length: 2_000 }, (_, i) => e.slice(i, i + 20).reduce((a, b) => a + b, 0));
    const trade = x.map(() => true);
    const one = blockBootstrap(x, trade, { block: 1, resamples: 2_000, seed: 7 });
    const forty = blockBootstrap(x, trade, { block: 40, resamples: 2_000, seed: 7 });
    expect(forty.perTrade.se).toBeGreaterThan(3 * one.perTrade.se);
  });

  it("gives p near 1 for a series that is always negative and near 0 for one always positive", () => {
    const neg = blockBootstrap([-1, -2, -3, -1, -2], [true, true, true, true, true], { block: 2, resamples: 999 });
    const pos = blockBootstrap([1, 2, 3, 1, 2], [true, true, true, true, true], { block: 2, resamples: 999 });
    expect(neg.perTrade.p).toBe(1);
    expect(pos.perTrade.p).toBeCloseTo(1 / 1000, 12);
  });
});

describe("runsOf and wilson", () => {
  it("finds maximal runs of true", () => {
    expect(runsOf([true, true, false, true, false, false, true, true, true])).toEqual([
      { start: 0, end: 1, length: 2 },
      { start: 3, end: 3, length: 1 },
      { start: 6, end: 8, length: 3 },
    ]);
    expect(runsOf([])).toEqual([]);
    expect(runsOf([false, false])).toEqual([]);
  });

  it("matches the Wilson interval's textbook values", () => {
    const w = wilson(8, 15);
    // 8 of 15: p = 0.533, 95% Wilson interval ≈ [0.301, 0.752].
    expect(w.lo).toBeCloseTo(0.3009, 3);
    expect(w.hi).toBeCloseTo(0.7523, 3);
    expect(wilson(0, 10).lo).toBe(0);
    expect(Number.isNaN(wilson(0, 0).lo)).toBe(true);
  });
});
