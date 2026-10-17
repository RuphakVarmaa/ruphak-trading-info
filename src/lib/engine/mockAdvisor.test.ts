import { describe, expect, it } from "vitest";
import { MockEngineApi } from "./mock";
import type { OptionChainView } from "@/engine/api-types";
import { buildMockAdvisorReport, deltaAtLevel, loadMockAdvisorMarket, MOCK_MIN_GAP_MS, MOCK_QUEUE_MS, MOCK_RUN_MS, MockAdvisor, type MockAdvisorMarket } from "./mockAdvisor";

async function market(): Promise<MockAdvisorMarket> {
  const api = new MockEngineApi("sim");
  api.configure({ adminToken: null, fail: false });
  return loadMockAdvisorMarket(api);
}

describe("mock advisor fixture", () => {
  it("builds a brief whose ideas are real contracts priced off the mock chain", async () => {
    const m = await market();
    const r = buildMockAdvisorReport(m, Date.parse("2026-10-16T12:41:00+05:30"));
    expect(r.model).toMatch(/mock/);
    expect(r.outlook).toHaveLength(6);
    expect(r.factors.map((f) => f.key)).toContain("SHORT_COVERING");
    expect(r.factors.find((f) => f.key === "FII_DII")?.reading).toBe("NO_DATA");
    expect(r.ideas.length).toBeGreaterThan(0);
    for (const idea of r.ideas) {
      const chain = m.chains[idea.contract.index].find((c) => c.expiry === idea.contract.expiry);
      const row = chain?.rows.find((x) => x.strike === idea.contract.strike);
      const side = idea.contract.optionType === "CE" ? row?.ce : row?.pe;
      expect(side?.ask).toBe(idea.entry.ask);
      expect(idea.stop).toBeLessThan(idea.entry.ask);
      expect(idea.target).toBeGreaterThan(idea.entry.ask);
      expect(idea.target - idea.entry.ask).toBeGreaterThanOrEqual(1.2 * (idea.entry.ask - idea.stop) - 0.1);
      expect(idea.maxLossPerLot).toBeGreaterThan((idea.entry.ask - idea.stop) * idea.contract.lotSize);
      expect(idea.probItm).toBe(Math.round(Math.abs(side?.delta ?? 0) * 100) / 100);
      // The break-even lies beyond the strike, so the chance of ending past it is no higher than the in-the-money chance.
      if (idea.probAboveBreakeven != null && idea.probItm != null) {
        expect(idea.probAboveBreakeven).toBeGreaterThanOrEqual(0);
        expect(idea.probAboveBreakeven).toBeLessThanOrEqual(idea.probItm + 0.01);
      }
    }
    expect(r.ideas.some((i) => i.probAboveBreakeven != null)).toBe(true);
    if (r.today.action === "BUY") expect(r.ideas.some((i) => i.id === r.today.ideaId)).toBe(true);
    // The month idea waits for its trigger, so demo mode shows the "Not a buy yet" warning; the others are a buy now.
    for (const idea of r.ideas) {
      if (idea.horizon === "MONTH") expect(idea.condition).toMatch(/^Only (if|once) (NIFTY|SENSEX) .*; otherwise skip it\.$/);
      else expect(idea.condition).toBeNull();
    }
    expect(r.ideas.some((i) => i.condition)).toBe(true);
    for (const s of r.sources) expect(s.url.startsWith("/")).toBe(true);
  });

  it("says the run cost nothing, words the headline plainly and never contradicts its own OI numbers", async () => {
    const m = await market();
    const r = buildMockAdvisorReport(m, Date.parse("2026-10-16T12:41:00+05:30"));
    expect(r.costUsd).toBe(0);
    if (r.today.action === "BUY") expect(r.headline).toMatch(/so at most one small (CALL|PUT) with a stop; SENSEX has no clear lean\.$/);
    const sc = r.factors.find((f) => f.key === "SHORT_COVERING");
    expect(sc?.detail).not.toMatch(/Writers are adding/);
    // NIFTY up: either call writers covered (call OI fell) or they did not (call OI rose); the line says which.
    if (sc && /with NIFTY \+/.test(sc.detail)) expect(sc.detail).toMatch(/call OI \(open contracts\) fell.*Call writers are covering|call OI \(open contracts\) rose.*call writers are not buying back/);
  });
});

describe("deltaAtLevel", () => {
  const chain = {
    rows: [
      { strike: 23300, ce: { delta: 0.3 }, pe: { delta: -0.7 } },
      { strike: 23200, ce: { delta: 0.5 }, pe: { delta: -0.5 } },
      { strike: 23400, ce: { delta: 0.15 }, pe: null },
    ],
  } as unknown as OptionChainView;

  it("interpolates |delta| between the strikes on either side of the level", () => {
    expect(deltaAtLevel(chain, 23250, "CE")).toBe(0.4);
    expect(deltaAtLevel(chain, 23200, "CE")).toBe(0.5);
    expect(deltaAtLevel(chain, 23225, "PE")).toBe(0.55);
  });

  it("returns null outside the listed strikes or where a delta is missing", () => {
    expect(deltaAtLevel(chain, 23150, "CE")).toBeNull();
    expect(deltaAtLevel(chain, 23450, "CE")).toBeNull();
    expect(deltaAtLevel(chain, 23350, "PE")).toBeNull();
  });
});

describe("mock advisor lifecycle", () => {
  it("queues, runs and writes a new brief, then rate-limits the next press", async () => {
    const m = await market();
    let now = Date.parse("2026-10-16T12:44:00+05:30");
    const advisor = new MockAdvisor(() => now);
    const load = async () => m;

    const first = await advisor.view(load);
    expect(first.status).toBe("idle");
    expect(first.latest).not.toBeNull();
    expect(first.nextAllowedAt).toBeNull();
    const firstId = first.latest?.id;

    const queued = await advisor.run(load);
    expect(queued.status).toBe("queued");
    expect(queued.runsToday).toBe(2);

    now += MOCK_QUEUE_MS;
    expect((await advisor.view(load)).status).toBe("running");
    // A second press while running changes nothing.
    expect((await advisor.run(load)).status).toBe("running");

    now += MOCK_RUN_MS;
    const done = await advisor.view(load);
    expect(done.status).toBe("idle");
    expect(done.latest?.id).not.toBe(firstId);
    expect(done.history[0].id).toBe(done.latest?.id);
    expect(done.history.some((h) => h.id === firstId)).toBe(true);

    const limited = await advisor.run(load);
    expect(limited.status).toBe("idle");
    expect(limited.nextAllowedAt).not.toBeNull();
    expect(Date.parse(limited.nextAllowedAt ?? "")).toBeGreaterThan(now);

    now += MOCK_MIN_GAP_MS;
    expect((await advisor.run(load)).status).toBe("queued");
  });
});
