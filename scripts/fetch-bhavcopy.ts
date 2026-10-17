/**
 * Downloads the exchanges' end-of-day F&O bhavcopies and keeps compact extracts of the index
 * options and futures (NIFTY and BANKNIFTY from NSE, SENSEX from BSE) for research: real option
 * prices for calibration and sanity checks (src/engine/backtest/realPrices.ts). Nothing in the live
 * engine reads this cache.
 *
 *   npx tsx scripts/fetch-bhavcopy.ts --from 2024-01-01 --to 2026-10-08
 *   npx tsx scripts/fetch-bhavcopy.ts --coverage                 # what is cached, per exchange and year
 *   npx tsx scripts/fetch-bhavcopy.ts --verify                   # re-read every extract; bad ones are re-fetched next run
 *   npx tsx scripts/fetch-bhavcopy.ts --index-daily              # Yahoo daily NIFTY/SENSEX/BANKNIFTY/India VIX
 *   npx tsx scripts/fetch-bhavcopy.ts --from 2024-01-01 --to 2026-10-08 --local-nse <dir> --local-bse <dir> [--offline]
 *            # use zips already on disk (official names, or fo_YYYYMMDD.zip / bhav_YYYY-MM-DD.zip) before the network
 *   options: --exchange NSE|BSE|BOTH  --dir .cache/bhavcopy  --no-weekends  --retry-missing
 *            --min-interval-ms 1100 (per host)  --max-errors 25
 *
 * Politeness: one request at a time per host and at least --min-interval-ms between request starts
 * (default 1.1 s, i.e. under 1 request/second per host), up to 3 retries with exponential backoff on
 * network errors, 429 and 5xx; 404 means "no file for that date" (holiday or not yet published) and is
 * not retried. Neither host publishes robots.txt rules; the requests use a descriptive User-Agent and,
 * for BSE, the Referer its download links send. Weekdays are always tried; weekends are tried on NSE
 * (special sessions such as budget days) and on BSE only when NSE had a file that day.
 *
 * Output: <dir>/<nse|bse>/YYYY/YYYYMMDD.csv.gz (compact CSV, see COMPACT_HEADER) and <dir>/manifest.json
 * (status of every date tried). Raw zips are not kept.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  COMPACT_HEADER,
  bhavcopyCsvFromZip,
  bhavcopyUrl,
  cachePath,
  detectBhavFormat,
  parseBhavcopy,
  toCompactCsv,
  type BhavExchange,
  type BhavFormat,
} from "../src/engine/backtest/realPrices";
import { fetchYahooChart } from "../src/engine/market/yahooClient";
import { MARKET_SYMBOLS } from "../src/engine/types";
import { ROOT, fail, num, parseArgs, sleep, str, table } from "./lib/node";

const USER_AGENT = "ruphak-trading-info-research/1.0 (end-of-day bhavcopy archive; <=1 request/s)";

export interface ManifestEntry {
  status: "ok" | "missing" | "error";
  format: BhavFormat;
  url: string;
  /** Rows kept in the extract. */
  rows?: number;
  /** Size of the downloaded zip. */
  bytes?: number;
  at: string;
  error?: string;
}

export interface Manifest {
  version: 1;
  entries: Record<string, ManifestEntry>;
}

const key = (exchange: BhavExchange, date: string) => `${exchange}:${date}`;

function readManifest(dir: string): Manifest {
  const p = resolve(dir, "manifest.json");
  if (!existsSync(p)) return { version: 1, entries: {} };
  return JSON.parse(readFileSync(p, "utf8")) as Manifest;
}

function writeManifest(dir: string, m: Manifest): void {
  const p = resolve(dir, "manifest.json");
  mkdirSync(dirname(p), { recursive: true });
  const sorted: Manifest = { version: 1, entries: Object.fromEntries(Object.entries(m.entries).sort(([a], [b]) => a.localeCompare(b))) };
  writeFileSync(`${p}.tmp`, JSON.stringify(sorted, null, 1));
  renameSync(`${p}.tmp`, p);
}

function addDaysIso(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Spaces request starts at least `minIntervalMs` apart (one limiter per host). */
class Pacer {
  private nextAt = 0;
  constructor(private readonly minIntervalMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    if (now < this.nextAt) await sleep(this.nextAt - now);
    this.nextAt = Date.now() + this.minIntervalMs;
  }
}

type Fetched = { status: number; bytes?: Uint8Array; error?: string };

async function fetchWithRetry(pacer: Pacer, url: string, headers: Record<string, string>, retries = 3): Promise<Fetched> {
  let last: Fetched = { status: 0, error: "not attempted" };
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(2_000 * 2 ** (attempt - 1) + Math.random() * 500);
    await pacer.wait();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "*/*", ...headers }, signal: controller.signal });
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (res.status === 404) return { status: 404 };
      if (res.ok) return { status: res.status, bytes };
      last = { status: res.status, error: `HTTP ${res.status}` };
      if (res.status !== 429 && res.status < 500) return last;
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      last = { status: 0, error: cause ?? (err instanceof Error ? err.message : String(err)) };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

/** True when the body starts with a ZIP local-file signature. */
function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** True when the body is an HTML page (BSE answers a missing file with its home page and HTTP 200). */
function isHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/** Names under which a day's zip may already sit in a local directory (official names and q1's names). */
function localNames(exchange: BhavExchange, date: string): string[] {
  const [y, m, d] = date.split("-");
  const mon = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][Number(m) - 1];
  if (exchange === "BSE") return [`bhav_${date}.zip`, `bhavcopy${d}-${m}-${y.slice(2)}.zip`];
  return [`fo_${y}${m}${d}.zip`, `BhavCopy_NSE_FO_0_0_0_${y}${m}${d}_F_0000.csv.zip`, `fo${d}${mon}${y}bhav.csv.zip`];
}

/** A day's zip from a local directory, when one exists there and is a zip (not a saved HTML page). */
function localZip(localDir: string | undefined, exchange: BhavExchange, date: string): { path: string; bytes: Uint8Array } | null {
  if (!localDir) return null;
  for (const name of localNames(exchange, date)) {
    const p = resolve(localDir, name);
    if (!existsSync(p)) continue;
    const bytes = new Uint8Array(readFileSync(p));
    if (isZip(bytes)) return { path: p, bytes };
  }
  return null;
}

async function fetchDay(
  dir: string,
  manifest: Manifest,
  pacer: Pacer,
  exchange: BhavExchange,
  date: string,
  o: { localDir?: string; offline?: boolean } = {},
): Promise<ManifestEntry | null> {
  const official = bhavcopyUrl(exchange, date);
  const at = new Date().toISOString();
  const local = localZip(o.localDir, exchange, date);
  if (!local && o.offline) return null;
  const url = local ? `file://${local.path}` : official.url;
  let format = official.format;
  const res: Fetched = local ? { status: 200, bytes: local.bytes } : await fetchWithRetry(pacer, official.url, official.headers);
  let entry: ManifestEntry;
  if (res.status === 404) entry = { status: "missing", format, url, at };
  else if (!res.bytes) entry = { status: "error", format, url, at, error: res.error ?? `HTTP ${res.status}` };
  else if (!isZip(res.bytes) && isHtml(res.bytes)) entry = { status: "missing", format, url, at, error: "HTML page instead of a file" };
  else {
    try {
      const csv = await bhavcopyCsvFromZip(res.bytes);
      format = detectBhavFormat(exchange, csv);
      const rows = parseBhavcopy(format, csv, date);
      const wrongDate = rows.find((r) => r.date !== date);
      if (wrongDate) throw new Error(`file holds ${wrongDate.date} rows`);
      const out = resolve(dir, cachePath(exchange, date));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, gzipSync(toCompactCsv(rows), { level: 9 }));
      entry = { status: "ok", format, url, rows: rows.length, bytes: res.bytes.length, at };
    } catch (err) {
      entry = { status: "error", format, url, at, error: `parse: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  manifest.entries[key(exchange, date)] = entry;
  return entry;
}

async function fetchRange(args: ReturnType<typeof parseArgs>): Promise<void> {
  const dir = resolve(ROOT, str(args, "dir", ".cache/bhavcopy")!);
  const from = str(args, "from", "2024-01-01")!;
  const to = str(args, "to", addDaysIso(new Date().toISOString().slice(0, 10), -1))!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) fail("--from/--to must be YYYY-MM-DD with from <= to");
  const which = (str(args, "exchange", "BOTH") ?? "BOTH").toUpperCase();
  const exchanges: BhavExchange[] = which === "BOTH" ? ["NSE", "BSE"] : which === "NSE" || which === "BSE" ? [which] : fail("--exchange must be NSE, BSE or BOTH");
  const weekends = args["no-weekends"] !== true;
  const retryMissing = args["retry-missing"] === true;
  const minInterval = Math.max(1_000, num(args, "min-interval-ms", 1_100));
  const maxErrors = num(args, "max-errors", 25);
  const manifest = readManifest(dir);
  // Errors are always retried on a rerun; "missing" (404) only with --retry-missing.
  const needs = (exchange: BhavExchange, date: string) => {
    const e = manifest.entries[key(exchange, date)];
    if (!e || e.status === "error") return true;
    if (e.status === "missing") return retryMissing;
    return !existsSync(resolve(dir, cachePath(exchange, date)));
  };
  const isWeekend = (date: string) => weekday(date) === 0 || weekday(date) === 6;
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDaysIso(d, 1)) dates.push(d);
  console.log(`Bhavcopy fetch ${from} .. ${to} (${dates.length} calendar days) into ${dir}; ${exchanges.join("+")}, >= ${minInterval} ms between requests per host.`);

  let errors = 0;
  let saveCounter = 0;
  const save = () => {
    if (++saveCounter % 10 === 0) writeManifest(dir, manifest);
  };
  const pacers: Record<BhavExchange, Pacer> = { NSE: new Pacer(minInterval), BSE: new Pacer(minInterval) };
  const localDirs: Record<BhavExchange, string | undefined> = {
    NSE: str(args, "local-nse", undefined) ? resolve(ROOT, str(args, "local-nse")!) : undefined,
    BSE: str(args, "local-bse", undefined) ? resolve(ROOT, str(args, "local-bse")!) : undefined,
  };
  const offline = args.offline === true;
  const worker = async (exchange: BhavExchange, todo: string[]) => {
    let ok = 0;
    let missing = 0;
    let skipped = 0;
    for (const date of todo) {
      if (errors >= maxErrors) {
        console.log(`${exchange}: stopping after ${errors} errors.`);
        break;
      }
      if (!needs(exchange, date)) continue;
      const e = await fetchDay(dir, manifest, pacers[exchange], exchange, date, { localDir: localDirs[exchange], offline });
      if (e === null) {
        skipped++;
        continue;
      }
      if (e.status === "ok") ok++;
      else if (e.status === "missing") missing++;
      else {
        errors++;
        console.log(`${exchange} ${date}: ${e.error}`);
      }
      save();
      if (e.status !== "error" && (ok + missing) % 25 === 0) console.log(`${exchange} ${date}: ${ok} saved, ${missing} without a file so far`);
    }
    console.log(`${exchange}: ${ok} saved, ${missing} without a file${offline ? `, ${skipped} not in the local directory (offline)` : ""}.`);
  };
  // The two hosts run in parallel, each paced on its own. BSE weekends (special sessions) are tried
  // afterwards, only on dates where NSE had a file.
  await Promise.all([
    exchanges.includes("NSE") ? worker("NSE", dates.filter((d) => weekends || !isWeekend(d))) : Promise.resolve(),
    exchanges.includes("BSE") ? worker("BSE", dates.filter((d) => !isWeekend(d))) : Promise.resolve(),
  ]);
  if (exchanges.includes("BSE") && weekends) {
    await worker("BSE", dates.filter((d) => isWeekend(d) && manifest.entries[key("NSE", d)]?.status === "ok"));
  }
  writeManifest(dir, manifest);
  printCoverage(manifest);
}

function printCoverage(manifest: Manifest): void {
  const rows: (string | number)[][] = [["exchange", "year", "files", "no file (weekday)", "errors", "first", "last"]];
  const groups = new Map<string, { ok: number; missing: number; errors: number; first: string; last: string }>();
  for (const [k, e] of Object.entries(manifest.entries)) {
    const [exchange, date] = k.split(":");
    const g = groups.get(`${exchange}|${date.slice(0, 4)}`) ?? { ok: 0, missing: 0, errors: 0, first: "", last: "" };
    if (e.status === "ok") {
      g.ok++;
      if (!g.first || date < g.first) g.first = date;
      if (!g.last || date > g.last) g.last = date;
    } else if (e.status === "missing") {
      if (weekday(date) !== 0 && weekday(date) !== 6) g.missing++;
    } else g.errors++;
    groups.set(`${exchange}|${date.slice(0, 4)}`, g);
  }
  for (const [k, g] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [exchange, year] = k.split("|");
    rows.push([exchange, year, g.ok, g.missing, g.errors, g.first, g.last]);
  }
  console.log(table(rows));
}

/** Yahoo daily candles (open/close of the indices and India VIX) used by the research scripts. */
async function fetchIndexDaily(args: ReturnType<typeof parseArgs>): Promise<void> {
  const dir = resolve(ROOT, str(args, "dir", ".cache/bhavcopy")!);
  const range = str(args, "range", "10y")!;
  const out: Record<string, unknown> = { fetchedAt: new Date().toISOString(), source: `Yahoo chart v8, interval 1d, range ${range}`, series: {} };
  const series = out.series as Record<string, unknown>;
  for (const sym of [MARKET_SYMBOLS.NIFTY, MARKET_SYMBOLS.SENSEX, MARKET_SYMBOLS.BANKNIFTY, MARKET_SYMBOLS.INDIAVIX]) {
    const chart = await fetchYahooChart(sym, { interval: "1d", range, timeoutMs: 30_000 });
    series[sym] = chart.candles;
    console.log(`${sym}: ${chart.candles.length} daily bars`);
    await sleep(1_500);
  }
  const p = resolve(dir, "index-daily.json");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(out));
  console.log(`Saved ${p}`);
}

/** Re-reads every cached extract; unreadable ones are marked as errors so the next fetch replaces them. */
function verifyCache(dir: string): void {
  const manifest = readManifest(dir);
  let ok = 0;
  const bad: string[] = [];
  for (const [k, e] of Object.entries(manifest.entries)) {
    if (e.status !== "ok") continue;
    const [exchange, date] = k.split(":") as [BhavExchange, string];
    const p = resolve(dir, cachePath(exchange, date));
    try {
      const text = gunzipSync(readFileSync(p)).toString("utf8");
      const n = text.split("\n").filter((l) => l !== "").length - 1;
      if (!text.startsWith(COMPACT_HEADER) || n !== e.rows) throw new Error(`expected ${e.rows} rows, found ${n}`);
      ok++;
    } catch (err) {
      bad.push(k);
      manifest.entries[k] = { ...e, status: "error", error: `verify: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  writeManifest(dir, manifest);
  console.log(`Verified ${ok} extracts; ${bad.length} unreadable${bad.length ? `: ${bad.slice(0, 10).join(", ")}` : ""}.`);
}

async function main() {
  const args = parseArgs();
  if (args.coverage) {
    printCoverage(readManifest(resolve(ROOT, str(args, "dir", ".cache/bhavcopy")!)));
    return;
  }
  if (args.verify) {
    verifyCache(resolve(ROOT, str(args, "dir", ".cache/bhavcopy")!));
    return;
  }
  if (args["index-daily"]) {
    await fetchIndexDaily(args);
    return;
  }
  await fetchRange(args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
