import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, makeConfig, parseIndices, parseMaxOpenPerIndex } from "./config";

describe("parseIndices", () => {
  it("reads one index or a comma-separated list", () => {
    expect(parseIndices("NIFTY")).toEqual(["NIFTY"]);
    expect(parseIndices(" nifty , SENSEX ")).toEqual(["NIFTY", "SENSEX"]);
    expect(parseIndices("SENSEX,NIFTY,SENSEX")).toEqual(["SENSEX", "NIFTY"]);
  });

  it("returns undefined when nothing valid is given, so the default list stays", () => {
    expect(parseIndices(undefined)).toBeUndefined();
    expect(parseIndices("")).toBeUndefined();
    expect(parseIndices("FOO, BANKNIFTY")).toBeUndefined();
    expect(makeConfig({ indices: parseIndices("") }).indices).toEqual(DEFAULT_CONFIG.indices);
  });

  it("replaces the default list in makeConfig", () => {
    expect(makeConfig({ indices: parseIndices("NIFTY") }).indices).toEqual(["NIFTY"]);
    expect(DEFAULT_CONFIG.indices).toEqual(["NIFTY", "SENSEX"]);
  });
});

describe("parseMaxOpenPerIndex", () => {
  it("reads an integer from 1 to 3", () => {
    expect(parseMaxOpenPerIndex("1")).toBe(1);
    expect(parseMaxOpenPerIndex("2")).toBe(2);
    expect(parseMaxOpenPerIndex(" 3 ")).toBe(3);
  });

  it("returns undefined for anything else, so the default of 1 stays", () => {
    for (const bad of [undefined, "", "0", "4", "-1", "1.5", "two", "2x"]) expect(parseMaxOpenPerIndex(bad)).toBeUndefined();
    expect(makeConfig({ sizing: { maxOpenPerIndex: parseMaxOpenPerIndex("x") } }).sizing.maxOpenPerIndex).toBe(1);
  });

  it("overrides only that sizing key", () => {
    const cfg = makeConfig({ sizing: { maxOpenPerIndex: parseMaxOpenPerIndex("2") } });
    expect(cfg.sizing.maxOpenPerIndex).toBe(2);
    expect(cfg.sizing.maxTradesPerDay).toBe(DEFAULT_CONFIG.sizing.maxTradesPerDay);
    expect(cfg.sizing.maxCombinedPremiumPct).toBe(DEFAULT_CONFIG.sizing.maxCombinedPremiumPct);
  });
});
