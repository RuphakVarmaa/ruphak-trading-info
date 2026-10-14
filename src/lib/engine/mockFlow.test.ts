import { describe, expect, it } from "vitest";
import { istAt } from "@/lib/ist";
import { MockEngineApi } from "./mock";
import { mockFlowSnapshots, mockOptionFlow, mockPath, mockRecommendation } from "./mockFlow";
import { mockSetups } from "./mockSetups";

const noHolidays = () => false;
const NOW = istAt("2026-10-14", "11:42") + 20_000;
const input = { index: "NIFTY" as const, nowMs: NOW, spot: 22646.35, open: 22563, prevSpot: 22518.1, isHoliday: noHolidays };

describe("mock option flow", () => {
  it("walks from the open to the current spot, one point a minute", () => {
    const p = mockPath("NIFTY", "2026-10-14", 22563, 22646.35, 147);
    expect(p).toHaveLength(148);
    expect(p[0]).toBeCloseTo(22563, 6);
    expect(p[147]).toBeCloseTo(22646.35, 6);
  });

  it("samples the session so far, never ahead of now", () => {
    const snaps = mockFlowSnapshots(input);
    expect(snaps).toHaveLength(148);
    expect(snaps[snaps.length - 1].t).toBeLessThanOrEqual(NOW);
    expect(snaps[0].rows).toHaveLength(31);
    // Cumulative volume never falls.
    const vol = snaps.map((s) => s.rows[15].ce!.volume!);
    for (let i = 1; i < vol.length; i++) expect(vol[i]).toBeGreaterThanOrEqual(vol[i - 1]);
  });

  it("runs the engine's flow monitor and says it is synthetic", () => {
    const v = mockOptionFlow(input);
    expect(v.source).toBe("mock");
    expect(v.note).toContain("not market data");
    expect(v.minutes).toBe(148);
    expect(v.windows["15m"].from).not.toBeNull();
    expect(v.events.length).toBeGreaterThan(0);
    expect(v.summary.pcr).toBeGreaterThan(0);
    expect(v.summary.resistance).not.toBeNull();
  });

  it("recommends with the engine's recommend() and never claims a measured edge", () => {
    const r = mockRecommendation({ ...input, setups: mockSetups("NIFTY", input.spot, NOW).setups ?? [] });
    expect(r.index).toBe("NIFTY");
    expect(r.grade).not.toBe("A");
    expect(r.honest).toBeTruthy();
    expect(r.historical.verdict).toBe("none");
    if (r.contract) {
      expect(r.contract.priceSource).toBe("mock");
      // Never the contract expiring today, at least 4 calendar days out.
      expect(r.contract.expiry > "2026-10-17").toBe(true);
    }
  });

  it("serves getOptionFlow and attaches a recommendation to every signal", async () => {
    const api = new MockEngineApi("sim");
    const flow = await api.getOptionFlow("SENSEX");
    expect(flow).toMatchObject({ index: "SENSEX", source: "mock", lotSize: 20 });
    const signals = await api.getSignals();
    for (const s of signals) expect(s.recommendation?.index).toBe(s.index);
  });
});
