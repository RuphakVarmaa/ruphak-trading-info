/**
 * The mock engine's options agent: a demo AgentView worked out in code from the mock clock, with no model call,
 * so the Agent page can be seen in mock mode. It shows what the real agent shows on a session like the mock's:
 * one decision per finalist on the latest closed 5-minute candle (a generic finalist per index and one
 * Advisor-style idea on NIFTY), the code's gate in words, sizing at zero because nothing measured says the calls
 * pay, one escalation to the deep model, the risk panel, calibration with buckets, the previous session's review
 * and a pending candidate. Approve and reject follow the engine's rules (approval only outside the session);
 * re-arm clears a drawdown halt. Every model-written text says it is demo data.
 */
import type {
  AccountView,
  AgentCalibrationView,
  AgentCandidateView,
  AgentCostView,
  AgentDecisionView,
  AgentDirection,
  AgentEscalationView,
  AgentFinalistView,
  AgentGateLineView,
  AgentIndexCardView,
  AgentMode,
  AgentRegime,
  AgentReviewView,
  AgentRiskLevel,
  AgentRiskView,
  AgentSnapshotFieldView,
  AgentView,
  IndexId,
} from "@/engine/api-types";
import { AGENT_HONESTY, AGENT_LIMITS, AGENT_POLICY, CHARS_PER_TOKEN_BOUND, ESCALATION } from "@/engine/agent/constants";
import { BUILTIN_GUIDANCE, instructionVersion } from "@/engine/agent/prompt";
import type { IndexSnapshot } from "@/engine/agent/types";
import { fnv1aHex } from "@/engine/util/hash";
import { addDays, isTradingDay, istAt, istDate, MINUTE_MS, nextWeeklyExpiry, prevTradingDay, sessionPhaseAt, toIstIso } from "@/lib/ist";
import { isMockHoliday, mockTradingSymbol, STRIKE_STEP } from "./fixtures";
import { hashString, mulberry32, round2 } from "./random";

export const MOCK_AGENT_MODEL = "demo (no model call)";

const INDICES: readonly IndexId[] = ["NIFTY", "SENSEX"];
const BAR_MS = 5 * MINUTE_MS;
/** A candle's decisions appear this long after its close, and the engine acts on them a little later (the real agent: about 1–2 minutes). */
const JUDGED_AFTER_MS = 90_000;
const ACTED_AFTER_MS = 120_000;
/** Bars are stored until the close for grading; the model judges only those closing in the reflex window. */
const LAST_STORED_BAR = "15:30";
/** The demo brief (the Advisor's 09:25 auto-run) and the nightly review's times. */
const BRIEF_AT = "09:26:30";
const REVIEW_AT = "16:23";
const CANDIDATE_AT = "16:31";
/** The demo's one escalation: SENSEX's generic finalist on the 11:35 candle, applied to the 11:40 one. */
const ESCALATION_BAR = "11:35";
const SHOWCASE_BAR = "11:40";
/** The demo's equity: flat at the account's capital (no trades), or 15.18% under its peak when it starts halted. */
const HALTED_EQUITY = 424_100;
const MINUS = "−";

/** The index levels the demo path is anchored on (the mock's fixture levels by default). */
export interface MockAgentLevels {
  spot: Record<IndexId, number>;
  prevClose: Record<IndexId, number>;
  prevHigh: Record<IndexId, number>;
  prevLow: Record<IndexId, number>;
  vix: number;
  vixPrevClose: number;
}

export const DEFAULT_AGENT_LEVELS: MockAgentLevels = {
  spot: { NIFTY: 22646.35, SENSEX: 72640.8 },
  prevClose: { NIFTY: 22518.1, SENSEX: 72301.45 },
  prevHigh: { NIFTY: 22601.5, SENSEX: 72455.2 },
  prevLow: { NIFTY: 22402.8, SENSEX: 72011.6 },
  vix: 13.92,
  vixPrevClose: 14.38,
};

export interface MockAgentOptions {
  /** Default "shadow", as the agent starts in production. */
  mode?: AgentMode;
  enabled?: boolean;
  paused?: boolean;
  /** Start halted by the 15% drawdown limit, with equity 15.18% under its peak (to try re-arm). */
  drawdownHalt?: boolean;
  levels?: MockAgentLevels;
}

/** The account kill switches the engine overlays on the view (the agent account's own and main's). */
export interface MockAgentFlags {
  killSwitch: boolean;
  killReason: string | null;
  mainKillSwitch: boolean;
}

const NO_FLAGS: MockAgentFlags = { killSwitch: false, killReason: null, mainKillSwitch: false };

/** The text the demo proposes in its nightly review: the built-in guidance with two lessons added. */
const DEMO_CANDIDATE_GUIDANCE = [
  BUILTIN_GUIDANCE,
  "- Give 0.45 while the close is still inside the opening range, whatever the other signals say.",
  "- Treat an option block older than 120 seconds as a reason for lower confidence, not only a missing one.",
].join("\n");

/** The demo's version label: the engine's own (its core version and the guidance's FNV-1a hash). */
const versionOf = instructionVersion;

// ---------------------------------------------------------------------------
// Small formatters (the view carries plain strings)
// ---------------------------------------------------------------------------

const groupFormats = new Map<number, Intl.NumberFormat>();
function grouped(n: number, decimals: number): string {
  let f = groupFormats.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    groupFormats.set(decimals, f);
  }
  return f.format(n);
}

function signed(n: number, decimals: number, suffix = ""): string {
  const s = Math.abs(n).toFixed(decimals);
  if (Number(s) === 0) return `${(0).toFixed(decimals)}${suffix}`;
  return `${n < 0 ? MINUS : "+"}${s}${suffix}`;
}

/** Basis points as a signed percent ("+0.12%"); "unknown" for null. */
const bpWords = (bp: number | null) => (bp == null ? "unknown" : signed(bp / 100, 2, "%"));
const bpOf = (level: number, close: number) => Math.round((level / close - 1) * 10_000);
const clampBp = (n: number) => Math.max(-9_999, Math.min(9_999, Math.round(n)));

// ---------------------------------------------------------------------------
// The demo market: a smooth deterministic path per index and day
// ---------------------------------------------------------------------------

interface DayPath {
  index: IndexId;
  date: string;
  /** Close of the bar ending at `ms` (09:15 is the open). */
  close(ms: number): number;
}

function dayPath(index: IndexId, date: string, levels: MockAgentLevels): DayPath {
  const seed = hashString(`agent-path:${date}:${index}`);
  const ph1 = (seed % 628) / 100;
  const ph2 = ((seed >>> 12) % 628) / 100;
  const open = istAt(date, "09:15");
  const move = (ms: number) => {
    const m = (ms - open) / MINUTE_MS;
    return 0.0021 * Math.sin((2 * Math.PI * m) / 190 + ph1) + 0.0009 * Math.sin((2 * Math.PI * m) / 41 + ph2) + 0.00002 * m;
  };
  // Anchored so the 11:42 close (the mock's start) is the fixture's spot.
  const anchor = move(istAt(date, "11:42"));
  return { index, date, close: (ms: number) => round2(levels.spot[index] * (1 + move(Math.max(open, ms)) - anchor)) };
}

/** Trading sessions after `date` up to and including `expiry`. */
function sessionsTo(date: string, expiry: string): number {
  let n = 0;
  for (let d = addDays(date, 1); d <= expiry && n < 30; d = addDays(d, 1)) if (isTradingDay(d, isMockHoliday)) n++;
  return n;
}

/** The weekly expiry the agent would buy: never one that expires on `date`. */
function buyableExpiry(index: IndexId, date: string): string {
  const e = nextWeeklyExpiry(index, istAt(date, "09:00"), isMockHoliday);
  return e === date ? nextWeeklyExpiry(index, istAt(addDays(date, 1), "09:00"), isMockHoliday) : e;
}

function snapshotAt(path: DayPath, T: number, levels: MockAgentLevels, book: { dd: number }, wideCall: boolean): IndexSnapshot {
  const { index, date } = path;
  const open = istAt(date, "09:15");
  const c = path.close(T);
  const at = (minutesBack: number) => path.close(Math.max(open, T - minutesBack * MINUTE_MS));
  const logBp = (a: number) => clampBp(Math.log(c / a) * 10_000);
  const closes: number[] = [];
  for (let t = open + BAR_MS; t <= T; t += BAR_MS) closes.push(path.close(t));
  const vwap = closes.reduce((s, x) => s + x, 0) / Math.max(1, closes.length);
  const sd = Math.sqrt(closes.reduce((s, x) => s + (x - vwap) ** 2, 0) / Math.max(1, closes.length)) || c * 0.0005;
  // The opening range: the open and the 09:20, 09:25 and 09:30 closes.
  const orBars = [path.close(open), path.close(open + BAR_MS), path.close(open + 2 * BAR_MS), path.close(open + 3 * BAR_MS)];
  const orHigh = Math.max(...orBars);
  const orLow = Math.min(...orBars);
  const formed = T >= open + 3 * BAR_MS;
  const r15 = logBp(at(15));
  const r60 = logBp(at(60));
  const rand = mulberry32(hashString(`agent-snap:${index}:${T}`));
  const step = STRIKE_STEP[index];
  const k = Math.round(c / step) * step;
  const premium = index === "NIFTY" ? 118 + 6 * rand() : 340 + 18 * rand();
  const vix = round2(levels.vix + 0.25 * Math.sin((T - open) / (47 * MINUTE_MS)));
  const iv = Math.round((12.4 + 1.2 * rand()) * 10) / 10;
  const expiry = buyableExpiry(index, date);
  const minutes = (T - istAt(date, "00:00")) / MINUTE_MS;
  return {
    c: Math.round(c * 10) / 10,
    r5: logBp(at(5)),
    r15,
    r60,
    ro: clampBp((c / path.close(open) - 1) * 10_000),
    vw: bpOf(vwap, c),
    vz: Math.round(((c - vwap) / sd) * 10) / 10,
    orh: formed ? bpOf(orHigh, c) : null,
    orl: formed ? bpOf(orLow, c) : null,
    ors: !formed ? "F" : c > orHigh ? "U" : c < orLow ? "D" : "I",
    pdh: bpOf(levels.prevHigh[index], c),
    pdl: bpOf(levels.prevLow[index], c),
    pdc: bpOf(levels.prevClose[index], c),
    rsi: Math.round(Math.max(22, Math.min(78, 50 + r15 / 2.2)) * 10) / 10,
    adx: Math.round(Math.max(11, Math.min(38, 15 + Math.abs(r60) / 5)) * 10) / 10,
    di: Math.round(Math.max(-25, Math.min(25, r60 / 4)) * 10) / 10,
    st: r60 > 6 ? 1 : r60 < -6 ? -1 : 0,
    rv: Math.round((10.5 + 2 * rand()) * 10) / 10,
    // % of the price, as the engine's snapshot writes it (only returns and distances are basis points).
    atr: (7 + Math.round(3 * rand())) / 100,
    vix,
    vixc: Math.round((vix / levels.vixPrevClose - 1) * 10_000) / 100,
    o: {
      k,
      cm: round2(premium),
      cs: wideCall ? 1.8 : round2(0.45 + 0.4 * rand()),
      pm: round2(premium * (0.9 + 0.15 * rand())),
      ps: round2(0.5 + 0.4 * rand()),
      iv,
      ivx: Math.round((iv - vix) * 10) / 10,
      pcr: round2(0.82 + 0.3 * rand()),
      mp: bpOf(k - step, c),
      cw: bpOf(k + 2 * step, c),
      pw: bpOf(k - 3 * step, c),
      bc: [Math.floor(5 * rand()), Math.floor(5 * rand()), Math.floor(4 * rand()), Math.floor(3 * rand())],
      bp: [Math.floor(4 * rand()), Math.floor(5 * rand()), Math.floor(4 * rand()), Math.floor(3 * rand())],
      oa: 18 + Math.floor(45 * rand()),
    },
    cv: round2(index === "NIFTY" ? 0.5 + r60 / 400 : 0.05 + r60 / 600),
    rg: index === "NIFTY" ? "TU" : "RG",
    pv: "C",
    pn: "kkckk",
    ew: minutes >= 9 * 60 + 25 && minutes <= 14 * 60 + 30 ? 1 : 0,
    dte: sessionsTo(date, expiry),
    xd: nextWeeklyExpiry(index, istAt(date, "09:00"), isMockHoliday) === date ? 1 : 0,
    bk: { pos: "-", lots: 0, pnl: null, dd: book.dd, dl: 0 },
  };
}

const ORS_WORDS: Record<IndexSnapshot["ors"], string> = { F: "still forming", I: "inside it", U: "broke up", D: "broke down" };
const RG_WORDS: Record<IndexSnapshot["rg"], string> = { TU: "trend up", TD: "trend down", RG: "range", HV: "high volatility", EV: "event" };
const PV_WORDS: Record<IndexSnapshot["pv"], string> = { C: "clear", A: "caution", X: "no trade" };

/** The snapshot as the page lists it: every field with a plain label. */
function snapshotFields(s: IndexSnapshot): AgentSnapshotFieldView[] {
  const f = (key: string, label: string, value: string): AgentSnapshotFieldView => ({ key, label, value });
  const rupees = (n: number | null) => (n == null ? "unknown" : `₹${grouped(n, 2)}`);
  const share = (n: number | null) => (n == null ? "unknown" : `${n.toFixed(2)}%`);
  const out: AgentSnapshotFieldView[] = [
    f("c", "Close", grouped(s.c, 1)),
    f("r5", "Return, last 5 minutes", bpWords(s.r5)),
    f("r15", "Return, last 15 minutes", bpWords(s.r15)),
    f("r60", "Return, last hour", bpWords(s.r60)),
    f("ro", "Return since today's open", bpWords(s.ro)),
    f("vw", "VWAP (the day's average price) from the close", bpWords(s.vw)),
    f("vz", "Distance from VWAP, in standard deviations", signed(s.vz, 1)),
    f("orh", "Opening-range high from the close", bpWords(s.orh)),
    f("orl", "Opening-range low from the close", bpWords(s.orl)),
    f("ors", "Opening range (09:15–09:30)", ORS_WORDS[s.ors]),
    f("pdh", "Previous day's high from the close", bpWords(s.pdh)),
    f("pdl", "Previous day's low from the close", bpWords(s.pdl)),
    f("pdc", "Previous day's close from the close", bpWords(s.pdc)),
    f("rsi", "RSI (14): momentum, 0 to 100", s.rsi.toFixed(1)),
    f("adx", "ADX (14): trend strength", s.adx.toFixed(1)),
    f("di", "+DI minus −DI: which way the trend points", signed(s.di, 1)),
    f("st", "Supertrend", s.st > 0 ? "up" : s.st < 0 ? "down" : "flat"),
    f("rv", "Realized volatility, last 2 hours (a year)", `${s.rv.toFixed(1)}%`),
    f("atr", "Average 5-minute range", `${s.atr.toFixed(2)}%`),
    f("vix", "India VIX (the fear gauge)", s.vix == null ? "unknown" : s.vix.toFixed(2)),
    f("vixc", "India VIX change today", signed(s.vixc, 2, "%")),
  ];
  if (s.o) {
    const o = s.o;
    out.push(
      f("o.k", "At-the-money strike", grouped(o.k, 0)),
      f("o.cm", "Call price (mid)", rupees(o.cm)),
      f("o.cs", "Call bid-ask spread", share(o.cs)),
      f("o.pm", "Put price (mid)", rupees(o.pm)),
      f("o.ps", "Put bid-ask spread", share(o.ps)),
      f("o.iv", "Implied volatility at the money", o.iv == null ? "unknown" : `${o.iv.toFixed(1)}%`),
      f("o.ivx", "Implied volatility minus India VIX", o.ivx == null ? "unknown" : `${signed(o.ivx, 1)} points`),
      f("o.pcr", "Put-call ratio (open interest)", o.pcr == null ? "unknown" : o.pcr.toFixed(2)),
      f("o.mp", "Max pain within ±15 monitored strikes, from the close", bpWords(o.mp)),
      f("o.cw", "Call wall (most call open interest) from the close", bpWords(o.cw)),
      f("o.pw", "Put wall (most put open interest) from the close", bpWords(o.pw)),
      f("o.bc", "Call build-up, last 5 min (long, short, covering, unwinding)", o.bc.join(", ")),
      f("o.bp", "Put build-up, last 5 min (long, short, covering, unwinding)", o.bp.join(", ")),
      f("o.oa", "Option data age", `${o.oa} s`),
    );
  } else out.push(f("o", "Option data", "missing"));
  out.push(
    f("cv", "Engine conviction (−1 to +1)", signed(s.cv, 2)),
    f("rg", "Engine regime", RG_WORDS[s.rg]),
    f("pv", "Today's plan", PV_WORDS[s.pv]),
    f("pn", "Plan rule statuses (N1 N2 N4 N7 N9)", s.pn),
    f("ew", "Inside the entry window (09:25–14:30)", s.ew ? "yes" : "no"),
    f("dte", "Trading sessions to the contract's expiry", String(s.dte)),
    f("xd", "Expiry day for this index", s.xd ? "yes" : "no"),
    f("bk.pos", "The agent's position on this index", s.bk.pos === "L" ? "a call" : s.bk.pos === "S" ? "a put" : "none"),
    f("bk.lots", "Lots held", String(s.bk.lots)),
    f("bk.pnl", "Open P&L (% of premium)", s.bk.pnl == null ? "none" : signed(s.bk.pnl, 1, "%")),
    f("bk.dd", "Account drawdown from its peak", `${s.bk.dd.toFixed(2)}%`),
    f("bk.dl", "Today's loss used (% of equity)", `${s.bk.dl.toFixed(2)}%`),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Finalists and the demo decisions
// ---------------------------------------------------------------------------

function genericFinalist(index: IndexId): AgentFinalistView {
  return { id: `gen:${index}`, kind: "GENERIC", index, label: `${index}: the best call or put right now`, side: null, contract: null, condition: null, wrongIf: null, bearCase: null, briefId: null };
}

function demoIdea(date: string, levels: MockAgentLevels): AgentFinalistView {
  const step = STRIKE_STEP.NIFTY;
  const strike = Math.round(levels.spot.NIFTY / step) * step + step;
  const expiry = buyableExpiry("NIFTY", date);
  const briefId = `demo-brief-${date}`;
  return {
    id: `idea:${briefId}:nifty-ce`,
    kind: "IDEA",
    index: "NIFTY",
    label: `Demo idea from the 09:26 brief: NIFTY ${strike} CE`,
    side: "LONG",
    contract: { tradingSymbol: mockTradingSymbol("NIFTY", expiry, strike, "CE"), strike, optionType: "CE", expiry },
    condition: `Only if NIFTY holds above ${grouped(strike - 2 * step, 0)} on a 5-minute close`,
    wrongIf: `NIFTY closes a 5-minute candle below ${grouped(strike - 3 * step, 0)}`,
    bearCase: "Demo: banks are lagging the index, and a hawkish RBI tone could cap the move.",
    briefId,
  };
}

interface DemoDecision {
  finalistId: string;
  index: IndexId;
  source: "REFLEX" | "ESCALATION";
  regime: AgentRegime;
  direction: AgentDirection;
  directionConfidence: number;
  toxicFlow: boolean;
  setupQuality: 0 | 1 | 2 | 3;
  riskState: AgentRiskLevel;
  reason: string;
}

const MOVE_WORDS = (s: IndexSnapshot) => `${bpWords(s.ro)} on the day, ${s.vw < 0 ? "above" : "below"} VWAP, ADX ${s.adx.toFixed(0)}`;

/** The deep model's demo answer to the escalation, as the brain merged it into the next candle. */
const ESCALATED: Omit<DemoDecision, "finalistId" | "index" | "source"> = {
  regime: "MEAN_REVERTING",
  direction: "NEUTRAL",
  directionConfidence: 0.45,
  toxicFlow: false,
  setupQuality: 1,
  riskState: "SAFE",
  reason: "Demo: on a second look SENSEX keeps swinging around VWAP with a weak ADX; the earlier lean up was too thin to trade.",
};

/**
 * One decision per finalist for the candle closing at T. The 11:35 and 11:40 candles tell the escalation story;
 * other candles rotate through three scenes (one call that passes every check, one blocked by confidence or
 * side, one blocked by data or risk). No other low-confidence call on a good setup appears, so no other
 * escalation would have been asked for.
 */
function demoDecisions(date: string, T: number, finalists: readonly AgentFinalistView[], snaps: Record<IndexId, IndexSnapshot>): DemoDecision[] {
  const at = (hhmm: string) => istAt(date, hhmm);
  const scene = T === at(SHOWCASE_BAR) ? "showcase" : T === at(ESCALATION_BAR) ? "escalation" : (["fire", "confidence", "data"] as const)[Math.round((T - at(AGENT_POLICY.reflexFirstBarIst)) / BAR_MS) % 3];
  const lean = (index: IndexId): AgentDirection => (snaps[index].r15 >= 0 ? "LONG" : "SHORT");
  const out: DemoDecision[] = [];
  for (const f of finalists) {
    const rand = mulberry32(hashString(`agent-decision:${f.id}:${T}`));
    const s = snaps[f.index];
    const conf = (lo: number, hi: number) => round2(lo + (hi - lo) * rand());
    const d = (x: Omit<DemoDecision, "finalistId" | "index" | "source" | "toxicFlow" | "riskState"> & Partial<Pick<DemoDecision, "toxicFlow" | "riskState" | "source">>): DemoDecision => ({
      finalistId: f.id,
      index: f.index,
      source: x.source ?? "REFLEX",
      toxicFlow: x.toxicFlow ?? false,
      riskState: x.riskState ?? "SAFE",
      ...x,
    });
    if (f.kind === "IDEA") {
      if (scene === "showcase" || scene === "escalation")
        out.push(d({ regime: "TRENDING", direction: "LONG", directionConfidence: scene === "showcase" ? 0.64 : 0.61, setupQuality: 1, reason: `Demo: NIFTY is ${MOVE_WORDS(s)}; the idea's level is close but not yet held on a close.` }));
      else if (scene === "fire") out.push(d({ regime: "TRENDING", direction: "NEUTRAL", directionConfidence: conf(0.45, 0.5), setupQuality: 1, reason: "Demo: the idea's condition is not met yet: NIFTY has not closed above its level." }));
      else if (scene === "confidence") out.push(d({ regime: "MEAN_REVERTING", direction: "SHORT", directionConfidence: conf(0.68, 0.74), setupQuality: 2, reason: "Demo: the last candles lean down, against this call idea." }));
      else out.push(d({ regime: "TRENDING", direction: "LONG", directionConfidence: conf(0.82, 0.86), setupQuality: 2, reason: `Demo: the condition is met and NIFTY is ${MOVE_WORDS(s)}.` }));
      continue;
    }
    if (f.index === "NIFTY") {
      if (scene === "showcase") out.push(d({ regime: "TRENDING", direction: "LONG", directionConfidence: 0.86, setupQuality: 3, reason: `Demo: NIFTY is ${MOVE_WORDS(s)}; the 5-, 15- and 60-minute returns agree and the call spread is ${s.o?.cs ?? "?"}%.` }));
      else if (scene === "escalation") out.push(d({ regime: "TRENDING", direction: "LONG", directionConfidence: 0.78, setupQuality: 2, reason: `Demo: NIFTY is ${MOVE_WORDS(s)}, but the hourly return is small.` }));
      else if (scene === "fire") out.push(d({ regime: "TRENDING", direction: lean("NIFTY"), directionConfidence: conf(0.81, 0.89), setupQuality: rand() < 0.5 ? 2 : 3, reason: `Demo: NIFTY is ${MOVE_WORDS(s)}; the short and hourly returns agree.` }));
      else if (scene === "confidence") out.push(d({ regime: "TRENDING", direction: lean("NIFTY"), directionConfidence: conf(0.66, 0.79), setupQuality: 2, reason: `Demo: NIFTY is ${MOVE_WORDS(s)}, but the returns disagree across 5, 15 and 60 minutes.` }));
      else out.push(d({ regime: "MEAN_REVERTING", direction: "NEUTRAL", directionConfidence: conf(0.5, 0.55), setupQuality: 1, reason: "Demo: price is back near VWAP and the call spread is wide; no side has the edge." }));
      continue;
    }
    if (scene === "showcase") out.push({ finalistId: f.id, index: f.index, source: "ESCALATION", ...ESCALATED });
    else if (scene === "escalation") out.push(d({ regime: "MEAN_REVERTING", direction: "LONG", directionConfidence: 0.55, setupQuality: 2, reason: "Demo: SENSEX ticks up from VWAP, but ADX is weak; a lean, not a call." }));
    else if (scene === "fire") out.push(d({ regime: "MEAN_REVERTING", direction: "NEUTRAL", directionConfidence: conf(0.46, 0.5), setupQuality: rand() < 0.5 ? 0 : 1, reason: "Demo: SENSEX is inside its opening range; no direction." }));
    else if (scene === "confidence") out.push(d({ regime: "TRENDING", direction: lean("SENSEX"), directionConfidence: conf(0.81, 0.88), setupQuality: rand() < 0.5 ? 2 : 3, reason: `Demo: SENSEX is ${MOVE_WORDS(s)}; the returns agree.` }));
    else out.push(d({ regime: "HIGH_VOL", direction: lean("SENSEX"), directionConfidence: conf(0.7, 0.76), setupQuality: 2, riskState: "NEAR_LIMIT", reason: "Demo: SENSEX is jumpy; a direction, but too risky to call firmly." }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The code's gate, in the engine's order (SPEC §5.1), worded for the page
// ---------------------------------------------------------------------------

const RISK_RANK: Record<AgentRiskLevel, number> = { SAFE: 0, NEAR_LIMIT: 1, REDUCE: 2 };
const REGIME_NAME: Record<AgentRegime, string> = { TRENDING: "trending", MEAN_REVERTING: "swinging back and forth", HIGH_VOL: "high volatility", CRISIS: "crisis" };
const SHORT_NAME: Record<string, string> = {
  fresh: "too old",
  batch_ok: "answer not usable",
  setup_quality: "setup quality",
  confidence: "confidence",
  direction: "no direction",
  regime: "crisis regime",
  idea_side: "wrong side for the idea",
  toxic_model: "toxic flow (model)",
  toxic_code: "option data or spread",
  risk_state: "risk state",
  entry_mode: "entries stopped",
};

function demoGate(d: DemoDecision, f: AgentFinalistView, s: IndexSnapshot, ctx: { lagMs: number; codeRisk: AgentRiskLevel; halted: boolean }): { fired: boolean; summary: string; lines: AgentGateLineView[] } {
  const p = AGENT_POLICY;
  const side = d.direction === "NEUTRAL" ? null : d.direction;
  const spread = side == null || !s.o ? null : side === "LONG" ? s.o.cs : s.o.ps;
  const optionsOk = s.o != null && s.o.oa <= p.maxOptionAgeSec && (side == null || (spread != null && spread <= p.maxSnapshotSpreadPct));
  const effective = RISK_RANK[d.riskState] >= RISK_RANK[ctx.codeRisk] ? d.riskState : ctx.codeRisk;
  const word = (r: AgentRiskLevel) => (r === "SAFE" ? "safe" : r === "NEAR_LIMIT" ? "near a limit" : "reduce");
  const ideaSide = f.side === "LONG" ? "Up" : "Down";
  const lines: AgentGateLineView[] = [
    { gate: "fresh", passed: ctx.lagMs <= p.maxDecisionAgeMs, words: `Acted on ${Math.round(ctx.lagMs / 1000)} s after the candle closed (limit ${p.maxDecisionAgeMs / MINUTE_MS} min)` },
    { gate: "batch_ok", passed: true, words: "The model's answer was complete and passed every format check" },
    { gate: "setup_quality", passed: d.setupQuality >= p.minSetupQuality, words: `Setup quality ${d.setupQuality} of 3 (needs ${p.minSetupQuality})` },
    { gate: "confidence", passed: d.directionConfidence > p.minConfidenceExclusive, words: `Confidence ${d.directionConfidence.toFixed(2)} (needs more than ${p.minConfidenceExclusive.toFixed(2)})` },
    { gate: "direction", passed: side != null, words: side == null ? "No direction given" : `Direction given: ${side === "LONG" ? "Up" : "Down"}` },
    { gate: "regime", passed: d.regime !== "CRISIS", words: `Regime ${REGIME_NAME[d.regime]} (crisis blocks)` },
    {
      gate: "idea_side",
      passed: f.kind === "GENERIC" || d.direction === f.side,
      words: f.kind === "GENERIC" ? "Generic finalist: either side is allowed" : `The idea buys a ${f.side === "LONG" ? "call" : "put"}, so the model must say ${ideaSide}`,
    },
    { gate: "toxic_model", passed: !d.toxicFlow, words: d.toxicFlow ? "The model flagged toxic flow" : "The model saw no toxic flow" },
    {
      gate: "toxic_code",
      passed: optionsOk,
      words: !s.o
        ? "No option data in the snapshot"
        : `Option data ${s.o.oa} s old (max ${p.maxOptionAgeSec} s)${spread == null ? "" : `; ${side === "LONG" ? "call" : "put"} spread ${spread.toFixed(2)}% (max ${p.maxSnapshotSpreadPct}%)`}`,
    },
    { gate: "risk_state", passed: effective === "SAFE", words: `Risk ${word(d.riskState)} by the model, ${word(ctx.codeRisk)} by the code (needs safe)` },
    { gate: "entry_mode", passed: !ctx.halted, words: ctx.halted ? `Entries stopped: the ${AGENT_LIMITS.maxDrawdownPct}% drawdown halt is on` : "Entries allowed: no halt" },
  ];
  const blocked = lines.filter((l) => l.passed === false);
  return { fired: blocked.length === 0, summary: blocked.length ? `Blocked: ${blocked.map((l) => SHORT_NAME[l.gate] ?? l.gate).join(", ")}` : "All checks passed", lines };
}

// ---------------------------------------------------------------------------
// The demo agent
// ---------------------------------------------------------------------------

interface Decided {
  status: "APPROVED" | "REJECTED";
  at: number;
  by: string;
}

/** The calibration behind sizing in the demo: graded reflex calls above 0.80, after overlapping windows count once. */
const DEMO_SIZING = { p: 0.43, n: 21 } as const;

export class MockAgent {
  private readonly mode: AgentMode;
  private readonly enabled: boolean;
  private readonly paused: boolean;
  private readonly levels: MockAgentLevels;
  private halted: boolean;
  private equity: number;
  private peak: number;
  private active = { guidance: BUILTIN_GUIDANCE, version: versionOf(BUILTIN_GUIDANCE) };
  private readonly decided = new Map<string, Decided>();

  constructor(
    private readonly now: () => number,
    opts: MockAgentOptions = {},
  ) {
    this.mode = opts.mode ?? "shadow";
    this.enabled = opts.enabled ?? true;
    this.paused = opts.paused ?? false;
    this.levels = opts.levels ?? DEFAULT_AGENT_LEVELS;
    this.halted = opts.drawdownHalt ?? false;
    this.equity = this.halted ? HALTED_EQUITY : AGENT_LIMITS.capitalRupees;
    this.peak = AGENT_LIMITS.capitalRupees;
  }

  /** Clears the drawdown halt; the peak restarts at the current equity. The engine also clears the account's kill switch. */
  rearm(actor: string): void {
    void actor;
    this.halted = false;
    this.peak = this.equity;
  }

  /** Approve or reject the pending candidate, with the engine's rules: pending only, and approval only outside the session. */
  decideCandidate(id: string, decision: "approve" | "reject", actor: string): { ok: boolean; message: string } {
    const now = this.now();
    const current = this.candidateDate(now);
    if (id !== candidateId(current)) return { ok: false, message: "No candidate with that id is waiting." };
    const done = this.decided.get(id);
    if (done) return { ok: false, message: `Only a pending candidate can be decided; this one was ${done.status.toLowerCase()}.` };
    if (decision === "approve" && sessionPhaseAt(now, isMockHoliday) === "OPEN") return { ok: false, message: "Approve after 15:30 IST, so that one session is judged by one text." };
    this.decided.set(id, { status: decision === "approve" ? "APPROVED" : "REJECTED", at: now, by: actor });
    if (decision === "approve") this.active = { guidance: DEMO_CANDIDATE_GUIDANCE, version: versionOf(DEMO_CANDIDATE_GUIDANCE) };
    return { ok: true, message: decision === "approve" ? "Approved: the new text is used from the next candle." : "Rejected: the current text stays." };
  }

  /** The view for an IST date (default: the mock's today), as of the mock clock. */
  view(date?: string, account: AccountView | null = null, flags: MockAgentFlags = NO_FLAGS): AgentView {
    const now = this.now();
    const today = istDate(now);
    const day = date ?? today;
    const sessionDay = isTradingDay(day, isMockHoliday);
    // A past day reads as of its close; a future day has nothing yet.
    const asOf = day < today ? istAt(day, "23:59") : day > today ? istAt(day, "00:00") : now;
    const on = this.enabled && this.mode !== "off";
    const judged = on && sessionDay ? latestBar(day, asOf, JUDGED_AFTER_MS, AGENT_POLICY.reflexLastBarIst) : null;
    const stored = on && sessionDay ? latestBar(day, asOf, MINUTE_MS, LAST_STORED_BAR) : null;
    const risk = this.riskView(asOf, flags);
    const finalists = judged == null ? [] : finalistsAt(day, judged, this.levels);
    const indices = INDICES.map((index) => this.card(index, day, judged, asOf, finalists, risk));
    const escalations = judged == null ? [] : escalationsFor(day, asOf);
    const reviewDate = this.reviewDateFor(day, now);
    const phase = sessionPhaseAt(asOf, isMockHoliday);
    const firstBar = istAt(day, AGENT_POLICY.reflexFirstBarIst);
    const lastBar = istAt(day, AGENT_POLICY.reflexLastBarIst);
    const state: AgentView["status"]["state"] = !on
      ? "OFF"
      : !sessionDay || day !== today || (phase !== "OPEN" && phase !== "PRE_OPEN") || asOf > lastBar + ACTED_AFTER_MS
        ? "CLOSED"
        : asOf < firstBar + JUDGED_AFTER_MS
          ? "WAITING"
          : "RUNNING";
    return {
      mode: this.enabled ? this.mode : "off",
      enabled: this.enabled,
      date: day,
      generatedAt: toIstIso(now),
      honesty: `Demo data, made up by code: no model is called. ${AGENT_HONESTY}`,
      account,
      models: { reflex: MOCK_AGENT_MODEL, escalation: MOCK_AGENT_MODEL, review: MOCK_AGENT_MODEL },
      instructionVersion: this.active.version,
      status: { state, lastBarAt: stored == null ? null : toIstIso(stored), lastError: null, paused: this.paused },
      indices,
      finalists,
      escalations,
      risk,
      calibration: this.calibration(reviewDate),
      review: review(reviewDate),
      candidate: this.candidate(this.candidateDate(now)),
      cost: cost(day, judged, escalations, asOf),
    };
  }

  // -------------------------------------------------------------------------

  private card(index: IndexId, day: string, judged: number | null, asOf: number, finalists: AgentFinalistView[], risk: AgentRiskView): AgentIndexCardView {
    if (judged == null) return { index, barAt: null, close: null, snapshot: null, snapshotTokensEst: null, decisions: [], position: null };
    const book = { dd: Math.round((risk.drawdownPct ?? 0) * 100) / 100 };
    const snaps = Object.fromEntries(INDICES.map((i) => [i, this.snapshot(i, day, judged, book)])) as Record<IndexId, IndexSnapshot>;
    const s = snaps[index];
    const decisions = demoDecisions(day, judged, finalists, snaps)
      .filter((d) => d.index === index)
      .map((d) => this.decisionView(d, finalists.find((f) => f.id === d.finalistId) ?? genericFinalist(index), s, judged, asOf, risk));
    return {
      index,
      barAt: toIstIso(judged),
      close: s.c,
      snapshot: snapshotFields(s),
      // The demo's estimate, on the snapshot as compact JSON with bare keys; the engine's own encoding sets the real figure.
      snapshotTokensEst: Math.ceil(JSON.stringify(s).replace(/"(\w+)":/g, "$1:").length / CHARS_PER_TOKEN_BOUND),
      decisions,
      position: null,
    };
  }

  private snapshot(index: IndexId, day: string, T: number, book: { dd: number }): IndexSnapshot {
    const scene = Math.round((T - istAt(day, AGENT_POLICY.reflexFirstBarIst)) / BAR_MS) % 3;
    // The "data" scene widens NIFTY's call spread, so the code's own toxicity check is what blocks.
    const wideCall = index === "NIFTY" && scene === 2 && T !== istAt(day, SHOWCASE_BAR) && T !== istAt(day, ESCALATION_BAR);
    return snapshotAt(dayPath(index, day, this.levels), T, this.levels, book, wideCall);
  }

  private decisionView(d: DemoDecision, f: AgentFinalistView, s: IndexSnapshot, T: number, asOf: number, risk: AgentRiskView): AgentDecisionView {
    const acted = asOf >= T + ACTED_AFTER_MS;
    const base: AgentDecisionView = {
      id: `dec-${fnv1aHex(`${d.finalistId}:${T}`)}`,
      barAt: toIstIso(T),
      finalistId: d.finalistId,
      source: d.source,
      regime: d.regime,
      direction: d.direction,
      directionConfidence: d.directionConfidence,
      toxicFlow: d.toxicFlow,
      setupQuality: d.setupQuality,
      riskState: d.riskState,
      reason: d.reason,
      gate: null,
      action: null,
      actionDetail: null,
      edge: null,
      sizing: null,
      outcome: { status: "PENDING", ret30Pct: null },
    };
    if (!acted) return base;
    const gate = demoGate(d, f, s, { lagMs: ACTED_AFTER_MS, codeRisk: risk.codeRiskState, halted: risk.drawdownHalt });
    if (!gate.fired) return { ...base, gate, action: "NO_ENTRY", actionDetail: gate.summary };
    // Every check passed; Kelly is the next step, and with p under 0.50 at b = 1 it sizes nothing.
    const p = DEMO_SIZING.p;
    const b = 1;
    const kelly = round2(p - (1 - p) / b);
    return {
      ...base,
      gate,
      action: "NO_ENTRY",
      actionDetail: `Kelly ≤ 0: no measured edge yet (p=${p.toFixed(2)}, b=${b.toFixed(2)})`,
      sizing: { p, b, kelly, riskPct: 0, lots: 0 },
    };
  }

  private riskView(asOf: number, flags: MockAgentFlags): AgentRiskView {
    const dd = this.peak > 0 ? Math.max(0, (1 - this.equity / this.peak) * 100) : 0;
    const L = AGENT_LIMITS;
    const codeRisk: AgentRiskLevel = dd >= L.reduceDrawdownPct ? "REDUCE" : dd >= L.nearDrawdownPct ? "NEAR_LIMIT" : "SAFE";
    const killSwitch = flags.killSwitch || this.halted;
    return {
      asOf: toIstIso(asOf - 10_000),
      equity: this.equity,
      peakEquity: this.peak,
      drawdownPct: round2(dd),
      maxDrawdownPct: L.maxDrawdownPct,
      dayLossPct: 0,
      dailyLossCapPct: L.dailyLossCapPct,
      openPositions: 0,
      maxOpenPositions: L.maxOpenTotal,
      maxLotsPerPosition: L.maxLotsPerPosition,
      killSwitch,
      killReason: killSwitch ? (flags.killReason ?? `max drawdown ${L.maxDrawdownPct}% reached: re-arm on the Agent page`) : null,
      mainKillSwitch: flags.mainKillSwitch,
      drawdownHalt: this.halted,
      codeRiskState: codeRisk,
    };
  }

  /** The latest review on or before the day that exists by now (a session's review is written at 16:23). */
  private reviewDateFor(day: string, now: number): string {
    const latestBy = (d: string, t: number) => (isTradingDay(d, isMockHoliday) && t >= istAt(d, REVIEW_AT) ? d : prevTradingDay(d, isMockHoliday));
    const latest = latestBy(istDate(now), now);
    const forDay = latestBy(day, now);
    return forDay < latest ? forDay : latest;
  }

  /** The day of the newest candidate (written at 16:31 after each session's review). */
  private candidateDate(now: number): string {
    const today = istDate(now);
    return isTradingDay(today, isMockHoliday) && now >= istAt(today, CANDIDATE_AT) ? today : prevTradingDay(today, isMockHoliday);
  }

  private candidate(date: string): AgentCandidateView {
    const id = candidateId(date);
    const done = this.decided.get(id) ?? null;
    const rand = mulberry32(hashString(`agent-replay:${date}`));
    const current = 0.245 + 0.01 * rand();
    return {
      id,
      date,
      createdAt: toIstIso(istAt(date, CANDIDATE_AT)),
      status: done?.status ?? "PENDING",
      baseVersion: versionOf(BUILTIN_GUIDANCE),
      guidance: DEMO_CANDIDATE_GUIDANCE,
      currentGuidance: BUILTIN_GUIDANCE,
      rationale:
        "Demo: the review found confident calls while the close was still inside the opening range, and on option data two to three minutes old. Both kinds were wrong more often than the rest, so the text asks for lower confidence there.",
      wouldBeWrongIf: "Demo: over the next five sessions the Brier score of calls above 0.80 does not improve, or the agent stops making calls above 0.80 at all.",
      replay: {
        bars: 75,
        graded: 64,
        brierCandidate: Math.round((current - 0.006) * 10_000) / 10_000,
        brierCurrentReplayed: Math.round(current * 10_000) / 10_000,
        brierCurrentLive: Math.round((current + 0.007) * 10_000) / 10_000,
        firesCandidate: 2,
        firesCurrent: 5,
        complete: true,
        label: "in-sample, not proof",
      },
      decidedAt: done ? toIstIso(done.at) : null,
      decidedBy: done?.by ?? null,
    };
  }

  private calibration(reviewDate: string): AgentCalibrationView {
    const bucket = (from: number, to: number, n: number, statedMean: number, hitRate: number, paidRate: number) => ({ from, to, n, statedMean, hitRate, paidRate });
    return {
      asOf: toIstIso(istAt(reviewDate, REVIEW_AT)),
      graded: 236,
      brier: 0.2514,
      baselineBrier: 0.2475,
      byIndex: [
        { index: "NIFTY", n: 121, brier: 0.2488 },
        { index: "SENSEX", n: 115, brier: 0.2541 },
      ],
      byKind: [
        { kind: "GENERIC", n: 188, brier: 0.2502 },
        { kind: "IDEA", n: 48, brier: 0.2561 },
      ],
      bySource: [
        { source: "REFLEX", n: 229, brier: 0.2509 },
        { source: "ESCALATION", n: 7, brier: 0.268 },
      ],
      neutral: { n: 154, brier: 0.2312, baselineBrier: 0.2259 },
      buckets: [
        bucket(0, 0.5, 18, 0.47, 0.44, 0.17),
        bucket(0.5, 0.6, 64, 0.56, 0.45, 0.23),
        bucket(0.6, 0.7, 71, 0.65, 0.46, 0.27),
        bucket(0.7, 0.8, 49, 0.74, 0.47, 0.29),
        bucket(0.8, 0.9, 29, 0.84, 0.48, 0.31),
        bucket(0.9, 1, 5, 0.92, 0.4, 0.2),
      ],
      sizingMode: "pooled",
      sizingP: DEMO_SIZING.p,
      sizingN: DEMO_SIZING.n,
      payoffB: 1,
      payoffMeasured: null,
      payoffTrades: 0,
      paidRate: 0.27,
      trades: { n: 0, wins: 0, netRupees: 0 },
      note: "Demo data, made up by code to show the layout. In the real agent every number here comes from graded decisions.",
    };
  }
}

// ---------------------------------------------------------------------------
// Day-level pieces
// ---------------------------------------------------------------------------

const candidateId = (date: string) => `cand-${date}`;

/** The latest bar closing in [09:20, lastIst] whose result is visible `lagMs` after its close; null before the first. */
function latestBar(day: string, asOf: number, lagMs: number, lastIst: string): number | null {
  const first = istAt(day, AGENT_POLICY.reflexFirstBarIst);
  const last = istAt(day, lastIst);
  if (asOf < first + lagMs) return null;
  const n = Math.floor((Math.min(asOf - lagMs, last) - first) / BAR_MS);
  return first + n * BAR_MS;
}

/** The finalists of the candle at T: a generic one per index, and the demo brief's idea once the brief exists. */
function finalistsAt(day: string, T: number, levels: MockAgentLevels): AgentFinalistView[] {
  const out = INDICES.map(genericFinalist);
  if (T >= istAt(day, BRIEF_AT)) out.splice(1, 0, demoIdea(day, levels));
  return out;
}

function escalationsFor(day: string, asOf: number): AgentEscalationView[] {
  const bar = istAt(day, ESCALATION_BAR);
  const requested = bar + JUDGED_AFTER_MS + 5_000;
  if (asOf < requested) return [];
  const done = requested + 70_000;
  const next = bar + BAR_MS;
  const finished = asOf >= done;
  return [
    {
      id: `esc-${day}-sensex-1135`,
      requestedAt: toIstIso(requested),
      index: "SENSEX",
      finalistId: "gen:SENSEX",
      trigger: "LOW_CONFIDENCE",
      status: finished ? "DONE" : "RUNNING",
      decision: finished
        ? { direction: ESCALATED.direction, directionConfidence: ESCALATED.directionConfidence, setupQuality: ESCALATED.setupQuality, regime: ESCALATED.regime, riskState: ESCALATED.riskState, reason: ESCALATED.reason }
        : null,
      reason: finished
        ? `Demo: the fast model leaned up at 0.55 on a setup of 2. On ${ESCALATION.contextBars} candles of context the moves are small and keep reverting to VWAP, so the deep model calls no direction.`
        : null,
      appliedToBarAt: asOf >= next + JUDGED_AFTER_MS ? toIstIso(next) : null,
      costUsd: finished ? 0 : null,
    },
  ];
}

function review(date: string): AgentReviewView {
  return {
    date,
    status: "DONE",
    writtenAt: toIstIso(istAt(date, REVIEW_AT)),
    model: MOCK_AGENT_MODEL,
    costUsd: 0,
    summary:
      "Demo review. The agent ran in shadow mode: it judged every candle from 09:20 to 15:05 on both indices and made no trade, because sizing had no measured edge to work with. Its confident calls were right about as often as always guessing the base rate, which is what the project's research would expect for option buyers.",
    fills: [],
    misses: [
      "Demo: SENSEX fell 0.4% between 13:05 and 13:35 while every call on it said no direction.",
      "Demo: three NIFTY calls above 0.80 between 10:00 and 10:30 were followed by moves under 0.03%: false alarms.",
    ],
    mistakes: ["Demo: confidence above 0.80 while the close was still inside the opening range.", "Demo: confident calls on option data two to three minutes old."],
    lessons: ["Demo: say 0.45 while the close is inside the opening range.", "Demo: treat option data older than two minutes as a reason for lower confidence."],
    error: null,
  };
}

function cost(day: string, judged: number | null, escalations: readonly AgentEscalationView[], asOf: number): AgentCostView {
  const calls = judged == null ? 0 : Math.round((judged - istAt(day, AGENT_POLICY.reflexFirstBarIst)) / BAR_MS) + 1;
  const reviewed = isTradingDay(day, isMockHoliday) && asOf >= istAt(day, REVIEW_AT);
  return {
    date: day,
    spentUsd: 0,
    capUsd: 3,
    capReached: false,
    byKind: [
      { kind: "REFLEX", calls, usd: 0 },
      { kind: "ESCALATION", calls: escalations.length, usd: 0 },
      { kind: "REVIEW", calls: reviewed ? 1 : 0, usd: 0 },
      { kind: "REPLAY", calls: reviewed && asOf >= istAt(day, CANDIDATE_AT) ? 10 : 0, usd: 0 },
    ],
    reflexLatencyMs: { p50: null, p95: null },
  };
}
