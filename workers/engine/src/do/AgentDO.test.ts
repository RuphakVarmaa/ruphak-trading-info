/**
 * The AgentDO's own guards around approve and revert (AgentDO.ts), on node:sqlite in place of the Durable Object's
 * SQLite and with the Workers runtime module stubbed: refused during the session with the window that applies, and
 * outside it the brain's answer (its own refusals included) reaches the caller unchanged. A resubmitted bar comes back
 * with the snapshots stored first.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

import { AgentBrain } from "../../../../src/engine/agent/brain";
import type { IndexSnapshot, ReflexInput } from "../../../../src/engine/agent/types";
import type { AgentSql, AgentSqlValue } from "../agent/sqlAgentStore";
import { AgentDO } from "./AgentDO";

function nodeSql(): AgentSql {
  const db = new DatabaseSync(":memory:");
  return {
    exec<T extends Record<string, AgentSqlValue>>(query: string, ...bindings: AgentSqlValue[]) {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
        const rows = stmt.all(...bindings) as T[];
        return { toArray: () => rows };
      }
      stmt.run(...bindings);
      return { toArray: () => [] as T[] };
    },
  };
}

function agentDo(): AgentDO {
  const ctx = {
    storage: { sql: nodeSql(), getAlarm: async () => null, setAlarm: async () => {} },
    blockConcurrencyWhile: (f: () => Promise<void>) => f(),
  } as unknown as DurableObjectState;
  return new AgentDO(ctx, { ACCOUNTS: "main,agent", AGENT_MODE: "shadow", ENGINE_ENV: "test", DB: {}, KV: {} } as unknown as Env);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("approve and revert on the AgentDO", () => {
  it("are refused during the session, with the window when they are allowed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T06:30:00.000Z")); // Monday 12:00 IST
    const dO = agentDo();
    const decide = vi.spyOn(AgentBrain.prototype, "decideCandidate");
    const revert = vi.spyOn(AgentBrain.prototype, "revertToBuiltin");
    expect(await dO.decideCandidate("cand-1", "approve", "dashboard")).toEqual({
      ok: false,
      message: "approve before 09:15 IST, or after today's review and replay finish (about 16:20–16:45 IST), so one session is judged by one text",
    });
    expect(await dO.revertInstruction("ops")).toEqual({
      ok: false,
      message: "revert before 09:15 IST, or after today's review and replay finish (about 16:20–16:45 IST), so one session is judged by one text",
    });
    expect(decide).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
  });

  it("leave everything else to the brain and pass its answer through unchanged, its own refusals included", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T10:15:00.000Z")); // Monday 15:45 IST: after the close, before the review
    const dO = agentDo();
    const refusal = { ok: false, message: "approve after today's review and replay finish (about 16:20–16:45 IST); if no review runs today, approve before 09:15 tomorrow" };
    vi.spyOn(AgentBrain.prototype, "decideCandidate").mockResolvedValue(refusal);
    vi.spyOn(AgentBrain.prototype, "revertToBuiltin").mockResolvedValue({ ok: false, message: "revert refused by the brain" });
    expect(await dO.decideCandidate("cand-1", "approve", "dashboard")).toEqual(refusal);
    expect(await dO.revertInstruction("ops")).toEqual({ ok: false, message: "revert refused by the brain" });
  });

  it("let a reject through during the session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T06:30:00.000Z"));
    const dO = agentDo();
    expect(await dO.decideCandidate("cand-1", "reject", "dashboard")).toEqual({ ok: false, message: "no candidate cand-1" });
  });
});

describe("a bar sent to the AgentDO twice", () => {
  it("comes back the second time as a duplicate with the snapshots stored first, the ones the model judges", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T04:35:40.000Z")); // Monday 10:05:40 IST
    const dO = agentDo();
    const T = Date.parse("2026-10-19T04:35:00.000Z"); // the 10:05 IST close
    // TE's first send timed out on its side; its second copy's flow read failed, so that copy has no option block.
    const first: ReflexInput = { barCloseMs: T, date: "2026-10-19", builtMs: T + 40_000, snapshots: { NIFTY: { c: 25_000, o: { oa: 30, cs: 0.6, ps: 0.7 } } as unknown as IndexSnapshot }, tokensEst: { NIFTY: 300 }, closes: { NIFTY: 25_000 }, problems: [] };
    const second: ReflexInput = { ...first, builtMs: T + 50_000, snapshots: { NIFTY: { c: 25_000, o: null } as unknown as IndexSnapshot } };
    expect(await dO.submitBar(first)).toEqual({ accepted: true, reason: null });
    expect(await dO.submitBar(second)).toEqual({ accepted: true, reason: "duplicate", snapshots: first.snapshots });
  });
});
