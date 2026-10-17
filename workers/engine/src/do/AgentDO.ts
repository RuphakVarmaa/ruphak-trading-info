/**
 * AgentDO: the options agent's model side (a paper experiment; docs/AGENT.md). One instance ("agent") keeps its
 * records in its own SQLite (workers/engine/src/agent/sqlAgentStore.ts): bars, reflex batches, decisions, model calls
 * and their cost, escalations, trades, risk, reviews, candidate guidance and the job queue.
 *
 * TradingEngineDO submits each closed 5-minute bar's snapshots (submitBar) and returns at once. The alarm runs the
 * jobs (AgentBrain.runDue): the reflex call, escalations to the deep model, the nightly review and the candidate's
 * replay, never inside TE's tick. TE takes the decisions on a later tick and executes them through code: this object
 * never places an order. A candidate guidance text from the nightly review waits for the operator's Approve or
 * Reject on the Agent page. Approve and revert are refused during the session (here, then in the brain) and, by the
 * brain, from the close until that day's review and replay finish, so the review judges the text the session ran with.
 *
 * Uses the existing ANTHROPIC_API_KEY secret; never logs the key, a prompt or a model's raw answer.
 */
import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import { accountConfig } from "../../../../src/engine/accounts";
import { plainError } from "../../../../src/engine/advisor/research";
import { AgentBrain, type AgentStatus } from "../../../../src/engine/agent/brain";
import { SNAPSHOT_TOKEN_LIMIT } from "../../../../src/engine/agent/constants";
import { ClaudeDeepJudge, ClaudeReflexJudge } from "../../../../src/engine/agent/judge";
import { encodeSnapshot, estimateTokens, worstCaseSnapshot } from "../../../../src/engine/agent/snapshot";
import type { AgentSettings, ExecutionRecord, IndexSnapshot, ReflexBatch, ReflexInput, SubmitBarResult } from "../../../../src/engine/agent/types";
import type { AccountView, AdvisorView, AgentView, IndexId } from "../../../../src/engine/api-types";
import { MINUTE_MS, istIso } from "../../../../src/engine/clock";
import { randomId } from "../../../../src/engine/ports";
import { MARKET_SYMBOLS } from "../../../../src/engine/types";
import { SqlAgentStore, migrateAgentSql } from "../agent/sqlAgentStore";
import { agentSettings, makeRuntime, type Runtime } from "../runtime";

/** One alarm runs jobs for at most this long (a job starts only when its own abort time fits; Durable Object alarms get 15 minutes). */
const ALARM_RUN_MS = 10 * MINUTE_MS;
/** After a failed alarm the jobs are looked at again this much later. */
const ALARM_RETRY_MS = MINUTE_MS;
const ADVISOR_TIMEOUT_MS = 3_000;
/** The brief is read at most this often (a failed read is retried after a minute). */
const ADVISOR_CACHE_MS = 5 * MINUTE_MS;
const ADVISOR_RETRY_MS = MINUTE_MS;
/** meta key: the last date whose review the end of day scheduled (TE and the POSTMARKET cron both ask; one review a day). */
const REVIEW_SCHEDULED_KEY = "do:review-scheduled";
/** When approve and revert are allowed: before the session, or once the day's review and its replay have finished. */
const OUTSIDE_THE_JUDGED_DAY = "before 09:15 IST, or after today's review and replay finish (about 16:20–16:45 IST)";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One token count: a stored snapshot (the newest per index) or the synthetic worst case. */
export interface TokenCountRow {
  source: "stored" | "synthetic worst case";
  index: IndexId | null;
  barAt: string | null;
  chars: number;
  /** The local estimate the unit tests and the token budget use (ceil(chars / CHARS_PER_TOKEN_BOUND)). */
  estimate: number;
  /** The API's count of the snapshot alone: count(snapshot) − count("{}"); null without a key or on an error. */
  actual: number | null;
  charsPerToken: number | null;
}

export interface TokenCountResult {
  model: string;
  limit: number;
  rows: TokenCountRow[];
  /** Every counted snapshot is under the limit and no estimate is below its count; null when nothing was counted. */
  ok: boolean | null;
  error: string | null;
}

export class AgentDO extends DurableObject<Env> {
  private readonly rt: Runtime;
  private readonly settings: AgentSettings;
  private readonly store: SqlAgentStore;
  private readonly brain: AgentBrain;
  private advisorCache: { at: number; view: AdvisorView | null } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.rt = makeRuntime(env, "agent");
    this.settings = agentSettings(env, this.rt.logger);
    const sql = ctx.storage.sql;
    this.store = new SqlAgentStore(sql);
    void ctx.blockConcurrencyWhile(async () => {
      migrateAgentSql(sql);
    });
    const apiKey = env.ANTHROPIC_API_KEY;
    this.brain = new AgentBrain({
      store: this.store,
      settings: this.settings,
      reflex: apiKey ? new ClaudeReflexJudge({ apiKey, model: this.settings.reflexModel }) : null,
      escalation: apiKey ? new ClaudeDeepJudge({ apiKey, model: this.settings.escalationModel }) : null,
      review: apiKey ? new ClaudeDeepJudge({ apiKey, model: this.settings.reviewModel }) : null,
      advisor: () => this.advisorView(),
      barsFallback: (index, fromMs, toMs) => this.barsFallback(index, fromMs, toMs),
      calendar: this.rt.calendar,
      cfg: accountConfig(this.rt.cfg, "agent"),
      now: Date.now,
      newId: randomId,
      logger: this.rt.logger,
    });
  }

  /** Sets the alarm for `ms` unless one is already due sooner (an alarm stuck in the past is replaced, as in MarketFeedDO). */
  private async wakeAt(ms: number | null): Promise<void> {
    if (ms === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > ms || current < Date.now() - 60_000) await this.ctx.storage.setAlarm(ms);
  }

  /** Approve, revert and a manual review are refused during the session, so one session is judged by one text. */
  private inSession(nowMs: number, opts: { preOpen?: boolean } = {}): boolean {
    const phase = this.rt.calendar.sessionPhase(nowMs);
    return phase === "OPEN" || (opts.preOpen === true && phase === "PRE_OPEN");
  }

  // -------------------------------------------------------------------------
  // RPC from TradingEngineDO
  // -------------------------------------------------------------------------

  /**
   * Stores the bar and queues its reflex job (idempotent per bar: a duplicate comes back with the snapshots stored first;
   * refused while paused); the alarm makes the call.
   */
  async submitBar(input: ReflexInput): Promise<SubmitBarResult> {
    const res = await this.brain.submitBar(input);
    if (res.accepted) await this.wakeAt(Date.now());
    return res;
  }

  /** The newest batch after `afterBarMs`, with its bar's stored snapshots (null when there is none yet). */
  async takeDecisions(afterBarMs: number): Promise<ReflexBatch | null> {
    return this.brain.takeDecisions(Number(afterBarMs));
  }

  /** What TE did with a batch, the closed trades and the risk (idempotent per bar and decision, and per trade). */
  async recordExecution(rec: ExecutionRecord): Promise<void> {
    await this.brain.recordExecution(rec);
  }

  /**
   * Queues the nightly review of `date` (the end of day calls it; it runs from 16:20 IST). TE's end of day and the
   * POSTMARKET cron both ask, so the first call for a date schedules it and the rest are no-ops.
   */
  async scheduleReview(date: string): Promise<void> {
    const d = String(date);
    if (!DATE.test(d)) throw new Error("date must be YYYY-MM-DD");
    if ((await this.store.getMeta<string>(REVIEW_SCHEDULED_KEY)) === d) return;
    // Claimed first, so a second request arriving meanwhile is a no-op; released if scheduling fails.
    await this.store.setMeta(REVIEW_SCHEDULED_KEY, d);
    try {
      await this.brain.scheduleReview(d);
    } catch (err) {
      await this.store.setMeta(REVIEW_SCHEDULED_KEY, null);
      throw err;
    }
    await this.wakeAt(await this.store.nextJobMs());
  }

  // -------------------------------------------------------------------------
  // RPC from EngineAdmin and the ops routes
  // -------------------------------------------------------------------------

  async view(date: string, account: AccountView | null): Promise<AgentView> {
    return this.brain.view(String(date), account);
  }

  /**
   * /ops/agent-review: queues a review of `date` now, again if one already ran (the brain's `force`; one queued or
   * running is left alone). It only enqueues (the alarm runs it), and never in the session.
   */
  async runReviewNow(date: string): Promise<{ ok: boolean; message: string }> {
    const d = String(date);
    if (!DATE.test(d)) return { ok: false, message: "date must be YYYY-MM-DD" };
    if (this.inSession(Date.now(), { preOpen: true })) return { ok: false, message: "a review runs only outside the session (it would hold up the reflex calls); ask again after 15:30 IST" };
    await this.brain.scheduleReview(d, { force: true });
    await this.wakeAt(await this.store.nextJobMs());
    return { ok: true, message: `review of ${d} queued (on the session's own day it waits for 16:20 IST)` };
  }

  /**
   * Approve or reject the pending candidate guidance. Approval is refused here during the session; outside it the
   * brain decides (it also refuses from the close until that day's review and replay finish), and its answer comes
   * back unchanged.
   */
  async decideCandidate(id: string, decision: "approve" | "reject", actor: string): Promise<{ ok: boolean; message: string }> {
    if (decision === "approve" && this.inSession(Date.now())) return { ok: false, message: `approve ${OUTSIDE_THE_JUDGED_DAY}, so one session is judged by one text` };
    return this.brain.decideCandidate(String(id), decision, String(actor));
  }

  /** /ops/agent-revert: the built-in guidance becomes active again (the same window as approve). */
  async revertInstruction(actor: string): Promise<{ ok: boolean; message: string }> {
    if (this.inSession(Date.now())) return { ok: false, message: `revert ${OUTSIDE_THE_JUDGED_DAY}, so one session is judged by one text` };
    return this.brain.revertToBuiltin(String(actor));
  }

  /** /ops/agent-pause: while paused no bar is accepted (TE's runner pauses its own side too). */
  async setPaused(on: boolean): Promise<{ ok: boolean; message: string }> {
    await this.brain.setPaused(Boolean(on));
    return { ok: true, message: on ? "AgentDO paused: no candle is accepted" : "AgentDO resumed" };
  }

  async status(): Promise<AgentStatus> {
    return this.brain.status();
  }

  /**
   * /ops/agent-count-tokens: the API's token count of a snapshot alone, count(snapshot) − count("{}"), beside the local
   * estimate. It counts the newest stored snapshot of each index and the synthetic worst case, so it runs before the
   * first session too. Counting is free and makes no model call.
   */
  async countTokens(): Promise<TokenCountResult> {
    const model = this.settings.reflexModel;
    const samples: { row: Omit<TokenCountRow, "chars" | "estimate" | "actual" | "charsPerToken">; snapshot: IndexSnapshot }[] = [];
    let error: string | null = null;
    try {
      samples.push({ row: { source: "synthetic worst case", index: null, barAt: null }, snapshot: worstCaseSnapshot() });
    } catch (err) {
      error = `the synthetic worst case is not available: ${plainError(err)}`;
    }
    for (const index of ["NIFTY", "SENSEX"] as const) {
      const bar = this.store.latestSnapshotBar(index);
      if (bar?.snapshot) samples.push({ row: { source: "stored", index, barAt: istIso(bar.barCloseMs) }, snapshot: bar.snapshot });
    }
    const rows: TokenCountRow[] = samples.map(({ row, snapshot }) => {
      const text = encodeSnapshot(snapshot);
      return { ...row, chars: text.length, estimate: estimateTokens(text), actual: null, charsPerToken: null };
    });
    const apiKey = this.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { model, limit: SNAPSHOT_TOKEN_LIMIT, rows, ok: null, error: error ?? "no ANTHROPIC_API_KEY secret: only the local estimates" };
    if (rows.length === 0) return { model, limit: SNAPSHOT_TOKEN_LIMIT, rows, ok: null, error };
    try {
      const client = new Anthropic({ apiKey, timeout: 15_000, maxRetries: 1 });
      const count = async (content: string) => (await client.messages.countTokens({ model, messages: [{ role: "user", content }] })).input_tokens;
      const empty = await count("{}");
      for (const [i, s] of samples.entries()) {
        const actual = (await count(encodeSnapshot(s.snapshot))) - empty;
        rows[i] = { ...rows[i], actual, charsPerToken: actual > 0 ? Math.round((rows[i].chars / actual) * 100) / 100 : null };
      }
    } catch (err) {
      return { model, limit: SNAPSHOT_TOKEN_LIMIT, rows, ok: null, error: `token count failed: ${plainError(err)}` };
    }
    const counted = rows.filter((r) => r.actual !== null);
    const ok = counted.length > 0 ? counted.every((r) => r.actual !== null && r.actual < SNAPSHOT_TOKEN_LIMIT && r.estimate >= r.actual) : null;
    return { model, limit: SNAPSHOT_TOKEN_LIMIT, rows, ok, error };
  }

  // -------------------------------------------------------------------------
  // Alarm
  // -------------------------------------------------------------------------

  /** Runs the due jobs (reflex first) for at most ALARM_RUN_MS, then sleeps until the next one. */
  async alarm(): Promise<void> {
    const now = Date.now();
    let next: number | null;
    try {
      next = await this.brain.runDue(now, now + ALARM_RUN_MS);
    } catch (err) {
      // runDue never throws; this keeps a failure from making the runtime retry the alarm (and a job re-run).
      this.rt.logger.error("agent alarm failed", { error: plainError(err) });
      next = Date.now() + ALARM_RETRY_MS;
    }
    try {
      await this.wakeAt(next);
    } catch (err) {
      this.rt.logger.error("agent alarm not re-armed", { error: plainError(err) });
    }
  }

  // -------------------------------------------------------------------------
  // The brain's sources
  // -------------------------------------------------------------------------

  /** The Advisor's view (the latest brief), read at most every 5 minutes with a 3 s timeout; null when it does not answer. */
  private async advisorView(): Promise<AdvisorView | null> {
    const now = Date.now();
    const cached = this.advisorCache;
    if (cached && now - cached.at < (cached.view ? ADVISOR_CACHE_MS : ADVISOR_RETRY_MS)) return cached.view;
    const stub = this.env.ADVISOR_DO.get(this.env.ADVISOR_DO.idFromName("advisor"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let view: AdvisorView | null = null;
    try {
      view = await Promise.race([
        stub.view() as Promise<AdvisorView>,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ADVISOR_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      this.rt.logger.warn("agent: advisor view unavailable", { error: plainError(err) });
    } finally {
      clearTimeout(timer);
    }
    this.advisorCache = { at: now, view };
    return view;
  }

  /**
   * Closes from the settled 5-minute archive (D1 bars_5m, written at 16:15 IST from Yahoo) for grading. `t` is each
   * bar's open time as stored there (the bar closes at t + 5 min); fromMs and toMs bound it the same way.
   */
  private async barsFallback(index: IndexId, fromMs: number, toMs: number): Promise<{ t: number; c: number }[]> {
    const res = await this.env.DB.prepare("SELECT t, c FROM bars_5m WHERE symbol = ? AND t >= ? AND t < ? ORDER BY t")
      .bind(MARKET_SYMBOLS[index], fromMs, toMs)
      .all<{ t: number; c: number }>();
    return (res.results ?? []).map((r) => ({ t: Number(r.t), c: Number(r.c) }));
  }
}
