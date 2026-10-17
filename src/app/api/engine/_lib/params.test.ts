import { describe, expect, it } from "vitest";
import { paramsFromQuery, paramsToQuery } from "@/lib/backtestParams";
import { accountField, accountParam, parseBacktest } from "./params";

describe("account parameters", () => {
  it("treats a missing or main account as main (no parameter passed on)", () => {
    expect(accountParam(new URLSearchParams(""))).toEqual({ ok: true, value: undefined });
    expect(accountParam(new URLSearchParams("account=main"))).toEqual({ ok: true, value: undefined });
    expect(accountParam(new URLSearchParams("account=small10k"))).toEqual({ ok: true, value: "small10k" });
  });

  it("rejects malformed account ids", () => {
    expect(accountParam(new URLSearchParams("account=../x")).ok).toBe(false);
    expect(accountParam(new URLSearchParams("account=SMALL10K")).ok).toBe(false);
    expect(accountField({ account: 5 }).ok).toBe(false);
  });

  it("accepts all for admin bodies", () => {
    expect(accountField({ account: "all" })).toEqual({ ok: true, value: "all" });
    expect(accountField({})).toEqual({ ok: true, value: undefined });
  });
});

describe("backtest parameters with an account", () => {
  const body = { from: "2026-09-01", to: "2026-10-07", index: "NIFTY", thresholdDelta: 0, stopPct: -35, targetPct: 60, noEvents: true };

  it("passes a follower account through and leaves main's params unchanged", () => {
    const main = parseBacktest(body, "2026-10-08");
    expect(main.ok && main.value).toEqual(body);
    const small = parseBacktest({ ...body, account: "small10k" }, "2026-10-08");
    expect(small.ok && small.value.account).toBe("small10k");
    expect(parseBacktest({ ...body, account: "all" }, "2026-10-08").ok).toBe(false);
  });

  it("round-trips the account through the page query", () => {
    const p = paramsFromQuery({ from: "2026-09-01", to: "2026-10-07", index: "NIFTY", account: "small10k" }, "2026-10-08");
    expect(p.account).toBe("small10k");
    expect(new URLSearchParams(paramsToQuery(p)).get("account")).toBe("small10k");
    expect(paramsFromQuery({}, "2026-10-08").account).toBeUndefined();
  });
});
