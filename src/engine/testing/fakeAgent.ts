/**
 * Test fakes for the options agent: judges that answer from a function instead of the API, an option-flow view and
 * an Advisor brief with plausible defaults. The fake judges check their answers the way the real ones do (only the
 * finalists on an index with a snapshot are asked; decisions go through validateBatch; deep answers through the
 * request's schema), so a test sees the statuses and drops production would.
 */
import { AGENT_DEFAULTS } from "../agent/config";
import type { DeepJudge, DeepRequest, DeepResponse, ReflexJudge, ReflexRequest, ReflexResponse } from "../agent/judge";
import { promptFinalists } from "../agent/prompt";
import type { ReflexDecision } from "../agent/types";
import { validateBatch } from "../agent/validate";
import type { AdvisorIdea, AdvisorReport, FlowSideView, FlowStrikeRow, OptionFlowView } from "../api-types";
import { addDays, istDate, istIso } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import type { LlmUsage } from "../ports";
import type { IndexId } from "../types";

/** What a fake reflex call answers: decisions, or how the call failed. */
export type FakeReflexAnswer = ReflexDecision[] | "fail" | "refuse" | "timeout" | "parse_error";

export const FAKE_REFLEX_USAGE: LlmUsage = { inputTokens: 1_800, outputTokens: 700, cacheReadTokens: 1_500, cacheCreationTokens: 0 };
export const FAKE_DEEP_USAGE: LlmUsage = { inputTokens: 4_500, outputTokens: 3_000, cacheReadTokens: 1_500, cacheCreationTokens: 0 };

export class FakeReflexJudge implements ReflexJudge {
  readonly kind = "fake" as const;
  readonly model: string;
  /** Every request, in order. */
  readonly calls: ReflexRequest[] = [];
  private readonly usage: LlmUsage;
  private readonly latencyMs: number;

  constructor(
    private readonly decide: (req: ReflexRequest) => FakeReflexAnswer,
    o: { usage?: LlmUsage; latencyMs?: number; model?: string } = {},
  ) {
    this.model = o.model ?? AGENT_DEFAULTS.reflexModel;
    this.usage = o.usage ?? FAKE_REFLEX_USAGE;
    this.latencyMs = o.latencyMs ?? 1_200;
  }

  async judge(req: ReflexRequest): Promise<ReflexResponse> {
    this.calls.push(req);
    const base = { decisions: [] as ReflexDecision[], dropped: [] as string[], model: this.model, latencyMs: this.latencyMs };
    if (req.signal?.aborted) return { ...base, status: "TIMEOUT", usage: null, error: "The call was stopped by its caller." };
    const asked = promptFinalists(req.input, req.finalists);
    if (asked.length === 0) return { ...base, status: "ERROR", usage: null, latencyMs: 0, error: "No finalist has a snapshot, so there was nothing to ask." };
    const answer = this.decide(req);
    if (answer === "fail") return { ...base, status: "ERROR", usage: null, error: "The call failed (fake judge)." };
    if (answer === "timeout") return { ...base, status: "TIMEOUT", usage: null, error: "No answer in time (fake judge)." };
    if (answer === "refuse") return { ...base, status: "REFUSED", usage: { ...this.usage }, error: "The model declined to answer (fake judge)." };
    if (answer === "parse_error") return { ...base, status: "PARSE_ERROR", usage: { ...this.usage }, error: "The answer was not complete JSON (fake judge)." };
    const v = validateBatch({ decisions: answer }, asked);
    if (!v.ok) return { ...base, status: "PARSE_ERROR", usage: { ...this.usage }, error: v.error };
    return { ...base, status: "OK", decisions: v.decisions, dropped: v.dropped, usage: { ...this.usage }, error: null };
  }
}

/** What a fake deep call answers: a value checked against the request's schema, or how the call failed. */
export type FakeDeepAnswer = unknown;

export class FakeDeepJudge implements DeepJudge {
  readonly model: string;
  /** Every request, in order. */
  readonly calls: DeepRequest<unknown>[] = [];
  private readonly usage: LlmUsage;
  private readonly latencyMs: number;

  /** `answer` returns the parsed answer, or "fail" | "refuse" | "timeout" | "max_tokens". */
  constructor(
    private readonly answer: (req: DeepRequest<unknown>) => FakeDeepAnswer,
    o: { usage?: LlmUsage; latencyMs?: number; model?: string } = {},
  ) {
    this.model = o.model ?? AGENT_DEFAULTS.escalationModel;
    this.usage = o.usage ?? FAKE_DEEP_USAGE;
    this.latencyMs = o.latencyMs ?? 30_000;
  }

  async structured<T>(req: DeepRequest<T>): Promise<DeepResponse<T>> {
    const asked = req as unknown as DeepRequest<unknown>;
    this.calls.push(asked);
    const base = { parsed: null, model: this.model, latencyMs: this.latencyMs, iterations: null };
    if (req.signal?.aborted) return { ...base, status: "TIMEOUT", usage: null, error: "The call was stopped by its caller." };
    const a = this.answer(asked);
    if (a === "fail") return { ...base, status: "ERROR", usage: null, error: "The call failed (fake judge)." };
    if (a === "timeout") return { ...base, status: "TIMEOUT", usage: null, error: "No answer in time (fake judge)." };
    if (a === "refuse") return { ...base, status: "REFUSED", usage: { ...this.usage }, error: "The model declined to answer (fake judge)." };
    if (a === "max_tokens") return { ...base, status: "MAX_TOKENS", usage: { ...this.usage }, error: "The answer was cut off at the output limit (fake judge)." };
    const r = req.schema.safeParse(a);
    if (!r.success) return { ...base, status: "PARSE_ERROR", usage: { ...this.usage }, error: "The answer did not match the expected structure (fake judge)." };
    return { ...base, status: "OK", parsed: r.data, usage: { ...this.usage }, error: null };
  }
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Strikes either side of the money in the fake view. */
const FAKE_FLOW_STRIKES = 10;

/**
 * An option-flow view of `index` at spot `spot` whose latest sample was taken at `t` (keep t at or before a bar's
 * close for a causal view). ATM ±10 strikes on the index's step; mids from a simple intrinsic-plus-time model with
 * a `spreadPct` (of the mid) bid-ask spread and IV `iv`; call OI peaks 4 strikes above the money and put OI 4 below
 * (the walls), scaled so the put-call ratio is `pcr`. No build-up anywhere. Test data, not a market.
 */
export function fakeFlowView(index: IndexId, spot: number, t: number, o: { spreadPct?: number; iv?: number; pcr?: number } = {}): OptionFlowView {
  const spec = DEFAULT_CONFIG.indexSpecs[index];
  const step = spec.strikeStep;
  const atm = Math.round(spot / step) * step;
  const iv = o.iv ?? 13;
  const spreadPct = o.spreadPct ?? 0.8;
  const pcr = o.pcr ?? 1;
  // About a week of time value at the money.
  const atmTime = Math.max(1, 0.4 * spot * (iv / 100) * Math.sqrt(5 / 252));
  const peak = (n: number, at: number) => Math.round(50_000 + 400_000 * Math.exp(-((n - at) ** 2) / 4));
  const side = (intrinsic: number, strike: number, oi: number): FlowSideView => {
    const mid = r2(Math.max(0.05, intrinsic + atmTime * Math.exp(-Math.abs(strike - spot) / (spot * 0.01))));
    const half = (mid * spreadPct) / 200;
    return { oi, ltp: mid, bid: r2(mid - half), ask: r2(mid + half), iv, delta: null, oiChg: 0, oiChgPct: 0, vol: 0, volMultiple: null, ltpChgPct: 0, ivChg: 0, buildup: "NEUTRAL" };
  };
  const rows: FlowStrikeRow[] = [];
  for (let n = -FAKE_FLOW_STRIKES; n <= FAKE_FLOW_STRIKES; n++) {
    const strike = atm + n * step;
    // Symmetric walls give a ratio of 1; the put side is scaled to the requested one.
    rows.push({ strike, ce: side(Math.max(spot - strike, 0), strike, peak(n, 4)), pe: side(Math.max(strike - spot, 0), strike, Math.round(peak(n, -4) * pcr)) });
  }
  const callWall = rows.reduce((a, b) => ((b.ce?.oi ?? 0) > (a.ce?.oi ?? 0) ? b : a));
  const putWall = rows.reduce((a, b) => ((b.pe?.oi ?? 0) > (a.pe?.oi ?? 0) ? b : a));
  const window = (minutes: number) => ({ minutes, from: istIso(t - minutes * 60_000), rows: rows.map((r) => ({ ...r, ce: r.ce && { ...r.ce }, pe: r.pe && { ...r.pe } })) });
  return {
    index,
    source: "feed",
    asOf: istIso(t),
    expiry: addDays(istDate(t), 7),
    lotSize: spec.lotSize,
    spot,
    atm,
    step,
    minutes: 30,
    note: null,
    windows: { "1m": window(1), "5m": window(5), "15m": window(15) },
    events: [],
    summary: {
      callWritersVsPutWriters: { window: "15m", ceOiAdded: 0, peOiAdded: 0, lean: "BALANCED", text: "Balanced (test data)." },
      pcr: r2(rows.reduce((s, r) => s + (r.pe?.oi ?? 0), 0) / rows.reduce((s, r) => s + (r.ce?.oi ?? 0), 0)),
      pcrChg15m: 0,
      resistance: { strike: callWall.strike, oi: callWall.ce?.oi ?? 0 },
      support: { strike: putWall.strike, oi: putWall.pe?.oi ?? 0 },
      fastestOiAdd: { ce: null, pe: null },
      premiumDryUp: false,
      dryUpDetail: "",
      decayPctPerHourAtm: null,
      volumeBaseline: "none",
    },
    bestEntryWindow: { verdict: "unknown", text: "Test data.", now: null, best: null },
    honestSummary: [],
    statsGeneratedAt: null,
  };
}

/**
 * An Advisor brief written at `createdAt` (IST ISO) with these ideas, each filled in from a NIFTY call expiring a
 * week later (so it is never today's expiry), with a condition, a wrongIf and a bear case. Test data, not advice.
 */
export function fakeBrief(createdAt: string, ideas: Partial<AdvisorIdea>[]): AdvisorReport {
  const date = createdAt.slice(0, 10);
  const id = `adv-${date}-1`;
  const expiry = addDays(date, 7);
  const idea = (p: Partial<AdvisorIdea>, i: number): AdvisorIdea => ({
    id: `${id}-${i + 1}`,
    horizon: "TODAY",
    contract: { index: "NIFTY", expiry, strike: 25_000, optionType: "CE", tradingSymbol: "NIFTY-TEST-25000-CE", lotSize: 65, label: `NIFTY ${expiry} 25000 CE` },
    entry: { low: 118, high: 125, ask: 121, asOf: createdAt },
    stop: 85,
    target: 180,
    exitBy: `${date}T15:00:00+05:30`,
    lots: 1,
    costPerLot: 121 * 65,
    maxLossPerLot: 36 * 65,
    rewardPerLot: 59 * 65,
    breakevenAtExpiry: 25_121,
    delta: 0.5,
    iv: 13,
    probItm: 0.5,
    why: ["Call writers are covering above 25,000.", "Flows turned positive."],
    wrongIf: "NIFTY closes a 5-minute candle below 24,900.",
    confidence: "LOW",
    condition: "Only if NIFTY holds above 25,000.",
    bearCase: "Call writers are adding at 25,100, so the move may stall below it.",
    ...p,
  });
  return {
    id,
    createdAt,
    model: "demo (no model call)",
    durationMs: 60_000,
    costUsd: null,
    market: { nifty: 25_000, sensex: 82_000, vix: 13, phase: "OPEN" },
    headline: "Test brief: wait for a clean break above 25,000.",
    today: { action: "WAIT", summary: "Test data, not advice.", ideaId: null },
    outlook: [],
    factors: [
      { key: "FII_DII", label: "Foreign and domestic funds", reading: "SUPPORTS_DOWN", detail: "FIIs sold ₹1,200 crore (test data).", source: "test" },
      { key: "TREND", label: "Trend", reading: "SUPPORTS_UP", detail: "Above VWAP (test data).", source: "test" },
    ],
    ideas: ideas.map(idea),
    zeroHero: { applicable: false, expiry: null, summary: "No expiry today (test data)." },
    premium: { verdict: "NORMAL", detail: "IV close to VIX (test data)." },
    alsoKnow: [],
    avoid: [],
    sources: [],
    honesty: "Test data, not advice.",
  };
}
