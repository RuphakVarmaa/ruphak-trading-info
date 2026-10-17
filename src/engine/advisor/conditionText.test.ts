import { describe, expect, it } from "vitest";
import { conditionFromWhy, ideaCondition, realCondition } from "./conditionText";

describe("an advisor idea's entry condition", () => {
  it("drops blanks and placeholders, keeping real text with whitespace collapsed", () => {
    for (const p of [null, undefined, "", "  ", "None", "none needed", "N/A", "na", "null", "nil", "-", "---", "No condition", "Not applicable", "Buy now."]) expect(realCondition(p)).toBeNull();
    expect(realCondition("  Only if NIFTY closes\n above 23,152 ")).toBe("Only if NIFTY closes above 23,152");
  });

  it("reads a condition stated as the first reason, and only then", () => {
    expect(conditionFromWhy(["Condition first: only if NIFTY closes today above 23,152 (today's high); otherwise skip."])).toMatch(/^Condition first/);
    expect(conditionFromWhy(["Only if the 09:30 candle holds above 23,150."])).toMatch(/^Only if/);
    expect(conditionFromWhy(["If NIFTY breaks 23,300, buy."])).toMatch(/^If/);
    expect(conditionFromWhy(["Wait for a close above 23,250."])).toMatch(/^Wait for/);
    expect(conditionFromWhy(["Put writers are adding at 23,000.", "Only if …"])).toBeNull();
    expect(conditionFromWhy(["Iffy momentum, but cheap."])).toBeNull();
    expect(conditionFromWhy([])).toBeNull();
    expect(conditionFromWhy(undefined)).toBeNull();
  });

  it("prefers the condition field, then the first reason", () => {
    expect(ideaCondition({ condition: "Only after the RBI decision.", why: ["Only if NIFTY …"] })).toBe("Only after the RBI decision.");
    expect(ideaCondition({ condition: "None", why: ["Only if NIFTY holds 23,150."] })).toBe("Only if NIFTY holds 23,150.");
    expect(ideaCondition({ condition: null, why: ["Calls are being covered."] })).toBeNull();
  });
});
