/**
 * agentSettings(env, logger): every AGENT_* var the parser ignores (src/engine/agent/config.ts reports each through
 * its onIgnored callback, for example a model with no price row) is logged as a warning. The parser is stood in for
 * here so the test is about this wiring only; the parser's own rules are tested in the engine package.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/engine/agent/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/engine/agent/config")>();
  return {
    ...real,
    parseAgentSettings: vi.fn((...args: unknown[]) => {
      const [vars, onIgnored] = args as [Record<string, string | undefined>, ((varName: string, value: string, reason: string) => void) | undefined];
      if (vars.AGENT_REVIEW_MODEL === "unpriced-deep-x") onIgnored?.("AGENT_REVIEW_MODEL", vars.AGENT_REVIEW_MODEL, "no price row for this model, so its spend could not be capped");
      return { ...real.AGENT_DEFAULTS, mode: "shadow" };
    }),
  };
});

import { agentSettings } from "./runtime";

const env = (o: Partial<Env>): Env => ({ ...o }) as unknown as Env;

describe("agentSettings and the vars the parser ignores", () => {
  it("logs each ignored var as a warning, with the value and the reason", () => {
    const warn = vi.fn();
    const s = agentSettings(env({ AGENT_MODE: "shadow", AGENT_REVIEW_MODEL: "unpriced-deep-x" }), { warn });
    expect(s.mode).toBe("shadow");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("agent setting ignored: the default is used", {
      var: "AGENT_REVIEW_MODEL",
      value: "unpriced-deep-x",
      reason: "no price row for this model, so its spend could not be capped",
    });
  });

  it("logs nothing when every var is used, and works without a logger", () => {
    const warn = vi.fn();
    agentSettings(env({ AGENT_MODE: "shadow" }), { warn });
    expect(warn).not.toHaveBeenCalled();
    expect(agentSettings(env({ AGENT_REVIEW_MODEL: "unpriced-deep-x" })).mode).toBe("shadow");
  });
});
