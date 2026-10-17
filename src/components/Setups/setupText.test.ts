import { describe, expect, it } from "vitest";
import type { TradeSetupView } from "@/engine/api-types";
import { alertKey, setupCopyText, shortExpiry, tradeLine, triggerProximity } from "./setupText";

const s = {
  id: "2026-10-14:NIFTY:ORB:BULL",
  index: "NIFTY",
  side: "BULL",
  status: "WATCHING",
  spot: 22512,
  condition: "a 5-min candle closes above 22,540",
  stop: 22506,
  t1: 22600,
  t2: 22650,
  invalidation: "a 5-min close back below 22,540",
  distance: 28,
  atr: 22,
  option: { contract: { strike: 22500, optionType: "CE", expiry: "2026-10-20", lotSize: 65 }, entry: 125.85, stop: 105.2, stopPct: -16.4, t1: 158.3, t2: 185 },
} as unknown as TradeSetupView;

describe("setup text", () => {
  it("writes the trade like a trader's note", () => {
    expect(shortExpiry("2026-10-20")).toBe("20-Oct");
    expect(tradeLine(s)).toBe("BUY NIFTY 22500 CE 20-Oct · 1 lot = 65 qty · enter when a 5-min candle closes above 22,540 (now 22,512)");
    expect(setupCopyText(s)).toContain("stop 105.20 (-16.4%)");
  });

  it("measures how close the price is to the trigger", () => {
    expect(triggerProximity({ distance: 0, atr: 22, spot: 22512 })).toBe(1);
    expect(triggerProximity({ distance: -5, atr: 22, spot: 22512 })).toBe(1);
    expect(triggerProximity({ distance: 1000, atr: 22, spot: 22512 })).toBe(0);
    expect(triggerProximity({ distance: 27.0144, atr: 22, spot: 22512 })).toBeCloseTo(0.5, 2);
  });

  it("keys alerts by setup and status, only for READY and TRIGGERED", () => {
    expect(alertKey(s)).toBeNull();
    expect(alertKey({ id: "x", status: "READY" })).toBe("x|READY");
    expect(alertKey({ id: "x", status: "TRIGGERED" })).toBe("x|TRIGGERED");
  });
});
