import { describe, expect, it } from "vitest";
import type { AdvisorFactor, AdvisorIdea } from "@/engine/api-types";
import {
  agoWords,
  chainHref,
  chanceWords,
  costWords,
  daysToExpiry,
  daysWords,
  engineNotesWords,
  exitByWords,
  groupIdeas,
  ideaLine,
  isOldDayTrade,
  itmWords,
  modelName,
  nextAllowedLine,
  oldBriefDay,
  parseContractLabel,
  pastCheck,
  plainContract,
  premium,
  profitSide,
  rangeWords,
  shortExpiry,
  sortFactors,
  statusWords,
  writtenLine,
} from "./advisorText";

/** 16 Oct 2026, 12:44 IST (a Friday). */
const NOW = Date.parse("2026-10-16T12:44:00+05:30");

function idea(over: Partial<AdvisorIdea> = {}): AdvisorIdea {
  return {
    id: "i1",
    horizon: "WEEK",
    contract: { index: "NIFTY", expiry: "2026-10-23", strike: 23200, optionType: "CE", tradingSymbol: "NIFTY26O2323200CE", lotSize: 65, label: "NIFTY 23-OCT-2026 23200 CE" },
    entry: { low: 140, high: 145.5, ask: 143.25, asOf: "2026-10-16T12:41:00+05:30" },
    stop: 100,
    target: 210,
    exitBy: "2026-10-22T14:30:00+05:30",
    lots: 1,
    costPerLot: 9311.25,
    maxLossPerLot: 2852.4,
    rewardPerLot: 4309,
    breakevenAtExpiry: 23343.25,
    delta: 0.52,
    iv: 12.1,
    probItm: 0.52,
    why: ["Trend up"],
    wrongIf: "NIFTY closes below 23,050",
    confidence: "MEDIUM",
    ...over,
  };
}

describe("dates and contracts", () => {
  it("counts calendar days to expiry in IST", () => {
    expect(daysToExpiry("2026-10-23", NOW)).toBe(7);
    expect(daysToExpiry("2026-10-16", NOW)).toBe(0);
    expect(daysToExpiry("2026-10-13", NOW)).toBe(-3);
    // 23:00 IST on the 16th is still the 16th in IST although it is the 16th 17:30 UTC.
    expect(daysToExpiry("2026-10-17", Date.parse("2026-10-16T23:00:00+05:30"))).toBe(1);
    // 00:30 IST on the 17th is the 16th in UTC, but the 17th in IST.
    expect(daysToExpiry("2026-10-17", Date.parse("2026-10-17T00:30:00+05:30"))).toBe(0);
  });

  it("words the days", () => {
    expect(daysWords(0)).toBe("today");
    expect(daysWords(1)).toBe("tomorrow");
    expect(daysWords(7)).toBe("7 days");
    expect(daysWords(-1)).toBe("expired");
  });

  it("names a contract in plain words", () => {
    expect(plainContract({ index: "NIFTY", expiry: "2026-10-23", strike: 23200, optionType: "CE" }, NOW)).toBe("NIFTY 23200 CALL, expires Fri 23 Oct (7 days)");
    expect(plainContract({ index: "SENSEX", expiry: "2026-10-16", strike: 82000, optionType: "PE" }, NOW)).toBe("SENSEX 82000 PUT, expires today");
    expect(plainContract({ index: "NIFTY", expiry: "2026-10-17", strike: 23000, optionType: "PE" }, NOW)).toBe("NIFTY 23000 PUT, expires Sat 17 Oct (tomorrow)");
    expect(shortExpiry("2026-10-23")).toBe("23-Oct");
  });

  it("writes the one-line order with the lot count and the max loss (at the stop) for all lots", () => {
    expect(ideaLine(idea())).toBe("BUY NIFTY 23200 CE 23-Oct · 1 lot · buy between ₹140–145.50 · stop ₹100 · target ₹210 · max loss ₹2,852 at the stop");
    expect(ideaLine(idea({ lots: 2 }))).toContain("2 lots");
    expect(ideaLine(idea({ lots: 2 }))).toContain("max loss ₹5,705 at the stop");
  });

  it("explains in the money and which side of the break-even is profit", () => {
    expect(itmWords({ index: "NIFTY", strike: 23200, optionType: "CE" })).toBe("NIFTY above 23,200, so the option is worth something");
    expect(itmWords({ index: "SENSEX", strike: 82000, optionType: "PE" })).toBe("SENSEX below 82,000, so the option is worth something");
    expect(profitSide("CE")).toBe("above");
    expect(profitSide("PE")).toBe("below");
  });

  it("joins the engine's adjustments into one line, and says nothing when there are none", () => {
    expect(engineNotesWords(["stop raised to ₹35.55 (was ₹38.40).", " target lowered to ₹90 (was ₹140) "])).toBe("stop raised to ₹35.55 (was ₹38.40); target lowered to ₹90 (was ₹140)");
    expect(engineNotesWords([])).toBeNull();
    expect(engineNotesWords(["  "])).toBeNull();
    expect(engineNotesWords(undefined)).toBeNull();
  });

  it("formats premiums, ranges, chances and the chain link", () => {
    expect(premium(98)).toBe("₹98");
    expect(premium(142.5)).toBe("₹142.50");
    expect(rangeWords(22810, 22480)).toBe("22,480 – 22,810");
    expect(rangeWords(null, 22480)).toBeNull();
    expect(chanceWords(0.523)).toBe("≈ 52%");
    expect(chanceWords(-0.31)).toBe("≈ 31%");
    expect(chanceWords(0.002)).toBe("under 1%");
    expect(chanceWords(null)).toBeNull();
    expect(chainHref({ index: "SENSEX", expiry: "2026-10-22" })).toBe("/options?index=SENSEX&expiry=2026-10-22");
  });

  it("words the exit time", () => {
    expect(exitByWords("2026-10-16T15:00:00+05:30", NOW)).toBe("today, 15:00 IST");
    expect(exitByWords("2026-10-22T14:30:00+05:30", NOW)).toBe("Thu 22 Oct, 14:30 IST");
    expect(exitByWords("before the close", NOW)).toBe("before the close");
  });
});

describe("top bar", () => {
  it("says when the brief was written", () => {
    expect(writtenLine("2026-10-16T12:41:00+05:30", NOW)).toBe("Written 12:41 IST, 3 min ago");
    expect(writtenLine("2026-10-16T12:41:00+05:30", null)).toBe("Written 12:41 IST");
    expect(writtenLine("2026-10-14T09:26:00+05:30", NOW)).toBe("Written Wed 14 Oct, 09:26 IST, 2 days ago");
    expect(writtenLine("garbage", NOW)).toBe("Written at an unknown time");
  });

  it("words ages", () => {
    expect(agoWords(20_000)).toBe("just now");
    expect(agoWords(3 * 60_000)).toBe("3 min ago");
    expect(agoWords(125 * 60_000)).toBe("2 h 5 min ago");
    expect(agoWords(120 * 60_000)).toBe("2 h ago");
    expect(agoWords(30 * 3_600_000)).toBe("yesterday");
  });

  it("names the model and the cost", () => {
    expect(modelName("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelName("mock")).toBe("mock");
    expect(costWords(0.3812)).toBe("$0.38");
    expect(costWords(0.004)).toBe("under $0.01");
    expect(costWords(0)).toBe("$0.00");
    expect(costWords(null)).toBeNull();
  });

  it("marks a brief from an earlier IST day as out of date, by IST calendar day", () => {
    expect(oldBriefDay("2026-10-15T09:59:00+05:30", NOW)).toBe("Thu 15 Oct");
    expect(oldBriefDay("2026-10-16T09:26:00+05:30", NOW)).toBeNull();
    // 00:10 IST on the 16th is still the 15th in UTC, but today in IST.
    expect(oldBriefDay("2026-10-16T00:10:00+05:30", NOW)).toBeNull();
    // 23:50 IST on the 15th is the 15th; at 09:15 IST next morning it is yesterday's brief.
    expect(oldBriefDay("2026-10-15T23:50:00+05:30", Date.parse("2026-10-16T09:15:00+05:30"))).toBe("Thu 15 Oct");
    // Unknown clock (first paint) or an unreadable time: not marked.
    expect(oldBriefDay("2026-10-15T09:59:00+05:30", null)).toBeNull();
    expect(oldBriefDay("garbage", NOW)).toBeNull();
  });

  it("shows the rate limit only while it holds", () => {
    expect(nextAllowedLine("2026-10-16T12:45:00+05:30", NOW)).toBe("Next analysis possible at 12:45 IST");
    expect(nextAllowedLine("2026-10-16T12:40:00+05:30", NOW)).toBeNull();
    expect(nextAllowedLine("2026-10-17T00:00:00+05:30", NOW)).toBe("Next analysis possible at Sat 17 Oct, 00:00 IST");
    expect(nextAllowedLine(null, NOW)).toBeNull();
  });

  it("words a running analysis", () => {
    const base = { lastError: null, runningSince: null, nextAllowedAt: null, runsToday: 1, maxRunsPerDay: 24, latest: null, history: [] };
    expect(statusWords({ ...base, status: "running" })).toBe("Analyzing… about 1–2 minutes");
    expect(statusWords({ ...base, status: "queued" })).toContain("Analyzing");
    expect(statusWords({ ...base, status: "idle" })).toBeNull();
  });
});

describe("ordering", () => {
  it("lists factors FII/DII first and events last, keeping unknown keys at the end", () => {
    const f = (key: AdvisorFactor["key"]): AdvisorFactor => ({ key, label: key, reading: "NEUTRAL", detail: "", source: "" });
    const out = sortFactors([f("EVENTS"), f("OTHER"), f("TREND"), f("FII_DII"), f("SHORT_COVERING"), f("GLOBAL_CUES"), f("NEWS_UNCERTAINTY")]).map((x) => x.key);
    expect(out).toEqual(["FII_DII", "NEWS_UNCERTAINTY", "GLOBAL_CUES", "SHORT_COVERING", "TREND", "EVENTS", "OTHER"]);
  });

  it("groups ideas by horizon and drops empty groups", () => {
    const groups = groupIdeas([idea({ id: "m", horizon: "MONTH" }), idea({ id: "t", horizon: "TODAY" }), idea({ id: "m2", horizon: "MONTH" })]);
    expect(groups.map((g) => [g.horizon, g.ideas.map((i) => i.id)])).toEqual([
      ["TODAY", ["t"]],
      ["MONTH", ["m", "m2"]],
    ]);
  });
});

describe("past briefs", () => {
  it("reads contract labels in the engine's and other common forms", () => {
    expect(parseContractLabel("NIFTY 20-OCT-2026 22650 CE")).toEqual({ index: "NIFTY", expiry: "2026-10-20", strike: 22650, optionType: "CE" });
    expect(parseContractLabel("SENSEX 82000 PE 2026-10-22")).toEqual({ index: "SENSEX", expiry: "2026-10-22", strike: 82000, optionType: "PE" });
    expect(parseContractLabel("NIFTY 23200 CALL, 3 Nov 2026")).toEqual({ index: "NIFTY", expiry: "2026-11-03", strike: 23200, optionType: "CE" });
    expect(parseContractLabel("NIFTY 23200 CE")).toBeNull();
    expect(parseContractLabel("BANKNIFTY 20-OCT-2026 50000 CE")).toBeNull();
  });

  it("does not price an earlier day's day trade at today's price", () => {
    expect(isOldDayTrade("TODAY", "2026-10-15T12:00:00+05:30", NOW)).toBe(true);
    expect(isOldDayTrade("TODAY", "2026-10-16T09:40:00+05:30", NOW)).toBe(false);
    expect(isOldDayTrade("WEEK", "2026-10-15T12:00:00+05:30", NOW)).toBe(false);
    expect(isOldDayTrade("TODAY", "2026-10-15T12:00:00+05:30", null)).toBe(false);
  });

  it("compares the price now with the ask when the brief was written", () => {
    expect(pastCheck({ entryAsk: 100, stop: 70, target: 150 }, 124).words).toBe("Now ₹124 vs ₹100 when written (up 24%)");
    expect(pastCheck({ entryAsk: 100, stop: 70, target: 150 }, 155).words).toContain("at or above the target");
    const down = pastCheck({ entryAsk: 100, stop: 70, target: 150 }, 64.5);
    expect(down.tone).toBe("down");
    expect(down.words).toBe("Now ₹64.50 vs ₹100 when written (down 36%): at or below the stop");
    expect(pastCheck({ entryAsk: 100, stop: 70, target: 150 }, 100.2).tone).toBe("flat");
  });
});

describe("sources", () => {
  it("only links http(s) URLs and this site's paths", async () => {
    const { safeHref, sourceHost } = await import("./advisorText");
    expect(safeHref("https://www.reuters.com/markets/india/x")).toBe("https://www.reuters.com/markets/india/x");
    expect(safeHref("/options")).toBe("/options");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("//evil.example/x")).toBeNull();
    expect(safeHref("/\\evil.example")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
    expect(sourceHost("https://www.livemint.com/market/x")).toBe("livemint.com");
    expect(sourceHost("/learn")).toBe("this site");
  });
});
