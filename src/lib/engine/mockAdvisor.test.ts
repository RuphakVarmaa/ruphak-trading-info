import { describe, expect, it } from "vitest";
import { MockEngineApi } from "./mock";
import { buildMockAdvisorReport, loadMockAdvisorMarket, MOCK_MIN_GAP_MS, MOCK_QUEUE_MS, MOCK_RUN_MS, MockAdvisor, type MockAdvisorMarket } from "./mockAdvisor";

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
    }
    if (r.today.action === "BUY") expect(r.ideas.some((i) => i.id === r.today.ideaId)).toBe(true);
    for (const s of r.sources) expect(s.url.startsWith("/")).toBe(true);
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
