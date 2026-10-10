import { describe, expect, it } from "vitest";
import { computeCharges } from "../broker/charges";
import { addDays, istAt, weekdayOf } from "../clock";
import type { ExpiryKind, QuoteRow } from "../market/quoteRecorder";
import type { IndexId, OptionType } from "../types";
import {
  atmStraddle,
  buildQuoteReport,
  chainsFor,
  clusteredMean,
  entryQuote,
  entrySnapshots,
  groupQuotes,
  minuteLastTrade,
  openingWindow,
  spreadsBySlot,
  straddleCharges,
  straddleSale,
  variantStats,
} from "./quoteReport";

const DAY = "2026-10-12";
const T = (time: string, sec = 0, date = DAY) => istAt(date, time) + sec * 1000;

interface Leg {
  strike: number;
  type: OptionType;
  bid: number | null;
  ask: number | null;
  ltp: number | null;
  /** Seconds after the snapshot's minute for the last trade (absolute ms when `lttMs`). */
  lttMs?: number | null;
}

function snap(o: { ms: number; slot?: string; index?: IndexId; kind?: ExpiryKind; expiry?: string; spot: number; lot?: number; legs: Leg[] }): QuoteRow[] {
  const index = o.index ?? "NIFTY";
  const expiry = o.expiry ?? "2026-10-13";
  return o.legs.map((l, i) => ({
    snapshotMs: o.ms,
    slot: o.slot ?? "open",
    indexId: index,
    expiry,
    expiryKind: o.kind ?? "next",
    strike: l.strike,
    optionType: l.type,
    tradingSymbol: `${index}${expiry}${l.strike}${l.type}`,
    lotSize: o.lot ?? (index === "NIFTY" ? 65 : 20),
    bid: l.bid,
    ask: l.ask,
    bidQty: l.bid === null ? null : 650,
    askQty: l.ask === null ? null : 650,
    ltp: l.ltp,
    lastTradeMs: l.lttMs ?? null,
    volume: 1000,
    oi: 100_000,
    depth: null,
    spot: o.spot,
    fetchedMs: o.ms + 300 * (i + 1),
    source: "groww:live-data/quote",
    schemaV: 1,
  }));
}

const straddle = (strike: number, ce: [number | null, number | null, number | null, number | null], pe: [number | null, number | null, number | null, number | null]): Leg[] => [
  { strike, type: "CE", bid: ce[0], ask: ce[1], ltp: ce[2], lttMs: ce[3] },
  { strike, type: "PE", bid: pe[0], ask: pe[1], ltp: pe[2], lttMs: pe[3] },
];

/** One NIFTY session (convention B only): the open window, 09:20, 09:30, 11:15, 15:00 and 15:20. */
function niftySession(date = DAY): QuoteRow[] {
  const t = (time: string, sec = 0) => T(time, sec, date);
  return [
    // Before 09:15:15: not an entry.
    ...snap({ ms: t("09:15", 10), spot: 24_505, legs: straddle(24_500, [99, 100, 99.5, t("09:15", 9)], [91, 92, 91.5, t("09:15", 8)]) }),
    // 09:15:20, spot exactly between two strikes: the lower one is at the money.
    ...snap({ ms: t("09:15", 20), spot: 24_525, legs: [...straddle(24_500, [100, 101, 100.5, t("09:15", 19.5)], [90, 91, 90.6, t("09:15", 18)]), ...straddle(24_550, [76, 77, 76.5, t("09:15", 19)], [115, 116, 115.5, t("09:15", 17)])] }),
    ...snap({ ms: t("09:15", 50), spot: 24_520, legs: straddle(24_500, [100.8, 101.6, 101, t("09:15", 49)], [89.6, 90.4, 90, t("09:15", 48)]) }),
    // After the minute: the put has not traded since 09:15:48 (so that is its 09:15 close, exactly).
    ...snap({ ms: t("09:16", 20), spot: 24_515, legs: straddle(24_500, [101.2, 102, 101.5, t("09:16", 19)], [89.7, 90.5, 90, t("09:15", 48)]) }),
    ...snap({ ms: t("09:20", 10), spot: 24_505, legs: straddle(24_500, [98, 98.8, 98.4, t("09:20", 9)], [92, 92.8, 92.5, t("09:20", 8)]) }),
    ...snap({ ms: t("09:30", 5), spot: 24_498, legs: straddle(24_500, [97, 97.8, 97.5, t("09:30", 4)], [91, 91.8, 91.2, t("09:30", 3)]) }),
    ...snap({ ms: t("11:15", 3), slot: "11:15", spot: 24_480, legs: straddle(24_500, [80, 80.8, 80.5, t("11:15", 2)], [85, 85.8, 85.2, t("11:15", 1)]) }),
    ...snap({ ms: t("15:00", 5), slot: "15:00", spot: 24_490, legs: straddle(24_500, [59.5, 60, 59.8, t("15:00", 4)], [69, 70, 69.5, t("15:00", 3)]) }),
    ...snap({ ms: t("15:20", 5), slot: "15:20", spot: 24_495, legs: straddle(24_500, [50, 50.5, 50.2, t("15:20", 4)], [60, 60.6, 60.3, t("15:20", 3)]) }),
  ];
}

describe("the at-the-money straddle and the minute's last trade", () => {
  const [s] = groupQuotes(niftySession());
  const chains = chainsFor(s, "B");

  it("picks the strike nearest the spot with two-sided legs; a tie goes to the lower strike", () => {
    const b = chains.find((c) => c.snapshotMs === T("09:15", 20))!;
    expect(atmStraddle(b)).toMatchObject({ strike: 24_500, bid: 190, ask: 192 });
    expect(atmStraddle(b)!.spreadPct).toBeCloseTo((2 / 191) * 100, 10);
    // Without a bid on the 24,500 call, the next strike with two-sided legs is used.
    const [s2] = groupQuotes(niftySession().map((r) => (r.snapshotMs === T("09:15", 20) && r.strike === 24_500 && r.optionType === "CE" ? { ...r, bid: null } : r)));
    expect(atmStraddle(chainsFor(s2, "B").find((c) => c.snapshotMs === T("09:15", 20))!)?.strike).toBe(24_550);
  });

  it("finds the minute's last trade from the last-trade times, and says when it is certainly the last", () => {
    const ce = minuteLastTrade(s.bySymbol.get("NIFTY2026-10-1324500CE")!, T("09:15"));
    expect(ce).toEqual({ price: 101, tradeMs: T("09:15", 49), exact: false }); // the 09:16:20 quote shows a newer trade
    const pe = minuteLastTrade(s.bySymbol.get("NIFTY2026-10-1324500PE")!, T("09:15"));
    expect(pe).toEqual({ price: 90, tradeMs: T("09:15", 48), exact: true });
    expect(minuteLastTrade(s.bySymbol.get("NIFTY2026-10-1324500PE")!, T("09:17"))).toBeNull();
    // Without last-trade times: the LTP of the minute's last quote, never exact.
    const noTimes = s.bySymbol.get("NIFTY2026-10-1324500CE")!.map((r) => ({ ...r, lastTradeMs: null }));
    expect(minuteLastTrade(noTimes, T("09:15"))).toEqual({ price: 101, tradeMs: null, exact: false });
  });

  it("selects the entry snapshots: 09:15:15-09:16:30, the first of 09:20 and 09:30, the 11:15 slot", () => {
    expect(entrySnapshots(chains, "09:15").map((c) => c.snapshotMs)).toEqual([T("09:15", 20), T("09:15", 50), T("09:16", 20)]);
    expect(entrySnapshots(chains, "09:20").map((c) => c.snapshotMs)).toEqual([T("09:20", 10)]);
    expect(entrySnapshots(chains, "09:30").map((c) => c.snapshotMs)).toEqual([T("09:30", 5)]);
    expect(entrySnapshots(chains, "11:15").map((c) => c.snapshotMs)).toEqual([T("11:15", 3)]);
  });
});

describe("selling at the bids vs the minute's last trade", () => {
  const [s] = groupQuotes(niftySession());

  it("compares the first opening snapshot's bids with the 09:15 minute's last trades", () => {
    const q = entryQuote(s, entrySnapshots(chainsFor(s, "B"), "09:15")[0], "09:15")!;
    expect(q).toMatchObject({ strike: 24_500, spot: 24_525, bid: 190, minuteLast: 191, minuteExact: false });
    expect(q.ltp).toBeCloseTo(191.1, 10);
    expect(q.slipVsMinutePct).toBeCloseTo(((190 - 191) / 191) * 100, 10);
    expect(q.slipVsLtpPct).toBeCloseTo(((190 - 191.1) / 191.1) * 100, 10);
    const w = openingWindow(s, "B");
    expect(w.quotes.map((x) => x.bid)).toEqual([expect.closeTo(190, 10), expect.closeTo(190.4, 10), expect.closeTo(190.9, 10)]);
    expect(w.meanSlipVsMinutePct).toBeCloseTo(((190 - 191) / 191 + (190.4 - 191) / 191 + (190.9 - 191) / 191) * (100 / 3), 10);
  });

  it("nets the seller's rupees per lot after the dated charges, at the touch and at the last trades", () => {
    // Schedule from 1 Apr 2026: ₹20 + STT 0.15% + NSE 0.03503% + SEBI + IPFT + 18% GST; a ₹100 x 65 sale costs ₹36.08.
    expect(computeCharges("SELL", 100, 65, "NSE", DAY).total).toBe(36.08);
    const sale = straddleSale(s, "B", "09:15", "15:00")!;
    const charges = straddleCharges("SELL", 100, 90, 65, "NSE", DAY) + straddleCharges("BUY", 60, 70, 65, "NSE", DAY);
    expect(charges).toBeGreaterThan(110);
    expect(charges).toBeLessThan(150);
    expect(sale).toMatchObject({ strike: 24_500, lot: 65, sellBid: 190, sellMinuteLast: 191, buyAsk: 130, premium: 190 * 65 });
    expect(sale.netTouch).toBeCloseTo(65 * (190 - 130) - charges, 2);
    const chargesLast = straddleCharges("SELL", 101, 90, 65, "NSE", DAY) + straddleCharges("BUY", 59.8, 69.5, 65, "NSE", DAY);
    expect(sale.netLast).toBeCloseTo(65 * (191 - 129.3) - chargesLast, 2);
    expect(sale.exitSlipPct).toBeCloseTo(((130 - 129.3) / 129.3) * 100, 10);
    expect(sale.entrySlipPct).toBeCloseTo(((190 - 191) / 191) * 100, 10);
    // The same at 09:20 against the 09:20 minute's last trades, bought back at 15:20.
    const late = straddleSale(s, "B", "09:20", "15:20")!;
    expect(late.entrySlipPct).toBeCloseTo(((190 - 190.9) / 190.9) * 100, 10);
    expect(late.buyAsk).toBeCloseTo(111.1, 10);
  });

  it("has no sale without the exit snapshot of the same strike", () => {
    const [s2] = groupQuotes(niftySession().filter((r) => r.slot !== "15:00"));
    expect(straddleSale(s2, "B", "09:15", "15:00")).toBeNull();
    expect(straddleSale(s2, "B", "09:15", "15:20")).not.toBeNull();
  });

  it("uses the contract expiring today for convention A, and the next one for B", () => {
    const exp = "2026-10-13";
    const rows = [
      ...niftySession(exp).map((r) => ({ ...r, expiry: "2026-10-19", tradingSymbol: r.tradingSymbol.replace("2026-10-13", "2026-10-19") })),
      ...snap({ ms: T("09:15", 20, exp), kind: "expiring", expiry: exp, spot: 24_525, legs: straddle(24_500, [40, 41, 40.5, T("09:15", 19, exp)], [35, 36, 35.5, T("09:15", 18, exp)]) }),
      ...snap({ ms: T("15:00", 5, exp), slot: "15:00", kind: "expiring", expiry: exp, spot: 24_490, legs: straddle(24_500, [2, 2.5, 2.2, T("15:00", 4, exp)], [10, 11, 10.5, T("15:00", 3, exp)]) }),
    ];
    const [s3] = groupQuotes(rows);
    expect(straddleSale(s3, "A", "09:15", "15:00")).toMatchObject({ expiry: exp, sellBid: 75, buyAsk: 13.5 });
    expect(straddleSale(s3, "B", "09:15", "15:00")).toMatchObject({ expiry: "2026-10-19", sellBid: 190 });
  });

  it("leaves manual snapshots out", () => {
    const manual = snap({ ms: T("12:00"), slot: "manual", spot: 24_500, legs: straddle(24_500, [1, 2, 1.5, null], [1, 2, 1.5, null]) });
    expect(groupQuotes([...niftySession(), ...manual])[0].byKind.next.map((c) => c.slot)).not.toContain("manual");
  });
});

describe("spreads by slot", () => {
  it("buckets the open window by minute and the rest by slot", () => {
    const stats = spreadsBySlot(groupQuotes(niftySession()));
    expect(stats.map((x) => x.bucket)).toEqual(["09:15", "09:16", "09:20", "09:30", "11:15", "15:00", "15:20"]);
    const first = stats[0];
    expect(first.n).toBe(3); // 09:15:10, 09:15:20, 09:15:50
    expect(first.median).toBeCloseTo((2 / 191) * 100, 10);
    expect(stats.find((x) => x.bucket === "15:00")!.median).toBeCloseTo((1.5 / 129.25) * 100, 10);
  });
});

describe("statistics", () => {
  /** n weekday sessions from 12 Oct 2026 with a 09:15:20 sale and a 15:00 buy-back; `edge(i)` rupees per unit before charges. */
  function sessions(n: number, edge: (i: number) => number): QuoteRow[] {
    const out: QuoteRow[] = [];
    let d = DAY;
    for (let i = 0; i < n; i++) {
      while (weekdayOf(d) >= 6) d = addDays(d, 1);
      const e = edge(i);
      out.push(
        ...snap({ ms: T("09:15", 20, d), spot: 24_500, legs: straddle(24_500, [100, 100.5, 100.2, T("09:15", 19, d)], [100, 100.5, 100.3, T("09:15", 18, d)]) }),
        ...snap({ ms: T("15:00", 5, d), slot: "15:00", spot: 24_500, legs: straddle(24_500, [99.5 - e / 2, 100 - e / 2, 99.8 - e / 2, T("15:00", 4, d)], [99.5 - e / 2, 100 - e / 2, 99.8 - e / 2, T("15:00", 3, d)]) }),
      );
      d = addDays(d, 1);
    }
    return out;
  }
  const opts = { nTrials: 10, srVariance: null, resamples: 400, confirmResamples: 800, seed: 7 };

  it("says there are not enough sessions before 60", () => {
    const r = buildQuoteReport(sessions(59, () => 20), opts);
    expect(r.sessions).toHaveLength(59);
    expect(r.enoughSessions).toBe(false);
    expect(r.stats).toBeNull();
  });

  it("runs the §12 bar from 60 sessions: a steady edge is still INSUFFICIENT (60 < 180 trades); a loss FAILS", () => {
    const good = buildQuoteReport(sessions(60, (i) => 20 + (i % 5)), opts);
    expect(good.enoughSessions).toBe(true);
    const v = good.stats!.find((x) => x.variant === "NIFTY B 09:15 -> 15:00")!;
    expect(v.trades).toBe(60);
    expect(v.boot.perTrade.lo).toBeGreaterThan(0);
    expect(v.boot.resamples).toBe(800); // rerun with more resamples once both lower bounds are above zero
    expect(v.criteria.map((c) => [c.name, c.verdict])).toEqual([
      ["≥ 180 trades", "INSUFFICIENT"],
      ["placebo gap ≥ 2 SE", "N/A"],
      ["day-block 95% CI above zero (per trade and per session)", "PASS"],
      ["profit factor ≥ 1.3", "PASS"],
      ["net > 0 in every year with ≥ 20 trades", "PASS"],
      ["±20% robustness", "N/A"],
      ["Bonferroni and deflated Sharpe ≥ 0.95", "PASS"],
      ["last 40% of sessions: mean > 0, CI above zero, PF ≥ 1.3", "PASS"],
    ]);
    expect(v.verdict).toBe("INSUFFICIENT");
    expect(v.oos.sessions).toBe(24);
    // Variants without trades (no 09:20 snapshot, no 15:20 slot) fail the CI.
    expect(good.stats!.find((x) => x.variant === "NIFTY B 09:20 -> 15:00")).toMatchObject({ trades: 0, verdict: "FAIL" });

    const bad = buildQuoteReport(sessions(60, (i) => -5 + (i % 3)), opts);
    expect(bad.stats!.find((x) => x.variant === "NIFTY B 09:15 -> 15:00")!.verdict).toBe("FAIL");
  });

  it("clusters by day: the same day's observations move together", () => {
    const c = clusteredMean(
      [
        { date: "2026-10-12", value: -1 },
        { date: "2026-10-12", value: -1 },
        { date: "2026-10-13", value: 1 },
      ],
      { resamples: 500 },
    )!;
    expect(c).toMatchObject({ n: 3, days: 2, median: -1 });
    expect(c.mean).toBeCloseTo(-1 / 3, 10);
    expect(clusteredMean([])).toBeNull();
    // Per-session P&L with the days without a trade counted as zero.
    const v = variantStats("x", [], ["2026-10-12", "2026-10-13"], { nTrials: 1, srVariance: null, resamples: 100 });
    expect(v).toMatchObject({ trades: 0, sessions: 2, verdict: "FAIL" });
  });
});
