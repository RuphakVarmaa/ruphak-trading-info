/**
 * Back-fills the private D1 bar archive (table bars_5m) from the JSON archive `npm run fetch-history -- --save`
 * keeps on a laptop (or from any `backtest --save-history` snapshot). It writes INSERT OR IGNORE SQL files to
 * a directory OUTSIDE the repository and prints the wrangler commands that apply them; it never touches the
 * remote database. The repository is public, so raw market data must never be committed (docs/DATA.md).
 *
 *   npm run archive-backfill                       # .cache/history/yahoo-5m-archive.json -> <tmp>/ruphak-bars-backfill-<stamp>/
 *   npm run archive-backfill -- --archive ~/yahoo-5m-archive.json --out ~/bars-sql --apply-local
 *   options: --symbols ^NSEI,^BSESN   --from 2026-07-01 --to 2026-10-09   (IST dates, inclusive)
 *            --rows-per-file 20000    --rows-per-statement 500             --force (write into a non-empty --out)
 *            --apply-local            run the files against the local D1 (.wrangler/state; npm run db:migrate:local first)
 *
 * Only bars that closed 30 minutes before the file's savedAt are written, and each bar's first_seen_ms is
 * the first capture that could have archived it. Apply to production by hand, outside market hours (each
 * file is imported in one go and the database serves no queries meanwhile):
 *
 *   npx wrangler d1 execute ruphak-trading --remote --config workers/engine/wrangler.jsonc --file <file>
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DAY_MS, formatIst, istMidnight } from "../src/engine/clock";
import { BACKFILL_SOURCE, backfillRows, backfillSqlFiles, DEFAULT_ROWS_PER_FILE, DEFAULT_ROWS_PER_STATEMENT, type HistoryFile } from "../src/engine/market/barArchive";
import { d1FileCommand, d1QueryCommand, executeLocalD1File, isInsideRepo, LOCAL_PERSIST, queryD1, shellQuote } from "./lib/d1";
import { fail, num, parseArgs, ROOT, str } from "./lib/node";

const COUNT_SQL = "SELECT symbol, COUNT(*) AS bars, MIN(t) AS first, MAX(t) AS last FROM bars_5m GROUP BY symbol ORDER BY symbol";

function istRange(from: string | undefined, to: string | undefined): { fromMs?: number; toMs?: number } {
  for (const d of [from, to]) if (d !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(d)) fail(`--from/--to must be YYYY-MM-DD, got ${d}`);
  return { fromMs: from ? istMidnight(from) : undefined, toMs: to ? istMidnight(to) + DAY_MS : undefined };
}

function main(): void {
  const args = parseArgs();
  const archivePath = resolve(ROOT, str(args, "archive", ".cache/history/yahoo-5m-archive.json")!);
  if (!existsSync(archivePath)) fail(`No archive at ${archivePath}. Build one with npm run fetch-history -- --save, or pass --archive <file>.`);
  const file = JSON.parse(readFileSync(archivePath, "utf8")) as HistoryFile;
  const symbols = str(args, "symbols")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const plan = backfillRows(file, { symbols, ...istRange(str(args, "from"), str(args, "to")) });
  if (plan.rows.length === 0) fail(`Nothing to write: no settled bars in ${archivePath} for the given symbols and dates.`);

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const outDir = resolve(ROOT, str(args, "out", join(tmpdir(), `ruphak-bars-backfill-${stamp}`))!);
  if (isInsideRepo(outDir)) {
    fail(`--out ${outDir} is inside the repository. The repository is public and raw market data must stay out of git: write the SQL files outside it (the default is under ${tmpdir()}).`);
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0 && args.force !== true) fail(`${outDir} is not empty; choose another --out, or pass --force to write into it.`);
  mkdirSync(outDir, { recursive: true });

  const files = backfillSqlFiles(plan.rows, {
    rowsPerFile: num(args, "rows-per-file", DEFAULT_ROWS_PER_FILE),
    rowsPerStatement: num(args, "rows-per-statement", DEFAULT_ROWS_PER_STATEMENT),
    header: [`source: ${basename(archivePath)} (${file.source ?? "?"}, saved ${file.savedAt ?? "?"}); generated ${new Date().toISOString()} by scripts/archive-backfill.ts`],
  });
  const paths = files.map((f) => {
    const p = join(outDir, f.name);
    writeFileSync(p, f.sql);
    return p;
  });
  const bytes = files.reduce((s, f) => s + Buffer.byteLength(f.sql), 0);
  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        archive: archivePath,
        savedAt: file.savedAt ?? null,
        settledBefore: new Date(plan.settledBeforeMs).toISOString(),
        source: BACKFILL_SOURCE,
        bars: plan.rows.length,
        skipped: plan.skipped,
        symbols: plan.symbols,
        files: files.map((f) => ({ name: f.name, rows: f.rows, statements: f.statements, bytes: Buffer.byteLength(f.sql), symbols: f.symbols })),
      },
      null,
      2,
    ),
  );

  console.log(`Read ${archivePath} (${file.source ?? "?"}, saved ${file.savedAt ?? "?"}); bars that closed by ${formatIst(plan.settledBeforeMs)} are included.`);
  for (const [sym, r] of Object.entries(plan.symbols)) console.log(`  ${sym.padEnd(10)} ${String(r.rows).padStart(7)} bars  ${formatIst(r.fromMs).slice(0, 16)} .. ${formatIst(r.toMs).slice(0, 16)}`);
  const sk = plan.skipped;
  console.log(`Left out: ${sk.unsettled} not settled, ${sk.invalid} invalid, ${sk.outOfRange} outside --from/--to, ${sk.duplicates} duplicates.`);
  console.log(`\nWrote ${files.length} SQL file(s), ${plan.rows.length} bars, ${(bytes / 1e6).toFixed(1)} MB, to ${outDir} (manifest.json lists them).`);
  console.log(`They hold raw market data: keep them out of the repository and delete them once applied.`);

  if (args["apply-local"] === true) {
    console.log(`\nApplying to the local D1 (${LOCAL_PERSIST}):`);
    paths.forEach((p, i) => {
      const t0 = Date.now();
      executeLocalD1File(p);
      console.log(`  ${files[i].name}: ${files[i].rows} bars (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    });
    for (const r of queryD1([COUNT_SQL], "local")[0]) {
      console.log(`  local bars_5m ${String(r.symbol).padEnd(10)} ${String(r.bars).padStart(7)} bars  ${formatIst(Number(r.first)).slice(0, 16)} .. ${formatIst(Number(r.last)).slice(0, 16)}`);
    }
  }

  console.log(`\nTo test the files locally first (npm run db:migrate:local once):`);
  for (const p of paths) console.log(`  ${d1FileCommand(p, "local")}`);
  console.log(`\nThen apply them to production by hand, from the repository root, OUTSIDE market hours (after 17:00 IST or at the`);
  console.log(`weekend): wrangler asks for confirmation, and the database serves no queries while a file is imported (seconds).`);
  console.log(`Re-running a file is harmless (INSERT OR IGNORE).`);
  for (const p of paths) console.log(`  ${d1FileCommand(p, "remote")}`);
  console.log(`\nCheck (reads every row once):\n  ${d1QueryCommand(COUNT_SQL, "remote")}`);
  console.log(`Compare D1 with this file, bar by bar (reads only; writes nothing):\n  npm run archive-export -- --remote --compare ${shellQuote(archivePath)}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
