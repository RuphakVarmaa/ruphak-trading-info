/**
 * Yahoo Finance chart v8 client (no auth). Index, VIX and cross-asset candles for the engine.
 *
 * Endpoint: https://query1.finance.yahoo.com/v8/finance/chart/<symbol>?interval=5m&range=5d
 * - Requests without a browser-like User-Agent get HTTP 429.
 * - 1m data reaches back ~7 days, 5m/15m ~60 days (a longer range returns HTTP 422).
 * - Unknown symbols return HTTP 404 with `chart.error`.
 * - Bars are keyed by their OPEN time; the newest bar can still be forming.
 * - Exchange holidays inside the range come back as rows of nulls (dropped here).
 * - While a market trades, intraday charts end with an extra point stamped at the last trade time
 *   (e.g. 15:43:13 after the 15:40 bar). For 1m/2m/5m/15m charts it is folded into the bar it falls in
 *   (close = that price, high/low extended) so every candle sits on the interval grid.
 * - Index volume is 0 on intraday bars (^NSEI, ^BSESN, ^NSEBANK, ^INDIAVIX).
 * - `meta.previousClose` is unreliable for multi-day ranges (on a 5d chart it can be the close
 *   from two sessions back); derive prior closes from the bars instead.
 */
import type { Candle } from "../types";

export type YahooInterval = "1m" | "5m" | "15m" | "1h" | "1d";

export interface YahooChartMeta {
  regularMarketPrice: number | null;
  previousClose: number | null;
  /** Epoch SECONDS of the last trade Yahoo knows about. */
  regularMarketTime: number | null;
  /** Exchange UTC offset in seconds (19800 for IST). */
  gmtoffset: number | null;
}

export interface YahooChart {
  symbol: string;
  /** Sorted by open time, unique, without null bars. */
  candles: Candle[];
  meta: YahooChartMeta;
}

export const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";

/** Yahoo rejects requests without a browser-like User-Agent (HTTP 429). */
export const YAHOO_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

/** Yahoo accepts a far-future period2 and clamps it to "now"; period1 alone is rejected. */
const FAR_FUTURE_PERIOD2 = 9_999_999_999;

/** Intraday granularities whose bars sit on an epoch-aligned grid for every exchange used here. */
const GRID_SECONDS: Record<string, number> = { "1m": 60, "2m": 120, "5m": 300, "15m": 900 };

function finiteOrNull(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function describeChartError(err: unknown): string {
  if (isRecord(err)) {
    const code = typeof err.code === "string" ? err.code : "error";
    const description = typeof err.description === "string" ? err.description : JSON.stringify(err);
    return `${code}: ${description}`;
  }
  return String(err);
}

/**
 * Parses a chart v8 JSON response. Pure: no I/O.
 * Drops bars with any null/non-finite OHLC value; `t` = timestamp * 1000 (bar open); null volume -> 0.
 * Off-grid trailing ticks of 1m-15m charts are folded into their bar (see the module comment).
 * A result without timestamps (no data in range) yields an empty candle list.
 * Throws on `chart.error` or an unrecognizable shape.
 */
export function parseYahooChart(json: unknown, symbol: string): YahooChart {
  const chart = isRecord(json) ? json.chart : undefined;
  if (!isRecord(chart)) throw new Error(`Yahoo chart ${symbol}: unexpected response shape (missing "chart")`);
  if (chart.error !== null && chart.error !== undefined) {
    throw new Error(`Yahoo chart ${symbol}: ${describeChartError(chart.error)}`);
  }
  const result = Array.isArray(chart.result) ? chart.result[0] : undefined;
  if (!isRecord(result)) throw new Error(`Yahoo chart ${symbol}: empty result`);

  const meta = isRecord(result.meta) ? result.meta : {};
  const timestamps = Array.isArray(result.timestamp) ? (result.timestamp as unknown[]) : [];
  const indicators = isRecord(result.indicators) ? result.indicators : {};
  const quoteArr = Array.isArray(indicators.quote) ? indicators.quote : [];
  const quote = isRecord(quoteArr[0]) ? quoteArr[0] : {};
  const col = (name: string): unknown[] => (Array.isArray(quote[name]) ? (quote[name] as unknown[]) : []);
  const open = col("open");
  const high = col("high");
  const low = col("low");
  const close = col("close");
  const volume = col("volume");

  const points: { ts: number; bar: Omit<Candle, "t"> }[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = finiteOrNull(timestamps[i]);
    const o = finiteOrNull(open[i]);
    const h = finiteOrNull(high[i]);
    const l = finiteOrNull(low[i]);
    const c = finiteOrNull(close[i]);
    if (ts === null || o === null || h === null || l === null || c === null) continue;
    points.push({ ts, bar: { o, h, l, c, v: finiteOrNull(volume[i]) ?? 0 } });
  }
  points.sort((a, b) => a.ts - b.ts); // stable: equal timestamps keep their order

  const grid = GRID_SECONDS[typeof meta.dataGranularity === "string" ? meta.dataGranularity : ""];
  const byTime = new Map<number, Candle>();
  for (const { ts, bar } of points) {
    if (grid && ts % grid !== 0) {
      // Live tick stamped at its trade time: fold it into the bar it belongs to.
      const t = Math.floor(ts / grid) * grid * 1000;
      const cur = byTime.get(t);
      byTime.set(
        t,
        cur
          ? { ...cur, h: Math.max(cur.h, bar.h, bar.c), l: Math.min(cur.l, bar.l, bar.c), c: bar.c }
          : { t, ...bar },
      );
      continue;
    }
    // A later duplicate row for the same bar wins (Yahoo repeats the forming bar occasionally).
    byTime.set(ts * 1000, { t: ts * 1000, ...bar });
  }
  const candles = [...byTime.values()].sort((a, b) => a.t - b.t);

  return {
    symbol: typeof meta.symbol === "string" && meta.symbol ? meta.symbol : symbol,
    candles,
    meta: {
      regularMarketPrice: finiteOrNull(meta.regularMarketPrice),
      previousClose: finiteOrNull(meta.previousClose),
      regularMarketTime: finiteOrNull(meta.regularMarketTime),
      gmtoffset: finiteOrNull(meta.gmtoffset),
    },
  };
}

export interface FetchYahooChartOptions {
  interval: YahooInterval;
  /** Yahoo range such as "1d", "5d", "60d", "6mo". Ignored when period1 is given. Default "1d". */
  range?: string;
  /** Start, epoch SECONDS. */
  period1?: number;
  /** End, epoch SECONDS. Defaults to "now" when only period1 is given. */
  period2?: number;
  fetchImpl?: typeof fetch;
  /** Default 10 s. */
  timeoutMs?: number;
}

/** Builds the chart URL (exported for tests and logging). */
export function yahooChartUrl(symbol: string, opts: Pick<FetchYahooChartOptions, "interval" | "range" | "period1" | "period2">): string {
  const params = new URLSearchParams({ interval: opts.interval });
  if (opts.period1 !== undefined || opts.period2 !== undefined) {
    const p1 = Math.floor(opts.period1 ?? 0);
    const p2 = Math.floor(opts.period2 ?? FAR_FUTURE_PERIOD2);
    params.set("period1", String(p1));
    params.set("period2", String(p2));
  } else {
    params.set("range", opts.range ?? "1d");
  }
  return `${YAHOO_CHART_BASE}${encodeURIComponent(symbol)}?${params.toString()}`;
}

/** Fetches and parses one chart. Throws a descriptive Error on HTTP errors, timeouts and `chart.error`. */
export async function fetchYahooChart(symbol: string, opts: FetchYahooChartOptions): Promise<YahooChart> {
  const url = yahooChartUrl(symbol, opts);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = 0;
  let text: string;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { "User-Agent": YAHOO_USER_AGENT, Accept: "application/json,text/plain,*/*" },
      signal: controller.signal,
    });
    status = res.status;
    text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        const parsed: unknown = JSON.parse(text);
        const err = isRecord(parsed) && isRecord(parsed.chart) ? parsed.chart.error : undefined;
        if (err) detail = describeChartError(err);
      } catch {
        // Non-JSON error body: keep the excerpt.
      }
      throw new Error(`Yahoo chart ${symbol} (${opts.interval}): HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Yahoo chart ${symbol} (${opts.interval}): timed out after ${timeoutMs} ms`);
    }
    if (err instanceof Error && err.message.startsWith("Yahoo chart")) throw err;
    throw new Error(`Yahoo chart ${symbol} (${opts.interval}): request failed${status ? ` (HTTP ${status})` : ""}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Yahoo chart ${symbol} (${opts.interval}): invalid JSON (${text.slice(0, 80)})`);
  }
  return parseYahooChart(json, symbol);
}
