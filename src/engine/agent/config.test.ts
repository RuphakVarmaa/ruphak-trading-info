import { describe, expect, it } from "vitest";
import { AGENT_DEFAULTS, parseAgentSettings } from "./config";
import { MODEL_PRICES, isPricedModel } from "./cost";

/** Priced models from the table other than the defaults (no model id is written out here). */
const OTHERS = Object.keys(MODEL_PRICES).filter((m) => m !== AGENT_DEFAULTS.reflexModel && m !== AGENT_DEFAULTS.escalationModel);

describe("parseAgentSettings", () => {
  it("defaults to off, the default models, a $3 cap and 8 escalations a day", () => {
    expect(parseAgentSettings({})).toEqual(AGENT_DEFAULTS);
    expect(AGENT_DEFAULTS).toMatchObject({ mode: "off", dailyUsdCap: 3, escalationsPerDay: 8 });
    expect(AGENT_DEFAULTS.reflexModel).not.toBe(AGENT_DEFAULTS.escalationModel);
    expect(AGENT_DEFAULTS.reviewModel).toBe(AGENT_DEFAULTS.escalationModel);
  });

  it("reads the three modes and turns anything else off", () => {
    expect(parseAgentSettings({ AGENT_MODE: "shadow" }).mode).toBe("shadow");
    expect(parseAgentSettings({ AGENT_MODE: "paper" }).mode).toBe("paper");
    expect(parseAgentSettings({ AGENT_MODE: " Paper " }).mode).toBe("paper");
    expect(parseAgentSettings({ AGENT_MODE: "off" }).mode).toBe("off");
    for (const m of ["live", "LIVE", "on", "1", "", "papr"]) expect(parseAgentSettings({ AGENT_MODE: m }).mode).toBe("off");
  });

  it("takes the model vars, and falls back to the defaults for an empty or garbled one", () => {
    const [a, b, c] = OTHERS;
    const s = parseAgentSettings({ AGENT_MODEL: ` ${a} `, AGENT_ESCALATION_MODEL: b, AGENT_REVIEW_MODEL: `${c}-20261001` });
    expect([s.reflexModel, s.escalationModel, s.reviewModel]).toEqual([a, b, `${c}-20261001`]);
    const bad = parseAgentSettings({ AGENT_MODEL: "", AGENT_ESCALATION_MODEL: "two words", AGENT_REVIEW_MODEL: "x".repeat(101) });
    expect([bad.reflexModel, bad.escalationModel, bad.reviewModel]).toEqual([AGENT_DEFAULTS.reflexModel, AGENT_DEFAULTS.escalationModel, AGENT_DEFAULTS.reviewModel]);
  });

  it("accepts only a model the price table can price, and reports one it cannot (M4)", () => {
    expect(OTHERS.length).toBeGreaterThanOrEqual(3);
    for (const id of [AGENT_DEFAULTS.reflexModel, AGENT_DEFAULTS.escalationModel, ...OTHERS]) expect(isPricedModel(id)).toBe(true);
    const heard: [string, string, string][] = [];
    const s = parseAgentSettings({ AGENT_MODEL: "model-a", AGENT_ESCALATION_MODEL: "an-unpriced-model", AGENT_REVIEW_MODEL: "model-c-20261001" }, (...x) => heard.push(x));
    expect([s.reflexModel, s.escalationModel, s.reviewModel]).toEqual([AGENT_DEFAULTS.reflexModel, AGENT_DEFAULTS.escalationModel, AGENT_DEFAULTS.reviewModel]);
    const why = (fallback: string) => `no row in the agent's price table, so the daily cost cap could not hold; using ${fallback}`;
    expect(heard).toEqual([
      ["AGENT_MODEL", "model-a", why(AGENT_DEFAULTS.reflexModel)],
      ["AGENT_ESCALATION_MODEL", "an-unpriced-model", why(AGENT_DEFAULTS.escalationModel)],
      ["AGENT_REVIEW_MODEL", "model-c-20261001", why(AGENT_DEFAULTS.reviewModel)],
    ]);
  });

  it("clamps the USD cap to 0..20 and uses 3 when it is not a number", () => {
    const cap = (v: string) => parseAgentSettings({ AGENT_DAILY_USD_CAP: v }).dailyUsdCap;
    expect(cap("2.5")).toBe(2.5);
    expect(cap("0")).toBe(0);
    expect(cap("-1")).toBe(0);
    expect(cap("25")).toBe(20);
    expect(cap("abc")).toBe(3);
    expect(cap("")).toBe(3);
    expect(cap("Infinity")).toBe(3);
  });

  it("clamps the escalations to whole numbers in 0..24 and uses 8 when not a number", () => {
    const esc = (v: string) => parseAgentSettings({ AGENT_ESCALATIONS_PER_DAY: v }).escalationsPerDay;
    expect(esc("4")).toBe(4);
    expect(esc("4.9")).toBe(4);
    expect(esc("0")).toBe(0);
    expect(esc("-3")).toBe(0);
    expect(esc("100")).toBe(24);
    expect(esc("many")).toBe(8);
  });

  it("reports every var that was set but not used as given, and nothing for unset or accepted ones", () => {
    const heard: [string, string, string][] = [];
    const s = parseAgentSettings(
      { AGENT_MODE: "live", AGENT_ESCALATION_MODEL: "two words", AGENT_DAILY_USD_CAP: "25", AGENT_ESCALATIONS_PER_DAY: "many", AGENT_MODEL: "" },
      (name, value, reason) => heard.push([name, value, reason]),
    );
    expect(s).toMatchObject({ mode: "off", escalationModel: AGENT_DEFAULTS.escalationModel, dailyUsdCap: 20, escalationsPerDay: 8 });
    expect(heard).toEqual([
      ["AGENT_MODE", "live", "not one of off, shadow, paper; using off"],
      ["AGENT_ESCALATION_MODEL", "two words", `not a model id; using ${AGENT_DEFAULTS.escalationModel}`],
      ["AGENT_DAILY_USD_CAP", "25", "outside 0..20; using 20"],
      ["AGENT_ESCALATIONS_PER_DAY", "many", "not a number; using 8"],
    ]);
    const quiet: string[] = [];
    parseAgentSettings({ AGENT_MODE: "shadow", AGENT_DAILY_USD_CAP: "3", AGENT_ESCALATIONS_PER_DAY: "8" }, (name) => quiet.push(name));
    expect(quiet).toEqual([]);
  });
});
