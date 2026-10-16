/**
 * AdvisorDO: the Advisor tab's plain-English brief. One instance ("advisor") holds the latest report, the
 * last 20 summaries and the run state in its storage.
 *
 * run(reason) queues an analysis (unless one is running or the rate limit says wait) and returns at once; the
 * alarm then reads the same inputs EngineAdmin serves (live levels, chains across expiries, option flow,
 * signals, news, scheduled events, today's plan, the paper book), runs the web research and the advice call
 * (src/engine/advisor/pipeline.ts) and stores the validated report. On failure the previous report stays and
 * lastError says why in plain words. A run stuck for 10 minutes is cleared. The minute cron calls autoRun()
 * for one automatic brief a trading day (ADVISOR_AUTO_RUN, 09:25 IST).
 *
 * Uses the existing ANTHROPIC_API_KEY secret; never logs the key, the prompt or the model's raw answer.
 */
import { DurableObject } from "cloudflare:workers";
import type { AdvisorReport, AdvisorReportSummary, AdvisorView, IndexId, OptionFlowView } from "../../../../src/engine/api-types";
import { ReadModel } from "../../../../src/engine/api/readModel";
import { AdvisorRunError, advisorClient, runAdvisorPipeline } from "../../../../src/engine/advisor/pipeline";
import { plainError } from "../../../../src/engine/advisor/research";
import {
  RUN_TIMEOUT_MS,
  autoRunDue,
  markFinished,
  markRunning,
  normalizeMeta,
  pushHistory,
  requestRun,
  toView,
  type AdvisorMeta,
} from "../../../../src/engine/advisor/runState";
import type { AdvisorSources } from "../../../../src/engine/advisor/types";
import { summarize } from "../../../../src/engine/advisor/validate";
import { istDate, istIso } from "../../../../src/engine/clock";
import { optionFlowWithFallback } from "../../../../src/engine/flow/flowFallback";
import { liveIndicesWithFeed, optionChainWithFeed } from "../../../../src/engine/market/liveFeedViews";
import type { FeedSnapshot } from "../../../../src/engine/market/upstoxFeed";
import { UpstoxLive } from "../../../../src/engine/market/upstoxLive";
import { accountRuntime, accountViews, advisorSettings, enabledAccounts, makeRuntime } from "../runtime";

const KEY_META = "meta";
const KEY_LATEST = "latest";
const KEY_HISTORY = "history";
/** The pipeline gives up a little before the 10-minute safety timeout. */
const PIPELINE_DEADLINE_MS = RUN_TIMEOUT_MS - 30_000;

// Per isolate, as in admin.ts: the Upstox caches and request budget.
let live: { token: string | undefined; market: UpstoxLive } | null = null;
function liveMarket(env: Env): UpstoxLive {
  const token = env.UPSTOX_ANALYTICS_TOKEN || undefined;
  if (!live || live.token !== token) live = { token, market: new UpstoxLive({ token }) };
  return live.market;
}

/** Runs `f` with a deadline; at the deadline its signal aborts (the model calls stop, so a given-up run stops paying). */
async function withDeadline<T>(f: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new AdvisorRunError("The analysis took longer than 10 minutes and was stopped.");
      controller.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([f(controller.signal), t]);
  } finally {
    clearTimeout(timer);
  }
}

export class AdvisorDO extends DurableObject<Env> {
  private disabledReason(): string | null {
    return this.env.ANTHROPIC_API_KEY ? null : "The advisor is switched off: the engine Worker has no ANTHROPIC_API_KEY secret.";
  }

  private async load(now: number): Promise<{ meta: AdvisorMeta; latest: AdvisorReport | null; history: AdvisorReportSummary[] }> {
    const [meta, latest, history] = await Promise.all([
      this.ctx.storage.get<AdvisorMeta>(KEY_META),
      this.ctx.storage.get<AdvisorReport>(KEY_LATEST),
      this.ctx.storage.get<AdvisorReportSummary[]>(KEY_HISTORY),
    ]);
    const m = normalizeMeta(meta, now);
    // A run stuck past the safety timeout was just cleared: keep that.
    if (meta && meta.status !== m.status) await this.ctx.storage.put(KEY_META, m);
    return { meta: m, latest: latest ?? null, history: history ?? [] };
  }

  private viewOf(meta: AdvisorMeta, latest: AdvisorReport | null, history: AdvisorReportSummary[], now: number): AdvisorView {
    return toView(meta, latest, history, now, advisorSettings(this.env), this.disabledReason());
  }

  async view(): Promise<AdvisorView> {
    const now = Date.now();
    const { meta, latest, history } = await this.load(now);
    return this.viewOf(meta, latest, history, now);
  }

  /** Queues an analysis now unless one is running or the rate limit says wait; returns the view at once. */
  async run(reason: string): Promise<AdvisorView> {
    const now = Date.now();
    const { meta, latest, history } = await this.load(now);
    if (this.disabledReason()) return this.viewOf(meta, latest, history, now);
    const req = requestRun(meta, now, advisorSettings(this.env), reason);
    if (req.start) {
      await this.ctx.storage.put(KEY_META, req.meta);
      await this.ctx.storage.setAlarm(now);
    }
    return this.viewOf(req.meta, latest, history, now);
  }

  /** The daily automatic brief (called by the minute cron): at most once a trading day, inside its window. */
  async autoRun(): Promise<{ started: boolean }> {
    const now = Date.now();
    const s = advisorSettings(this.env);
    const rt = makeRuntime(this.env, "advisor");
    const { meta } = await this.load(now);
    if (!autoRunDue(meta, now, s, (d) => rt.calendar.isTradingDay(d))) return { started: false };
    const marked: AdvisorMeta = { ...meta, lastAutoRunDate: istDate(now) };
    if (this.disabledReason()) {
      await this.ctx.storage.put(KEY_META, marked);
      return { started: false };
    }
    const req = requestRun(marked, now, s, "daily automatic brief");
    await this.ctx.storage.put(KEY_META, req.meta);
    if (req.start) await this.ctx.storage.setAlarm(now);
    return { started: req.start };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const meta = normalizeMeta(await this.ctx.storage.get<AdvisorMeta>(KEY_META), now);
    if (meta.status !== "queued") return;
    await this.ctx.storage.put(KEY_META, markRunning(meta, now));
    const rt = makeRuntime(this.env, "advisor");
    const settings = advisorSettings(this.env);
    let error: string | null = null;
    let notes: string[] = [];
    try {
      const key = this.env.ANTHROPIC_API_KEY;
      if (!key) throw new AdvisorRunError("The advisor is switched off: the engine Worker has no ANTHROPIC_API_KEY secret.");
      const id = `adv-${istIso(now).slice(0, 16).replace(/[-:T]/g, "")}`;
      const result = await withDeadline(
        (signal) => runAdvisorPipeline({ sources: this.sources(rt), calendar: rt.calendar, client: advisorClient(key), model: settings.model, id, signal }),
        PIPELINE_DEADLINE_MS,
      );
      const history = pushHistory(await this.ctx.storage.get<AdvisorReportSummary[]>(KEY_HISTORY), summarize(result.report));
      await this.ctx.storage.put({ [KEY_LATEST]: result.report, [KEY_HISTORY]: history });
      notes = result.notes;
      rt.logger.info("advisor brief written", {
        id,
        action: result.report.today.action,
        ideas: result.report.ideas.length,
        costUsd: result.report.costUsd,
        durationMs: result.report.durationMs,
        research: result.research.ok ? `${result.research.sources.length} sources` : "failed",
        notes: notes.slice(0, 12),
      });
    } catch (err) {
      error = err instanceof AdvisorRunError ? err.message : `The analysis failed: ${plainError(err)}`;
      rt.logger.error("advisor run failed", { error });
    } finally {
      const current = normalizeMeta((await this.ctx.storage.get<AdvisorMeta>(KEY_META)) ?? meta, Date.now());
      await this.ctx.storage.put(KEY_META, markFinished(current, error, notes));
    }
  }

  /** The same reads EngineAdmin serves, for the main account. */
  private sources(rt: ReturnType<typeof makeRuntime>): AdvisorSources {
    const market = liveMarket(this.env);
    const ids = enabledAccounts(this.env);
    const a = accountRuntime(rt, "main");
    const views = accountViews(rt, ids);
    const model = () =>
      new ReadModel({
        repo: a.repo,
        cfg: a.cfg,
        calendar: rt.calendar,
        now: Date.now(),
        liveTradingEnabled: rt.liveTradingEnabled,
        version: rt.version,
        account: views.find((v) => v.id === "main"),
        accounts: views,
      });
    const snapshot = (keys?: string[]) => this.feedTicks(keys);
    return {
      getLiveIndices: () => liveIndicesWithFeed(market, snapshot),
      getOptionChain: (index, expiry) => optionChainWithFeed(market, snapshot, index, expiry),
      getOptionFlow: (index) => optionFlowWithFallback(index, () => this.feedFlow(index), () => market.getOptionChain(index), Date.now()),
      getSignals: () => model().getSignals(),
      getEvents: (q) => model().getEvents(q),
      getScheduled: (hours) => model().getScheduled(hours),
      getTodayPlan: () => model().getTodayPlan(),
      getPnl: (days) => model().getPnl(days),
      getPositions: () => model().getPositions(),
    };
  }

  private feedStub() {
    return this.env.MARKET_FEED_DO.get(this.env.MARKET_FEED_DO.idFromName("feed"));
  }

  /** The market feed's latest ticks; null when the feed DO does not answer within 1.5 s (the views then use REST). */
  private async feedTicks(keys?: string[]): Promise<FeedSnapshot | null> {
    return this.within(() => this.feedStub().ticks(keys) as Promise<FeedSnapshot>);
  }

  private async feedFlow(index: IndexId): Promise<OptionFlowView | null> {
    return this.within(() => this.feedStub().getOptionFlow(index) as Promise<OptionFlowView>);
  }

  private async within<T>(f: () => Promise<T>, ms = 1_500): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        f(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ms);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
