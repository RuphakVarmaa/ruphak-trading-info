/**
 * Caches Groww historical 5-minute index candles for multi-year backtests (Yahoo keeps only ~60
 * days of 5-minute bars). Groww serves 1-5 minute candles in windows of at most 30 days, from 2020.
 * Output: .cache/history/groww-5m.json keyed by the Yahoo symbols the engine uses, merged with
 * whatever was cached before. Needs GROWW_API_KEY and GROWW_TOTP_SECRET (env, .env or .dev.vars).
 *
 *   npm run fetch-history -- --from 2025-01-01 --to 2026-10-07
 */
import { GrowwDataClient, GrowwHttp, GrowwTokenManager, mintTotpToken } from "../src/engine/broker/groww";
import { addDays, istAt, istDate } from "../src/engine/clock";
import { MARKET_SYMBOLS, type Candle, type Exchange } from "../src/engine/types";
import { fail, loadEnvFiles, parseArgs, readJson, sleep, str, writeJson } from "./lib/node";

/** Index series to cache. India VIX's Groww symbol is unverified; failures are reported, not fatal. */
const SERIES: { yahoo: string; exchange: Exchange; growwSymbol: string }[] = [
  { yahoo: MARKET_SYMBOLS.NIFTY, exchange: "NSE", growwSymbol: "NSE-NIFTY" },
  { yahoo: MARKET_SYMBOLS.SENSEX, exchange: "BSE", growwSymbol: "BSE-SENSEX" },
  { yahoo: MARKET_SYMBOLS.BANKNIFTY, exchange: "NSE", growwSymbol: "NSE-BANKNIFTY" },
  { yahoo: MARKET_SYMBOLS.INDIAVIX, exchange: "NSE", growwSymbol: "NSE-INDIAVIX" },
];
const CACHE = ".cache/history/groww-5m.json";
const WINDOW_DAYS = 30;

async function main() {
  loadEnvFiles();
  const args = parseArgs();
  const to = str(args, "to", istDate(Date.now()))!;
  const from = str(args, "from", addDays(to, -365))!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) fail("--from/--to must be YYYY-MM-DD with from <= to");
  const apiKey = process.env.GROWW_API_KEY;
  const totpSecret = process.env.GROWW_TOTP_SECRET;
  if (!apiKey || !totpSecret) fail("Set GROWW_API_KEY and GROWW_TOTP_SECRET (API key of type TOTP from groww.in/trade-api/api-keys).");

  const tokens = new GrowwTokenManager({ now: Date.now, mint: () => mintTotpToken({ apiKey, totpSecret, nowMs: Date.now }) });
  const data = new GrowwDataClient(new GrowwHttp({ tokens, minIntervalMs: { nontrading: 300 } }));
  const cache = readJson<Record<string, Candle[]>>(CACHE) ?? {};

  for (const s of SERIES) {
    const merged = new Map<number, Candle>((cache[s.yahoo] ?? []).map((c) => [c.t, c]));
    let errors = 0;
    for (let start = from; start <= to; start = addDays(start, WINDOW_DAYS)) {
      const end = addDays(start, WINDOW_DAYS - 1) < to ? addDays(start, WINDOW_DAYS - 1) : to;
      try {
        const candles = await data.historicalCandles({
          exchange: s.exchange,
          segment: "CASH",
          growwSymbol: s.growwSymbol,
          startMs: istAt(start, "09:00"),
          endMs: istAt(end, "15:35"),
          interval: "5minute",
        });
        for (const c of candles) merged.set(c.t, c);
        process.stdout.write(`\r${s.growwSymbol} ${start}..${end}: ${candles.length} bars (total ${merged.size})        `);
      } catch (err) {
        errors++;
        console.log(`\n${s.growwSymbol} ${start}..${end}: ${err instanceof Error ? err.message : String(err)}`);
        if (errors >= 3 && merged.size === 0) {
          console.log(`Skipping ${s.growwSymbol}: repeated failures (symbol may not be served by Groww).`);
          break;
        }
        await sleep(2_000);
      }
    }
    process.stdout.write("\n");
    if (merged.size > 0) cache[s.yahoo] = [...merged.values()].sort((a, b) => a.t - b.t);
  }
  const path = writeJson(CACHE, cache);
  for (const [sym, arr] of Object.entries(cache)) console.log(`${sym}: ${arr.length} bars, ${arr.length ? `${istDate(arr[0].t)} .. ${istDate(arr.at(-1)!.t)}` : "empty"}`);
  console.log(`Saved ${path}. npm run backtest now uses it automatically.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
