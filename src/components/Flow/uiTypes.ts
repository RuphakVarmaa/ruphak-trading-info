/**
 * The shapes the flow panel and the ₹10k card render, and adapters from the engine's views
 * (OptionFlowView and RecommendationView in src/engine/api-types.ts). The two were built in parallel;
 * the engine's views carry more, and these adapters keep the components on one small, stable shape.
 */
import type { OptionFlowView, RecommendationView } from "@/engine/api-types";

export type Buildup = "LONG_BUILDUP" | "SHORT_BUILDUP" | "SHORT_COVERING" | "LONG_UNWINDING" | "NEUTRAL";

export interface FlowSide {
  oi: number | null;
  oiChg: number | null;
  oiChgPct: number | null;
  vol: number | null;
  ltp: number | null;
  ltpChgPct: number | null;
  ivChg: number | null;
  buildup: Buildup;
}

export interface UiFlowEvent {
  at: string;
  index: string;
  strike: number;
  side: "CE" | "PE";
  kind: "LONG_BUILDUP" | "SHORT_BUILDUP" | "SHORT_COVERING" | "LONG_UNWINDING" | "VOLUME_SPIKE" | "DRY_UP" | "OI_WALL";
  text: string;
  magnitude: number;
}

export interface UiOptionFlow {
  index: OptionFlowView["index"];
  asOf: string;
  spot: number;
  atm: number;
  windows: Record<"1m" | "5m" | "15m", { rows: { strike: number; ce: FlowSide | null; pe: FlowSide | null }[] }>;
  events: UiFlowEvent[];
  summary: {
    callWritersVsPutWriters: number;
    pcr: number | null;
    pcrChg15m: number | null;
    resistance: number | null;
    support: number | null;
    premiumDryUp: boolean;
    decayPctPerHourAtm: number | null;
  };
  bestEntryWindow: { window: string; verdict: "good" | "neutral" | "expensive"; reason: string } | null;
  source: "feed" | "rest" | "mock";
  error: string | null;
}

export interface UiReco {
  status: RecommendationView["status"];
  index: RecommendationView["index"];
  grade: RecommendationView["grade"];
  capital: number;
  contract: { strike: number; optionType: "CE" | "PE"; expiry: string; tradingSymbol: string; lotSize: number; label: string } | null;
  entry: { limit: number; validUntil: string; trigger: string } | null;
  stop: { premium: number; index: number | null } | null;
  target: { t1: number; t2: number | null; indexT1: number | null } | null;
  timeExit: string | null;
  lots: number;
  costRupees: number;
  riskRupees: number;
  rewardRupees: number;
  rr: number | null;
  reasons: string[];
  historical: {
    ruleIds: string[];
    sample: number;
    hitRate: number | null;
    avgPnlPerLot: number | null;
    ci95: [number, number] | null;
    verdict: "positive" | "not_proven" | "negative";
    dataRange: string;
  } | null;
  honestLine: string;
  asOf: string;
}

const EMPTY_WINDOW = { rows: [] };

/** The engine's OptionFlowView in the panel's shape. */
export function toUiFlow(f: OptionFlowView): UiOptionFlow {
  const win = (k: "1m" | "5m" | "15m") => ({ rows: (f.windows?.[k] ?? EMPTY_WINDOW).rows.map((r) => ({ strike: r.strike, ce: r.ce, pe: r.pe })) });
  const cw = f.summary.callWritersVsPutWriters;
  const ew = f.bestEntryWindow;
  return {
    index: f.index,
    asOf: f.asOf ?? "",
    spot: f.spot ?? 0,
    atm: f.atm ?? 0,
    windows: { "1m": win("1m"), "5m": win("5m"), "15m": win("15m") },
    events: f.events.map((e) => ({
      at: e.at,
      index: f.index,
      strike: e.strike ?? 0,
      side: e.side ?? "CE",
      kind:
        e.kind === "OI_BUILDUP"
          ? e.buildup && e.buildup !== "NEUTRAL"
            ? e.buildup
            : "OI_WALL"
          : e.kind === "VOLUME_SPIKE" || e.kind === "DRY_UP"
            ? e.kind
            : "OI_WALL",
      text: e.text,
      magnitude: Math.abs(e.oiChg ?? e.volMultiple ?? 0),
    })),
    summary: {
      callWritersVsPutWriters: (cw.ceOiAdded ?? 0) - (cw.peOiAdded ?? 0),
      pcr: f.summary.pcr,
      pcrChg15m: f.summary.pcrChg15m,
      resistance: f.summary.resistance?.strike ?? null,
      support: f.summary.support?.strike ?? null,
      premiumDryUp: f.summary.premiumDryUp,
      decayPctPerHourAtm: f.summary.decayPctPerHourAtm,
    },
    bestEntryWindow: ew
      ? { window: ew.now?.window ?? ew.best?.window ?? "", verdict: ew.verdict === "good" || ew.verdict === "expensive" ? ew.verdict : "neutral", reason: ew.text }
      : null,
    source: f.source,
    error: f.note,
  };
}

/** The engine's RecommendationView in the card's shape. */
export function toUiReco(r: RecommendationView): UiReco {
  const h = r.historical;
  return {
    status: r.status,
    index: r.index,
    grade: r.grade,
    capital: r.capital,
    contract: r.contract
      ? { strike: r.contract.strike, optionType: r.contract.optionType, expiry: r.contract.expiry, tradingSymbol: r.contract.tradingSymbol, lotSize: r.contract.lotSize, label: r.contract.label }
      : null,
    entry: r.entry ? { limit: r.entry.limit, validUntil: r.entry.validUntil, trigger: r.entry.trigger } : null,
    stop: r.stop ? { premium: r.stop.premium, index: r.stop.index } : null,
    target: r.target ? { t1: r.target.t1, t2: r.target.t2, indexT1: r.target.indexT1 } : null,
    timeExit: r.timeExit,
    lots: r.qty?.lots ?? 0,
    costRupees: r.qty?.totalRupees ?? 0,
    riskRupees: r.risk?.riskRupees ?? 0,
    rewardRupees: r.risk?.rewardT1Rupees ?? 0,
    rr: r.risk?.rr1 ?? null,
    reasons: [...r.reasons, ...r.cautions.map((c) => `Caution: ${c}`)],
    historical:
      h.verdict === "none"
        ? null
        : { ruleIds: h.ruleIds, sample: h.sample, hitRate: h.hitRate, avgPnlPerLot: h.avgPnlPerLot, ci95: h.ci95, verdict: h.verdict, dataRange: h.dataRange ?? "" },
    honestLine: r.honest ?? h.text,
    asOf: r.at,
  };
}
