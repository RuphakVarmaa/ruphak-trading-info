/**
 * AgentRunner: the options agent's part of TradingEngineDO's tick (a paper experiment; docs/AGENT.md). TE stays the
 * only writer of orders and positions. The AgentDO makes the model calls and keeps the records but never places an
 * order: this runner executes its decisions through the code gate, the planner and the risk layer on the agent's
 * own paper book (PAPER@agent), runs the agent's code exits, and submits each closed 5-minute bar.
 *
 * step() runs after main's exits and exit polls, under a time budget TE sets (AGENT_STEP), in this order:
 *  1. the day's state (TE storage key "agent:hot"; a new IST date clears the per-day fields);
 *  2. main's kill switch engages the agent's (resetting main never resets the agent);
 *  3. the code exits (stop, target, trail, time stop, square-off, kill switch, daily loss cap) while it holds anything;
 *  4. the risk snapshot and the 15% drawdown halt (kill switch, flatten, no entries until the operator re-arms);
 *  5. the newest reflex batch: executed while fresh (shadow mode records what it would have done and places
 *     nothing), recorded as not executed when stale;
 *  6. the execution record, the closed trades and the risk back to the AgentDO (an outbox keeps what it missed);
 *  7. the book the next snapshots read, kept in a ring so a bar's snapshot sees the book as of its close;
 *  8. the latest closed bar's snapshots to the AgentDO, which calls the model on its own alarm: TE never waits.
 * Steps 1-4 always run, and step 6 sends the risk (and any closed trade) in every mode; in mode "off" and while
 * paused nothing else does. Every call to another Durable Object checks the deadline first and has its own timeout,
 * so a slow or silent Durable Object costs the agent's step, never main's tick. Once a kill of main or of every account
 * that squares off pre-empts a step (TE's stopped()), the step takes no batch, sends no record or bar and sends none of
 * the model's exits. A Telegram alert is waited for at most ALERT_WAIT_MS; it is still sent, and alerts go out in order
 * unless an earlier send is still out ALERT_QUEUE_MS after a later alert was raised.
 *
 * pollStep() runs the same sequence without step 5 inside main's 10 s exit-poll waits (while main or a follower
 * account holds a position or an order). The kill coupling and the code exits always run (but before the open a wait
 * runs only the code exits, and a wait does nothing while earlier agent work, such as a step, is still running, at most
 * STUCK_MS); each later part starts, and each call to another Durable Object is sent, only before the wait ends (the
 * book always follows the risk row). A part already started, a drawdown halt above all, can finish after it. A bar the
 * step had no budget left to submit, or a drawdown halt in a tick whose step TE skipped, therefore waits at most one
 * wait; only the decisions wait for a step. A kill of main or of every account that squares off stops it before its
 * next part or call to another Durable Object.
 *
 * The runner never reads main's market data source: the features of main's own tick are the agent's only market
 * input, so the agent can never spend main's request budget or move main's cached prices.
 *
 * Everything outside TE comes in as an interface (the AgentDO and MarketFeedDO stubs, TE's storage, the quote
 * source, Telegram), so agentRunner.test.ts runs it with fakes. It never imports cloudflare:workers.
 */
import type { AccountSpec } from "../../../../src/engine/accounts";
import { agentPositionPass, bookAsOf, bookFrom, buildReflexInput, executeAgentBatch, initialBook, type ExecuteContext } from "../../../../src/engine/agent/agentCycle";
import { latestClosedBarMs } from "../../../../src/engine/agent/causal";
import { AGENT_LIMITS, AGENT_POLICY, AGENT_QUOTES, AGENT_RPC_MS, AGENT_STEP } from "../../../../src/engine/agent/constants";
import { drawdownBreached, riskSnapshotFrom } from "../../../../src/engine/agent/risk";
import type {
  AgentBookState,
  AgentExitReason,
  AgentMode,
  AgentPositionTag,
  AgentRiskSnapshot,
  AgentSettings,
  AgentTradeRecord,
  ExecutionRecord,
  GateVerdict,
  IndexSnapshot,
  ReflexBatch,
  ReflexInput,
  SubmitBarResult,
} from "../../../../src/engine/agent/types";
import type { OptionFlowView } from "../../../../src/engine/api-types";
import { FallbackOptionQuotes } from "../../../../src/engine/broker/groww";
import { PaperBroker } from "../../../../src/engine/broker/paperBroker";
import type { TradingCalendar } from "../../../../src/engine/calendar/calendar";
import { HOUR_MS, MINUTE_MS, SESSION, formatHHMM, istDate, istMidnight, istMinutes, parseHHMM, systemClock, type Clock } from "../../../../src/engine/clock";
import type { EngineConfig } from "../../../../src/engine/config";
import { UpstoxOptionQuotes, type UpstoxMarketClient } from "../../../../src/engine/market/upstoxMarket";
import type { MarketContextStore } from "../../../../src/engine/pipeline/marketContext";
import { loadRiskState } from "../../../../src/engine/pipeline/riskState";
import type { CycleReport } from "../../../../src/engine/pipeline/tradingCycle";
import { randomId, type EngineDeps, type IdGenerator, type InstrumentProvider, type Logger, type MarketDataSource, type OptionQuoteSource, type Repository } from "../../../../src/engine/ports";
import { SyntheticOptionQuotes } from "../../../../src/engine/pricing/syntheticOptionPricer";
import type { EngineSettings, IndexId } from "../../../../src/engine/types";

/** The AgentDO methods the runner calls (a Durable Object stub in the Worker, a fake in tests). */
export interface AgentDoPort {
  submitBar(input: ReflexInput): Promise<SubmitBarResult>;
  takeDecisions(afterBarMs: number): Promise<ReflexBatch | null>;
  recordExecution(rec: ExecutionRecord): Promise<void>;
}

/** The MarketFeedDO method the runner calls: the option flow from the minute samples taken at or before asOfMs. */
export interface FlowAsOfPort {
  getOptionFlowAsOf(index: IndexId, asOfMs: number): Promise<OptionFlowView | null>;
}

/** The slice of TE's Durable Object storage the runner uses (one key, HOT_KEY). */
export interface HotStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/** Telegram (telegram.ts Alerts) on the agent account's kv, so its dedupe keys stay under acct:agent:. */
export interface AlertSink {
  send(text: string, o?: { key?: string; minIntervalMs?: number }): Promise<boolean>;
}

export interface AgentResult {
  ok: boolean;
  message: string;
}

export interface AgentRunnerOptions {
  /** The agent account: its pinned config and its scoped repository (PAPER@agent books, acct:agent: kv). */
  account: { spec: AccountSpec; cfg: EngineConfig; repo: Repository };
  /** Main's repository: main's settings (the kill-switch coupling) and the scored events every account shares. */
  mainRepo: Repository;
  settings: AgentSettings;
  storage: HotStorage;
  agentDo: AgentDoPort;
  feed: FlowAsOfPort;
  /** The runner's own real quote source with its own request budget (agentQuoteSource), never TE's; null: synthetic only. */
  quotes: OptionQuoteSource | null;
  instruments: InstrumentProvider;
  /** Main's latest spot and VIX per index. Read only: the agent never writes it. */
  marketContext: MarketContextStore;
  alerts: AlertSink;
  logger: Logger;
  /** The default calendar (TE passes its own, with the holiday overrides, to each step). */
  calendar: TradingCalendar;
  clock?: Clock;
  newId?: IdGenerator;
}

/** The runner's state in TE's storage. Per-day fields are cleared when the IST date changes. */
export interface AgentHot {
  date: string;
  /** Per day (from the day's start): the last bar submitted to the AgentDO (or skipped), and the last batch taken from it. */
  lastSubmittedBarMs: number;
  lastExecutedBarMs: number;
  /** The highest equity the agent account has reached: the drawdown base. A re-arm restarts it at the current equity. */
  peakEquity: number | null;
  /** Set when the drawdown from the peak reached AGENT_LIMITS.maxDrawdownPct; only a re-arm clears it. */
  ddHalt: boolean;
  /** /ops/agent-pause: only the code exits (and the checks behind them) run. It stays until resumed. */
  paused: boolean;
  /** Per day: the books recorded at each step and exit-poll wait, oldest first (at most AGENT_STEP.bookRing). */
  books: AgentBookState[];
  /** The latest risk snapshot (its book is the fallback when the ring has nothing at or before a bar close). */
  lastRisk: AgentRiskSnapshot | null;
  /**
   * Per day: the snapshots the AgentDO keeps for the last bars it accepted (for a duplicate, the copy it stored first).
   * The code gate reads the snapshots a batch comes with, and these only for a batch that comes without them.
   */
  inputs: { barCloseMs: number; snapshots: Partial<Record<IndexId, IndexSnapshot>> }[];
  /** positionId -> the finalist and decision behind each open agent position. */
  positions: Record<string, AgentPositionTag>;
  /** Per day: every tag seen, with the reason of a decision exit, for the trade records after a position closes. */
  tagged: Record<string, { finalistId: string; decisionId: string; agentExit: AgentExitReason | null }>;
  /** Per day: positionIds whose trade the AgentDO acknowledged. */
  sentTrades: string[];
  /** Closed trades the AgentDO has not acknowledged yet (any day): every record carries them until it does. */
  unsentTrades: AgentTradeRecord[];
  /**
   * Execution records the AgentDO did not acknowledge, oldest first; sent before the next one. They carry no trades
   * (those wait in unsentTrades), so dropping the oldest when it is full never loses a trade.
   */
  outbox: ExecutionRecord[];
  lastRecordMs: number;
  /** The IST date of the last cost-cap alert (one a day). */
  costCapAlertDate: string | null;
}

/** How long a piece of the agent's work may run: its deadline and a kill that stops it (in TE's step and exit-poll waits). */
interface Budget {
  deadlineMs: number;
  /** True once a kill of main or of every account that squares off pre-empts the work: no call to another Durable Object is sent after it. */
  stopped?: () => boolean;
}

/** One pass of the per-tick sequence: TE's step, or the agent's part of one of TE's exit-poll waits. */
interface Pass extends Budget {
  kind: "step" | "wait";
  degraded: boolean;
}

export const HOT_KEY = "agent:hot";
export const ALERT_PREFIX = "🤖 Agent (paper experiment)";
const ALERT_AFTER_ERRORS = 5;
/** A step still running after this long is treated as lost, so a hung call can never stop the agent's exits for good. */
const STUCK_MS = 2 * MINUTE_MS;
/** Without a batch or a closed trade, the risk still reaches the AgentDO at most this often. */
const RISK_RECORD_EVERY_MS = MINUTE_MS;
/** The runner waits at most this long for a Telegram alert (sendTelegram allows one 10 s); the send carries on. */
const ALERT_WAIT_MS = 1_000;
/** An alert waits at most this long for the one before it to go out (then it may go out first), so a hung send never holds back the rest. */
const ALERT_QUEUE_MS = 15_000;
const INPUTS_KEPT = 3;
/**
 * The runner's quotes are reused this long. With TE's exit polls the agent's positions are priced up to six times a
 * minute; at 15 s the requests stay within AGENT_QUOTES.maxRequestsPerMinute instead of spilling onto synthetic prices.
 */
export const AGENT_QUOTE_CACHE_MS = 15_000;

/**
 * The market data source in the agent's deps. The agent never reads main's (its spot and candle caches and its
 * request budget are main's), so every read fails: an entry with no features from main's tick is not taken.
 */
export const AGENT_NO_MARKET: MarketDataSource = {
  snapshot: () => Promise.reject(new Error("the agent never reads main's market data source")),
};

/** The model's call in Telegram's words: the agent only buys, so a SHORT call is a bought put, never a sold call. */
const CALL_WORDS: Record<"LONG" | "SHORT", string> = { LONG: "the model's Up call (bought a call)", SHORT: "the model's Down call (bought a put)" };
/** Why the model's decision closed a position, in plain words. */
const EXIT_WORDS: Record<AgentExitReason, string> = {
  AGENT_REDUCE: "the model asked to cut risk",
  AGENT_CRISIS: "the model saw a crisis",
  AGENT_OPPOSITE: "the model turned confidently the other way",
};

/** An exit order's status in plain words. */
function exitStatusWords(status: string): string {
  if (status === "FILLED") return "filled";
  if (status === "REJECTED" || status === "CANCELLED") return `order ${status.toLowerCase()}`;
  if (status.startsWith("ERROR")) return `not sent: ${status.replace(/^ERROR:\s*/, "").slice(0, 120)}`;
  return "order sent";
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The agent step's time budget: clamp(tickStart + AGENT_STEP.fromTickStartMs − now, AGENT_STEP.minMs, AGENT_STEP.maxMs). */
export function agentStepBudgetMs(tickStartMs: number, nowMs: number): number {
  return Math.min(AGENT_STEP.maxMs, Math.max(AGENT_STEP.minMs, tickStartMs + AGENT_STEP.fromTickStartMs - nowMs));
}

/**
 * The runner's own Upstox option quotes: a separate instance with a smaller request budget and its own pause after
 * an error, so the agent can never spend main's budget or push main onto synthetic prices. Null without a client.
 */
export function agentQuoteSource(client: UpstoxMarketClient | null): UpstoxOptionQuotes | null {
  if (!client) return null;
  return new UpstoxOptionQuotes(client, { maxRequestsPerMinute: AGENT_QUOTES.maxRequestsPerMinute, pauseAfterErrorMs: AGENT_QUOTES.pauseAfterErrorMs, cacheMs: AGENT_QUOTE_CACHE_MS });
}

export interface KillStep {
  label: string;
  run: () => Promise<AgentResult>;
}

/**
 * The kill switch for "all": main first, then every other account, each in its own try/catch so one failure never
 * stops the rest. Each result becomes a line of the reply. A refusal is a failure for an engage; for a reset it is
 * only a line (the agent refuses a reset while its drawdown halt holds). Square-off is the caller's: one tick after
 * every switch is set.
 */
export async function killAll(engaged: boolean, main: KillStep, others: readonly KillStep[]): Promise<AgentResult> {
  const lines: string[] = [];
  let ok = true;
  for (const [i, step] of [main, ...others].entries()) {
    try {
      const res = await step.run();
      lines.push(res.message);
      if (!res.ok && (engaged || i === 0)) ok = false;
    } catch (err) {
      lines.push(`${step.label}: kill switch ${engaged ? "not engaged" : "not reset"}: ${message(err).slice(0, 200)}`);
      ok = false;
    }
  }
  return { ok, message: lines.join("; ") };
}

/** Runs `f` for at most `ms`; a timeout or a throw comes back as an error, never as an exception. */
async function within<T>(f: () => Promise<T>, ms: number): Promise<{ value: T } | { error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      f().then((value) => ({ value })),
      new Promise<{ error: string }>((resolve) => {
        timer = setTimeout(() => resolve({ error: `no answer within ${ms / 1000} s` }), ms);
      }),
    ]);
  } catch (err) {
    return { error: message(err) };
  } finally {
    clearTimeout(timer);
  }
}

function initialHot(date: string): AgentHot {
  return {
    date,
    lastSubmittedBarMs: istMidnight(date),
    lastExecutedBarMs: istMidnight(date),
    peakEquity: null,
    ddHalt: false,
    paused: false,
    books: [],
    lastRisk: null,
    inputs: [],
    positions: {},
    tagged: {},
    sentTrades: [],
    unsentTrades: [],
    outbox: [],
    lastRecordMs: 0,
    costCapAlertDate: null,
  };
}

/**
 * A new IST date: clears the per-day fields and keeps the peak, the halt, the pause, the open tags, the trades not
 * yet acknowledged and the outbox. The bar cursors restart at the day's start, so a batch from an earlier day is
 * never taken again.
 */
function rollDay(hot: AgentHot, date: string): void {
  const open = new Set(Object.keys(hot.positions));
  hot.date = date;
  hot.lastSubmittedBarMs = istMidnight(date);
  hot.lastExecutedBarMs = istMidnight(date);
  hot.books = [];
  hot.inputs = [];
  hot.sentTrades = [];
  hot.tagged = Object.fromEntries(Object.entries(hot.tagged).filter(([id]) => open.has(id)));
}

/** Every decision of a batch that was not executed, its exit-only ones too (for example, too old by the time TE took it). */
function notExecuted(batch: ReflexBatch, risk: AgentRiskSnapshot, nowMs: number, detail: string): ExecutionRecord {
  const gate: GateVerdict = { fired: false, lines: [{ gate: "fresh", passed: false, detail }], codeToxic: [], codeRisk: risk.codeRisk, effectiveRisk: risk.codeRisk };
  return {
    barCloseMs: batch.barCloseMs,
    t: nowMs,
    decisions: [...batch.decisions, ...batch.exitOnly].map((d) => ({
      decisionId: d.id,
      execution: { t: nowMs, gate, action: "NOT_EXECUTED", detail, planId: null, positionId: null, tradingSymbol: null, edge: null, sizing: null },
    })),
    exits: [],
    trades: [],
    risk,
  };
}

/** Trades by positionId; a later list wins (the runner's own records carry the tags). */
function mergeTrades(a: readonly AgentTradeRecord[], b: readonly AgentTradeRecord[]): AgentTradeRecord[] {
  const byId = new Map<string, AgentTradeRecord>();
  for (const t of [...a, ...b]) byId.set(t.positionId, t);
  return [...byId.values()];
}

const hhmm = (ms: number): string => formatHHMM(istMinutes(ms));

export class AgentRunner {
  /** Consecutive failed steps: the agent's own counter, never main's. */
  errors = 0;
  private hot: AgentHot | null = null;
  private loading: Promise<AgentHot> | null = null;
  private busy: { what: string; since: number; done: Promise<void> } | null = null;
  /** The latest alert in flight. The next alert waits for it to go out, at most ALERT_QUEUE_MS from when the next was raised. */
  private alerting: Promise<void> = Promise.resolve();
  private readonly clock: Clock;
  private readonly newId: IdGenerator;

  constructor(private readonly o: AgentRunnerOptions) {
    this.clock = o.clock ?? systemClock;
    this.newId = o.newId ?? randomId;
  }

  get mode(): AgentMode {
    return this.o.settings.mode;
  }

  private now(): number {
    return this.clock.now();
  }

  /**
   * Paper deps on the agent's own book: a PAPER PaperBroker, and the runner's quotes with synthetic ones behind them.
   * Its market source refuses every read (AGENT_NO_MARKET): the agent never touches main's.
   */
  deps(calendar: TradingCalendar = this.o.calendar): EngineDeps {
    const { cfg, repo } = this.o.account;
    const { logger, marketContext } = this.o;
    const synthetic = new SyntheticOptionQuotes(calendar, cfg);
    const real = this.o.quotes;
    const optionQuotes: OptionQuoteSource = real
      ? new FallbackOptionQuotes(real, synthetic, (err) => logger.warn(`agent ${real.kind} quote failed; synthetic quote used (the agent never enters on one)`, { error: message(err) }))
      : synthetic;
    const broker = new PaperBroker({ cfg, clock: this.clock, repo, quotes: optionQuotes, marketContext: (i) => marketContext.get(i), newId: this.newId, mode: "PAPER" });
    return { cfg, clock: this.clock, calendar, repo, broker, market: AGENT_NO_MARKET, optionQuotes, instruments: this.o.instruments, logger, newId: this.newId, mode: "PAPER", marketContext };
  }

  // -------------------------------------------------------------------------
  // State and guards
  // -------------------------------------------------------------------------

  private async loadHot(nowMs: number): Promise<AgentHot> {
    if (!this.hot) {
      // One read, shared by concurrent first callers, so no one works on a copy another will overwrite.
      this.loading ??= (async () => ({ ...initialHot(istDate(nowMs)), ...((await this.o.storage.get<AgentHot>(HOT_KEY)) ?? {}) }))().finally(() => {
        this.loading = null;
      });
      const loaded = await this.loading;
      this.hot ??= loaded;
    }
    const today = istDate(nowMs);
    if (this.hot.date !== today) rollDay(this.hot, today);
    return this.hot;
  }

  private async saveHot(): Promise<void> {
    if (this.hot) await this.o.storage.put(HOT_KEY, this.hot);
  }

  /** True while `b` has `needMs` left and no kill has stopped it. */
  private has(b: Budget, needMs: number): boolean {
    return !b.stopped?.() && b.deadlineMs - this.now() >= needMs;
  }

  /**
   * One piece of the agent's work at a time: TE abandons a step that overruns its budget, and the next tick must not
   * run beside it. Failures count against the agent only, with an alert at the fifth in a row.
   */
  private async exclusive(what: string, fn: () => Promise<void>): Promise<void> {
    const now = this.now();
    if (this.busy && now - this.busy.since < STUCK_MS) {
      this.o.logger.warn("agent work skipped: the previous step is still running", { what, running: this.busy.what, forMs: now - this.busy.since });
      return;
    }
    let release = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mine = { what, since: now, done };
    this.busy = mine;
    try {
      await fn();
      this.errors = 0;
    } catch (err) {
      this.errors++;
      this.o.logger.error("agent step failed", { what, error: message(err), consecutive: this.errors });
      if (this.errors === ALERT_AFTER_ERRORS) {
        await this.alert(`⚠ ${ALERT_AFTER_ERRORS} failed steps in a row (${what}): ${message(err).slice(0, 200)}`, { key: "agent-errors", minIntervalMs: 30 * MINUTE_MS });
      }
    } finally {
      if (this.busy === mine) this.busy = null;
      release();
    }
  }

  /** Waits (at most maxMs) for the agent's work in progress to finish. */
  private async idle(maxMs: number): Promise<void> {
    const running = this.busy;
    if (!running) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([running.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, maxMs)))]);
    clearTimeout(timer);
  }

  /**
   * An operator action under the same lock as the steps: it waits for the step in progress (a step started meanwhile
   * is skipped), so the step cannot write back state the action just changed. Errors reach the caller.
   */
  private async locked<T>(what: string, fn: () => Promise<T>): Promise<T> {
    await this.idle(AGENT_STEP.maxMs + 3_000);
    if (this.busy && this.now() - this.busy.since < STUCK_MS) throw new Error(`the agent's ${this.busy.what} is still running; try again shortly`);
    let release = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mine = { what, since: this.now(), done };
    this.busy = mine;
    try {
      return await fn();
    } finally {
      if (this.busy === mine) this.busy = null;
      release();
    }
  }

  /**
   * A Telegram alert, waited for at most ALERT_WAIT_MS: a slow chat never holds up the agent's exits, its halt or a
   * step's decisions, and the send carries on. It waits for the alert before it to go out, at most ALERT_QUEUE_MS from
   * when this one was raised (one hung send never holds back every later alert), so alerts go out in order unless an
   * earlier send is still out ALERT_QUEUE_MS after a later alert was raised. Never throws.
   */
  private async alert(text: string, o?: { key?: string; minIntervalMs?: number }): Promise<void> {
    const before = this.alerting;
    const sent = (async () => {
      await within(() => before, ALERT_QUEUE_MS);
      try {
        await this.o.alerts.send(`${ALERT_PREFIX}: ${text}`, o);
      } catch (err) {
        this.o.logger.warn("agent alert failed", { error: message(err) });
      }
    })();
    this.alerting = sent;
    await within(() => sent, ALERT_WAIT_MS);
  }

  // -------------------------------------------------------------------------
  // TE's tick
  // -------------------------------------------------------------------------

  /** Open agent positions plus open agent orders. */
  private async holding(): Promise<number> {
    const repo = this.o.account.repo;
    const [p, o] = await Promise.all([repo.positions.open("PAPER"), repo.orders.open("PAPER")]);
    return p.length + o.length;
  }

  /** Open agent positions plus open agent orders; 0 when the book cannot be read (never throws). */
  async openCount(): Promise<number> {
    try {
      return await this.holding();
    } catch (err) {
      this.o.logger.warn("agent open count failed", { error: message(err) });
      return 0;
    }
  }

  /**
   * TE's exit-poll waits while a kill squares off main: the agent's code exits only. Never throws; skipped while another
   * agent step runs.
   */
  async exitsOnly(cal: TradingCalendar): Promise<void> {
    await this.exclusive("exits", () => this.codeExits(this.deps(cal)));
  }

  /**
   * The whole per-tick sequence (see the module comment). Never throws; `deadlineMs` bounds its calls to other Durable
   * Objects. Once `stopped()` is true (a kill of main or of every account that squares off has pre-empted it), it takes
   * no batch, sends no record or bar, and sends none of the model's exits; its kill coupling, code exits and drawdown
   * check run as in every step.
   */
  async step(report: CycleReport, cal: TradingCalendar, degraded: boolean, deadlineMs: number, stopped?: () => boolean): Promise<void> {
    await this.exclusive("step", () => this.pass(report, cal, { kind: "step", degraded, deadlineMs, stopped }));
  }

  /**
   * The agent's part of one of TE's exit-poll waits (main's own 10 s waits while main or a follower account holds a
   * position or an order): the step without its decisions, so whatever a step left undone for lack of budget, or a step
   * TE skipped, is done within one wait. That is the kill coupling, the code exits, the drawdown check and its halt, the
   * risk row, the book, and the latest closed bar while it is unsent and fresh. The kill coupling and the code exits
   * always run; each later part starts, and each call to another Durable Object is sent, only before `deadlineMs` (the
   * wait's end) and while `stopped()` is false (a kill of main or of every account that squares off), the book always
   * following the risk row. A part already started can finish after the wait with its D1, quote and Telegram calls, and
   * a drawdown halt always finishes. Before the open only the code exits run. Never throws; skipped while another agent
   * step runs.
   */
  async pollStep(report: CycleReport, cal: TradingCalendar, deadlineMs: number, stopped: () => boolean = () => false): Promise<void> {
    await this.exclusive("poll", () => this.pass(report, cal, { kind: "wait", degraded: false, deadlineMs, stopped }));
  }

  /**
   * One pass of the per-tick sequence. A step runs all of it and always runs steps 1-4 (once a kill has stopped it, with
   * no call to another Durable Object and none of the model's exits). A wait leaves out the decisions, and starts each
   * part after the code exits only while it has time and no kill has stopped it.
   */
  private async pass(report: CycleReport, cal: TradingCalendar, p: Pass): Promise<void> {
    const now = this.now();
    const hot = await this.loadHot(now);
    const deps = this.deps(cal);
    const wait = p.kind === "wait";
    if (report.phase !== "OPEN") {
      // Before the open a step only loads the day's state; a wait runs the code exits, as at any time.
      if (wait) await this.codeExits(deps);
      await this.saveHot();
      return;
    }
    const more = () => !wait || this.has(p, 0);
    const prevRisk = hot.lastRisk;
    const main = await this.coupleKill(now);
    this.rememberTags();
    await this.codeExits(deps);
    if (!more()) return;
    const checked = await this.riskCheck(deps, main, now);
    let risk = checked.risk;
    const active = this.mode !== "off" && !hot.paused;
    let rec: ExecutionRecord | null = null;
    if (active && !wait) {
      rec = await this.executeLatest(deps, report, cal, p.degraded, risk, p);
      if (rec) risk = rec.risk;
    }
    if (!more()) return;
    // Paused or off too: the risk (at most once a minute) and any closed trade still reach the AgentDO, so the
    // Agent page never shows an old halt or kill switch.
    await this.report(rec, risk, p);
    await this.recordBook(risk);
    await this.saveHot();
    if (active && more()) {
      await this.submit(report, cal, prevRisk, checked.startEquity, p);
      await this.saveHot();
    }
  }

  /** Step 2: main's kill switch engages the agent's; resetting main leaves the agent's alone. Returns main's settings. */
  private async coupleKill(now: number): Promise<EngineSettings> {
    const repo = this.o.account.repo;
    const [main, mine] = await Promise.all([this.o.mainRepo.settings.get(), repo.settings.get()]);
    if (main.killSwitch && !mine.killSwitch) {
      const reason = `main kill switch engaged at ${hhmm(now)}`;
      await repo.settings.update({ killSwitch: true, killReason: reason }, "engine");
      await repo.audit.append({ ts: now, actor: "engine", action: "kill", detail: { reason, coupled: true } });
      await this.alert(`kill switch engaged because main's is on (${main.killReason ?? "no reason given"}); it stays on after main is reset`, { key: "agent-kill-coupled", minIntervalMs: 60 * MINUTE_MS });
    }
    return main;
  }

  /** Step 3: the code exits (agentPositionPass) while the account holds a position or an order. */
  private async codeExits(deps: EngineDeps): Promise<void> {
    if ((await this.holding()) === 0) return;
    const pr = await agentPositionPass(deps);
    for (const x of pr.exits) {
      const pos = await deps.repo.positions.get(x.positionId);
      const pnl = pos && pos.status === "CLOSED" ? (pos.realized ?? 0) - pos.entryCharges - (pos.exitCharges ?? 0) : null;
      await this.alert(`EXIT ${pos?.contract.tradingSymbol ?? x.positionId} ${x.reason} (${x.status})${pnl !== null ? ` net ₹${pnl.toFixed(0)}` : ""}`);
    }
    for (const e of pr.errors) this.o.logger.warn("agent position cycle error", { error: e });
  }

  /** The agent's risk snapshot now (the peak equity carries over from earlier steps and days). */
  private async riskNow(mainKill: boolean, now: number): Promise<{ risk: AgentRiskSnapshot; startEquity: number }> {
    const hot = this.hot!;
    const { repo, cfg } = this.o.account;
    const settings = await repo.settings.get();
    const rs = await loadRiskState(repo, cfg, settings, now, "PAPER");
    const risk = riskSnapshotFrom(rs, hot.peakEquity, { killSwitch: settings.killSwitch, killReason: settings.killReason, mainKillSwitch: mainKill, ddHalt: hot.ddHalt, nowMs: now });
    return { risk, startEquity: rs.day.startEquity };
  }

  /**
   * Step 4: the risk snapshot and the drawdown halt: kill switch, flatten at market, no entries until a re-arm.
   * The halt acts first (kill switch, audit, alert, exits) and latches last, so a write that fails part way leaves
   * it unlatched and the next step does all of it again. Once latched it is checked again on every step: a kill
   * switch that went off is put back on and the exits run again.
   */
  private async riskCheck(deps: EngineDeps, main: EngineSettings, now: number): Promise<{ risk: AgentRiskSnapshot; startEquity: number }> {
    const hot = this.hot!;
    const repo = this.o.account.repo;
    let checked = await this.riskNow(main.killSwitch, now);
    hot.peakEquity = checked.risk.peakEquity;
    if (drawdownBreached(checked.risk) || hot.ddHalt) {
      const reason = `max drawdown ${AGENT_LIMITS.maxDrawdownPct}% reached: re-arm on the Agent page`;
      const engage = !checked.risk.killSwitch;
      if (engage) await repo.settings.update({ killSwitch: true, killReason: reason }, "engine");
      if (!hot.ddHalt) {
        const dd = checked.risk.ddPct;
        await repo.audit.append({ ts: now, actor: "engine", action: "kill", detail: { reason, drawdownPct: dd, peakEquity: checked.risk.peakEquity, equity: checked.risk.equity } });
        await this.alert(
          `🛑 down ${dd.toFixed(1)}% from its peak equity (limit ${AGENT_LIMITS.maxDrawdownPct}%): kill switch on, positions closed at market, no new entries until it is re-armed on the Agent page`,
          { key: "agent-dd-halt", minIntervalMs: 6 * 60 * MINUTE_MS },
        );
      }
      // With the kill switch on every exit is a market exit. A latched halt whose switch was already on had its exits
      // run with the switch on in step 3 of this same step.
      if (engage || !hot.ddHalt) {
        await this.codeExits(deps);
        if (!hot.ddHalt) {
          hot.ddHalt = true;
          await this.saveHot();
        }
        checked = await this.riskNow(main.killSwitch, this.now());
      }
    }
    hot.lastRisk = checked.risk;
    return checked;
  }

  /** Step 5: takes the newest batch the AgentDO has after the last one executed, and executes it while it is fresh. */
  private async executeLatest(deps: EngineDeps, report: CycleReport, cal: TradingCalendar, degraded: boolean, risk: AgentRiskSnapshot, b: Budget): Promise<ExecutionRecord | null> {
    const hot = this.hot!;
    if (!this.has(b, AGENT_RPC_MS.takeDecisions)) return null;
    const got = await within(() => this.o.agentDo.takeDecisions(hot.lastExecutedBarMs), AGENT_RPC_MS.takeDecisions);
    if ("error" in got) {
      this.o.logger.warn("agent decisions not taken", { error: got.error });
      return null;
    }
    const batch = got.value;
    if (!batch || batch.barCloseMs <= hot.lastExecutedBarMs) return null;
    const now = this.now();
    if (batch.status === "COST_CAP" && hot.costCapAlertDate !== hot.date) {
      hot.costCapAlertDate = hot.date;
      await this.alert(`the daily model budget ($${this.o.settings.dailyUsdCap}) is used up: no more candles are judged today and no new entries are taken; exits still run`);
    }
    // Marked first: a step that dies part way through never executes the same batch twice.
    hot.lastExecutedBarMs = batch.barCloseMs;
    await this.saveHot();
    const ageMs = now - batch.barCloseMs;
    if (ageMs > AGENT_POLICY.maxDecisionAgeMs) {
      return notExecuted(batch, risk, now, `stale: taken ${Math.round(ageMs / 1000)} s after the candle closed (limit ${AGENT_POLICY.maxDecisionAgeMs / MINUTE_MS} min)`);
    }
    const ctx: ExecuteContext = {
      mode: this.mode === "paper" ? "paper" : "shadow",
      nowMs: now,
      calendar: cal,
      features: report.features,
      pressure: report.pressure,
      convictions: report.convictions,
      // The bar's snapshots as the AgentDO stored them, the ones the model judged; TE's own copy only from an AgentDO
      // that does not send them.
      snapshots: batch.snapshots ?? hot.inputs.find((x) => x.barCloseMs === batch.barCloseMs)?.snapshots ?? {},
      noEntries: degraded ? "engine DEGRADED after repeated errors: exits only" : null,
      mainSettings: () => this.o.mainRepo.settings.get(),
      peakEquity: hot.peakEquity,
      ddHalt: hot.ddHalt,
      positions: hot.positions,
      trades: await this.todayTrades(now),
      timeLeftMs: () => b.deadlineMs - this.now(),
      // The operator's pause, read with the kill switches before each order: a pause stops the rest of a running batch.
      paused: () => this.hot?.paused === true,
      stopped: b.stopped,
    };
    const rec = await executeAgentBatch(deps, batch, ctx);
    this.rememberTags(rec);
    await this.saveHot();
    await this.alertActions(batch, rec);
    return rec;
  }

  /** Keeps today's tags (and the reason of each decision exit) for the trade records, also after a position closes. */
  private rememberTags(rec?: ExecutionRecord): void {
    const hot = this.hot!;
    for (const [id, tag] of Object.entries(hot.positions)) hot.tagged[id] ??= { finalistId: tag.finalistId, decisionId: tag.decisionId, agentExit: null };
    for (const x of rec?.exits ?? []) {
      const tag = hot.tagged[x.positionId];
      if (tag) tag.agentExit = x.reason;
    }
  }

  /**
   * Telegram for paper orders only (shadow mode places none), in plain words: the agent only buys, so the model's
   * Up call buys a call and its Down call buys a put. Plain alerts: the agent never sends copy-trade tickets.
   */
  private async alertActions(batch: ReflexBatch, rec: ExecutionRecord): Promise<void> {
    if (this.mode !== "paper") return;
    for (const { decisionId, execution: e } of rec.decisions) {
      if (e.action !== "ENTERED" && e.action !== "ENTRY_PENDING") continue;
      const d = batch.decisions.find((x) => x.id === decisionId);
      const call =
        d && d.direction !== "NEUTRAL" ? ` on ${CALL_WORDS[d.direction]}: confidence ${d.directionConfidence.toFixed(2)}, setup ${d.setupQuality}, ${d.finalistId}` : "";
      await this.alert(`ENTRY ${e.tradingSymbol ?? "?"}${e.sizing ? ` ${e.sizing.lots} lot${e.sizing.lots === 1 ? "" : "s"}` : ""} (${e.action === "ENTERED" ? "filled" : "order sent"})${call}`);
    }
    for (const x of rec.exits) {
      if (x.status === "EXIT_PENDING") continue;
      const symbol = (await this.o.account.repo.positions.get(x.positionId).catch(() => null))?.contract.tradingSymbol ?? x.positionId;
      await this.alert(`EXIT ${symbol} on the model's call: ${EXIT_WORDS[x.reason]} (${exitStatusWords(x.status)})`);
    }
  }

  /** Step 6: the execution record, the trades not yet acknowledged and the risk; the risk alone at most once a minute. */
  private async report(rec: ExecutionRecord | null, risk: AgentRiskSnapshot, b: Budget): Promise<void> {
    const hot = this.hot!;
    const now = this.now();
    this.collectTrades(await this.todayTrades(now));
    if (!rec && hot.unsentTrades.length === 0 && now - hot.lastRecordMs < RISK_RECORD_EVERY_MS) return;
    const record: ExecutionRecord = rec
      ? { ...rec, trades: mergeTrades(rec.trades, hot.unsentTrades) }
      : { barCloseMs: hot.lastExecutedBarMs, t: now, decisions: [], exits: [], trades: [...hot.unsentTrades], risk };
    await this.deliver(record, b);
  }

  /** Adds closed trades the AgentDO has not acknowledged to unsentTrades (a newer copy replaces an older one). */
  private collectTrades(trades: readonly AgentTradeRecord[]): void {
    const hot = this.hot!;
    for (const t of trades) {
      if (hot.sentTrades.includes(t.positionId)) continue;
      const i = hot.unsentTrades.findIndex((u) => u.positionId === t.positionId);
      if (i >= 0) hot.unsentTrades[i] = t;
      else hot.unsentTrades.push(t);
    }
  }

  /** Sends the outbox (oldest first), then `record`; whatever the AgentDO does not acknowledge waits for the next step. */
  private async deliver(record: ExecutionRecord, b: Budget): Promise<boolean> {
    const hot = this.hot!;
    while (hot.outbox.length > 0) {
      if (!this.has(b, AGENT_RPC_MS.recordExecution) || !(await this.send(hot.outbox[0]))) {
        this.queue(record);
        return false;
      }
      hot.outbox.shift();
    }
    if (this.has(b, AGENT_RPC_MS.recordExecution) && (await this.send(record))) return true;
    this.queue(record);
    return false;
  }

  /** One recordExecution; trades count as sent only once the AgentDO has acknowledged them. */
  private async send(rec: ExecutionRecord): Promise<boolean> {
    const res = await within(() => this.o.agentDo.recordExecution(rec), AGENT_RPC_MS.recordExecution);
    if ("error" in res) {
      this.o.logger.warn("agent execution record not delivered (kept for the next step)", { barCloseMs: rec.barCloseMs, error: res.error });
      return false;
    }
    const hot = this.hot!;
    const sent = new Set(rec.trades.map((t) => t.positionId));
    for (const id of sent) if (!hot.sentTrades.includes(id)) hot.sentTrades.push(id);
    hot.unsentTrades = hot.unsentTrades.filter((t) => !sent.has(t.positionId));
    hot.lastRecordMs = this.now();
    return true;
  }

  /**
   * Keeps a record's decisions and exits for the next step, at most AGENT_STEP.outboxMax, the oldest dropped first.
   * Its trades stay in unsentTrades (every record carries them), so nothing dropped here is a trade. A record with
   * nothing else in it (the risk alone) is not kept: the next one supersedes it.
   */
  private queue(rec: ExecutionRecord): void {
    if (rec.decisions.length === 0 && rec.exits.length === 0) return;
    const box = this.hot!.outbox;
    box.push({ ...rec, trades: [] });
    if (box.length > AGENT_STEP.outboxMax) box.splice(0, box.length - AGENT_STEP.outboxMax);
  }

  /**
   * Step 7: the book as of now (the snapshots of later bars read it), and the tags of positions that closed. A tag
   * stays while its position is open or its entry order still rests (a resting entry has no position yet), so the
   * model's exits apply once it fills. The book is stamped after its positions are read: the marks the exits just set
   * are then at or before its time (so the snapshot shows the open P&L), and a fill made after a bar's close can never
   * reach that bar's book.
   */
  private async recordBook(risk: AgentRiskSnapshot): Promise<void> {
    const hot = this.hot!;
    const { repo } = this.o.account;
    const [open, orders] = await Promise.all([repo.positions.open("PAPER"), repo.orders.open("PAPER")]);
    const t = this.now();
    const ids = new Set([...open.map((p) => p.id), ...orders.filter((o) => o.reason === "ENTRY" && o.positionId).map((o) => o.positionId)]);
    for (const id of Object.keys(hot.positions)) if (!ids.has(id)) delete hot.positions[id];
    hot.books.push(bookFrom({ ...risk, t }, open, (p) => p.contract.lotSize));
    if (hot.books.length > AGENT_STEP.bookRing) hot.books.splice(0, hot.books.length - AGENT_STEP.bookRing);
  }

  /**
   * Step 8: the latest closed bar between 09:20 and 15:30, once every index's bar is complete (or AGENT_POLICY
   * .incompleteBarWaitMs after the close with at least one complete). Bars after 15:05 go too: the AgentDO stores them
   * for grading only. A bar not submitted within AGENT_POLICY.maxDecisionAgeMs is skipped; a failed submission is
   * retried on the next tick while the bar is fresh (the AgentDO accepts each bar once).
   */
  private async submit(report: CycleReport, cal: TradingCalendar, prevRisk: AgentRiskSnapshot | null, startEquity: number, b: Budget): Promise<void> {
    const hot = this.hot!;
    const snap = report.snapshot;
    if (!snap) return;
    const { cfg } = this.o.account;
    const now = this.now();
    const bar = latestClosedBarMs(snap, cfg.indices, now, cal);
    if (!bar || bar.barCloseMs <= hot.lastSubmittedBarMs) return;
    const t = bar.barCloseMs;
    const min = istMinutes(t);
    if (min < parseHHMM(AGENT_POLICY.reflexFirstBarIst) || min > SESSION.close) return;
    if (now - t > AGENT_POLICY.maxDecisionAgeMs) {
      hot.lastSubmittedBarMs = t;
      this.o.logger.warn("agent bar skipped: not submitted in time", { bar: hhmm(t), complete: bar.complete });
      return;
    }
    const allComplete = cfg.indices.every((i) => bar.complete.includes(i));
    if (bar.complete.length === 0 || (!allComplete && now < t + AGENT_POLICY.incompleteBarWaitMs)) return;
    // Only the submission is reserved; the flow read gets what is left, up to its own timeout. A flow that does not
    // come in time only drops that index's option block (and the gate then blocks its entries), never the bar.
    if (!this.has(b, AGENT_RPC_MS.submitBar + 500)) return;
    const flowMs = Math.min(AGENT_RPC_MS.flowAsOf, b.deadlineMs - this.now() - AGENT_RPC_MS.submitBar - 300);
    const flows = await this.flowsAt(bar.complete, t, flowMs);
    const events = await this.o.mainRepo.events.active(t - cfg.events.staleAfterHours * HOUR_MS);
    const fallback = initialBook(prevRisk && prevRisk.t <= t ? prevRisk : null, startEquity, istMidnight(istDate(t)));
    const input = buildReflexInput({
      barCloseMs: t,
      indices: cfg.indices,
      complete: bar.complete,
      market: snap,
      calendar: cal,
      cfg,
      events,
      perf: report.perf ?? [],
      flows,
      book: bookAsOf(hot.books, t, fallback),
      nowMs: now,
    });
    if (!this.has(b, AGENT_RPC_MS.submitBar)) return;
    // Read again just before the send: a pause or mode off that came in during this pass sends no bar (the AgentDO's
    // own pause is only a backstop), and a bar that the flow read and the input took past its age limit is skipped, as
    // one found too old at the start is: its decisions could never be executed.
    if (hot.paused || this.mode === "off") return;
    if (this.now() - t > AGENT_POLICY.maxDecisionAgeMs) {
      hot.lastSubmittedBarMs = t;
      this.o.logger.warn("agent bar skipped: not submitted in time", { bar: hhmm(t), complete: bar.complete });
      return;
    }
    const res = await within(() => this.o.agentDo.submitBar(input), AGENT_RPC_MS.submitBar);
    if ("error" in res) {
      this.o.logger.warn("agent bar not submitted (retried while fresh)", { bar: hhmm(t), error: res.error });
      return;
    }
    hot.lastSubmittedBarMs = t;
    if (!res.value.accepted) {
      // No batch comes from a copy the AgentDO refused, so the gate keeps none of it.
      this.o.logger.info("agent bar not accepted", { bar: hhmm(t), reason: res.value.reason });
      return;
    }
    // The gate reads the copy the model judges: a bar the AgentDO already had (an earlier send timed out here but
    // reached it) comes back as a duplicate with the snapshots it stored. Without them the gate gets none.
    const snapshots = res.value.reason === "duplicate" ? (res.value.snapshots ?? {}) : input.snapshots;
    hot.inputs = [...hot.inputs.filter((x) => x.barCloseMs !== t), { barCloseMs: t, snapshots }].slice(-INPUTS_KEPT);
  }

  /** The option flow as of the bar close for each index, in parallel; null for an index whose feed did not answer within `ms`. */
  private async flowsAt(indices: readonly IndexId[], t: number, ms: number = AGENT_RPC_MS.flowAsOf): Promise<Partial<Record<IndexId, OptionFlowView | null>>> {
    const out: Partial<Record<IndexId, OptionFlowView | null>> = {};
    await Promise.all(
      indices.map(async (index) => {
        const r = await within(() => this.o.feed.getOptionFlowAsOf(index, t), ms);
        out[index] = "error" in r ? null : r.value;
      }),
    );
    return out;
  }

  /** Today's closed agent trades as the AgentDO stores them, with their finalist, decision and decision-exit reason. */
  private async todayTrades(nowMs: number): Promise<AgentTradeRecord[]> {
    const hot = this.hot!;
    const { repo, cfg } = this.o.account;
    const rows = await repo.trades.between(istMidnight(istDate(nowMs)), nowMs, "PAPER");
    return rows.map((t) => {
      const tag = hot.tagged[t.positionId];
      const lot = cfg.indexSpecs[t.index]?.lotSize ?? 0;
      return {
        positionId: t.positionId,
        date: istDate(t.exitMs),
        index: t.index,
        side: t.side,
        finalistId: tag?.finalistId ?? null,
        decisionId: tag?.decisionId ?? null,
        tradingSymbol: t.tradingSymbol,
        entryMs: t.entryMs,
        exitMs: t.exitMs,
        lots: lot > 0 ? Math.round(t.qty / lot) : t.qty,
        pnlRupees: t.pnl,
        pnlPctPremium: t.pnlPctPremium,
        exitReason: t.exitReason,
        // Decision exits are sent with the reason SIGNAL_FLIP; the agent's own reason is kept beside it.
        agentExit: t.exitReason === "SIGNAL_FLIP" ? (tag?.agentExit ?? null) : null,
      };
    });
  }

  // -------------------------------------------------------------------------
  // End of day, kill switch, re-arm, pause, status
  // -------------------------------------------------------------------------

  /**
   * After TE's end of day closed the leftovers: sends every trade of the day again (the AgentDO keeps one per
   * position, so this is idempotent) with the final risk, and returns the summary line.
   */
  async afterEndOfDay(): Promise<string> {
    try {
      const now = this.now();
      const hot = await this.loadHot(now);
      const { repo } = this.o.account;
      const main = await this.o.mainRepo.settings.get();
      const { risk } = await this.riskNow(main.killSwitch, now);
      hot.peakEquity = risk.peakEquity;
      hot.lastRisk = risk;
      const today = await this.todayTrades(now);
      this.collectTrades(today);
      const trades = mergeTrades(today, hot.unsentTrades);
      const delivered = await this.deliver({ barCloseMs: this.o.calendar.closeMs(hot.date), t: now, decisions: [], exits: [], trades, risk }, { deadlineMs: now + 2 * AGENT_RPC_MS.recordExecution * (hot.outbox.length + 1) });
      await this.saveHot();
      const l = await repo.ledger.get(hot.date, "PAPER");
      const net = l ? l.realized + l.unrealized - l.charges : 0;
      return (
        `${this.o.account.spec.shortLabel} (paper experiment, ${this.mode}): ` +
        (l ? `net ₹${net.toFixed(0)}, trades ${l.trades} (${l.wins}W/${l.losses}L)` : "no trades") +
        `, equity ₹${risk.equity.toFixed(0)}, drawdown ${risk.ddPct.toFixed(1)}%${hot.ddHalt ? " (halted: re-arm on the Agent page)" : ""}` +
        (delivered ? "" : `; ${hot.unsentTrades.length} trade record${hot.unsentTrades.length === 1 ? "" : "s"} wait for the AgentDO`)
      );
    } catch (err) {
      this.o.logger.error("agent end of day record failed", { error: message(err) });
      return `${this.o.account.spec.shortLabel}: end-of-day record failed: ${message(err)}`;
    }
  }

  /**
   * The agent account's kill switch: the target "agent", or the agent's line of "all". A reset is refused while the
   * drawdown halt holds (only a re-arm clears it) and, for the agent alone, while main's kill switch is on (it would
   * engage the agent's again at the next tick). An engage that squares off runs the agent's own code exits at once;
   * it never runs a TE tick. For "all" it does neither: TE runs one tick once every account's switch is set.
   */
  async setKill(req: { engaged: boolean; squareOff: boolean; reason: string }, actor: string, opts: { all?: boolean; calendar?: TradingCalendar } = {}): Promise<AgentResult> {
    const now = this.now();
    const hot = await this.loadHot(now);
    const { repo, spec } = this.o.account;
    if (!req.engaged) {
      if (hot.ddHalt) return { ok: false, message: `${spec.shortLabel}: stopped at its ${AGENT_LIMITS.maxDrawdownPct}% drawdown limit; use Re-arm on the Agent page` };
      if (!opts.all && (await this.o.mainRepo.settings.get()).killSwitch) {
        return { ok: false, message: `${spec.shortLabel}: main's kill switch is on and would engage the agent's again; reset main first` };
      }
      await repo.settings.update({ killSwitch: false, killReason: null }, actor);
      await repo.audit.append({ ts: now, actor, action: "kill_reset", detail: { reason: req.reason } });
      await this.alert(`✅ kill switch reset by ${actor}`);
      return { ok: true, message: `${spec.shortLabel} kill switch reset` };
    }
    const reason = (req.reason || "manual").slice(0, 300);
    await repo.settings.update({ killSwitch: true, killReason: reason }, actor);
    await repo.audit.append({ ts: now, actor, action: "kill", detail: { reason, squareOff: req.squareOff } });
    await this.alert(`🛑 KILL SWITCH by ${actor}: ${reason}${req.squareOff ? " (squaring off)" : ""}`);
    if (req.squareOff && !opts.all) {
      await this.idle(AGENT_STEP.maxMs + 3_000);
      await this.exclusive("kill exits", () => this.codeExits(this.deps(opts.calendar)));
    }
    return { ok: true, message: `${spec.shortLabel} kill switch engaged` };
  }

  /**
   * The Agent page's Re-arm: clears the drawdown halt and the kill switch. After a halt the peak equity restarts at
   * the current equity; clearing a kill switch alone keeps measuring the drawdown from the old peak.
   */
  async rearm(actor: string): Promise<AgentResult> {
    try {
      return await this.locked("re-arm", () => this.rearmNow(actor));
    } catch (err) {
      return { ok: false, message: `${this.o.account.spec.shortLabel}: not re-armed: ${message(err).slice(0, 200)}` };
    }
  }

  private async rearmNow(actor: string): Promise<AgentResult> {
    const now = this.now();
    const hot = await this.loadHot(now);
    const { repo, spec } = this.o.account;
    const main = await this.o.mainRepo.settings.get();
    if (main.killSwitch) return { ok: false, message: `${spec.shortLabel}: main's kill switch is on and would engage the agent's again; reset main first` };
    const settings = await repo.settings.get();
    const rs = await loadRiskState(repo, this.o.account.cfg, settings, now, "PAPER");
    const equity = riskSnapshotFrom(rs, null, { killSwitch: false, killReason: null, mainKillSwitch: false, ddHalt: false, nowMs: now }).equity;
    const wasHalted = hot.ddHalt;
    hot.ddHalt = false;
    if (wasHalted) hot.peakEquity = equity;
    await this.saveHot();
    await repo.settings.update({ killSwitch: false, killReason: null }, actor);
    // The risk from now on (no halt, no kill switch): kept as the latest and sent to the AgentDO at once, so the
    // Agent page drops the halt without waiting for the next step (none comes after the close, or while paused).
    const fresh = riskSnapshotFrom(rs, hot.peakEquity, { killSwitch: false, killReason: null, mainKillSwitch: main.killSwitch, ddHalt: false, nowMs: now });
    const peak = fresh.peakEquity;
    hot.peakEquity = peak;
    hot.lastRisk = fresh;
    await this.saveHot();
    await repo.audit.append({ ts: now, actor, action: "agent_rearm", detail: { equity, peakEquity: peak, wasHalted, killReason: settings.killReason } });
    if (wasHalted) await this.alert(`✅ re-armed by ${actor}: kill switch off, drawdown now measured from ₹${equity.toFixed(0)}`);
    else await this.alert(`✅ kill switch cleared by ${actor}; drawdown still measured from ₹${peak.toFixed(0)}`);
    // Best effort: a failure is logged, and the next step's risk row corrects it.
    if (!(await this.send({ barCloseMs: hot.lastExecutedBarMs, t: now, decisions: [], exits: [], trades: [], risk: fresh }))) {
      this.o.logger.warn("agent re-arm: the new risk did not reach the AgentDO; the next step's risk row corrects it");
    }
    await this.saveHot();
    return wasHalted
      ? { ok: true, message: `${spec.shortLabel} re-armed: kill switch off; peak equity restarts at ₹${equity.toFixed(0)}` }
      : { ok: true, message: `${spec.shortLabel} re-armed: kill switch off; drawdown still measured from ₹${peak.toFixed(0)}` };
  }

  /** /ops/agent-pause: while paused only the code exits (and the kill-switch and drawdown checks behind them) run. */
  async setPaused(on: boolean, actor: string): Promise<AgentResult> {
    const now = this.now();
    const hot = await this.loadHot(now);
    hot.paused = on;
    await this.saveHot();
    await this.o.account.repo.audit.append({ ts: now, actor, action: on ? "agent_pause" : "agent_resume" });
    await this.alert(on ? `⏸ paused by ${actor}: only its code exits run; no candle is judged` : `▶ resumed by ${actor}`);
    return { ok: true, message: on ? "agent paused: only its code exits run" : "agent resumed" };
  }

  /** Lines for Telegram /status. Never throws. */
  async statusLines(): Promise<string[]> {
    try {
      const now = this.now();
      const hot = await this.loadHot(now);
      const { repo, spec } = this.o.account;
      const [s, open, l] = await Promise.all([repo.settings.get(), repo.positions.open("PAPER"), repo.ledger.get(hot.date, "PAPER")]);
      const net = l ? l.realized + l.unrealized - l.charges : 0;
      const bar = (ms: number) => (ms > istMidnight(hot.date) ? hhmm(ms) : "none");
      return [
        `${spec.shortLabel} (paper experiment): mode ${this.mode}${hot.paused ? " · PAUSED" : ""} · kill switch ${s.killSwitch ? `ON (${s.killReason ?? ""})` : "off"}${hot.ddHalt ? " · drawdown halt (re-arm on the Agent page)" : ""}`,
        `  bars: last submitted ${bar(hot.lastSubmittedBarMs)}, last executed ${bar(hot.lastExecutedBarMs)} · open ${open.length} · today net ₹${net.toFixed(0)} · errors ${this.errors}${hot.outbox.length + hot.unsentTrades.length > 0 ? ` · waiting for the AgentDO: ${hot.outbox.length} records, ${hot.unsentTrades.length} trades` : ""}`,
        ...open.map((p) => `  ${spec.shortLabel} ${p.contract.tradingSymbol} x${p.qty} @ ${p.avgEntry.toFixed(2)} mark ${p.markPremium.toFixed(2)}`),
      ];
    } catch (err) {
      return [`${this.o.account.spec.shortLabel}: status unavailable (${message(err).slice(0, 120)})`];
    }
  }
}
