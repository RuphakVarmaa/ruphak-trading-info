import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CopyTicketView, OrderReason, PositionView, SessionPhase } from "@/engine/api-types";
import {
  buyOrderText,
  deriveIndexAction,
  expiryLong,
  expiryShort,
  GATE_RANK,
  manageText,
  nowLine,
  opensText,
  sellOrderText,
  skipRule,
  type ActionInput,
  type FeedInput,
} from "./action";
import { at, ms, niftyTicket, rangeGates, sensexTicket, signal, withGate } from "./testTickets";

const LIVE: FeedInput = { freshness: "live", ageMs: 1200, price: 22610 };

function input(o: Partial<ActionInput> = {}): ActionInput {
  return {
    index: "NIFTY",
    account: "main",
    signal: signal(),
    tickets: [],
    ticketsAgeMs: 2000,
    positions: [],
    nowMs: ms("11:42"),
    phase: "OPEN",
    nextOpenAt: at("09:15", "2026-10-12"),
    holidayName: null,
    feed: LIVE,
    ...o,
  };
}

const closed = (reason: OrderReason, exitAt: string, pnl: number, premium = 99.7): CopyTicketView =>
  niftyTicket({ status: "CLOSED", live: null, exit: { at: at(exitAt), premium, reason, reasonText: "x", pnl, movePct: (premium / 142.5 - 1) * 100, holdMin: 8 } });

describe("ENTER NOW", () => {
  it("gives the exact NIFTY order within 10 minutes of the engine's buy", () => {
    const a = deriveIndexAction(input({ tickets: [niftyTicket()], nowMs: ms("10:08") }));
    expect(a.kind).toBe("ENTER_NOW");
    expect(a.headline).toBe("ENTER NOW");
    expect(a.order).toBe("BUY NIFTY 22600 CE 13-Oct · 1 lot = 65 qty · limit ≤ ₹145.35 · skip if NIFTY > 22,631");
    expect(a.limit).toBe(145.35);
    expect(a.skip).toEqual({ level: 22631, above: true });
    expect(a.tone).toBe("action");
    expect(a.alert).toBe(true);
    expect(a.statusKey).toBe("ENTER_NOW:pos-nifty-1005");
    expect(a.notice).toEqual({ title: "ENTER NOW · NIFTY", body: a.order });
    expect(a.details[0]).toContain("10:05:02 IST (2 min ago) at ₹142.50, a model price");
    expect(a.details.join(" ")).toContain("stop-loss ₹99.75, target ₹213.75, out by 15:05");
  });

  it("gives the exact SENSEX put order for the ₹10k account (lot of 20, skip below)", () => {
    const a = deriveIndexAction(input({ index: "SENSEX", account: "small10k", tickets: [sensexTicket()], nowMs: ms("10:23"), feed: { ...LIVE, price: 81300 } }));
    expect(a.kind).toBe("ENTER_NOW");
    expect(a.order).toBe("BUY SENSEX 81500 PE 15-Oct · 1 lot = 20 qty · limit ≤ ₹171.75 · skip if SENSEX < 81,234");
    expect(a.skip).toEqual({ level: 81234, above: false });
    expect(a.details[0]).not.toContain("model price");
  });

  it("writes lots and quantity for several lots", () => {
    const t = niftyTicket({ lots: 3, qty: 195, contract: { lots: 3 } });
    expect(buyOrderText(t)).toBe("BUY NIFTY 22600 CE 13-Oct · 3 lots = 195 qty · limit ≤ ₹145.35 · skip if NIFTY > 22,631");
    const s = sensexTicket({ lots: 2, qty: 40, contract: { lots: 2 } });
    expect(buyOrderText(s)).toContain("2 lots = 40 qty");
  });

  it("stays ENTER NOW at exactly the skip level and exactly 10 minutes", () => {
    expect(deriveIndexAction(input({ tickets: [niftyTicket()], nowMs: ms("10:08"), feed: { ...LIVE, price: 22631 } })).kind).toBe("ENTER_NOW");
    expect(deriveIndexAction(input({ tickets: [niftyTicket()], nowMs: ms("10:15:02") })).kind).toBe("ENTER_NOW");
    expect(deriveIndexAction(input({ tickets: [niftyTicket()], nowMs: ms("10:15:03") })).kind).toBe("MANAGE");
  });

  it("drops the skip clause when the engine gave no skip level", () => {
    const a = deriveIndexAction(input({ tickets: [niftyTicket({ entry: { skipBeyondSpot: null } })], nowMs: ms("10:08") }));
    expect(a.kind).toBe("ENTER_NOW");
    expect(a.order).toBe("BUY NIFTY 22600 CE 13-Oct · 1 lot = 65 qty · limit ≤ ₹145.35");
    expect(a.details.join(" ")).toContain("no skip level");
  });

  it("works the same for any account id (a new ₹5k account)", () => {
    const t = niftyTicket({ id: "pos-5k", account: { id: "small5k", label: "₹5k account", shortLabel: "₹5k", capitalRupees: 5000 } });
    const a = deriveIndexAction(input({ account: "small5k", tickets: [t], nowMs: ms("10:08") }));
    expect(a.kind).toBe("ENTER_NOW");
    expect(a.statusKey).toBe("ENTER_NOW:pos-5k");
  });

  it("ignores the other index's tickets", () => {
    const a = deriveIndexAction(input({ index: "SENSEX", tickets: [niftyTicket()], nowMs: ms("10:08"), signal: signal({ index: "SENSEX" }) }));
    expect(a.kind).toBe("WAIT");
  });
});

describe("PAUSED (never enter on stale data)", () => {
  const paused = (feed: Partial<FeedInput>, o: Partial<ActionInput> = {}) => deriveIndexAction(input({ tickets: [niftyTicket()], nowMs: ms("10:08"), feed: { ...LIVE, ...feed }, ...o }));

  it("pauses on a stale feed and shows its age", () => {
    const a = paused({ freshness: "stale", ageMs: 14_000 });
    expect(a.kind).toBe("PAUSED");
    expect(a.headline).toBe("PAUSED — live feed stale (14 s)");
    expect(a.tone).toBe("stale");
    expect(a.alert).toBe(true);
    expect(a.statusKey).toBe("PAUSED:pos-nifty-1005");
    expect(a.details[0]).toContain("Don't buy on old data");
    expect(a.details.join(" ")).toContain("skip if NIFTY is above 22,631");
  });

  it("pauses when the feed is offline, or never answered", () => {
    expect(paused({ freshness: "offline", ageMs: 75_000 }).headline).toBe("PAUSED — live feed offline (1 min)");
    // A 404 from /api/market/live: no good response yet, and an error.
    const never = paused({ freshness: "loading", ageMs: null, price: null, error: true });
    expect(never.headline).toBe("PAUSED — live feed offline");
    expect(never.alert).toBe(true);
  });

  it("waits quietly while the feed is still loading", () => {
    const a = paused({ freshness: "loading", ageMs: null, price: null });
    expect(a.headline).toBe("PAUSED — waiting for the live feed");
    expect(a.alert).toBe(false);
  });

  it("pauses without this index's price, on a repeated payload, and on stale engine data", () => {
    expect(paused({ price: null }).headline).toBe("PAUSED — no live NIFTY price");
    expect(paused({ sourceStale: true }).headline).toBe("PAUSED — live feed stale (its source stopped updating)");
    expect(paused({}, { ticketsAgeMs: 45_000 }).headline).toBe("PAUSED — engine data stale (45 s)");
    expect(paused({}, { ticketsAgeMs: null }).kind).toBe("PAUSED");
  });

  it("says why when the tab is in the background", () => {
    const a = paused({ freshness: "stale", ageMs: 40_000, hidden: true });
    expect(a.headline).toBe("PAUSED — live feed paused in the background");
    expect(a.alert).toBe(true);
  });

  it("does not latch the skip on stale prices", () => {
    const a = paused({ freshness: "stale", ageMs: 14_000, price: 22700 });
    expect(a.kind).toBe("PAUSED");
    expect(a.pastSkipNow).toBe(false);
  });
});

describe("MANAGE", () => {
  it("manages a trade older than 10 minutes", () => {
    const a = deriveIndexAction(input({ tickets: [niftyTicket()], nowMs: ms("11:42") }));
    expect(a.kind).toBe("MANAGE");
    expect(a.tone).toBe("hold");
    expect(a.order).toBe("If you hold it: stop ₹99.75 (it trails once the premium reaches ₹185.25), target ₹213.75, out by 15:05. If you don't: don't chase.");
    expect(a.details[0]).toBe("Opened at 10:05 IST, 1 h 36 min ago: too late to copy.");
    expect(a.statusKey).toBe("MANAGE:pos-nifty-1005");
    expect(a.alert).toBe(true);
    // Manage does not depend on the live feed.
    expect(deriveIndexAction(input({ tickets: [niftyTicket()], nowMs: ms("11:42"), feed: { freshness: "offline", ageMs: null, price: null } })).kind).toBe("MANAGE");
  });

  it("manages (don't chase) once the index passes the skip level, for calls and puts", () => {
    const call = deriveIndexAction(input({ tickets: [niftyTicket()], nowMs: ms("10:08"), feed: { ...LIVE, price: 22631.2 } }));
    expect(call.kind).toBe("MANAGE");
    expect(call.pastSkipNow).toBe(true);
    expect(call.details[0]).toBe("NIFTY has passed the skip level of 22,631 (now 22,631.20): too late to copy.");
    const put = deriveIndexAction(input({ index: "SENSEX", tickets: [sensexTicket()], nowMs: ms("10:23"), feed: { ...LIVE, price: 81233.9 } }));
    expect(put.kind).toBe("MANAGE");
    expect(put.pastSkipNow).toBe(true);
    expect(put.order).toBe("If you hold it: stop ₹109.40 (it trails once the premium reaches ₹218.90), target ₹269.40, out by 15:05. If you don't: don't chase.");
  });

  it("stays MANAGE once latched, even if the index comes back", () => {
    const a = deriveIndexAction(input({ tickets: [niftyTicket()], nowMs: ms("10:09"), feed: LIVE, skipLatched: new Set(["pos-nifty-1005"]) }));
    expect(a.kind).toBe("MANAGE");
    expect(a.pastSkipNow).toBe(false);
  });

  it("shows the trailing stop once it is on", () => {
    expect(manageText(niftyTicket({ levels: { trail: 164.12 } }))).toBe("If you hold it: trailing stop ₹164.10 (the trail is on), target ₹213.75, out by 15:05. If you don't: don't chase.");
  });

  it("falls back to the engine's position when the trade list cannot load", () => {
    const pos = { id: "pos-nifty-1005", index: "NIFTY", contract: { index: "NIFTY", strike: 22600, optionType: "CE" }, stopPrice: 99.75, targetPrice: 213.75, trailPrice: null, squareOffAt: at("15:05"), openedAt: at("10:05:02") } as unknown as PositionView;
    const a = deriveIndexAction(input({ tickets: null, ticketsError: true, positions: [pos] }));
    expect(a.kind).toBe("MANAGE");
    expect(a.statusKey).toBe("MANAGE:pos-nifty-1005");
    expect(a.order).toBe("If you hold it: stop ₹99.75, target ₹213.75, out by 15:05. If you don't: don't chase.");
  });

  it("lists another open trade on the same index", () => {
    const older = niftyTicket({ id: "pos-old", entry: { at: at("09:40") }, contract: { strike: 22550 } });
    const a = deriveIndexAction(input({ tickets: [older, niftyTicket()], nowMs: ms("10:08") }));
    expect(a.ticket?.id).toBe("pos-nifty-1005");
    expect(a.details.join(" ")).toContain("Also open: NIFTY 22550 CE (since 09:40).");
  });
});

describe("EXIT NOW", () => {
  const words: [OrderReason, string][] = [
    ["STOP", "stop-loss hit"],
    ["TARGET", "target hit"],
    ["TRAIL", "trailing stop hit"],
    ["TIME_STOP", "time stop"],
    ["SIGNAL_FLIP", "signal flip"],
    ["SQUARE_OFF", "square-off"],
  ];
  it.each(words)("says SELL now with the reason (%s)", (reason, word) => {
    const a = deriveIndexAction(input({ tickets: [closed(reason, "10:12:40", -2555)], nowMs: ms("10:15") }));
    expect(a.kind).toBe("EXIT_NOW");
    expect(a.headline).toBe(`SELL NIFTY 22600 CE now — ${word}`);
    expect(a.order).toBe(`SELL NIFTY 22600 CE 13-Oct · 1 lot = 65 qty · market order now · ${word}`);
    expect(a.statusKey).toBe("EXIT_NOW:pos-nifty-1005");
    expect(a.tone).toBe("action");
  });

  it("reports the engine's exit price and P&L", () => {
    const a = deriveIndexAction(input({ tickets: [closed("STOP", "10:12:40", -2555)], nowMs: ms("10:15") }));
    expect(a.pnl).toBe(-2555);
    expect(a.details[0]).toBe("The engine sold at ₹99.70 at 10:12 IST after 8 min: −₹2,555 after charges (x).");
  });

  it("goes back to WAIT more than 10 minutes after the exit", () => {
    const a = deriveIndexAction(input({ tickets: [closed("TARGET", "10:12:40", 4400, 214)], nowMs: ms("10:22:41") }));
    expect(a.kind).toBe("WAIT");
    expect(a.details).toContain("Today on NIFTY: 1 trade, +₹4,400 after charges.");
  });

  it("says SELL at the 15:05 square-off even before the engine confirms, with one alert identity", () => {
    const open = deriveIndexAction(input({ tickets: [niftyTicket()], nowMs: ms("15:05:10") }));
    expect(open.kind).toBe("EXIT_NOW");
    expect(open.headline).toBe("SELL NIFTY 22600 CE now — square-off 15:05");
    const confirmed = deriveIndexAction(input({ tickets: [closed("SQUARE_OFF", "15:05:20", 300, 147.3)], nowMs: ms("15:05:30") }));
    expect(confirmed.statusKey).toBe(open.statusKey);
  });

  it("is DONE after the close if a trade is somehow still listed open", () => {
    const a = deriveIndexAction(input({ tickets: [niftyTicket()], nowMs: ms("15:40"), phase: "CLOSED" }));
    expect(a.kind).toBe("DONE");
    expect(a.details[0]).toContain("still lists NIFTY 22600 CE as open");
  });

  it("keeps a new trade first but reminds about a fresh exit on the same index", () => {
    const first = closed("TARGET", "10:06", 4400, 214);
    const second = niftyTicket({ id: "pos-2", entry: { at: at("10:07") } });
    const a = deriveIndexAction(input({ tickets: [first, second], nowMs: ms("10:08") }));
    expect(a.kind).toBe("ENTER_NOW");
    expect(a.details.join(" ")).toContain("Also: sell NIFTY 22600 CE if you still hold it (target hit at 10:06).");
  });
});

describe("WAIT", () => {
  it("explains the conviction band in the engine's words", () => {
    const a = deriveIndexAction(input());
    expect(a.kind).toBe("WAIT");
    expect(a.headline).toBe("WAIT");
    expect(a.details[0]).toBe("Conviction +0.07 is inside the ±0.55 no-trade band (RANGE)");
    expect(a.trigger).toBe("An entry needs conviction beyond ±0.55 (above +0.55 buys a CE, below −0.55 a PE), with every other check passing.");
    expect(a.details).toContain("Engine reading at 11:41 IST.");
    expect(a.alert).toBe(false);
    expect(a.statusKey).toBe("WAIT:");
  });

  it("explains a counter-trend threshold", () => {
    const s = signal({ conviction: -0.2, entryThreshold: 0.6, regime: "TREND_UP", gates: withGate(rangeGates(-0.2), "conviction", false, "score -0.20", "Conviction beyond ±0.60 (TREND_UP)") });
    const a = deriveIndexAction(input({ signal: s }));
    expect(a.details[0]).toBe("Conviction −0.20 is short of the −0.60 needed against the uptrend (TREND_UP)");
    expect(a.trigger).toBe("A PE needs conviction −0.60 against the uptrend, with every other check passing.");
  });

  it("says when entries start, during pre-open and before the open", () => {
    expect(deriveIndexAction(input({ nowMs: ms("09:20") })).details[0]).toBe("New entries start at 09:25 IST");
    expect(deriveIndexAction(input({ nowMs: ms("09:05"), phase: "PRE_OPEN" })).details[0]).toBe("Pre-open — trading starts at 09:15 IST; new entries from 09:25 IST");
    const early = deriveIndexAction(input({ nowMs: ms("08:00"), phase: "CLOSED", nextOpenAt: at("09:15") }));
    expect(early.kind).toBe("WAIT");
    expect(early.details[0]).toBe("Market closed — opens today 09:15 IST");
  });

  it("names holidays and weekends", () => {
    const holiday = deriveIndexAction(input({ nowMs: ms("11:00", "2026-10-20"), phase: "HOLIDAY", holidayName: "Dussehra", nextOpenAt: at("09:15", "2026-10-21") }));
    expect(holiday.details[0]).toBe("Market closed today (Dussehra) — opens Wed 09:15 IST");
    const weekend = deriveIndexAction(input({ nowMs: ms("11:00", "2026-10-10"), phase: "CLOSED", holidayName: null, nextOpenAt: at("09:15", "2026-10-12") }));
    expect(weekend.details[0]).toBe("Market closed (weekend) — opens Mon 09:15 IST");
  });

  it("puts account-wide stops first: daily loss cap and kill switch", () => {
    const cap = signal({ gates: withGate(rangeGates(0.07), "halt", false, "daily loss ₹15234 reached the cap ₹15000") });
    const a = deriveIndexAction(input({ signal: cap }));
    expect(a.details[0]).toBe("Daily loss cap reached (₹15,234 lost, cap ₹15,000): no new entries today");
    expect(a.trigger).toBe("None today: this check resets at the next session.");
    expect(a.details).toContain("1 more check failing (see Details).");
    const kill = signal({ gates: withGate(rangeGates(0.07), "halt", false, "Manual kill by ops") });
    expect(deriveIndexAction(input({ signal: kill })).details[0]).toBe("Kill switch is on (Manual kill by ops): no new entries");
  });

  it("explains capacity and cooldown blocks, with the conviction it also needs", () => {
    const busy = signal({ index: "SENSEX", gates: withGate(rangeGates(0.07), "max_positions", false, "1 of 1") });
    const a = deriveIndexAction(input({ index: "SENSEX", signal: busy }));
    expect(a.details[0]).toBe("The account is at its open-trade limit (1 of 1)");
    expect(a.trigger).toBe("After the open trade closes. An entry needs conviction beyond ±0.55 (above +0.55 buys a CE, below −0.55 a PE), with every other check passing.");
    const cool = signal({ conviction: 0.7, gates: withGate(withGate(rangeGates(0.7), "conviction", true, "score +0.70"), "cooldown", false, "stopped out 12 min ago") });
    const c = deriveIndexAction(input({ signal: cool }));
    expect(c.details[0]).toBe("Cooling down after a stop-out (stopped out 12 min ago)");
    expect(c.trigger).toBe("Entries on NIFTY can resume in about 18 min.");
  });

  it("explains an edge failure once the conviction passes", () => {
    const s = signal({ conviction: 0.62, entryThreshold: 0.35, regime: "TREND_UP", gates: withGate(withGate(rangeGates(0.62), "conviction", true, "score +0.62"), "edge_ratio", false, "6.2% (θ 1.10, costs 0.45 per unit)", "Edge after theta and costs ≥ 10% of premium") });
    expect(deriveIndexAction(input({ signal: s })).details[0]).toBe("Edge after time decay and costs too small: 6.2% (θ 1.10, costs 0.45 per unit)");
  });

  it("explains the expiry-day cutoff and scheduled-event blackouts", () => {
    const exp = signal({ index: "SENSEX", conviction: 0.7, gates: withGate(withGate(rangeGates(0.7), "conviction", true, "score +0.70"), "expiry_day", false, "SENSEX expiry today, 85 min to close") });
    expect(deriveIndexAction(input({ index: "SENSEX", signal: exp })).details[0]).toBe("SENSEX expires today: no new SENSEX entries this close to the expiry (85 min to the close)");
    const ev = signal({ gates: withGate(rangeGates(0.07), "event_blackout", false, "RBI policy decision in 12 min") });
    expect(deriveIndexAction(input({ signal: ev })).details[0]).toBe("Scheduled-event blackout: RBI policy decision in 12 min");
  });

  it("says when every check passes", () => {
    const s = signal({ conviction: 0.7, gates: withGate(rangeGates(0.7), "conviction", true, "score +0.70"), allGatesPassed: true });
    expect(deriveIndexAction(input({ signal: s })).details[0]).toBe("Every check passes on the engine's 11:41 IST reading: an entry may follow within seconds");
  });

  it("handles a missing or late reading", () => {
    expect(deriveIndexAction(input({ signal: null })).details[0]).toBe("No engine reading for NIFTY yet");
    const late = deriveIndexAction(input({ signal: signal({ computedAt: at("11:20") }) }));
    expect(late.tone).toBe("stale");
    expect(late.details).toContain("The engine's last NIFTY reading is from 11:20 IST (22 min ago): it may be behind.");
  });

  it("reads gates it does not know (labels and details as given)", () => {
    const s = signal({
      conviction: 0.08,
      gates: [
        { gate: "CONVICTION", label: "Conviction", passed: false, detail: "+0.08 < 0.55 (RANGE)" },
        { gate: "EXPOSURE", label: "Exposure", passed: false, detail: "1/1 position slots used (NIFTY)" },
        { gate: "SESSION", label: "Entry window", passed: true, detail: "09:25–14:30 IST" },
      ],
    });
    const a = deriveIndexAction(input({ signal: s }));
    expect(a.details[0]).toBe("Conviction +0.08 is inside the ±0.55 no-trade band (RANGE)");
    expect(a.details).toContain("1 more check failing (see Details).");
  });

  it("counts the conviction band even without a conviction gate", () => {
    const s = signal({ gates: [] });
    expect(deriveIndexAction(input({ signal: s })).details[0]).toBe("Conviction +0.07 is inside the ±0.55 no-trade band (RANGE)");
  });
});

describe("DONE and LOADING", () => {
  it("is DONE after 14:30 with nothing open, with the day's result", () => {
    const a = deriveIndexAction(input({ tickets: [closed("STOP", "10:12:40", -2555)], nowMs: ms("14:31") }));
    expect(a.kind).toBe("DONE");
    expect(a.headline).toBe("DONE for today");
    expect(a.details[0]).toBe("No new entries after 14:30 IST, and nothing is open on NIFTY.");
    expect(a.details[1]).toBe("Today on NIFTY: 1 trade, −₹2,555 after charges.");
    expect(a.pnl).toBe(-2555);
    expect(deriveIndexAction(input({ nowMs: ms("14:30:30") })).kind).toBe("WAIT");
  });

  it("is DONE after the close", () => {
    const a = deriveIndexAction(input({ nowMs: ms("16:00", "2026-10-08"), phase: "CLOSED", nextOpenAt: at("09:15") }));
    expect(a.kind).toBe("DONE");
    expect(a.details[0]).toBe("Market closed at 15:30 IST — opens Fri 09:15 IST.");
  });

  it("is LOADING until the trade list arrives, and says so when it cannot", () => {
    const a = deriveIndexAction(input({ tickets: null, ticketsAgeMs: null }));
    expect(a.kind).toBe("LOADING");
    expect(a.headline).toBe("Loading today's trades…");
    const b = deriveIndexAction(input({ tickets: null, ticketsAgeMs: null, ticketsError: true }));
    expect(b.headline).toBe("Can't load today's trades");
    expect(b.details[0]).toBe("The engine is not answering. This retries every few seconds.");
    expect(b.alert).toBe(false);
    // Outside market hours the clock alone decides.
    expect(deriveIndexAction(input({ tickets: null, nowMs: ms("16:00"), phase: "CLOSED" })).kind).toBe("DONE");
  });
});

describe("helpers", () => {
  it("formats expiries and opening times", () => {
    expect(expiryShort("2026-10-13")).toBe("13-Oct");
    expect(expiryShort("2026-11-03")).toBe("3-Nov");
    expect(expiryLong("2026-10-19")).toBe("Mon 19 Oct 2026");
    expect(opensText(at("09:15", "2026-10-09"), ms("16:00", "2026-10-08"))).toBe("Fri 09:15 IST");
    expect(opensText(at("09:15", "2026-10-21"), ms("16:00", "2026-10-13"))).toBe("Wed 21 Oct 09:15 IST");
    expect(opensText(at("09:15", "2026-10-08"), ms("16:00", "2026-10-08"))).toBeNull();
  });

  it("rounds the skip level the safe way", () => {
    expect(skipRule(niftyTicket({ entry: { skipBeyondSpot: 22631.99 } }))).toEqual({ level: 22631, above: true });
    expect(skipRule(sensexTicket({ entry: { skipBeyondSpot: 81233.01 } }))).toEqual({ level: 81234, above: false });
  });

  it("writes the sell order", () => {
    expect(sellOrderText(sensexTicket(), "target hit")).toBe("SELL SENSEX 81500 PE 15-Oct · 1 lot = 20 qty · market order now · target hit");
  });

  it("writes one 'what to do now' line per status", () => {
    const enter = deriveIndexAction(input({ tickets: [niftyTicket()], nowMs: ms("10:08") }));
    expect(nowLine(enter, enter.ticket)).toBe("Buy 65 qty of NIFTY 22600 CE now with a limit of ₹145.35 or less, then place the stop-loss at ₹99.75.");
    const pause = deriveIndexAction(input({ tickets: [niftyTicket()], nowMs: ms("10:08"), feed: { ...LIVE, freshness: "stale", ageMs: 14_000 } }));
    expect(nowLine(pause, pause.ticket)).toBe("Wait: live feed stale (14 s). Don't buy NIFTY 22600 CE until the live price is back, and skip it if NIFTY is above 22,631.");
    const manage = deriveIndexAction(input({ tickets: [niftyTicket()] }));
    expect(nowLine(manage, manage.ticket)).toBe("Holding NIFTY 22600 CE? Keep the stop at ₹99.75 and sell by 15:05 IST. Not holding it? Don't chase it.");
    const exit = deriveIndexAction(input({ tickets: [closed("STOP", "10:12:40", -2555)], nowMs: ms("10:15") }));
    expect(nowLine(exit, exit.ticket)).toBe("Sell all 65 qty of NIFTY 22600 CE now at market (stop-loss hit).");
    const old = closed("STOP", "10:12:40", -2555);
    expect(nowLine(null, old)).toBe("NIFTY 22600 CE closed at 10:12 IST (stop-loss hit): nothing to do.");
  });
});

describe("the engine's own gate ids", () => {
  it("has a plain-language reason for every gate the engine emits", () => {
    const files = ["src/engine/strategy/gates.ts", "src/engine/risk/limits.ts", "src/engine/strategy/planner.ts", "src/engine/strategy/optionSelect.ts"];
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const ids = new Set<string>();
    for (const f of files) for (const m of readFileSync(`${root}${f}`, "utf8").matchAll(/gate: "([a-z_]+)"/g)) ids.add(m[1]);
    expect(ids.size).toBeGreaterThan(20);
    for (const id of ids) expect(GATE_RANK, `gate ${id}`).toHaveProperty(id);
  });

  it("covers every market phase", () => {
    const phases: SessionPhase[] = ["PRE_OPEN", "OPEN", "CLOSED", "HOLIDAY"];
    for (const phase of phases) expect(deriveIndexAction(input({ phase })).kind).toMatch(/WAIT|DONE/);
  });
});
