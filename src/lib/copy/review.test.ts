/** Fixes from the skeptic review of the copy advice (silent exits, cancel steps, repeat alerts, per-index staleness, loss caps). */
import { describe, expect, it } from "vitest";
import type { CopyTicketView } from "@/engine/api-types";
import type { LiveIndicesFeed } from "@/lib/market/liveIndices";
import { deriveIndexAction, feedInput, nowLine, type ActionInput } from "./action";
import { decideAlert } from "./alertRules";
import { paperScript, sizeCheck, sizeChecks } from "./script";
import { at, ms, niftyTicket, signal } from "./testTickets";

const LIVE = { freshness: "live" as const, ageMs: 1200, price: 22610 };

function input(o: Partial<ActionInput> = {}): ActionInput {
  return { index: "NIFTY", account: "main", signal: signal(), tickets: [], ticketsAgeMs: 2000, positions: [], nowMs: ms("11:42"), phase: "OPEN", nextOpenAt: null, feed: LIVE, ...o };
}

const closedAt = (id: string, exitAt: string): CopyTicketView =>
  niftyTicket({ id, status: "CLOSED", live: null, exit: { at: at(exitAt), premium: 99.7, reason: "STOP", reasonText: "Stop-loss hit", pnl: -2555, movePct: -30, holdMin: 20 } });

describe("1. exits are never silent", () => {
  it("an exit outranks another open trade on the same index", () => {
    const a = closedAt("pos-a", "11:41");
    const b = niftyTicket({ id: "pos-b", entry: { at: at("11:20") } });
    const r = deriveIndexAction(input({ tickets: [a, b], nowMs: ms("11:42") }));
    expect(r.kind).toBe("EXIT_NOW");
    expect(r.statusKey).toBe("EXIT_NOW:pos-a");
    expect(r.details.join(" ")).toContain("Also open: NIFTY 22600 CE (since 11:20).");
  });

  it("after a long sleep, a trade this tab saw open stays EXIT NOW until acknowledged", () => {
    const a = closedAt("pos-a", "10:40");
    const seen = new Map([["pos-a", 65]]);
    const r = deriveIndexAction(input({ tickets: [a], nowMs: ms("11:42"), openQty: seen }));
    expect(r.kind).toBe("EXIT_NOW");
    expect(r.alert).toBe(true);
    expect(r.details.join(" ")).toContain("If you still hold it, sell now.");
    const acked = deriveIndexAction(input({ tickets: [a], nowMs: ms("11:42"), openQty: seen, acked: new Set(["pos-a"]) }));
    expect(acked.kind).toBe("WAIT");
    // Never seen open and long gone: no EXIT NOW.
    expect(deriveIndexAction(input({ tickets: [a], nowMs: ms("11:42") })).kind).toBe("WAIT");
    // An acknowledged fresh exit clears too.
    expect(deriveIndexAction(input({ tickets: [closedAt("pos-c", "11:41")], nowMs: ms("11:42"), acked: new Set(["pos-c"]) })).kind).toBe("WAIT");
  });

  it("the closed-trade line tells a holder to sell", () => {
    expect(nowLine(null, closedAt("pos-a", "10:40"))).toBe("NIFTY 22600 CE closed at 10:40 IST (stop-loss hit). If you still hold it, sell now; otherwise nothing to do.");
  });
});

describe("2. cancel instructions", () => {
  it("ENTER NOW says to cancel an unfilled buy after about a minute", () => {
    const r = deriveIndexAction(input({ tickets: [niftyTicket()], nowMs: ms("10:08") }));
    expect(r.details).toContain("Not filled within about a minute? Cancel it — don't chase.");
  });

  it("MANAGE says to cancel any unfilled buy", () => {
    const r = deriveIndexAction(input({ tickets: [niftyTicket()], nowMs: ms("11:42") }));
    expect(r.details).toContain("Cancel any unfilled buy order for it.");
  });

  it("EXIT NOW says to cancel the stop-loss and target first", () => {
    const r = deriveIndexAction(input({ tickets: [closedAt("pos-a", "11:41")], nowMs: ms("11:42") }));
    expect(r.details[0]).toBe("First cancel your open stop-loss and target orders. If your stop-loss already filled, you are out — do nothing more.");
  });

  it("the script says the same", () => {
    const s = paperScript(niftyTicket()).join("\n");
    expect(s).toContain("If it is not filled within about a minute, cancel it — don't chase (the engine cancels its own unfilled entry after 30 s).");
    expect(s).toContain("first cancel your stop-loss and target orders (if the stop-loss already filled, you are out — do nothing more), then sell at market");
  });
});

describe("3. ENTER NOW is announced once per trade", () => {
  const enter = { kind: "ENTER_NOW" as const, statusKey: "ENTER_NOW:pos-a", alert: true, ticket: { id: "pos-a" } };
  const paused = { kind: "PAUSED" as const, statusKey: "PAUSED:pos-a", alert: true, ticket: { id: "pos-a" } };
  it("fires once, then never again for the same trade after ENTER → PAUSED → ENTER", () => {
    const first = decideAlert(enter, { last: "WAIT:", entered: new Set() });
    expect(first).toMatchObject({ fire: true, enteredId: "pos-a" });
    const p = decideAlert(paused, { last: "ENTER_NOW:pos-a", entered: new Set(["pos-a"]) });
    expect(p).toMatchObject({ fire: true, delayMs: 3000 });
    const again = decideAlert(enter, { last: "PAUSED:pos-a", entered: new Set(["pos-a"]) });
    expect(again.fire).toBe(false);
    expect(again.record).toBe("ENTER_NOW:pos-a");
  });

  it("records the first look quietly, and remembers an ENTER NOW seen then", () => {
    expect(decideAlert(enter, { last: null, entered: new Set() })).toMatchObject({ fire: false, enteredId: "pos-a" });
    expect(decideAlert(enter, { last: "ENTER_NOW:pos-a", entered: new Set() }).fire).toBe(false);
  });
});

describe("4. a stale index pauses ENTER NOW even when the other is fresh", () => {
  it("reads the index's own stale flag", () => {
    const quote = (index: "NIFTY" | "SENSEX", stale: boolean) => ({ index, price: index === "NIFTY" ? 22610 : 81300, stale }) as unknown as LiveIndicesFeed["indices"][number];
    const data = { indices: [quote("NIFTY", true), quote("SENSEX", false)], stale: false, missing: [] } as unknown as LiveIndicesFeed;
    const f = feedInput({ data, freshness: "live", ageMs: 900, error: null }, "NIFTY", false);
    expect(f.sourceStale).toBe(true);
    expect(feedInput({ data, freshness: "live", ageMs: 900, error: null }, "SENSEX", false).sourceStale).toBe(false);
    const r = deriveIndexAction(input({ tickets: [niftyTicket()], nowMs: ms("10:08"), feed: f }));
    expect(r.kind).toBe("PAUSED");
  });
});

describe("6. the size check flags a stop loss above the account's cap", () => {
  it("₹5,000: a NIFTY lot losing more than ₹1,500 at the stop is flagged, a smaller one is not", () => {
    const big = niftyTicket({ entry: { premium: 62 }, levels: { stopPct: -35, stop: 40.3 } });
    const c = sizeCheck(big, 5000, 1, "₹5,000", "small5k");
    expect(c.lossCap).toBe(1500);
    expect(c.maxLoss).toBeGreaterThan(1500);
    expect(c.overLossCap).toBe(true);
    expect(c.warning).toContain("more than the ₹1,500 one trade may lose");
    const small = niftyTicket({ entry: { premium: 50 }, levels: { stopPct: -35, stop: 32.5 } });
    expect(sizeCheck(small, 5000, 1, "₹5,000", "small5k").overLossCap).toBe(false);
  });

  it("uses each account's own cap (₹10k: 20 %, main: 1 %)", () => {
    const [own, five] = sizeChecks(niftyTicket({ account: { id: "small10k", label: "₹10k account", shortLabel: "₹10k", capitalRupees: 10_000 } }));
    expect(own.lossCap).toBe(2000);
    expect(five.lossCap).toBe(1500);
    expect(sizeChecks(niftyTicket())[0].lossCap).toBe(5000);
  });
});
