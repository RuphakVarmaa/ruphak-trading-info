/**
 * What the recorded option quotes (D1 `option_quotes`: Groww Trade API or Upstox) say about selling the at-the-money straddle at
 * the open: the question WP11 left open (reports/wp11-real-intraday.md §9; docs/DATA.md). Read-only: it
 * reads D1 and prints. Definitions and math: src/engine/backtest/quoteReport.ts.
 *
 *   npm run quotes-report                                     # the local D1 (.wrangler/state)
 *   npm run quotes-report -- --from 2026-10-12 --to 2027-01-15
 *   npm run quotes-report -- --remote                         # the deployed database (read-only; rows read are billed)
 *   options: --no-sessions       leave out the per-session tables
 *            --json <file>       also write the results as JSON (under .cache/ or outside the repository:
 *                                they hold quote data and the repository is public)
 *            --ledger            append the §12 variants to reports/trials.jsonl (only with ≥ 60 sessions)
 *            --resamples 20000   bootstrap resamples
 *            --page-rows 20000   rows per query
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CONVENTIONS,
  ENTRY_IDS,
  EXIT_IDS,
  MIN_SESSIONS,
  WP11_BID_TOLERANCE_PCT,
  WP11_MID_EDGE_PCT,
  buildQuoteReport,
  dateBounds,
  trialRecords,
  variantName,
  type QuoteReport,
  type StraddleSale,
} from "../src/engine/backtest/quoteReport";
import { TrialLedger } from "../src/engine/backtest/trials";
import { formatIst } from "../src/engine/clock";
import { quoteRowFromDb, quotesPageSql, type QuoteRow } from "../src/engine/market/quoteRecorder";
import { isGitIgnored, isInsideRepo, queryD1, type D1Target } from "./lib/d1";
import { fail, num, parseArgs, ROOT, str } from "./lib/node";

const args = parseArgs();
const LEDGER = "reports/trials.jsonl";
/** index × convention × entry × exit evaluated by the §12 statistics: counted as trials even when not logged. */
const VARIANTS = 2 * CONVENTIONS.length * ENTRY_IDS.length * EXIT_IDS.length;

function readRows(target: D1Target, bounds: { fromMs?: number; toMs?: number }, pageRows: number): QuoteRow[] {
  const rows: QuoteRow[] = [];
  let after: { snapshotMs: number; symbol: string } | null = null;
  for (;;) {
    const [page] = queryD1([quotesPageSql(after, { ...bounds, limit: pageRows })], target);
    const got = (page ?? []).map(quoteRowFromDb);
    rows.push(...got);
    if (got.length < pageRows) return rows;
    const last = got[got.length - 1];
    after = { snapshotMs: last.snapshotMs, symbol: last.tradingSymbol };
  }
}

function ledger(): TrialLedger {
  const p = resolve(ROOT, LEDGER);
  return new TrialLedger(
    {
      read: () => (existsSync(p) ? readFileSync(p, "utf8") : null),
      append: (text) => {
        mkdirSync(dirname(p), { recursive: true });
        appendFileSync(p, text);
      },
    },
    p,
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const f = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : x.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}`);
const rupees = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `${x < 0 ? "−" : ""}₹${Math.abs(Math.round(x)).toLocaleString("en-IN")}`);
const hms = (ms: number) => formatIst(ms).slice(11, 19);

/** Fixed-width table: the first `left` columns left-aligned, the rest right-aligned. */
function grid(rows: string[][], left = 1): string {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  return rows.map((r) => r.map((v, c) => (c < left ? v.padEnd(widths[c]) : v.padStart(widths[c]))).join("  ").trimEnd()).join("\n");
}

const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

function sale(r: QuoteReport, date: string, index: string, conv: string, entry: string, exit: string): StraddleSale | undefined {
  return r.sales.find((s) => s.date === date && s.index === index && s.convention === conv && s.entry === entry && s.exit === exit);
}

function printSessions(r: QuoteReport): void {
  console.log("\n1. The 09:15 sale: the straddle's bids at the 09:15:15-09:16:30 snapshots vs the 09:15 minute's last trades");
  console.log("   (WP11's near-miss assumed a fill at that last trade). Convention B, and A on expiry days. Prices per unit; % = (bids − reference) / reference.");
  const t1 = [["date", "index", "conv", "first quote", "strike", "spot", "bids", "09:15 last", "vs minute %", "vs LTP %", "window mean %", "spread %"]];
  for (const w of r.opening) {
    const q = w.quotes[0];
    if (!q) {
      t1.push([w.date, w.index, w.convention, "no quote", "", "", "", "", "", "", "", ""]);
      continue;
    }
    t1.push([w.date, w.index, w.convention, hms(q.snapshotMs), f(q.strike, 0), f(q.spot), f(q.bid), `${f(q.minuteLast)}${q.minuteExact || q.minuteLast === null ? "" : "*"}`, pct(q.slipVsMinutePct), pct(q.slipVsLtpPct), pct(w.meanSlipVsMinutePct), f(q.spreadPct)]);
  }
  console.log(grid(t1, 4));
  console.log("   * the last trade the recorder saw in the minute; a later trade in the same minute may have been missed.");

  console.log("\n2. Later entries: the bids vs that minute's last trades / vs the last trades at the same snapshot (%), and the buy-back: the 09:15 strike's asks vs its last trades at 15:00 and 15:20 (%)");
  const t2 = [["date", "index", "conv", "09:20 %", "09:30 %", "11:15 %", "15:00 ask %", "15:20 ask %"]];
  for (const w of r.opening) {
    const e = (entry: string) => {
      const s = sale(r, w.date, w.index, w.convention, entry, "15:00") ?? sale(r, w.date, w.index, w.convention, entry, "15:20");
      return s ? `${pct(s.entrySlipPct)} / ${pct(s.entrySlipVsLtpPct)}` : "–";
    };
    const x = (exit: string) => pct(sale(r, w.date, w.index, w.convention, "09:15", exit)?.exitSlipPct);
    t2.push([w.date, w.index, w.convention, e("09:20"), e("09:30"), e("11:15"), x("15:00"), x("15:20")]);
  }
  console.log(grid(t2, 3));

  console.log("\n3. Net per lot for the seller of the 09:15 straddle, after charges: at the touch (sold at the bids, bought back at the asks) and at the last trades (WP11's mid fill)");
  const t3 = [["date", "index", "conv", "strike", "lot", "premium", "→15:00 touch", "→15:00 last", "→15:20 touch", "→15:20 last"]];
  for (const w of r.opening) {
    const a = sale(r, w.date, w.index, w.convention, "09:15", "15:00");
    const b = sale(r, w.date, w.index, w.convention, "09:15", "15:20");
    const any = a ?? b;
    t3.push([w.date, w.index, w.convention, any ? f(any.strike, 0) : "–", any ? String(any.lot) : "–", rupees(any?.premium), rupees(a?.netTouch), rupees(a?.netLast), rupees(b?.netTouch), rupees(b?.netLast)]);
  }
  console.log(grid(t3, 3));
}

function printSpreads(r: QuoteReport): void {
  console.log("\n4. The at-the-money straddle's spread, (ask − bid) / mid, by slot: median % (75th percentile) [snapshots]");
  const cols = [...new Set(r.spreads.map((s) => `${s.index} ${s.kind}`))].sort();
  const buckets = [...new Set(r.spreads.map((s) => s.bucket))].sort();
  const t = [["slot", ...cols]];
  for (const b of buckets) {
    t.push([
      b,
      ...cols.map((c) => {
        const s = r.spreads.find((x) => `${x.index} ${x.kind}` === c && x.bucket === b);
        return s ? `${s.median.toFixed(2)} (${s.p75.toFixed(2)}) [${s.n}]` : "–";
      }),
    ]);
  }
  console.log(cols.length > 0 ? grid(t) : "   (no two-sided at-the-money quotes)");
}

function printSummary(r: QuoteReport): void {
  console.log("\n5. Every session: mean ₹ per lot after charges at the touch and at the last trades, and the mean slippage at entry and exit (%)");
  const t = [["variant", "trades", "touch ₹", "last ₹", "touch − last ₹", "entry %", "exit %"]];
  for (const index of ["NIFTY", "SENSEX"] as const) {
    for (const conv of CONVENTIONS) for (const entry of ENTRY_IDS) for (const exit of EXIT_IDS) {
      const xs = r.sales.filter((s) => s.index === index && s.convention === conv && s.entry === entry && s.exit === exit);
      if (xs.length === 0) continue;
      const touch = avg(xs.map((s) => s.netTouch));
      const last = avg(xs.map((s) => s.netLast));
      t.push([variantName(index, conv, entry, exit), String(xs.length), rupees(touch), rupees(last), rupees(touch !== null && last !== null ? touch - last : null), pct(avg(xs.map((s) => s.entrySlipPct))), pct(avg(xs.map((s) => s.exitSlipPct)))]);
    }
  }
  console.log(t.length > 1 ? grid(t) : "   (no complete sale yet: an entry and a 15:00 or 15:20 snapshot of the same strike)");
  console.log("   Convention A equals B on days without an expiring contract.");

  console.log(`\n6. Entry slippage vs the entry minute's last trades, % of premium (day-clustered bootstrap 95% CI). WP11's mid-fill edge was ${WP11_MID_EDGE_PCT.lo}-${WP11_MID_EDGE_PCT.hi}% of premium:`);
  console.log(`   it survives only if the bid sits within about ${WP11_BID_TOLERANCE_PCT.lo}-${WP11_BID_TOLERANCE_PCT.hi}% of the last trade (reports/wp11-real-intraday.md §9).`);
  console.log("   The last columns compare the bids with the last trades at the same snapshot: the spread alone, without the price moving inside the minute.");
  const s = [["index", "conv", "entry", "n", "days", "mean %", "95% CI", "median %", "vs LTP mean %", "vs LTP 95% CI"]];
  for (const x of r.slippage) {
    if (!x.stat) continue;
    s.push([x.index, x.convention, x.entry, String(x.stat.n), String(x.stat.days), pct(x.stat.mean), `${pct(x.stat.lo)} … ${pct(x.stat.hi)}`, pct(x.stat.median), pct(x.vsLtp?.mean), x.vsLtp ? `${pct(x.vsLtp.lo)} … ${pct(x.vsLtp.hi)}` : "–"]);
  }
  console.log(s.length > 1 ? grid(s, 3) : "   (no entry with a last trade in its minute yet)");
}

function printStats(r: QuoteReport, nTrials: number): void {
  console.log(`\n7. The plan's §12 bar on the net per lot at the touch (Bonferroni N = ${nTrials}: the ledger's lines plus this report's ${VARIANTS} variants)`);
  if (!r.stats) {
    console.log(`   not enough sessions: ${r.sessions.length} of ${MIN_SESSIONS}. The statistics run once ${MIN_SESSIONS} sessions are recorded.`);
    return;
  }
  for (const v of r.stats) {
    console.log(`\n   ${v.variant}: ${v.verdict} (${v.trades} trades on ${v.sessions} sessions, net ${rupees(v.net)})`);
    for (const c of v.criteria) console.log(`     ${c.verdict.padEnd(12)} ${c.name}: ${c.detail}`);
  }
  console.log("\n   A rule passes only with no FAIL and no N/A: the placebo and the ±20% checks need a paper test with orders at random times.");
}

async function main(): Promise<void> {
  const target: D1Target = args.remote === true ? "remote" : "local";
  const from = str(args, "from");
  const to = str(args, "to");
  for (const d of [from, to]) if (d !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(d)) fail(`--from/--to must be YYYY-MM-DD, got ${d}`);
  const jsonOut = str(args, "json");
  if (jsonOut && isInsideRepo(jsonOut) && !isGitIgnored(jsonOut)) fail(`--json ${jsonOut} could be committed. The repository is public: write under .cache/ or outside the repository.`);

  console.log(`Reading option_quotes from the ${target} D1${target === "remote" ? " (read-only; rows read are billed)" : " (.wrangler/state)"}...`);
  let rows: QuoteRow[];
  try {
    rows = readRows(target, dateBounds(from, to), num(args, "page-rows", 20_000));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(msg)) fail(`The ${target} D1 has no option_quotes table: apply the migrations first (${target === "local" ? "npm run db:migrate:local" : "the deploy's npm run db:migrate:remote"}).`);
    throw err;
  }
  const stats = ledger().stats();
  const nTrials = stats.n + VARIANTS;
  const r = buildQuoteReport(rows, { nTrials, srVariance: stats.srVariance, resamples: num(args, "resamples", 20_000), seed: 7 });

  const dq = r.dataQuality;
  const share = (n: number) => (dq.quotes > 0 ? `${((n / dq.quotes) * 100).toFixed(1)}%` : "–");
  console.log(`\n${r.rows.toLocaleString("en-IN")} rows, ${r.sessions.length} session(s)${r.sessions.length > 0 ? ` (${r.sessions[0]} .. ${r.sessions.at(-1)})` : ""}, ${dq.snapshots.toLocaleString("en-IN")} snapshots (manual ones left out).`);
  if (r.rows === 0) {
    console.log("No recorded quotes yet: the trading DO records them on trading days once a quote source is set: the free UPSTOX_ANALYTICS_TOKEN or the Groww Trade API keys (docs/DATA.md).");
  } else {
    console.log(`Quotes with a bid and an ask: ${share(dq.withBidAsk)}; with the exchange's last-trade time: ${share(dq.withLastTradeTime)}; median open-window snapshots a session: ${dq.openSnapshotsPerSession ?? "–"}.`);
    console.log(`Sources: ${Object.entries(dq.bySource).map(([src, n]) => `${src} ${share(n)}`).join("; ")}.`);
    if (args["no-sessions"] !== true) printSessions(r);
    printSpreads(r);
    printSummary(r);
  }
  printStats(r, nTrials);

  if (jsonOut) {
    const out = resolve(ROOT, jsonOut);
    mkdirSync(dirname(out), { recursive: true });
    const { bySession, ...rest } = r;
    writeFileSync(out, JSON.stringify({ target, from: from ?? null, to: to ?? null, generatedAt: new Date().toISOString(), sessionsRecorded: bySession.length, ...rest }, null, 2));
    console.log(`\nWrote ${out}.`);
  }
  if (args.ledger === true) {
    if (!r.stats) console.log(`\n--ledger: nothing appended (${r.sessions.length} of ${MIN_SESSIONS} sessions).`);
    else {
      const lines = trialRecords(r.stats, { ts: new Date().toISOString(), data: `D1 option_quotes (${target}) ${r.sessions[0]}..${r.sessions.at(-1)}, ${r.sessions.length} sessions` });
      ledger().append(...lines);
      console.log(`\nAppended ${lines.length} lines to ${LEDGER}.`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
