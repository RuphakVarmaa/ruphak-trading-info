import { describe, expect, it } from "vitest";
import { ACCOUNTS } from "@/engine/accounts";
import { DEFAULT_CONFIG } from "@/engine/config";
import { BACKTEST_ACCOUNTS, backtestAccount, paramsFromQuery } from "./backtestParams";

describe("backtest accounts", () => {
  it("lists every account in the registry, main first, with its own exits and capital", () => {
    expect(BACKTEST_ACCOUNTS.map((a) => a.id)).toEqual(Object.keys(ACCOUNTS));
    expect(BACKTEST_ACCOUNTS[0].id).toBe("main");
    for (const a of BACKTEST_ACCOUNTS) {
      const patch = ACCOUNTS[a.id].configPatch;
      expect(a.label).toBe(ACCOUNTS[a.id].label);
      expect(a.stopPct).toBe(patch.exits?.stopPct ?? DEFAULT_CONFIG.exits.stopPct);
      expect(a.targetPct).toBe(patch.exits?.targetPct ?? DEFAULT_CONFIG.exits.targetPct);
      expect(a.capitalRupees).toBe(patch.capitalRupees ?? DEFAULT_CONFIG.capitalRupees);
    }
  });

  it("falls back to main for an unknown id", () => {
    expect(backtestAccount("nope").id).toBe("main");
    expect(backtestAccount(undefined).id).toBe("main");
  });

  it("takes a follower's default stop and target from the query's account, and ignores unknown accounts", () => {
    const follower = BACKTEST_ACCOUNTS.find((a) => a.id !== "main");
    if (follower) {
      const p = paramsFromQuery({ account: follower.id }, "2026-10-08");
      expect(p.account).toBe(follower.id);
      expect([p.stopPct, p.targetPct]).toEqual([follower.stopPct, follower.targetPct]);
    }
    const unknown = paramsFromQuery({ account: "nope", stopPct: "-25" }, "2026-10-08");
    expect(unknown.account).toBeUndefined();
    expect(unknown.stopPct).toBe(-25);
  });
});
