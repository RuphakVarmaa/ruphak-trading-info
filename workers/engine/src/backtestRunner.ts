/** Starts and reads dashboard backtests (one BacktestDO per run). */
import type { BacktestParams, BacktestResult } from "../../../src/engine/api-types";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateParams(p: BacktestParams): string | null {
  if (!p || typeof p !== "object") return "missing parameters";
  if (!DATE.test(p.from) || !DATE.test(p.to)) return "from/to must be YYYY-MM-DD";
  if (p.from > p.to) return "from must not be after to";
  if (!["NIFTY", "SENSEX", "BOTH"].includes(p.index)) return "index must be NIFTY, SENSEX or BOTH";
  if (!Number.isFinite(p.thresholdDelta) || Math.abs(p.thresholdDelta) > 0.5) return "thresholdDelta must be within ±0.5";
  if (!(p.stopPct > 0 && p.stopPct <= 90) || !(p.targetPct > 0 && p.targetPct <= 500)) return "stopPct must be 1-90 and targetPct 1-500";
  return null;
}

export async function startBacktest(env: Env, _ctx: ExecutionContext, params: BacktestParams, actor: string): Promise<{ runId: string; status: "RUNNING" | "DONE" }> {
  const problem = validateParams(params);
  if (problem) throw new Error(`BAD_REQUEST: ${problem}`);
  const runId = crypto.randomUUID();
  const clean: BacktestParams = {
    from: params.from,
    to: params.to,
    index: params.index,
    thresholdDelta: Number(params.thresholdDelta) || 0,
    stopPct: Number(params.stopPct),
    targetPct: Number(params.targetPct),
    noEvents: Boolean(params.noEvents),
  };
  return env.BACKTEST_DO.get(env.BACKTEST_DO.idFromName(runId)).start(runId, clean, actor);
}

export async function getBacktest(env: Env, runId: string): Promise<BacktestResult | null> {
  if (!/^[0-9a-f-]{36}$/.test(runId)) return null;
  return env.BACKTEST_DO.get(env.BACKTEST_DO.idFromName(runId)).get();
}
