/** Backtest form defaults and URL query (de)serialization shared by the page and its client. */
import type { BacktestParams } from "@/engine/api-types";
import { addDays, isIsoDate } from "@/lib/ist";

export function defaultBacktestParams(todayIst: string): BacktestParams {
  const to = addDays(todayIst, -1);
  return { from: addDays(to, -90), to, index: "BOTH", thresholdDelta: 0, stopPct: -30, targetPct: 50, noEvents: false };
}

type Query = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function num(v: string | undefined, lo: number, hi: number, def: number): number {
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : def;
}

/** Lenient: anything invalid falls back to the default for that field. */
export function paramsFromQuery(q: Query, todayIst: string): BacktestParams {
  const d = defaultBacktestParams(todayIst);
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
  if (runId) q.set("runId", runId);
  return q.toString();
}
