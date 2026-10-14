/**
 * DASHBOARD STUB — drop this file (and its two call sites in mock.ts) once the engine's own mock publishes
 * getOptionFlow and SignalView.recommendation.
 *
 * Option flow and the ₹10k recommendation for the mock engine (ENGINE_MOCK=1, or no engine binding), worked
 * out from the mock's synthetic option chain so the dashboard's panels have something to draw. It is
 * practice data: the flow says source "mock", and every recommendation says it is the mock in its honest
 * line. The measured history attached to a recommendation is only ever taken from FLOW_STATS (the research's
 * generated file); without a matching rule it is null.
 */
import type { IndexId, OptionChainView, OptionFlowView, OptionSideView, RecommendationView, SignalView } from "@/engine/api-types";
import { computeCharges } from "@/engine/broker/charges";
import { FLOW_STATS } from "@/engine/flow/flowStats.generated";
import { istDate, istParts, MINUTE_MS, SESSION, toIstIso } from "@/lib/ist";
import { hashString, mulberry32, round2 } from "./random";

type Window = keyof OptionFlowView["windows"];
type Flow = NonNullable<OptionFlowView["windows"][Window]["rows"][number]["ce"]>;
type Event = OptionFlowView["events"][number];

const WINDOWS: [Window, number][] = [
  ["1m", 1],
  ["5m", 5],
  ["15m", 15],
];
const HALF_WIDTH = 15;
const CAPITAL = 10_000;
const tick05 = (n: number) => Math.max(0.05, Math.round(n * 20) / 20);
const lakh = (n: number) => `${(Math.abs(n) / 1e5).toFixed(1)}L`;

function buildup(ltpChgPct: number, oiChgPct: number): Flow["buildup"] {
  if (Math.abs(ltpChgPct) < 0.25 || Math.abs(oiChgPct) < 0.3) return "NEUTRAL";
  if (oiChgPct > 0) return ltpChgPct > 0 ? "LONG_BUILDUP" : "SHORT_BUILDUP";
  return ltpChgPct > 0 ? "SHORT_COVERING" : "LONG_UNWINDING";
}

/** Minutes since the open, at least 1 (the mock spreads the day's OI change over them). */
function minutesIn(nowMs: number): number {
  return Math.max(1, Math.min(375, istParts(nowMs).minutesOfDay - SESSION.open));
}

function flowSide(chain: OptionChainView, strike: number, type: "CE" | "PE", s: OptionSideView, win: Window, mins: number, nowMs: number): Flow {
  const bucket = Math.floor(nowMs / MINUTE_MS);
  const r = mulberry32(hashString(`${chain.index}|${strike}|${type}|${win}|${bucket}`));
  const day = minutesIn(nowMs);
  const oi = s.oi ?? 0;
  const dayChg = s.oiChange ?? 0;
  const oiChg = Math.round((dayChg * (mins / day) * (0.4 + 1.6 * r())) / chain.lotSize) * chain.lotSize;
  const before = oi - oiChg;
  const spike = r() > 0.94 ? 4 + 3 * r() : 1;
  const vol = Math.round(((s.volume ?? 0) * (mins / day) * (0.5 + r()) * spike) / chain.lotSize) * chain.lotSize;
  // The price change follows the OI: writers adding pushes the premium down more often than not.
  const drift = (oiChg >= 0 ? -1 : 1) * (type === "CE" ? 1 : 0.8);
  const ltpChgPct = round2((drift * (0.2 + r()) + (r() - 0.5)) * Math.sqrt(mins));
  const oiChgPct = before > 0 ? round2((oiChg / before) * 100) : null;
  return {
    oi,
    oiChg,
    oiChgPct,
    vol,
    ltp: s.ltp,
    ltpChgPct,
    ivChg: round2((r() - 0.5) * 0.4 * Math.sqrt(mins)),
    buildup: buildup(ltpChgPct, oiChgPct ?? 0),
  };
}

/** The ATM straddle's decay in % of its premium per trading hour, from the chain's own theta (per day). */
function atmDecayPctPerHour(chain: OptionChainView): number | null {
  const row = chain.rows.find((x) => x.strike === chain.atmStrike);
  const ce = row?.ce;
  const pe = row?.pe;
  if (!ce?.ltp || !pe?.ltp || ce.theta == null || pe.theta == null) return null;
  return round2(((Math.abs(ce.theta) + Math.abs(pe.theta)) / (ce.ltp + pe.ltp) / 6.25) * 100);
}

function mockEvents(chain: OptionChainView, rows: OptionFlowView["windows"]["5m"]["rows"], nowMs: number): Event[] {
  const out: Event[] = [];
  const bucket = Math.floor(nowMs / MINUTE_MS);
  const near = rows.filter((r) => Math.abs(r.strike - chain.atmStrike) <= 4 * (rows[1]?.strike - rows[0]?.strike || 50));
  for (let m = 0; m < 24 && near.length > 0; m++) {
    const r = mulberry32(hashString(`${chain.index}|events|${bucket - m}`));
    const row = near[Math.floor(r() * near.length)];
    const type: "CE" | "PE" = r() < 0.5 ? "CE" : "PE";
    const f = type === "CE" ? row.ce : row.pe;
    if (!f) continue;
    const at = toIstIso((bucket - m) * MINUTE_MS + Math.floor(r() * 55_000));
    const name = `${row.strike} ${type}`;
    const pick = r();
    if (pick < 0.15 && f.vol != null) {
      const x = round2(3 + r() * 4);
      out.push({ at, index: chain.index, strike: row.strike, side: type, kind: "VOLUME_SPIKE", text: `${name}: volume ×${x.toFixed(1)} its 15-minute pace (mock)`, magnitude: x });
    } else if (pick < 0.22) {
      out.push({ at, index: chain.index, strike: row.strike, side: type, kind: "OI_WALL", text: `${name}: open interest ${lakh(f.oi ?? 0)}, the largest near the money (mock)`, magnitude: f.oi ?? 0 });
    } else if (f.buildup !== "NEUTRAL" && f.oiChg != null) {
      const verb = f.oiChg >= 0 ? "added" : "removed";
      const move = (f.ltpChgPct ?? 0) >= 0 ? "rose" : "fell";
      out.push({
        at,
        index: chain.index,
        strike: row.strike,
        side: type,
        kind: f.buildup,
        text: `${name}: ${lakh(f.oiChg)} OI ${verb} in 5 min while the premium ${move} ${Math.abs(f.ltpChgPct ?? 0).toFixed(1)}% (mock)`,
        magnitude: Math.abs(f.oiChg),
      });
    }
  }
  return out;
}

/** The plan's entry windows (research plan §4): not the first 15 minutes, not 11:15–14:15. Mock reasons only. */
function mockBestEntry(nowMs: number): OptionFlowView["bestEntryWindow"] {
  const m = istParts(nowMs).minutesOfDay;
  if (m < SESSION.open || m >= SESSION.close) return null;
  if (m < 9 * 60 + 30) return { window: "09:15–09:30 IST", verdict: "expensive", reason: "Mock: the first 15 minutes carry the day's richest premium." };
  if (m < 11 * 60 + 15) return { window: "09:30–11:15 IST", verdict: "good", reason: "Mock: inside the research plan's morning window." };
  if (m < 14 * 60 + 15) return { window: "11:15–14:15 IST", verdict: "expensive", reason: "Mock: the plan's midday no-trade window." };
  return { window: "14:15–15:30 IST", verdict: "neutral", reason: "Mock: late session; no new entries after 14:30." };
}

/** Option flow for one index from the mock chain (see the header: practice data). */
export function mockOptionFlow(chain: OptionChainView, nowMs: number): OptionFlowView {
  const step = chain.rows.length > 1 ? chain.rows[1].strike - chain.rows[0].strike : 50;
  const near = chain.rows.filter((r) => Math.abs(r.strike - chain.atmStrike) <= HALF_WIDTH * step);
  const windows = {} as OptionFlowView["windows"];
  for (const [w, mins] of WINDOWS) {
    windows[w] = {
      rows: near.map((r) => ({
        strike: r.strike,
        ce: r.ce ? flowSide(chain, r.strike, "CE", r.ce, w, mins, nowMs) : null,
        pe: r.pe ? flowSide(chain, r.strike, "PE", r.pe, w, mins, nowMs) : null,
      })),
    };
  }
  let ceOi = 0;
  let peOi = 0;
  let ceChg = 0;
  let peChg = 0;
  let resistance: { strike: number; oi: number } | null = null;
  let support: { strike: number; oi: number } | null = null;
  for (const r of windows["15m"].rows) {
    ceOi += r.ce?.oi ?? 0;
    peOi += r.pe?.oi ?? 0;
    ceChg += r.ce?.oiChg ?? 0;
    peChg += r.pe?.oiChg ?? 0;
    if (r.ce?.oi != null && r.strike >= chain.spot && (!resistance || r.ce.oi > resistance.oi)) resistance = { strike: r.strike, oi: r.ce.oi };
    if (r.pe?.oi != null && r.strike <= chain.spot && (!support || r.pe.oi > support.oi)) support = { strike: r.strike, oi: r.pe.oi };
  }
  const pcr = ceOi > 0 ? round2(peOi / ceOi) : null;
  const pcrBefore = ceOi - ceChg > 0 ? (peOi - peChg) / (ceOi - ceChg) : null;
  const decay = atmDecayPctPerHour(chain);
  return {
    index: chain.index,
    asOf: toIstIso(nowMs),
    spot: chain.spot,
    atm: chain.atmStrike,
    windows,
    events: mockEvents(chain, windows["5m"].rows, nowMs),
    summary: {
      callWritersVsPutWriters: ceChg - peChg,
      pcr,
      pcrChg15m: pcr != null && pcrBefore != null ? round2(pcr - pcrBefore) : null,
      resistance: resistance?.strike ?? null,
      support: support?.strike ?? null,
      premiumDryUp: decay != null && decay > 4,
      decayPctPerHourAtm: decay,
    },
    bestEntryWindow: mockBestEntry(nowMs),
    source: "mock",
    error: chain.error,
  };
}

function roundTripCharges(index: IndexId, entry: number, exit: number, qty: number, date: string): number {
  const ex = index === "NIFTY" ? "NSE" : "BSE";
  return computeCharges("BUY", entry, qty, ex, date).total + computeCharges("SELL", exit, qty, ex, date).total;
}

function historical(index: IndexId, type: "CE" | "PE"): RecommendationView["historical"] {
  const rule = FLOW_STATS.rules.find((r) => (r.index === index || r.index === "BOTH") && (r.side === type || r.side === "EITHER"));
  if (!rule) return null;
  return { ruleIds: [rule.id], sample: rule.sample, hitRate: rule.hitRate, avgPnlPerLot: rule.avgPnlPerLot, ci95: rule.ci95, verdict: rule.verdict, dataRange: rule.dataRange };
}

const MOCK_LINE = "Mock engine: practice data, not a market reading.";

function wait(signal: SignalView, nowMs: number, status: "WAIT" | "NO_TRADE", reasons: string[]): RecommendationView {
  return {
    status,
    index: signal.index,
    grade: "C",
    capital: CAPITAL,
    contract: null,
    entry: null,
    stop: null,
    target: null,
    timeExit: null,
    lots: 0,
    costRupees: 0,
    riskRupees: 0,
    rewardRupees: 0,
    rr: null,
    reasons,
    historical: null,
    honestLine: `${MOCK_LINE} Nothing to buy now.`,
    asOf: toIstIso(nowMs),
  };
}

/**
 * The ₹10k recommendation for one mock signal: ENTER on a directional signal past its threshold with the
 * nearest-to-ATM contract whose ask fits one lot in ₹10,000 (never the contract expiring today), the
 * engine's −30% stop and +50% target; WAIT otherwise.
 */
export async function mockRecommendation(signal: SignalView, chainFor: (expiry?: string) => Promise<OptionChainView>, nowMs: number): Promise<RecommendationView> {
  const m = istParts(nowMs).minutesOfDay;
  if (m < SESSION.open || m >= SESSION.close) return wait(signal, nowMs, "NO_TRADE", ["The market is closed."]);
  if (signal.stance === "NEUTRAL" || Math.abs(signal.conviction) < signal.entryThreshold) {
    return wait(signal, nowMs, "WAIT", [signal.noPlanReason ?? `No direction: conviction ${signal.conviction.toFixed(2)} is below ${signal.entryThreshold.toFixed(2)}.`]);
  }
  const today = istDate(nowMs);
  let chain = await chainFor();
  if (chain.expiry === today && chain.expiries[1]) chain = await chainFor(chain.expiries[1]);
  if (chain.expiry === today) return wait(signal, nowMs, "WAIT", ["Only today's expiry is listed; it is never bought for a multi-hour hold."]);
  const type: "CE" | "PE" = signal.stance === "BULLISH" ? "CE" : "PE";
  const step = chain.rows.length > 1 ? chain.rows[1].strike - chain.rows[0].strike : 50;
  const maxPremium = (CAPITAL - 80) / chain.lotSize;
  // ATM first, then outward on the out-of-the-money side until one lot fits.
  let pick: { strike: number; s: OptionSideView } | null = null;
  for (let k = 0; k <= 6 && !pick; k++) {
    const strike = chain.atmStrike + (type === "CE" ? k : -k) * step;
    const s = chain.rows.find((r) => r.strike === strike)?.[type === "CE" ? "ce" : "pe"];
    if (s?.ask != null && s.ask <= maxPremium) pick = { strike, s };
  }
  if (!pick) return wait(signal, nowMs, "NO_TRADE", [`No ${signal.index} ${type} near the money fits one lot in ₹10,000.`]);
  const limit = tick05(pick.s.ask!);
  const qty = chain.lotSize;
  const stopPrem = tick05(limit * 0.7);
  const t1 = tick05(limit * 1.5);
  const delta = Math.abs(pick.s.delta ?? 0.5) || 0.5;
  const dir = type === "CE" ? 1 : -1;
  const charges = round2(roundTripCharges(signal.index, limit, t1, qty, today));
  const risk = round2((limit - stopPrem) * qty + charges);
  const reward = round2((t1 - limit) * qty - charges);
  const h = historical(signal.index, type);
  return {
    status: "ENTER",
    index: signal.index,
    grade: "C",
    capital: CAPITAL,
    contract: { strike: pick.strike, optionType: type, expiry: chain.expiry, tradingSymbol: `${signal.index}${chain.expiry.replace(/-/g, "")}${pick.strike}${type}`, lotSize: chain.lotSize, label: `${signal.index} ${chain.expiry} ${pick.strike} ${type}` },
    entry: { limit, validUntil: toIstIso(nowMs + 3 * MINUTE_MS), trigger: `Now, while ${signal.index} is within ${Math.round(0.1 * step)} points of ${Math.round(chain.spot).toLocaleString("en-IN")}` },
    stop: { premium: stopPrem, index: Math.round(chain.spot - (dir * (limit - stopPrem)) / delta) },
    target: { t1, t2: null, indexT1: Math.round(chain.spot + (dir * (t1 - limit)) / delta) },
    timeExit: "15:05 IST",
    lots: 1,
    costRupees: round2(limit * qty),
    riskRupees: risk,
    rewardRupees: reward,
    rr: risk > 0 ? round2(reward / risk) : null,
    reasons: [
      `Mock signal ${signal.stance.toLowerCase()} at conviction ${signal.conviction.toFixed(2)} (threshold ${signal.entryThreshold.toFixed(2)})`,
      `Ask ₹${limit.toFixed(2)} × ${qty} = ₹${Math.round(limit * qty).toLocaleString("en-IN")}: one lot fits ₹10,000`,
      `Expiry ${chain.expiry}: not the contract expiring today`,
    ],
    historical: h,
    honestLine: h ? `${MOCK_LINE} The history shown is the research's measurement for rule ${h.ruleIds[0]}.` : `${MOCK_LINE} No measured history backs this trade.`,
    asOf: toIstIso(nowMs),
  };
}
