/**
 * Test helpers: recorded Yahoo chart responses (captured 2026-10-07 ~20:45 IST, after the close) and
 * synthetic candle generators. Test-only (uses node:fs); excluded from the Workers build.
 *
 * 5m range=5d covers the NSE/BSE sessions of 2026-10-01, 05, 06 and 07 (2026-10-02 was a holiday and
 * comes back as 75 null rows). Cross-assets: ES=F, BZ=F, USDINR=X, ^TNX. Daily range=3mo for the
 * four Indian symbols.
 */
import { readFileSync } from "node:fs";
import { MARKET_SYMBOLS, type Candle } from "../../types";
import { parseYahooChart } from "../../market/yahooClient";
import { istAt } from "../../clock";

export const FIXTURE_5M: Record<string, string> = {
  [MARKET_SYMBOLS.NIFTY]: "yahoo-5m-5d-NSEI.json",
  [MARKET_SYMBOLS.SENSEX]: "yahoo-5m-5d-BSESN.json",
  [MARKET_SYMBOLS.BANKNIFTY]: "yahoo-5m-5d-NSEBANK.json",
  [MARKET_SYMBOLS.INDIAVIX]: "yahoo-5m-5d-INDIAVIX.json",
  [MARKET_SYMBOLS.ES]: "yahoo-5m-5d-ES_F.json",
  [MARKET_SYMBOLS.BZ]: "yahoo-5m-5d-BZ_F.json",
  [MARKET_SYMBOLS.USDINR]: "yahoo-5m-5d-USDINR_X.json",
  [MARKET_SYMBOLS.US10Y]: "yahoo-5m-5d-TNX.json",
};

export const FIXTURE_1D: Record<string, string> = {
  [MARKET_SYMBOLS.NIFTY]: "yahoo-1d-3mo-NSEI.json",
  [MARKET_SYMBOLS.SENSEX]: "yahoo-1d-3mo-BSESN.json",
  [MARKET_SYMBOLS.BANKNIFTY]: "yahoo-1d-3mo-NSEBANK.json",
  [MARKET_SYMBOLS.INDIAVIX]: "yahoo-1d-3mo-INDIAVIX.json",
};

export function readMarketFixtureText(file: string): string {
  return readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
}

export function readMarketFixture(file: string): unknown {
  return JSON.parse(readMarketFixtureText(file));
}

export function readInstrumentFixtureText(file = "index-options-sample.csv"): string {
  return readFileSync(new URL(`../instruments/${file}`, import.meta.url), "utf8");
}

export function fixtureCandles5m(): Record<string, Candle[]> {
  const out: Record<string, Candle[]> = {};
  for (const [sym, file] of Object.entries(FIXTURE_5M)) out[sym] = parseYahooChart(readMarketFixture(file), sym).candles;
  return out;
}

export function fixtureDaily(): Record<string, Candle[]> {
  const out: Record<string, Candle[]> = {};
  for (const [sym, file] of Object.entries(FIXTURE_1D)) out[sym] = parseYahooChart(readMarketFixture(file), sym).candles;
  return out;
}

/** Deterministic PRNG (mulberry32) for reproducible synthetic paths. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draws via Box-Muller on a seeded PRNG. */
export function normalSampler(seed: number): () => number {
  const u = mulberry32(seed);
  return () => {
    const u1 = Math.max(u(), 1e-12);
    const u2 = u();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
}

/**
 * One session of 5m bars from 09:15 IST: bar i opens at the previous close (or `open` for the first bar)
 * and closes at closes[i]; high/low extend `wick` beyond the body.
 */
export function sessionFromCloses(date: string, closes: number[], open: number, wick = 0, volume = 0): Candle[] {
  const out: Candle[] = [];
  let prev = open;
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    out.push({
      t: istAt(date, 555 + 5 * i),
      o: prev,
      h: Math.max(prev, c) + wick,
      l: Math.min(prev, c) - wick,
      c,
      v: volume,
    });
    prev = c;
  }
  return out;
}

/** A flat-ish session: `n` bars alternating +/- `step` around `level`. */
export function zigzagSession(date: string, level: number, step: number, n = 75, wick = 0): Candle[] {
  const closes = Array.from({ length: n }, (_, i) => level + (i % 2 === 0 ? step : -step));
  return sessionFromCloses(date, closes, level, wick);
}
