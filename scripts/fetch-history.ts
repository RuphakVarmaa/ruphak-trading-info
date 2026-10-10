/**
 * Caches Groww historical 5-minute index candles for multi-year backtests (Yahoo keeps only ~60
 * days of 5-minute bars). Groww serves 1-5 minute candles in windows of at most 30 days, from 2020.
 * Output: .cache/history/groww-5m.json keyed by the Yahoo symbols the engine uses, merged with
 * whatever was cached before. Needs GROWW_API_KEY and GROWW_TOTP_SECRET (env, .env or .dev.vars).
 *
 *   npm run fetch-history -- --from 2025-01-01 --to 2026-10-07
 *
 * Yahoo 5-minute archive (--save, no keys needed): Yahoo serves only the last ~60 days of 5-minute
 * bars, so every day that is not saved is lost. --save fetches the rolling window of NIFTY, SENSEX,
 * BANKNIFTY, India VIX and the cross assets the engine uses, writes it unchanged to
 * .cache/history/yahoo-5m-YYYYMMDD.json (IST date of the run) and appends the bars that are new to
 * .cache/history/yahoo-5m-archive.json. Archived bars are never changed or removed: a later Yahoo
 * revision of a bar is recorded next to it, and the dated capture keeps what was served. The archive
 * also carries the latest 2-year daily bars, so it replays as a history snapshot. Run it every evening
 * after 16:00 IST (docs/DATA.md):
 *
 *   npm run fetch-history -- --save                      [--range 60d] [--cross-range 5d|60d]
 *   npm run backtest -- --history .cache/history/yahoo-5m-archive.json --from ... --to ...
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GrowwDataClient, GrowwHttp, GrowwTokenManager, mintTotpToken } from "../src/engine/broker/groww";
import { addDays, DAY_MS, formatIst, istAt, istDate, MINUTE_MS } from "../src/engine/clock";
import { appendCandles } from "../src/engine/market/candles";
import { fetchYahooChart, type YahooInterval } from "../src/engine/market/yahooClient";
import { CROSS_ASSET_SYMBOLS, INDIAN_SYMBOLS } from "../src/engine/market/yahooMarketData";
import { MARKET_SYMBOLS, type Candle, type Exchange } from "../src/engine/types";
import { fail, loadEnvFiles, parseArgs, readJson, ROOT, sleep, str, writeJson, type Args } from "./lib/node";

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
  const args = parseArgs();
  if (args.save === true || args.archive === true) return saveYahooArchive(args);
  loadEnvFiles();
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

// ---------------------------------------------------------------------------
// Yahoo 5-minute archive (--save)
// ---------------------------------------------------------------------------

const ARCHIVE_DIR = ".cache/history";
const ARCHIVE = `${ARCHIVE_DIR}/yahoo-5m-archive.json`;
/**
 * A bar is archived once it closed this long before the fetch, so a still-forming or provisional bar is
 * never frozen in. Some of Yahoo's feeds run 10-15 minutes late (Hong Kong, Shanghai): their last bars
 * were still revised 15 minutes after the close. Newer bars are simply taken by the next run.
 */
const SETTLE_MS = 30 * MINUTE_MS;
/** A cross-asset series whose archive is fresher than this gets the 5-day window instead of 60 days. */
const CROSS_FRESH_MS = 3 * DAY_MS;

interface ArchiveCapture {
  file: string;
  fetchedAt: string;
  ranges: Record<string, string>;
  added: Record<string, number>;
  revisions: number;
  errors: string[];
}

interface ArchiveRevision {
  symbol: string;
  t: number;
  bar: string;
  archived: Candle;
  fetched: Candle;
  file: string;
}

/** Same shape as a backtest history snapshot (candles, daily, errors, source, savedAt) plus the archive log. */
interface ArchiveFile {
  source: string;
  savedAt: string;
  candles: Record<string, Candle[]>;
  daily: Record<string, Candle[]>;
  errors: string[];
  archive: { version: 1; captures: ArchiveCapture[]; revisions: ArchiveRevision[] };
}

/** Compact JSON (the archive grows by a few hundred KB a day; indentation would triple that). */
function writeCompactJson(path: string, data: unknown): string {
  const p = resolve(ROOT, path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data));
  return p;
}

async function fetchAll(jobs: { symbol: string; interval: YahooInterval; range: string }[]): Promise<{ data: Record<string, Candle[]>; errors: string[] }> {
  const data: Record<string, Candle[]> = {};
  const errors: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        data[job.symbol] = (await fetchYahooChart(job.symbol, { interval: job.interval, range: job.range, timeoutMs: 30_000 })).candles;
      } catch (err) {
        errors.push(`${job.symbol} ${job.interval} ${job.range}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
  return { data, errors };
}

async function saveYahooArchive(args: Args): Promise<void> {
  const fetchedAtMs = Date.now();
  const fetchedAt = new Date(fetchedAtMs).toISOString();
  const archive: ArchiveFile = readJson<ArchiveFile>(ARCHIVE) ?? {
    source: "yahoo 5m archive",
    savedAt: fetchedAt,
    candles: {},
    daily: {},
    errors: [],
    archive: { version: 1, captures: [], revisions: [] },
  };
  const range = str(args, "range", "60d")!;
  const crossRange = str(args, "cross-range", undefined);
  const ranges: Record<string, string> = {};
  for (const s of INDIAN_SYMBOLS) ranges[s] = range;
  // Around-the-clock series are ~1 MB per 60 days: the full window only when the archive is behind.
  for (const s of CROSS_ASSET_SYMBOLS) ranges[s] = crossRange ?? (fetchedAtMs - (archive.candles[s]?.at(-1)?.t ?? 0) < CROSS_FRESH_MS ? "5d" : "60d");

  console.log(`Fetching Yahoo 5m: ${Object.entries(ranges).map(([s, r]) => `${s} ${r}`).join(", ")}`);
  const intraday = await fetchAll(Object.entries(ranges).map(([symbol, r]) => ({ symbol, interval: "5m" as const, range: r })));
  const daily = await fetchAll([...INDIAN_SYMBOLS, ...CROSS_ASSET_SYMBOLS].map((symbol) => ({ symbol, interval: "1d" as const, range: "2y" })));
  for (const e of [...intraday.errors, ...daily.errors]) console.log(`warning: ${e}`);
  if (Object.keys(intraday.data).length === 0) fail("Nothing fetched from Yahoo; the archive is unchanged.");

  // 1) The capture exactly as served, one file per IST date (a second run that day gets a time suffix).
  const stamp = istDate(fetchedAtMs).replaceAll("-", "");
  let file = `yahoo-5m-${stamp}.json`;
  if (existsSync(resolve(ROOT, ARCHIVE_DIR, file))) file = `yahoo-5m-${stamp}-${formatIst(fetchedAtMs).slice(11, 16).replace(":", "")}.json`;
  const capturePath = writeCompactJson(`${ARCHIVE_DIR}/${file}`, { source: "yahoo chart v8, 5m", fetchedAt, ranges, candles: intraday.data, errors: intraday.errors });

  // 2) Append the settled new bars to the archive; never rewrite an archived bar.
  const added: Record<string, number> = {};
  let revisions = 0;
  let priceRevisions = 0;
  for (const [symbol, bars] of Object.entries(intraday.data)) {
    const r = appendCandles(archive.candles[symbol] ?? [], bars, fetchedAtMs - SETTLE_MS);
    archive.candles[symbol] = r.candles;
    added[symbol] = r.added;
    for (const rev of r.revisions) {
      archive.archive.revisions.push({ symbol, t: rev.fetched.t, bar: formatIst(rev.fetched.t), archived: rev.archived, fetched: rev.fetched, file });
      const a = rev.archived;
      const f = rev.fetched;
      if (a.o !== f.o || a.h !== f.h || a.l !== f.l || a.c !== f.c) priceRevisions++;
    }
    revisions += r.revisions.length;
  }
  // Daily bars stay downloadable for years; they are refreshed (not archived) so the file replays as a snapshot.
  for (const [symbol, bars] of Object.entries(daily.data)) if (bars.length > 0) archive.daily[symbol] = bars;
  archive.savedAt = fetchedAt;
  archive.archive.captures.push({ file, fetchedAt, ranges, added, revisions, errors: [...intraday.errors, ...daily.errors] });
  const archivePath = writeCompactJson(ARCHIVE, archive);

  console.log(`Capture: ${capturePath}`);
  for (const [symbol, bars] of Object.entries(archive.candles)) {
    const first = bars[0];
    const last = bars.at(-1);
    console.log(`  ${symbol.padEnd(10)} +${String(added[symbol] ?? 0).padStart(5)} new, ${String(bars.length).padStart(6)} archived${first && last ? `, ${formatIst(first.t).slice(0, 16)} .. ${formatIst(last.t).slice(0, 16)}` : ""}`);
  }
  console.log(
    `Archive: ${archivePath} (${archive.archive.captures.length} capture(s); ${revisions} revised bar(s) recorded this run, ` +
      `${priceRevisions} with a different price and ${revisions - priceRevisions} volume only; archived values kept).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
