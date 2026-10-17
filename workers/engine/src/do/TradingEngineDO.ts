/**
 * TradingEngineDO: the only writer of decisions, orders and positions (singleton "engine").
 *
 * Alarm loop: every 30 s in market hours (60 s when DEGRADED) it runs the shared trading cycle
 * (features -> conviction -> gates -> plan -> entry) in the current entry mode, then position
 * cycles for every mode with open positions, polling exits twice more while positioned. Last, under
 * its own time budget, comes the options agent's step (a paper experiment on its own account,
 * workers/engine/src/agent/agentRunner.ts): main's work and its timing never wait for it. The budget
 * ends before main's next alarm is due, and a kill that squares off holds the agent from the moment it
 * comes in, before main's switch is written: TE stops waiting for a running agent step and runs none of
 * the agent's work but its code exits until the square-off, the relay panic and the agent's own kill are
 * done, so main is flat (and the relay panic sent) before the agent's kill switch and exits come. A step
 * already running still runs its kill coupling, code exits and drawdown check (a drawdown halt it finds
 * acts at once), but from the kill on it calls no other Durable Object (no batch taken, no record or bar
 * sent) and sends none of the model's exits; a batch it took before reads the kill switches again before
 * each entry. A follower's square-off holds the agent the same way until its square-off tick is done.
 * Inside main's 10 s waits between exit polls (while main or a follower account holds a position or an
 * order) the agent also does all of its step but the decisions: the kill coupling and the code exits
 * always run; each later part starts, and each call to another Durable Object is sent, only before the
 * wait ends (the book always follows the risk row). So a step cut short or skipped is made up within one
 * wait; a kill stops that work too.
 * Off hours it refreshes a market snapshot hourly and sleeps until 09:00 IST.
 * After a tick (never inside it) the read-only quote recorder may take a snapshot of option quotes (the
 * Groww Trade API, or Upstox's free read-only token) for the 09:15 straddle study
 * (workers/engine/src/quoteRecorder.ts); it places no orders.
 *
 * Live orders need three keys here (LIVE_TRADING var, settings.mode LIVE, an unexpired arm)
 * plus RELAY_LIVE on the relay; otherwise every order is simulated by the PaperBroker.
 */
import { DurableObject } from "cloudflare:workers";
import { accountStateKey, followerIds, parseAccountId, type AccountId } from "../../../../src/engine/accounts";
import type { AgentStatus } from "../../../../src/engine/agent/brain";
import type { ReflexBatch, SubmitBarResult } from "../../../../src/engine/agent/types";
import type { AccountView, OptionFlowView } from "../../../../src/engine/api-types";
import type { TradingCalendar } from "../../../../src/engine/calendar/calendar";
import { MINUTE_MS, formatHHMM, istAt, istDate, istIso, istMinutes, systemClock } from "../../../../src/engine/clock";
import { PaperBroker } from "../../../../src/engine/broker/paperBroker";
import { computeCharges } from "../../../../src/engine/broker/charges";
import {
  FallbackOptionQuotes,
  GrowwBroker,
  GrowwDataClient,
  GrowwOptionQuotes,
  GrowwTokenManager,
  mintTotpToken,
  type GrowwToken,
  type RelayClient,
  type RelayHealth,
} from "../../../../src/engine/broker/groww";
import type { EngineConfig } from "../../../../src/engine/config";
import { computeFeatures } from "../../../../src/engine/market/features";
import { n2DailyByIndex } from "../../../../src/engine/strategy/rules";
import { UpstoxOptionQuotes, UpstoxOverlayMarketData } from "../../../../src/engine/market/upstoxMarket";
import { YahooMarketDataSource } from "../../../../src/engine/market/yahooMarketData";
import { runFollowerEntries } from "../../../../src/engine/pipeline/accountCycle";
import { mainExitsFirst } from "../../../../src/engine/pipeline/tickOrder";
import { runEndOfDay } from "../../../../src/engine/pipeline/dayLifecycle";
import { applyExitFills, persistResult } from "../../../../src/engine/pipeline/execution";
import { recordSourceHealth } from "../../../../src/engine/pipeline/ingestCycle";
import { MarketContextStore } from "../../../../src/engine/pipeline/marketContext";
import { runPositionCycle, type PositionReport } from "../../../../src/engine/pipeline/positionCycle";
import { practiceQuotaOn } from "../../../../src/engine/pipeline/practiceCycle";
import { quoteRows, runTradingCycle, type CycleReport } from "../../../../src/engine/pipeline/tradingCycle";
import { SyntheticOptionQuotes } from "../../../../src/engine/pricing/syntheticOptionPricer";
import { randomId, type Broker, type EngineDeps, type MarketDataSource, type OptionFlowSource, type OptionQuoteSource, type Repository } from "../../../../src/engine/ports";
import { entryMode } from "../../../../src/engine/settings";
import type { EngineMode, EnginePhase, EngineSettings, Fill, Heartbeat, IndexId, MarketFeatures, Order, Position, TradingMode } from "../../../../src/engine/types";
import { makeRefId } from "../../../../src/engine/util/refId";
import { accountRepository } from "../../../../src/engine/repo/accountRepo";
import { ALERT_PREFIX, AgentRunner, agentQuoteSource, agentStepBudgetMs, killAll, type KillStep } from "../agent/agentRunner";
import { runBarArchive, type BarArchiveOptions, type BarArchiveStatus } from "../barArchive";
import { sendEntryAlert, sendExitAlert, sendTrailAlerts, type CopyAlertContext } from "../copyAlerts";
import { CachedInstruments } from "../instruments";
import { QUOTE_RECORDER_STATE_KEY, QuoteRecorder, type QuoteRecorderStatus, type RecorderState } from "../quoteRecorder";
import {
  accountRuntime,
  accountViews,
  agentSettings,
  enabledAccounts,
  errorMessage,
  growwDataClient,
  liveDataSource,
  makeRuntime,
  recorderQuoteSource,
  relayClient,
  upstoxLiveClient,
  type AccountRuntime,
  type LiveDataSource,
  type Runtime,
} from "../runtime";
import { Alerts } from "../telegram";

const LOOP_MS = 30_000;
const DEGRADED_LOOP_MS = 60_000;
const ERROR_RETRY_MS = 10_000;
const DEGRADED_AFTER_ERRORS = 5;
const EXIT_POLLS_MS = [10_000, 10_000];
const RECONCILE_EVERY_MS = 5 * MINUTE_MS;
const RELAY_HEALTH_TTL_MS = 60_000;
const OFF_HOURS_SNAPSHOT_MS = 60 * MINUTE_MS;
const HEARTBEAT_STALE_MS = 120_000;
/** Paper quotes skip Groww (synthetic quotes) for this long after a Groww failure that is not about one symbol. */
const PAPER_QUOTE_PAUSE_MS = 30_000;
/** The quote recorder covers both indices whatever the engine trades (INDICES). */
const RECORDED_INDICES = ["NIFTY", "SENSEX"] as const;
/** The agent's step ends at least this long before main's next alarm is due (its budget never delays main's next tick). */
const AGENT_STEP_ALARM_MARGIN_MS = 1_500;
/**
 * An agent step with less time than this is skipped. While main or a follower account holds a position or an order,
 * main's exit-poll waits do all of the step but the decisions (AgentRunner.pollStep); otherwise that work waits for the
 * next step with time for it.
 */
const AGENT_STEP_MIN_MS = 1_000;
/** The end of day waits this long for the AgentDO to queue the review; the POSTMARKET cron asks again. */
const AGENT_REVIEW_SCHEDULE_MS = 5_000;
/** Telegram /status waits this long for the AgentDO's line. */
const AGENT_STATUS_MS = 3_000;

type BookMode = Extract<TradingMode, "PAPER" | "LIVE">;

interface HotState {
  consecutiveErrors: number;
  lastError: string | null;
  lastTickMs: number | null;
  lastOffHoursSnapshotMs: number;
  lastReconcileMs: number;
  reconcileMismatches: number;
}

const INITIAL_HOT: HotState = {
  consecutiveErrors: 0,
  lastError: null,
  lastTickMs: null,
  lastOffHoursSnapshotMs: 0,
  lastReconcileMs: 0,
  reconcileMismatches: 0,
};

export interface AdminResult {
  ok: boolean;
  message: string;
}

/** A paper account that follows main's signals inside main's tick. */
interface Follower extends AccountRuntime {
  alerts: Alerts;
  /** Consecutive failed steps (its own counter: it never degrades main). */
  errors: number;
  /** Copy-trade alerts for this account. */
  copy: CopyAlertContext;
}

const FOLLOWER_ALERT_AFTER_ERRORS = 5;

export class TradingEngineDO extends DurableObject<Env> {
  private readonly rt: Runtime;
  private readonly marketContext = new MarketContextStore();
  private readonly tokens: GrowwTokenManager | null;
  private readonly data: GrowwDataClient | null;
  /** Groww quotes for LIVE (no fallback, no pause). */
  private readonly growwQuotes: GrowwOptionQuotes | null;
  /**
   * Real quotes behind the paper books' synthetic fallback, paused for 30 s after a failure: Groww when its
   * keys are set, else Upstox when LIVE_DATA is "upstox".
   */
  private readonly paperQuotes: GrowwOptionQuotes | UpstoxOptionQuotes | null;
  /** Read-only live quote recorder (runs after ticks, never inside one; workers/engine/src/quoteRecorder.ts). */
  private readonly quoteRecorder: QuoteRecorder;
  private readonly relay: RelayClient | null;
  /** Yahoo's bars (the bar archive's source). */
  private readonly yahoo: YahooMarketDataSource;
  /** The trading loop's market data: Yahoo, with Upstox's live index data over it when LIVE_DATA is "upstox". */
  private readonly market: MarketDataSource;
  private readonly liveData: LiveDataSource;
  private readonly instruments: CachedInstruments;
  private readonly alerts: Alerts;
  /** Copy-trade alerts for main. */
  private readonly copy: CopyAlertContext;
  private hot: HotState = { ...INITIAL_HOT };
  private relayHealth: { at: number; value: RelayHealth } | null = null;
  private ticking: Promise<number> | null = null;
  private entryModeNow: BookMode = "PAPER";
  /** Set inside a tick when the next tick must follow immediately (kill switch engaged mid-tick). */
  private tickSoon = false;
  private readonly followers: Follower[];
  /** The options agent's account is in ACCOUNTS (its runner is built in every AGENT_MODE, so its exits always run). */
  private readonly agentEnabled: boolean;
  /** The options agent's runner; null when it is not enabled or could not be built (main is unaffected either way). */
  private readonly agent: AgentRunner | null = null;
  private agentInitError: string | null = null;
  /** Telegram for the agent when its runner is missing, deduplicated under the agent's kv prefix (acct:agent:). */
  private readonly agentAlerts: Alerts;
  /**
   * Ends TE's wait for the agent step in progress at once and stops that step (its stopped() reads true): it carries on
   * with its kill coupling, code exits and drawdown check, but calls no other Durable Object and sends none of the
   * model's exits.
   */
  private agentPreempt: (() => void) | null = null;
  /**
   * While above zero no agent step starts, a running one is stopped and a wait runs only the agent's code exits: a kill
   * that squares off is running, from before its first switch is written until the agent's own kill is done (a
   * follower's: until its square-off tick is done).
   */
  private agentHold = 0;
  /**
   * Kills of main or of every account that square off, while they run: each sets the agent's switch itself after its
   * panic, so a kill without a square-off that comes meanwhile leaves the agent's switch to it.
   */
  private agentKillsDue = 0;
  /** The running bar-archive job, if any (concurrent callers share it). */
  private archiving: Promise<BarArchiveStatus> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.rt = makeRuntime(env, "engine-do");
    const { cfg, calendar, logger, repo } = this.rt;
    this.tokens = this.rt.growwConfigured
      ? new GrowwTokenManager({
          now: Date.now,
          mint: () => mintTotpToken({ apiKey: env.GROWW_API_KEY!, totpSecret: env.GROWW_TOTP_SECRET!, nowMs: Date.now }),
          cache: {
            get: async () => (await ctx.storage.get<GrowwToken>("groww:token")) ?? null,
            set: async (t) => {
              await ctx.storage.put("groww:token", t);
            },
          },
        })
      : null;
    this.data = growwDataClient(env, this.tokens);
    this.growwQuotes = this.data ? new GrowwOptionQuotes(this.data, cfg) : null;
    const upstox = upstoxLiveClient(env);
    this.liveData = liveDataSource(env);
    this.paperQuotes = this.data
      ? new GrowwOptionQuotes(this.data, cfg, { pauseAfterErrorMs: PAPER_QUOTE_PAUSE_MS })
      : upstox
        ? new UpstoxOptionQuotes(upstox, { pauseAfterErrorMs: PAPER_QUOTE_PAUSE_MS })
        : null;
    this.relay = relayClient(env);
    const data = this.data;
    this.yahoo = new YahooMarketDataSource({
      calendar,
      ltp: data
        ? async () => {
            try {
              const v = await data.indexLtp();
              await recordSourceHealth(repo, "groww", true, Date.now());
              return v;
            } catch (err) {
              await recordSourceHealth(repo, "groww", false, Date.now(), errorMessage(err));
              return {};
            }
          }
        : undefined,
      log: (msg, d) => logger.warn(msg, d),
    });
    this.market = upstox ? new UpstoxOverlayMarketData(this.yahoo, upstox, { log: (msg, d) => logger.warn(msg, d) }) : this.yahoo;
    this.instruments = new CachedInstruments({
      env,
      cfg,
      calendar,
      marketContext: this.marketContext,
      logger,
      allowSynthetic: () => this.entryModeNow === "PAPER",
    });
    this.alerts = new Alerts(env, repo.state, logger);
    // Groww Trade API when its keys are set, else the free read-only Upstox token, else none (runtime.ts).
    const recorderSource = recorderQuoteSource(env, this.tokens);
    this.quoteRecorder = new QuoteRecorder({
      db: env.DB,
      kv: env.KV,
      state: {
        get: async () => (await ctx.storage.get<RecorderState>(QUOTE_RECORDER_STATE_KEY)) ?? null,
        put: async (s) => {
          await ctx.storage.put(QUOTE_RECORDER_STATE_KEY, s);
        },
      },
      source: recorderSource.source,
      disabledReason: recorderSource.reason ?? undefined,
      // Its own copy of the real instrument master: never synthetic contracts.
      instruments: new CachedInstruments({ env, cfg, calendar, marketContext: this.marketContext, logger, allowSynthetic: () => false }),
      calendar: async () => this.calendarFor(await repo.settings.get()),
      indices: RECORDED_INDICES,
      logger,
      alert: (text) => this.alerts.send(text, { key: "quote-recorder", minIntervalMs: 6 * 60 * MINUTE_MS }),
    });
    const ids = enabledAccounts(env);
    // Each account's config is validated on its own: one that fails leaves that account out (the agent's with the
    // reason on /status and in an alert), never main. Main's own failure still throws.
    const views = accountViews(this.rt, ids, (id, err) => {
      const reason = errorMessage(err).slice(0, 300);
      if (id === "agent") this.agentInitError = reason;
      logger.error("account not started: its config failed validation", { account: id, error: reason });
    });
    const started = new Set<string>(views.map((v) => v.id));
    const view = (id: AccountId): AccountView => {
      const v = views.find((x) => x.id === id);
      if (!v) throw new Error(`account ${id} has no view`);
      return v;
    };
    const copyFor = (r: Repository, c: EngineConfig, account: AccountView, alerts: Alerts): CopyAlertContext => ({
      repo: r,
      cfg: c,
      account,
      alerts,
      logger,
      dashboardUrl: env.DASHBOARD_URL,
      trailSent: new Set(),
    });
    this.copy = copyFor(repo, cfg, view("main"), this.alerts);
    this.followers = followerIds(ids)
      .filter((id) => started.has(id))
      .map((id) => {
        const a = accountRuntime(this.rt, id);
        // Its alert dedupe keys live under the account's prefix (the scoped repo's state).
        const alerts = new Alerts(env, a.repo.state, logger);
        return { ...a, alerts, errors: 0, copy: copyFor(a.repo, a.cfg, view(id), alerts) };
      });
    this.agentEnabled = ids.includes("agent");
    this.agentAlerts = new Alerts(env, { get: <T,>(k: string) => repo.state.get<T>(accountStateKey("agent", k)), set: <T,>(k: string, v: T) => repo.state.set(accountStateKey("agent", k), v) }, logger);
    if (this.agentEnabled && started.has("agent")) {
      // A failure here leaves the agent off, never main.
      try {
        this.agent = this.buildAgentRunner(env, ctx);
      } catch (err) {
        this.agentInitError = errorMessage(err).slice(0, 300);
        logger.error("agent runner not built: the agent stays off", { error: this.agentInitError });
      }
    }
    void ctx.blockConcurrencyWhile(async () => {
      this.hot = { ...INITIAL_HOT, ...((await ctx.storage.get<HotState>("hot")) ?? {}) };
    });
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /**
   * The options agent's runner: its own account (PAPER@agent), its own Upstox quote budget (never paperQuotes, so its
   * requests cannot push main onto synthetic prices) and the AgentDO and MarketFeedDO stubs. It is never given main's
   * market data source: the features of main's tick are its only market input.
   */
  private buildAgentRunner(env: Env, ctx: DurableObjectState): AgentRunner {
    const account = accountRuntime(this.rt, "agent");
    const agentDo = () => env.AGENT_DO.get(env.AGENT_DO.idFromName("agent"));
    const feed = () => env.MARKET_FEED_DO.get(env.MARKET_FEED_DO.idFromName("feed"));
    return new AgentRunner({
      account,
      mainRepo: this.rt.repo,
      settings: agentSettings(env, this.rt.logger),
      storage: { get: <T,>(key: string) => ctx.storage.get<T>(key), put: <T,>(key: string, value: T) => ctx.storage.put(key, value) },
      agentDo: {
        submitBar: (input) => agentDo().submitBar(input) as Promise<SubmitBarResult>,
        takeDecisions: (afterBarMs) => agentDo().takeDecisions(afterBarMs) as Promise<ReflexBatch | null>,
        recordExecution: (rec) => agentDo().recordExecution(rec),
      },
      feed: { getOptionFlowAsOf: (index, asOfMs) => feed().getOptionFlowAsOf(index, asOfMs) as Promise<OptionFlowView | null> },
      quotes: agentQuoteSource(upstoxLiveClient(env)),
      instruments: this.instruments,
      marketContext: this.marketContext,
      alerts: new Alerts(env, account.repo.state, this.rt.logger),
      logger: this.rt.logger,
      calendar: this.rt.calendar,
    });
  }

  /** Groww data, relay and the LIVE_TRADING var are all present. */
  private get liveAvailable(): boolean {
    return this.rt.liveTradingEnabled && this.relay !== null && this.growwQuotes !== null;
  }

  private deps(mode: BookMode): EngineDeps {
    const { cfg, calendar, repo, logger } = this.rt;
    const synthetic = new SyntheticOptionQuotes(calendar, cfg);
    let optionQuotes: OptionQuoteSource;
    let broker: Broker;
    if (mode === "LIVE") {
      if (!this.growwQuotes || !this.relay) throw new Error("LIVE needs Groww credentials and the relay");
      optionQuotes = this.growwQuotes;
      broker = new GrowwBroker({ relay: this.relay, repo, clock: systemClock, newId: randomId, logger });
    } else {
      optionQuotes = this.paperQuotes
        ? new FallbackOptionQuotes(this.paperQuotes, synthetic, (err) => logger.warn(`${this.paperQuotes!.kind} quote failed; synthetic quote used for paper`, { error: errorMessage(err) }))
        : synthetic;
      broker = new PaperBroker({ cfg, clock: systemClock, repo, quotes: optionQuotes, marketContext: (i) => this.marketContext.get(i), newId: randomId, mode: "PAPER" });
    }
    return {
      cfg,
      clock: systemClock,
      calendar,
      repo,
      broker,
      market: this.market,
      optionQuotes,
      instruments: this.instruments,
      logger,
      newId: randomId,
      mode,
      marketContext: this.marketContext,
      flow: this.flowSource,
    };
  }

  /** The market feed's option flow (read-only, for the recommendation); null when it does not answer within 1.5 s. */
  private readonly flowSource: OptionFlowSource = {
    view: async (index) => {
      const stub = this.env.MARKET_FEED_DO.get(this.env.MARKET_FEED_DO.idFromName("feed"));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          stub.getOptionFlow(index) as Promise<OptionFlowView>,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 1_500);
          }),
        ]);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };

  /** Paper deps for a follower: its own config, book and broker; main's market data, quotes and calendar. */
  private followerDeps(f: Follower, calendar: TradingCalendar = this.rt.calendar): EngineDeps {
    const { logger } = this.rt;
    const synthetic = new SyntheticOptionQuotes(calendar, f.cfg);
    const optionQuotes: OptionQuoteSource = this.paperQuotes
      ? new FallbackOptionQuotes(this.paperQuotes, synthetic, (err) => logger.warn(`${this.paperQuotes!.kind} quote failed; synthetic quote used for paper`, { error: errorMessage(err) }))
      : synthetic;
    const broker = new PaperBroker({ cfg: f.cfg, clock: systemClock, repo: f.repo, quotes: optionQuotes, marketContext: (i) => this.marketContext.get(i), newId: randomId, mode: "PAPER" });
    return { cfg: f.cfg, clock: systemClock, calendar, repo: f.repo, broker, market: this.market, optionQuotes, instruments: this.instruments, logger, newId: randomId, mode: "PAPER", marketContext: this.marketContext };
  }

  private async followerOpen(f: Follower): Promise<number> {
    const [p, o] = await Promise.all([f.repo.positions.open("PAPER"), f.repo.orders.open("PAPER")]);
    return p.length + o.length;
  }

  /** Runs one follower step; failures are counted against the follower only. */
  private async followerStep(f: Follower, what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      f.errors = 0;
    } catch (err) {
      f.errors++;
      this.rt.logger.error("follower step failed", { account: f.spec.id, what, error: errorMessage(err), consecutive: f.errors });
      if (f.errors === FOLLOWER_ALERT_AFTER_ERRORS) {
        await f.alerts.send(`⚠ ${f.spec.shortLabel}: ${FOLLOWER_ALERT_AFTER_ERRORS} failed steps in a row (${what}): ${errorMessage(err).slice(0, 200)}`, { key: "follower-errors", minIntervalMs: 30 * MINUTE_MS });
      }
    }
  }

  private async followerEntries(f: Follower, report: CycleReport, calendar: TradingCalendar, noEntries: string | null): Promise<void> {
    await this.followerStep(f, "entries", async () => {
      const r = await runFollowerEntries(this.followerDeps(f, calendar), report, { calendar, noEntries, decisionEveryMs: 5 * MINUTE_MS });
      for (const e of r.entries) {
        const d = r.decisions.find((x) => x.plan?.id === e.planId);
        const short = `📝 ${f.spec.shortLabel} ENTRY ${d?.plan?.contract.tradingSymbol ?? e.planId} x${d?.plan?.qty ?? "?"} @ ~₹${d?.plan?.limitPrice ?? d?.plan?.refPremium ?? "?"} (${e.status})`;
        await sendEntryAlert(f.copy, e.positionId, d?.plan ?? null, short);
      }
      if (r.halted && !noEntries) await f.alerts.send(`⏸ ${f.spec.shortLabel} entries halted: ${r.halted}`, { key: `halt:${istDate(r.t)}:${r.halted.slice(0, 40)}`, minIntervalMs: 6 * 60 * MINUTE_MS });
      if (r.errors.length) throw new Error(r.errors.join("; "));
    });
  }

  private async followerPositions(f: Follower, report: CycleReport, calendar: TradingCalendar): Promise<void> {
    if ((await this.followerOpen(f)) === 0) return;
    await this.followerStep(f, "exits", async () => {
      const pr = await runPositionCycle(this.followerDeps(f, calendar), { convictions: report.convictions });
      for (const x of pr.exits) {
        const pos = await f.repo.positions.get(x.positionId);
        const pnl = pos && pos.status === "CLOSED" ? (pos.realized ?? 0) - pos.entryCharges - (pos.exitCharges ?? 0) : null;
        const short = `📝 ${f.spec.shortLabel} EXIT ${pos?.contract.tradingSymbol ?? x.positionId} ${x.reason} (${x.status})${pnl !== null ? ` net ₹${pnl.toFixed(0)}` : ""}`;
        await sendExitAlert(f.copy, x.positionId, short);
      }
      await sendTrailAlerts(f.copy, "PAPER");
      for (const e of pr.errors) this.rt.logger.warn("follower position cycle error", { account: f.spec.id, error: e });
    });
  }

  private async saveHot(): Promise<void> {
    await this.ctx.storage.put("hot", this.hot);
  }

  private async relayHealthCached(force = false): Promise<RelayHealth | null> {
    if (!this.relay) return null;
    const now = Date.now();
    if (!force && this.relayHealth && now - this.relayHealth.at < RELAY_HEALTH_TTL_MS) return this.relayHealth.value;
    const value = await this.relay.health();
    this.relayHealth = { at: now, value };
    await recordSourceHealth(this.rt.repo, "relay", value.ok && value.growwReachable, now, value.detail);
    return value;
  }

  private calendarFor(settings: EngineSettings) {
    return settings.holidayOverrides.length > 0 ? this.rt.calendar.withOverrides(settings.holidayOverrides) : this.rt.calendar;
  }

  // -------------------------------------------------------------------------
  // Alarm loop
  // -------------------------------------------------------------------------

  async alarm(): Promise<void> {
    await this.runTick();
  }

  /** Single-flight tick: concurrent callers share the running one. Always re-arms the alarm. */
  private runTick(): Promise<number> {
    if (!this.ticking) {
      this.ticking = (async () => {
        const started = Date.now();
        let next = started + LOOP_MS;
        try {
          next = await this.tick(started);
          if (this.hot.consecutiveErrors > 0) this.hot.consecutiveErrors = 0;
          this.hot.lastError = null;
        } catch (err) {
          this.hot.consecutiveErrors++;
          this.hot.lastError = errorMessage(err).slice(0, 300);
          this.rt.logger.error("tick failed", { error: this.hot.lastError, consecutive: this.hot.consecutiveErrors });
          next = Date.now() + (this.hot.consecutiveErrors >= DEGRADED_AFTER_ERRORS ? DEGRADED_LOOP_MS : ERROR_RETRY_MS);
          if (this.hot.consecutiveErrors === DEGRADED_AFTER_ERRORS) {
            await this.alerts.send(`⚠ Engine DEGRADED after ${DEGRADED_AFTER_ERRORS} failed ticks (exits only): ${this.hot.lastError}`, { key: "degraded", minIntervalMs: 30 * MINUTE_MS });
          }
        } finally {
          if (this.tickSoon) {
            this.tickSoon = false;
            next = Date.now() + 1_000;
          }
          next = Math.max(next, Date.now() + 1_000);
          try {
            await this.ctx.storage.setAlarm(next);
            this.hot.lastTickMs = started;
            await this.saveHot();
            await this.writeHeartbeat(next);
          } catch (err) {
            this.rt.logger.error("heartbeat/alarm write failed", { error: errorMessage(err) });
          }
          this.kickQuoteRecorder();
        }
        return next;
      })().finally(() => {
        this.ticking = null;
      });
    }
    return this.ticking;
  }

  /**
   * After a tick's own work (the next alarm is already set): starts the read-only quote recorder in the
   * background when a slot may be due. Nothing here is awaited by the tick and nothing can throw into it.
   */
  private kickQuoteRecorder(): void {
    try {
      if (!this.quoteRecorder.wants(Date.now())) return;
      this.ctx.waitUntil(this.quoteRecorder.run());
    } catch (err) {
      this.rt.logger.warn("quote recorder not started", { error: errorMessage(err) });
    }
  }

  private async phaseFor(now: number, settings?: EngineSettings): Promise<EnginePhase> {
    const s = settings ?? (await this.rt.repo.settings.get());
    if (s.killSwitch) return "KILLED";
    if (this.hot.consecutiveErrors >= DEGRADED_AFTER_ERRORS) return "DEGRADED";
    const cal = this.calendarFor(s);
    const p = cal.sessionPhase(now);
    if (p === "PRE_OPEN") return "PREMARKET";
    if (p === "OPEN") return now >= istAt(istDate(now), this.rt.cfg.exits.squareOffIst) ? "CLOSING" : "OPEN";
    return p === "HOLIDAY" ? "IDLE" : "CLOSED";
  }

  private async writeHeartbeat(alarmNextMs: number): Promise<void> {
    const now = Date.now();
    const settings = await this.rt.repo.settings.get();
    const [paper, live] = await Promise.all([this.rt.repo.positions.open("PAPER"), this.rt.repo.positions.open("LIVE")]);
    const hb: Heartbeat = {
      ts: now,
      phase: await this.phaseFor(now, settings),
      mode: settings.mode,
      alarmNextMs,
      lastTickMs: this.hot.lastTickMs,
      openPositions: paper.length + live.length,
      consecutiveErrors: this.hot.consecutiveErrors,
      version: this.rt.version,
      relayHealthy: this.relayHealth ? this.relayHealth.value.ok && this.relayHealth.value.growwReachable : null,
    };
    if (this.hot.lastError) hb.lastError = this.hot.lastError;
    await this.rt.repo.heartbeat.write(hb);
  }

  private async openCounts(): Promise<Record<BookMode, number>> {
    const { repo } = this.rt;
    const [pp, po, lp, lo] = await Promise.all([repo.positions.open("PAPER"), repo.orders.open("PAPER"), repo.positions.open("LIVE"), repo.orders.open("LIVE")]);
    return { PAPER: pp.length + po.length, LIVE: lp.length + lo.length };
  }

  private async tick(now: number): Promise<number> {
    const { repo, cfg, logger } = this.rt;
    const settings = await repo.settings.get();
    const cal = this.calendarFor(settings);
    const phase = cal.sessionPhase(now);

    if (phase !== "OPEN" && phase !== "PRE_OPEN") {
      if (now - this.hot.lastOffHoursSnapshotMs >= OFF_HOURS_SNAPSHOT_MS) {
        await this.offHoursSnapshot(now);
        this.hot.lastOffHoursSnapshotMs = now;
      }
      const preOpen = cal.nextOpenMs(now) - 15 * MINUTE_MS;
      return preOpen > now + 60_000 ? Math.min(preOpen, now + OFF_HOURS_SNAPSHOT_MS) : now + 60_000;
    }

    const degraded = this.hot.consecutiveErrors >= DEGRADED_AFTER_ERRORS;
    const mode = entryMode(settings, this.liveAvailable, now);
    this.entryModeNow = mode;
    let noEntries: string | null = degraded ? "engine DEGRADED after repeated errors: exits only" : null;
    if (mode === "LIVE") {
      const h = await this.relayHealthCached();
      if (!h || !(h.ok && h.live && h.growwReachable)) {
        noEntries = `relay not ready for live orders: ${h?.detail ?? "not configured"}`;
        await this.alerts.send(`⚠ LIVE armed but ${noEntries}`, { key: "relay-unhealthy", minIntervalMs: 15 * MINUTE_MS });
      } else if (this.hot.reconcileMismatches > 0) {
        noEntries = "live positions do not match the broker: entries paused";
      }
    }

    const report = await runTradingCycle(this.deps(mode), { noEntries, decisionEveryMs: 5 * MINUTE_MS, recommend: true, practice: mode === "PAPER" && practiceQuotaOn(this.env.PRACTICE_QUOTA, now) });
    if (report.snapshot) {
      const age = report.snapshot.dataAgeSec;
      await recordSourceHealth(repo, "yahoo", age < 600, now, age < 600 ? undefined : `market data ${Math.round(age)} s old`);
    }
    if (report.errors.length >= cfg.indices.length) throw new Error(`trading cycle failed: ${report.errors.join("; ")}`);
    for (const e of report.entries) {
      const d = report.decisions.find((x) => x.plan?.id === e.planId);
      const short = `${mode === "LIVE" ? "🔴 LIVE" : "📝 PAPER"} ENTRY ${d?.plan?.contract.tradingSymbol ?? e.planId} x${d?.plan?.qty ?? "?"} @ ~₹${d?.plan?.limitPrice ?? d?.plan?.refPremium ?? "?"} (${e.status}) conviction ${d?.conviction.score.toFixed(2) ?? "?"}`;
      await sendEntryAlert(this.copy, e.positionId, d?.plan ?? null, short);
    }
    if (report.halted) await this.alerts.send(`⏸ Entries halted: ${report.halted}`, { key: `halt:${istDate(now)}:${report.halted.slice(0, 40)}`, minIntervalMs: 6 * 60 * MINUTE_MS });

    // Exits for every book with exposure (PAPER always; LIVE whenever it holds anything).
    let counts = await this.openCounts();
    const books = (): BookMode[] => {
      const out: BookMode[] = [];
      if (counts.PAPER > 0) out.push("PAPER");
      if (counts.LIVE > 0 && this.liveAvailable) out.push("LIVE");
      return out;
    };
    const followersOpen = async () => (await Promise.all(this.followers.map((f) => this.followerOpen(f)))).reduce((a, b) => a + b, 0);
    // Main's exit check first; then the follower accounts act on the same signals (only main being
    // degraded stops their entries: relay health is a LIVE concern and they are paper-only).
    await mainExitsFirst({
      mainExits: async () => {
        for (const book of books()) await this.positionCycle(book, report);
      },
      followers: this.followers.map((f) => ({
        entries: () => this.followerEntries(f, report, cal, degraded ? "engine DEGRADED after repeated errors: exits only" : null),
        exits: () => this.followerPositions(f, report, cal),
      })),
    });
    counts = await this.openCounts();
    for (const wait of EXIT_POLLS_MS) {
      if (books().length === 0 && (await followersOpen()) === 0) break;
      await this.pollWait(wait, cal, report);
      for (const book of books()) await this.positionCycle(book, report);
      for (const f of this.followers) await this.followerPositions(f, report, cal);
      counts = await this.openCounts();
    }
    // The options agent last, under its own time budget: main's exits and polls are done. None while a kill squares off.
    await this.agentStep(report, cal, degraded, now);

    if (this.liveAvailable && (counts.LIVE > 0 || mode === "LIVE") && now - this.hot.lastReconcileMs >= RECONCILE_EVERY_MS) {
      await this.reconcile();
    }
    logger.info("tick", { phase, mode, decisions: report.decisions.length, entries: report.entries.length, halted: report.halted, open: counts });
    return now + (degraded ? DEGRADED_LOOP_MS : LOOP_MS);
  }

  /**
   * Main's wait between exit polls; the agent's work during it never fails it, and never makes it longer by more than
   * one piece of the agent's code that runs without a pause (a few ms: the timer that ends the wait runs between them).
   * Unless a kill is squaring off, the agent catches up there on its whole step but the decisions
   * (AgentRunner.pollStep): its kill coupling, code exits and drawdown halt, its risk row and book, and the latest closed
   * bar while it is unsent and fresh. The kill coupling and the code exits always run; each later part starts, and each
   * call to another Durable Object is sent, only before the wait ends (the book always follows the risk row). A part
   * already started may finish after it (a drawdown halt always does). A kill that squares off stops that work before
   * its next part from the moment it comes in (agentPreempt, agentHold); while one runs, a wait starts only the agent's
   * code exits.
   */
  private async pollWait(ms: number, cal: TradingCalendar, report: CycleReport): Promise<void> {
    const endMs = Date.now() + ms;
    const pause = new Promise<void>((resolve) => setTimeout(resolve, ms));
    const runner = this.agent;
    if (!runner) {
      await pause;
      return;
    }
    const held = this.agentHold > 0;
    let preempted = false;
    const preempt = () => {
      preempted = true;
    };
    if (!held) this.agentPreempt = preempt;
    const stopped = () => preempted || this.agentHold > 0;
    // Started inside an async function, so even a synchronous throw only ends the agent's part.
    const work = (async () => (held ? runner.exitsOnly(cal) : runner.pollStep(report, cal, endMs, stopped)))();
    try {
      await Promise.all([pause, Promise.race([work.catch(() => {}), pause])]);
    } finally {
      if (this.agentPreempt === preempt) this.agentPreempt = null;
    }
  }

  /**
   * The options agent's step (agentRunner.ts) under its own budget: agentStepBudgetMs, and never past
   * AGENT_STEP_ALARM_MARGIN_MS before main's next alarm (a step with less than AGENT_STEP_MIN_MS is skipped; main's
   * exit-poll waits make up all of it but the decisions). TE waits at most that long, and the runner checks the same
   * deadline before each call to another Durable Object. A kill that squares off ends the wait as it comes in
   * (agentPreempt), stops the step (its stopped(): no call to another Durable Object and none of the model's exits after
   * it) and starts no step while it runs (agentHold). It never throws and never counts toward DEGRADED.
   */
  private async agentStep(report: CycleReport, cal: TradingCalendar, degraded: boolean, tickStartMs: number): Promise<void> {
    if (!this.agentEnabled || this.agentHold > 0) return;
    const runner = this.agent;
    if (!runner) {
      await this.agentAlerts
        .send(`⚠ ${ALERT_PREFIX} is in ACCOUNTS but could not start, so it stays off: ${this.agentInitError ?? "unknown error"}`, { key: "agent-init", minIntervalMs: 6 * 60 * MINUTE_MS })
        .catch((err) => this.rt.logger.warn("agent init alert failed", { error: errorMessage(err) }));
      return;
    }
    const now = Date.now();
    const nextAlarmMs = tickStartMs + (degraded ? DEGRADED_LOOP_MS : LOOP_MS);
    const budget = Math.min(agentStepBudgetMs(tickStartMs, now), nextAlarmMs - AGENT_STEP_ALARM_MARGIN_MS - now);
    if (budget < AGENT_STEP_MIN_MS) {
      this.rt.logger.warn("agent step skipped: main's next tick is due", { budgetMs: budget });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let preempted = false;
    const stopped = () => preempted || this.agentHold > 0;
    try {
      await Promise.race([
        runner.step(report, cal, degraded, Date.now() + budget, stopped),
        new Promise<void>((resolve) => {
          this.agentPreempt = () => {
            preempted = true;
            resolve();
          };
          timer = setTimeout(resolve, budget);
        }),
      ]);
    } catch (err) {
      // step() never throws; this keeps any surprise out of main's tick.
      this.rt.logger.error("agent step failed", { error: errorMessage(err) });
    } finally {
      clearTimeout(timer);
      this.agentPreempt = null;
    }
  }

  private async positionCycle(book: BookMode, report: CycleReport): Promise<PositionReport> {
    const pr = await runPositionCycle(this.deps(book), { convictions: report.convictions });
    for (const x of pr.exits) {
      const pos = await this.rt.repo.positions.get(x.positionId);
      const pnl = pos && pos.status === "CLOSED" ? (pos.realized ?? 0) - pos.entryCharges - (pos.exitCharges ?? 0) : null;
      const short = `${book === "LIVE" ? "🔴 LIVE" : "📝 PAPER"} EXIT ${pos?.contract.tradingSymbol ?? x.positionId} ${x.reason} (${x.status})${pnl !== null ? ` net ₹${pnl.toFixed(0)}` : ""}`;
      await sendExitAlert(this.copy, x.positionId, short);
    }
    await sendTrailAlerts(this.copy, book);
    for (const e of pr.errors) this.rt.logger.warn("position cycle error", { book, error: e });
    return pr;
  }

  private async offHoursSnapshot(now: number): Promise<void> {
    const { repo, cfg, calendar } = this.rt;
    try {
      const snap = await this.market.snapshot(now);
      const features: Partial<Record<IndexId, MarketFeatures>> = {};
      for (const index of cfg.indices) features[index] = computeFeatures(index, snap, calendar, cfg);
      await repo.snapshots.append({ t: now, quotes: quoteRows(snap), features, regimes: {}, pressure: {}, daily: n2DailyByIndex(snap, cfg.indices, now, cfg) });
      await recordSourceHealth(repo, "yahoo", true, now);
    } catch (err) {
      await recordSourceHealth(repo, "yahoo", false, now, errorMessage(err));
      this.rt.logger.warn("off-hours snapshot failed", { error: errorMessage(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Reconciliation and forced closes
  // -------------------------------------------------------------------------

  /** Compares LIVE positions with the broker's; two mismatches in a row engage the kill switch. */
  private async reconcile(): Promise<void> {
    const { repo, logger } = this.rt;
    const now = Date.now();
    this.hot.lastReconcileMs = now;
    if ((await repo.orders.open("LIVE")).length > 0) return; // in-flight orders make the books differ briefly
    let broker;
    try {
      broker = await this.deps("LIVE").broker.positions();
    } catch (err) {
      logger.warn("reconciliation skipped: broker positions unavailable", { error: errorMessage(err) });
      return;
    }
    const theirs = new Map<string, number>();
    for (const p of broker) if (p.qty !== 0) theirs.set(p.tradingSymbol, (theirs.get(p.tradingSymbol) ?? 0) + p.qty);
    const ours = new Map<string, number>();
    for (const p of await repo.positions.open("LIVE")) ours.set(p.contract.tradingSymbol, (ours.get(p.contract.tradingSymbol) ?? 0) + p.qty);
    const diffs: string[] = [];
    for (const sym of new Set([...theirs.keys(), ...ours.keys()])) {
      const a = ours.get(sym) ?? 0;
      const b = theirs.get(sym) ?? 0;
      if (a !== b) diffs.push(`${sym}: engine ${a} vs broker ${b}`);
    }
    if (diffs.length === 0) {
      this.hot.reconcileMismatches = 0;
      return;
    }
    this.hot.reconcileMismatches++;
    await repo.audit.append({ ts: now, actor: "engine", action: "reconcile_mismatch", detail: { diffs, count: this.hot.reconcileMismatches } });
    await this.alerts.send(`⚠ LIVE reconciliation mismatch (${this.hot.reconcileMismatches}): ${diffs.join("; ")}`, { key: "reconcile", minIntervalMs: 5 * MINUTE_MS });
    if (this.hot.reconcileMismatches >= 2) {
      await this.engageKill(`reconciliation mismatch: ${diffs.join("; ")}`, "engine", true, true);
    }
  }

  /** Closes a position at its last mark without an exchange order (paper leftovers after the close). */
  private async closeAtMark(deps: EngineDeps, p: Position, reason: "SQUARE_OFF" | "RECONCILE", note: string): Promise<void> {
    const now = Date.now();
    const price = p.markPremium > 0 ? p.markPremium : p.avgEntry;
    const order: Order = {
      refId: makeRefId(now, "X"),
      contract: p.contract,
      side: "SELL",
      qty: p.qty,
      type: "MARKET",
      product: deps.cfg.broker.product,
      reason,
      planId: p.planId,
      positionId: p.id,
      id: randomId(),
      status: "FILLED",
      filledQty: p.qty,
      avgFillPrice: price,
      createdMs: now,
      updatedMs: now,
      mode: deps.mode,
      error: note,
    };
    const fill: Fill = {
      id: randomId(),
      orderId: order.id,
      t: now,
      qty: p.qty,
      price,
      charges: computeCharges("SELL", price, p.qty, p.contract.exchange, istDate(now)),
      slippageTicks: 0,
    };
    await persistResult(deps, { order, fills: [fill] });
    await applyExitFills(deps, p, [fill], reason);
  }

  // -------------------------------------------------------------------------
  // RPC: called by the cron dispatcher, the queue consumer and EngineAdmin
  // -------------------------------------------------------------------------

  /** Minute cron in market hours: re-arms a missing or far-off alarm and alerts on a stale heartbeat. */
  async ensureRunning(): Promise<{ alarmAt: number | null; rearmed: boolean }> {
    const now = Date.now();
    const settings = await this.rt.repo.settings.get();
    const phase = this.calendarFor(settings).sessionPhase(now);
    const at = await this.ctx.storage.getAlarm();
    const marketHours = phase === "OPEN" || phase === "PRE_OPEN";
    let rearmed = false;
    if (at === null || (marketHours && at > now + 90_000) || at < now - 120_000) {
      await this.ctx.storage.setAlarm(now + 1_000);
      rearmed = true;
    }
    if (marketHours && this.hot.lastTickMs !== null && now - this.hot.lastTickMs > HEARTBEAT_STALE_MS) {
      await this.alerts.send(`⚠ Engine heartbeat stale: last tick ${Math.round((now - this.hot.lastTickMs) / 1000)} s ago (alarm re-armed)`, { key: "heartbeat", minIntervalMs: 10 * MINUTE_MS });
    }
    return { alarmAt: rearmed ? now + 1_000 : at, rearmed };
  }

  /** Runs one tick immediately (admin / tests). */
  async tickNow(): Promise<{ nextAlarmAt: string }> {
    return { nextAlarmAt: istIso(await this.runTick()) };
  }

  /** New event scores arrived: tick soon during market hours so the EPI is used right away. */
  async onNewScores(count: number): Promise<void> {
    const now = Date.now();
    const settings = await this.rt.repo.settings.get();
    const phase = this.calendarFor(settings).sessionPhase(now);
    if (phase !== "OPEN" || count <= 0) return;
    const at = await this.ctx.storage.getAlarm();
    if (at === null || at > now + 5_000) await this.ctx.storage.setAlarm(now + 2_000);
  }

  /** 08:00 IST and POST /ops/token: mint the day's Groww token (tokens expire at 06:00), even during a failure backoff. */
  async refreshToken(): Promise<AdminResult> {
    if (!this.tokens) return { ok: false, message: "Groww credentials not configured (paper trading uses synthetic quotes)" };
    try {
      const t = await this.tokens.refresh({ force: true });
      await recordSourceHealth(this.rt.repo, "groww", true, Date.now());
      return { ok: true, message: `token valid until ${istIso(t.expiryMs)}` };
    } catch (err) {
      await recordSourceHealth(this.rt.repo, "groww", false, Date.now(), errorMessage(err));
      await this.alerts.send(`⚠ Groww token refresh failed: ${errorMessage(err)}`, { key: "token", minIntervalMs: 60 * MINUTE_MS });
      return { ok: false, message: errorMessage(err) };
    }
  }

  /** Current Groww access token for other jobs in this Worker (never returned to the dashboard). */
  async growwToken(): Promise<string | null> {
    return this.tokens ? this.tokens.token() : null;
  }

  /** 08:30 IST: warm market data and make sure the loop starts at 09:00. */
  async premarket(): Promise<AdminResult> {
    const now = Date.now();
    await this.offHoursSnapshot(now);
    this.hot.lastOffHoursSnapshotMs = now;
    await this.saveHot();
    const h = await this.relayHealthCached(true);
    await this.ensureRunning();
    return { ok: true, message: `premarket snapshot written${h ? `; relay: ${h.detail}` : ""}` };
  }

  /** 16:00 IST: close leftovers, grade decisions, update per-signal performance, send the summary. */
  async endOfDay(): Promise<AdminResult> {
    const { repo, logger } = this.rt;
    const now = Date.now();
    const lines: string[] = [];
    for (const book of ["PAPER", "LIVE"] as BookMode[]) {
      const open = await repo.positions.open(book);
      for (const p of open) {
        if (book === "PAPER") await this.closeAtMark(this.deps(book), p, "SQUARE_OFF", "closed at the last mark after the session");
        else {
          let atBroker = 0;
          try {
            atBroker = (await this.deps("LIVE").broker.positions()).filter((x) => x.tradingSymbol === p.contract.tradingSymbol).reduce((s, x) => s + x.qty, 0);
          } catch (err) {
            logger.warn("EOD broker positions unavailable", { error: errorMessage(err) });
            atBroker = p.qty;
          }
          if (atBroker === 0) await this.closeAtMark(this.deps("LIVE"), p, "RECONCILE", "flat at the broker after the session (auto square-off?); verify the contract note");
          await this.alerts.send(`⚠ LIVE position ${p.contract.tradingSymbol} was still open in the engine after the close (broker qty ${atBroker})`);
        }
      }
      const trades = await repo.trades.recent(1, book);
      const hasActivity = book === "PAPER" || trades.length > 0;
      if (!hasActivity) continue;
      try {
        const eod = await runEndOfDay(this.deps(book));
        const l = await repo.ledger.get(eod.date, book);
        if (l) {
          const net = l.realized + l.unrealized - l.charges;
          lines.push(`${book}: net ₹${net.toFixed(0)} (realized ₹${l.realized.toFixed(0)}, charges ₹${l.charges.toFixed(0)}), trades ${l.trades} (${l.wins}W/${l.losses}L), graded ${eod.graded}`);
        } else lines.push(`${book}: no trades, graded ${eod.graded} decisions`);
        if (eod.newlyDisabled.length) lines.push(`disabled: ${eod.newlyDisabled.join(", ")}`);
        if (eod.reEnabled.length) lines.push(`re-enabled: ${eod.reEnabled.join(", ")}`);
      } catch (err) {
        lines.push(`${book}: end-of-day failed: ${errorMessage(err)}`);
        logger.error("end of day failed", { book, error: errorMessage(err) });
      }
    }
    for (const f of this.followers) {
      try {
        const deps = this.followerDeps(f);
        for (const p of await f.repo.positions.open("PAPER")) await this.closeAtMark(deps, p, "SQUARE_OFF", "closed at the last mark after the session");
        // Main grades the shared signals and updates their performance; the follower only closes its day.
        const eod = await runEndOfDay(deps, { grade: false, performance: false });
        const l = await f.repo.ledger.get(eod.date, "PAPER");
        const equity = l ? l.startEquity + l.realized + l.unrealized - l.charges : f.cfg.capitalRupees;
        lines.push(
          l
            ? `${f.spec.shortLabel}: net ₹${(l.realized + l.unrealized - l.charges).toFixed(0)}, trades ${l.trades} (${l.wins}W/${l.losses}L), equity ₹${equity.toFixed(0)}`
            : `${f.spec.shortLabel}: no trades, equity ₹${equity.toFixed(0)}`,
        );
      } catch (err) {
        lines.push(`${f.spec.shortLabel}: end-of-day failed: ${errorMessage(err)}`);
        logger.error("follower end of day failed", { account: f.spec.id, error: errorMessage(err) });
      }
    }
    if (this.agentEnabled) {
      // The options agent closes its leftovers like a follower; the AgentDO's nightly review grades its decisions.
      try {
        if (!this.agent) throw new Error(`the agent is not running: ${this.agentInitError ?? "unknown error"}`);
        const deps = this.agent.deps();
        for (const p of await deps.repo.positions.open("PAPER")) await this.closeAtMark(deps, p, "SQUARE_OFF", "closed at the last mark after the session");
        await runEndOfDay(deps, { grade: false, performance: false });
        lines.push(await this.agent.afterEndOfDay());
      } catch (err) {
        lines.push(`Agent: end-of-day failed: ${errorMessage(err)}`);
        logger.error("agent end of day failed", { error: errorMessage(err) });
      } finally {
        // Queued even when the end of day failed (the POSTMARKET cron asks too; the AgentDO keeps one per day).
        await this.scheduleAgentReview(istDate(now));
      }
    }
    await this.alerts.send(`📊 ${istDate(now)} summary\n${lines.join("\n")}`);
    return { ok: true, message: lines.join(" | ") };
  }

  /**
   * Asks the AgentDO to queue the nightly review of `date`, waiting at most AGENT_REVIEW_SCHEDULE_MS: a silent AgentDO
   * never holds up main's daily summary. The POSTMARKET cron asks again after the end of day. Never throws.
   */
  private async scheduleAgentReview(date: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answered = await Promise.race([
        this.env.AGENT_DO.get(this.env.AGENT_DO.idFromName("agent"))
          .scheduleReview(date)
          .then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), AGENT_REVIEW_SCHEDULE_MS);
        }),
      ]);
      if (!answered) this.rt.logger.warn("agent review not scheduled yet: the AgentDO did not answer in time; the POSTMARKET cron asks again", { date, waitedMs: AGENT_REVIEW_SCHEDULE_MS });
    } catch (err) {
      this.rt.logger.error("agent review not scheduled", { date, error: errorMessage(err) });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 16:15 IST on trading days (cron ARCHIVE, POST /ops/archive): appends the settled 5-minute bars this
   * DO's market-data source holds to D1 bars_5m (workers/engine/src/barArchive.ts). It runs outside the
   * alarm loop and never throws, so a failure cannot stop trading or count toward DEGRADED; the outcome
   * is logged and kept in KV.
   */
  archiveBars(opts: BarArchiveOptions = {}): Promise<BarArchiveStatus> {
    if (!this.archiving) {
      this.archiving = (async () => {
        let calendar = this.rt.calendar;
        try {
          calendar = this.calendarFor(await this.rt.repo.settings.get());
        } catch (err) {
          this.rt.logger.warn("bar archive: settings unavailable, using the bundled holiday calendar", { error: errorMessage(err) });
        }
        return runBarArchive({ db: this.env.DB, kv: this.env.KV, source: this.yahoo, calendar, logger: this.rt.logger }, opts);
      })().finally(() => {
        this.archiving = null;
      });
    }
    return this.archiving;
  }

  /**
   * POST /ops/quotes-snapshot: one quote snapshot now, labelled "manual" (the report leaves those out), for
   * checking the Groww credentials and the table after a deploy. Read-only like the scheduled snapshots.
   */
  recordQuotesNow(): Promise<QuoteRecorderStatus | null> {
    return this.quoteRecorder.run({ manual: true });
  }

  async setArmed(armed: boolean, actor: string): Promise<AdminResult> {
    const { repo } = this.rt;
    const now = Date.now();
    const settings = await repo.settings.get();
    if (!armed) {
      await repo.settings.update({ armedUntil: null }, actor);
      await repo.audit.append({ ts: now, actor, action: "disarm" });
      await this.alerts.send(`🔓 Disarmed by ${actor}`);
      return { ok: true, message: "disarmed" };
    }
    if (settings.killSwitch) return { ok: false, message: "kill switch is engaged; reset it first" };
    const cal = this.calendarFor(settings);
    const today = istDate(now);
    if (!cal.isTradingDay(today)) return { ok: false, message: "not a trading day" };
    const until = cal.closeMs(today);
    if (now >= until) return { ok: false, message: "the session is over" };
    if (settings.mode === "LIVE") {
      if (!this.rt.liveTradingEnabled) return { ok: false, message: "LIVE_TRADING is false on the engine Worker" };
      if (!this.liveAvailable) return { ok: false, message: "LIVE needs Groww credentials and the relay (RELAY_URL, RELAY_HMAC_SECRET)" };
      const h = await this.relayHealthCached(true);
      if (!h || !(h.ok && h.live && h.growwReachable)) return { ok: false, message: `relay not ready: ${h?.detail ?? "unreachable"}` };
    }
    await repo.settings.update({ armedUntil: until }, actor);
    await repo.audit.append({ ts: now, actor, action: "arm", detail: { mode: settings.mode, until } });
    await this.alerts.send(`🔐 Armed (${settings.mode}) by ${actor} until ${istIso(until)}`);
    await this.ensureRunning();
    return { ok: true, message: `armed until ${istIso(until)}` };
  }

  /**
   * Engages the kill switch. Position cycles treat it as a halt and market-exit every open position;
   * LIVE positions are also handed to the relay's panic (cancel all, square off longs).
   * `inTick` is true when called from inside a tick: the exits then run in an immediate follow-up tick.
   * Outside a tick the agent's kill switch follows at once, after main's square-off (with its own exits when
   * squaring off); inside one, the agent's own coupling at its next step does it. A square-off outside a tick holds
   * the agent from the start, before main's switch is written, until the agent's own kill is done. A kill without one
   * that comes while another kill of main (or of every account) squares off does not set the agent's switch: that kill
   * sets it after its panic, and the agent's own coupling at its next step is the backstop.
   */
  private async engageKill(reason: string, actor: string, squareOff: boolean, inTick = false): Promise<void> {
    const hold = squareOff && !inTick;
    if (hold) {
      this.agentHold++;
      this.agentKillsDue++;
    }
    try {
      if (hold) this.agentPreempt?.();
      await this.setMainKill(reason, actor, squareOff);
      if (squareOff) await this.squareOffNow(reason, actor, inTick);
      if (!inTick && (hold || this.agentKillsDue === 0)) await this.coupleAgentKill(reason, actor, squareOff);
    } finally {
      if (hold) {
        this.agentHold--;
        this.agentKillsDue--;
      }
    }
  }

  /**
   * Main's kill engages the agent's at once, so a main kill reset seconds later can never leave the agent trading.
   * Called after main's square-off, so the agent's exits never delay main's. Never throws: a failure is logged and the
   * agent's coupling at its next step is the backstop.
   */
  private async coupleAgentKill(reason: string, actor: string, squareOff: boolean): Promise<void> {
    if (!this.agentEnabled) return;
    try {
      const res = await this.agentKill({ engaged: true, squareOff, reason: `main kill switch: ${reason}` }, actor, false);
      if (!res.ok) this.rt.logger.warn("agent kill switch not engaged with main's", { message: res.message.slice(0, 200) });
    } catch (err) {
      this.rt.logger.error("agent kill switch not engaged with main's", { error: errorMessage(err) });
    }
  }

  /** Main's kill switch on, audited and alerted; no exits yet. */
  private async setMainKill(reason: string, actor: string, squareOff: boolean): Promise<void> {
    const { repo } = this.rt;
    const now = Date.now();
    await repo.settings.update({ killSwitch: true, killReason: reason.slice(0, 300), armedUntil: null }, actor);
    await repo.audit.append({ ts: now, actor, action: "kill", detail: { reason, squareOff } });
    await this.alerts.send(`🛑 KILL SWITCH by ${actor}: ${reason}${squareOff ? " (squaring off)" : ""}`);
  }

  /**
   * Exits every position whose account's kill switch is on: an immediate tick (or the next, inside a tick); LIVE also
   * via the relay's panic. Outside a tick main goes first: TE stops waiting for an agent step already running, and no
   * agent step starts until the square-off tick and the panic are done (the kills that call it hold the agent from
   * their start already).
   */
  private async squareOffNow(reason: string, actor: string, inTick = false): Promise<void> {
    if (inTick) {
      this.tickSoon = true;
      await this.relayPanic(reason, actor);
      return;
    }
    this.agentHold++;
    try {
      this.agentPreempt?.();
      if (this.ticking) await this.ticking;
      await this.runTick();
      await this.relayPanic(reason, actor);
    } finally {
      this.agentHold--;
    }
  }

  /** LIVE positions to the relay's panic (cancel all, square off longs), when main holds any. */
  private async relayPanic(reason: string, actor: string): Promise<void> {
    const { repo } = this.rt;
    if (this.relay && (await repo.positions.open("LIVE")).length > 0) {
      try {
        const res = await this.relay.panic(reason);
        await repo.audit.append({ ts: Date.now(), actor, action: "relay_panic", detail: { status: res.status, body: res.body } });
      } catch (err) {
        await this.alerts.send(`⚠ relay panic failed: ${errorMessage(err)}`);
      }
    }
  }

  /**
   * Kill switch for main (default), one follower account, the agent, or "all". A follower's kill switch only
   * stops that account; its position cycles treat it as a halt and exit at market. A follower's square-off holds the
   * agent as main's does, from before the follower's switch is written until its square-off tick is done, so the
   * agent never delays that tick or main's next alarm.
   */
  async setKillSwitch(req: { engaged: boolean; squareOff: boolean; reason: string }, actor: string, account?: string): Promise<AdminResult> {
    const target = account === "all" ? "all" : parseAccountId(account);
    if (target === null) return { ok: false, message: `unknown account ${String(account).slice(0, 40)}` };
    if (target === "all") return this.killAllAccounts(req, actor);
    if (target === "agent") return this.agentKill(req, actor, false);
    if (target === "main") return this.setMainKillSwitch(req, actor);
    const f = this.followers.find((x) => x.spec.id === target);
    if (!f) return { ok: false, message: `account ${target} is not enabled` };
    const hold = req.engaged && req.squareOff;
    if (hold) this.agentHold++;
    try {
      // The follower's exits come before the agent's step in a tick; a running agent step is not waited for.
      if (hold) this.agentPreempt?.();
      const res = await this.followerKill(f, req, actor);
      if (hold) {
        if (this.ticking) await this.ticking;
        await this.runTick();
      }
      return res;
    } finally {
      if (hold) this.agentHold--;
    }
  }

  /**
   * "all" (Telegram /kill): main's switch first, then each follower's, each on its own so one failure never stops the
   * rest (killAll). With a square-off, one tick then squares off main and the followers (and the relay panic goes out)
   * before the agent's switch is set and its own exits run: the agent never delays main's square-off, and it is held
   * from the start, before any switch is written, until its own kill is done. Without one, and for a reset, the agent's
   * switch is set in the same pass as the others; but a kill without one that comes while another kill of main (or of
   * every account) squares off leaves the agent's switch to that kill, which sets it after its panic, with the agent's
   * own coupling at its next step as the backstop.
   */
  private async killAllAccounts(req: { engaged: boolean; squareOff: boolean; reason: string }, actor: string): Promise<AdminResult> {
    const reason = req.reason || "manual";
    const main: KillStep = {
      label: "main",
      run: async () => {
        if (!req.engaged) return this.setMainKillSwitch(req, actor);
        await this.setMainKill(reason, actor, req.squareOff);
        return { ok: true, message: "kill switch engaged" };
      },
    };
    const followers: KillStep[] = this.followers.map((f) => ({ label: f.spec.shortLabel, run: () => this.followerKill(f, req, actor) }));
    if (!(req.engaged && req.squareOff)) {
      const agent: KillStep = {
        label: "Agent",
        run: async () => (req.engaged && this.agentKillsDue > 0 ? { ok: true, message: "Agent kill switch follows main's after the square-off in progress" } : this.agentKill(req, actor, true)),
      };
      return killAll(req.engaged, main, this.agentEnabled ? [...followers, agent] : followers);
    }
    this.agentHold++;
    this.agentKillsDue++;
    try {
      this.agentPreempt?.();
      const res = await killAll(true, main, followers);
      await this.squareOffNow(reason, actor);
      if (!this.agentEnabled) return res;
      // Alone (not "all"): the agent sets its switch, then runs its own exits.
      let agent: AdminResult;
      try {
        agent = await this.agentKill(req, actor, false);
      } catch (err) {
        agent = { ok: false, message: `Agent: kill switch not engaged: ${errorMessage(err).slice(0, 200)}` };
      }
      return { ok: res.ok && agent.ok, message: `${res.message}; ${agent.message}` };
    } finally {
      this.agentHold--;
      this.agentKillsDue--;
    }
  }

  /** One follower's kill switch. */
  private async followerKill(f: Follower, req: { engaged: boolean; squareOff: boolean; reason: string }, actor: string): Promise<AdminResult> {
    await f.repo.settings.update(req.engaged ? { killSwitch: true, killReason: (req.reason || "manual").slice(0, 300) } : { killSwitch: false, killReason: null }, actor);
    await f.repo.audit.append({ ts: Date.now(), actor, action: req.engaged ? "kill" : "kill_reset", detail: { reason: req.reason, squareOff: req.squareOff } });
    await f.alerts.send(req.engaged ? `🛑 ${f.spec.shortLabel} KILL SWITCH by ${actor}: ${req.reason || "manual"}` : `✅ ${f.spec.shortLabel} kill switch reset by ${actor}`);
    return { ok: true, message: `${f.spec.shortLabel} kill switch ${req.engaged ? "engaged" : "reset"}` };
  }

  /**
   * The agent account's kill switch (AgentRunner.setKill). Alone (`all` false), an engage that squares off runs the
   * agent's own exits and never a tick; with `all`, the switch is only set (a kill of every account without a
   * square-off, or a reset). A reset is refused during the agent's drawdown halt (use Re-arm).
   */
  private async agentKill(req: { engaged: boolean; squareOff: boolean; reason: string }, actor: string, all: boolean): Promise<AdminResult> {
    if (!this.agentEnabled) return { ok: false, message: "account agent is not enabled" };
    if (!this.agent) {
      // The runner did not start; the switch is still the account's own (kv acct:agent:settings).
      const repo = accountRepository(this.rt.repo, "agent", this.rt.cfg, Date.now);
      await repo.settings.update(req.engaged ? { killSwitch: true, killReason: (req.reason || "manual").slice(0, 300) } : { killSwitch: false, killReason: null }, actor);
      return { ok: true, message: `Agent kill switch ${req.engaged ? "engaged" : "reset"} (the agent is not running: ${this.agentInitError ?? "unknown error"})` };
    }
    return this.agent.setKill(req, actor, { all, calendar: this.calendarFor(await this.rt.repo.settings.get()) });
  }

  /** The Agent page's Re-arm (EngineAdmin.rearmAgent): clears the agent's drawdown halt and kill switch. */
  async rearmAgent(actor: string): Promise<AdminResult> {
    if (!this.agentEnabled) return { ok: false, message: "account agent is not enabled" };
    if (!this.agent) return { ok: false, message: `the agent is not running: ${this.agentInitError ?? "unknown error"}` };
    return this.agent.rearm(actor);
  }

  /** /ops/agent-pause: while paused only the agent's code exits run (the AgentDO also refuses candles). */
  async setAgentPaused(on: boolean, actor: string): Promise<AdminResult> {
    if (!this.agentEnabled) return { ok: false, message: "account agent is not enabled" };
    if (!this.agent) return { ok: false, message: `the agent is not running: ${this.agentInitError ?? "unknown error"}` };
    return this.agent.setPaused(Boolean(on), actor);
  }

  private async setMainKillSwitch(req: { engaged: boolean; squareOff: boolean; reason: string }, actor: string): Promise<AdminResult> {
    const { repo } = this.rt;
    if (req.engaged) {
      await this.engageKill(req.reason || "manual", actor, req.squareOff);
      return { ok: true, message: "kill switch engaged" };
    }
    await repo.settings.update({ killSwitch: false, killReason: null }, actor);
    this.hot.consecutiveErrors = 0;
    this.hot.reconcileMismatches = 0;
    await this.saveHot();
    await repo.audit.append({ ts: Date.now(), actor, action: "kill_reset", detail: { reason: req.reason } });
    await this.alerts.send(`✅ Kill switch reset by ${actor}`);
    await this.ensureRunning();
    return { ok: true, message: "kill switch reset" };
  }

  async setMode(mode: EngineMode, actor: string): Promise<AdminResult> {
    const { repo } = this.rt;
    if (mode === "LIVE" && !this.rt.liveTradingEnabled) return { ok: false, message: "LIVE_TRADING is false on the engine Worker" };
    const s = await repo.settings.get();
    if (s.mode === mode) return { ok: true, message: `already ${mode}` };
    await repo.settings.update({ mode, armedUntil: null }, actor);
    await repo.audit.append({ ts: Date.now(), actor, action: "set_mode", detail: { from: s.mode, to: mode } });
    await this.alerts.send(`⚙ Mode ${s.mode} → ${mode} by ${actor} (disarmed)`);
    return { ok: true, message: `mode ${mode}; disarmed` };
  }

  /** Telegram /status text. */
  async statusText(): Promise<string> {
    const { repo } = this.rt;
    const now = Date.now();
    const s = await repo.settings.get();
    const [paper, live] = await Promise.all([repo.positions.open("PAPER"), repo.positions.open("LIVE")]);
    const hb = await repo.heartbeat.read();
    const relay = this.relay ? await this.relayHealthCached() : null;
    const lines = [
      `${istIso(now)} · phase ${await this.phaseFor(now, s)} · mode ${s.mode}${s.armedUntil && s.armedUntil > now ? ` (armed until ${istIso(s.armedUntil)})` : ""}`,
      `kill switch: ${s.killSwitch ? `ON (${s.killReason ?? ""})` : "off"}`,
      `last tick: ${hb?.lastTickMs ? `${Math.round((now - hb.lastTickMs) / 1000)} s ago` : "never"} · errors ${this.hot.consecutiveErrors}`,
      `open: ${paper.length} paper, ${live.length} live`,
      ...[...paper, ...live].map((p) => `  ${p.mode} ${p.contract.tradingSymbol} x${p.qty} @ ${p.avgEntry.toFixed(2)} mark ${p.markPremium.toFixed(2)}`),
      `relay: ${relay ? relay.detail : "not configured"}`,
      `live data: ${this.liveData === "upstox" ? "upstox (index bars and spots over yahoo" : "yahoo (index bars"}; paper quotes ${this.paperQuotes?.kind ?? "synthetic"})`,
    ];
    for (const f of this.followers) {
      const [fs, open, l] = await Promise.all([f.repo.settings.get(), f.repo.positions.open("PAPER"), f.repo.ledger.get(istDate(now), "PAPER")]);
      const net = l ? l.realized + l.unrealized - l.charges : 0;
      lines.push(`${f.spec.shortLabel}: kill switch ${fs.killSwitch ? "ON" : "off"} · open ${open.length} · today net ₹${net.toFixed(0)}`);
      for (const p of open) lines.push(`  ${f.spec.shortLabel} ${p.contract.tradingSymbol} x${p.qty} @ ${p.avgEntry.toFixed(2)} mark ${p.markPremium.toFixed(2)}`);
    }
    if (this.agent) lines.push(...(await this.agent.statusLines()));
    else if (this.agentEnabled) lines.push(`Agent (paper experiment): not running (${this.agentInitError ?? "unknown error"})`);
    if (this.agentEnabled) lines.push(await this.agentDoStatusLine(now));
    return lines.join("\n");
  }

  /**
   * The AgentDO's line for /status: mode, pause, next job, today's spend against the cap and the last batch. Waits at
   * most AGENT_STATUS_MS and never throws. Calling /ops/status first after a deploy makes TE the AgentDO's first
   * caller, so a new AgentDO is placed near TE, which calls it several times a tick (docs/AGENT.md, Rollout).
   */
  private async agentDoStatusLine(now: number): Promise<string> {
    const at = (ms: number) => `${istDate(ms) === istDate(now) ? "" : `${istDate(ms)} `}${formatHHMM(istMinutes(ms))}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const s = await Promise.race([
        this.env.AGENT_DO.get(this.env.AGENT_DO.idFromName("agent")).status() as Promise<AgentStatus>,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), AGENT_STATUS_MS);
        }),
      ]);
      if (!s) return `  AgentDO: no answer within ${AGENT_STATUS_MS / 1000} s`;
      return (
        `  AgentDO: mode ${s.mode}${s.paused ? " · PAUSED" : ""} · next job ${s.nextJobMs !== null ? at(s.nextJobMs) : "none"}` +
        ` · spent $${s.spentUsd.toFixed(3)} of $${s.capUsd.toFixed(2)} today · last batch ${s.lastBatch ? `${at(s.lastBatch.barCloseMs)} ${s.lastBatch.status}` : "none"}`
      );
    } catch (err) {
      return `  AgentDO: status unavailable (${errorMessage(err).slice(0, 120)})`;
    } finally {
      clearTimeout(timer);
    }
  }
}
