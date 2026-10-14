/** Tests for the dashboard's mock flow stub (dropped with mockFlowStub.ts once the engine's mock lands). */
import { describe, expect, it } from "vitest";
import type { SignalView } from "@/engine/api-types";
import { istAt } from "@/lib/ist";
import { buildMockChain, weeklyExpiries } from "./mockChain";
import { mockOptionFlow, mockRecommendation } from "./mockFlowStub";

const now = istAt("2026-10-14", "10:42");
const chainFor = (index: "NIFTY" | "SENSEX", spot: number) => (expiry?: string) =>
  Promise.resolve(buildMockChain({ index, spot, prevSpot: spot - 40, nowMs: now, expiries: weeklyExpiries(index, now, () => false), expiry }));

describe("mock option flow", () => {
  it("covers ATM±15 in every window and labels itself mock", async () => {
    const flow = mockOptionFlow(await chainFor("NIFTY", 22512.4)(), now);
    expect(flow.source).toBe("mock");
    expect(flow.atm).toBe(22500);
    for (const w of ["1m", "5m", "15m"] as const) expect(flow.windows[w].rows).toHaveLength(31);
    expect(flow.summary.resistance).not.toBeNull();
    expect(flow.summary.support).not.toBeNull();
    expect(flow.events.every((e) => e.text.endsWith("(mock)"))).toBe(true);
    expect(flow.bestEntryWindow?.window).toBe("09:30–11:15 IST");
  });
});

describe("mock recommendation", () => {
  const signal = (stance: SignalView["stance"], conviction: number) => ({ index: "NIFTY", stance, conviction, entryThreshold: 0.35, noPlanReason: null }) as unknown as SignalView;

  it("enters on a directional signal with one lot that fits ₹10,000, never today's expiry", async () => {
    const r = await mockRecommendation(signal("BULLISH", 0.62), chainFor("NIFTY", 22512.4), now);
    expect(r.status).toBe("ENTER");
    expect(r.contract?.optionType).toBe("CE");
    expect(r.contract?.expiry).not.toBe("2026-10-14");
    expect(r.lots).toBe(1);
    expect(r.costRupees).toBeLessThanOrEqual(10_000);
    expect(r.stop!.premium).toBeCloseTo(r.entry!.limit * 0.7, 0);
    expect(r.honestLine).toMatch(/^Mock engine/);
    expect(r.grade).toBe("C");
  });

  it("waits without a direction and says nothing to buy when the market is shut", async () => {
    expect((await mockRecommendation(signal("NEUTRAL", 0.08), chainFor("NIFTY", 22512.4), now)).status).toBe("WAIT");
    expect((await mockRecommendation(signal("BULLISH", 0.62), chainFor("NIFTY", 22512.4), istAt("2026-10-14", "16:00"))).status).toBe("NO_TRADE");
  });
});
