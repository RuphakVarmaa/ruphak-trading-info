/**
 * TradingEngineDO: the only writer of decisions, orders and positions (singleton "engine").
 *
 * Alarm loop: every 30 s in market hours (60 s when DEGRADED) it runs the shared trading cycle
 * (features -> conviction -> gates -> plan -> entry) in the current entry mode, then position
 * cycles for every mode with open positions, polling exits twice more while positioned.
 * Off hours it refreshes a market snapshot hourly and sleeps until 09:00 IST.
 *
 * Live orders need three keys here (LIVE_TRADING var, settings.mode LIVE, an unexpired arm)
 * plus RELAY_LIVE on the relay; otherwise every order is simulated by the PaperBroker.
 */
import { DurableObject } from "cloudflare:workers";
import { parseAccountId } from "../../../../src/engine/accounts";
import type { TradingCalendar } from "../../../../src/engine/calendar/calendar";
import { MINUTE_MS, istAt, istDate, istIso, systemClock } from "../../../../src/engine/clock";
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
import { computeFeatures } from "../../../../src/engine/market/features";
import { YahooMarketDataSource } from "../../../../src/engine/market/yahooMarketData";
import { runFollowerEntries } from "../../../../src/engine/pipeline/accountCycle";
import { runEndOfDay } from "../../../../src/engine/pipeline/dayLifecycle";
import { applyExitFills, persistResult } from "../../../../src/engine/pipeline/execution";
import { recordSourceHealth } from "../../../../src/engine/pipeline/ingestCycle";
import { MarketContextStore } from "../../../../src/engine/pipeline/marketContext";
import { runPositionCycle, type PositionReport } from "../../../../src/engine/pipeline/positionCycle";
import { quoteRows, runTradingCycle, type CycleReport } from "../../../../src/engine/pipeline/tradingCycle";
import { SyntheticOptionQuotes } from "../../../../src/engine/pricing/syntheticOptionPricer";
import { randomId, type Broker, type EngineDeps, type OptionQuoteSource } from "../../../../src/engine/ports";
import { entryMode } from "../../../../src/engine/settings";
import type { EngineMode, EnginePhase, EngineSettings, Fill, Heartbeat, IndexId, MarketFeatures, Order, Position, TradingMode } from "../../../../src/engine/types";
import { makeRefId } from "../../../../src/engine/util/refId";
import { CachedInstruments } from "../instruments";
import { accountRuntime, enabledAccounts, errorMessage, growwDataClient, makeRuntime, relayClient, type AccountRuntime, type Runtime } from "../runtime";
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
}

const FOLLOWER_ALERT_AFTER_ERRORS = 5;

export class TradingEngineDO extends DurableObject<Env> {
  private readonly rt: Runtime;
  private readonly marketContext = new MarketContextStore();
  private readonly tokens: GrowwTokenManager | null;
  private readonly data: GrowwDataClient | null;
  private readonly growwQuotes: GrowwOptionQuotes | null;
  private readonly relay: RelayClient | null;
  private readonly market: YahooMarketDataSource;
  private readonly instruments: CachedInstruments;
  private readonly alerts: Alerts;
  private hot: HotState = { ...INITIAL_HOT };
  private relayHealth: { at: number; value: RelayHealth } | null = null;
  private ticking: Promise<number> | null = null;
  private entryModeNow: BookMode = "PAPER";
  /** Set inside a tick when the next tick must follow immediately (kill switch engaged mid-tick). */
  private tickSoon = false;
  private readonly followers: Follower[];

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
    this.relay = relayClient(env);
    const data = this.data;
    this.market = new YahooMarketDataSource({
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
    this.instruments = new CachedInstruments({
      env,
      cfg,
      calendar,
      marketContext: this.marketContext,
      logger,
      allowSynthetic: () => this.entryModeNow === "PAPER",
    });
    this.alerts = new Alerts(env, repo.state, logger);
    this.followers = enabledAccounts(env)
      .filter((id) => id !== "main")
      .map((id) => {
        const a = accountRuntime(this.rt, id);
        // Its alert dedupe keys live under the account's prefix (the scoped repo's state).
        return { ...a, alerts: new Alerts(env, a.repo.state, logger), errors: 0 };
      });
    void ctx.blockConcurrencyWhile(async () => {
      this.hot = { ...INITIAL_HOT, ...((await ctx.storage.get<HotState>("hot")) ?? {}) };
    });
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

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
      optionQuotes = this.growwQuotes
        ? new FallbackOptionQuotes(this.growwQuotes, synthetic, (err) => logger.warn("groww quote failed; synthetic quote used for paper", { error: errorMessage(err) }))
        : synthetic;
      broker = new PaperBroker({ cfg, clock: systemClock, repo, quotes: optionQuotes, marketContext: (i) => this.marketContext.get(i), newId: randomId, mode: "PAPER" });
    }
    return { cfg, clock: systemClock, calendar, repo, broker, market: this.market, optionQuotes, instruments: this.instruments, logger, newId: randomId, mode, marketContext: this.marketContext };
  }

  /** Paper deps for a follower: its own config, book and broker; main's market data, quotes and calendar. */
  private followerDeps(f: Follower, calendar: TradingCalendar = this.rt.calendar): EngineDeps {
    const { logger } = this.rt;
    const synthetic = new SyntheticOptionQuotes(calendar, f.cfg);
    const optionQuotes: OptionQuoteSource = this.growwQuotes
      ? new FallbackOptionQuotes(this.growwQuotes, synthetic, (err) => logger.warn("groww quote failed; synthetic quote used for paper", { error: errorMessage(err) }))
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
        await f.alerts.send(
          `📝 ${f.spec.shortLabel} ENTRY ${d?.plan?.contract.tradingSymbol ?? e.planId} x${d?.plan?.qty ?? "?"} @ ~₹${d?.plan?.limitPrice ?? d?.plan?.refPremium ?? "?"} (${e.status})`,
        );
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
        await f.alerts.send(`📝 ${f.spec.shortLabel} EXIT ${pos?.contract.tradingSymbol ?? x.positionId} ${x.reason} (${x.status})${pnl !== null ? ` net ₹${pnl.toFixed(0)}` : ""}`);
      }
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
        }
        return next;
      })().finally(() => {
        this.ticking = null;
      });
    }
    return this.ticking;
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

    const report = await runTradingCycle(this.deps(mode), { noEntries, decisionEveryMs: 5 * MINUTE_MS });
    if (report.snapshot) {
      const age = report.snapshot.dataAgeSec;
      await recordSourceHealth(repo, "yahoo", age < 600, now, age < 600 ? undefined : `market data ${Math.round(age)} s old`);
    }
    if (report.errors.length >= cfg.indices.length) throw new Error(`trading cycle failed: ${report.errors.join("; ")}`);
    for (const e of report.entries) {
      const d = report.decisions.find((x) => x.plan?.id === e.planId);
      await this.alerts.send(
        `${mode === "LIVE" ? "🔴 LIVE" : "📝 PAPER"} ENTRY ${d?.plan?.contract.tradingSymbol ?? e.planId} x${d?.plan?.qty ?? "?"} @ ~₹${d?.plan?.limitPrice ?? d?.plan?.refPremium ?? "?"} (${e.status}) conviction ${d?.conviction.score.toFixed(2) ?? "?"}`,
      );
    }
    if (report.halted) await this.alerts.send(`⏸ Entries halted: ${report.halted}`, { key: `halt:${istDate(now)}:${report.halted.slice(0, 40)}`, minIntervalMs: 6 * 60 * MINUTE_MS });

    // Follower accounts act on the same signals; only main being degraded stops their entries
    // (relay health is a LIVE concern and they are paper-only).
    for (const f of this.followers) await this.followerEntries(f, report, cal, degraded ? "engine DEGRADED after repeated errors: exits only" : null);

    // Exits for every book with exposure (PAPER always; LIVE whenever it holds anything).
    let counts = await this.openCounts();
    const books = (): BookMode[] => {
      const out: BookMode[] = [];
      if (counts.PAPER > 0) out.push("PAPER");
      if (counts.LIVE > 0 && this.liveAvailable) out.push("LIVE");
      return out;
    };
    const followersOpen = async () => (await Promise.all(this.followers.map((f) => this.followerOpen(f)))).reduce((a, b) => a + b, 0);
    for (const book of books()) await this.positionCycle(book, report);
    for (const f of this.followers) await this.followerPositions(f, report, cal);
    counts = await this.openCounts();
    for (const wait of EXIT_POLLS_MS) {
      if (books().length === 0 && (await followersOpen()) === 0) break;
      await new Promise((r) => setTimeout(r, wait));
      for (const book of books()) await this.positionCycle(book, report);
      for (const f of this.followers) await this.followerPositions(f, report, cal);
      counts = await this.openCounts();
    }

    if (this.liveAvailable && (counts.LIVE > 0 || mode === "LIVE") && now - this.hot.lastReconcileMs >= RECONCILE_EVERY_MS) {
      await this.reconcile();
    }
    logger.info("tick", { phase, mode, decisions: report.decisions.length, entries: report.entries.length, halted: report.halted, open: counts });
    return now + (degraded ? DEGRADED_LOOP_MS : LOOP_MS);
  }

  private async positionCycle(book: BookMode, report: CycleReport): Promise<PositionReport> {
    const pr = await runPositionCycle(this.deps(book), { convictions: report.convictions });
    for (const x of pr.exits) {
      const pos = await this.rt.repo.positions.get(x.positionId);
      const pnl = pos && pos.status === "CLOSED" ? (pos.realized ?? 0) - pos.entryCharges - (pos.exitCharges ?? 0) : null;
      await this.alerts.send(
        `${book === "LIVE" ? "🔴 LIVE" : "📝 PAPER"} EXIT ${pos?.contract.tradingSymbol ?? x.positionId} ${x.reason} (${x.status})${pnl !== null ? ` net ₹${pnl.toFixed(0)}` : ""}`,
      );
    }
    for (const e of pr.errors) this.rt.logger.warn("position cycle error", { book, error: e });
    return pr;
  }

  private async offHoursSnapshot(now: number): Promise<void> {
    const { repo, cfg, calendar } = this.rt;
    try {
      const snap = await this.market.snapshot(now);
      const features: Partial<Record<IndexId, MarketFeatures>> = {};
      for (const index of cfg.indices) features[index] = computeFeatures(index, snap, calendar, cfg);
      await repo.snapshots.append({ t: now, quotes: quoteRows(snap), features, regimes: {}, pressure: {} });
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

  /** 08:00 IST: mint the day's Groww token (tokens expire at 06:00). */
  async refreshToken(): Promise<AdminResult> {
    if (!this.tokens) return { ok: false, message: "Groww credentials not configured (paper trading uses synthetic quotes)" };
    try {
      const t = await this.tokens.refresh();
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
    await this.alerts.send(`📊 ${istDate(now)} summary\n${lines.join("\n")}`);
    return { ok: true, message: lines.join(" | ") };
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
   */
  private async engageKill(reason: string, actor: string, squareOff: boolean, inTick = false): Promise<void> {
    const { repo } = this.rt;
    const now = Date.now();
    await repo.settings.update({ killSwitch: true, killReason: reason.slice(0, 300), armedUntil: null }, actor);
    await repo.audit.append({ ts: now, actor, action: "kill", detail: { reason, squareOff } });
    await this.alerts.send(`🛑 KILL SWITCH by ${actor}: ${reason}${squareOff ? " (squaring off)" : ""}`);
    if (!squareOff) return;
    if (inTick) this.tickSoon = true;
    else {
      if (this.ticking) await this.ticking;
      await this.runTick();
    }
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
   * Kill switch for main (default), one follower account, or "all". A follower's kill switch only
   * stops that account; its position cycles treat it as a halt and exit at market.
   */
  async setKillSwitch(req: { engaged: boolean; squareOff: boolean; reason: string }, actor: string, account?: string): Promise<AdminResult> {
    const target = account === "all" ? "all" : parseAccountId(account);
    if (target === null) return { ok: false, message: `unknown account ${String(account).slice(0, 40)}` };
    const followers = target === "all" ? this.followers : this.followers.filter((f) => f.spec.id === target);
    if (target !== "all" && target !== "main" && followers.length === 0) return { ok: false, message: `account ${target} is not enabled` };
    const messages: string[] = [];
    for (const f of followers) {
      await f.repo.settings.update(req.engaged ? { killSwitch: true, killReason: (req.reason || "manual").slice(0, 300) } : { killSwitch: false, killReason: null }, actor);
      await f.repo.audit.append({ ts: Date.now(), actor, action: req.engaged ? "kill" : "kill_reset", detail: { reason: req.reason, squareOff: req.squareOff } });
      await f.alerts.send(req.engaged ? `🛑 ${f.spec.shortLabel} KILL SWITCH by ${actor}: ${req.reason || "manual"}` : `✅ ${f.spec.shortLabel} kill switch reset by ${actor}`);
      messages.push(`${f.spec.shortLabel} kill switch ${req.engaged ? "engaged" : "reset"}`);
    }
    if (target !== "all" && target !== "main") {
      if (req.engaged && req.squareOff) {
        if (this.ticking) await this.ticking;
        await this.runTick();
      }
      return { ok: true, message: messages.join("; ") };
    }
    const res = await this.setMainKillSwitch(req, actor);
    return { ok: res.ok, message: [res.message, ...messages].join("; ") };
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
    ];
    for (const f of this.followers) {
      const [fs, open, l] = await Promise.all([f.repo.settings.get(), f.repo.positions.open("PAPER"), f.repo.ledger.get(istDate(now), "PAPER")]);
      const net = l ? l.realized + l.unrealized - l.charges : 0;
      lines.push(`${f.spec.shortLabel}: kill switch ${fs.killSwitch ? "ON" : "off"} · open ${open.length} · today net ₹${net.toFixed(0)}`);
      for (const p of open) lines.push(`  ${f.spec.shortLabel} ${p.contract.tradingSymbol} x${p.qty} @ ${p.avgEntry.toFixed(2)} mark ${p.markPremium.toFixed(2)}`);
    }
    return lines.join("\n");
  }
}
