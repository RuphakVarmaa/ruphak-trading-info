import { describe, expect, it } from "vitest";
import type { CopyTicketView, DailyPnlView, PnlResponse } from "@/engine/api-types";
import { getMockEngine } from "@/lib/engine/mock";
import { accountFromQuery, accountHref, capitalOf, isPractice, marketStatusText, noTradesText, pnlFigures, safetyChips, tradeRow, type SafetyInput } from "./engineView";

const mock = () => getMockEngine({ adminToken: null, fail: false });
const at = (iso: string) => Date.parse(iso);

describe("accountFromQuery", () => {
  it("accepts a well-formed follower account", () => {
    expect(accountFromQuery({ account: "small10k" })).toBe("small10k");
    expect(accountFromQuery({ account: ["small5k", "x"] })).toBe("small5k");
  });
  it("treats main, empty and malformed values as main (undefined)", () => {
    expect(accountFromQuery({})).toBeUndefined();
    expect(accountFromQuery({ account: "main" })).toBeUndefined();
    expect(accountFromQuery({ account: "" })).toBeUndefined();
    expect(accountFromQuery({ account: "Small10K" })).toBeUndefined();
    expect(accountFromQuery({ account: "a/../b" })).toBeUndefined();
    expect(accountFromQuery({ account: "x".repeat(33) })).toBeUndefined();
  });
});

describe("accountHref", () => {
  it("keeps the plain path for main", () => {
    expect(accountHref("/live", undefined)).toBe("/live");
    expect(accountHref("/live", "main")).toBe("/live");
  });
  it("adds the account and other parameters", () => {
    expect(accountHref("/live", "small10k")).toBe("/live?account=small10k");
    expect(accountHref("/copy", "small5k", { id: "pos-1" })).toBe("/copy?account=small5k&id=pos-1");
    expect(accountHref("/copy", null, { id: "pos:1" })).toBe("/copy?id=pos%3A1");
  });
});

describe("capitalOf", () => {
  const main = { id: "main", label: "Main account", shortLabel: "Main", paperOnly: false, capitalRupees: 500_000 };
  const small = { id: "small10k", label: "₹10k account", shortLabel: "₹10k", paperOnly: true, capitalRupees: 10_000 };
  it("reads the state's own account, then the account list", () => {
    expect(capitalOf({ account: small, accounts: [main, small] }, "small10k")).toBe(10_000);
    expect(capitalOf({ account: undefined, accounts: [main, small] }, "main")).toBe(500_000);
  });
  it("is null when the engine does not report it (never a default)", () => {
    expect(capitalOf(null, "main")).toBeNull();
    expect(capitalOf({ account: undefined, accounts: undefined }, "main")).toBeNull();
    expect(capitalOf({ account: main, accounts: [main] }, "small5k")).toBeNull();
  });
});

describe("marketStatusText", () => {
  const now = at("2026-10-16T11:43:00+05:30");
  it("describes each phase", () => {
    expect(marketStatusText("OPEN", now, null, at("2026-10-16T15:30:00+05:30"), null)).toBe("Market open · closes in 3h 47m");
    expect(marketStatusText("PRE_OPEN", now, null, null, null)).toBe("Pre-open session");
    expect(marketStatusText("HOLIDAY", now, null, null, "Diwali")).toBe("Market holiday · Diwali");
    expect(marketStatusText("CLOSED", now, at("2026-10-19T09:15:00+05:30"), null, null)).toBe("Market closed · opens Mon 19 Oct 09:15 IST");
  });
  it("leaves out times it cannot know", () => {
    expect(marketStatusText("OPEN", null, null, at("2026-10-16T15:30:00+05:30"), null)).toBe("Market open");
    expect(marketStatusText("CLOSED", now, at("2026-10-15T09:15:00+05:30"), null, null)).toBe("Market closed");
  });
});

describe("safetyChips", () => {
  const base = async (): Promise<SafetyInput> => {
    const state = await mock().getState();
    return { state, source: "mock", status: "live", plan: { buyingPaused: true, pausedReason: "Buying is paused: the measured-edge check." }, practiceToday: 0, nowMs: Date.parse(state.market.nowIst) };
  };
  const find = (chips: ReturnType<typeof safetyChips>, key: string) => chips.find((c) => c.key === key)!;

  it("puts the demo-data flag first in mock mode, then mode, kill switch, engine and buying", async () => {
    const chips = safetyChips(await base());
    expect(chips.map((c) => c.key)).toEqual(["mock", "mode", "kill", "engine", "buying"]);
    expect(chips[0]).toMatchObject({ tone: "mock", label: "Demo data" });
    expect(find(chips, "mode")).toMatchObject({ tone: "info", label: "Paper", detail: "simulated orders" });
    expect(find(chips, "kill")).toMatchObject({ tone: "ok", label: "Kill switch off" });
    expect(find(chips, "engine").tone).toBe("ok");
    expect(find(chips, "engine").detail).toMatch(/^last ran \d+s ago · no errors$/);
    expect(find(chips, "buying")).toMatchObject({ tone: "warn", label: "New buys paused", title: "Buying is paused: the measured-edge check.", href: "#why" });
  });

  it("has no demo-data chip for the real engine", async () => {
    const input = await base();
    const chips = safetyChips({ ...input, source: "engine", state: { ...input.state!, dataSource: "engine" } });
    expect(chips.some((c) => c.key === "mock")).toBe(false);
  });

  it("shows the kill switch with its reason, linked to the controls", async () => {
    const input = await base();
    const chips = safetyChips({ ...input, state: { ...input.state!, killSwitch: true, killReason: "manual: news spike" } });
    expect(find(chips, "kill")).toMatchObject({ tone: "bad", label: "Kill switch ON", detail: "manual: news spike", href: "#operations" });
  });

  it("flags engine errors, a late tick and a dead connection", async () => {
    const input = await base();
    const s = input.state!;
    const errors = safetyChips({ ...input, state: { ...s, heartbeat: { ...s.heartbeat, consecutiveErrors: 3, lastError: "quote timeout" } } });
    expect(find(errors, "engine")).toMatchObject({ tone: "bad", label: "Engine errors", title: "quote timeout" });
    expect(find(errors, "engine").detail).toMatch(/^3 in a row/);

    const late = safetyChips({ ...input, nowMs: Date.parse(s.heartbeat.lastTickAt!) + 5 * 60_000 });
    expect(find(late, "engine")).toMatchObject({ tone: "warn", label: "Engine late" });

    const closed = safetyChips({ ...input, nowMs: Date.parse(s.heartbeat.lastTickAt!) + 5 * 60_000, state: { ...s, market: { ...s.market, phase: "CLOSED" }, heartbeat: { ...s.heartbeat, phase: "CLOSED" } } });
    expect(find(closed, "engine")).toMatchObject({ tone: "ok", label: "Engine idle" });

    expect(find(safetyChips({ ...input, status: "offline" }), "engine")).toMatchObject({ tone: "bad", label: "Engine not answering" });
    expect(find(safetyChips({ ...input, status: "stale" }), "engine")).toMatchObject({ tone: "warn", label: "Data out of date" });
  });

  it("says when live orders are armed, and when live mode cannot place one", async () => {
    const input = await base();
    const s = input.state!;
    const armed = safetyChips({ ...input, state: { ...s, mode: "LIVE", liveTradingEnabled: true, armed: true, armedUntil: "2026-10-16T12:30:00+05:30" } });
    expect(find(armed, "mode")).toMatchObject({ tone: "bad", label: "LIVE · armed", detail: "real orders until 12:30 IST" });
    const keyOff = safetyChips({ ...input, state: { ...s, mode: "LIVE", liveTradingEnabled: false, armed: false } });
    expect(find(keyOff, "mode")).toMatchObject({ tone: "warn", detail: "live key off: no real orders" });
  });

  it("reports buying on, practice trades, and missing data honestly", async () => {
    const input = await base();
    expect(find(safetyChips({ ...input, plan: { buyingPaused: false, pausedReason: null } }), "buying")).toMatchObject({ tone: "ok", label: "Buying on" });
    expect(find(safetyChips({ ...input, practiceToday: 2 }), "buying").detail).toBe("measured-edge check · 2 practice trades today");
    const empty = safetyChips({ state: null, source: null, status: "loading", plan: null, practiceToday: 0, nowMs: null });
    expect(empty.map((c) => [c.key, c.tone])).toEqual([
      ["mode", "muted"],
      ["kill", "muted"],
      ["engine", "muted"],
      ["buying", "muted"],
    ]);
    expect(find(empty, "buying").detail).toBe("no data");
  });
});

describe("pnlFigures", () => {
  const day = (date: string, net: number, equityEnd: number, extra: Partial<DailyPnlView> = {}): DailyPnlView => ({ date, realized: net, unrealized: 0, charges: 0, net, trades: 1, equityEnd, ...extra });

  it("matches PnlTiles for today and measures all-time against the capital", () => {
    const pnl: Pick<PnlResponse, "today" | "history"> = {
      today: day("2026-10-16", -400, 101_600, { realized: -500, unrealized: 150, charges: 50 }),
      history: [day("2026-10-14", 1_000, 101_000), day("2026-10-15", 1_000, 102_000)],
    };
    // The open position is now marked at +300 (the engine's ledger still says +150).
    const f = pnlFigures(pnl, [{ ltp: 103, avgPrice: 100, qty: 100 }], 100_000)!;
    expect(f.netToday).toBe(-500 + 300 - 50);
    expect(f.equityNow).toBe(102_000 - 250);
    expect(f.allTime).toBe(1_750);
    expect(f.allTimePct).toBeCloseTo(1.75);
    expect(f.window).toEqual({ from: "2026-10-14", net: 2_000 - 250 });
  });

  it("does not count today twice when the engine's history already holds it", () => {
    const today = day("2026-10-16", 200, 100_200);
    const f = pnlFigures({ today, history: [day("2026-10-15", 0, 100_000), today] }, [], 100_000)!;
    expect(f.window).toEqual({ from: "2026-10-15", net: 200 });
    expect(f.allTime).toBe(200);
  });

  it("has no all-time figure without a capital, and nothing at all without a P&L summary", () => {
    const f = pnlFigures({ today: day("2026-10-16", 0, 100_000), history: [] }, null, null)!;
    expect(f.allTime).toBeNull();
    expect(f.allTimePct).toBeNull();
    expect(f.window.from).toBe("2026-10-16");
    expect(pnlFigures(null, null, 100_000)).toBeNull();
  });

  it("agrees with the mock engine's main and ₹10k books", async () => {
    for (const account of [undefined, "small10k"]) {
      const engine = mock();
      const [state, pnl, positions] = await Promise.all([engine.getState(account), engine.getPnl(30, account), engine.getPositions(account)]);
      const capital = capitalOf(state, account ?? "main");
      expect(capital).toBe(account ? 10_000 : 500_000);
      const f = pnlFigures(pnl, positions, capital)!;
      expect(Number.isFinite(f.equityNow)).toBe(true);
      expect(f.allTime).toBeCloseTo(f.equityNow - capital!, 6);
      expect(f.window.from <= pnl.today.date).toBe(true);
    }
  });
});

describe("tradeRow", () => {
  it("lays out the mock's open trade with its mark and a /copy link", async () => {
    const engine = mock();
    const state = await engine.getState();
    const tickets = await engine.getCopyTickets(state.market.nowIst.slice(0, 10));
    expect(tickets.length).toBeGreaterThan(0);
    const t = tickets[0];
    const row = tradeRow(t, undefined);
    expect(row.href).toBe(`/copy?id=${encodeURIComponent(t.id)}`);
    expect(row.contract).toBe(t.contract.label);
    expect(row.inText).toMatch(/^in \d\d:\d\d at ₹[\d,]+\.\d\d$/);
    if (t.status === "OPEN") {
      expect(row.open).toBe(true);
      expect(row.outText).toMatch(/^open · mark ₹/);
      expect(row.pnl).toBe(t.live?.pnl ?? null);
    }
    expect(row.practice).toBe(false);
    expect(tradeRow(t, "small10k").href).toBe(`/copy?account=small10k&id=${encodeURIComponent(t.id)}`);
  });

  const ticket = (over: Partial<CopyTicketView>): CopyTicketView =>
    ({
      id: "pos-1",
      status: "CLOSED",
      headline: "BUY NIFTY 22600 CE (19 Oct)",
      contract: { label: "NIFTY 19-OCT-2026 22600 CE" },
      entry: { at: "2026-10-16T09:31:12+05:30", premium: 52.35 },
      exit: null,
      live: null,
      setup: null,
      ...over,
    }) as unknown as CopyTicketView;

  it("shows the exit time, price and reason, and the P&L after charges", () => {
    const row = tradeRow(ticket({ exit: { at: "2026-10-16T10:12:40+05:30", premium: 33.95, reason: "STOP", reasonText: "Stop-loss", pnl: -1_250.4, movePct: -35, holdMin: 41 } }), "main");
    expect(row.inText).toBe("in 09:31 at ₹52.35");
    expect(row.outText).toBe("out 10:12 at ₹33.95 · stop-loss hit");
    expect(row.pnl).toBe(-1_250.4);
    expect(row.href).toBe("/copy?id=pos-1");
  });

  it("never invents a P&L: no mark and no exit is null", () => {
    expect(tradeRow(ticket({ status: "OPEN" }), null)).toMatchObject({ open: true, outText: "open · no mark yet", pnl: null });
    expect(tradeRow(ticket({}), null)).toMatchObject({ outText: "closed · no exit record", pnl: null });
  });

  it("labels practice-quota trades", () => {
    const gates = [{ gate: "practice", label: "Practice quota (paper)", passed: true, detail: "window 10:30–11:30 IST" }];
    const t = ticket({ setup: { gates } as unknown as CopyTicketView["setup"] });
    expect(isPractice(t)).toBe(true);
    expect(tradeRow(t, null).practice).toBe(true);
  });
});

describe("noTradesText", () => {
  it("says 'yet' only while a trade can still come today", () => {
    expect(noTradesText("OPEN", at("2026-10-16T11:00:00+05:30"))).toBe("No trades yet today.");
    expect(noTradesText("PRE_OPEN", at("2026-10-16T09:05:00+05:30"))).toBe("No trades yet today.");
    expect(noTradesText("CLOSED", at("2026-10-16T08:00:00+05:30"))).toBe("No trades yet today. The market opens at 09:15 IST.");
    expect(noTradesText("CLOSED", at("2026-10-16T16:00:00+05:30"))).toBe("No trades today.");
    expect(noTradesText("CLOSED", at("2026-10-17T08:00:00+05:30"))).toBe("No trades today.");
    expect(noTradesText("HOLIDAY", at("2026-10-20T10:00:00+05:30"))).toMatch(/holiday/);
    expect(noTradesText(undefined, null)).toBe("No trades today.");
  });
});
