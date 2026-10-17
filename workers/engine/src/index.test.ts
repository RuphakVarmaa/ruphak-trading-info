/**
 * The engine Worker's ops routes for the options agent (index.ts): like EngineAdmin's agent calls, they need the
 * agent's account in ACCOUNTS, and otherwise answer 409 without calling either Durable Object.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

import worker from "./index";

const AGENT_ROUTES = ["/ops/agent-status", "/ops/agent-review?date=2026-10-19", "/ops/agent-count-tokens", "/ops/agent-revert", "/ops/agent-pause?on=1"];

/** An env whose Durable Object stubs record every call (as "engine.method" or "agent.method") and answer ok. */
function env(accounts: string, calls: string[]): Env {
  const stub = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method) => async () => {
          calls.push(`${name}.${String(method)}`);
          return { ok: true, message: "done" };
        },
      },
    );
  return {
    ADMIN_TOKEN: "ops-token",
    ACCOUNTS: accounts,
    ENGINE_ENV: "test",
    DB: {},
    KV: {},
    ENGINE_DO: { idFromName: () => "engine", get: () => stub("engine") },
    AGENT_DO: { idFromName: () => "agent", get: () => stub("agent") },
  } as unknown as Env;
}

const post = (path: string) => new Request(`https://engine.test${path}`, { method: "POST", headers: { authorization: "Bearer ops-token" } });

describe("the agent's ops routes", () => {
  it("answer 409 when ACCOUNTS does not list the agent, before calling either Durable Object", async () => {
    for (const path of AGENT_ROUTES) {
      const calls: string[] = [];
      const res = await worker.fetch(post(path), env("main,small10k,small5k", calls));
      expect(res.status, path).toBe(409);
      expect(await res.json()).toEqual({ ok: false, error: "the agent account is not enabled (ACCOUNTS)" });
      expect(calls, path).toEqual([]);
    }
  });

  it("reach the AgentDO (and, to pause, the trading DO) when the agent is enabled", async () => {
    const calls: string[] = [];
    const pause = await worker.fetch(post("/ops/agent-pause?on=1"), env("main,small10k,small5k,agent", calls));
    expect(pause.status).toBe(200);
    expect([...calls].sort()).toEqual(["agent.setPaused", "engine.setAgentPaused"]);
    const status = await worker.fetch(post("/ops/agent-status"), env("main,agent", calls));
    expect(status.status).toBe(200);
    expect(calls.at(-1)).toBe("agent.status");
  });

  it("still need the admin token first", async () => {
    const calls: string[] = [];
    const res = await worker.fetch(new Request("https://engine.test/ops/agent-pause?on=1", { method: "POST" }), env("main", calls));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });
});
