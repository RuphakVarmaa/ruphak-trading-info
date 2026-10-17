/**
 * The mock engine's Advisor: a demo brief built from the mock's own option chains, signals, quotes, news
 * and calendar, worked out in code (no AI call, no web research), with every source labelled "mock".
 * It runs the same lifecycle the real AdvisorDO does: Analyze queues a run, the run takes a few seconds,
 * a new brief replaces the old one and joins the history, and a rate limit (4 minutes between starts,
 * 24 runs per IST day) answers with `nextAllowedAt`.
 */
import type {
  AdvisorConfidence,
  AdvisorFactor,
  AdvisorHorizon,
  AdvisorIdea,
  AdvisorLean,
  AdvisorOutlook,
  AdvisorReport,
  AdvisorReportSummary,
  AdvisorView,
  EngineApi,
  IndexId,
  IndexQuote,
  OptionChainView,
  OptionSideView,
  OptionType,
  ScheduledEventView,
  Severity,
  SignalView,
} from "@/engine/api-types";
import { contractLabel } from "@/engine/api-types";
import { addDays, istAt, istDate, prevTradingDay, toIstIso } from "@/lib/ist";
import { isMockHoliday, optionCharges } from "./fixtures";
import { round2 } from "./random";

const INDICES: readonly IndexId[] = ["NIFTY", "SENSEX"];
const SEVERITY_RANK: Record<Severity, number> = { FLASH: 0, ALERT: 1, UPDATE: 2 };
const MINUTE = 60_000;
const DAY = 86_400_000;
/** Queued -> running after this long; the brief is written this long after the press. */
export const MOCK_QUEUE_MS = 1_500;
export const MOCK_RUN_MS = 9_000;
export const MOCK_MIN_GAP_MS = 4 * MINUTE;
export const MOCK_MAX_RUNS_PER_DAY = 24;
const HISTORY_MAX = 20;

export const MOCK_MODEL = "mock (demo data, no Claude call)";
export const MOCK_HONESTY =
  "The project's own tests found no proven way to make money buying NIFTY or SENSEX options: 3,303 rule variants on real prices, and none passed after charges. Size small, always use the stop, and treat every idea here as a reasoned guess, not a promise.";

/** Everything the demo brief is built from, read through the mock's public EngineApi. */
export interface MockAdvisorMarket {
  /** The mock's market clock (its simulated session time). */
  marketNowMs: number;
  phase: string;
  quotes: IndexQuote[];
  vix: number | null;
  signals: SignalView[];
  /** Every listed expiry within 35 days per index, nearest first. */
  chains: Record<IndexId, OptionChainView[]>;
  scheduled: ScheduledEventView[];
  headlines: string[];
}

export async function loadMockAdvisorMarket(api: EngineApi): Promise<MockAdvisorMarket> {
  const [state, signals, live, scheduled, events] = await Promise.all([
    api.getState(),
    api.getSignals(),
    api.getLiveIndices(),
    api.getScheduled(30 * 24),
    api.getEvents({ tab: "ALL", limit: 15 }),
  ]);
  const marketNowMs = Date.parse(state.market.nowIst);
  const chains = {} as Record<IndexId, OptionChainView[]>;
  for (const index of INDICES) {
    const first = await api.getOptionChain(index);
    const listed = first.expiries.filter((e) => Date.parse(`${e}T00:00:00Z`) - Date.parse(`${istDate(marketNowMs)}T00:00:00Z`) <= 35 * DAY).slice(0, 5);
    chains[index] = await Promise.all(listed.map((e) => (e === first.expiry ? first : api.getOptionChain(index, e))));
  }
  return {
    marketNowMs,
    phase: state.market.phase,
    quotes: state.quotes,
    vix: live.levels.find((l) => l.key === "INDIAVIX")?.price ?? null,
    signals,
    chains,
    scheduled,
    headlines: [...events].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)).slice(0, 3).map((e) => e.title),
  };
}

// ---------------------------------------------------------------------------
// Chain readings
// ---------------------------------------------------------------------------

const tick05 = (n: number) => Math.max(0.05, Math.round(n * 20) / 20);
const fmt0 = (n: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n);
const fmt2 = (n: number) => new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const signedPct = (n: number | null) => (n == null ? "no data" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`);
const lakh = (n: number) => `${(Math.abs(n) / 1e5).toFixed(1)} lakh`;
const dayKey = (date: string) => Date.parse(`${date}T00:00:00Z`);
const daysBetween = (from: string, to: string) => Math.round((dayKey(to) - dayKey(from)) / DAY);
const dayWords = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" }).format(new Date(dayKey(date)));

function side(chain: OptionChainView, strike: number, type: OptionType): OptionSideView | null {
  const row = chain.rows.find((r) => r.strike === strike);
  return (type === "CE" ? row?.ce : row?.pe) ?? null;
}

/**
 * |delta| of the given side at an index level between listed strikes, interpolated between the strikes on
 * either side of it: a rough chance the index ends beyond that level at expiry. Null when the level is
 * outside the listed strikes or a delta is missing.
 */
export function deltaAtLevel(chain: OptionChainView, level: number, type: OptionType): number | null {
  const pts = chain.rows
    .map((r) => ({ strike: r.strike, d: (type === "CE" ? r.ce : r.pe)?.delta ?? null }))
    .filter((p): p is { strike: number; d: number } => p.d != null && Number.isFinite(p.d))
    .sort((a, b) => a.strike - b.strike);
  const hi = pts.findIndex((p) => p.strike >= level);
  if (hi < 0) return null;
  if (pts[hi].strike === level) return round2(Math.abs(pts[hi].d));
  if (hi === 0) return null;
  const a = pts[hi - 1];
  const b = pts[hi];
  const t = (level - a.strike) / (b.strike - a.strike);
  return round2(Math.abs(a.d + t * (b.d - a.d)));
}

function mid(s: OptionSideView | null): number | null {
  if (!s) return null;
  if (s.bid != null && s.ask != null) return (s.bid + s.ask) / 2;
  return s.ltp;
}

interface ChainRead {
  chain: OptionChainView;
  days: number;
  straddle: number | null;
  atmIv: number | null;
  callWall: number | null;
  putWall: number | null;
  /** OI change near the money (ATM ± 5 strikes) since the previous session. */
  ceOiChange: number;
  peOiChange: number;
}

function readChain(chain: OptionChainView, today: string): ChainRead {
  const ce = side(chain, chain.atmStrike, "CE");
  const pe = side(chain, chain.atmStrike, "PE");
  const ceMid = mid(ce);
  const peMid = mid(pe);
  const ivs = [ce?.iv, pe?.iv].filter((v): v is number => v != null);
  let callWall: { strike: number; oi: number } | null = null;
  let putWall: { strike: number; oi: number } | null = null;
  let ceOiChange = 0;
  let peOiChange = 0;
  const step = chain.rows.length > 1 ? Math.abs(chain.rows[1].strike - chain.rows[0].strike) : 50;
  for (const r of chain.rows) {
    if (r.strike >= chain.spot && (r.ce?.oi ?? 0) > (callWall?.oi ?? 0)) callWall = { strike: r.strike, oi: r.ce?.oi ?? 0 };
    if (r.strike <= chain.spot && (r.pe?.oi ?? 0) > (putWall?.oi ?? 0)) putWall = { strike: r.strike, oi: r.pe?.oi ?? 0 };
    if (Math.abs(r.strike - chain.atmStrike) <= 5 * step) {
      ceOiChange += r.ce?.oiChange ?? 0;
      peOiChange += r.pe?.oiChange ?? 0;
    }
  }
  return {
    chain,
    days: daysBetween(today, chain.expiry),
    straddle: ceMid != null && peMid != null ? round2(ceMid + peMid) : null,
    atmIv: ivs.length ? round2(ivs.reduce((a, b) => a + b, 0) / ivs.length) : null,
    callWall: callWall?.strike ?? null,
    putWall: putWall?.strike ?? null,
    ceOiChange,
    peOiChange,
  };
}

/** The three expiries the real advisor builds candidates from: the nearest not expiring today, the next weekly, and the furthest within 35 days. */
function pickExpiries(reads: ChainRead[]): { near: ChainRead | null; week: ChainRead | null; month: ChainRead | null; today: ChainRead | null } {
  const today = reads.find((r) => r.days === 0) ?? null;
  const later = reads.filter((r) => r.days > 0);
  const near = later[0] ?? null;
  const week = later[1] ?? near;
  const month = later.filter((r) => r.days <= 35).at(-1) ?? null;
  return { near, week, month: month && month !== week ? month : null, today };
}

// ---------------------------------------------------------------------------
// Ideas: priced off the live ask, with the validation's rules (stop 30% below, target 1.6× the risk)
// ---------------------------------------------------------------------------

function buildIdea(args: {
  horizon: AdvisorHorizon;
  read: ChainRead;
  strike: number;
  type: OptionType;
  exitByMs: number;
  why: string[];
  wrongIf: string;
  confidence: AdvisorConfidence;
  asOf: string;
  /** What must happen before buying; omitted for a buy now. */
  condition?: string;
}): AdvisorIdea | null {
  const { chain } = args.read;
  const s = side(chain, args.strike, args.type);
  if (!s || s.ask == null || s.ask <= 0) return null;
  const ask = s.ask;
  const stop = tick05(ask * 0.7);
  const target = tick05(ask + 1.6 * (ask - stop));
  const lot = chain.lotSize;
  const charges = optionCharges("BUY", ask, lot, chain.index).total + optionCharges("SELL", stop, lot, chain.index).total;
  const costPerLot = round2(ask * lot);
  const breakeven = round2(args.type === "CE" ? args.strike + ask : args.strike - ask);
  const contract = { index: chain.index, expiry: chain.expiry, strike: args.strike, optionType: args.type };
  return {
    id: `${chain.index}-${chain.expiry}-${args.strike}-${args.type}`,
    horizon: args.horizon,
    contract: { ...contract, tradingSymbol: `${chain.index}${chain.expiry.replace(/-/g, "").slice(2)}${args.strike}${args.type}`, lotSize: lot, label: contractLabel(contract) },
    entry: { low: tick05(ask * 0.97), high: tick05(ask * 1.01), ask, asOf: args.asOf },
    stop,
    target,
    exitBy: toIstIso(args.exitByMs),
    lots: 1,
    costPerLot,
    maxLossPerLot: round2((ask - stop) * lot + charges),
    rewardPerLot: round2((target - ask) * lot - charges),
    breakevenAtExpiry: breakeven,
    delta: s.delta,
    iv: s.iv,
    probItm: s.delta == null ? null : round2(Math.abs(s.delta)),
    probAboveBreakeven: deltaAtLevel(chain, breakeven, args.type),
    why: args.why,
    wrongIf: args.wrongIf,
    confidence: args.confidence,
    condition: args.condition ?? null,
  };
}

/** The strike nearest the money (at or out of it) whose one lot costs at most ₹10,000 at the ask; ATM when none does. */
function fitStrike(chain: OptionChainView, type: OptionType): number {
  const outward = chain.rows
    .filter((r) => (type === "CE" ? r.strike >= chain.atmStrike : r.strike <= chain.atmStrike))
    .sort((a, b) => Math.abs(a.strike - chain.atmStrike) - Math.abs(b.strike - chain.atmStrike));
  for (const r of outward) {
    const ask = (type === "CE" ? r.ce : r.pe)?.ask;
    if (ask != null && ask * chain.lotSize <= 10_000) return r.strike;
  }
  return chain.atmStrike;
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

const leanOf = (s: SignalView | undefined): AdvisorLean => (s?.stance === "BULLISH" ? "UP" : s?.stance === "BEARISH" ? "DOWN" : "SIDEWAYS");

function quotePct(quotes: IndexQuote[], key: string): number | null {
  return quotes.find((q) => q.key === key)?.changePct ?? null;
}

export function buildMockAdvisorReport(m: MockAdvisorMarket, createdAtMs: number, durationMs = MOCK_RUN_MS): AdvisorReport {
  const today = istDate(m.marketNowMs);
  const createdAt = toIstIso(createdAtMs);
  const spot = (index: IndexId) => m.chains[index][0]?.spot ?? m.quotes.find((q) => q.key === index)?.price ?? null;
  const reads = Object.fromEntries(INDICES.map((i) => [i, m.chains[i].map((c) => readChain(c, today))])) as Record<IndexId, ChainRead[]>;
  const picks = Object.fromEntries(INDICES.map((i) => [i, pickExpiries(reads[i])])) as Record<IndexId, ReturnType<typeof pickExpiries>>;
  const signal = (i: IndexId) => m.signals.find((s) => s.index === i);

  // --- outlook: lean from the engine's signal, ranges from what option prices imply -----------------
  const outlook: AdvisorOutlook[] = [];
  for (const index of INDICES) {
    const s = signal(index);
    const p = picks[index];
    const level = spot(index);
    const lean = leanOf(s);
    const near = p.near ?? p.today;
    const dayMove = level != null && near?.atmIv != null ? (level * near.atmIv) / 100 / Math.sqrt(252) : null;
    const range = (move: number | null) => (level != null && move != null ? { rangeLow: Math.round(level - move), rangeHigh: Math.round(level + move) } : { rangeLow: null, rangeHigh: null });
    const conv = s ? Math.abs(s.conviction) : 0;
    const pcr = near?.chain.pcr ?? null;
    outlook.push({
      index,
      horizon: "TODAY",
      lean,
      confidence: conv >= 0.6 ? "MEDIUM" : "LOW",
      ...range(dayMove),
      why: [
        s ? `The engine's signal is ${s.stance.toLowerCase()} with conviction ${s.conviction.toFixed(2)} (its strength score from −1 to +1), in a ${s.regime.replace("_", " ").toLowerCase()} market.` : "No engine signal right now.",
        dayMove != null && near ? `Option prices imply a typical day's move of about ±${fmt0(dayMove)} points (from ATM IV ${near.atmIv?.toFixed(1)}%, the volatility priced into at-the-money options).` : "No implied move: the chain has no IV.",
        pcr != null ? `PCR (puts open ÷ calls open) is ${pcr.toFixed(2)}: ${pcr >= 1.2 ? "many puts written, usually read as support below" : pcr <= 0.8 ? "calls dominate, usually read as a lid above" : "balanced"}.` : "No PCR: the chain has no open interest.",
        "Indicators like these called the next day's direction no better than a coin in the project's tests, so treat the lean as context.",
      ],
    });
    const wk = p.week;
    outlook.push({
      index,
      horizon: "WEEK",
      lean: lean === "UP" && (wk?.chain.pcr ?? 0) >= 1 ? "UP" : lean === "DOWN" && (wk?.chain.pcr ?? 2) < 1 ? "DOWN" : "SIDEWAYS",
      confidence: "LOW",
      ...range(wk?.straddle ?? null),
      why: [
        wk?.straddle != null ? `The ATM straddle (a call plus a put at the current price) for ${dayWords(wk.chain.expiry)} costs ₹${fmt2(wk.straddle)}: option prices imply about ±${fmt0(wk.straddle)} points by then.` : "No straddle price for the weekly expiry.",
        wk?.callWall != null && wk.putWall != null ? `Option sellers sit at ${fmt0(wk.putWall)} (biggest put OI, support) and ${fmt0(wk.callWall)} (biggest call OI, resistance).` : "No OI walls.",
        wk?.chain.maxPain != null ? `Max pain (where option buyers as a group lose the most at expiry) is ${fmt0(wk.chain.maxPain)}.` : "No max pain.",
      ],
    });
    const mo = p.month ?? p.week;
    outlook.push({
      index,
      horizon: "MONTH",
      lean: "SIDEWAYS",
      confidence: "LOW",
      ...range(mo?.straddle ?? null),
      why: [
        mo?.straddle != null ? `For ${dayWords(mo.chain.expiry)} option prices imply about ±${fmt0(mo.straddle)} points (ATM straddle ₹${fmt2(mo.straddle)}).` : "No straddle price for the monthly expiry.",
        "Nothing the project tested calls a month's direction, so the honest lean is sideways inside the implied range.",
        "Results season and the next RBI and US Fed meetings can move the index more than the chain prices in.",
      ],
    });
  }

  // --- factors ------------------------------------------------------------------------------------
  const nifty = picks.NIFTY.near ?? picks.NIFTY.today;
  const niftyPct = quotePct(m.quotes, "NIFTY");
  const ceChg = nifty?.ceOiChange ?? 0;
  const peChg = nifty?.peOiChange ?? 0;
  const covering = niftyPct != null && niftyPct > 0 && ceChg < 0;
  const unwinding = niftyPct != null && niftyPct < 0 && peChg < 0;
  const sp = quotePct(m.quotes, "SPFUT");
  const brent = quotePct(m.quotes, "BRENT");
  const inr = m.quotes.find((q) => q.key === "USDINR");
  const ivRatio = nifty?.atmIv != null && m.vix != null && m.vix > 0 ? nifty.atmIv / m.vix : null;
  const premiumVerdict: AdvisorReport["premium"]["verdict"] = ivRatio == null ? "NO_DATA" : ivRatio < 0.8 ? "CHEAP" : ivRatio > 1.2 ? "EXPENSIVE" : "NORMAL";
  const soon = m.scheduled.filter((e) => Date.parse(e.at) - m.marketNowMs <= 7 * DAY && e.impact === "HIGH");
  const nextEvents = m.scheduled.slice(0, 3).map((e) => `${e.title} (${dayWords(istDate(Date.parse(e.at)))})`);
  const ns = signal("NIFTY");

  const factors: AdvisorFactor[] = [
    {
      key: "FII_DII",
      label: "Foreign and domestic funds (FII/DII)",
      reading: "NO_DATA",
      detail: "Demo mode does no web research, so there are no FII (foreign institutions) or DII (Indian funds) buying and selling figures. The real brief looks them up on news sites and links each number.",
      source: "none (demo)",
    },
    {
      key: "NEWS_UNCERTAINTY",
      label: "News and uncertainty",
      reading: m.headlines.length ? "RISK" : "NO_DATA",
      detail: m.headlines.length ? `Top stories in the mock news feed: ${m.headlines.join("; ")}.` : "No scored news in the last 48 hours.",
      source: "news: mock feed",
    },
    {
      key: "GLOBAL_CUES",
      label: "Global markets",
      reading: brent != null && brent > 1.5 ? "RISK" : sp != null && sp > 0.2 ? "SUPPORTS_UP" : sp != null && sp < -0.2 ? "SUPPORTS_DOWN" : "NEUTRAL",
      detail: `US S&P 500 futures ${signedPct(sp)}; Brent crude ${signedPct(brent)} (dearer oil hurts India, which imports most of its oil); rupee ${inr ? `${inr.price.toFixed(2)} per dollar (${signedPct(inr.changePct)})` : "no data"}.`,
      source: "mock quotes",
    },
    {
      key: "SHORT_COVERING",
      label: "Short covering (option sellers buying back)",
      reading: covering ? "SUPPORTS_UP" : unwinding ? "SUPPORTS_DOWN" : "NEUTRAL",
      detail: nifty
        ? `Near the money on NIFTY's ${dayWords(nifty.chain.expiry)} expiry, call OI (open contracts) ${ceChg >= 0 ? "rose" : "fell"} by ${lakh(ceChg)} and put OI ${peChg >= 0 ? "rose" : "fell"} by ${lakh(peChg)} since yesterday, with NIFTY ${signedPct(niftyPct)}. ${
            covering
              ? "Call writers are covering as the index rises: a bullish push."
              : unwinding
                ? "Put OI falling while the index falls: bearish."
                : niftyPct != null && niftyPct > 0
                  ? "Call OI is not falling as the index rises, so call writers are not buying back: no short-covering push."
                  : niftyPct != null && niftyPct < 0
                    ? "Put OI is not falling as the index falls: put writers are holding."
                    : niftyPct == null
                      ? "No index move to read it against: no short-covering read."
                      : "The index is flat: no short-covering read."
          }`
        : "No chain.",
      source: "mock option chain",
    },
    {
      key: "OPTIONS_POSITIONING",
      label: "Where option sellers sit",
      reading: nifty?.chain.pcr != null ? (nifty.chain.pcr >= 1.2 ? "SUPPORTS_UP" : nifty.chain.pcr <= 0.8 ? "SUPPORTS_DOWN" : "NEUTRAL") : "NO_DATA",
      detail: nifty
        ? `NIFTY PCR (puts open ÷ calls open) ${nifty.chain.pcr?.toFixed(2) ?? "no data"}; biggest put OI ${nifty.putWall != null ? fmt0(nifty.putWall) : "—"} (support), biggest call OI ${nifty.callWall != null ? fmt0(nifty.callWall) : "—"} (resistance); max pain ${nifty.chain.maxPain != null ? fmt0(nifty.chain.maxPain) : "—"}.`
        : "No chain.",
      source: "mock option chain",
    },
    {
      key: "VOLATILITY_PREMIUM",
      label: "Option prices and volatility",
      reading: premiumVerdict === "EXPENSIVE" ? "RISK" : premiumVerdict === "NO_DATA" ? "NO_DATA" : "NEUTRAL",
      detail:
        nifty?.atmIv != null && m.vix != null
          ? `NIFTY at-the-money IV ${nifty.atmIv.toFixed(1)}% against India VIX ${m.vix.toFixed(2)} (the market's fear gauge). Premiums usually price in more movement than follows, so buyers start behind.`
          : "No IV or VIX reading.",
      source: "mock option chain, mock India VIX",
    },
    {
      key: "TREND",
      label: "Trend and setups",
      reading: ns?.stance === "BULLISH" ? "SUPPORTS_UP" : ns?.stance === "BEARISH" ? "SUPPORTS_DOWN" : "NEUTRAL",
      detail: ns
        ? `The engine reads NIFTY as ${ns.regime.replace("_", " ").toLowerCase()} with ${ns.stance.toLowerCase()} conviction ${ns.conviction.toFixed(2)}${ns.allGatesPassed ? "" : `; its own checks still block an entry (${ns.gates.filter((g) => g.passed === false).slice(0, 2).map((g) => g.label).join(", ") || "edge check"})`}.`
        : "No signal.",
      source: "mock engine signal",
    },
    {
      key: "EVENTS",
      label: "Scheduled events",
      reading: soon.length ? "RISK" : nextEvents.length ? "NEUTRAL" : "NO_DATA",
      detail: nextEvents.length
        ? `Next: ${nextEvents.join("; ")}. Option prices often rise before a big event and drop right after it (IV crush), even when the index moves your way.`
        : "Nothing scheduled in the next 30 days.",
      source: "mock calendar",
    },
  ];

  // --- ideas --------------------------------------------------------------------------------------
  const ideas: AdvisorIdea[] = [];
  for (const index of INDICES) {
    const s = signal(index);
    if (!s || s.stance === "NEUTRAL") continue;
    const type: OptionType = s.stance === "BULLISH" ? "CE" : "PE";
    const p = picks[index];
    const dir = type === "CE" ? "rises" : "falls";
    const against = (r: ChainRead | null) => (type === "CE" ? r?.putWall : r?.callWall);
    const wrongIf = (r: ChainRead | null) => {
      const lvl = against(r);
      return lvl != null ? `${index} ${type === "CE" ? "closes below" : "closes above"} ${fmt0(lvl)}, or the premium hits the stop.` : "The premium hits the stop.";
    };
    const exitToday = istAt(today, "15:00");
    if (p.near && p.near.days >= 1) {
      const idea = buildIdea({
        horizon: "TODAY",
        read: p.near,
        strike: p.near.chain.atmStrike,
        type,
        exitByMs: exitToday,
        why: [
          `The engine's ${s.stance.toLowerCase()} signal (conviction ${s.conviction.toFixed(2)}); the option gains if ${index} ${dir} today.`,
          "At the money (strike nearest the price): the cheapest way to get a full point-for-point move on a ₹10,000 account.",
          "Only inside the plan's entry windows (09:30–11:15 or 14:15–15:00), and out by 15:00: no overnight risk.",
        ],
        wrongIf: wrongIf(p.near),
        confidence: "LOW",
        asOf: createdAt,
      });
      if (idea) ideas.push(idea);
    }
    if (p.week && p.week !== p.near) {
      const wk = p.week;
      const exitDay = prevTradingDay(wk.chain.expiry, isMockHoliday);
      const strike = fitStrike(wk.chain, type);
      const ask = side(wk.chain, strike, type)?.ask ?? null;
      const idea = buildIdea({
        horizon: "WEEK",
        read: wk,
        strike,
        type,
        exitByMs: istAt(exitDay, "14:30"),
        why: [
          `${wk.days} days to expiry: the research's choice for a buyer (at least 4 days, so time decay is slower).`,
          strike === wk.chain.atmStrike
            ? "At the money (the strike nearest the price), and one lot fits in ₹10,000."
            : `The strike nearest the money whose lot fits in ₹10,000 (${fmt0(Math.abs(strike - wk.chain.atmStrike))} points ${type === "CE" ? "above" : "below"} the price).`,
          wk.straddle != null && ask != null ? `Option prices imply ±${fmt0(wk.straddle)} points by expiry; break-even needs ${index} ${type === "CE" ? "above" : "below"} ${fmt0(type === "CE" ? strike + ask : strike - ask)}.` : "No implied move.",
          "Exit a day before expiry: the last day's decay is the steepest.",
        ],
        wrongIf: wrongIf(wk),
        confidence: Math.abs(s.conviction) >= 0.6 ? "MEDIUM" : "LOW",
        asOf: createdAt,
      });
      if (idea) ideas.push(idea);
    }
    if (p.month) {
      const step = p.month.chain.rows.length > 1 ? Math.abs(p.month.chain.rows[1].strike - p.month.chain.rows[0].strike) : 50;
      const itm = type === "CE" ? p.month.chain.atmStrike - step : p.month.chain.atmStrike + step;
      // A conditional idea, so demo mode shows the "Not a buy yet" warning: it waits for the index to clear its OI wall.
      const wall = type === "CE" ? p.month.callWall : p.month.putWall;
      const idea = buildIdea({
        horizon: "MONTH",
        read: p.month,
        strike: itm,
        type,
        exitByMs: istAt(addDays(p.month.chain.expiry, -7), "15:00"),
        why: [
          "One strike in the money (already past the strike): it holds value better if the move is slow.",
          `${p.month.days} days to expiry gives the idea time; it costs more than ₹10,000 a lot on NIFTY, so it is an idea to watch, not to stretch for.`,
          "Exit with a week left, before decay speeds up.",
        ],
        wrongIf: wrongIf(p.month),
        confidence: "LOW",
        asOf: createdAt,
        condition:
          wall != null
            ? `Only if ${index} closes a day ${type === "CE" ? "above" : "below"} ${fmt0(wall)} (where the biggest ${type === "CE" ? "call" : "put"} OI sits) first; otherwise skip it.`
            : `Only once ${index} has closed two days in a row ${type === "CE" ? "higher" : "lower"}; otherwise skip it.`,
      });
      if (idea) ideas.push(idea);
    }
  }
  const pick = ideas.find((i) => i.horizon === "WEEK") ?? ideas[0] ?? null;

  // --- zero-hero ----------------------------------------------------------------------------------
  const expiringToday = INDICES.map((i) => picks[i].today).filter((r): r is ChainRead => r != null);
  let zeroHero: AdvisorReport["zeroHero"];
  if (expiringToday.length) {
    const r = expiringToday[0];
    const cheap = r.chain.rows
      .flatMap((row) => [row.ce && row.strike > r.chain.spot ? row.ce : null, row.pe && row.strike < r.chain.spot ? row.pe : null])
      .filter((x): x is OptionSideView => x != null && x.ask != null && x.ask <= 10 && x.ask >= 0.5);
    const deltas = cheap.map((x) => Math.abs(x.delta ?? 0)).filter((d) => d > 0);
    const dMax = deltas.length ? Math.max(...deltas) : null;
    zeroHero = {
      applicable: true,
      expiry: r.chain.expiry,
      summary:
        cheap.length && dMax != null
          ? `${r.chain.index} expires today. Far out-of-the-money options at ₹0.50–10 cost ₹${fmt0(0.5 * r.chain.lotSize)}–${fmt0(10 * r.chain.lotSize)} a lot and have delta up to ${dMax.toFixed(2)}: roughly a ${Math.round(dMax * 100)}% chance or less of ending in the money, so about ${100 - Math.round(dMax * 100)} in 100 expire worthless. Only money you are happy to lose entirely.`
          : `${r.chain.index} expires today, but no far out-of-the-money option is quoted between ₹0.50 and ₹10.`,
    };
  } else {
    const next = INDICES.map((i) => (picks[i].near ? `${i} on ${dayWords(picks[i].near!.chain.expiry)}` : null)).filter(Boolean);
    zeroHero = { applicable: false, expiry: null, summary: `No expiry today. Next expiries: ${next.join(", ")}.` };
  }

  // --- the rest -----------------------------------------------------------------------------------
  const niftyLot = m.chains.NIFTY[0]?.lotSize ?? 65;
  const sensexLot = m.chains.SENSEX[0]?.lotSize ?? 20;
  const action: AdvisorReport["today"]["action"] = pick ? "BUY" : "WAIT";
  const level = spot("NIFTY");
  return {
    id: `mock-${createdAtMs}`,
    createdAt,
    model: MOCK_MODEL,
    durationMs,
    // No Claude call, so the run cost nothing (null would read "cost not known").
    costUsd: 0,
    market: { nifty: spot("NIFTY"), sensex: spot("SENSEX"), vix: m.vix, phase: m.phase },
    headline: pick
      ? `Demo: NIFTY leans up, so at most one small ${pick.contract.optionType === "CE" ? "CALL" : "PUT"} with a stop; SENSEX has no clear lean.`
      : "Demo: no clear lean on either index today, so WAIT.",
    today: pick
      ? {
          action,
          summary: `NIFTY ${level != null ? `at ${fmt0(level)} ` : ""}is in an uptrend on the engine's reading, and option prices are ${premiumVerdict === "NO_DATA" ? "unknown" : premiumVerdict.toLowerCase()}. If you take it, buy one lot inside the plan's entry windows (09:30–11:15 or 14:15–15:00), set the stop at once, and skip it if NIFTY gives up the day's gain first.`,
          ideaId: pick.id,
        }
      : { action, summary: "Neither index has a lean worth paying time decay for. Waiting is a position too.", ideaId: null },
    outlook,
    factors,
    ideas,
    zeroHero,
    premium: {
      verdict: premiumVerdict,
      detail:
        ivRatio == null
          ? "No IV or VIX reading."
          : `NIFTY at-the-money IV (the volatility priced into options) is ${nifty?.atmIv?.toFixed(1)}%, ${ivRatio.toFixed(2)}× India VIX. ${premiumVerdict === "CHEAP" ? "Cheap against VIX, though premiums usually still price in more movement than follows." : premiumVerdict === "EXPENSIVE" ? "Rich: a buyer needs a bigger move just to break even, and the price can drop after the next event." : "In the usual range."} Premium is highest in the first minutes after 09:15; it is cheapest to buy after 09:30.`,
    },
    alsoKnow: [
      `India VIX (the market's "fear gauge", built from NIFTY option prices) is ${m.vix != null ? m.vix.toFixed(2) : "not available"}. It predicts how big moves may be, not which way.`,
      "IV skew: puts below the price usually carry higher volatility than calls above it, because people pay up for crash insurance.",
      "Max pain pull: close to expiry the index is said to drift toward the max-pain strike; it is a weak effect, never a reason to trade on its own.",
      "Theta (time decay) speeds up in the last 2–3 days: an at-the-money weekly can lose a third of its value on its last day if the index does not move.",
      "Gap risk: anything held overnight can open far past your stop, and no stop fills while the market is shut.",
      `Lot sizes: NIFTY is ${niftyLot} units a lot, SENSEX ${sensexLot}. A ₹150 NIFTY option costs ₹${fmt0(150 * niftyLot)} for one lot; buying options needs only the premium, selling needs lakhs of margin.`,
      "Charges: a round trip costs roughly ₹60–80 a lot in brokerage, STT (securities transaction tax, 0.15% of the premium when you sell), exchange fees, GST and stamp duty.",
      "Tax: F&O profit is business income in India, taxed at your slab rate; a loss can be carried forward 8 years if you file your return on time.",
      "SEBI's F&O rules: one weekly expiry per exchange (NIFTY on Tuesday, SENSEX on Thursday), bigger lots and extra margin on expiry day. 9 in 10 individual F&O traders lost money in FY26.",
      "Liquidity: far strikes have wide bid–ask spreads (the gap between the buying and selling price); a ₹2 option with a ₹0.50 spread is 25% down the moment you buy it.",
      "Results season (mid-October to mid-November): one heavyweight such as Reliance or HDFC Bank reporting can move NIFTY on its own.",
    ],
    avoid: [
      "Don't buy in the first 15 minutes (09:15–09:30): premiums are at their richest.",
      "Don't open new trades from 11:15 to 14:15: premium decays while the index drifts.",
      "Don't hold an option overnight.",
      "Don't buy far out-of-the-money \"cheap\" strikes to hold: most expire worthless.",
      "Don't sell \"because FIIs sold\": the FII figure says nothing about the next day.",
      "Don't move the stop once you are in.",
    ],
    sources: [
      { title: "Demo data: the mock engine's option chains", url: "/options" },
      { title: "Options buying in plain words (this site)", url: "/learn" },
    ],
    honesty: MOCK_HONESTY,
  };
}

export function summarize(r: AdvisorReport): AdvisorReportSummary {
  return {
    id: r.id,
    createdAt: r.createdAt,
    headline: r.headline,
    todayAction: r.today.action,
    ideas: r.ideas.map((i) => ({ id: i.id, label: i.contract.label, horizon: i.horizon, entryAsk: i.entry.ask, stop: i.stop, target: i.target, conditional: i.condition != null || r.today.action !== "BUY" })),
  };
}

/** Two older demo briefs: one on contracts still listed (priced off today's chain), one on a contract that has expired. */
function seedHistory(m: MockAdvisorMarket, latestMs: number): AdvisorReportSummary[] {
  const out: AdvisorReportSummary[] = [];
  const today = istDate(m.marketNowMs);
  const near = m.chains.NIFTY.find((c) => c.expiry > today) ?? m.chains.NIFTY[0];
  if (near) {
    const ce = side(near, near.atmStrike, "CE");
    const pe = side(near, near.atmStrike - 100, "PE");
    const row = (type: OptionType, strike: number, ask: number | null, k: number, horizon: AdvisorHorizon) =>
      ask == null
        ? null
        : { id: `${near.index}-${near.expiry}-${strike}-${type}`, label: contractLabel({ index: near.index, expiry: near.expiry, strike, optionType: type }), horizon, entryAsk: tick05(ask * k), stop: tick05(ask * k * 0.7), target: tick05(ask * k * 1.48) };
    const ideas = [row("CE", near.atmStrike, ce?.ltp ?? null, 0.82, "WEEK"), row("PE", near.atmStrike - 100, pe?.ltp ?? null, 1.4, "TODAY")].filter((x): x is NonNullable<typeof x> => x != null);
    out.push({ id: `mock-${latestMs - DAY}`, createdAt: toIstIso(latestMs - DAY - 3 * 3_600_000), headline: "Demo: NIFTY firm above its put wall; one weekly CALL, small.", todayAction: "BUY", ideas });
  }
  const expired = addDays(today, -3);
  const atm = m.chains.NIFTY[0]?.atmStrike ?? 22600;
  out.push({
    id: `mock-${latestMs - 3 * DAY}`,
    createdAt: toIstIso(latestMs - 3 * DAY - 3 * 3_600_000),
    headline: "Demo: event day ahead; WAIT for the RBI decision.",
    todayAction: "WAIT",
    ideas: [{ id: `NIFTY-${expired}-${atm}-CE`, label: contractLabel({ index: "NIFTY", expiry: expired, strike: atm, optionType: "CE" }), horizon: "WEEK", entryAsk: 96.5, stop: 67.55, target: 142.9 }],
  });
  return out;
}

// ---------------------------------------------------------------------------
// The run lifecycle and rate limit
// ---------------------------------------------------------------------------

export class MockAdvisor {
  private status: AdvisorView["status"] = "idle";
  private queuedAt: number | null = null;
  private lastStartAt: number | null = null;
  private runs = { day: "", n: 0 };
  private latest: AdvisorReport | null = null;
  private history: AdvisorReportSummary[] = [];
  private seeded = false;

  constructor(private readonly clock: () => number = Date.now) {}

  private runsToday(now: number): number {
    return this.runs.day === istDate(now) ? this.runs.n : 0;
  }

  private nextAllowed(now: number): number | null {
    if (this.runsToday(now) >= MOCK_MAX_RUNS_PER_DAY) return istAt(addDays(istDate(now), 1), "00:00");
    if (this.lastStartAt != null && now - this.lastStartAt < MOCK_MIN_GAP_MS) return this.lastStartAt + MOCK_MIN_GAP_MS;
    return null;
  }

  private snapshot(now: number): AdvisorView {
    const next = this.nextAllowed(now);
    return {
      status: this.status,
      lastError: null,
      runningSince: this.status === "running" && this.queuedAt != null ? toIstIso(this.queuedAt + MOCK_QUEUE_MS) : null,
      nextAllowedAt: next == null ? null : toIstIso(next),
      runsToday: this.runsToday(now),
      maxRunsPerDay: MOCK_MAX_RUNS_PER_DAY,
      latest: this.latest,
      history: this.history,
    };
  }

  /** The current view; advances a queued or running demo analysis, writing the new brief once it is due. */
  async view(load: () => Promise<MockAdvisorMarket>): Promise<AdvisorView> {
    const now = this.clock();
    if (!this.seeded) {
      // A brief from five minutes ago (the morning auto-run), so the page has something to show.
      const m = await load();
      const at = now - 5 * MINUTE;
      this.latest = buildMockAdvisorReport(m, at);
      this.history = [summarize(this.latest), ...seedHistory(m, at)];
      this.lastStartAt = at - MOCK_RUN_MS;
      this.runs = { day: istDate(now), n: 1 };
      this.seeded = true;
    }
    if (this.status === "queued" && this.queuedAt != null && now - this.queuedAt >= MOCK_QUEUE_MS) this.status = "running";
    if (this.status === "running" && this.queuedAt != null && now - this.queuedAt >= MOCK_RUN_MS) {
      const report = buildMockAdvisorReport(await load(), this.queuedAt + MOCK_RUN_MS);
      this.latest = report;
      this.history = [summarize(report), ...this.history].slice(0, HISTORY_MAX);
      this.status = "idle";
      this.queuedAt = null;
    }
    return this.snapshot(now);
  }

  /** Queues a demo analysis unless one is under way or the rate limit holds. */
  async run(load: () => Promise<MockAdvisorMarket>): Promise<AdvisorView> {
    const view = await this.view(load);
    if (view.status === "queued" || view.status === "running" || view.nextAllowedAt != null) return view;
    const now = this.clock();
    this.status = "queued";
    this.queuedAt = now;
    this.lastStartAt = now;
    this.runs = { day: istDate(now), n: this.runsToday(now) + 1 };
    return this.snapshot(now);
  }
}

const ADVISORS = new WeakMap<object, MockAdvisor>();

/** One demo advisor per mock engine instance (the mock engine is a process-wide singleton). */
export function mockAdvisorFor(owner: object): MockAdvisor {
  let a = ADVISORS.get(owner);
  if (!a) {
    a = new MockAdvisor();
    ADVISORS.set(owner, a);
  }
  return a;
}
