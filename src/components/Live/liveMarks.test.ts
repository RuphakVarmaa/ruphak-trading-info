import { describe, expect, it } from "vitest";
import type { PositionView } from "@/engine/api-types";
import { markLive, rawUnrealized, type LiveInputs } from "./liveMarks";

const AT = Date.parse("2026-10-08T11:10:00+05:30");
const live = (spot: number, vix: number | null = 14.3): LiveInputs => ({ spot, vix, asOf: "2026-10-08T11:10:00+05:30", atMs: AT });

/** A 22450 put bought at 146.55 (65 qty), marked by the engine at 143.00 with 27.89 of entry charges. */
const put = (over: Partial<PositionView> = {}): PositionView =>
  ({
    id: "p1",
    index: "NIFTY",
    qty: 65,
    avgPrice: 146.55,
    ltp: 143.0,
    ltpAsOf: "2026-10-08T11:09:40+05:30",
    pnl: Math.round(((143.0 - 146.55) * 65 - 27.89) * 100) / 100,
    pnlPct: -2.7,
    contract: { index: "NIFTY", expiry: "2026-10-13", strike: 22450, optionType: "PE", tradingSymbol: "NIFTY26O1322450PE", lotSize: 65 },
    ...over,
  }) as unknown as PositionView;

describe("rawUnrealized", () => {
  it("is the price move before charges, and zero without a mark", () => {
    expect(rawUnrealized(put())).toBeCloseTo((143 - 146.55) * 65, 6);
    expect(rawUnrealized(put({ ltp: null }))).toBe(0);
  });
});

describe("markLive", () => {
  it("prices a put higher when NIFTY falls and lower when it rises", () => {
    const down = markLive(put(), live(22400));
    const up = markLive(put(), live(22500));
    expect(down.ltp!).toBeGreaterThan(up.ltp!);
    expect(down.pnl).toBeGreaterThan(up.pnl);
  });

  it("keeps the entry charges the engine already deducted", () => {
    const m = markLive(put(), live(22440));
    expect(rawUnrealized(m) - m.pnl).toBeCloseTo(27.89, 1);
    expect(m.pnl).toBeCloseTo((m.ltp! - 146.55) * 65 - 27.89, 1);
    expect(m.pnlPct).toBeCloseTo((m.pnl / (146.55 * 65)) * 100, 1);
  });

  it("stamps the live time and is stable when applied twice", () => {
    const once = markLive(put(), live(22440));
    const twice = markLive(once, live(22440));
    expect(once.ltpAsOf).toBe("2026-10-08T11:10:00+05:30");
    expect(twice.ltp).toBe(once.ltp);
    expect(twice.pnl).toBeCloseTo(once.pnl, 1);
  });

  it("leaves the position alone without a usable price", () => {
    const p = put();
    expect(markLive(p, null)).toBe(p);
    expect(markLive(p, live(22440, null))).toBe(p);
    expect(markLive(p, live(0))).toBe(p);
    const unmarked = put({ ltp: null });
    expect(markLive(unmarked, live(22440))).toBe(unmarked);
  });
});
