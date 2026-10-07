/**
 * In-memory EngineApi used when the engine Worker binding is missing or ENGINE_MOCK=1.
 * It is "alive": quotes jitter, conviction drifts, the open position marks to market,
 * exits fire (stop / target / trail / square-off), and admin actions mutate state.
 *
 * Clock: by default the mock runs a simulated session clock that starts at 11:42 IST on
 * the latest trading day and advances in real time, so the fixture story (RBI at 10:00,
 * position opened 11:05) is coherent whenever you run it. ENGINE_MOCK_CLOCK=real uses
 * the wall clock instead. Every timestamp the mock returns uses its own clock, and
 * state.market.nowIst tells the dashboard which "now" that is.
 */
import type {
  BacktestParams,
  BacktestResult,
  ChargesView,
  DailyPnlView,
  EngineApi,
  EngineMode,
  EngineStateDTO,
  EventClusterDetail,
  EventClusterView,
  EventContribution,
  EventsQuery,
  FillView,
  GateResult,
  IndexId,
  IndexQuote,
  KillSwitchRequest,
  OrderReason,
  OrderView,
  PnlResponse,
  PositionView,
  ScheduledEventView,
  SignalPerformanceRow,
  SignalView,
  SourceHealthView,
  SourceName,
} from "@/engine/api-types";
import {
  HOUR_MS,
  istAt,
  istDate,
  istParts,
  MINUTE_MS,
  nextSessionClose,
  nextSessionOpen,
  SESSION,
  sessionPhaseAt,
  toIstIso,
  tradingDayOnOrBefore,
} from "@/lib/ist";
import {
  addCharges,
  buildSeed,
  emptyCharges,
  isMockHoliday,
  MOCK_HOLIDAYS,
  optionCharges,
  ROUND_TRIP_CHARGES,
  type MockSeed,
  type PositionSeed,
  type QuoteSeed,
  type SignalSeed,
} from "./fixtures";
import { simulateBacktest } from "./mockBacktest";
import { clamp, hashString, round2 } from "./random";

export interface MockConfig {
  adminToken: string | null;
  fail: boolean;
}

export type MockClockMode = "sim" | "real";

const SIM_START = "11:42:00";
const DAILY_LOSS_CAP = 15_000;
const MAX_POSITIONS = 1;
const MAX_ORDERS_PER_DAY = 8;
const MAX_TRADES_PER_DAY = 4;

const fmtSigned = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
const tick05 = (n: number) => Math.max(0.05, Math.round(n * 20) / 20);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function scaleCharges(c: ChargesView, k: number): ChargesView {
  return {
    brokerage: round2(c.brokerage * k),
    stt: round2(c.stt * k),
    exchange: round2(c.exchange * k),
    gst: round2(c.gst * k),
    sebi: round2(c.sebi * k),
    stamp: round2(c.stamp * k),
    total: round2(c.total * k),
  };
}

interface BacktestRun {
  params: BacktestParams;
  startedAt: number;
  polls: number;
  result: BacktestResult | null;
}

export class MockEngineApi implements EngineApi {
  private cfg: MockConfig = { adminToken: null, fail: false };
  private readonly simOffset: number;
  private readonly seed: MockSeed;
  private mode: EngineMode = "PAPER";
  private armedUntil: number | null = null;
  private killSwitch = false;
  private killReason: string | null = null;
  private positions: PositionSeed[];
  private orders: OrderView[];
  private fills: FillView[];
  private realizedToday: number;
  private chargesToday: ChargesView;
  private tradesToday: number;
  private quoteDev: Record<string, number> = {};
  private convDev: Record<IndexId, number> = { NIFTY: 0, SENSEX: 0 };
  private lastJitter = 0;
  private seq = 0;
  private backtests = new Map<string, BacktestRun>();

  constructor(clockMode: MockClockMode = "sim") {
    const real = Date.now();
    const anchor = tradingDayOnOrBefore(istDate(real), isMockHoliday);
    const t0 = clockMode === "real" ? real : istAt(anchor, SIM_START);
    this.simOffset = t0 - real;
    this.seed = buildSeed(anchor, t0);
    this.positions = clone(this.seed.positions);
    this.orders = clone(this.seed.orders);
    this.fills = clone(this.seed.fills);
    this.realizedToday = this.seed.realizedToday;
    this.chargesToday = clone(this.seed.chargesToday);
    this.tradesToday = this.seed.tradesToday;
  }

  configure(cfg: MockConfig): void {
    this.cfg = cfg;
  }

  // -------------------------------------------------------------------------
  // Clock, jitter, lifecycle
  // -------------------------------------------------------------------------

  private now(): number {
    return Date.now() + this.simOffset;
  }

  /** Common entry for reads: optional simulated outage, then advance the simulation. */
  private read(): number {
    if (this.cfg.fail) throw new Error("ENGINE_MOCK_FAIL: simulated engine outage");
    return this.advance();
  }

  private advance(): number {
    const now = this.now();
    if (now - this.lastJitter >= 1000) {
      this.lastJitter = now;
      for (const q of this.seed.quotes) {
        const dev = this.quoteDev[q.key] ?? 0;
        this.quoteDev[q.key] = clamp(0.7 * dev + (Math.random() - 0.5) * 0.0006, -0.0005, 0.0005);
      }
      for (const index of ["NIFTY", "SENSEX"] as IndexId[]) {
        this.convDev[index] = clamp(0.8 * this.convDev[index] + (Math.random() - 0.5) * 0.02, -0.03, 0.03);
      }
    }
    if (this.armedUntil != null && now >= this.armedUntil) this.armedUntil = null;
    for (const pos of [...this.positions]) {
      const ltp = this.mark(pos, now);
      pos.peak = Math.max(pos.peak, ltp);
      const trail = this.trailPrice(pos);
      let reason: OrderReason | null = null;
      if (now >= pos.squareOffAt) reason = "SQUARE_OFF";
      else if (ltp <= this.stopPrice(pos)) reason = "STOP";
      else if (ltp >= this.targetPrice(pos)) reason = "TARGET";
      else if (trail != null && ltp <= trail) reason = "TRAIL";
      else if (now >= pos.timeStopAt && (ltp / pos.avgPrice - 1) * 100 < 10) reason = "TIME_STOP";
      if (reason) this.closePosition(pos, reason, now);
    }
    return now;
  }

  private quote(q: QuoteSeed): number {
    const dev = this.quoteDev[q.key] ?? 0;
    const factor = 10 ** q.decimals;
    return Math.round(q.base * (1 + dev) * factor) / factor;
  }

  private quoteSeed(key: string): QuoteSeed {
    const q = this.seed.quotes.find((x) => x.key === key);
    if (!q) throw new Error(`Unknown quote ${key}`);
    return q;
  }

  private spot(index: IndexId): number {
    return this.quote(this.quoteSeed(index));
  }

  /** Option mark: entry premium + delta x spot move - theta decay, on a 0.05 tick. */
  private mark(pos: PositionSeed, now: number): number {
    const minutes = Math.max(0, (now - pos.openedAt) / MINUTE_MS);
    return tick05(pos.avgPrice + pos.delta * (this.spot(pos.index) - pos.entrySpot) - pos.thetaPerMin * minutes);
  }

  private stopPrice(pos: PositionSeed): number {
    return round2(pos.avgPrice * (1 + pos.stopPct / 100));
  }

  private targetPrice(pos: PositionSeed): number {
    return round2(pos.avgPrice * (1 + pos.targetPct / 100));
  }

  private trailPrice(pos: PositionSeed): number | null {
    if (pos.peak < pos.avgPrice * (1 + pos.trailActivatePct / 100)) return null;
    return round2(pos.avgPrice + (pos.peak - pos.avgPrice) * (1 - pos.trailGivebackPct / 100));
  }

  private closePosition(pos: PositionSeed, reason: OrderReason, now: number): void {
    const price = tick05(this.mark(pos, now) - 0.1);
    const charges = optionCharges("SELL", price, pos.qty, pos.index);
    const id = `ord-${istParts(now).hour}${String(istParts(now).minute).padStart(2, "0")}-${++this.seq}`;
    this.orders.unshift({
      id,
      placedAt: toIstIso(now),
      mode: this.positionMode(),
      contractLabel: pos.contract.label,
      tradingSymbol: pos.contract.tradingSymbol,
      side: "SELL",
      qty: pos.qty,
      orderType: "MARKET",
      limitPrice: null,
      status: "FILLED",
      reason,
      filledQty: pos.qty,
      avgFillPrice: price,
      planId: pos.planId,
      error: null,
    });
    this.fills.push({ id: `fil-${this.seq}`, orderId: id, at: toIstIso(now + 1000), price, qty: pos.qty, charges: charges.total });
    this.realizedToday = round2(this.realizedToday + (price - pos.avgPrice) * pos.qty);
    this.chargesToday = addCharges(this.chargesToday, charges);
    this.tradesToday += 1;
    this.positions = this.positions.filter((p) => p.id !== pos.id);
  }

  private positionMode(): "PAPER" | "LIVE" {
    // LIVE_TRADING is false in the mock, so every order stays simulated.
    return "PAPER";
  }

  // -------------------------------------------------------------------------
  // Read model builders
  // -------------------------------------------------------------------------

  private unrealized(now: number): number {
    return round2(this.positions.reduce((s, p) => s + (this.mark(p, now) - p.avgPrice) * p.qty, 0));
  }

  private todayPnl(now: number): DailyPnlView {
    const unrealized = this.unrealized(now);
    const last = this.seed.history[this.seed.history.length - 1];
    const net = round2(this.realizedToday + unrealized - this.chargesToday.total);
    return {
      date: this.seed.anchorDate,
      realized: this.realizedToday,
      unrealized,
      charges: this.chargesToday.total,
      net,
      trades: this.tradesToday,
      equityEnd: round2((last?.equityEnd ?? this.seed.startingEquity) + net),
    };
  }

  private quotes(now: number): IndexQuote[] {
    return this.seed.quotes.map((q) => {
      const price = this.quote(q);
      const change = price - q.prevClose;
      const [lo, hi] = q.lagSec;
      const lag = lo + ((hashString(`${q.key}:${Math.floor(now / 5000)}`) % 1000) / 1000) * (hi - lo);
      return {
        key: q.key,
        label: q.label,
        price,
        change: Math.round(change * 10 ** q.decimals) / 10 ** q.decimals,
        changePct: round2((change / q.prevClose) * 100),
        asOf: toIstIso(now - lag * 1000),
        stale: lag > 180,
      };
    });
  }

  private health(now: number): Partial<Record<SourceName, SourceHealthView>> {
    const ago = (ms: number) => toIstIso(now - ms);
    const h: Partial<Record<SourceName, SourceHealthView>> = {
      yahoo: { ok: true, lastOkAt: ago(40_000), detail: "Chart v8, 5m bars (≈1–2 min delayed)" },
      groww: { ok: true, lastOkAt: ago(5_000), detail: "LTP polling 1/s · token valid until 06:00" },
      gnews: { ok: true, lastOkAt: ago(3 * MINUTE_MS), detail: "62/100 requests used today" },
      rss: { ok: true, lastOkAt: ago(4 * MINUTE_MS) },
      gdelt: { ok: false, lastOkAt: ago(14 * MINUTE_MS), detail: "HTTP 429 from shared egress; backing off 5 min" },
      claude: { ok: true, lastOkAt: ago(6 * MINUTE_MS), detail: "claude-opus-5-5 · cache hits 91%" },
    };
    if (this.mode === "LIVE") h.relay = { ok: false, lastOkAt: null, detail: "Order relay not configured" };
    return h;
  }

  private stateDto(now: number): EngineStateDTO {
    const phase = sessionPhaseAt(now, isMockHoliday);
    const date = istDate(now);
    const today = this.todayPnl(now);
    const open = istAt(date, SESSION.open);
    const close = istAt(date, SESSION.close);
    const decisions = phase === "OPEN" || now >= close ? Math.floor((Math.min(now, close) - open) / 30_000) * 2 : 0;
    return {
      dataSource: "mock",
      mode: this.mode,
      liveTradingEnabled: false,
      armed: this.armedUntil != null,
      armedUntil: this.armedUntil == null ? null : toIstIso(this.armedUntil),
      killSwitch: this.killSwitch,
      killReason: this.killReason,
      caps: {
        dailyLossCap: DAILY_LOSS_CAP,
        dailyLossUsed: Math.max(0, round2(-today.net)),
        maxPositions: MAX_POSITIONS,
        openPositions: this.positions.length,
        maxOrdersPerDay: MAX_ORDERS_PER_DAY,
        ordersToday: this.orders.length,
      },
      heartbeat: {
        lastTickAt: toIstIso(now - 7000),
        phase: this.killSwitch
          ? "KILLED"
          : phase === "OPEN"
            ? "OPEN"
            : phase === "PRE_OPEN"
              ? "PREMARKET"
              : phase === "HOLIDAY"
                ? "IDLE"
                : "CLOSED",
        loopIntervalSec: 30,
        consecutiveErrors: 0,
        version: "mock-2026.10.07",
        lastError: null,
      },
      health: this.health(now),
      market: {
        phase,
        nowIst: toIstIso(now),
        nextOpenAt: toIstIso(nextSessionOpen(now, isMockHoliday)),
        nextCloseAt: toIstIso(nextSessionClose(now, isMockHoliday)),
        isHoliday: phase === "HOLIDAY",
        holidayName: MOCK_HOLIDAYS[date] ?? null,
      },
      quotes: this.quotes(now),
      stats: {
        clustersScoredToday: this.seed.stats.clustersScoredToday,
        signalsToday: Math.max(0, decisions),
        llmInputTokensToday: this.seed.stats.llmInputTokensToday,
        llmOutputTokensToday: this.seed.stats.llmOutputTokensToday,
      },
    };
  }

  private positionView(pos: PositionSeed, now: number): PositionView {
    const ltp = this.mark(pos, now);
    return {
      id: pos.id,
      index: pos.index,
      contract: pos.contract,
      mode: "PAPER",
      qty: pos.qty,
      avgPrice: pos.avgPrice,
      ltp,
      ltpAsOf: toIstIso(now - 3000),
      pnl: round2((ltp - pos.avgPrice) * pos.qty),
      pnlPct: round2((ltp / pos.avgPrice - 1) * 100),
      stopPrice: this.stopPrice(pos),
      targetPrice: this.targetPrice(pos),
      trailPrice: this.trailPrice(pos),
      timeStopAt: toIstIso(pos.timeStopAt),
      squareOffAt: toIstIso(pos.squareOffAt),
      openedAt: toIstIso(pos.openedAt),
      planId: pos.planId,
      dominantSource: pos.dominantSource,
    };
  }

  private decay(e: EventClusterDetail, now: number): number {
    if (e.impacts.length === 0) return 1;
    const hl = Math.max(...e.impacts.map((i) => i.halfLifeHours));
    const ageH = Math.max(0, (now - Date.parse(e.firstSeenAt)) / HOUR_MS);
    return Math.round(clamp(2 ** (-ageH / hl), 0, 1) * 1000) / 1000;
  }

  private eventView(e: EventClusterDetail, now: number): EventClusterView {
    return {
      clusterId: e.clusterId,
      title: e.title,
      summary: e.summary,
      taxonomy: e.taxonomy,
      tab: e.tab,
      severity: e.severity,
      scorer: e.scorer,
      firstSeenAt: e.firstSeenAt,
      lastSeenAt: e.lastSeenAt,
      articleCount: e.articleCount,
      sources: e.sources,
      impacts: e.impacts,
      sectors: e.sectors,
      pricedIn: e.pricedIn,
      decayRemaining: this.decay(e, now),
      topUrl: e.topUrl,
      isScheduledData: e.isScheduledData,
    };
  }

  private gates(seed: SignalSeed, conviction: number, now: number): GateResult[] {
    const minutes = istParts(now).minutesOfDay;
    const inWindow = sessionPhaseAt(now, isMockHoliday) === "OPEN" && minutes >= 9 * 60 + 25 && minutes < 14 * 60 + 30;
    const age = Math.round((now - Date.parse(this.quotes(now).find((q) => q.key === seed.index)?.asOf ?? "")) / 1000);
    const holding = this.positions.some((p) => p.index === seed.index);
    return seed.gates.map((g): GateResult => {
      switch (g.gate) {
        case "SESSION":
          return { ...g, passed: inWindow, detail: inWindow ? "09:25–14:30 IST" : "Outside 09:25–14:30 IST" };
        case "DATA_AGE":
          return { ...g, passed: age <= 180, detail: `Spot ${Number.isFinite(age) ? age : "?"} s old (max 180 s)` };
        case "KILL_SWITCH":
          return { ...g, passed: !this.killSwitch, detail: this.killSwitch ? `Engaged: ${this.killReason ?? "manual"}` : "Not engaged" };
        case "CONVICTION": {
          const pass = Math.abs(conviction) >= seed.threshold;
          return { ...g, passed: pass, detail: `${fmtSigned(conviction)} ${pass ? "≥" : "<"} ${seed.threshold.toFixed(2)} (${seed.regime})` };
        }
        case "EXPOSURE": {
          const used = this.positions.length;
          if (holding) return { ...g, passed: true, detail: `${used}/${MAX_POSITIONS} position (this plan) · ${this.tradesToday + used}/${MAX_TRADES_PER_DAY} trades today` };
          const pass = used < MAX_POSITIONS;
          const other = this.positions[0]?.index;
          return { ...g, passed: pass, detail: pass ? `${used}/${MAX_POSITIONS} positions · ${this.tradesToday}/${MAX_TRADES_PER_DAY} trades today` : `${used}/${MAX_POSITIONS} position slots used (${other})` };
        }
        default:
          return { ...g };
      }
    });
  }

  private contributions(seed: SignalSeed, now: number): EventContribution[] {
    const out: EventContribution[] = [];
    for (const c of seed.contributors) {
      const e = this.seed.events.find((x) => x.clusterId === c.clusterId);
      const impact = e?.impacts.find((i) => i.index === seed.index);
      if (!e || !impact) continue;
      out.push({
        ...impact,
        clusterId: e.clusterId,
        title: e.title,
        taxonomy: e.taxonomy,
        weight: c.weight,
        ageMin: Math.max(0, Math.round((now - Date.parse(e.firstSeenAt)) / MINUTE_MS)),
        pricedIn: e.pricedIn,
      });
    }
    return out;
  }

  private signalView(seed: SignalSeed, now: number): SignalView {
    const conviction = round2(seed.baseConviction + this.convDev[seed.index]);
    const gates = this.gates(seed, conviction, now);
    const pos = this.positions.find((p) => p.index === seed.index) ?? null;
    const plannedContract =
      seed.index === "NIFTY" ? (pos?.contract ?? this.seed.positions.find((p) => p.index === "NIFTY")?.contract ?? null) : null;
    const allGatesPassed = gates.every((g) => g.passed !== false);
    let noPlanReason: string | null = null;
    if (this.killSwitch) noPlanReason = "Kill switch engaged: no new entries";
    else if (Math.abs(conviction) < seed.threshold)
      noPlanReason = `Below threshold: conviction ${fmtSigned(conviction)} < ${seed.threshold.toFixed(2)} (${seed.regime})`;
    else if (!pos) noPlanReason = "Position closed today; 15-minute re-entry cooldown";
    else if (!allGatesPassed) noPlanReason = gates.find((g) => g.passed === false)?.detail ?? "A gate failed";
    const impliedMovePct = seed.impliedMovePct;
    return {
      index: seed.index,
      stance: seed.stance,
      conviction,
      entryThreshold: seed.threshold,
      regime: seed.regime,
      computedAt: toIstIso(now - 7000),
      spot: this.spot(seed.index),
      expectedMovePct: round2(Math.abs(conviction) * impliedMovePct),
      impliedMovePct,
      edgeRatio: seed.index === "NIFTY" ? round2(0.21 + (conviction - seed.baseConviction) * 0.5) : null,
      gates,
      allGatesPassed,
      contract: plannedContract,
      noPlanReason,
      components: seed.components,
      contributors: this.contributions(seed, now),
      rationale: seed.rationale,
      position: pos ? this.positionView(pos, now) : null,
    };
  }

  // -------------------------------------------------------------------------
  // EngineApi: reads
  // -------------------------------------------------------------------------

  async getState(): Promise<EngineStateDTO> {
    const now = this.read();
    return clone(this.stateDto(now));
  }

  async getSignals(): Promise<SignalView[]> {
    const now = this.read();
    return clone(this.seed.signals.map((s) => this.signalView(s, now)));
  }

  async getPositions(): Promise<PositionView[]> {
    const now = this.read();
    return clone(this.positions.map((p) => this.positionView(p, now)));
  }

  async getEvents(q: EventsQuery): Promise<EventClusterView[]> {
    const now = this.read();
    const limit = clamp(Math.floor(q.limit ?? 50), 1, 200);
    const rows = this.seed.events
      .filter((e) => !q.tab || q.tab === "ALL" || e.tab === q.tab)
      .filter((e) => q.sinceMs == null || Date.parse(e.lastSeenAt) > q.sinceMs)
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
      .slice(0, limit)
      .map((e) => this.eventView(e, now));
    return clone(rows);
  }

  async getEventDetail(clusterId: string): Promise<EventClusterDetail | null> {
    const now = this.read();
    const e = this.seed.events.find((x) => x.clusterId === clusterId);
    return e ? clone({ ...e, decayRemaining: this.decay(e, now) }) : null;
  }

  async getOrders(date: string): Promise<{ orders: OrderView[]; fills: FillView[] }> {
    this.read();
    const isToday = date === this.seed.anchorDate || date === istDate(Date.now());
    if (!isToday) return { orders: [], fills: [] };
    const orders = [...this.orders].sort((a, b) => Date.parse(b.placedAt) - Date.parse(a.placedAt));
    const fills = [...this.fills].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return clone({ orders, fills });
  }

  async getPnl(days: number): Promise<PnlResponse> {
    const now = this.read();
    const n = clamp(Math.floor(days), 1, this.seed.history.length);
    const history = this.seed.history.slice(-n);
    const today = this.todayPnl(now);
    const first = history[0];
    const startingEquity = round2(first.equityEnd - first.net);
    const windowTrades = history.reduce((s, d) => s + d.trades, 0);
    const equityCurve = [
      { t: toIstIso(istAt(first.date, "09:15")), equity: startingEquity },
      ...history.map((d) => ({ t: toIstIso(istAt(d.date, "15:30")), equity: d.equityEnd })),
      { t: toIstIso(now), equity: today.equityEnd },
    ];
    return clone({
      mode: "PAPER",
      startingEquity,
      today,
      history,
      equityCurve,
      charges: addCharges(scaleCharges(ROUND_TRIP_CHARGES, windowTrades), this.chargesToday ?? emptyCharges()),
    });
  }

  async getPerformance(): Promise<SignalPerformanceRow[]> {
    this.read();
    return clone(this.seed.performance);
  }

  async getScheduled(hours: number): Promise<ScheduledEventView[]> {
    const now = this.read();
    const from = now - 15 * MINUTE_MS;
    const to = now + hours * HOUR_MS;
    return clone(
      this.seed.scheduled
        .filter((s) => {
          const at = Date.parse(s.at);
          return at >= from && at <= to;
        })
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    );
  }

  async getBacktest(runId: string): Promise<BacktestResult | null> {
    this.read();
    const run = this.backtests.get(runId);
    if (!run) return null;
    run.polls += 1;
    if (run.polls <= 2 && !run.result) {
      return {
        runId,
        status: "RUNNING",
        params: clone(run.params),
        startedAt: toIstIso(run.startedAt),
        finishedAt: null,
        progress: round2(run.polls / 3),
        error: null,
        summary: null,
        equityCurve: [],
        trades: [],
        attribution: [],
        notes: [],
      };
    }
    run.result ??= simulateBacktest(runId, run.params, run.startedAt, this.now());
    return clone(run.result);
  }

  // -------------------------------------------------------------------------
  // EngineApi: admin (token re-checked here, as the real engine does)
  // -------------------------------------------------------------------------

  private tokenOk(token: string): boolean {
    const expected = this.cfg.adminToken;
    return expected != null && expected.length > 0 && token === expected;
  }

  private assertToken(token: string): void {
    if (!this.tokenOk(token)) throw new Error("UNAUTHORIZED: invalid admin token");
  }

  async verifyAdmin(token: string): Promise<boolean> {
    return this.tokenOk(token);
  }

  async setArmed(token: string, armed: boolean, actor: string): Promise<EngineStateDTO> {
    void actor;
    this.assertToken(token);
    const now = this.advance();
    if (armed && this.killSwitch) throw new Error("CONFLICT: kill switch is engaged; reset it before arming");
    this.armedUntil = armed ? nextSessionClose(now, isMockHoliday) : null;
    return clone(this.stateDto(now));
  }

  async setKillSwitch(token: string, req: KillSwitchRequest, actor: string): Promise<EngineStateDTO> {
    this.assertToken(token);
    const now = this.advance();
    if (req.engaged) {
      this.killSwitch = true;
      this.killReason = req.reason.trim() || `Manual kill by ${actor}`;
      this.armedUntil = null;
      if (req.squareOff) for (const pos of [...this.positions]) this.closePosition(pos, "KILL_SWITCH", now);
    } else {
      this.killSwitch = false;
      this.killReason = null;
    }
    return clone(this.stateDto(now));
  }

  async setMode(token: string, mode: EngineMode, actor: string): Promise<EngineStateDTO> {
    void actor;
    this.assertToken(token);
    const now = this.advance();
    if (mode !== this.mode) {
      this.mode = mode;
      this.armedUntil = null;
    }
    return clone(this.stateDto(now));
  }

  async startBacktest(token: string, params: BacktestParams, actor: string): Promise<{ runId: string; status: "RUNNING" | "DONE" }> {
    void actor;
    this.assertToken(token);
    const runId = `bt-${hashString(`${JSON.stringify(params)}:${++this.seq}:${Date.now()}`).toString(36)}`;
    this.backtests.set(runId, { params: clone(params), startedAt: this.now(), polls: 0, result: null });
    if (this.backtests.size > 50) {
      const oldest = this.backtests.keys().next().value;
      if (oldest) this.backtests.delete(oldest);
    }
    return { runId, status: "RUNNING" };
  }
}

// ---------------------------------------------------------------------------
// Singleton (kept on globalThis so route handlers, pages and HMR share one instance)
// ---------------------------------------------------------------------------

type GlobalWithMock = typeof globalThis & { __ruphakMockEngine?: MockEngineApi };

export function getMockEngine(cfg: MockConfig, clockMode: MockClockMode = "sim"): MockEngineApi {
  const g = globalThis as GlobalWithMock;
  const engine = (g.__ruphakMockEngine ??= new MockEngineApi(clockMode));
  engine.configure(cfg);
  return engine;
}
