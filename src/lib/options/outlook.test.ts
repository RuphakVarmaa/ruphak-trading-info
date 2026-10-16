import { describe, expect, it } from "vitest";
import type { IndexId, OptionChainView, OptionSideView, ScheduledEventView } from "@/engine/api-types";
import { defaultCalendar } from "@/engine/calendar/calendar";
import { buildOptionChainView, parseUpstoxChain } from "@/engine/market/upstoxChain";
import { NIFTY_CHAIN_SAMPLE, SENSEX_CHAIN_SAMPLE } from "@/engine/market/upstoxChain.fixture";
import { buildMockChain } from "@/lib/engine/mockChain";
import { DAY_MS } from "@/lib/ist";
import {
  atmIv,
  buildOutlook,
  dayMonth,
  daysToExpiry,
  expiryCloseMs,
  expiryOutlook,
  headlineExpiry,
  monthlyExpiries,
  oiChangeTotals,
  outlookEvents,
  outlookExpiries,
  outlookHeadline,
  sessionsLeft,
  sidePrice,
  straddleAt,
  topOi,
  weekdayShort,
  type ChainReading,
  type ExpiryContext,
} from "./outlook";

const ist = (s: string) => Date.parse(`${s}+05:30`);
const cal = defaultCalendar;

const side = (p: Partial<OptionSideView>): OptionSideView => ({
  instrumentKey: "NSE_FO|1",
  ltp: null,
  close: null,
  change: null,
  changePct: null,
  bid: null,
  ask: null,
  bidQty: null,
  askQty: null,
  volume: null,
  oi: null,
  prevOi: null,
  oiChange: null,
  iv: null,
  delta: null,
  gamma: null,
  theta: null,
  vega: null,
  pop: null,
  ...p,
});

const ctx = (nowMs: number, index: IndexId = "NIFTY", events: ExpiryContext["events"] = []): ExpiryContext => ({
  nowMs,
  index,
  calendar: cal,
  monthly: false,
  beyondHorizon: false,
  events,
  eventsUntilMs: nowMs + 720 * 3_600_000,
});

const ev = (id: string, kind: ScheduledEventView["kind"], at: string, indices: IndexId[] = ["NIFTY", "SENSEX"]): ScheduledEventView => ({
  id,
  title: id,
  kind,
  at: `${at}+05:30`,
  impact: "HIGH",
  approx: false,
  blackoutStart: null,
  blackoutEnd: null,
  indices,
});

describe("prices", () => {
  it("uses the bid/ask mid when the spread is tight, else the last trade", () => {
    expect(sidePrice(side({ bid: 100, ask: 101, ltp: 99 }))).toEqual({ price: 100.5, basis: "mid" });
    // 10 wide on a 105 mid is 9.5%: too wide, so the LTP.
    expect(sidePrice(side({ bid: 100, ask: 110, ltp: 104 }))).toEqual({ price: 104, basis: "ltp" });
    expect(sidePrice(side({ bid: 100, ask: 110, ltp: 104 }), 10)).toEqual({ price: 105, basis: "mid" });
    // After hours Upstox often reports no bid or ask.
    expect(sidePrice(side({ bid: null, ask: 50, ltp: 48 }))).toEqual({ price: 48, basis: "ltp" });
    expect(sidePrice(side({ bid: null, ask: null, ltp: null }))).toBeNull();
    expect(sidePrice(side({ bid: 100, ask: 130, ltp: null }))).toBeNull();
    expect(sidePrice(null)).toBeNull();
  });

  it("prices the straddle only when both sides have a price, and says how", () => {
    const row = { strike: 100, ce: side({ bid: 10, ask: 10.2 }), pe: side({ ltp: 9 }) };
    expect(straddleAt(row)).toEqual({ ce: 10.1, pe: 9, total: 19.1, basis: "mixed" });
    expect(straddleAt({ strike: 100, ce: side({ ltp: 5 }), pe: side({ ltp: 6 }) })?.basis).toBe("ltp");
    expect(straddleAt({ strike: 100, ce: side({ ltp: 5 }), pe: null })).toBeNull();
    expect(straddleAt(undefined)).toBeNull();
  });

  it("averages the call and put IV, or takes the one reported", () => {
    expect(atmIv({ strike: 1, ce: side({ iv: 12 }), pe: side({ iv: 14 }) })).toBe(13);
    expect(atmIv({ strike: 1, ce: side({ iv: null }), pe: side({ iv: 14 }) })).toBe(14);
    expect(atmIv({ strike: 1, ce: null, pe: null })).toBeNull();
  });

  it("ranks OI walls, lower strike first on a tie, skipping strikes without OI", () => {
    const rows = [
      { strike: 100, ce: side({ oi: 50 }), pe: side({ oi: 0 }) },
      { strike: 110, ce: side({ oi: 80 }), pe: side({ oi: 30 }) },
      { strike: 120, ce: side({ oi: 50 }), pe: side({ oi: null }) },
      { strike: 130, ce: side({ oi: 10 }), pe: null },
    ];
    expect(topOi(rows, "ce")).toEqual([
      { strike: 110, oi: 80 },
      { strike: 100, oi: 50 },
      { strike: 120, oi: 50 },
    ]);
    expect(topOi(rows, "pe")).toEqual([{ strike: 110, oi: 30 }]);
    expect(topOi(rows, "ce", 1)).toEqual([{ strike: 110, oi: 80 }]);
  });

  it("nets the OI change per side, null when none is reported", () => {
    const rows = [
      { strike: 100, ce: side({ oiChange: 500 }), pe: side({ oiChange: -200 }) },
      { strike: 110, ce: side({ oiChange: -100 }), pe: side({ oiChange: null }) },
    ];
    expect(oiChangeTotals(rows)).toEqual({ ce: 400, pe: -200 });
    expect(oiChangeTotals([{ strike: 1, ce: side({}), pe: null }])).toEqual({ ce: null, pe: null });
  });
});

describe("expiries and the calendar", () => {
  const NIFTY_LISTED = ["2026-10-19", "2026-10-27", "2026-11-03", "2026-11-09", "2026-11-17", "2026-11-23", "2026-12-29", "2027-01-25"];
  const SENSEX_LISTED = ["2026-10-15", "2026-10-22", "2026-10-29", "2026-11-05", "2026-11-12", "2026-11-26", "2026-12-31"];

  it("flags each month's last listed expiry when a later month is listed, else asks the calendar", () => {
    expect([...monthlyExpiries(NIFTY_LISTED, "NIFTY", cal)]).toEqual(["2026-10-27", "2026-11-23", "2026-12-29", "2027-01-25"]);
    expect([...monthlyExpiries(SENSEX_LISTED, "SENSEX", cal)]).toEqual(["2026-10-29", "2026-11-26", "2026-12-31"]);
    // The mock lists four weeklies only: 9 Nov is not November's last (the calendar's next one is 17 Nov).
    expect([...monthlyExpiries(["2026-10-19", "2026-10-27", "2026-11-03", "2026-11-09"], "NIFTY", cal)]).toEqual(["2026-10-27"]);
    // Cross-check with the calendar: the week after each monthly is in the next month.
    for (const e of ["2026-10-27", "2026-11-23", "2026-12-29"]) expect(cal.followingExpiry("NIFTY", e).slice(0, 7)).not.toBe(e.slice(0, 7));
  });

  it("covers the listed expiries up to 30 days ahead, today's until 15:30", () => {
    expect(outlookExpiries(NIFTY_LISTED, ist("2026-10-15T10:00:00"), "NIFTY", cal).map((e) => e.expiry)).toEqual(["2026-10-19", "2026-10-27", "2026-11-03", "2026-11-09"]);
    // The horizon's last day is included.
    expect(outlookExpiries(NIFTY_LISTED, ist("2026-10-18T10:00:00"), "NIFTY", cal).map((e) => e.expiry)).toContain("2026-11-17");
    expect(outlookExpiries(SENSEX_LISTED, ist("2026-10-15T10:00:00"), "SENSEX", cal)[0].expiry).toBe("2026-10-15");
    expect(outlookExpiries(SENSEX_LISTED, ist("2026-10-15T16:00:00"), "SENSEX", cal)[0].expiry).toBe("2026-10-22");
    const rows = outlookExpiries(NIFTY_LISTED, ist("2026-10-15T10:00:00"), "NIFTY", cal);
    expect(rows.filter((r) => r.monthly).map((r) => r.expiry)).toEqual(["2026-10-27"]);
    expect(rows.every((r) => !r.beyondHorizon)).toBe(true);
    expect(outlookExpiries([], ist("2026-10-15T10:00:00"), "NIFTY", cal)).toEqual([]);
  });

  it("adds the first monthly past the horizon only when none falls inside it", () => {
    const listed = ["2026-12-01", "2026-12-08", "2026-12-15", "2026-12-22", "2026-12-29", "2027-01-25"];
    const rows = outlookExpiries(listed, ist("2026-11-25T10:00:00"), "NIFTY", cal);
    expect(rows.map((r) => r.expiry)).toEqual(["2026-12-01", "2026-12-08", "2026-12-15", "2026-12-22", "2026-12-29"]);
    expect(rows[4]).toEqual({ expiry: "2026-12-29", monthly: true, beyondHorizon: true });
  });

  it("counts calendar days and the sessions left, today's while it is open, holidays skipped", () => {
    expect(daysToExpiry(ist("2026-10-15T10:00:00"), "2026-10-19")).toBe(4);
    expect(daysToExpiry(ist("2026-10-19T10:00:00"), "2026-10-19")).toBe(0);
    // Thu 15 (still open), Fri 16, Mon 19.
    expect(sessionsLeft(ist("2026-10-15T10:00:00"), "2026-10-19", cal)).toBe(3);
    expect(sessionsLeft(ist("2026-10-15T16:00:00"), "2026-10-19", cal)).toBe(2);
    expect(sessionsLeft(ist("2026-10-19T10:00:00"), "2026-10-19", cal)).toBe(1);
    expect(sessionsLeft(ist("2026-10-19T16:00:00"), "2026-10-19", cal)).toBe(0);
    // Tue 10 Nov is a holiday (Diwali Balipratipada): Wed 11 and Thu 12 only.
    expect(cal.isTradingDay("2026-11-10")).toBe(false);
    expect(sessionsLeft(ist("2026-11-09T16:00:00"), "2026-11-12", cal)).toBe(2);
  });

  it("formats expiry dates", () => {
    expect(dayMonth("2026-10-27")).toBe("27 Oct");
    expect(weekdayShort("2026-10-27")).toBe("Tue");
    expect(weekdayShort("2026-10-29")).toBe("Thu");
  });
});

describe("events", () => {
  const events = [
    ev("past", "US_CPI", "2026-10-14T18:00:00"),
    ev("nifty-expiry", "EXPIRY", "2026-10-27T15:30:00", ["NIFTY"]),
    ev("sensex-only", "OTHER", "2026-10-20T16:00:00", ["SENSEX"]),
    ev("fomc", "FOMC", "2026-10-28T23:30:00"),
    ev("us-cpi", "US_CPI", "2026-11-10T19:00:00"),
  ];
  const now = ist("2026-10-15T10:00:00");

  it("keeps the index's future events, expiries left out, by time", () => {
    expect(outlookEvents(events, "NIFTY", now, now + 30 * DAY_MS).map((e) => e.id)).toEqual(["fomc", "us-cpi"]);
    expect(outlookEvents(events, "SENSEX", now, now + 30 * DAY_MS).map((e) => e.id)).toEqual(["sensex-only", "fomc", "us-cpi"]);
    expect(outlookEvents(events, "NIFTY", now, ist("2026-10-28T23:00:00"))).toEqual([]);
  });

  it("lists each expiry's events up to its close: FOMC late on 28 Oct is before 3 Nov, not 27 Oct", () => {
    const view = buildOutlook({
      index: "NIFTY",
      nowMs: now,
      listed: ["2026-10-19", "2026-10-27", "2026-11-03"],
      readings: new Map(),
      scheduled: events,
      calendar: cal,
    });
    const byExpiry = Object.fromEntries(view.expiries.map((e) => [e.expiry, e.events.map((x) => x.id)]));
    expect(byExpiry).toEqual({ "2026-10-19": [], "2026-10-27": [], "2026-11-03": ["fomc"] });
    expect(view.events?.map((e) => e.id)).toEqual(["fomc", "us-cpi"]);
    expect(view.expiries.every((e) => e.eventsComplete)).toBe(true);
    expect(expiryCloseMs("2026-10-27")).toBe(ist("2026-10-27T15:30:00"));
  });

  it("says when events could not be read", () => {
    const view = buildOutlook({ index: "NIFTY", nowMs: now, listed: ["2026-10-19"], readings: new Map(), scheduled: null, calendar: cal });
    expect(view.events).toBeNull();
    expect(view.expiries[0].events).toEqual([]);
    expect(view.expiries[0].eventsComplete).toBe(false);
  });
});

describe("one expiry from a real Upstox chain (14 Oct 2026, 14:10 IST)", () => {
  const nowMs = ist("2026-10-14T14:10:00");
  const chainOf = (index: IndexId, sample: unknown, expiry: string, lotSize: number): OptionChainView =>
    buildOptionChainView({ index, expiry, meta: { expiries: [expiry], lotSize }, chain: parseUpstoxChain(sample), fetchedMs: nowMs });

  it("NIFTY 19 Oct: straddle at the 22,600 strike, range, IV, walls and OI change", () => {
    const chain = chainOf("NIFTY", NIFTY_CHAIN_SAMPLE, "2026-10-19", 65);
    const r = expiryOutlook(chain, ctx(nowMs));
    expect(r.atmStrike).toBe(22600);
    expect(r.spot).toBe(22622.7);
    // Mids: CE (145.25 + 145.85) / 2 = 145.55, PE (133.00 + 133.75) / 2 = 133.375.
    expect(r.straddle?.basis).toBe("mid");
    expect(r.straddle?.ce).toBe(145.55);
    expect(r.straddle?.pe).toBeCloseTo(133.38, 2);
    expect(r.straddle?.total).toBeCloseTo(278.93, 2);
    expect(r.movePct).toBe(1.23);
    expect(r.range?.low).toBeCloseTo(22321.07, 2);
    expect(r.range?.high).toBeCloseTo(22878.93, 2);
    expect(r.oneSigmaPct).toBeCloseTo(1.23 / 0.8, 2);
    expect(r.atmIv).toBeCloseTo((12.21 + 14.14) / 2, 2);
    expect(r.pcr).toBe(chain.pcr);
    expect(r.maxPain).toBe(chain.maxPain);
    expect(r.support.map((w) => w.strike)).toEqual([22600, 22700, 22550]);
    expect(r.resistance.map((w) => w.strike)).toEqual([22700, 22600, 22650]);
    expect(r.oiChange).toEqual({ ce: 9_995_310, pe: 2_479_490 });
    expect(r.days).toBe(5);
    expect(r.sessions).toBe(4);
    expect(r.fetchedAt).toBe("2026-10-14T14:10:00+05:30");
    expect(r.error).toBeNull();
    // The straddle is about 0.8 σ√T (the expected absolute move), with σ the ATM IV and T in calendar years.
    const tYears = (expiryCloseMs("2026-10-19") - nowMs) / (365 * DAY_MS);
    const ratio = r.movePct! / 100 / ((r.atmIv! / 100) * Math.sqrt(tYears));
    expect(ratio).toBeGreaterThan(0.75);
    expect(ratio).toBeLessThan(0.85);
  });

  it("on last trades (no tight quote) the straddle is 145.85 + 133.40", () => {
    const chain = chainOf("NIFTY", NIFTY_CHAIN_SAMPLE, "2026-10-19", 65);
    const atm = chain.rows.find((r) => r.strike === 22600);
    expect(straddleAt(atm, 0)).toEqual({ ce: 145.85, pe: 133.4, total: 279.25, basis: "ltp" });
  });

  it("SENSEX 15 Oct: the 72,800 straddle", () => {
    const chain = chainOf("SENSEX", SENSEX_CHAIN_SAMPLE, "2026-10-15", 20);
    const r = expiryOutlook(chain, ctx(nowMs, "SENSEX"));
    expect(r.atmStrike).toBe(72800);
    expect(r.straddle?.ce).toBe(237);
    expect(r.straddle?.total).toBeCloseTo(237 + 321.525, 1);
    expect(r.movePct).toBe(0.77);
    expect(r.days).toBe(1);
    expect(r.sessions).toBe(2);
  });

  it("a chain with an error gives calendar facts and the error, no figures", () => {
    const chain: OptionChainView = { ...chainOf("NIFTY", NIFTY_CHAIN_SAMPLE, "2026-10-19", 65), rows: [], pcr: null, maxPain: null, error: "Upstox rate limit (HTTP 429): retrying shortly" };
    const r = expiryOutlook(chain, ctx(nowMs));
    expect(r.error).toBe("Upstox rate limit (HTTP 429): retrying shortly");
    expect([r.straddle, r.movePct, r.range, r.atmIv, r.pcr, r.maxPain]).toEqual([null, null, null, null, null, null]);
    expect(r.days).toBe(5);
  });
});

describe("the mock chain", () => {
  const nowMs = ist("2026-10-15T11:42:00");
  const expiries = ["2026-10-19", "2026-10-27", "2026-11-03", "2026-11-09"];
  const chains = expiries.map((expiry) => buildMockChain({ index: "NIFTY", spot: 25012.4, prevSpot: 24990, nowMs, expiries, expiry }));

  it("prices about 0.8 σ√T per expiry, wider further out", () => {
    const rows = chains.map((c) => expiryOutlook(c, ctx(nowMs)));
    rows.forEach((r) => {
      const tYears = (expiryCloseMs(r.expiry) - nowMs) / (365 * DAY_MS);
      const ratio = r.movePct! / 100 / ((r.atmIv! / 100) * Math.sqrt(tYears));
      expect(ratio).toBeGreaterThan(0.77);
      expect(ratio).toBeLessThan(0.83);
    });
    const moves = rows.map((r) => r.movePct!);
    expect([...moves].sort((a, b) => a - b)).toEqual(moves);
    expect(new Set(moves).size).toBe(4);
  });

  it("assembles the outlook: missing rows pending, failed rows with their error, stale rows kept", () => {
    const readings = new Map<string, ChainReading>([
      ["2026-10-19", { chain: chains[0], error: null }],
      ["2026-10-27", { chain: null, error: "Upstox request budget reached: retrying shortly" }],
      ["2026-11-03", { chain: chains[2], error: "The engine did not answer within 8 s" }],
    ]);
    const view = buildOutlook({ index: "NIFTY", nowMs, listed: expiries, readings, scheduled: [], calendar: cal });
    expect(view.expiries.map((e) => e.expiry)).toEqual(expiries);
    expect(view.pending).toBe(1);
    expect(view.source).toBe("mock");
    expect(view.spot).toBe(25012.4);
    expect(view.asOf).toBe(chains[0].fetchedAt);
    const [a, b, c, d] = view.expiries;
    expect(a.movePct).not.toBeNull();
    expect(a.stale).toBe(false);
    expect(b.monthly).toBe(true);
    expect(b.movePct).toBeNull();
    expect(b.error).toMatch(/budget/);
    expect(c.movePct).not.toBeNull();
    expect(c.stale).toBe(true);
    expect(c.error).toMatch(/did not answer/);
    expect(d.movePct).toBeNull();
    expect(d.error).toBeNull();
    // The headline speaks about the first priced monthly; 27 Oct has no figures, so the farthest priced row.
    expect(headlineExpiry(view.expiries)?.expiry).toBe("2026-11-03");
  });

  it("writes one plain headline, or none without a priced expiry", () => {
    const rows = chains.map((ch, i) => ({ ...expiryOutlook(ch, ctx(nowMs)), monthly: i === 1 }));
    const r = rows[1];
    expect(outlookHeadline("NIFTY", rows)).toBe(
      `Option prices imply a move of about ±${r.movePct!.toFixed(1)}% for NIFTY by the 27 Oct monthly expiry: ${Math.round(r.range!.low).toLocaleString("en-IN")} to ${Math.round(r.range!.high).toLocaleString("en-IN")}.`,
    );
    expect(outlookHeadline("NIFTY", rows.map((x) => ({ ...x, monthly: false })))).toMatch(/by the 9 Nov expiry:/);
    expect(outlookHeadline("NIFTY", [])).toBeNull();
  });
});
