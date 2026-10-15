import { describe, expect, it } from "vitest";
import type { SignalView } from "@/engine/api-types";
import { C } from "@/components/shared/colors";
import { ENTER, WAIT } from "./__fixtures__/reco";
import {
  capitalLabel,
  ciText,
  clockText,
  engineNow,
  historyRows,
  lotsText,
  orderLine,
  pct0,
  premium,
  recoAlertKey,
  recoCopyText,
  recoNotice,
  recosFrom,
  recoState,
  rrText,
  rupees,
  showHonestLine,
  stopText,
  targetText,
  validUntilMs,
  VERDICT_META,
} from "./recoText";

describe("figures", () => {
  it("writes rupees, premiums and ratios", () => {
    expect(rupees(9262.5)).toBe("₹9,263");
    expect(rupees(-1026.4)).toBe("−₹1,026");
    expect(rupees(51.3, true)).toBe("+₹51");
    expect(rupees(0, true)).toBe("₹0");
    expect(rupees(125000)).toBe("₹1,25,000");
    expect(rupees(null)).toBe("—");
    expect(premium(142.5)).toBe("₹142.50");
    expect(premium(undefined)).toBe("—");
    expect(rrText(1.61)).toBe("1:1.6");
    expect(rrText(null)).toBe("—");
    expect(pct0(0.414)).toBe("41%");
    expect(pct0(null)).toBe("—");
    expect(ciText([-480.2, 51.3])).toBe("−₹480 to +₹51");
    expect(ciText(null)).toBe("—");
    expect(capitalLabel(10_000)).toBe("₹10k");
    expect(capitalLabel(12_500)).toBe("₹12.5k");
    expect(capitalLabel(250_000)).toBe("₹2.5L");
  });

  it("reads clock times from ISO or text", () => {
    expect(clockText("2026-10-14T10:48:00+05:30")).toBe("10:48");
    expect(clockText("13:30 IST")).toBe("13:30");
    expect(clockText("9:45")).toBe("09:45");
    expect(clockText("at the close")).toBe("at the close");
    expect(clockText(null)).toBeNull();
  });
});

describe("the order", () => {
  it("writes the exact order line", () => {
    expect(orderLine(ENTER)).toBe("BUY NIFTY 22500 CE 20-Oct · 1 lot = 65 qty · limit ≤ ₹142.50 · valid till 10:48");
    expect(orderLine({ ...ENTER, index: "SENSEX", lots: 2, contract: { ...ENTER.contract!, strike: 81500, optionType: "PE", lotSize: 20 } })).toBe(
      "BUY SENSEX 81500 PE 20-Oct · 2 lots = 40 qty · limit ≤ ₹142.50 · valid till 10:48",
    );
    expect(lotsText(1, 65)).toBe("1 lot = 65 qty");
  });

  it("has no order line without a contract, an entry or a whole lot", () => {
    expect(orderLine(WAIT)).toBeNull();
    expect(orderLine({ ...ENTER, entry: null })).toBeNull();
    expect(orderLine({ ...ENTER, lots: 0 })).toBeNull();
  });

  it("writes the stop, targets and clipboard text", () => {
    expect(stopText(ENTER)).toBe("Stop ₹99.75 (NIFTY 22,431)");
    expect(stopText({ ...ENTER, stop: { premium: 99.75, index: null } })).toBe("Stop ₹99.75");
    expect(targetText(ENTER)).toBe("T1 ₹213.75 (NIFTY 22,655) · T2 ₹256.50");
    expect(targetText({ ...ENTER, target: { t1: 200, t2: null, indexT1: null } })).toBe("T1 ₹200.00");
    expect(stopText(WAIT)).toBeNull();
    expect(recoCopyText(ENTER)).toBe(
      [
        "BUY NIFTY 22500 CE 20-Oct · 1 lot = 65 qty · limit ≤ ₹142.50 · valid till 10:48",
        "Stop ₹99.75 (NIFTY 22,431) · T1 ₹213.75 (NIFTY 22,655) · T2 ₹256.50 · exit by 13:30",
        "Entry: Now, while NIFTY holds above 22,480",
      ].join("\n"),
    );
    expect(recoCopyText(WAIT)).toBe("WAIT SENSEX");
  });

  it("notifies with the order", () => {
    const n = recoNotice(ENTER);
    expect(n.title).toBe("ENTER · NIFTY (grade C)");
    expect(n.body.split("\n")[0]).toBe(orderLine(ENTER));
  });
});

describe("honesty", () => {
  it("shows the honest line unless grade A and a positive measured history", () => {
    expect(showHonestLine(ENTER)).toBe(true);
    expect(showHonestLine({ grade: "A", historical: { ...ENTER.historical!, verdict: "positive" } })).toBe(false);
    expect(showHonestLine({ grade: "A", historical: { ...ENTER.historical!, verdict: "not_proven" } })).toBe(true);
    expect(showHonestLine({ grade: "A", historical: null })).toBe(true);
  });

  it("lays out the measured history", () => {
    const rows = historyRows(ENTER.historical!);
    expect(rows.map((r) => `${r.label}: ${r.value}`)).toEqual(["Test trades: 142", "Made money: 41%", "Avg per lot: −₹212", "95% range: −₹480 to +₹51"]);
    expect(rows[2].color).toBe(C.red);
    expect(VERDICT_META.not_proven.label).toBe("Not proven");
    expect(VERDICT_META.positive.color).toBe(C.green);
  });
});

describe("alerts and state", () => {
  it("keys alerts by index, contract and status, ENTER only", () => {
    expect(recoAlertKey(ENTER)).toBe("NIFTY|NIFTY26O2022500CE|ENTER");
    expect(recoAlertKey({ ...ENTER, contract: { ...ENTER.contract!, tradingSymbol: "" } })).toBe("NIFTY|22500CE2026-10-20|ENTER");
    expect(recoAlertKey({ ...ENTER, status: "WAIT" })).toBeNull();
    expect(recoAlertKey(WAIT)).toBeNull();
  });

  it("reads 'valid till' as ISO or as a clock time on the reading's day", () => {
    expect(validUntilMs("2026-10-14T10:48:00+05:30", ENTER.asOf)).toBe(Date.parse("2026-10-14T10:48:00+05:30"));
    expect(validUntilMs("10:48", ENTER.asOf)).toBe(Date.parse("2026-10-14T10:48:00+05:30"));
    expect(validUntilMs("10:48 IST", ENTER.asOf)).toBe(Date.parse("2026-10-14T10:48:00+05:30"));
    expect(validUntilMs("soon", ENTER.asOf)).toBeNull();
  });

  it("is stale after 3 minutes and expired past its validity, on the engine's clock", () => {
    const asOf = Date.parse(ENTER.asOf);
    expect(recoState(ENTER, asOf + 60_000)).toEqual({ stale: false, expired: false, ageMs: 60_000 });
    expect(recoState(ENTER, asOf + 4 * 60_000)).toEqual({ stale: true, expired: true, ageMs: 240_000 });
    expect(recoState({ ...ENTER, entry: { ...ENTER.entry!, validUntil: "10:50" } }, asOf + 4 * 60_000).expired).toBe(false);
    expect(recoState(ENTER, null)).toEqual({ stale: false, expired: false, ageMs: null });
    expect(engineNow(1000, -500)).toBe(500);
  });

  it("separates 'no recommendation' from 'engine does not publish them'", () => {
    const sig = (index: "NIFTY" | "SENSEX", recommendation?: typeof ENTER | null) => ({ index, ...(recommendation !== undefined ? { recommendation } : {}) }) as SignalView;
    const r = recosFrom([sig("SENSEX", null)], ["NIFTY", "SENSEX"]);
    expect(r.NIFTY).toBeUndefined();
    expect(r.SENSEX).toBeNull();
    expect(recosFrom([sig("NIFTY")], ["NIFTY", "SENSEX"])).toEqual({ NIFTY: undefined, SENSEX: undefined });
    expect(recosFrom(null, ["NIFTY"])).toEqual({ NIFTY: undefined });
  });
});
