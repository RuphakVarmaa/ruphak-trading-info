/** Loads recorded Yahoo fixtures for tests (Node-only helper; not used by the engine runtime). */
import { readFileSync } from "node:fs";
import { parseYahooChart } from "../market/yahooClient";
import type { Candle } from "../types";

const DIR = new URL("../__fixtures__/market/", import.meta.url);

const FILES: Record<string, { intraday?: string; daily?: string }> = {
  "^NSEI": { intraday: "yahoo-5m-5d-NSEI.json", daily: "yahoo-1d-3mo-NSEI.json" },
  "^BSESN": { intraday: "yahoo-5m-5d-BSESN.json", daily: "yahoo-1d-3mo-BSESN.json" },
  "^NSEBANK": { intraday: "yahoo-5m-5d-NSEBANK.json", daily: "yahoo-1d-3mo-NSEBANK.json" },
  "^INDIAVIX": { intraday: "yahoo-5m-5d-INDIAVIX.json", daily: "yahoo-1d-3mo-INDIAVIX.json" },
  "ES=F": { intraday: "yahoo-5m-5d-ES_F.json" },
  "BZ=F": { intraday: "yahoo-5m-5d-BZ_F.json" },
  "USDINR=X": { intraday: "yahoo-5m-5d-USDINR_X.json" },
  "^TNX": { intraday: "yahoo-5m-5d-TNX.json" },
};

function load(file: string, symbol: string): Candle[] {
  return parseYahooChart(JSON.parse(readFileSync(new URL(file, DIR), "utf8")), symbol).candles;
}

export function loadMarketFixtures(): { candles: Record<string, Candle[]>; daily: Record<string, Candle[]> } {
  const candles: Record<string, Candle[]> = {};
  const daily: Record<string, Candle[]> = {};
  for (const [symbol, f] of Object.entries(FILES)) {
    if (f.intraday) candles[symbol] = load(f.intraday, symbol);
    if (f.daily) daily[symbol] = load(f.daily, symbol);
  }
  return { candles, daily };
}
