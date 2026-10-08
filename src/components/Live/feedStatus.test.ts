import { describe, expect, it } from "vitest";
import type { EngineStateDTO, PositionView, SignalView } from "@/engine/api-types";
import { dashboardLinkStatus, engineLoopStatus, marketFeedStatus, optionPriceStatus } from "./feedStatus";

const at = (hm: string) => `2026-10-08T${hm}:00+05:30`;
const ms = (hm: string) => Date.parse(at(hm));

function state(phase: EngineStateDTO["market"]["phase"], over: Partial<EngineStateDTO> = {}): EngineStateDTO {
  return {
    dataSource: "engine",
    mode: "PAPER",
    liveTradingEnabled: false,
    armed: false,
    armedUntil: null,
    killSwitch: false,
    killReason: null,
    caps: { dailyLossCap: 15000, dailyLossUsed: 0, maxPositions: 1, openPositions: 0, maxOrdersPerDay: 10, ordersToday: 0 },
    heartbeat: { lastTickAt: at("09:40"), phase: "OPEN", loopIntervalSec: 30, consecutiveErrors: 0, version: "x", lastError: null },
    health: { yahoo: { ok: true, lastOkAt: at("09:40") } },
    market: { phase, nowIst: at("09:40"), nextOpenAt: at("09:15"), nextCloseAt: at("15:30"), isHoliday: false, holidayName: null },
    quotes: [{ key: "NIFTY", label: "NIFTY 50", price: 22550.5, change: -52.5, changePct: -0.23, asOf: at("09:35"), stale: false }],
    stats: { clustersScoredToday: 0, signalsToday: 0, llmInputTokensToday: 0, llmOutputTokensToday: 0 },
    ...over,
  };
}

const contract = { index: "NIFTY", expiry: "2026-10-13", strike: 22550, optionType: "PE", tradingSymbol: "NIFTY2610132255PE", lotSize: 65, lots: 1, premium: 140.25, premiumAtRisk: null, label: "NIFTY 13-OCT-2026 22550 PE" } as const;
const signal = { index: "NIFTY", computedAt: at("09:39"), contract } as unknown as SignalView;
const position = { contract: { ...contract, label: "NIFTY 13-OCT-2026 22600 CE" }, ltp: 151.5, ltpAsOf: at("09:39"), pnl: 700 } as unknown as PositionView;

describe("marketFeedStatus", () => {
  it("waits before the open and shows the last price", () => {
    const s = marketFeedStatus(state("CLOSED"), ms("08:45"));
    expect(s.level).toBe("wait");
    expect(s.detail).toContain("opens 09:15 IST");
  });
  it("is ok with a fresh bar and stale with an old one", () => {
    expect(marketFeedStatus(state("OPEN"), ms("09:40")).level).toBe("ok");
    const old = marketFeedStatus(state("OPEN"), ms("09:50"));
    expect(old.level).toBe("stale");
    expect(old.detail).toContain("15m old");
  });
  it("is down when Yahoo fails or there is no quote", () => {
    expect(marketFeedStatus(state("OPEN", { health: { yahoo: { ok: false, lastOkAt: null, detail: "429" } } }), ms("09:40")).level).toBe("down");
    expect(marketFeedStatus(state("OPEN", { quotes: [] }), ms("09:40")).level).toBe("down");
  });
});

describe("optionPriceStatus", () => {
  it("labels model prices when Groww is not connected", () => {
    const s = optionPriceStatus(state("OPEN"), [], [signal], ms("09:40"));
    expect(s.level).toBe("ok");
    expect(s.detail).toContain("22550 PE ₹140.25");
    expect(s.detail).toContain("Model price");
  });
  it("labels Groww quotes when Groww is healthy", () => {
    const s = optionPriceStatus(state("OPEN", { health: { groww: { ok: true, lastOkAt: at("09:40") } } }), [], [signal], ms("09:40"));
    expect(s.detail).toContain("Groww live quotes");
  });
  it("prefers an open position's mark over the signal premium", () => {
    expect(optionPriceStatus(state("OPEN"), [position], [signal], ms("09:40")).detail).toContain("22600 CE ₹151.50");
  });
  it("is stale when the newest price is old, and waits before the pre-open", () => {
    expect(optionPriceStatus(state("OPEN"), [], [signal], ms("09:45")).level).toBe("stale");
    expect(optionPriceStatus(state("CLOSED"), [], [], ms("08:45")).level).toBe("wait");
    expect(optionPriceStatus(state("OPEN"), [], [], ms("09:40")).level).toBe("stale");
  });
});

describe("engineLoopStatus", () => {
  it("runs, idles, and reports errors and the kill switch", () => {
    expect(engineLoopStatus(state("OPEN"), ms("09:40") + 20_000).level).toBe("ok");
    expect(engineLoopStatus(state("OPEN"), ms("09:45")).level).toBe("stale");
    expect(engineLoopStatus(state("CLOSED"), ms("08:45")).level).toBe("wait");
    const failing = state("OPEN", { heartbeat: { ...state("OPEN").heartbeat, consecutiveErrors: 2, lastError: "yahoo timeout" } });
    expect(engineLoopStatus(failing, ms("09:40")).headline).toBe("2 failed ticks");
    expect(engineLoopStatus(state("OPEN", { killSwitch: true, killReason: "Manual kill" }), ms("09:40")).level).toBe("down");
  });
});

describe("dashboardLinkStatus", () => {
  it("maps the provider status", () => {
    expect(dashboardLinkStatus("live", 1000, 5000, 4000).detail).toBe("Refreshing every 5 s, last update 3s ago");
    expect(dashboardLinkStatus("offline", null, 5000, null).level).toBe("down");
  });
});
