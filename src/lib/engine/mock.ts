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
  AccountView,
  BacktestParams,
  BacktestResult,
  ChargesView,
  CopyTicketView,
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
  SuggestedContract,
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
  makeContract,
  ROUND_TRIP_CHARGES,
  type MockSeed,
  type PositionSeed,
  type QuoteSeed,
  type SignalSeed,
} from "./fixtures";
import { copyTicketView } from "@/engine/copy/copyTicket";
import type { Position, TradePlan } from "@/engine/types";
import { simulateBacktest } from "./mockBacktest";
import { clamp, gauss, hashString, mulberry32, round2 } from "./random";

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

// ---------------------------------------------------------------------------
// Paper accounts: main plus two followers that take main's entries with their own capital, one lot of a
// cheaper strike (premium band), wider stops and their own caps. Followers are always paper.
// ---------------------------------------------------------------------------

interface FollowerTrade {
  index: IndexId;
  strike: number;
  type: "CE" | "PE";
  entry: number;
  /** Exit premium for a trade closed today; null while it is open. */
  exit: number | null;
  /** Greeks for the mock's mark (per unit of the index, per minute). */
  delta: number;
  thetaPerMin: number;
  peak: number;
}

interface FollowerSpec {
  account: AccountView;
  /** Order-id prefix, so ids stay unique across books. */
  prefix: string;
  /** Today's PE (stopped out at 10:12) and CE (open since 11:05), mirroring main's two NIFTY trades. */
  pe: FollowerTrade;
  ce: FollowerTrade;
  stopPct: number;
  targetPct: number;
  dailyLossCapPct: number;
  maxTradesPerDay: number;
  /** One closed trade's gross P&L in rupees: mean, spread and the stop / target bounds. */
  perTrade: { mean: number; sd: number; lo: number; hi: number };
}

const FOLLOWERS: FollowerSpec[] = [
  {
    account: { id: "small10k", label: "₹10k account", shortLabel: "₹10k", paperOnly: true, capitalRupees: 10_000 },
    prefix: "s10k-",
    // NIFTY premium band ₹40–70 (one lot of 65 costs ₹2,600–4,550).
    pe: { index: "NIFTY", strike: 22350, type: "PE", entry: 52.35, exit: 33.95, delta: -0.28, thetaPerMin: 0.012, peak: 52.35 },
    ce: { index: "NIFTY", strike: 22800, type: "CE", entry: 58.4, exit: null, delta: 0.3, thetaPerMin: 0.012, peak: 74.65 },
    stopPct: -35,
    targetPct: 60,
    dailyLossCapPct: 25,
    maxTradesPerDay: 3,
    perTrade: { mean: 75, sd: 900, lo: -1300, hi: 2200 },
  },
  {
    account: { id: "small5k", label: "₹5k account", shortLabel: "₹5k", paperOnly: true, capitalRupees: 5_000 },
    prefix: "s5k-",
    // NIFTY premium band ₹20–38 (one lot of 65 costs ₹1,300–2,470).
    pe: { index: "NIFTY", strike: 22300, type: "PE", entry: 31.2, exit: 20.25, delta: -0.2, thetaPerMin: 0.008, peak: 31.2 },
    ce: { index: "NIFTY", strike: 22850, type: "CE", entry: 34.65, exit: null, delta: 0.22, thetaPerMin: 0.008, peak: 44.1 },
    stopPct: -35,
    targetPct: 60,
    dailyLossCapPct: 25,
    maxTradesPerDay: 3,
    perTrade: { mean: 58, sd: 520, lo: -760, hi: 1280 },
  },
];

/** One paper account's book. Main's comes from the fixture seed; a follower's mirrors main's trades. */
interface Book {
  account: AccountView;
  prefix: string;
  positions: PositionSeed[];
  orders: OrderView[];
  fills: FillView[];
  realizedToday: number;
  chargesToday: ChargesView;
  tradesToday: number;
  killSwitch: boolean;
  killReason: string | null;
  /** Closed trading days before the anchor date, oldest first. */
  history: DailyPnlView[];
  performance: SignalPerformanceRow[];
  /** The contract the account would buy on a NIFTY entry now. */
  niftyPlan: SuggestedContract | null;
  dailyLossCap: number;
  maxTradesPerDay: number;
}

function mainBook(seed: MockSeed): Book {
  return {
    account: { id: "main", label: "Main account", shortLabel: "Main", paperOnly: false, capitalRupees: seed.startingEquity },
    prefix: "",
    positions: clone(seed.positions),
    orders: clone(seed.orders),
    fills: clone(seed.fills),
    realizedToday: seed.realizedToday,
    chargesToday: clone(seed.chargesToday),
    tradesToday: seed.tradesToday,
    killSwitch: false,
    killReason: null,
    history: seed.history,
    performance: seed.performance,
    niftyPlan: seed.positions.find((p) => p.index === "NIFTY")?.contract ?? null,
    dailyLossCap: DAILY_LOSS_CAP,
    maxTradesPerDay: MAX_TRADES_PER_DAY,
  };
}

/** A follower's book: main's NIFTY trades of the day at the follower's strikes, one lot each, and its own history. */
function followerBook(seed: MockSeed, f: FollowerSpec): Book {
  const mainOpen = seed.positions.find((p) => p.index === "NIFTY");
  const expiry = mainOpen?.contract.expiry ?? seed.positions[0]?.contract.expiry ?? seed.anchorDate;
  const at = (hhmmss: string) => toIstIso(istAt(seed.anchorDate, hhmmss));
  const lot = 1;
  const pe = makeContract(f.pe.index, expiry, f.pe.strike, f.pe.type, lot, f.pe.entry);
  const ce = makeContract(f.ce.index, expiry, f.ce.strike, f.ce.type, lot, f.ce.entry);
  const qty = pe.lotSize * lot;
  const peBuy = optionCharges("BUY", f.pe.entry, qty, "NIFTY");
  const peSell = optionCharges("SELL", f.pe.exit ?? f.pe.entry, qty, "NIFTY");
  const ceBuy = optionCharges("BUY", f.ce.entry, ce.lotSize * lot, "NIFTY");
  const order = (id: string, placedAt: string, c: SuggestedContract, side: "BUY" | "SELL", type: "LIMIT" | "MARKET", limit: number | null, fill: number, reason: OrderReason, planId: string): OrderView => ({
    id: `${f.prefix}${id}`,
    placedAt: at(placedAt),
    mode: "PAPER",
    contractLabel: c.label,
    tradingSymbol: c.tradingSymbol,
    side,
    qty: c.lotSize * lot,
    orderType: type,
    limitPrice: limit,
    status: "FILLED",
    reason,
    filledQty: c.lotSize * lot,
    avgFillPrice: fill,
    planId,
    error: null,
  });
  const pePlan = `pln-nifty-0931-${f.account.id}`;
  const cePlan = `pln-nifty-1105-${f.account.id}`;
  const orders: OrderView[] = [
    order("ord-0931-entry", "09:31:12", pe, "BUY", "LIMIT", round2(f.pe.entry + 0.05), f.pe.entry, "ENTRY", pePlan),
    order("ord-1012-stop", "10:12:40", pe, "SELL", "MARKET", null, f.pe.exit ?? f.pe.entry, "STOP", pePlan),
    order("ord-1105-entry", "11:05:02", ce, "BUY", "LIMIT", round2(f.ce.entry + 0.05), f.ce.entry, "ENTRY", cePlan),
  ];
  const fills: FillView[] = [
    { id: `${f.prefix}fil-0931`, orderId: orders[0].id, at: at("09:31:13"), price: f.pe.entry, qty, charges: peBuy.total },
    { id: `${f.prefix}fil-1012`, orderId: orders[1].id, at: at("10:12:41"), price: f.pe.exit ?? f.pe.entry, qty, charges: peSell.total },
    { id: `${f.prefix}fil-1105`, orderId: orders[2].id, at: at("11:05:03"), price: f.ce.entry, qty: ce.lotSize * lot, charges: ceBuy.total },
  ];
  const openedAt = istAt(seed.anchorDate, "11:05:02");
  const position: PositionSeed = {
    id: `pos-nifty-1105-${f.account.id}`,
    planId: cePlan,
    index: "NIFTY",
    contract: ce,
    qty: ce.lotSize * lot,
    avgPrice: f.ce.entry,
    entrySpot: mainOpen?.entrySpot ?? 22588,
    delta: f.ce.delta,
    thetaPerMin: f.ce.thetaPerMin,
    openedAt,
    peak: f.ce.peak,
    stopPct: f.stopPct,
    targetPct: f.targetPct,
    trailActivatePct: 30,
    trailGivebackPct: 50,
    timeStopAt: openedAt + 120 * MINUTE_MS,
    squareOffAt: istAt(seed.anchorDate, "15:05"),
    dominantSource: mainOpen?.dominantSource ?? "EVENT",
    entryCharges: ceBuy.total,
  };

  // History: main's trading days, at most three of main's trades a day, sized for one cheap lot.
  const rand = mulberry32(hashString(`history:${seed.anchorDate}:${f.account.id}`));
  const roundTrip = round2(optionCharges("BUY", f.ce.entry, qty, "NIFTY").total + optionCharges("SELL", f.ce.entry * 1.05, qty, "NIFTY").total);
  const capital = f.account.capitalRupees;
  const raw = seed.history.map((d) => {
    const trades = Math.min(d.trades, f.maxTradesPerDay);
    return Array.from({ length: trades }, () => clamp(f.perTrade.mean + f.perTrade.sd * gauss(rand), f.perTrade.lo, f.perTrade.hi));
  });
  // One cheap lot is a big bet for a small account: keep the 60-day path between 80% and 145% of the
  // capital (where its loss caps and premium cap would hold it) by shrinking outcomes towards the mean.
  const path = (k: number): DailyPnlView[] => {
    let equity = capital;
    return seed.history.map((d, i) => {
      const trades = raw[i].length;
      const gross = round2(raw[i].reduce((sum, g) => sum + f.perTrade.mean + k * (g - f.perTrade.mean), 0));
      const charges = round2(roundTrip * trades);
      const net = round2(gross - charges);
      equity = round2(equity + net);
      return { date: d.date, realized: gross, unrealized: 0, charges, net, trades, equityEnd: equity };
    });
  };
  const inBand = (h: DailyPnlView[]) => h.every((d) => d.equityEnd >= 0.8 * capital && d.equityEnd <= 1.45 * capital);
  const history = [1, 0.8, 0.6, 0.45, 0.3, 0.2, 0.1].map(path).find(inBand) ?? path(0);
  // Rupee figures scale with the premium of one lot (main trades a lot of a pricier strike).
  const scale = (f.ce.entry * qty) / Math.max(1, (mainOpen?.avgPrice ?? 140) * (mainOpen?.qty ?? 65));
  const performance = seed.performance.map((r) => ({ ...r, expectancyRupees: round2(r.expectancyRupees * scale) }));

  return {
    account: f.account,
    prefix: f.prefix,
    positions: [position],
    orders,
    fills,
    realizedToday: round2(((f.pe.exit ?? f.pe.entry) - f.pe.entry) * qty),
    chargesToday: addCharges(addCharges(peBuy, peSell), ceBuy),
    tradesToday: 1,
    killSwitch: false,
    killReason: null,
    history,
    performance,
    niftyPlan: ce,
    dailyLossCap: round2((f.account.capitalRupees * f.dailyLossCapPct) / 100),
    maxTradesPerDay: f.maxTradesPerDay,
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
  /** Books by account id: main first, then the followers. */
  private readonly books: Map<string, Book>;
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
    this.books = new Map([["main", mainBook(this.seed)], ...FOLLOWERS.map((f): [string, Book] => [f.account.id, followerBook(this.seed, f)])]);
  }

  /** The book for `account` (main when omitted); unknown accounts are refused, as the engine does. */
  private book(account?: string): Book {
    const b = this.books.get(account ?? "main");
    if (!b) throw new Error(`BAD_REQUEST: This engine runs no account called '${account}'. Accounts: ${[...this.books.keys()].join(", ")}.`);
    return b;
  }

  private get main(): Book {
    return this.book();
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
    for (const book of this.books.values()) {
      for (const pos of [...book.positions]) {
        const ltp = this.mark(pos, now);
        pos.peak = Math.max(pos.peak, ltp);
        const trail = this.trailPrice(pos);
        let reason: OrderReason | null = null;
        if (now >= pos.squareOffAt) reason = "SQUARE_OFF";
        else if (ltp <= this.stopPrice(pos)) reason = "STOP";
        else if (ltp >= this.targetPrice(pos)) reason = "TARGET";
        else if (trail != null && ltp <= trail) reason = "TRAIL";
        else if (now >= pos.timeStopAt && (ltp / pos.avgPrice - 1) * 100 < 10) reason = "TIME_STOP";
        if (reason) this.closePosition(book, pos, reason, now);
      }
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

  private closePosition(book: Book, pos: PositionSeed, reason: OrderReason, now: number): void {
    const price = tick05(this.mark(pos, now) - 0.1);
    const charges = optionCharges("SELL", price, pos.qty, pos.index);
    const id = `${book.prefix}ord-${istParts(now).hour}${String(istParts(now).minute).padStart(2, "0")}-${++this.seq}`;
    book.orders.unshift({
      id,
      placedAt: toIstIso(now),
      mode: book.account.paperOnly ? "PAPER" : this.positionMode(),
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
    book.fills.push({ id: `${book.prefix}fil-${this.seq}`, orderId: id, at: toIstIso(now + 1000), price, qty: pos.qty, charges: charges.total });
    book.realizedToday = round2(book.realizedToday + (price - pos.avgPrice) * pos.qty);
    book.chargesToday = addCharges(book.chargesToday, charges);
    book.tradesToday += 1;
    book.positions = book.positions.filter((p) => p.id !== pos.id);
  }

  private positionMode(): "PAPER" | "LIVE" {
    // LIVE_TRADING is false in the mock, so every order stays simulated.
    return "PAPER";
  }

  // -------------------------------------------------------------------------
  // Read model builders
  // -------------------------------------------------------------------------

  private unrealized(book: Book, now: number): number {
    return round2(book.positions.reduce((s, p) => s + (this.mark(p, now) - p.avgPrice) * p.qty, 0));
  }

  private todayPnl(book: Book, now: number): DailyPnlView {
    const unrealized = this.unrealized(book, now);
    const last = book.history[book.history.length - 1];
    const net = round2(book.realizedToday + unrealized - book.chargesToday.total);
    return {
      date: this.seed.anchorDate,
      realized: book.realizedToday,
      unrealized,
      charges: book.chargesToday.total,
      net,
      trades: book.tradesToday,
      equityEnd: round2((last?.equityEnd ?? book.account.capitalRupees) + net),
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
      claude: { ok: true, lastOkAt: ago(6 * MINUTE_MS), detail: "News scorer · cache hits 91%" },
    };
    if (this.mode === "LIVE") h.relay = { ok: false, lastOkAt: null, detail: "Order relay not configured" };
    return h;
  }

  private stateDto(now: number, book: Book = this.main): EngineStateDTO {
    const phase = sessionPhaseAt(now, isMockHoliday);
    const date = istDate(now);
    const today = this.todayPnl(book, now);
    const follower = book.account.paperOnly;
    const open = istAt(date, SESSION.open);
    const close = istAt(date, SESSION.close);
    const decisions = phase === "OPEN" || now >= close ? Math.floor((Math.min(now, close) - open) / 30_000) * 2 : 0;
    return {
      dataSource: "mock",
      // Follower accounts are paper only: never LIVE, never armed.
      mode: follower ? "PAPER" : this.mode,
      liveTradingEnabled: false,
      armed: !follower && this.armedUntil != null,
      armedUntil: follower || this.armedUntil == null ? null : toIstIso(this.armedUntil),
      killSwitch: book.killSwitch,
      killReason: book.killReason,
      caps: {
        dailyLossCap: book.dailyLossCap,
        dailyLossUsed: Math.max(0, round2(-today.net)),
        maxPositions: MAX_POSITIONS,
        openPositions: book.positions.length,
        maxOrdersPerDay: MAX_ORDERS_PER_DAY,
        ordersToday: book.orders.length,
      },
      heartbeat: {
        lastTickAt: toIstIso(now - 7000),
        phase: this.main.killSwitch
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
      account: clone(book.account),
      accounts: [...this.books.values()].map((b) => clone(b.account)),
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

  private gates(seed: SignalSeed, conviction: number, now: number, book: Book): GateResult[] {
    const minutes = istParts(now).minutesOfDay;
    const inWindow = sessionPhaseAt(now, isMockHoliday) === "OPEN" && minutes >= 9 * 60 + 25 && minutes < 14 * 60 + 30;
    const age = Math.round((now - Date.parse(this.quotes(now).find((q) => q.key === seed.index)?.asOf ?? "")) / 1000);
    const holding = book.positions.some((p) => p.index === seed.index);
    return seed.gates.map((g): GateResult => {
      switch (g.gate) {
        case "SESSION":
          return { ...g, passed: inWindow, detail: inWindow ? "09:25–14:30 IST" : "Outside 09:25–14:30 IST" };
        case "DATA_AGE":
          return { ...g, passed: age <= 180, detail: `Spot ${Number.isFinite(age) ? age : "?"} s old (max 180 s)` };
        case "KILL_SWITCH":
          return { ...g, passed: !book.killSwitch, detail: book.killSwitch ? `Engaged: ${book.killReason ?? "manual"}` : "Not engaged" };
        case "CONVICTION": {
          const pass = Math.abs(conviction) >= seed.threshold;
          return { ...g, passed: pass, detail: `${fmtSigned(conviction)} ${pass ? "≥" : "<"} ${seed.threshold.toFixed(2)} (${seed.regime})` };
        }
        case "EXPOSURE": {
          const used = book.positions.length;
          if (holding) return { ...g, passed: true, detail: `${used}/${MAX_POSITIONS} position (this plan) · ${book.tradesToday + used}/${book.maxTradesPerDay} trades today` };
          const pass = used < MAX_POSITIONS;
          const other = book.positions[0]?.index;
          return { ...g, passed: pass, detail: pass ? `${used}/${MAX_POSITIONS} positions · ${book.tradesToday}/${book.maxTradesPerDay} trades today` : `${used}/${MAX_POSITIONS} position slots used (${other})` };
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

  private signalView(seed: SignalSeed, now: number, book: Book): SignalView {
    const conviction = round2(seed.baseConviction + this.convDev[seed.index]);
    const gates = this.gates(seed, conviction, now, book);
    const pos = book.positions.find((p) => p.index === seed.index) ?? null;
    const plannedContract = seed.index === "NIFTY" ? (pos?.contract ?? book.niftyPlan) : null;
    const allGatesPassed = gates.every((g) => g.passed !== false);
    let noPlanReason: string | null = null;
    if (book.killSwitch) noPlanReason = "Kill switch engaged: no new entries";
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
      minEdgeRatio: 0.1,
      gates,
      allGatesPassed,
      contract: plannedContract,
      noPlanReason,
      components: seed.components,
      contributors: this.contributions(seed, now),
      rationale: seed.rationale,
      position: pos ? this.positionView(pos, now) : null,
      indicators: seed.indicators,
    };
  }

  /** The open position as a copy ticket, built by the engine's own builder from the fixture. */
  private copyTicket(book: Book, pos: PositionSeed, now: number): CopyTicketView {
    const seed = this.seed.signals.find((s) => s.index === pos.index);
    const mark = this.mark(pos, now);
    const c = pos.contract;
    const side = c.optionType === "CE" ? "BULL" : "BEAR";
    const stops = {
      stopPct: pos.stopPct,
      targetPct: pos.targetPct,
      trailActivatePct: pos.trailActivatePct,
      trailGivebackPct: pos.trailGivebackPct,
      timeStopMs: pos.timeStopAt,
      squareOffMs: pos.squareOffAt,
    };
    const position: Position = {
      id: pos.id,
      planId: pos.planId,
      index: pos.index,
      side,
      contract: { index: c.index, exchange: c.index === "NIFTY" ? "NSE" : "BSE", tradingSymbol: c.tradingSymbol, growwSymbol: "", exchangeToken: "", expiry: c.expiry, strike: c.strike, type: c.optionType, lotSize: c.lotSize, tickSize: 0.05 },
      mode: "PAPER",
      qty: pos.qty,
      avgEntry: pos.avgPrice,
      entryMs: pos.openedAt,
      entryCharges: pos.entryCharges,
      status: "OPEN",
      markPremium: mark,
      markMs: now - 3000,
      peakPremium: Math.max(pos.peak, mark),
      unrealized: (mark - pos.avgPrice) * pos.qty,
      stops,
      horizonMin: Math.round((pos.timeStopAt - pos.openedAt) / MINUTE_MS),
      convictionAtEntry: seed?.baseConviction ?? 0,
      regimeAtEntry: seed?.regime ?? "RANGE",
      dominantSource: pos.dominantSource,
      attribution: [],
      eventKeysAtEntry: [],
      maePct: 0,
      mfePct: round2((Math.max(pos.peak, mark) / pos.avgPrice - 1) * 100),
    };
    const plan: TradePlan | null = seed
      ? {
          id: pos.planId,
          index: pos.index,
          t: pos.openedAt,
          side,
          contract: position.contract,
          lots: c.lots,
          qty: pos.qty,
          entryType: "LIMIT",
          refPremium: pos.avgPrice,
          refSpot: pos.entrySpot,
          horizonMin: position.horizonMin,
          expectedMovePct: round2(Math.abs(seed.baseConviction) * seed.impliedMovePct),
          impliedMovePct: seed.impliedMovePct,
          breakevenMovePct: round2(seed.impliedMovePct * 0.8),
          edgeRatio: 0.21,
          stops,
          riskRupees: round2(pos.avgPrice * pos.qty * Math.abs(pos.stopPct / 100)),
          riskPct: 0.6,
          kellyFraction: 0.25,
          conviction: {
            index: pos.index,
            t: pos.openedAt,
            score: seed.baseConviction,
            components: seed.components.map((x) => ({ ...x, horizonMin: 60 })),
            regime: seed.regime,
            threshold: seed.threshold,
            passes: true,
            sizeMult: 1,
            stance: seed.stance,
          },
          gates: seed.gates,
          dominantSource: pos.dominantSource,
          indicators: { ...seed.indicators, spot: pos.entrySpot },
          quoteSource: "synthetic",
        }
      : null;
    return copyTicketView({ position, plan, account: clone(book.account), timeStopMinPnlPct: 10 });
  }

  // -------------------------------------------------------------------------
  // EngineApi: reads
  // -------------------------------------------------------------------------

  async getState(account?: string): Promise<EngineStateDTO> {
    const now = this.read();
    return clone(this.stateDto(now, this.book(account)));
  }

  async getSignals(account?: string): Promise<SignalView[]> {
    const now = this.read();
    const book = this.book(account);
    return clone(this.seed.signals.map((s) => this.signalView(s, now, book)));
  }

  async getPositions(account?: string): Promise<PositionView[]> {
    const now = this.read();
    return clone(this.book(account).positions.map((p) => this.positionView(p, now)));
  }

  async getCopyTickets(date: string, account?: string): Promise<CopyTicketView[]> {
    const now = this.read();
    const book = this.book(account);
    return clone(book.positions.filter((p) => istDate(p.openedAt) === date).map((p) => this.copyTicket(book, p, now)));
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

  async getOrders(date: string, account?: string): Promise<{ orders: OrderView[]; fills: FillView[] }> {
    this.read();
    const book = this.book(account);
    const isToday = date === this.seed.anchorDate || date === istDate(Date.now());
    if (!isToday) return { orders: [], fills: [] };
    const orders = [...book.orders].sort((a, b) => Date.parse(b.placedAt) - Date.parse(a.placedAt));
    const fills = [...book.fills].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return clone({ orders, fills });
  }

  async getPnl(days: number, account?: string): Promise<PnlResponse> {
    const now = this.read();
    const book = this.book(account);
    const n = clamp(Math.floor(days), 1, book.history.length);
    const history = book.history.slice(-n);
    const today = this.todayPnl(book, now);
    const first = history[0];
    const startingEquity = round2(first.equityEnd - first.net);
    const windowTrades = history.reduce((s, d) => s + d.trades, 0);
    // History charges are per round trip at the account's own premiums.
    const perTrade = windowTrades > 0 ? history.reduce((s, d) => s + d.charges, 0) / windowTrades / ROUND_TRIP_CHARGES.total : 1;
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
      charges: addCharges(scaleCharges(ROUND_TRIP_CHARGES, windowTrades * perTrade), book.chargesToday ?? emptyCharges()),
    });
  }

  async getPerformance(account?: string): Promise<SignalPerformanceRow[]> {
    this.read();
    return clone(this.book(account).performance);
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
    if (armed && this.main.killSwitch) throw new Error("CONFLICT: kill switch is engaged; reset it before arming");
    this.armedUntil = armed ? nextSessionClose(now, isMockHoliday) : null;
    return clone(this.stateDto(now));
  }

  /** `account`: main (default), a follower id, or "all". */
  async setKillSwitch(token: string, req: KillSwitchRequest, actor: string, account?: string): Promise<EngineStateDTO> {
    this.assertToken(token);
    const now = this.advance();
    const books = account === "all" ? [...this.books.values()] : [this.book(account)];
    for (const book of books) {
      if (req.engaged) {
        book.killSwitch = true;
        book.killReason = req.reason.trim() || `Manual kill by ${actor}`;
        if (!book.account.paperOnly) this.armedUntil = null;
        if (req.squareOff) for (const pos of [...book.positions]) this.closePosition(book, pos, "KILL_SWITCH", now);
      } else {
        book.killSwitch = false;
        book.killReason = null;
      }
    }
    return clone(this.stateDto(now, account === "all" ? this.main : books[0]));
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
