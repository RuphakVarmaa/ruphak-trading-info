import { describe, expect, it } from "vitest";
import { MemoryAgentStore } from "./store";
import { agentSample as s, agentStoreContract } from "./storeContract";

agentStoreContract("memory", async () => new MemoryAgentStore());

// The two rules below join the contract (storeContract.ts) once the SQL store has them too.
describe("MemoryAgentStore", () => {
  it("returns the stored text of any guidance version, active or not, and null for one never stored", async () => {
    const st = new MemoryAgentStore();
    await st.putInstruction(s.instruction({ version: "v-builtin", guidance: "- built-in text", active: true }));
    await st.putInstruction(s.instruction({ version: "v-cand", guidance: "- the candidate's text", source: "CANDIDATE", candidateId: "cand-1", active: true }));
    expect(await st.instruction!("v-builtin")).toEqual(s.instruction({ version: "v-builtin", guidance: "- built-in text", active: false }));
    expect((await st.instruction!("v-cand"))?.guidance).toBe("- the candidate's text");
    expect(await st.instruction!("v-unknown")).toBeNull();
    // A copy: changing it changes nothing stored.
    const got = (await st.instruction!("v-cand"))!;
    got.guidance = "changed";
    expect((await st.instruction!("v-cand"))?.guidance).toBe("- the candidate's text");
  });

  it("never lists a code-made row among the graded calls (it is not a forecast)", async () => {
    const st = new MemoryAgentStore();
    await st.putDecisions([
      s.decision({ id: "model", outcome: s.outcome({ status: "HIT", y: 1, paid: true }) }),
      s.decision({ id: "code-dir", barCloseMs: s.decision().barCloseMs + 300_000, codeMade: true, outcome: s.outcome({ status: "MISS", y: 0, paid: false }) }),
      s.decision({ id: "neutral", direction: "NEUTRAL", directionConfidence: 0.45, outcome: s.outcome({ status: "NEUTRAL", y: 1, paid: null }) }),
      s.decision({ id: "code-neutral", direction: "NEUTRAL", directionConfidence: 0.5, source: "ESCALATION", codeMade: true, outcome: s.outcome({ status: "NEUTRAL", y: 0, paid: null }) }),
    ]);
    expect((await st.graded("2026-10-01")).map((g) => g.id)).toEqual(["model"]);
    expect((await st.gradedNeutral("2026-10-01")).map((g) => g.id)).toEqual(["neutral"]);
    // The rows themselves stay stored and listed by date.
    expect((await st.decisions("2026-10-19")).map((d) => d.id).sort()).toEqual(["code-dir", "code-neutral", "model", "neutral"]);
  });
});
