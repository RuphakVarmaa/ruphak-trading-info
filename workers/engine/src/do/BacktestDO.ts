/**
 * BacktestDO: one instance per dashboard backtest run. It loads Yahoo history and the scored
 * events from D1, then replays a few trading days per alarm so a long run never hits the
 * per-invocation CPU limit. Progress and the final result live in this object's storage;
 * finished results are also written to the optional R2 archive (backtests/<runId>.json).
 */
import { DurableObject } from "cloudflare:workers";
import { parseAccountId } from "../../../../src/engine/accounts";
import type { BacktestParams, BacktestResult } from "../../../../src/engine/api-types";
import { loadYahooHistory } from "../../../../src/engine/backtest/history";
import { BacktestRun, configForParams, followerConfigForParams, toBacktestResult } from "../../../../src/engine/backtest/runBacktest";
import { DAY_MS, addDays, istDate, istMidnight } from "../../../../src/engine/clock";
import { MARKET_SYMBOLS } from "../../../../src/engine/types";
import { archiveBucket, errorMessage, makeRuntime } from "../runtime";

const DAYS_PER_ALARM = 3;

interface Meta {
  runId: string;
  params: BacktestParams;
  actor: string;
  startedMs: number;
  finishedMs: number | null;
  status: BacktestResult["status"];
  progress: number;
  error: string | null;
}

export class BacktestDO extends DurableObject<Env> {
  private run: BacktestRun | null = null;

  async start(runId: string, params: BacktestParams, actor: string): Promise<{ runId: string; status: "RUNNING" | "DONE" }> {
    const existing = await this.ctx.storage.get<Meta>("meta");
    if (existing) return { runId: existing.runId, status: existing.status === "DONE" ? "DONE" : "RUNNING" };
    const meta: Meta = { runId, params, actor, startedMs: Date.now(), finishedMs: null, status: "RUNNING", progress: 0, error: null };
    await this.ctx.storage.put("meta", meta);
    await this.ctx.storage.setAlarm(Date.now() + 100);
    return { runId, status: "RUNNING" };
  }

  async get(): Promise<BacktestResult | null> {
    const meta = await this.ctx.storage.get<Meta>("meta");
    if (!meta) return null;
    if (meta.status !== "RUNNING") return (await this.ctx.storage.get<BacktestResult>("result")) ?? toBacktestResult(meta.runId, meta.params, null, meta);
    return toBacktestResult(meta.runId, meta.params, null, meta);
  }

  private async fail(meta: Meta, error: string): Promise<void> {
    const done: Meta = { ...meta, status: "ERROR", error, finishedMs: Date.now() };
    await this.ctx.storage.put("meta", done);
    await this.ctx.storage.put("result", toBacktestResult(meta.runId, meta.params, null, done));
  }

  async alarm(): Promise<void> {
    const meta = await this.ctx.storage.get<Meta>("meta");
    if (!meta || meta.status !== "RUNNING") return;
    const rt = makeRuntime(this.env, "backtest");
    try {
      if (!this.run) {
        if (meta.progress > 0) return this.fail(meta, "the run was interrupted (engine restarted); start it again");
        const history = await loadYahooHistory();
        const nifty = history.candles[MARKET_SYMBOLS.NIFTY] ?? [];
        if (nifty.length === 0) return this.fail(meta, `no market history: ${history.errors.join("; ")}`);
        const firstDay = istDate(nifty[0].t);
        // Keep a few sessions of warm-up before the first replayed day.
        const from = meta.params.from > addDays(firstDay, 7) ? meta.params.from : addDays(firstDay, 7);
        const to = meta.params.to < istDate(Date.now()) ? meta.params.to : addDays(istDate(Date.now()), -1);
        if (from > to) return this.fail(meta, `Yahoo keeps about 60 days of 5-minute bars: the earliest replayable day is ${addDays(firstDay, 7)}`);
        const events = meta.params.noEvents ? [] : await rt.repo.events.active(istMidnight(from) - 2 * DAY_MS);
        const account = parseAccountId(meta.params.account);
        if (account === null) return this.fail(meta, `unknown account ${String(meta.params.account).slice(0, 40)}`);
        const follows = account !== "main";
        // A follower backtest replays main with its own exits and applies the run's stop and target to the follower.
        const mainParams = follows ? { ...meta.params, stopPct: Math.abs(rt.cfg.exits.stopPct), targetPct: rt.cfg.exits.targetPct } : meta.params;
        this.run = new BacktestRun({
          cfg: configForParams(rt.cfg, mainParams),
          from,
          to,
          candles: history.candles,
          daily: history.daily,
          events,
          noEvents: meta.params.noEvents,
          calendar: rt.calendar,
          followers: follows ? [{ account, cfg: followerConfigForParams(rt.cfg, account, meta.params) }] : undefined,
        });
        if (from !== meta.params.from || to !== meta.params.to) await this.ctx.storage.put("clamped", `${from}..${to}`);
      }
      // A follower backtest replays two books per day, so it takes fewer days per alarm.
      const perAlarm = meta.params.account && meta.params.account !== "main" ? 2 : DAYS_PER_ALARM;
      for (let i = 0; i < perAlarm && !this.run.done; i++) await this.run.step();
      const progress = this.run.progress;
      if (!this.run.done) {
        await this.ctx.storage.put("meta", { ...meta, progress });
        await this.ctx.storage.setAlarm(Date.now() + 50);
        return;
      }
      const account = parseAccountId(meta.params.account) ?? "main";
      const out = await this.run.result(account);
      const clamped = await this.ctx.storage.get<string>("clamped");
      if (clamped) out.notes.unshift(`Replayed ${clamped} (the requested range was clamped to the available 5-minute history).`);
      const done: Meta = { ...meta, status: "DONE", progress: 1, finishedMs: Date.now() };
      const result = toBacktestResult(meta.runId, meta.params, out, done);
      await this.ctx.storage.put("meta", done);
      await this.ctx.storage.put("result", result);
      await archiveBucket(this.env)?.put(`backtests/${meta.runId}.json`, JSON.stringify(result), { httpMetadata: { contentType: "application/json" } });
      await rt.repo.audit.append({ ts: Date.now(), actor: meta.actor, action: "backtest_done", entity: "backtest", entityId: meta.runId, detail: { trades: out.summary.trades, net: out.summary.netPnl } });
      this.run = null;
    } catch (err) {
      rt.logger.error("backtest failed", { runId: meta.runId, error: errorMessage(err) });
      this.run = null;
      await this.fail(meta, errorMessage(err));
    }
  }
}
