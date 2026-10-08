import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, makeConfig, parseIndices } from "./config";

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
