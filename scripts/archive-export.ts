/**
 * Writes the private D1 bar archive (table bars_5m) as a backtest history snapshot: the file
 * `npm run backtest -- --history <file>` replays (what --save-history writes), so a backtest can run on
 * archived months (docs/DATA.md).
 *
 *   npm run archive-export                                     # local D1 (.wrangler/state) -> .cache/history/d1-5m-export.json
 *   npm run archive-export -- --from 2026-07-01 --to 2026-12-31 --out .cache/history/d1-h2-2026.json
 *   npm run archive-export -- --remote                         # the deployed database (read-only; rows read are billed)
 *   options: --symbols ^NSEI,^BSESN,^NSEBANK,^INDIAVIX     (default: every archived symbol)
 *            --daily-from <snapshot.json>   daily bars from a saved snapshot or archive instead of Yahoo
 *            --no-daily                     no daily bars (the replay then builds them from the 5-minute bars)
 *            --compare <archive.json>       compare only: check every settled bar of a JSON archive against D1
 *                                           (e.g. after a back-fill); writes nothing, exits 1 on a missing or different bar
 *            --page-rows 25000              rows per query
 *
 * Daily bars are not archived because Yahoo keeps years of them: by default they are fetched from Yahoo
 * (2y, longer when the archive reaches further back) and frozen into the snapshot, as --save-history does.
 * The snapshot holds raw market data and the repository is public: it is written under .cache/ (gitignored)
 * or outside the repository, never to a path git could commit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DAY_MS, formatIst, istDate, istMidnight } from "../src/engine/clock";
import { backfillRows, compareBars, dailyRangeFor, historySnapshot, readArchivedBars, type HistoryFile } from "../src/engine/market/barArchive";
import { fetchYahooChart } from "../src/engine/market/yahooClient";
import type { Candle } from "../src/engine/types";
import { isGitIgnored, isInsideRepo, queryD1, shellQuote, type D1Target } from "./lib/d1";
import { fail, num, parseArgs, readJson, ROOT, str } from "./lib/node";

const args = parseArgs();

function istRange(from: string | undefined, to: string | undefined): { fromMs?: number; toMs?: number } {
  for (const d of [from, to]) if (d !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(d)) fail(`--from/--to must be YYYY-MM-DD, got ${d}`);
  return { fromMs: from ? istMidnight(from) : undefined, toMs: to ? istMidnight(to) + DAY_MS : undefined };
}

async function fetchDaily(symbols: string[], range: string): Promise<{ daily: Record<string, Candle[]>; errors: string[] }> {
  const daily: Record<string, Candle[]> = {};
  const errors: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < symbols.length) {
      const sym = symbols[next++];
      try {
        daily[sym] = (await fetchYahooChart(sym, { interval: "1d", range, timeoutMs: 30_000 })).candles;
      } catch (err) {
        errors.push(`${sym} 1d ${range}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, symbols.length) }, worker));
  return { daily, errors };
}

async function main(): Promise<void> {
  const target: D1Target = args.remote === true ? "remote" : "local";
  const symbols = str(args, "symbols")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const range = istRange(str(args, "from"), str(args, "to"));
  const compareWith = str(args, "compare");
  const out = resolve(ROOT, str(args, "out", ".cache/history/d1-5m-export.json")!);
  if (!compareWith && isInsideRepo(out) && !isGitIgnored(out)) {
    fail(`--out ${out} could be committed. The repository is public and raw market data must stay out of git: write under .cache/ or outside the repository.`);
  }

  console.log(`Reading bars_5m from the ${target} D1${target === "remote" ? " (read-only; rows read are billed)" : " (.wrangler/state)"}...`);
  const t0 = Date.now();
  const tty = process.stdout.isTTY === true;
  const candles = await readArchivedBars(async (statements) => queryD1(statements, target), {
    symbols,
    ...range,
    pageRows: num(args, "page-rows", 25_000),
    onProgress: tty ? (sym, n) => process.stdout.write(`\r  ${sym.padEnd(10)} ${String(n).padStart(8)} bars   `) : undefined,
  });
  if (tty) process.stdout.write("\r");
  const total = Object.values(candles).reduce((s, a) => s + a.length, 0);
  console.log(`Read ${total} bars of ${Object.keys(candles).length} symbol(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
  for (const [sym, arr] of Object.entries(candles)) console.log(`  ${sym.padEnd(10)} ${String(arr.length).padStart(7)} bars  ${formatIst(arr[0].t).slice(0, 16)} .. ${formatIst(arr.at(-1)!.t).slice(0, 16)}`);

  if (compareWith) {
    const file = readJson<HistoryFile>(compareWith) ?? fail(`No file at ${compareWith}.`);
    const expected: Record<string, Candle[]> = {};
    for (const r of backfillRows(file, { symbols, ...range }).rows) {
      const c: Candle = { t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v };
      if (r.oi !== null) c.oi = r.oi;
      (expected[r.symbol] ??= []).push(c);
    }
    const cmp = compareBars(expected, candles);
    console.log(`\nCompared with the settled bars of ${compareWith}: ${cmp.same} identical, ${cmp.missing} missing from D1, ${cmp.different} different, ${cmp.extra} in D1 only (e.g. written by the engine).`);
    for (const e of cmp.examples) console.log(`  ${e}`);
    if (cmp.missing > 0 || cmp.different > 0) process.exit(1);
    return;
  }
  if (total === 0) fail("No archived bars for these symbols and dates (run the back-fill, or wait for the 16:15 IST job).");

  const exported = Object.keys(candles);
  let daily: Record<string, Candle[]> = {};
  const errors: string[] = [];
  const dailyFrom = str(args, "daily-from");
  if (args["no-daily"] === true) {
    errors.push("no daily bars: the replay builds them from the 5-minute bars");
  } else if (dailyFrom) {
    const src = readJson<{ daily?: Record<string, Candle[]> }>(dailyFrom) ?? fail(`No file at ${dailyFrom}.`);
    for (const sym of exported) if (src.daily?.[sym]?.length) daily[sym] = src.daily[sym];
    console.log(`Daily bars from ${dailyFrom}: ${Object.keys(daily).length} of ${exported.length} symbols.`);
  } else {
    const first = Math.min(...Object.values(candles).map((a) => a[0].t));
    const dailyRange = dailyRangeFor(first, Date.now());
    console.log(`Fetching Yahoo daily bars (${dailyRange}) for ${exported.length} symbols...`);
    const r = await fetchDaily(exported, dailyRange);
    daily = r.daily;
    errors.push(...r.errors);
  }
  for (const e of errors) console.log(`warning: ${e}`);

  const snap = historySnapshot(candles, { source: `d1 bars_5m archive (${target})`, savedAt: new Date().toISOString(), daily, errors });
  const json = JSON.stringify(snap); // compact, like the fetch-history archive
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  // Suggest a window that leaves the first 5 sessions as indicator warm-up (as the reference backtest does).
  const sessions = [...new Set((snap.candles["^NSEI"] ?? []).map((c) => istDate(c.t)))];
  const days = sessions.length > 0 ? `--from ${sessions[Math.min(5, sessions.length - 1)]} --to ${sessions.at(-1)}` : "--from <YYYY-MM-DD> --to <YYYY-MM-DD>";
  console.log(`\nWrote ${out} (${(json.length / 1e6).toFixed(1)} MB). Replay it:`);
  console.log(`  npm run backtest -- --history ${shellQuote(out)} ${days} --no-events --prod-limits`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
