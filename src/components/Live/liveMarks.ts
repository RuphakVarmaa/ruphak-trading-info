/**
 * Re-prices open positions on the live feed's index (NIFTY) from its live price, so the Live P&L page
 * can move every couple of seconds instead of on the engine's 30-second marks. Positions on another
 * index (SENSEX) keep the engine's marks. Uses the engine's own model (Black-Scholes on
 * India VIX with the modelled spread) and its own rule of marking at the bid. The engine still decides
 * stops and targets on its own cycle; these numbers are the page's live estimate.
 */
import type { PositionView } from "@/engine/api-types";
import { defaultCalendar } from "@/engine/calendar/calendar";
import { DEFAULT_CONFIG } from "@/engine/config";
import { syntheticQuote } from "@/engine/pricing/syntheticOptionPricer";
import type { IndexId, OptionContract } from "@/engine/types";

export interface LiveInputs {
  /** The index the live price belongs to; only its positions are re-priced. */
  index: IndexId;
  spot: number;
  vix: number | null;
  /** IST ISO time the inputs were fetched; shown as the price's "as of". */
  asOf: string;
  /** The same moment, epoch ms; time to expiry is measured from here. */
  atMs: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Price move on a position before charges: (mark - entry) x quantity. Zero until it has a mark. */
export const rawUnrealized = (p: Pick<PositionView, "ltp" | "avgPrice" | "qty">): number => (p.ltp == null ? 0 : (p.ltp - p.avgPrice) * p.qty);

/** Entry charges the engine already took off the position's P&L (price move minus reported P&L). */
const entryCharges = (p: PositionView): number => Math.max(0, rawUnrealized(p) - p.pnl);

/** The position re-marked at the live price, or unchanged when there is no usable price. */
export function markLive(p: PositionView, live: LiveInputs | null): PositionView {
  if (!live || p.index !== live.index || live.vix == null || !(live.vix > 0) || !(live.spot > 0) || p.ltp == null) return p;
  const spec = DEFAULT_CONFIG.indexSpecs[p.index];
  if (!spec) return p;
  const contract: OptionContract = {
    index: p.index,
    exchange: spec.exchange,
    tradingSymbol: p.contract.tradingSymbol,
    growwSymbol: "",
    exchangeToken: "",
    expiry: p.contract.expiry,
    strike: p.contract.strike,
    type: p.contract.optionType,
    lotSize: p.contract.lotSize,
    tickSize: spec.tickSize,
  };
  const q = syntheticQuote(contract, { t: live.atMs, spot: live.spot, vix: live.vix }, defaultCalendar, DEFAULT_CONFIG);
  const mark = q.bid > 0 ? q.bid : q.ltp;
  if (!(mark > 0)) return p;
  const pnl = (mark - p.avgPrice) * p.qty - entryCharges(p);
  const cost = p.avgPrice * p.qty;
  return { ...p, ltp: round2(mark), ltpAsOf: live.asOf, pnl: round2(pnl), pnlPct: cost > 0 ? round2((pnl / cost) * 100) : 0 };
}
