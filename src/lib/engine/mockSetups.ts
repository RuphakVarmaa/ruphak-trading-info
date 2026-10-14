/**
 * Mock trade setups for the dashboard: a WATCHING opening-range breakout on NIFTY and a TRIGGERED
 * previous-day-low breakdown on SENSEX, placed around the mock's moving spot so the board looks live.
 */
import type { IndexId, KeyLevelView, SignalView, TradeSetupView } from "@/engine/api-types";
import { istIso } from "@/engine/clock";

const r2 = (x: number) => Math.round(x * 100) / 100;

export function mockSetups(index: IndexId, spot: number, now: number): Pick<SignalView, "setups" | "levels" | "setupNote"> {
  const date = istIso(now).slice(0, 10);
  if (index === "NIFTY") {
    const trigger = Math.round(spot / 10) * 10 + 30;
    const levels: KeyLevelView[] = [
      { price: trigger - 80, label: "VWAP", kinds: ["VWAP"], strength: 2 },
      { price: trigger, label: "ORH", kinds: ["ORH"], strength: 2 },
      { price: trigger + 60, label: "PDH + R1", kinds: ["PDH", "R1"], strength: 5 },
      { price: trigger + 110, label: "VWAP+2σ", kinds: ["VWAP+2σ"], strength: 1 },
    ];
    const setup: TradeSetupView = {
      id: `${date}:NIFTY:ORB:BULL`,
      index: "NIFTY",
      kind: "ORB",
      name: "Opening-range breakout",
      side: "BULL",
      status: "WATCHING",
      statusSince: istIso(now - 4 * 60_000),
      firstSeen: istIso(now - 4 * 60_000),
      score: 72,
      spot,
      trigger,
      condition: `a 5-min candle closes above ${trigger.toLocaleString("en-IN")}`,
      chaseLimit: trigger + 11,
      distance: r2(trigger - spot),
      level: { price: trigger, label: "ORH" },
      stop: trigger - 34,
      t1: trigger + 60,
      t2: trigger + 110,
      t1Label: "PDH + R1",
      t2Label: "VWAP+2σ",
      rr1: 1.76,
      rr2: 3.24,
      invalidation: `a 5-min close back below ${trigger.toLocaleString("en-IN")} (ORH) after the break, or price back under VWAP`,
      evidence: [
        { text: `Price ${Math.round(spot).toLocaleString("en-IN")} above VWAP ${(trigger - 80).toLocaleString("en-IN")}`, supports: true },
        { text: "EMA9 above EMA21", supports: true },
        { text: "ADX 24.1 (≥ 20, trending), +DI 27.4 / −DI 15.2", supports: true },
        { text: "Supertrend up", supports: true },
        { text: "RSI 63.0 (momentum with the trade)", supports: true },
        { text: "Daily trend down (EMA20 vs EMA50)", supports: false },
      ],
      cautions: [],
      atr: 22,
      option: {
        contract: { index: "NIFTY", expiry: "2026-10-20", strike: Math.round(spot / 50) * 50, optionType: "CE", tradingSymbol: "NIFTY26O20CE", lotSize: 65, label: `NIFTY ${Math.round(spot / 50) * 50} CE 2026-10-20` },
        premiumNow: 112.4,
        priceSource: "model",
        iv: 12.8,
        delta: 0.53,
        gamma: 0.0011,
        decayPerMin: 0.04,
        entry: 129.5,
        stop: 110.2,
        t1: 160.3,
        t2: 190.15,
        stopPct: -14.9,
        stopCapped: false,
        riskPerLot: 1255,
        rewardT1PerLot: 2002,
        rewardT2PerLot: 3942,
        holdMin: 45,
      },
    };
    return { setups: [setup], levels, setupNote: null };
  }
  const trigger = Math.round(spot / 10) * 10 + 40;
  const setup: TradeSetupView = {
    id: `${date}:SENSEX:PDH_PDL:BEAR`,
    index: "SENSEX",
    kind: "PDH_PDL",
    name: "Previous-day low breakdown",
    side: "BEAR",
    status: "TRIGGERED",
    statusSince: istIso(now - 3 * 60_000),
    firstSeen: istIso(now - 14 * 60_000),
    score: 78,
    spot,
    trigger,
    condition: `a 5-min candle closes below ${trigger.toLocaleString("en-IN")}`,
    chaseLimit: trigger - 40,
    distance: r2(spot - trigger),
    level: { price: trigger, label: "PDL + S1" },
    stop: trigger + 115,
    t1: trigger - 190,
    t2: trigger - 330,
    t1Label: "74,000",
    t2Label: "VWAP−2σ",
    rr1: 1.65,
    rr2: 2.87,
    invalidation: `a 5-min close back above ${trigger.toLocaleString("en-IN")} (PDL) after the break, or price back over VWAP`,
    evidence: [
      { text: "Price below VWAP", supports: true },
      { text: "EMA9 below EMA21", supports: true },
      { text: "ADX 27.9 (≥ 20, trending), +DI 13.1 / −DI 29.6", supports: true },
      { text: "PDL + S1: a stacked level, a clean break carries", supports: true },
      { text: "RSI 34.2 (momentum with the trade)", supports: true },
    ],
    cautions: ["India VIX up 8.6% today (above +8%): the Desk's plan would wait."],
    atr: 80,
    option: {
      contract: { index: "SENSEX", expiry: "2026-10-22", strike: Math.round(spot / 100) * 100 + 100, optionType: "PE", tradingSymbol: "SENSEX26O22PE", lotSize: 20, label: `SENSEX ${Math.round(spot / 100) * 100 + 100} PE 2026-10-22` },
      premiumNow: 318.6,
      priceSource: "model",
      iv: 13.4,
      delta: -0.61,
      gamma: 0.0003,
      decayPerMin: 0.09,
      entry: 307.55,
      stop: 233.4,
      t1: 418.1,
      t2: 501.75,
      stopPct: -24.1,
      stopCapped: false,
      riskPerLot: 1483,
      rewardT1PerLot: 2211,
      rewardT2PerLot: 3884,
      holdMin: 45,
    },
  };
  const levels: KeyLevelView[] = [
    { price: trigger - 330, label: "VWAP−2σ", kinds: ["VWAP−2σ"], strength: 1 },
    { price: trigger - 190, label: "74,000", kinds: ["74000"], strength: 2 },
    { price: trigger, label: "PDL + S1", kinds: ["PDL", "S1"], strength: 5 },
    { price: trigger + 160, label: "VWAP", kinds: ["VWAP"], strength: 2 },
  ];
  return { setups: [setup], levels, setupNote: null };
}
