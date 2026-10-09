# Market data: closing-auction artefacts, cleaning flags, 5-minute archive

Checked on 9 October 2026 against a Yahoo history snapshot of 59 sessions (16 Jul – 8 Oct 2026). The before/after backtest is in `reports/wp1-cleaning.md`.

## What the engine reads

- Yahoo chart v8, 5-minute bars of `^NSEI`, `^BSESN`, `^NSEBANK` and `^INDIAVIX` (Yahoo serves about 60 days), and of the cross assets the gap and global signals use: `ES=F NQ=F CL=F BZ=F GC=F DX-Y.NYB USDINR=X ^TNX ^VIX ^N225 ^HSI 000001.SS`. Daily bars for all of them. The data is unofficial and delayed by 1–2 minutes.
- The previous close is the session's last 5-minute close. It matches Yahoo's daily close: the mean gap over 59 sessions is 0.0085% for NIFTY and 0.0007% for SENSEX.

## The closing auction and what it does to the bars

Since 3 August 2026, continuous trading in NSE's F&O stocks ends at 15:15 IST. A closing auction then sets the close, and BSE runs the equivalent. Yahoo's 5-minute index bars show it:

- **NIFTY and BANKNIFTY:** the 15:15 and 15:20 bars are flat (open = high = low = close), and the whole closing move lands in the 15:25 bar, whose close is the official close.

  | flat bars (o = h = l = c) | 15:15, before 3 Aug | 15:15, from 3 Aug | 15:20, before 3 Aug | 15:20, from 3 Aug |
  |---|---|---|---|---|
  | NIFTY | 0 of 12 | 37 of 47 | 0 of 12 | 46 of 46 |
  | BANKNIFTY | 0 of 12 | 46 of 47 | 0 of 12 | 46 of 46 |

- **SENSEX:** the 15:20 bar swings while NIFTY is flat, and the 15:25 bar falls back to the official close.
  - The mean absolute 15:20 body went from 0.024% before 3 August to 0.202% after, with a maximum of 1.27%. The 15:25 body went from 0.013% to 0.140%.
  - On 10 Sep the 15:20 bar ran from 74,630.50 to 75,577.74 (+1.27%, high 75,803.76), then the 15:25 bar fell 0.89% to 74,902.59. On 27 Aug and 3 Sep the 15:20 lows were about 2.9% under the open.
  - Yahoo's daily SENSEX bars do not contain these prints (10 Sep daily high 74,910.96, low 74,598.47). They are not tradeable prices.

The engine stops entries at 14:30 and squares off at 15:05, so these bars never price a trade. They reach the **next morning's** features instead:

- the 120-bar cross-session history behind RSI, ADX/DI, Supertrend, EMA9/21 and the Bollinger bands;
- previous-day high and low;
- realized vol for the first 30 minutes, which borrows the previous session's last bars;
- NIFTY's BANKNIFTY divergence z-score, through its 15:15–15:30 window.

`clipWicks` (0.3%) trims only wicks. The 10 Sep SENSEX print passes untouched: its close is the problem, and its wick is inside 0.3%.

## Cleaning flags (`src/engine/config.ts`, `features`)

The cutoff is **on by default since 9 Oct 2026** (owner's decision after the before/after below); the body clip stays off. The reference backtest moved from 51 trades / −₹9,595.92 to 50 trades / −₹19,400.94, a −1.25 standard-error difference. `--indicator-cutoff off` reproduces the old behaviour.

| flag | what it does | backtest switch |
|---|---|---|
| `indicatorCutoffIst: "15:15"` (default since 9 Oct 2026; `null` keeps every bar) | NIFTY, SENSEX and BANKNIFTY bars that open at or after the time are left out of every feature, including today's bars after the cutoff. Kept: the previous close (the official close, so the gap and daily vol do not move), the spot/LTP and India VIX. The time must lie between the square-off and 15:30, so the features that manage open positions are never frozen. | `--indicator-cutoff 15:15` (default) or `--indicator-cutoff off` |
| `bodyClip: true` (default `false`) | A NIFTY or SENSEX bar that moved more than 0.6% open to close while the other index moved less than 0.1% in the same bar is flattened to its open. Each clip is logged once per process with `console.warn`, e.g. `[features] body clip ^BSESN 2026-09-10 15:20 IST bar: body +1.269% while ^NSEI moved +0.000%; o 74630.50 h 75803.76 l 74482.48 c 75577.74 -> flat at 74630.50`. | `--body-clip` |

The body clip is not a substitute for the cutoff:

- In the 59 sessions it fired only on closing-auction bars: 6 bars at 15:20 or 15:25, and none before 15:15.
- It leaves the next bar's open. SENSEX's 10 Sep 15:25 bar still opens at the bad 75,575, which then becomes the previous-day high.
- It flattens NIFTY's auction bar but not BANKNIFTY's matching bar. That fakes a NIFTY-vs-BANKNIFTY divergence for the next 20 sessions.

With the cutoff on, it changes nothing on this sample.

Reproduce the comparison:

```
npx tsx scripts/wp1-compare.ts --history <snapshot.json> --from 2026-07-23 --to 2026-10-08
```

This replays the snapshot with the flags off and on, lists every trade that differs with its features and decisions, and logs each replay in `reports/trials.jsonl`.

## The 5-minute archive (`npm run fetch-history -- --save`, no keys)

Yahoo keeps only about 60 days of 5-minute bars, so every day that is not saved is lost. One run does three things:

1. **Fetches the window.** It takes the 5-minute window of the four Indian series (60 days) and the 12 cross assets. Cross assets get 60 days when the archive is more than 3 days behind, else 5 days, because each 24-hour series is about 1 MB per 60 days.
2. **Saves it unchanged.** The fetched window goes to `.cache/history/yahoo-5m-YYYYMMDD.json`, named by IST date. A second run on the same day gets a `-HHMM` suffix.
3. **Appends new bars** to `.cache/history/yahoo-5m-archive.json`:
   - A bar is added only once it has closed at least 30 minutes before the fetch. Some Yahoo feeds run 10–15 minutes late: Hong Kong's and Shanghai's last bars were still revised 15 minutes after the close. A newer bar is simply taken by the next run.
   - An archived bar is never changed or removed. If Yahoo later serves it differently, the revision is recorded in `archive.revisions` and the dated capture keeps what was served.
   - The archive also carries the latest 2-year daily bars. These are refreshed on each run, not archived; daily history stays downloadable.

   The archive has the same shape as a backtest snapshot, so it replays directly:

   ```
   npm run backtest -- --history .cache/history/yahoo-5m-archive.json --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits
   ```

Sizes: the first capture is about 13 MB, because it fetches 60 days of everything. Later captures are about 2–3 MB, and the archive grows by about 0.3 MB per trading day. `.cache/` is gitignored, so back the archive up somewhere durable. The archive was started on 9 Oct 2026 at about 09:20 IST. It holds Indian bars from 16 Jul 09:15 to 8 Oct 15:25 and cross assets from their 60-day windows.

### Running it nightly

Once the D1 archive below is deployed, the engine archives every trading day by itself and this laptop cron is optional: a second copy, and the source for a back-fill.

Run it on weekdays after the close and Yahoo's settle time, e.g. 16:45 IST. A missed night is caught up by the next run, because the Indian window is 60 days and stale cross-asset series refetch 60 days. Cron on a machine that is on in the evening (times in UTC; 16:45 IST = 11:15 UTC):

```
15 11 * * 1-5  cd /path/to/ruphak-trading-info && npm run fetch-history -- --save >> .cache/history/archive.log 2>&1
```

GitHub Actions is possible but is **not installed**. The repository's only workflow, `.github/workflows/ci.yml`, deploys on pushes to `main`, so a data job must never push to `main` or reuse that workflow's secrets. It would need its own file with `permissions: contents: read`:

- a `schedule: cron "15 11 * * 1-5"` trigger;
- `npm ci`, then `npm run fetch-history -- --save`;
- persistence through `actions/cache` (path `.cache/history`, key `yahoo-5m-archive-${{ github.run_id }}`, restore-key `yahoo-5m-archive-`).

GitHub evicts caches unused for 7 days, and Yahoo may throttle runner IPs, so a local cron with a backup copy is the more reliable choice.

## The private archive in D1 (`bars_5m`)

The GitHub repository is **public**, so raw market data never goes into git: the laptop archive stays in `.cache/` (gitignored), the back-fill SQL goes to the OS temp directory, an export goes to `.cache/` or outside the repository (both scripts refuse a path git could commit), and the engine keeps its own archive in D1 (`ruphak-trading`, binding `DB`), which only the Cloudflare account can read.

### Setting it up

1. `npm run db:migrate:remote` creates the table (CI does this on a push to `main`).
2. `npm run deploy:engine` adds the 16:15 IST job (CI does this too). Without the table, the job only records an error.
3. Back-fill the laptop archive, outside market hours (below).
4. After the next 16:15 IST run, check `/ops/archive-status`.

The preview environment has no archive cron. Once its own database has the migration, `POST /ops/archive` runs the job there by hand.

### What is archived

Every settled 5-minute bar of the 16 symbols the engine's market-data source holds: NIFTY, SENSEX, BANKNIFTY, India VIX and the 12 cross assets. Bars are stored as Yahoo serves them, including off-session bars such as the 15:30 closing tick (the replay filters sessions itself). Daily bars are not archived; Yahoo serves years of them.

Table `bars_5m` (`migrations/0001_bars_5m.sql`), primary key `(symbol, t)`:

| column | content |
|---|---|
| `symbol` | Yahoo symbol, e.g. `^NSEI`, `ES=F` |
| `t` | bar open time, epoch ms |
| `o`, `h`, `l`, `c` | prices as served |
| `v` | volume (0 for the Indian indices) |
| `oi` | open interest; NULL for Yahoo bars |
| `source` | writer that archived the bar first: `yahoo:engine` or `yahoo:fetch-history` (back-fill) |
| `first_seen_ms` | when the bar was first archived |

Rows are only ever inserted, with `INSERT OR IGNORE`. They are never updated or deleted, and the nightly prune does not touch the table.

### When and how the engine writes it

At 16:15 IST on trading days (cron `45 10 * * MON-FRI`, after the 16:00 end of day), `workers/engine/src/barArchive.ts` runs inside the trading Durable Object:

1. The DO refreshes its market-data source as usual (Indian indices: Yahoo's 60-day window; cross assets: 5 days) and hands over the bars it holds.
2. A bar is written once it closed 30 minutes before the run, the `fetch-history` rule. At 16:15 that is every Indian bar of the day and cross-asset bars up to 15:40; later bars go in with the next run.
3. Per symbol, it compares the fresh bars with the archive from IST midnight of the day of the last archived bar. The first run therefore writes everything Yahoo still serves, and a missed night is caught up by the next run. A cross asset whose archive is empty or ends before the 5-day window gets one `range=60d` request. An archive that ends before even Yahoo's 60-day window is reported under `gaps`: those bars are lost.
4. Inserts are `INSERT OR IGNORE`, 9 rows per statement (D1 allows 100 bound parameters) and 50 statements per batch. A normal day is about 280 statements in 6 batches. Running the job twice changes nothing.
5. A fresh copy that differs from the archived bar is a **revision**. It is counted and logged with up to 5 examples (`bar archive: revised bars` in Workers Logs), and the archived copy is kept. Most revisions are volume-only, because Yahoo's 5-day and 60-day ranges disagree on futures volumes. A few change prices: in a test run on 9 Oct, a Hang Seng bar's high and close had changed hours later. The next run compares the same day again, so it can count a revised bar a second time.
6. Non-trading days are skipped: the bundled holiday calendar plus the dashboard's overrides.

The job runs outside the alarm loop and never throws. A failure is logged as `bar archive failed` and recorded in the status below. It can neither stop trading nor count toward DEGRADED.

Status (KV key `archive:bars_5m:status`), and a manual run:

```
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<engine-host>/ops/archive-status
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<engine-host>/ops/archive          # ?full=1: compare everything held; ?force=1: run on a non-trading day
```

The status has `ok`, `ranAt`, `skipped`, `new` (bars found), `added` (rows inserted), `revisions`, per-symbol counts with the last archived bar, `fetched60d`, `gaps`, `errors` and `lastOkAt` (the last run that wrote without an error).

### Back-filling from the laptop archive

Do this once, and again whenever a laptop archive holds days D1 lacks:

```
npm run archive-backfill -- --archive .cache/history/yahoo-5m-archive.json            # --apply-local loads the files into the local D1 too
```

- It writes `INSERT OR IGNORE` SQL files of 20,000 bars each, plus `manifest.json`, to a new directory under the OS temp directory. `--out` picks another directory, but never one inside the repository.
- It keeps only bars that closed 30 minutes before the file's `savedAt`. Each bar's `first_seen_ms` is the first capture that could have archived it.
- It prints one command per file. Run them from the repository root, outside market hours. Wrangler asks for confirmation, and the database serves no queries while a file is imported (a few seconds each):

  ```
  npx wrangler d1 execute ruphak-trading --remote --config workers/engine/wrangler.jsonc --file <dir>/bars-0001.sql
  npm run archive-export -- --remote --compare .cache/history/yahoo-5m-archive.json    # then: every bar identical?
  ```

The 9 Oct archive gives 7 files with 128,928 bars (16.5 MB of SQL). Applied to the local D1 and read back, all 128,928 bars were identical to the JSON, value for value. A backtest on the export matched a backtest on the JSON archive trade for trade. Delete the SQL files once they are applied.

### Exporting for a backtest

```
npm run archive-export -- --from 2026-07-01 --to 2026-12-31          # local D1 -> .cache/history/d1-5m-export.json
npm run backtest -- --history .cache/history/d1-5m-export.json --from 2026-07-08 --to 2026-12-31 --no-events --prod-limits
```

- It reads the local D1 by default. `--remote` reads the deployed database; it is read-only, and rows read are billed.
- The output is the snapshot format `--save-history` writes. Daily bars are fetched from Yahoo (2 years, longer when the archive reaches further back) and frozen into the file. `--daily-from <snapshot>` takes them from a saved file instead, and `--no-daily` leaves them out, so the replay builds them from the 5-minute bars.
- Leave a week of warm-up before `--from`; the script suggests a window.

### Cost

Measured on the local D1 with the 9 Oct archive: a bar takes 109.5 bytes including its primary-key index. Each new bar counts as 2 rows written (the table and the index), and re-inserting an archived bar writes nothing.

| | per trading day | per year |
|---|---|---|
| bars | ≈2,470 (Indian 4 × 75; 24-hour futures ≈280 each; the rest 45–160) | ≈620,000 |
| D1 storage | ≈270 KB | ≈68 MB |
| rows written | ≈4,900 | ≈1.2 million |
| rows read | ≈2,500 (the comparison window) | ≈0.6 million |

Workers Paid includes 50 million rows written and 25 billion rows read a month, plus 5 GB of storage, so the archive adds nothing to the bill. The one-off back-fill writes about 258,000 rows; that is more than the free plan's 100,000 a day, but within the paid allowance. An export reads one row per bar.
