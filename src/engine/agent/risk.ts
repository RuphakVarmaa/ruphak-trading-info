/** The agent account's risk snapshot and its drawdown halt (SPEC §5.5). The model never sets or reads these limits. */
import { ACCOUNTS } from "../accounts";
import { istDate } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import type { RiskState } from "../types";
import { AGENT_LIMITS } from "./constants";
import { codeRiskState } from "./policy";
import type { AgentRiskSnapshot } from "./types";

/** The agent account's pinned trades a day (ACCOUNTS.agent), for the account-level code risk. */
const AGENT_MAX_TRADES_PER_DAY = ACCOUNTS.agent.configPatch.sizing?.maxTradesPerDay ?? DEFAULT_CONFIG.sizing.maxTradesPerDay;

const finite = (x: number) => (Number.isFinite(x) ? x : 0);

/**
 * The account's risk now, from its RiskState (loaded with the agent's own settings).
 * - equity = start-of-day equity + realized + unrealized − charges, the ledger's own mark-to-market. A position whose
 *   mark is not a number counts as having lost its whole premium, so broken data can only look worse.
 * - peakEquity = the higher of `prevPeak` (TE keeps it across days) and equity. Without a previous peak (first run, or
 *   just re-armed) the peak restarts at the current equity, never at an older intraday high.
 * - ddPct is the fall from that peak in percent; dayLossPct today's net loss in percent of the equity sizing uses.
 * - openPositions counts open positions and entry orders still working (each holds a slot).
 * - codeRisk is the account-level code risk (no index context; trades a day from the agent's pinned config unless
 *   `maxTradesPerDay` is given).
 */
export function riskSnapshotFrom(
  r: RiskState,
  prevPeak: number | null,
  flags: { killSwitch: boolean; killReason: string | null; mainKillSwitch: boolean; ddHalt: boolean; nowMs: number; maxTradesPerDay?: number },
): AgentRiskSnapshot {
  const d = r.day;
  const unrealized = Number.isFinite(d.unrealized)
    ? d.unrealized
    : r.openPositions.reduce((s, p) => s + (Number.isFinite(p.unrealized) ? p.unrealized : -finite(Math.abs(p.avgEntry * p.qty))), 0);
  const net = finite(d.realized) + unrealized - finite(d.charges);
  const equity = finite(d.startEquity) + net;
  const peakEquity = typeof prevPeak === "number" && Number.isFinite(prevPeak) && prevPeak > 0 ? Math.max(prevPeak, equity) : equity;
  const ddPct = peakEquity > 0 ? Math.max(0, ((peakEquity - equity) / peakEquity) * 100) : 0;
  const dayLossPct = r.capitalRupees > 0 ? (Math.max(0, -net) / r.capitalRupees) * 100 : 0;
  const pending = r.pendingEntries?.length ?? 0;
  const snap: AgentRiskSnapshot = {
    t: flags.nowMs,
    date: istDate(flags.nowMs),
    equity,
    peakEquity,
    ddPct,
    dayLossPct,
    openPositions: r.openPositions.length + pending,
    killSwitch: flags.killSwitch,
    killReason: flags.killReason,
    mainKillSwitch: flags.mainKillSwitch,
    ddHalt: flags.ddHalt,
    codeRisk: "SAFE",
  };
  const entriesToday = finite(r.entriesToday.NIFTY) + finite(r.entriesToday.SENSEX) + pending;
  snap.codeRisk = codeRiskState(snap, 0, entriesToday, flags.maxTradesPerDay ?? AGENT_MAX_TRADES_PER_DAY);
  return snap;
}

/** True when the drawdown from peak equity reached AGENT_LIMITS.maxDrawdownPct (15.00 counts); an unknown drawdown counts too. */
export function drawdownBreached(s: AgentRiskSnapshot): boolean {
  return !(s.ddPct < AGENT_LIMITS.maxDrawdownPct - 1e-9);
}
