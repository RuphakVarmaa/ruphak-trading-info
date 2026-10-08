/** Backtest form defaults and URL query (de)serialization shared by the page and its client. */
import { ACCOUNTS, parseAccountId, type AccountId } from "@/engine/accounts";
import type { BacktestParams } from "@/engine/api-types";
import { DEFAULT_CONFIG } from "@/engine/config";
import { addDays, isIsoDate } from "@/lib/ist";

/** One paper account as the backtest form offers it, read from the engine's account registry. */
export interface BacktestAccount {
  id: AccountId;
  label: string;
  shortLabel: string;
  capitalRupees: number;
  /** The account's own default stop and target, percent of the option premium. */
  stopPct: number;
  targetPct: number;
}

/** Every account in src/engine/accounts.ts, main first: a new account appears here without a code change. */
export const BACKTEST_ACCOUNTS: readonly BacktestAccount[] = (Object.keys(ACCOUNTS) as AccountId[]).map((id) => {
  const spec = ACCOUNTS[id];
  const patch = spec.configPatch;
  return {
    id,
    label: spec.label,
    shortLabel: spec.shortLabel,
    capitalRupees: patch.capitalRupees ?? DEFAULT_CONFIG.capitalRupees,
    stopPct: patch.exits?.stopPct ?? DEFAULT_CONFIG.exits.stopPct,
    targetPct: patch.exits?.targetPct ?? DEFAULT_CONFIG.exits.targetPct,
  };
});

/** The account's form entry; unknown ids fall back to main. */
export function backtestAccount(id: string | undefined): BacktestAccount {
  return BACKTEST_ACCOUNTS.find((a) => a.id === id) ?? BACKTEST_ACCOUNTS.find((a) => a.id === "main") ?? BACKTEST_ACCOUNTS[0];
}

export function defaultBacktestParams(todayIst: string, account?: string): BacktestParams {
  const to = addDays(todayIst, -1);
  const a = backtestAccount(account);
  return {
    from: addDays(to, -90),
    to,
    index: "BOTH",
    thresholdDelta: 0,
    stopPct: a.stopPct,
    targetPct: a.targetPct,
    noEvents: false,
    ...(a.id !== "main" ? { account: a.id } : {}),
  };
}

type Query = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function num(v: string | undefined, lo: number, hi: number, def: number): number {
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : def;
}

/** Lenient: anything invalid falls back to the default for that field (an unknown account means main). */
export function paramsFromQuery(q: Query, todayIst: string): BacktestParams {
  const account = parseAccountId(first(q.account)) ?? "main";
  const d = defaultBacktestParams(todayIst, account);
  const from = first(q.from);
  const to = first(q.to);
  const index = first(q.index);
  return {
    from: from && isIsoDate(from) ? from : d.from,
    to: to && isIsoDate(to) ? to : d.to,
    index: index === "NIFTY" || index === "SENSEX" || index === "BOTH" ? index : d.index,
    thresholdDelta: num(first(q.thresholdDelta), -0.3, 0.3, d.thresholdDelta),
    stopPct: num(first(q.stopPct), -90, -5, d.stopPct),
    targetPct: num(first(q.targetPct), 5, 300, d.targetPct),
    noEvents: first(q.noEvents) === "1" || first(q.noEvents) === "true",
    ...(account !== "main" ? { account } : {}),
  };
}

export function paramsToQuery(p: BacktestParams, runId?: string | null): string {
  const q = new URLSearchParams({
    from: p.from,
    to: p.to,
    index: p.index,
    thresholdDelta: String(p.thresholdDelta),
    stopPct: String(p.stopPct),
    targetPct: String(p.targetPct),
    noEvents: p.noEvents ? "1" : "0",
  });
  if (p.account && p.account !== "main") q.set("account", p.account);
  if (runId) q.set("runId", runId);
  return q.toString();
}
