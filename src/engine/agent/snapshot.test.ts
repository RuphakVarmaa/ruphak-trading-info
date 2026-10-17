import { describe, expect, it } from "vitest";
import type { OptionFlowView } from "../api-types";
import { TradingCalendar } from "../calendar/calendar";
import { MINUTE_MS, istAt, istDate, istIso } from "../clock";
import { DEFAULT_CONFIG, makeConfig } from "../config";
import { chainSnapshotFromView } from "../flow/flowFallback";
import type { ChainSnapshot } from "../flow/flowMonitor";
import { computeFeatures } from "../market/features";
import { NIFTY_CHAIN_SAMPLE, SENSEX_CHAIN_SAMPLE } from "../market/upstoxChain.fixture";
import { buildOptionChainView, maxPainStrike, parseUpstoxChain } from "../market/upstoxChain";
import { loadMarketFixtures } from "../testing/fixtures";
import { MARKET_SYMBOLS, type IndexId, type MarketSnapshot } from "../types";
import { causalMarketSnapshot } from "./causal";
import { CHARS_PER_TOKEN_BOUND, PROSE_CHARS_PER_TOKEN, SNAPSHOT_TOKEN_LIMIT, SNAPSHOT_TYPICAL_TOKEN_TARGET } from "./constants";
import { flowViewAsOf } from "./flowAsOf";
import {
  SNAPSHOT_CLAMPS,
  SNAPSHOT_WIRE_KEYS,
  bookBlock,
  buildIndexSnapshot,
  buyExpiry,
  encodeSnapshot,
  estimateProseTokens,
  estimateTokens,
  fitSnapshot,
  maxPain,
  optionBlock,
  worstCaseSnapshot,
  type SnapshotInput,
} from "./snapshot";
import type { AgentBookState, IndexSnapshot } from "./types";

const DAY = "2026-10-07";
const at = (hhmm: string, date = DAY) => istAt(date, hhmm);
const cal = new TradingCalendar();
const cfg = DEFAULT_CONFIG;
const fixtures = loadMarketFixtures();

/** The fixtures as a live snapshot taken at `t`: every bar, today's daily bar and a live spot (the snapshot reads them as of the close). */
function marketAt(t: number): MarketSnapshot {
  return { t, candles: fixtures.candles, daily: fixtures.daily, ltp: { NIFTY: 1, SENSEX: 1 }, dataAgeSec: 0, dataAgeSecByIndex: { NIFTY: 0, SENSEX: 0 }, asOfMs: {} };
}

const flatBook = (t: number): AgentBookState => ({ t, equity: 500_000, peakEquity: 505_000, ddPct: 0.99, dayLossPct: 0.4, positions: [] });

/** The index's last 5-minute close at or before t (the feed's spot in these samples). */
function spotAt(index: IndexId, t: number): number {
  const bars = fixtures.candles[MARKET_SYMBOLS[index]].filter((c) => c.t + 5 * MINUTE_MS <= t);
  return bars[bars.length - 1].c;
}

/** Minute samples of an ATM ±15 chain from 09:16 to `to`, priced off the index (time value fading away from ATM). */
function chainSamples(index: IndexId, to: number): ChainSnapshot[] {
  const step = cfg.indexSpecs[index].strikeStep;
  const tv = index === "NIFTY" ? 120 : 380;
  const width = index === "NIFTY" ? 250 : 800;
  const out: ChainSnapshot[] = [];
  for (let t = at("09:16") + 1_500, m = 0; t <= to; t += MINUTE_MS, m++) {
    const spot = spotAt(index, t);
    const atm = Math.round(spot / step) * step;
    const rows = Array.from({ length: 31 }, (_, i) => {
      const strike = atm + (i - 15) * step;
      const side = (type: "CE" | "PE") => {
        const mid = Math.max(0, type === "CE" ? spot - strike : strike - spot) + tv * Math.exp(-Math.abs(strike - spot) / width);
        const half = Math.max(0.05, mid * 0.003);
        const wall = type === "CE" ? strike === atm + 4 * step : strike === atm - 4 * step;
        return { ltp: mid, volume: 1_000 * m, oi: (wall ? 3_000_000 : 1_000_000) + 1_000 * m, bid: mid - half, ask: mid + half, iv: type === "CE" ? 12.4 : 13.1, delta: type === "CE" ? 0.5 : -0.5 };
      };
      return { strike, ce: side("CE"), pe: side("PE") };
    });
    out.push({ t, index, expiry: "2026-10-13", lotSize: cfg.indexSpecs[index].lotSize, spot, rows });
  }
  return out;
}

/** The day's samples per index (with ten minutes after the close), built once. */
const SAMPLES: Partial<Record<IndexId, ChainSnapshot[]>> = {};
/**
 * The flow as of T. Only the last 20 minutes are replayed: the option block reads the latest sample and the 1, 5 and
 * 15-minute windows, and the full day would only slow the tests down.
 */
function flowAt(index: IndexId, T: number): OptionFlowView | null {
  const all = (SAMPLES[index] ??= chainSamples(index, at("15:40")));
  return flowViewAsOf(all.filter((s) => s.t >= T - 20 * MINUTE_MS), index, T);
}

function input(index: IndexId, T: number, o: Partial<SnapshotInput> = {}): SnapshotInput {
  const flow = "flow" in o ? (o.flow ?? null) : flowAt(index, T);
  return { index, barCloseMs: T, market: marketAt(T + 40_000), calendar: cal, cfg, events: [], perf: [], book: flatBook(T - 30_000), ...o, flow };
}

/** SPEC §3.2's typical example, in the amended units. */
const TYPICAL: IndexSnapshot = fitSnapshot({
  c: 25012.4,
  r5: 12,
  r15: -8,
  r60: 31,
  ro: 45,
  vw: 18,
  vz: 0.9,
  orh: -11,
  orl: 21,
  ors: "I",
  pdh: -35,
  pdl: 64,
  pdc: 45,
  rsi: 58.2,
  adx: 24.1,
  di: 6.3,
  st: 1,
  rv: 11.2,
  atr: 0.08,
  vix: 13.42,
  vixc: -2.1,
  o: { k: 25000, cm: 112.45, cs: 0.89, pm: 98.05, ps: 1.02, iv: 12.8, ivx: -0.6, pcr: 0.92, mp: -5, cw: 40, pw: -60, bc: [3, 5, 1, 2], bp: [2, 1, 4, 0], oa: 58 },
  cv: 0.21,
  rg: "TU",
  pv: "C",
  pn: "kkckk",
  ew: 1,
  dte: 3,
  xd: 0,
  bk: { pos: "-", lots: 0, pnl: null, dd: 1.15, dl: 0.35 },
});

describe("buildIndexSnapshot on the 7 Oct fixtures", () => {
  const T = at("11:00");

  it("maps the engine's own features at the close into the snapshot's units", () => {
    for (const index of ["NIFTY", "SENSEX"] as const) {
      const s = buildIndexSnapshot(input(index, T));
      const f = computeFeatures(index, causalMarketSnapshot(marketAt(T + 40_000), T), cal, cfg);
      const close = fixtures.candles[MARKET_SYMBOLS[index]].find((c) => c.t === T - 5 * MINUTE_MS)!.c;
      const bp = (x: number) => Math.round(x) + 0;
      expect(s.c).toBe(Math.round(close));
      expect(f.spot).toBe(close);
      expect(s.r5).toBe(bp(f.ret5m * 100));
      expect(s.r15).toBe(bp(f.ret15m * 100));
      expect(s.r60).toBe(bp(f.ret60m * 100));
      expect(s.ro).toBe(bp(f.retFromOpen * 100));
      // Distances run from the close to the level: VWAP above the close is positive.
      expect(s.vw).toBe(bp((f.indicators.vwap / close - 1) * 10_000));
      expect(s.pdc).toBe(bp((f.indicators.prevDayClose / close - 1) * 10_000));
      expect(s.orh).toBe(bp((f.openingRange.high / close - 1) * 10_000));
      expect(s.ors).toBe({ FORMING: "F", INSIDE: "I", BROKE_UP: "U", BROKE_DOWN: "D" }[f.openingRange.state]);
      expect(s.rsi).toBe(Math.round(f.indicators.rsi14));
      expect(s.di).toBe(Math.round(f.indicators.plusDi14 - f.indicators.minusDi14));
      expect(s.atr).toBe(Math.round(f.atrPct5m * 100) / 100);
      expect(s.vix).toBe(Math.round(f.vix * 10) / 10);
      expect(s.ew).toBe(1);
      expect(s.pn).toMatch(/^[kcbu]{5}$/);
      expect(s.pv).toBe(s.pn.includes("b") ? "X" : s.pn === "kkkkk" ? "C" : "A");
      expect(s.bk).toEqual({ pos: "-", lots: 0, pnl: null, dd: 1, dl: 0.4 });
      expect(s.o).not.toBeNull();
      expect(s.o!.oa).toBe(59);
      expect(s.o!.k % cfg.indexSpecs[index].strikeStep).toBe(0);
    }
  });

  it("reads the contract the agent would buy: NIFTY's next Tuesday, SENSEX's Thursday", () => {
    // Wed 7 Oct: NIFTY expires Tue 13 Oct (4 sessions), SENSEX Thu 8 Oct (1 session).
    expect(buildIndexSnapshot(input("NIFTY", T))).toMatchObject({ dte: 4, xd: 0 });
    expect(buildIndexSnapshot(input("SENSEX", T))).toMatchObject({ dte: 1, xd: 0 });
  });

  it("sets the entry-window flag from the config's window", () => {
    expect(buildIndexSnapshot(input("NIFTY", at("09:20"))).ew).toBe(0);
    expect(buildIndexSnapshot(input("NIFTY", at("14:30"))).ew).toBe(1);
    expect(buildIndexSnapshot(input("NIFTY", at("15:05"))).ew).toBe(0);
  });

  it("reads today's plan at the 15:30 bar, not the next session's", () => {
    // Thu 8 Oct is SENSEX's expiry day: the next session's plan would flag N7.
    const s = buildIndexSnapshot(input("SENSEX", at("15:30")));
    expect(s.pn[3]).toBe("k");
    expect(buildIndexSnapshot(input("SENSEX", at("15:25"))).pn).toBe(s.pn);
  });

  it("is the same from report.snapshot and from its causal copy", () => {
    const raw = buildIndexSnapshot(input("NIFTY", T));
    expect(buildIndexSnapshot(input("NIFTY", T, { market: causalMarketSnapshot(marketAt(T + 40_000), T) }))).toEqual(raw);
  });

  it("refuses inputs that cannot describe the bar: older market data, a missing bar, a later book", () => {
    expect(() => buildIndexSnapshot(input("NIFTY", T, { market: marketAt(T - 1) }))).toThrow(/older than the NIFTY bar closing at 11:00/);
    expect(() => buildIndexSnapshot(input("NIFTY", at("10:00", "2026-10-08"), { market: marketAt(at("10:01", "2026-10-08")) }))).toThrow(/no NIFTY bar closes at 10:00/);
    expect(() => buildIndexSnapshot(input("NIFTY", T, { book: flatBook(T + 1) }))).toThrow(/after the bar close/);
  });
});

describe("buyExpiry", () => {
  it("never picks today's expiry, and honours rules.n4", () => {
    expect(buyExpiry("SENSEX", at("10:00", "2026-10-08"), cal, cfg)).toBe("2026-10-15");
    // Mon 19 Oct: NIFTY's weekly expires that day (Tue 20 Oct is a holiday).
    expect(buyExpiry("NIFTY", at("10:00", "2026-10-19"), cal, cfg)).toBe("2026-10-27");
    const n4 = makeConfig({ rules: { n4: { enabled: true, minSessionsLeft: 2 } } });
    expect(buyExpiry("SENSEX", at("10:00", "2026-10-14"), cal, cfg)).toBe("2026-10-15");
    expect(buyExpiry("SENSEX", at("10:00", "2026-10-14"), cal, n4)).toBe("2026-10-22");
  });
});

describe("fitSnapshot", () => {
  it("rounds every field to the snapshot's units", () => {
    expect(TYPICAL).toEqual({
      c: 25012,
      r5: 12,
      r15: -8,
      r60: 31,
      ro: 45,
      vw: 18,
      vz: 0.9,
      orh: -11,
      orl: 21,
      ors: "I",
      pdh: -35,
      pdl: 64,
      pdc: 45,
      rsi: 58,
      adx: 24,
      di: 6,
      st: 1,
      rv: 11,
      atr: 0.08,
      vix: 13.4,
      vixc: -2.1,
      o: { k: 25000, cm: 112, cs: 0.89, pm: 98.1, ps: 1.02, iv: 13, ivx: -0.6, pcr: 0.92, mp: -5, cw: 40, pw: -60, bc: [3, 5, 1, 2], bp: [2, 1, 4, 0], oa: 58 },
      cv: 0.21,
      rg: "TU",
      pv: "C",
      pn: "kkckk",
      ew: 1,
      dte: 3,
      xd: 0,
      bk: { pos: "-", lots: 0, pnl: null, dd: 1.2, dl: 0.4 },
    });
  });

  it("gives premiums three significant figures", () => {
    const cm = (x: number) => fitSnapshot({ ...TYPICAL, o: { ...TYPICAL.o!, cm: x } }).o!.cm;
    expect([8.456, 9.996, 54.34, 99.94, 99.96, 412.6, 12_345].map(cm)).toEqual([8.46, 10, 54.3, 99.9, 100, 413, 9999]);
    expect(cm(-1)).toBeNull();
  });

  it("clamps to SNAPSHOT_CLAMPS, keeps unknowns null and never emits -0 or NaN", () => {
    const s = fitSnapshot({
      ...TYPICAL,
      c: 5e9,
      r5: -1e6,
      r60: Number.NaN,
      vw: -0.2,
      vz: 40,
      orh: null,
      pdc: Number.POSITIVE_INFINITY,
      rsi: 140,
      di: -300,
      st: -7 as -1,
      atr: 33,
      vix: null,
      vixc: -150,
      cv: 3,
      pn: "kk",
      dte: 400,
      o: { ...TYPICAL.o!, cs: 250, iv: Number.NaN, pcr: -1, bc: [99, -3, 2.6, 0], oa: 1e5 },
      bk: { pos: "L", lots: 140, pnl: -250, dd: -3, dl: 400 },
    });
    expect(s).toMatchObject({ c: SNAPSHOT_CLAMPS.level, r5: -999, r60: 0, vw: 0, vz: 9.9, orh: null, pdc: null, rsi: 100, di: -100, st: -1, atr: 9.99, vix: null, vixc: -99.9, cv: 1, pn: "uuuuu", dte: 99 });
    expect(Object.is(s.vw, -0)).toBe(false);
    expect(s.o).toMatchObject({ cs: 99.99, iv: null, pcr: 0, bc: [11, 0, 3, 0], oa: 999 });
    expect(s.bk).toEqual({ pos: "L", lots: 99, pnl: -100, dd: 0, dl: 100 });
  });

  it("is idempotent, and the worst case is a fixed point", () => {
    expect(fitSnapshot(TYPICAL)).toEqual(TYPICAL);
    expect(fitSnapshot(worstCaseSnapshot())).toEqual(worstCaseSnapshot());
  });
});

describe("encodeSnapshot", () => {
  it("sends the wire keys in a fixed order, the book as an array, and leaves out ors, pv and ew", () => {
    const wire = JSON.parse(encodeSnapshot(TYPICAL));
    expect(Object.keys(wire)).toEqual([...SNAPSHOT_WIRE_KEYS.top]);
    expect(Object.keys(wire.o)).toEqual([...SNAPSHOT_WIRE_KEYS.o]);
    expect(wire.bk).toEqual(["-", 0, null, 1.2, 0.4]);
    for (const k of ["ors", "pv", "ew"]) expect(wire).not.toHaveProperty(k);
    expect(encodeSnapshot(TYPICAL).startsWith('{"c":25012,"r5":12,"r15":-8,"r60":31,"ro":45,"vw":18,"vz":0.9,"orh":-11,')).toBe(true);
    // Field order in the object does not matter.
    const shuffled = Object.fromEntries(Object.entries(TYPICAL).reverse()) as unknown as IndexSnapshot;
    expect(encodeSnapshot(shuffled)).toBe(encodeSnapshot(TYPICAL));
    expect(JSON.parse(encodeSnapshot({ ...TYPICAL, o: null })).o).toBeNull();
  });
});

/** A small seeded generator, so a failure can be replayed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("token budget (SPEC §3.3 as amended)", () => {
  const tokens = (s: IndexSnapshot) => estimateTokens(encodeSnapshot(s));

  it("estimates dense JSON at 1.2 characters a token and prose at 3, never below the bound", () => {
    expect(CHARS_PER_TOKEN_BOUND).toBe(1.2);
    expect(PROSE_CHARS_PER_TOKEN).toBe(3);
    const r = rng(7);
    for (let i = 0; i < 200; i++) {
      const text = Array.from({ length: Math.floor(r() * 700) }, () => String.fromCharCode(32 + Math.floor(r() * 95))).join("");
      expect(estimateTokens(text)).toBeGreaterThanOrEqual(text.length / CHARS_PER_TOKEN_BOUND);
      expect(estimateProseTokens(text)).toBe(Math.ceil(text.length / 3));
    }
  });

  it("keeps the worst case under 400 and the typical case at or under 340", () => {
    expect(tokens(worstCaseSnapshot())).toBeLessThan(SNAPSHOT_TOKEN_LIMIT);
    expect(SNAPSHOT_TYPICAL_TOKEN_TARGET).toBe(340);
    expect(tokens(TYPICAL)).toBeLessThanOrEqual(SNAPSHOT_TYPICAL_TOKEN_TARGET);
    expect(tokens({ ...worstCaseSnapshot(), o: null })).toBeLessThan(tokens(worstCaseSnapshot()));
  });

  it("never encodes a fitted snapshot longer than the worst case, whatever the inputs", () => {
    const r = rng(42);
    const wild = (): number => {
      const k = r();
      if (k < 0.04) return Number.NaN;
      if (k < 0.08) return (r() < 0.5 ? -1 : 1) * Number.POSITIVE_INFINITY;
      return (r() - 0.5) * 10 ** (r() * 9);
    };
    const maybe = () => (r() < 0.2 ? null : wild());
    const four = () => [wild(), wild(), wild(), wild()] as [number, number, number, number];
    const worst = encodeSnapshot(worstCaseSnapshot()).length;
    for (let i = 0; i < 3_000; i++) {
      const raw: IndexSnapshot = {
        ...TYPICAL,
        c: wild(),
        r5: wild(),
        r15: wild(),
        r60: wild(),
        ro: wild(),
        vw: wild(),
        vz: wild(),
        orh: maybe(),
        orl: maybe(),
        pdh: maybe(),
        pdl: maybe(),
        pdc: maybe(),
        rsi: wild(),
        adx: wild(),
        di: wild(),
        rv: wild(),
        atr: wild(),
        vix: maybe(),
        vixc: wild(),
        cv: wild(),
        dte: wild(),
        o: r() < 0.15 ? null : { k: wild(), cm: maybe(), cs: maybe(), pm: maybe(), ps: maybe(), iv: maybe(), ivx: maybe(), pcr: maybe(), mp: maybe(), cw: maybe(), pw: maybe(), bc: four(), bp: four(), oa: wild() },
        bk: { pos: "S", lots: wild(), pnl: maybe(), dd: wild(), dl: wild() },
      };
      const s = fitSnapshot(raw);
      expect(encodeSnapshot(s).length).toBeLessThanOrEqual(worst);
      expect(fitSnapshot(s)).toEqual(s);
      // The encoder fits its input itself.
      expect(encodeSnapshot(raw)).toBe(encodeSnapshot(s));
    }
  });

  it("keeps snapshots built from the 7 Oct fixtures well under 400, with and without option data", () => {
    for (const hhmm of ["09:20", "11:00", "15:05"]) {
      for (const index of ["NIFTY", "SENSEX"] as const) {
        const s = buildIndexSnapshot(input(index, at(hhmm)));
        expect(tokens(s)).toBeLessThanOrEqual(SNAPSHOT_TYPICAL_TOKEN_TARGET);
        expect(tokens(buildIndexSnapshot(input(index, at(hhmm), { flow: null })))).toBeLessThan(SNAPSHOT_TOKEN_LIMIT);
      }
    }
  });
});

describe("optionBlock", () => {
  const T = at("11:00");
  const flow = (): OptionFlowView => flowAt("NIFTY", T)!;

  it("is null without a view, for a view sampled after the close or on another day, and without rows", () => {
    expect(optionBlock(null, 22_600, 12, T)).toBeNull();
    const later = flowAt("NIFTY", T + 5 * MINUTE_MS)!;
    expect(optionBlock(later, 22_600, 12, T)).toBeNull();
    expect(optionBlock({ ...flow(), asOf: istIso(at("15:20", "2026-10-06")) }, 22_600, 12, T)).toBeNull();
    expect(optionBlock({ ...flow(), windows: { ...flow().windows, "1m": { minutes: 1, from: null, rows: [] } } }, 22_600, 12, T)).toBeNull();
    expect(optionBlock(flow(), 0, 12, T)).toBeNull();
  });

  it("reads the ATM row: mids, spreads in % of mid, IV less VIX; a side without a bid or ask has no mid", () => {
    const v = flow();
    const o = optionBlock(v, 22_600, 12, T)!;
    const atm = v.windows["1m"].rows.find((r) => r.strike === v.atm)!;
    const mid = (atm.ce!.bid! + atm.ce!.ask!) / 2;
    expect(o.k).toBe(v.atm);
    expect(o.cs).toBe(Math.round(((atm.ce!.ask! - atm.ce!.bid!) / mid) * 10_000) / 100);
    expect(o.iv).toBe(13);
    expect(o.ivx).toBe(0.8);
    expect(o.pcr).toBe(Math.round(v.summary.pcr! * 100) / 100);
    expect(optionBlock(v, 22_600, null, T)!.ivx).toBeNull();
    const noBid = { ...v, windows: { ...v.windows, "1m": { ...v.windows["1m"], rows: v.windows["1m"].rows.map((r) => (r.strike === v.atm ? { ...r, ce: { ...r.ce!, bid: null } } : r)) } } };
    expect(optionBlock(noBid, 22_600, 12, T)).toMatchObject({ cm: null, cs: null });
  });

  it("measures max pain and the OI walls from the close", () => {
    const v = flow();
    const o = optionBlock(v, 22_600, 12, T)!;
    const rows = v.windows["1m"].rows.map((r) => ({ strike: r.strike, ceOi: r.ce?.oi ?? null, peOi: r.pe?.oi ?? null }));
    expect(o.mp).toBe(Math.round((maxPain(rows)! / 22_600 - 1) * 10_000));
    expect(o.cw).toBe(Math.round((v.summary.resistance!.strike / 22_600 - 1) * 10_000));
    expect(o.pw).toBe(Math.round((v.summary.support!.strike / 22_600 - 1) * 10_000));
    expect(o.cw!).toBeGreaterThan(o.pw!);
  });
});

describe("maxPain", () => {
  it("matches maxPainStrike on the recorded Upstox chains, directly and through the flow rows", () => {
    for (const [index, payload] of [["NIFTY", NIFTY_CHAIN_SAMPLE], ["SENSEX", SENSEX_CHAIN_SAMPLE]] as const) {
      const chain = parseUpstoxChain(payload);
      const expected = maxPainStrike(chain.rows);
      expect(expected).not.toBeNull();
      expect(maxPain(chain.rows.map((r) => ({ strike: r.strike, ceOi: r.ce?.oi ?? null, peOi: r.pe?.oi ?? null })))).toBe(expected);
      const view = buildOptionChainView({ index, expiry: "2026-10-19", meta: { expiries: [], lotSize: 65 }, chain, fetchedMs: at("11:00", "2026-10-14") });
      const snap = chainSnapshotFromView(view, at("11:00", "2026-10-14"))!;
      expect(maxPain(snap.rows.map((r) => ({ strike: r.strike, ceOi: r.ce?.oi ?? null, peOi: r.pe?.oi ?? null })))).toBe(expected);
    }
  });

  it("is null without open interest and takes the lowest strike on a tie", () => {
    expect(maxPain([])).toBeNull();
    expect(maxPain([{ strike: 100, ceOi: null, peOi: 0 }])).toBeNull();
    // Settling at 100 pays 2,500, at 200 pays 2,000, at 300 pays 2,500.
    expect(maxPain([{ strike: 100, ceOi: 10, peOi: 0 }, { strike: 200, ceOi: 5, peOi: 5 }, { strike: 300, ceOi: 0, peOi: 10 }])).toBe(200);
    expect(maxPain([{ strike: 100, ceOi: 5, peOi: 5 }, { strike: 200, ceOi: 5, peOi: 5 }])).toBe(100);
  });
});

describe("bookBlock", () => {
  const t = at("11:00");
  const pos = (o: Partial<AgentBookState["positions"][number]> = {}) => ({ index: "NIFTY" as const, side: "BULL" as const, lots: 2, avgEntry: 100, markPremium: 112.5, markMs: t - 5_000, ...o });

  it("is flat without a position on the index", () => {
    expect(bookBlock(flatBook(t), "NIFTY")).toEqual({ pos: "-", lots: 0, pnl: null, dd: 1, dl: 0.4 });
    expect(bookBlock({ ...flatBook(t), positions: [pos({ index: "SENSEX" })] }, "NIFTY").pos).toBe("-");
  });

  it("reports the side, lots and open P&L at the recorded marks", () => {
    expect(bookBlock({ ...flatBook(t), positions: [pos()] }, "NIFTY")).toEqual({ pos: "L", lots: 2, pnl: 12.5, dd: 1, dl: 0.4 });
    expect(bookBlock({ ...flatBook(t), positions: [pos({ side: "BEAR", lots: 1, markPremium: 70 })] }, "NIFTY")).toMatchObject({ pos: "S", lots: 1, pnl: -30 });
  });

  it("has no P&L for a mark that is missing or later than the book", () => {
    expect(bookBlock({ ...flatBook(t), positions: [pos({ markMs: t + 1 })] }, "NIFTY").pnl).toBeNull();
    expect(bookBlock({ ...flatBook(t), positions: [pos({ markPremium: Number.NaN })] }, "NIFTY").pnl).toBeNull();
    expect(bookBlock({ ...flatBook(t), positions: [pos({ avgEntry: 0 })] }, "NIFTY").pnl).toBeNull();
  });

  it("reads a profitable day as no loss used", () => {
    expect(bookBlock({ ...flatBook(t), dayLossPct: -0.8, ddPct: 0 }, "NIFTY")).toMatchObject({ dd: 0, dl: 0 });
  });
});

it("the fixture day is a trading day with the 11:00 bar in the data", () => {
  expect(cal.isTradingDay(DAY)).toBe(true);
  expect(istDate(at("11:00"))).toBe(DAY);
  expect(fixtures.candles["^NSEI"].some((c) => c.t === at("10:55"))).toBe(true);
});
