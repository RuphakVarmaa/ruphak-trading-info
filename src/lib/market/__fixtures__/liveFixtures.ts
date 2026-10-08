/**
 * Test-only Yahoo chart responses for the live index feed.
 *
 * Recorded: Yahoo chart v8 fetched 2026-10-09 00:41 IST (after the 2026-10-08 session, before the next
 * pre-open), trimmed to the fields the parser and the feed read; values untouched. 1-minute range=1d for
 * ^NSEI and ^BSESN (376 bars, 09:15 through the 15:30 closing print; India VIX keeps its last 15 bars) and
 * daily range=1mo (2026-09-14 and 2026-10-02 are holidays, as null rows; the 2026-10-08 bar has a null close).
 *
 * Synthetic: chartJson() builds a response of the same shape from bars, for cases the recording lacks.
 */
import { istAt } from "@/engine/clock";
import { parseYahooChart, type YahooChart } from "@/engine/market/yahooClient";
import bsesn1d from "./yahoo-1d-1mo-BSESN-2026-10-08.json";
import vix1d from "./yahoo-1d-1mo-INDIAVIX-2026-10-08.json";
import nsei1d from "./yahoo-1d-1mo-NSEI-2026-10-08.json";
import bsesn1m from "./yahoo-1m-1d-BSESN-2026-10-08.json";
import vix1m from "./yahoo-1m-1d-INDIAVIX-2026-10-08.json";
import nsei1m from "./yahoo-1m-1d-NSEI-2026-10-08.json";

/** Recorded responses keyed "<symbol> <interval>". */
export const RECORDED: Record<string, unknown> = {
  "^NSEI 1m": nsei1m,
  "^NSEI 1d": nsei1d,
  "^BSESN 1m": bsesn1m,
  "^BSESN 1d": bsesn1d,
  "^INDIAVIX 1m": vix1m,
  "^INDIAVIX 1d": vix1d,
};

export const recordedChart = (key: string): YahooChart => parseYahooChart(RECORDED[key], key.split(" ")[0]);

export interface RawBar {
  /** Bar open, epoch ms. */
  t: number;
  o: number | null;
  h: number | null;
  l: number | null;
  c: number | null;
}

/** An IST bar: bar("2026-10-08", "09:15", o, h, l, c). */
export const bar = (date: string, hm: string, o: number | null, h: number | null = o, l: number | null = o, c: number | null = o): RawBar => ({ t: istAt(date, hm), o, h, l, c });

/** A chart v8 response like Yahoo's, from bars and meta (epoch-second regularMarketTime). */
export function chartJson(symbol: string, interval: "1m" | "1d", bars: RawBar[], meta: Record<string, unknown> = {}) {
  return {
    chart: {
      result: [
        {
          meta: { symbol, gmtoffset: 19800, exchangeTimezoneName: "Asia/Kolkata", dataGranularity: interval, range: interval === "1m" ? "1d" : "1mo", ...meta },
          timestamp: bars.map((b) => Math.floor(b.t / 1000)),
          indicators: {
            quote: [
              {
                open: bars.map((b) => b.o),
                high: bars.map((b) => b.h),
                low: bars.map((b) => b.l),
                close: bars.map((b) => b.c),
                volume: bars.map((b) => (b.c == null ? null : 0)),
              },
            ],
          },
        },
      ],
      error: null,
    },
  };
}

/** The bars of a recorded response, as RawBar rows (for slicing a session into an earlier moment). */
export function recordedBars(key: string): RawBar[] {
  const r = (RECORDED[key] as { chart: { result: { timestamp: number[]; indicators: { quote: Record<string, (number | null)[]>[] } }[] } }).chart.result[0];
  const q = r.indicators.quote[0];
  return r.timestamp.map((ts, i) => ({ t: ts * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] }));
}
