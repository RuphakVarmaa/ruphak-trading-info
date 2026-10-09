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

Run it on weekdays after the close and Yahoo's settle time, e.g. 16:45 IST. A missed night is caught up by the next run, because the Indian window is 60 days and stale cross-asset series refetch 60 days. Cron on a machine that is on in the evening (times in UTC; 16:45 IST = 11:15 UTC):

```
15 11 * * 1-5  cd /path/to/ruphak-trading-info && npm run fetch-history -- --save >> .cache/history/archive.log 2>&1
```

GitHub Actions is possible but is **not installed**. The repository's only workflow, `.github/workflows/ci.yml`, deploys on pushes to `main`, so a data job must never push to `main` or reuse that workflow's secrets. It would need its own file with `permissions: contents: read`:

- a `schedule: cron "15 11 * * 1-5"` trigger;
- `npm ci`, then `npm run fetch-history -- --save`;
- persistence through `actions/cache` (path `.cache/history`, key `yahoo-5m-archive-${{ github.run_id }}`, restore-key `yahoo-5m-archive-`).

GitHub evicts caches unused for 7 days, and Yahoo may throttle runner IPs, so a local cron with a backup copy is the more reliable choice.
