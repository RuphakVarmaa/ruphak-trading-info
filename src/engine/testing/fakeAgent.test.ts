import { describe, expect, it } from "vitest";
import { AGENT_DEFAULTS } from "../agent/config";
import { EscalationSchema } from "../agent/schema";
import type { Finalist, IndexSnapshot, ReflexDecision, ReflexInput } from "../agent/types";
import { istAt, istIso } from "../clock";
import { FAKE_DEEP_USAGE, FAKE_REFLEX_USAGE, FakeDeepJudge, FakeReflexJudge, fakeBrief, fakeFlowView } from "./fakeAgent";

const T = istAt("2026-10-19", "10:35");
const snap = {} as IndexSnapshot;
const input = (snapshots: ReflexInput["snapshots"] = { NIFTY: snap, SENSEX: snap }): ReflexInput => ({ barCloseMs: T, date: "2026-10-19", builtMs: T, snapshots, tokensEst: {}, closes: {}, problems: [] });
const generic = (index: "NIFTY" | "SENSEX"): Finalist => ({
  id: `gen:${index}`, kind: "GENERIC", index, label: index, side: null, contract: null, entryHigh: null,
  condition: null, wrongIf: null, bearCase: null, why: [], horizon: null, briefId: null,
});
const d = (p: Partial<ReflexDecision> = {}): ReflexDecision => ({
  finalistId: "gen:NIFTY", regime: "TRENDING", direction: "LONG", directionConfidence: 0.9, toxicFlow: false, setupQuality: 3, riskState: "SAFE", reason: "test", ...p,
});
const req = (p: Partial<Parameters<FakeReflexJudge["judge"]>[0]> = {}) => ({ input: input(), finalists: [generic("NIFTY"), generic("SENSEX")], brief: null, guidance: "", ...p });

describe("FakeReflexJudge", () => {
  it("answers from its function, validated as the real judge does, and records every call", async () => {
    const judge = new FakeReflexJudge(() => [d(), d({ finalistId: "gen:SENSEX", directionConfidence: 1.3 }), d({ finalistId: "gen:OTHER" })]);
    const r = await judge.judge(req());
    expect(r).toEqual({
      status: "OK",
      decisions: [d()],
      dropped: ["gen:SENSEX: confidence 1.3 is outside 0..1", "gen:OTHER: not a finalist"],
      usage: FAKE_REFLEX_USAGE,
      model: AGENT_DEFAULTS.reflexModel,
      latencyMs: 1_200,
      error: null,
    });
    expect(judge.kind).toBe("fake");
    expect(judge.calls).toHaveLength(1);
  });

  it("asks only about finalists on an index with a snapshot", async () => {
    const judge = new FakeReflexJudge(() => [d(), d({ finalistId: "gen:SENSEX" })]);
    const r = await judge.judge(req({ input: input({ NIFTY: snap }) }));
    expect(r.decisions.map((x) => x.finalistId)).toEqual(["gen:NIFTY"]);
    expect((await judge.judge(req({ input: input({}) }))).status).toBe("ERROR");
  });

  it("turns each failure into the status the real judge reports", async () => {
    const status = async (a: "fail" | "refuse" | "timeout" | "parse_error") => {
      const r = await new FakeReflexJudge(() => a).judge(req());
      return [r.status, r.usage === null, r.decisions.length];
    };
    expect(await status("fail")).toEqual(["ERROR", true, 0]);
    expect(await status("timeout")).toEqual(["TIMEOUT", true, 0]);
    expect(await status("refuse")).toEqual(["REFUSED", false, 0]);
    expect(await status("parse_error")).toEqual(["PARSE_ERROR", false, 0]);
    expect((await new FakeReflexJudge(() => []).judge(req())).status).toBe("PARSE_ERROR");
    const ac = new AbortController();
    ac.abort();
    expect((await new FakeReflexJudge(() => [d()]).judge(req({ signal: ac.signal }))).status).toBe("TIMEOUT");
  });

  it("takes its usage, latency and model from the options", async () => {
    const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 };
    const r = await new FakeReflexJudge(() => [d()], { usage, latencyMs: 5, model: "fake-model" }).judge(req());
    expect(r).toMatchObject({ usage, latencyMs: 5, model: "fake-model" });
  });
});

describe("FakeDeepJudge", () => {
  const ask = (answer: unknown) => new FakeDeepJudge(() => answer).structured({ system: "s", user: "u", effort: "medium", maxTokens: 10, timeoutMs: 10, schema: EscalationSchema });

  it("checks the answer against the request's schema", async () => {
    const good = { decision: d(), reason: "test" };
    expect(await ask(good)).toMatchObject({ status: "OK", parsed: good, usage: FAKE_DEEP_USAGE, model: AGENT_DEFAULTS.escalationModel, error: null });
    expect(await ask({ decision: d(), reason: 5 })).toMatchObject({ status: "PARSE_ERROR", parsed: null });
  });

  it("turns each failure into a status", async () => {
    expect(await ask("fail")).toMatchObject({ status: "ERROR", usage: null });
    expect(await ask("timeout")).toMatchObject({ status: "TIMEOUT", usage: null });
    expect(await ask("refuse")).toMatchObject({ status: "REFUSED", usage: FAKE_DEEP_USAGE });
    expect(await ask("max_tokens")).toMatchObject({ status: "MAX_TOKENS", usage: FAKE_DEEP_USAGE });
  });

  it("records every request", async () => {
    const judge = new FakeDeepJudge(() => "fail");
    await judge.structured({ system: "s", user: "first", effort: "high", maxTokens: 10, timeoutMs: 10, schema: EscalationSchema });
    expect(judge.calls.map((c) => c.user)).toEqual(["first"]);
  });
});

describe("fakeFlowView", () => {
  it("builds an at-the-money view on the index's strike step, with the spread, IV and put-call ratio asked for", () => {
    const v = fakeFlowView("NIFTY", 25_012, T - 58_000, { spreadPct: 1, iv: 14, pcr: 1.2 });
    expect(v).toMatchObject({ index: "NIFTY", source: "feed", atm: 25_000, step: 50, lotSize: 65, spot: 25_012, asOf: istIso(T - 58_000) });
    const atm = v.windows["1m"].rows.find((r) => r.strike === 25_000)!;
    expect(atm.ce!.ask! - atm.ce!.bid!).toBeCloseTo(atm.ce!.ltp! * 0.01, 1);
    expect(atm.pe!.iv).toBe(14);
    expect(v.summary.pcr).toBeCloseTo(1.2, 2);
    expect(v.summary.resistance!.strike).toBe(25_200);
    expect(v.summary.support!.strike).toBe(24_800);
    expect(v.windows["5m"].rows).toHaveLength(21);
    expect(v.expiry! > "2026-10-19").toBe(true);
    const s = fakeFlowView("SENSEX", 82_040, T);
    expect([s.atm, s.step, s.lotSize]).toEqual([82_000, 100, 20]);
  });
});

describe("fakeBrief", () => {
  it("fills each idea from a call expiring a week later, overridable field by field", () => {
    const b = fakeBrief("2026-10-19T09:25:00+05:30", [{}, { horizon: "WEEK", condition: null, bearCase: null }]);
    expect(b.id).toBe("adv-2026-10-19-1");
    expect(b.createdAt).toBe("2026-10-19T09:25:00+05:30");
    expect(b.ideas.map((i) => i.id)).toEqual(["adv-2026-10-19-1-1", "adv-2026-10-19-1-2"]);
    expect(b.ideas[0]).toMatchObject({ horizon: "TODAY", contract: { index: "NIFTY", expiry: "2026-10-26", optionType: "CE" }, condition: "Only if NIFTY holds above 25,000." });
    expect(b.ideas[1]).toMatchObject({ horizon: "WEEK", condition: null, bearCase: null });
    expect(b.factors).toHaveLength(2);
    expect(b.model).not.toContain(AGENT_DEFAULTS.escalationModel);
  });
});
