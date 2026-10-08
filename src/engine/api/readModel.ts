/**
 * Read model: turns repository state into the dashboard DTOs of api-types.ts.
 * Pure apart from repository reads, so it runs inside the engine Worker's EngineAdmin entrypoint
 * and in tests against the in-memory repository.
 */
import {
  SIGNAL_SOURCE_LABELS,
  contractLabel,
  taxonomyTab,
  type AccountView,
  type ChargesView,
  type CopyTicketView,
  type DailyPnlView,
  type EngineStateDTO,
  type EventClusterDetail,
  type EventClusterView,
  type EventContribution,
  type EventsQuery,
  type FillView,
  type ImpactView,
  type IndexQuote,
  type OrderView,
  type PnlResponse,
  type PositionView,
  type ScheduledEventView,
  type Severity,
  type SignalPerformanceRow,
  type SignalView,
  type SourceHealthView,
  type SuggestedContract,
} from "../api-types";
import type { TradingCalendar } from "../calendar/calendar";
import { DAY_MS, HOUR_MS, MINUTE_MS, addDays, istAt, istDate, istIso, istMidnight } from "../clock";
import type { EngineConfig } from "../config";
import { copyTicketView } from "../copy/copyTicket";
import { classifySeverity } from "../events/lexicon";
import { CONFIDENCE_VALUE, MAGNITUDE_MIDPOINT_PCT, MAGNITUDE_VALUE } from "../events/taxonomy";
import type { Repository } from "../ports";
import { displayMode } from "../settings";
import { stopPrice, targetPrice, trailPrice } from "../strategy/exits";
import {
  INDEX_IDS,
  type ArticleCluster,
  type ChargeBreakdown,
  type DayLedger,
  type Direction,
  type EngineSettings,
  type EventPressure,
  type IndexId,
  type IndicatorView,
  type OptionContract,
  type PlanDecision,
  type Position,
  type ScoredEvent,
  type SourceHealth,
  type SourceName,
  type TradingMode,
} from "../types";

export interface ReadContext {
  repo: Repository;
  cfg: EngineConfig;
  calendar: TradingCalendar;
  now: number;
  /** Worker var LIVE_TRADING. */
  liveTradingEnabled: boolean;
  version?: string;
  loopIntervalSec?: number;
  /** The account `repo` is scoped to (main when absent). */
  account?: AccountView;
  /** Every account the engine runs, for the dashboard's switcher. */
  accounts?: AccountView[];
}

/** Daily LLM usage counters kept in repo.state under `llm:usage:<IST date>`. */
export interface LlmUsageDay {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  calls: number;
  clustersScored: number;
}

export const llmUsageKey = (date: string) => `llm:usage:${date}`;

const SOURCE_NAMES: SourceName[] = ["yahoo", "gdelt", "gnews", "rss", "claude", "groww", "relay"];
/** repo.state health keys written by different modules, mapped to dashboard source names. */
const HEALTH_KEYS: Record<SourceName, string[]> = {
  yahoo: ["health:yahoo"],
  gdelt: ["health:gdelt"],
  gnews: ["health:gnews"],
  rss: ["health:publisher_rss", "health:bing_rss", "health:google_rss", "health:rss"],
  claude: ["health:claude", "health:llm"],
  groww: ["health:groww"],
  relay: ["health:relay"],
};

const round2 = (x: number) => Math.round(x * 100) / 100;
const dirNum = (d: Direction): -1 | 0 | 1 => (d === "BULL" || d === "STRONG_BULL" ? 1 : d === "BEAR" || d === "STRONG_BEAR" ? -1 : 0);

function calendarFor(ctx: ReadContext, s: EngineSettings): TradingCalendar {
  return s.holidayOverrides.length > 0 ? ctx.calendar.withOverrides(s.holidayOverrides) : ctx.calendar;
}

function zeroLedger(date: string, mode: TradingMode, equity: number, now: number): DayLedger {
  return {
    date,
    mode,
    realized: 0,
    unrealized: 0,
    charges: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    consecutiveLosses: 0,
    ordersPlaced: 0,
    maxIntradayDrawdown: 0,
    peakEquity: equity,
    startEquity: equity,
    updatedMs: now,
  };
}

const netOf = (l: DayLedger) => l.realized + l.unrealized - l.charges;

// ---------------------------------------------------------------------------
// Contracts and positions
// ---------------------------------------------------------------------------

export function suggestedContract(c: OptionContract, lots: number, premium: number | null, premiumAtRisk: number | null): SuggestedContract {
  return {
    index: c.index,
    expiry: c.expiry,
    strike: c.strike,
    optionType: c.type,
    tradingSymbol: c.tradingSymbol,
    lotSize: c.lotSize,
    lots,
    premium: premium === null ? null : round2(premium),
    premiumAtRisk: premiumAtRisk === null ? null : Math.round(premiumAtRisk),
    label: contractLabel({ index: c.index, expiry: c.expiry, strike: c.strike, optionType: c.type }),
  };
}

export function positionView(p: Position): PositionView {
  const lots = p.contract.lotSize > 0 ? Math.round(p.qty / p.contract.lotSize) : 0;
  const cost = p.avgEntry * p.qty;
  const pnl = p.unrealized - p.entryCharges;
  const trail = trailPrice(p);
  return {
    id: p.id,
    index: p.index,
    contract: suggestedContract(p.contract, lots, p.avgEntry, p.avgEntry * p.qty * Math.abs(p.stops.stopPct / 100)),
    mode: p.mode,
    qty: p.qty,
    avgPrice: round2(p.avgEntry),
    ltp: p.markPremium > 0 ? round2(p.markPremium) : null,
    ltpAsOf: p.markMs > 0 ? istIso(p.markMs) : null,
    pnl: round2(pnl),
    pnlPct: cost > 0 ? round2((pnl / cost) * 100) : 0,
    stopPrice: round2(stopPrice(p)),
    targetPrice: round2(targetPrice(p)),
    trailPrice: trail === null ? null : round2(trail),
    timeStopAt: istIso(p.stops.timeStopMs),
    squareOffAt: istIso(p.stops.squareOffMs),
    openedAt: istIso(p.entryMs),
    planId: p.planId,
    dominantSource: p.dominantSource,
  };
}

async function openPositions(repo: Repository): Promise<Position[]> {
  const [paper, live] = await Promise.all([repo.positions.open("PAPER"), repo.positions.open("LIVE")]);
  return [...live, ...paper].sort((a, b) => a.entryMs - b.entryMs);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function impactViews(e: ScoredEvent): ImpactView[] {
  return INDEX_IDS.map((index) => ({
    index,
    direction: dirNum(e.impact[index].direction),
    score: Math.round(e.numeric[index] * 1000) / 1000,
    magnitudePct: MAGNITUDE_MIDPOINT_PCT[e.impact[index].magnitude],
    confidence: CONFIDENCE_VALUE[e.impact[index].confidence],
    halfLifeHours: e.halfLifeHours,
  }));
}

function severityOf(e: ScoredEvent | undefined, title: string): Severity {
  if (!e) return classifySeverity(title);
  const m = Math.max(...INDEX_IDS.map((i) => MAGNITUDE_VALUE[e.impact[i].magnitude]));
  return m >= 0.75 ? "FLASH" : m >= 0.5 ? "ALERT" : "UPDATE";
}

export function eventView(c: ArticleCluster, e: ScoredEvent | undefined, now: number): EventClusterView {
  const title = e?.title || c.representativeTitle;
  const taxonomy = e?.taxonomy ?? "OTHER";
  const isScheduledData = e?.isScheduledData ?? false;
  const ageH = Math.max(0, (now - c.firstSeenMs) / HOUR_MS);
  return {
    clusterId: c.id,
    title,
    summary: e?.rationale ?? "",
    taxonomy,
    tab: taxonomyTab(taxonomy, isScheduledData),
    severity: severityOf(e, title),
    scorer: e?.scorer ?? "pending",
    firstSeenAt: istIso(c.firstSeenMs),
    lastSeenAt: istIso(c.lastSeenMs),
    articleCount: c.articleCount,
    sources: c.sources.slice(0, 8),
    impacts: e ? impactViews(e) : [],
    sectors: (e?.sectors ?? []).map((s) => ({ sector: s.sector, direction: dirNum(s.direction), weight: s.weight })),
    pricedIn: e?.pricedIn === "MOSTLY",
    decayRemaining: e ? Math.round(Math.min(1, 2 ** (-ageH / Math.max(0.25, e.halfLifeHours))) * 1000) / 1000 : 1,
    topUrl: c.urls[0] ?? null,
    isScheduledData,
  };
}

// ---------------------------------------------------------------------------
// The read model
// ---------------------------------------------------------------------------

export class ReadModel {
  constructor(private readonly ctx: ReadContext) {}

  private get now() {
    return this.ctx.now;
  }

  async health(): Promise<Partial<Record<SourceName, SourceHealthView>>> {
    const out: Partial<Record<SourceName, SourceHealthView>> = {};
    for (const name of SOURCE_NAMES) {
      let best: SourceHealth | null = null;
      for (const key of HEALTH_KEYS[name]) {
        const h = await this.ctx.repo.state.get<SourceHealth>(key);
        if (h && (!best || (h.lastOkMs ?? 0) > (best.lastOkMs ?? 0))) best = h;
      }
      if (best) out[name] = { ok: best.ok, lastOkAt: best.lastOkMs ? istIso(best.lastOkMs) : null, ...(best.detail ? { detail: best.detail } : {}) };
    }
    return out;
  }

  async getState(): Promise<EngineStateDTO> {
    const { repo, cfg } = this.ctx;
    const now = this.now;
    const settings = await repo.settings.get();
    const cal = calendarFor(this.ctx, settings);
    const mode = displayMode(settings, this.ctx.liveTradingEnabled);
    const today = istDate(now);
    const [ledger, positions, hb, snap, usage, decisions, health] = await Promise.all([
      repo.ledger.get(today, mode),
      repo.positions.open(mode),
      repo.heartbeat.read(),
      repo.snapshots.latest(),
      repo.state.get<LlmUsageDay>(llmUsageKey(today)),
      repo.decisions.between(istMidnight(today), now),
      this.health(),
    ]);
    const l = ledger ?? zeroLedger(today, mode, cfg.capitalRupees, now);
    const phase = cal.sessionPhase(now);
    const quoteStaleMs = phase === "OPEN" ? 10 * MINUTE_MS : 3 * DAY_MS;
    const quotes: IndexQuote[] = (snap?.quotes ?? []).map((q) => ({
      key: q.key,
      label: q.label,
      price: q.price,
      change: q.change,
      changePct: q.changePct,
      asOf: istIso(q.asOf),
      stale: now - q.asOf > quoteStaleMs,
    }));
    const armed = settings.armedUntil !== null && settings.armedUntil > now && !settings.killSwitch;
    // The heartbeat is engine-wide; its KILLED phase is main's kill switch, so other accounts show their own.
    const hbPhase = this.ctx.account && this.ctx.account.id !== "main" && hb?.phase === "KILLED" ? (phase === "OPEN" ? "OPEN" : "CLOSED") : hb?.phase;
    return {
      dataSource: "engine",
      mode: settings.mode,
      liveTradingEnabled: this.ctx.liveTradingEnabled && !this.ctx.account?.paperOnly,
      armed,
      armedUntil: settings.armedUntil !== null && settings.armedUntil > now ? istIso(settings.armedUntil) : null,
      killSwitch: settings.killSwitch,
      killReason: settings.killReason,
      caps: {
        dailyLossCap: settings.dailyLossCapInr,
        dailyLossUsed: Math.max(0, Math.round(-netOf(l))),
        maxPositions: settings.maxOpenPositions,
        openPositions: positions.length,
        maxOrdersPerDay: settings.maxOrdersPerDay,
        ordersToday: l.ordersPlaced,
      },
      heartbeat: {
        lastTickAt: hb?.lastTickMs ? istIso(hb.lastTickMs) : null,
        phase: settings.killSwitch ? "KILLED" : (hbPhase ?? "IDLE"),
        loopIntervalSec: this.ctx.loopIntervalSec ?? 30,
        consecutiveErrors: hb?.consecutiveErrors ?? 0,
        version: hb?.version ?? this.ctx.version ?? null,
        lastError: hb?.lastError ?? null,
      },
      health,
      market: {
        phase,
        nowIst: istIso(now),
        nextOpenAt: istIso(cal.nextOpenMs(now)),
        nextCloseAt: istIso(cal.nextCloseMs(now)),
        isHoliday: phase === "HOLIDAY",
        holidayName: cal.holidayName(today),
      },
      quotes,
      stats: {
        clustersScoredToday: usage?.clustersScored ?? 0,
        signalsToday: decisions.length,
        llmInputTokensToday: usage?.inputTokens ?? 0,
        llmOutputTokensToday: usage?.outputTokens ?? 0,
      },
      ...(this.ctx.account ? { account: this.ctx.account } : {}),
      ...(this.ctx.accounts ? { accounts: this.ctx.accounts } : {}),
    };
  }

  private async contributors(index: IndexId, p: EventPressure | null): Promise<EventContribution[]> {
    if (!p || p.topContributors.length === 0) return [];
    const events = await this.ctx.repo.events.byClusterIds(p.topContributors.map((c) => c.clusterId));
    const byId = new Map(events.map((e) => [e.clusterId, e]));
    const total = p.topContributors.reduce((s, c) => s + Math.abs(c.contribution), 0) || 1;
    const out: EventContribution[] = [];
    for (const c of p.topContributors) {
      const e = byId.get(c.clusterId);
      if (!e) continue;
      const imp = e.impact[index];
      out.push({
        index,
        direction: dirNum(imp.direction),
        score: Math.round(e.numeric[index] * 1000) / 1000,
        magnitudePct: MAGNITUDE_MIDPOINT_PCT[imp.magnitude],
        confidence: CONFIDENCE_VALUE[imp.confidence],
        halfLifeHours: e.halfLifeHours,
        clusterId: e.clusterId,
        title: e.title || c.title,
        taxonomy: e.taxonomy,
        weight: Math.round((c.contribution / total) * 1000) / 1000,
        ageMin: Math.round(Math.max(0, (this.now - e.firstSeenMs) / MINUTE_MS)),
        pricedIn: e.pricedIn === "MOSTLY",
      });
    }
    return out;
  }

  private rationale(index: IndexId, d: PlanDecision, contributors: EventContribution[]): string {
    const c = d.conviction;
    const parts: string[] = [];
    const stance = c.stance === "NEUTRAL" ? "No directional edge" : `${c.stance === "BULLISH" ? "Bullish" : "Bearish"} ${index}`;
    parts.push(`${stance} (conviction ${c.score >= 0 ? "+" : ""}${c.score.toFixed(2)} vs threshold ${c.threshold.toFixed(2)}, regime ${c.regime.replace("_", " ").toLowerCase()}).`);
    const top = contributors[0];
    if (top) parts.push(`Top event: ${top.title} (${top.score >= 0 ? "+" : ""}${top.score.toFixed(2)}, ${top.ageMin} min old).`);
    const lead = [...c.components].filter((x) => x.enabled && !x.abstain && x.source !== "EVENT").sort((a, b) => Math.abs(b.weight * b.value) - Math.abs(a.weight * a.value))[0];
    if (lead && Math.abs(lead.value) > 0.05) parts.push(`${SIGNAL_SOURCE_LABELS[lead.source]} ${lead.value >= 0 ? "+" : ""}${lead.value.toFixed(2)}.`);
    if (c.note) parts.push(`No score: ${c.note}.`);
    const failed = d.gates.filter((g) => g.passed === false);
    if (d.plan) parts.push(`All gates passed: plan ${d.plan.lots} lot(s) of ${d.plan.contract.tradingSymbol}.`);
    else if (failed.length > 0) parts.push(`Blocked by ${failed.map((g) => `${g.label} (${g.detail})`).slice(0, 2).join("; ")}.`);
    else if (d.noPlanReason) parts.push(d.noPlanReason);
    return parts.join(" ");
  }

  async getSignals(): Promise<SignalView[]> {
    const { repo, cfg } = this.ctx;
    const snap = await repo.snapshots.latest();
    const positions = await openPositions(repo);
    const out: SignalView[] = [];
    for (const index of cfg.indices) {
      const [d, p] = await Promise.all([repo.decisions.latest(index), repo.pressure.latest(index)]);
      if (!d) continue;
      const contributors = await this.contributors(index, p);
      const plan = d.plan;
      const contract = plan
        ? suggestedContract(plan.contract, plan.lots, plan.refPremium, plan.riskRupees)
        : d.contract
          ? suggestedContract(d.contract, 0, d.refPremium, null)
          : null;
      const pos = positions.find((x) => x.index === index) ?? null;
      out.push({
        index,
        stance: d.conviction.stance,
        conviction: Math.round(d.conviction.score * 1000) / 1000,
        entryThreshold: d.conviction.threshold,
        regime: d.conviction.regime,
        computedAt: istIso(d.t),
        spot: snap?.features[index]?.spot ?? plan?.refSpot ?? null,
        expectedMovePct: d.expectedMovePct,
        impliedMovePct: d.impliedMovePct,
        edgeRatio: d.edgeRatio,
        minEdgeRatio: cfg.gates.minEdgeRatio,
        gates: d.gates,
        allGatesPassed: d.gates.every((g) => g.passed !== false),
        contract,
        noPlanReason: d.noPlanReason,
        components: d.conviction.components.map((c) => ({
          source: c.source,
          value: c.value,
          weight: c.weight,
          enabled: c.enabled,
          ...(c.notes ? { notes: c.notes } : {}),
          ...(c.abstain ? { abstain: true } : {}),
        })),
        contributors,
        rationale: this.rationale(index, d, contributors),
        position: pos ? positionView(pos) : null,
        indicators: d.indicators ?? null,
      });
    }
    return out;
  }

  async getPositions(): Promise<PositionView[]> {
    return (await openPositions(this.ctx.repo)).map(positionView);
  }

  async getEvents(q: EventsQuery): Promise<EventClusterView[]> {
    const since = q.sinceMs ?? this.now - 48 * HOUR_MS;
    const limit = Math.max(1, Math.min(200, q.limit ?? 50));
    const clusters = (await this.ctx.repo.clusters.active(since)).filter((c) => c.status !== "STALE");
    const events = await this.ctx.repo.events.byClusterIds(clusters.map((c) => c.id));
    const byId = new Map(events.map((e) => [e.clusterId, e]));
    const views = clusters
      .map((c) => eventView(c, byId.get(c.id), this.now))
      .filter((v) => !q.tab || q.tab === "ALL" || v.tab === q.tab)
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
    return views.slice(0, limit);
  }

  async getEventDetail(clusterId: string): Promise<EventClusterDetail | null> {
    const [c] = await this.ctx.repo.clusters.byIds([clusterId]);
    if (!c) return null;
    const [e] = await this.ctx.repo.events.byClusterIds([clusterId]);
    const view = eventView(c, e, this.now);
    return {
      ...view,
      rationale: e?.rationale ?? "Not scored yet.",
      novelty: e?.novelty ?? "NEW",
      surprise: e?.surprise ?? "NA",
      horizon: e?.horizon ?? "DAYS_1_2",
      model: e?.model ?? (e?.scorer === "fallback" ? "lexicon" : null),
      scoredAt: e ? istIso(e.scoredAtMs) : null,
      headlines: c.headlines.slice(0, 30).map((title, i) => ({ title, url: c.urls[i] ?? null })),
    };
  }

  async getOrders(date: string): Promise<{ orders: OrderView[]; fills: FillView[] }> {
    const from = istMidnight(date);
    const to = from + DAY_MS - 1;
    const { repo } = this.ctx;
    // Ask per mode: other accounts' books live in the same tables under their own stored modes.
    const [paper, live, allFills] = await Promise.all([repo.orders.between(from, to, "PAPER"), repo.orders.between(from, to, "LIVE"), repo.fills.between(from, to)]);
    const orders = [...paper, ...live];
    const ids = new Set(orders.map((o) => o.id));
    const fills = allFills.filter((f) => ids.has(f.orderId));
    return {
      orders: orders
        .sort((a, b) => b.createdMs - a.createdMs)
        .map((o) => ({
          id: o.id,
          placedAt: istIso(o.createdMs),
          mode: o.mode,
          contractLabel: contractLabel({ index: o.contract.index, expiry: o.contract.expiry, strike: o.contract.strike, optionType: o.contract.type }),
          tradingSymbol: o.contract.tradingSymbol,
          side: o.side,
          qty: o.qty,
          orderType: o.type,
          limitPrice: o.limitPrice ?? null,
          status: o.status,
          reason: o.reason,
          filledQty: o.filledQty,
          avgFillPrice: o.avgFillPrice ?? null,
          planId: o.planId ?? null,
          error: o.error ?? null,
        })),
      fills: fills
        .sort((a, b) => b.t - a.t)
        .map((f) => ({ id: f.id, orderId: f.orderId, at: istIso(f.t), price: f.price, qty: f.qty, charges: round2(f.charges.total) })),
    };
  }

  /** Trades opened on an IST date as copy tickets: open ones first, then newest first. */
  async getCopyTickets(date: string): Promise<CopyTicketView[]> {
    const { repo, cfg } = this.ctx;
    const from = istMidnight(date);
    const to = from + DAY_MS - 1;
    const lists = await Promise.all([repo.positions.open("PAPER"), repo.positions.open("LIVE"), repo.positions.closedBetween(from, to, "PAPER"), repo.positions.closedBetween(from, to, "LIVE")]);
    const positions = new Map<string, Position>();
    for (const p of lists.flat()) if (p.entryMs >= from && p.entryMs <= to && !positions.has(p.id)) positions.set(p.id, p);
    const account = this.ctx.account ?? { id: "main", label: "Main account", shortLabel: "Main", paperOnly: false, capitalRupees: cfg.capitalRupees };
    const out: CopyTicketView[] = [];
    for (const p of positions.values()) {
      const plan = await repo.plans.get(p.planId);
      // Plans made before they carried their own readings: use main's decision for the same plan.
      let fallbackIndicators: IndicatorView | null = null;
      if (!plan?.indicators) {
        const t = plan?.t ?? p.entryMs;
        fallbackIndicators = (await repo.decisions.between(t - MINUTE_MS, t + MINUTE_MS)).find((d) => d.plan?.id === p.planId)?.indicators ?? null;
      }
      out.push(copyTicketView({ position: p, plan, account, timeStopMinPnlPct: cfg.exits.timeStopMinPnlPct, fallbackIndicators }));
    }
    return out.sort((a, b) => (a.status === b.status ? Date.parse(b.entry.at) - Date.parse(a.entry.at) : a.status === "OPEN" ? -1 : 1));
  }

  async getPnl(days: number): Promise<PnlResponse> {
    const { repo, cfg } = this.ctx;
    const now = this.now;
    const settings = await repo.settings.get();
    const mode = displayMode(settings, this.ctx.liveTradingEnabled);
    const today = istDate(now);
    const span = Math.max(1, Math.min(365, Math.floor(days)));
    const from = addDays(today, -(span - 1));
    const ledgers = (await repo.ledger.range(from, today, mode)).sort((a, b) => a.date.localeCompare(b.date));
    const toView = (l: DayLedger): DailyPnlView => ({
      date: l.date,
      realized: round2(l.realized),
      unrealized: round2(l.unrealized),
      charges: round2(l.charges),
      net: round2(netOf(l)),
      trades: l.trades,
      equityEnd: round2(l.startEquity + netOf(l)),
    });
    const todayLedger = ledgers.find((l) => l.date === today) ?? zeroLedger(today, mode, ledgers.at(-1) ? ledgers.at(-1)!.startEquity + netOf(ledgers.at(-1)!) : cfg.capitalRupees, now);
    const history = ledgers.map(toView);
    const startingEquity = ledgers[0]?.startEquity ?? todayLedger.startEquity;
    const equityCurve = [{ t: istIso(istAt(from, "09:15")), equity: round2(startingEquity) }, ...ledgers.map((l) => ({ t: istIso(istAt(l.date, "15:30")), equity: round2(l.startEquity + netOf(l)) }))];

    // Charge breakdown over the window from this mode's fills.
    const fromMs = istMidnight(from);
    const orders = await repo.orders.between(fromMs, now, mode);
    const ids = new Set(orders.map((o) => o.id));
    const fills = (await repo.fills.between(fromMs, now)).filter((f) => ids.has(f.orderId));
    const sum = (k: keyof ChargeBreakdown) => round2(fills.reduce((s, f) => s + f.charges[k], 0));
    const charges: ChargesView = {
      brokerage: sum("brokerage"),
      stt: sum("stt"),
      exchange: round2(sum("exchangeTxn") + sum("ipft")),
      gst: sum("gst"),
      sebi: sum("sebi"),
      stamp: sum("stampDuty"),
      total: sum("total"),
    };
    return { mode, startingEquity: round2(startingEquity), today: toView(todayLedger), history, equityCurve, charges };
  }

  async getPerformance(): Promise<SignalPerformanceRow[]> {
    const settings = await this.ctx.repo.settings.get();
    const mode = displayMode(settings, this.ctx.liveTradingEnabled);
    const rows = await this.ctx.repo.perf.all(mode);
    return rows
      .map((p) => ({
        source: p.source,
        label: SIGNAL_SOURCE_LABELS[p.source],
        index: p.index,
        trades: p.windowTrades,
        wins: Math.round(p.hitRate * p.windowTrades),
        hitRate: p.hitRate,
        expectancyPct: p.expectancyPct,
        expectancyRupees: p.expectancyRupees,
        avgWinPct: p.avgWinPct,
        avgLossPct: p.avgLossPct,
        profitFactor: p.profitFactor,
        tStat: p.tStat,
        status: p.status,
        weight: p.weight,
        disabledReason: p.disabledReason ?? null,
        lastTradeAt: p.lastTradeMs ? istIso(p.lastTradeMs) : null,
      }))
      .sort((a, b) => a.source.localeCompare(b.source) || String(a.index).localeCompare(String(b.index)));
  }

  async getScheduled(hours: number): Promise<ScheduledEventView[]> {
    const settings = await this.ctx.repo.settings.get();
    const cal = calendarFor(this.ctx, settings);
    const h = Math.max(1, Math.min(24 * 30, hours));
    const g = this.ctx.cfg.gates;
    return cal.scheduledEvents(this.now - 2 * HOUR_MS, this.now + h * HOUR_MS).map((e) => {
      const date = istDate(e.at);
      const inSession = cal.isTradingDay(date) && e.at >= cal.openMs(date) - g.preEventBlackoutMin * MINUTE_MS && e.at <= cal.closeMs(date);
      const blackout = inSession && e.impact !== "LOW" && e.kind !== "EXPIRY";
      return {
        id: e.id,
        title: e.title,
        kind: e.kind,
        at: istIso(e.at),
        impact: e.impact,
        approx: e.approx ?? false,
        blackoutStart: blackout ? istIso(e.at - g.preEventBlackoutMin * MINUTE_MS) : null,
        blackoutEnd: blackout ? istIso(e.at + g.postEventWaitMin * MINUTE_MS) : null,
        indices: e.indices,
      };
    });
  }
}
