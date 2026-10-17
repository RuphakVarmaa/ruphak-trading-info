import { describe, expect, it } from "vitest";
import { SNAPSHOT_TOKEN_LIMIT } from "@/engine/agent/constants";
import { BUILTIN_GUIDANCE, instructionVersion } from "@/engine/agent/prompt";
import { istAt } from "@/lib/ist";
import { MockEngineApi } from "./mock";
import { MockAgent, MOCK_AGENT_MODEL } from "./mockAgent";
import type { AgentCandidateCardView, AgentSizingView } from "./types";

/** Fri 16 Oct 2026 (a trading day): 11:42 is the mock engine's simulated start; 17:00 is after the close. */
const DAY = "2026-10-16";
const at = (hhmm: string, date = DAY) => istAt(date, hhmm);
const clock = (t: number) => () => t;

describe("MockAgent view", () => {
  it("shows both index cards with one decision per finalist, the honesty text and demo labels", () => {
    const v = new MockAgent(clock(at("11:42:05"))).view();
    expect(v.mode).toBe("shadow");
    expect(v.enabled).toBe(true);
    expect(v.date).toBe(DAY);
    expect(v.honesty).toMatch(/^Demo data/);
    expect(v.honesty).toMatch(/no edge for option buyers/);
    expect(v.models.reflex).toBe(MOCK_AGENT_MODEL);
    expect(v.models.reflex).toMatch(/demo/);
    expect(v.status.state).toBe("RUNNING");
    expect(v.status.lastBarAt).toBe("2026-10-16T11:40:00+05:30");
    expect(v.indices.map((c) => c.index)).toEqual(["NIFTY", "SENSEX"]);
    const [nifty, sensex] = v.indices;
    expect(nifty.barAt).toBe("2026-10-16T11:40:00+05:30");
    // NIFTY has its generic finalist and the demo idea; SENSEX its generic finalist.
    expect(nifty.decisions.map((d) => v.finalists.find((f) => f.id === d.finalistId)?.kind)).toEqual(["GENERIC", "IDEA"]);
    expect(sensex.decisions).toHaveLength(1);
    expect(v.finalists.filter((f) => f.kind === "IDEA")).toHaveLength(1);
    for (const card of v.indices) {
      expect(card.snapshot?.length).toBeGreaterThan(30);
      expect(card.snapshotTokensEst).toBeGreaterThan(100);
      expect(card.snapshotTokensEst).toBeLessThan(SNAPSHOT_TOKEN_LIMIT);
      expect(card.position).toBeNull();
    }
  });

  it("tells the showcase story: one call passes the model-side checks but Kelly sizes nothing, as the engine records it; the others are blocked", () => {
    const v = new MockAgent(clock(at("11:42:05"))).view();
    const [generic, idea] = v.indices[0].decisions;
    // As the engine: Kelly ≤ 0 is a failed kelly line after the 11 gate lines, so the gate did not fire.
    expect(generic.gate?.fired).toBe(false);
    expect(generic.gate?.lines).toHaveLength(12);
    expect(generic.gate?.lines.filter((l) => l.passed === false).map((l) => l.gate)).toEqual(["kelly"]);
    expect(generic.gate?.lines.at(-1)?.words).toBe("Size zero: confident past calls have not cleared break-even yet (p 0.43, b 1.00, Kelly −0.14)");
    expect(generic.gate?.summary).toBe("Blocked: size zero");
    const sizing: AgentSizingView | null = generic.sizing;
    expect(sizing).toMatchObject({ riskPct: 0, lots: 0, n: 21 });
    expect(generic.sizing!.kelly).toBeLessThan(0);
    expect(generic.action).toBe("NO_ENTRY");
    expect(generic.actionDetail).toBe("Kelly ≤ 0: past calls have not cleared break-even (p=0.43, b=1.00)");
    // The generic finalist is labelled as the engine labels it.
    expect(v.finalists.find((f) => f.id === generic.finalistId)?.label).toBe("NIFTY, either side (generic call)");
    expect(idea.gate?.fired).toBe(false);
    expect(idea.gate?.lines.filter((l) => l.passed === false).map((l) => l.gate)).toEqual(["setup_quality", "confidence"]);
    expect(idea.sizing).toBeNull();
    // SENSEX's decision is the deep model's answer to the 11:35 escalation, applied to the 11:40 candle.
    const sensex = v.indices[1].decisions[0];
    expect(sensex.source).toBe("ESCALATION");
    expect(sensex.direction).toBe("NEUTRAL");
    expect(v.escalations).toHaveLength(1);
    expect(v.escalations[0]).toMatchObject({ status: "DONE", trigger: "LOW_CONFIDENCE", index: "SENSEX", appliedToBarAt: "2026-10-16T11:40:00+05:30" });
    // Nothing traded: the demo is honest about sizing at zero.
    expect(v.calibration.sizingP!).toBeLessThan(0.5);
    expect(v.calibration.trades.n).toBe(0);
    expect(v.cost.spentUsd).toBe(0);
  });

  it("is deterministic from the clock", () => {
    const a = new MockAgent(clock(at("13:07:10"))).view();
    const b = new MockAgent(clock(at("13:07:10"))).view();
    expect(b).toEqual(a);
    expect(a.indices[0].barAt).toBe("2026-10-16T13:05:00+05:30");
  });

  it("never shows a confident-looking call that the code gate would let through on a low-confidence good setup without an escalation", () => {
    for (let t = at("09:22"); t <= at("15:10"); t += 5 * 60_000) {
      const v = new MockAgent(clock(t)).view();
      for (const card of v.indices)
        for (const d of card.decisions) {
          if (d.directionConfidence < 0.6 && d.setupQuality >= 2) expect(d.barAt).toBe("2026-10-16T11:35:00+05:30");
          // Every acted-on decision in the demo ends in no trade: a gate line blocked it, or Kelly sized nothing; either
          // way the gate did not fire, so the page never says "All checks passed" on an untraded decision.
          if (d.action) {
            expect(d.action).toBe("NO_ENTRY");
            expect(d.gate?.fired).toBe(false);
          }
          if (d.gate?.lines.some((l) => l.gate === "kelly")) expect(d.sizing?.riskPct).toBe(0);
          expect(card.snapshotTokensEst!).toBeLessThan(SNAPSHOT_TOKEN_LIMIT);
        }
    }
  });

  it("waits before the first candle and is closed after the session", () => {
    const early = new MockAgent(clock(at("09:10"))).view();
    expect(early.status.state).toBe("WAITING");
    expect(early.indices.every((c) => c.decisions.length === 0 && c.barAt == null)).toBe(true);
    expect(early.escalations).toEqual([]);
    const late = new MockAgent(clock(at("17:00"))).view();
    expect(late.status.state).toBe("CLOSED");
    // Each card shows the candle its decisions were made on; bars after 15:05 are stored for grading only, up to 15:25.
    expect(late.indices[0].barAt).toBe("2026-10-16T15:05:00+05:30");
    expect(late.indices[0].decisions.every((d) => d.barAt === late.indices[0].barAt)).toBe(true);
    expect(late.status.lastBarAt).toBe("2026-10-16T15:25:00+05:30");
    // After 16:23 the day's own review is shown.
    expect(late.review?.date).toBe(DAY);
    expect(new MockAgent(clock(at("11:42"))).view().review?.date).toBe("2026-10-15");
  });

  it("stops judging once the last candle (15:05) is too old to act on: closed from 15:09, as the engine", () => {
    expect(new MockAgent(clock(at("15:08:30"))).view().status.state).toBe("RUNNING");
    expect(new MockAgent(clock(at("15:09:30"))).view().status.state).toBe("CLOSED");
    expect(new MockAgent(clock(at("15:26"))).view().status.state).toBe("CLOSED");
  });

  it("blocks entries in the gate while either kill switch is on, as the engine's entry_mode line does", () => {
    const entryLines = (v: ReturnType<MockAgent["view"]>) => v.indices.flatMap((c) => c.decisions.flatMap((d) => d.gate?.lines ?? [])).filter((l) => l.gate === "entry_mode");
    const own = new MockAgent(clock(at("11:42:05"))).view(undefined, null, { killSwitch: true, killReason: "manual stop", mainKillSwitch: false });
    expect(entryLines(own).length).toBeGreaterThan(0);
    expect(entryLines(own).every((l) => l.passed === false && l.words === "Entries stopped: the agent's kill switch is on (manual stop)")).toBe(true);
    const main = new MockAgent(clock(at("11:42:05"))).view(undefined, null, { killSwitch: false, killReason: null, mainKillSwitch: true });
    expect(entryLines(main).every((l) => l.passed === false && l.words === "Entries stopped: main's kill switch is on")).toBe(true);
    expect(entryLines(new MockAgent(clock(at("11:42:05"))).view()).every((l) => l.passed === true)).toBe(true);
  });

  it("shows the decisions before they are acted on as not acted on yet", () => {
    const v = new MockAgent(clock(at("11:41:40"))).view();
    expect(v.indices[0].barAt).toBe("2026-10-16T11:40:00+05:30");
    expect(v.indices[0].decisions.every((d) => d.gate == null && d.action == null)).toBe(true);
  });

  it("is empty when switched off", () => {
    const v = new MockAgent(clock(at("11:42")), { mode: "off" }).view();
    expect(v.mode).toBe("off");
    expect(v.status.state).toBe("OFF");
    expect(v.indices.every((c) => c.decisions.length === 0)).toBe(true);
  });
});

describe("MockAgent candidate and re-arm", () => {
  it("lists a pending candidate whose replay is labelled in-sample, not proof, with the engine's new fields", () => {
    const v = new MockAgent(clock(at("11:42"))).view();
    expect(v.candidate).toMatchObject({ id: "cand-2026-10-15", status: "PENDING", decidedAt: null, decidedBy: null });
    expect(v.candidate?.replay?.label).toBe("in-sample, not proof");
    expect(v.candidate?.guidance).not.toBe(v.candidate?.currentGuidance);
    const c: AgentCandidateCardView = v.candidate!;
    expect(c.baseGuidance).toBe(BUILTIN_GUIDANCE);
    expect(c.inUse).toBe(false);
    // All three Brier scores are over the calls every run labelled; graded equals that common count.
    expect(c.replay).toMatchObject({ bars: 75, barsTotal: 75, graded: 58, gradedCandidate: 58, gradedCurrent: 66, gradedLive: 64, gradedCommon: 58, stopReason: null, complete: true });
  });

  it("refuses approval in the session and from the close until the day's review and replay finish, then accepts it; the active version changes", () => {
    let now = at("11:42");
    const agent = new MockAgent(() => now);
    const before = agent.view();
    const id = before.candidate!.id;
    expect(agent.decideCandidate(id, "approve", "test")).toEqual({
      ok: false,
      message: "approve before 09:15 IST, or after today's review and replay finish (about 16:20–16:45 IST), so one session is judged by one text",
    });
    expect(agent.view().candidate?.status).toBe("PENDING");
    // flow.test.ts: an approval at 15:45 made the 16:20 review and its replay judge a text the session never ran with.
    now = at("15:45");
    expect(agent.decideCandidate(id, "approve", "test")).toEqual({
      ok: false,
      message: "approve after today's review and replay finish (about 16:20–16:45 IST); if no review runs today, approve before 09:15 tomorrow",
    });
    expect(agent.view().candidate?.status).toBe("PENDING");
    // Rejecting is allowed at any time: it changes no text.
    expect(new MockAgent(() => at("15:45")).decideCandidate(id, "reject", "test").ok).toBe(true);
    // Once the day's review and replay have finished (the demo writes the day's candidate at 16:31), it can be approved.
    now = at("16:45");
    const todays = agent.view().candidate!;
    expect(todays.id).toBe("cand-2026-10-16");
    expect(agent.decideCandidate(todays.id, "approve", "test").ok).toBe(true);
    const after = agent.view();
    const c: AgentCandidateCardView = after.candidate!;
    // The approved card diffs against the text it was written against, never against itself.
    expect(c).toMatchObject({ status: "APPROVED", decidedBy: "test", inUse: true, baseGuidance: BUILTIN_GUIDANCE });
    expect(c.currentGuidance).toBe(c.guidance);
    expect(c.baseGuidance).not.toBe(c.guidance);
    expect(c.decidedAt).toBe("2026-10-16T16:45:00+05:30");
    expect(after.instructionVersion).not.toBe(before.instructionVersion);
    expect(after.instructionVersion).toBe(instructionVersion(c.guidance));
    // Decided once: a second decision is refused.
    expect(agent.decideCandidate(todays.id, "reject", "test").ok).toBe(false);
  });

  it("allows approval before the open, and keeps the approved candidate as the newest once later sessions ran with its text", () => {
    let now = at("09:05");
    const agent = new MockAgent(() => now);
    expect(agent.decideCandidate("cand-2026-10-15", "approve", "test").ok).toBe(true);
    // 16 Oct ran with the approved text, so its review proposes nothing new: the approved candidate stays the newest.
    now = at("17:00");
    const c: AgentCandidateCardView = agent.view().candidate!;
    expect(c).toMatchObject({ id: "cand-2026-10-15", status: "APPROVED", inUse: true });
    // Only the candidate the page shows can be decided.
    expect(agent.decideCandidate("cand-2026-10-16", "reject", "test")).toEqual({ ok: false, message: "No candidate with that id is waiting." });
  });

  it("rejects at any time, and refuses an unknown id", () => {
    const agent = new MockAgent(clock(at("11:42")));
    expect(agent.decideCandidate("cand-1999-01-01", "reject", "test").ok).toBe(false);
    expect(agent.decideCandidate("cand-2026-10-15", "reject", "test").ok).toBe(true);
    expect(agent.view().candidate?.status).toBe("REJECTED");
  });

  it("re-arm clears the drawdown halt and restarts the peak at the current equity", () => {
    const agent = new MockAgent(clock(at("11:42")), { drawdownHalt: true });
    const halted = agent.view();
    expect(halted.risk.drawdownHalt).toBe(true);
    expect(halted.risk.killSwitch).toBe(true);
    expect(halted.risk.drawdownPct!).toBeGreaterThanOrEqual(15);
    expect(halted.risk.codeRiskState).toBe("REDUCE");
    // While halted, every decision is blocked by the halt line.
    const lines = halted.indices.flatMap((c) => c.decisions.flatMap((d) => d.gate?.lines ?? []));
    expect(lines.filter((l) => l.gate === "entry_mode").every((l) => l.passed === false)).toBe(true);
    expect(agent.rearm("test")).toEqual({ ok: true, message: "Agent re-armed: kill switch off; peak equity restarts at ₹424100" });
    const rearmed = agent.view();
    expect(rearmed.risk.drawdownHalt).toBe(false);
    expect(rearmed.risk.killSwitch).toBe(false);
    expect(rearmed.risk.drawdownPct).toBe(0);
    expect(rearmed.risk.peakEquity).toBe(rearmed.risk.equity);
    expect(rearmed.risk.codeRiskState).toBe("SAFE");
  });

  it("re-arm is refused while main's kill switch is on, and without a halt keeps the peak", () => {
    const agent = new MockAgent(clock(at("11:42")), { drawdownHalt: true });
    expect(agent.rearm("test", true)).toEqual({ ok: false, message: "Agent: main's kill switch is on and would engage the agent's again; reset main first" });
    expect(agent.view().risk.drawdownHalt).toBe(true);
    const flat = new MockAgent(clock(at("11:42")));
    expect(flat.rearm("test")).toEqual({ ok: true, message: "Agent re-armed: kill switch off; drawdown still measured from ₹500000" });
    expect(flat.view().risk.peakEquity).toBe(500_000);
  });

  it("overlays the account kill switches it is given", () => {
    const v = new MockAgent(clock(at("11:42"))).view(undefined, null, { killSwitch: true, killReason: "main kill switch engaged at 11:30", mainKillSwitch: true });
    expect(v.risk).toMatchObject({ killSwitch: true, killReason: "main kill switch engaged at 11:30", mainKillSwitch: true, drawdownHalt: false });
  });
});

describe("the mock engine's agent account", () => {
  /** The mock engine on its simulated clock: 11:42 IST on the latest trading day, so the session is open. */
  const engine = () => {
    const api = new MockEngineApi("sim");
    api.configure({ adminToken: "t", fail: false });
    return api;
  };

  it("lists the agent's own paper account, marked as the agent's, and leaves the other accounts without a kind", async () => {
    const api = engine();
    const state = await api.getState();
    expect(state.account?.kind).toBeUndefined();
    expect(state.accounts?.find((a) => a.id === "agent")).toMatchObject({ label: "Agent ₹5L", shortLabel: "Agent", kind: "agent", paperOnly: true, capitalRupees: 500_000 });
    expect(state.accounts?.filter((a) => a.id !== "agent").every((a) => a.kind === undefined)).toBe(true);
    const own = await api.getState("agent");
    expect(own.mode).toBe("PAPER");
    expect(own.caps).toMatchObject({ dailyLossCap: 15_000, maxPositions: 2, openPositions: 0 });
    expect(await api.getPositions("agent")).toEqual([]);
    expect((await api.getPnl(30, "agent")).today.net).toBe(0);
  });

  it("refuses copy tickets for the agent's account, as the engine does", async () => {
    await expect(engine().getCopyTickets("2026-10-16", "agent")).rejects.toThrow(/^BAD_REQUEST/);
  });

  it("serves the agent view with its account and checks the admin token and the input", async () => {
    const api = engine();
    const v = await api.getAgent();
    expect(v.account?.id).toBe("agent");
    expect(v.models.reflex).toMatch(/demo/);
    await expect(api.getAgent("16-10-2026")).rejects.toThrow(/^BAD_REQUEST/);
    await expect(api.rearmAgent("wrong", "test")).rejects.toThrow(/^UNAUTHORIZED/);
    await expect(api.setAgentCandidate("t", "bad id!", "approve", "test")).rejects.toThrow(/^BAD_REQUEST/);
  });

  it("engages the agent's kill switch with main's, keeps it when main is reset, and re-arm clears it", async () => {
    const api = engine();
    await api.setKillSwitch("t", { engaged: true, squareOff: false, reason: "test" }, "test");
    expect((await api.getAgent()).risk).toMatchObject({ killSwitch: true, mainKillSwitch: true });
    await api.setKillSwitch("t", { engaged: false, squareOff: false, reason: "reset" }, "test");
    const after = await api.getAgent();
    expect(after.risk).toMatchObject({ killSwitch: true, mainKillSwitch: false });
    expect(after.risk.killReason).toMatch(/^main kill switch engaged at \d\d:\d\d$/);
    const rearmed = await api.rearmAgent("t", "test");
    expect(rearmed.risk.killSwitch).toBe(false);
    expect((await api.getState("agent")).killSwitch).toBe(false);
  });

  it("refuses re-arm while main's kill switch is on, as the engine does (it would engage the agent's again)", async () => {
    const api = engine();
    await api.setKillSwitch("t", { engaged: true, squareOff: false, reason: "test" }, "test");
    await expect(api.rearmAgent("t", "test")).rejects.toThrow(/^CONFLICT: Agent: main's kill switch is on/);
    expect((await api.getAgent()).risk).toMatchObject({ killSwitch: true, mainKillSwitch: true });
  });

  it("refuses approval during the session with the engine's reason, and accepts a rejection", async () => {
    const api = engine();
    const id = (await api.getAgent()).candidate!.id;
    await expect(api.setAgentCandidate("t", id, "approve", "test")).rejects.toThrow(/^CONFLICT: approve before 09:15 IST, or after today's review and replay finish/);
    expect((await api.setAgentCandidate("t", id, "reject", "test")).candidate).toMatchObject({ status: "REJECTED", decidedBy: "test" });
  });
});
