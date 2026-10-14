/**
 * EngineAdmin.getOptionFlow: the market feed's minute-sampled view (MarketFeedDO.getOptionFlow) when it has
 * any minutes, otherwise what one REST option chain (UpstoxLive) can show, clearly flagged (source "rest"):
 * the latest OI, prices, PCR and the OI walls, plus the change since the previous session's close (the
 * chain's previous OI and close) as the `day` window. The 1, 5 and 15-minute windows stay empty: they need
 * minute samples. Pure apart from the two injected reads.
 */
import type { FlowSideView, FlowStrikeRow, FlowWindowView, IndexId, OptionChainView, OptionFlowView, OptionSideView } from "../api-types";
import { istIso, istMinutes } from "../clock";
import { FLOW_STATS, entryWindowVerdict, type FlowStatsFile } from "./flowStats";
import { FlowMonitor, classifyBuildup, emptyFlowView, nearestStrike, strikeStep, writersLean, type ChainSnapshot, type SideQuote } from "./flowMonitor";

/** The day's build-up thresholds (versus the previous close): |ΔOI %| and |ΔLTP %|. */
export const DAY_MIN_OI_CHG_PCT = 5;
export const DAY_MIN_LTP_CHG_PCT = 5;
/** Strikes each side of ATM kept from a REST chain (as the feed subscribes). */
export const REST_STRIKES_EACH_SIDE = 15;

const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;

function quote(s: OptionSideView | null): SideQuote | null {
  if (!s || s.ltp === null) return null;
  return { ltp: s.ltp, volume: s.volume, oi: s.oi, bid: s.bid, ask: s.ask, iv: s.iv, delta: s.delta };
}

/** ATM ± REST_STRIKES_EACH_SIDE of a REST chain as a snapshot taken at `t`; null without a spot or rows. */
export function chainSnapshotFromView(chain: OptionChainView, t: number): ChainSnapshot | null {
  if (!(chain.spot > 0) || chain.rows.length === 0) return null;
  const sorted = [...chain.rows].sort((a, b) => a.strike - b.strike);
  const atm = nearestStrike(sorted, chain.spot);
  const i = sorted.findIndex((r) => r.strike === atm);
  const rows = sorted
    .slice(Math.max(0, i - REST_STRIKES_EACH_SIDE), i + REST_STRIKES_EACH_SIDE + 1)
    .map((r) => ({ strike: r.strike, ce: quote(r.ce), pe: quote(r.pe) }))
    .filter((r) => r.ce !== null || r.pe !== null);
  if (rows.length === 0) return null;
  return { t, index: chain.index, expiry: chain.expiry || null, lotSize: chain.lotSize > 0 ? chain.lotSize : null, spot: chain.spot, rows };
}

function daySide(s: OptionSideView | null): FlowSideView | null {
  if (!s) return null;
  const oiChg = s.oi !== null && s.prevOi !== null ? s.oi - s.prevOi : null;
  const oiChgPct = oiChg !== null && s.prevOi !== null && s.prevOi > 0 ? round((oiChg / s.prevOi) * 100, 2) : null;
  return {
    oi: s.oi,
    ltp: s.ltp,
    bid: s.bid,
    ask: s.ask,
    iv: s.iv,
    delta: s.delta,
    oiChg,
    oiChgPct,
    vol: s.volume,
    volMultiple: null,
    ltpChgPct: s.changePct,
    ivChg: null,
    buildup: classifyBuildup(oiChgPct, s.changePct, DAY_MIN_OI_CHG_PCT, DAY_MIN_LTP_CHG_PCT),
  };
}

/** The flow view one REST chain supports (see the header). */
export function restFlowView(chain: OptionChainView, nowMs: number, opts: { stats?: FlowStatsFile; why?: string; dte?: number | null } = {}): OptionFlowView {
  const stats = opts.stats ?? FLOW_STATS;
  const fetched = Date.parse(chain.fetchedAt);
  const t = Number.isFinite(fetched) ? fetched : nowMs;
  const snap = chainSnapshotFromView(chain, t);
  const why = opts.why ? `${opts.why}: ` : "";
  if (!snap) {
    const best = entryWindowVerdict(stats, chain.index, istMinutes(nowMs), opts.dte ?? null);
    return emptyFlowView(chain.index, "rest", stats, best, `${why}no REST option chain either${chain.error ? ` (${chain.error})` : ""}.`);
  }
  const monitor = new FlowMonitor({ stats });
  monitor.ingest(snap);
  const note = `${why}built from one REST option chain fetched ${istIso(t).slice(11, 19)} IST. The 1, 5 and 15-minute changes, build-ups and volume spikes need the live feed's minute samples; "day" shows the change since the previous close.`;
  const view = monitor.view(chain.index, nowMs, { source: "rest", dte: opts.dte ?? null, note });
  const keep = new Set(snap.rows.map((r) => r.strike));
  const dayRows: FlowStrikeRow[] = chain.rows
    .filter((r) => keep.has(r.strike))
    .sort((a, b) => a.strike - b.strike)
    .map((r) => ({ strike: r.strike, ce: daySide(r.ce), pe: daySide(r.pe) }));
  const day: FlowWindowView = { minutes: 0, from: null, rows: dayRows };
  const changes = new Map(dayRows.map((r) => [r.strike, { ce: r.ce?.oiChg ?? null, pe: r.pe?.oiChg ?? null }]));
  const atm = nearestStrike(snap.rows, snap.spot);
  return { ...view, day, summary: { ...view.summary, callWritersVsPutWriters: writersLean(snap, null, atm, strikeStep(snap.rows), "day", changes) } };
}

/**
 * The feed's view when it has minute samples, else the REST fallback. A feed that throws or does not answer
 * counts as no feed; a chain read that throws gives an empty view with the reason.
 */
export async function optionFlowWithFallback(
  index: IndexId,
  feed: () => Promise<OptionFlowView | null>,
  chain: () => Promise<OptionChainView>,
  nowMs: number,
  opts: { stats?: FlowStatsFile; dte?: number | null } = {},
): Promise<OptionFlowView> {
  let v: OptionFlowView | null = null;
  try {
    v = await feed();
  } catch {
    v = null;
  }
  if (v && v.minutes > 0) return v;
  const why = v ? "The market feed has no option-flow minutes yet" : "The market feed did not answer";
  let c: OptionChainView;
  try {
    c = await chain();
  } catch (err) {
    const stats = opts.stats ?? FLOW_STATS;
    return emptyFlowView(index, "rest", stats, entryWindowVerdict(stats, index, istMinutes(nowMs), opts.dte ?? null), `${why}, and the REST chain failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`);
  }
  return restFlowView(c, nowMs, { ...opts, why });
}
