# WP1: closing-auction cleaning and the 5-minute archive

Fri 9 Oct 2026. Branch `worktree-agent-a12fc6b14ac3eae31`, built on `9a80d7b` (`claude/gifted-wright-3d8r3j`).

The engine stays PAPER. Nothing was deployed or pushed, and no check, stop or loss cap was touched.

**Data:** the planner's snapshot `scratchpad/why/hist.json` (Yahoo, saved 2026-10-09T02:54:12Z, 59 sessions of 5-minute index bars from 16 Jul to 8 Oct).

**Settings:** every run below uses `npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits` plus the switch named. That is the main account, 54 sessions, synthetic option prices.

The generated tables (every column) are in `reports/wp1-compare.md`, and the attribution diagnostic is in `reports/wp1-compare-genuine.md`.

## 1. Bottom line

| run | trades | hit | net ₹ | PF | maxDD % | Δ trades | Δ net ₹ |
|---|---|---|---|---|---|---|---|
| baseline (flags off) | 51 | 33.3% | **−9,595.92** | 0.79 | 3.73 | | |
| `--indicator-cutoff 15:15` | 50 | 28.0% | −19,400.94 | 0.59 | 5.11 | −1 | −9,805.02 |
| `--body-clip` | 51 | 31.4% | −12,877.01 | 0.73 | 3.81 | 0 | −3,281.09 |
| cutoff + body clip | 50 | 28.0% | −19,400.94 | 0.59 | 5.11 | −1 | −9,805.02 |

- **The defaults are unchanged.** With both flags off, the snapshot replay prints 51 trades and −₹9,595.92. The report JSON is byte-identical (`cmp`) to the run on unmodified `9a80d7b`; this was checked again on the committed code.
  - `npx vitest run`: 672 passed, 1 skipped. The skipped test is the LLM eval gated on `RUN_LLM_EVAL`.
  - `npx tsc --noEmit -p .` and `-p workers/engine` are clean, and eslint is clean on every touched file.
- **The cutoff changes 16 of 51 trades:** 7 removed, 6 added and 3 changed (exit time).
  - Every difference traces back to closing-auction bars. 11 come from a feature change at that very decision, made by auction-era bars.
  - 5 are knock-ons of those: 1 position limit, and 4 source weights from the engine's per-source performance record.
  - No trade before 4 Aug differs.
  - The net change of −₹9,805 is −1.25 standard errors (σ ₹2,175 per trade, 13 trades swapped; p ≈ 0.2), which is noise. The strategy has no edge with or without the fix (PLAN §1).
- **The body clip is not a clean fix.** It fired on 6 bars, all closing-auction bars at 15:20 or 15:25. Of its 6 trade differences:
  - 1 is the same genuine fix as the cutoff's.
  - 2 are caused by an inconsistency the clip creates. It flattens NIFTY's auction bar but not BANKNIFTY's matching one, which fakes a NIFTY-vs-BANKNIFTY divergence.
  - 3 are knock-ons.
- **Cutoff + body clip = cutoff.** No bar before 15:15 was ever flagged in 59 sessions.
- **Recommendation:**
  - **Enable the cutoff by default** (`features.indicatorCutoffIst: "15:15"`) as a demonstrated-bug fix under rule 3 / PLAN §7, after WP8's review and after 15:30 IST. Tell the owner up front that the backtest number gets worse, and that this is noise, not a reason to keep feeding the indicators auction prints.
  - **Keep the body clip off.**
- **Archive:** started this morning. `npm run fetch-history -- --save` holds 60 days of Indian 5-minute bars and 60 days of the 12 cross assets. The nightly cron note is in `docs/DATA.md`.

## 2. The bug, measured on the snapshot

Since 3 Aug 2026, NSE's continuous trading in F&O stocks ends at 15:15 and a closing auction sets the close; BSE runs the equivalent. Yahoo's 5-minute bars for the last 15 minutes are not tradeable prices:

| bars at or after 15:15 | before 3 Aug | from 3 Aug |
|---|---|---|
| NIFTY 15:15 flat (o = h = l = c) | 0 of 12 | 37 of 47 |
| NIFTY 15:20 flat | 0 of 12 | 46 of 46 |
| BANKNIFTY 15:15 flat | 0 of 12 | 46 of 47 |
| BANKNIFTY 15:20 flat | 0 of 12 | 46 of 46 |
| SENSEX 15:20, mean \|close/open − 1\| | 0.024% | 0.202% (max 1.27%) |
| SENSEX 15:25, mean \|close/open − 1\| | 0.013% | 0.140% |

The close lands in the 15:25 bar (NIFTY +0.82% on 3 Aug, +0.38% on 10 Sep). That close is the official close; the last 5-minute close matches Yahoo's daily close to 0.0085% (NIFTY) and 0.0007% (SENSEX) on average.

SENSEX's 15:20 prints are not real index levels. On 10 Sep the 5-minute high/low was 75,803.76 / 74,482.48, against a daily bar of 74,910.96 / 74,598.47. On 27 Aug and 3 Sep the 15:20 lows were 2.9% under the open.

`clipWicks` (0.3%) leaves the 10 Sep 15:20 bar untouched: its close is the problem, and its wick is within the limit.

Entries end at 14:30 and positions are squared off at 15:05, so these bars only reach the **next morning's** features:

- the 120-bar cross-session RSI, ADX/DI, Supertrend, EMA and Bollinger values. Flat bars add zero true range and the jump adds a large one;
- the previous-day high and low;
- realized vol for the first 30 minutes, which borrows the previous session's last returns;
- NIFTY's BANKNIFTY divergence z-score, through its 15:15–15:30 window.

## 3. What was built

| file | change |
|---|---|
| `src/engine/config.ts` (delimited WP1 blocks) | `features.indicatorCutoffIst: string \| null` (default `null`) and `features.bodyClip: boolean` (default `false`). Validation: the cutoff must be HH:MM between `exits.squareOffIst` and 15:30, so features that manage open positions are never frozen. |
| `src/engine/market/features.ts` | `prepare()` drops NIFTY/SENSEX/BANKNIFTY bars that open at or after the cutoff, today's included. The previous close stays the official close (a separate session-close map keeps gap and daily vol unchanged); spot/LTP and India VIX are untouched. `bodyClip()` flattens a NIFTY/SENSEX bar to its open when \|body\| > 0.6% while the other index's same-time bar moved < 0.1%. Every clip is reported once per process: `console.warn` by default (Workers Logs live, with observability at 100%), or a listener via `setBodyClipListener`. The series cache key includes the rules. |
| `src/engine/market/features.test.ts` + fixture `src/engine/__fixtures__/market/snapshot-5m-2026-09-09_11.json` | 15 new tests on the **real 9–11 Sep 2026 bars** of NIFTY, SENSEX, BANKNIFTY and VIX, copied unchanged from the snapshot. They cover: `clipWicks` missing the 15:20 print; the body clip flagging exactly that bar and nothing else in three sessions; previous-day high/low/close with each flag; the cutoff holding for today's bars after 15:15; logging, including a throwing listener; inert flags; cache separation; config validation. |
| `src/engine/market/candles.ts` (+ `candles.test.ts`) | `appendCandles()`: the append-only merge for the archive (settled bars only, archived bars never rewritten, revisions returned). |
| `scripts/fetch-history.ts` | `--save`: the Yahoo 5-minute archive (§7). The Groww path is unchanged. |
| `scripts/backtest.ts` (delimited WP1 block) | `--indicator-cutoff HH:MM` and `--body-clip`. A `dataCleaning` field is written only when a switch is on, so default reports stay byte-identical. |
| `scripts/wp1-compare.ts` (new) | Replays baseline and variants in-process with the CLI's exact config. It reads every persisted decision back, lists every differing trade with the decision in both runs, the signals and the features that changed, classifies the cause, and logs each replay to `reports/trials.jsonl`. A sampled self-check confirms recomputed features equal the engine's own decisions: 0 mismatches. |
| `docs/DATA.md` | Data notes, the flags, archive usage, the nightly cron note and GitHub Actions caveats (no workflow added). |

## 4. Every trade that differs: cutoff 15:15 (16 trades)

The cause is read from what the two replays actually decided:

- **signal:** the features moved a voting signal or the regime at that decision. The regime sets the threshold and the time-stop horizon.
- **perf:** the signal views were identical, but source weights from the per-source performance record differ because earlier trades differed.
- **book:** only position or entry limits differ.

"Sessions" lists the sessions whose 15:15–15:25 bars feed that decision.

| # | kind | trade | baseline → cutoff | cause: decisive change at the decision | sessions |
|---|---|---|---|---|---|
| 1 | added | NIFTY 4 Aug 09:31 BEAR | — → 24600PE, SIGNAL_FLIP 09:51, **−₹1,324.51** | signal: realizedVol2h 24.79 → 8.59 (rvIvRatio 2.07 → 0.72), so HIGH_VOL → RANGE; MOMENTUM −0.45 → −0.84; score −0.429 vs 0.45 → −0.602 vs 0.55 | 3 Aug (NIFTY 15:25 +0.82% jump in the borrowed returns); 31 Jul in the 120-bar window moves only vsBankNiftyZ −2.835 → −2.791 and ADX 34.01 → 34.19 |
| 2 | added | NIFTY 12 Aug 10:01 BEAR | — → 24400PE, TRAIL 14:36, **+₹1,193.97** | signal: ADX 18.30 → 22.53, so MEAN_REVERSION (needs ADX < 20) 0.55 → abstains; score −0.253 → −0.642 (RANGE, threshold 0.50) | 10–11 Aug |
| 3 | removed | SENSEX 12 Aug 10:06 BEAR | 77800PE, TARGET 12:16, **+₹3,079.04** → — | book: same score −0.681 (HIGH_VOL), but "open positions overall 2 of 2" with #2 and the unchanged NIFTY 10:06 trade open | knock-on of #2 |
| 4 | removed | NIFTY 13 Aug 10:36 BEAR | 24300PE, SIGNAL_FLIP 10:41, **−₹259.97** → — | signal: +DI/−DI 18.83/19.90 → 19.75/18.31 (cross) and Supertrend −1 → +1, so TREND_DOWN → RANGE; threshold 0.35 → 0.55 at score −0.37 | 11–12 Aug |
| 5 | added | NIFTY 13 Aug 11:11 BEAR | — → 24300PE, SIGNAL_FLIP 11:31, **−₹590.24** | signal: ADX 20.02 → 25.23 (≥ 25 with −DI > +DI), so RANGE → TREND_DOWN; threshold 0.55 → 0.35 at score −0.39 | 11–12 Aug |
| 6 | changed | SENSEX 17 Aug 10:21 BEAR 77600PE | TIME_STOP 11:51 **−₹86.40** → TIME_STOP 12:21 **−₹1,271.16** | signal: ADX 21.20 → 36.09, so RANGE → TREND_DOWN and the time stop moves 90 → 120 min; prevDayHigh 78,205.79 → 78,048.45 | 13–14 Aug |
| 7 | removed | SENSEX 19 Aug 11:41 BEAR | 76900PE, TIME_STOP 13:41, **−₹661.75** → — | perf: same signal views; MOMENTUM weight 0.140 → 0.129 after #4–#6, so active weight 0.312 → 0.295, below the 0.30 minimum: score −0.712 → 0 | knock-on |
| 8 | removed | NIFTY 24 Aug 10:01 BEAR | 24250PE, TARGET 11:36, **+₹2,804.78** → — | perf: MOMENTUM weight 0.122 → 0.115, active 0.300 → 0.294: score −0.656 → 0 | knock-on |
| 9 | removed | SENSEX 24 Aug 10:01 BEAR | 77600PE, SQUARE_OFF 15:06, **+₹2,472.02** → — | perf: MOMENTUM weight 0.139 → 0.125, active 0.303 → 0.292: score −0.704 → 0 | knock-on |
| 10 | removed | SENSEX 25 Aug 10:26 BEAR | 77100PE, STOP 12:01, **−₹2,283.87** → — | perf: MOMENTUM weight 0.147 → 0.125, active 0.311 → 0.292: score −0.560 → 0 | knock-on |
| 11 | changed | NIFTY 1 Sep 11:16 BULL 24100CE | TIME_STOP 13:16 **−₹2,475.33** → TIME_STOP 12:46 **−₹16.56** | signal: ADX 25.32 → 23.68 (< 25), so TREND_UP → RANGE and the time stop moves 120 → 90 min | 28–31 Aug |
| 12 | removed | SENSEX 4 Sep 09:56 BULL | 76700CE, TIME_STOP 11:26, **+₹713.36** → — | signal: the 3 Sep 15:20 print (−0.83%, low −2.9%) no longer widens the bands: Bollinger width 0.954 → 0.243, %B 0.73 → 1.06, so MEAN_REVERSION abstain → −0.49; score 0.629 → 0.319 (threshold 0.55); prevDayLow 75,651.72 → 76,463.88 | 2–3 Sep |
| 13 | added | NIFTY 4 Sep 11:21 BULL | — → 23950CE, TIME_STOP 13:21, **−₹1,328.74** | signal: vsBankNiftyZ 1.302 → 1.537, so RELATIVE_VALUE abstain → 0.27 and active weight 0.284 → 0.332: score 0 → 0.756 (TREND_UP, threshold 0.45) | 2–3 Sep (z history all auction-era) |
| 14 | added | NIFTY 11 Sep 11:16 BULL | — → 23350CE, TIME_STOP 13:16, **−₹736.22** | signal: ADX 15.24 → 29.96, so RANGE → TREND_UP (threshold 0.65 → 0.45); MEAN_REVERSION −0.67 → abstains; score 0.356 → 0.760 | 9–10 Sep (the 10 Sep prints) |
| 15 | added | NIFTY 11 Sep 11:21 BULL | — → 23350CE, TIME_STOP 13:21, **−₹1,122.45** | signal: as #14 (ADX 16.34 → 29.63); score 0.401 → 0.771 | 9–10 Sep |
| 16 | changed | NIFTY 7 Oct 10:31 BULL 22700CE | TIME_STOP 12:01 **−₹688.59** → TIME_STOP 12:31 **−₹1,995.82** | signal: ADX 20.29 → 28.15, so RANGE → TREND_UP and the time stop moves 90 → 120 min; prevDayHigh 22,776.10 → 22,731.75 | 5–6 Oct |

**Totals:** removed trades +₹5,863.61 (four winners, including two TARGET and one SQUARE_OFF), added −₹3,908.19, changed −₹33.22. Net Δ = −₹9,805.02.

**Scope.** Every one of the 8,100 decision points (2 indices × 75 steps × 54 sessions) gets slightly different indicator inputs, because the 120-bar window always spans the previous session's 15:15–15:25 bars. The stance changed at 41 points and plan/no-plan at 13. The trades that moved are the decisions sitting on the engine's hard thresholds: ADX 25 for the trend regime, ADX 20 for mean reversion, and the 0.30 minimum active weight.

## 5. Every trade that differs: body clip (6 trades)

The 6 clipped bars (each logged once):

| bar | body | other index |
|---|---|---|
| NIFTY 3 Aug 15:25 | +0.818% | SENSEX +0.019% |
| NIFTY 4 Aug 15:25 | +0.619% | SENSEX +0.086% |
| SENSEX 6 Aug 15:20 | +0.800% | NIFTY 0.000% |
| SENSEX 27 Aug 15:20 | −0.712% | NIFTY 0.000% |
| SENSEX 3 Sep 15:20 | −0.825% | NIFTY 0.000% |
| SENSEX 10 Sep 15:20 | +1.269% | NIFTY 0.000% |

The two NIFTY bars are the real auction close, flagged because SENSEX's auction print landed in a different bar.

| # | kind | trade | baseline → body clip | cause |
|---|---|---|---|---|
| 1 | added | NIFTY 4 Aug 09:31 BEAR | — → 24600PE, SIGNAL_FLIP 09:51, **−₹1,324.51** | signal, genuine fix: the flattened 3 Aug 15:25 bar takes realizedVol2h 24.79 → 8.46, so HIGH_VOL → RANGE (as cutoff #1) |
| 2 | removed | NIFTY 11 Aug 09:41 BEAR | 24500PE, TIME_STOP 11:41, **+₹736.77** → — | signal, **made by the clip**: vsBankNiftyZ −1.673 → −1.333, so RELATIVE_VALUE −0.29 → abstains and active weight 0.323 → 0.269: score −0.655 → 0 |
| 3 | added | NIFTY 11 Aug 11:06 BEAR | — → 24450PE, TIME_STOP 13:06, **−₹701.45** | book: knock-on of #2 |
| 4 | removed | NIFTY 12 Aug 10:06 BEAR | 24350PE, TRAIL 14:31, **+₹1,394.37** → — | signal, **made by the clip**: vsBankNiftyZ 1.748 → 1.330, so RELATIVE_VALUE 0.30 → abstains and active 0.319 → 0.265: score −0.684 → 0 |
| 5 | added | NIFTY 12 Aug 10:11 BEAR | — → 24350PE, TRAIL 14:36, **+₹616.04** | book: knock-on of #4 |
| 6 | removed | NIFTY 13 Aug 10:36 BEAR | 24300PE, SIGNAL_FLIP 10:41, **−₹259.97** → — | perf: ORB weight 0.141 → 0.136, score −0.370 → −0.366, and the edge (10.0%) falls just short of the 10% gate |

**Why #2 and #4 are clip artefacts.** NIFTY's vsBankNiftyZ history includes each session's 15:15–15:30 window. On 3 Aug NIFTY and BANKNIFTY both jumped into the auction close (+0.81% and +0.98%), a spread of +0.165%. Flattening only NIFTY's bar turns that spread into +0.979%, and on 4 Aug +0.099% into +0.716%. These fabricated outliers inflate the z-score's scale for 20 sessions.

The clip also leaves the next bar's open: SENSEX's 10 Sep 15:25 bar still opens at the bad 75,575, which becomes the previous-day high (test `with the body clip alone the 15:20 print goes, but the 15:25 bar still opens at it`).

**Totals:** removed +₹1,871.17, added −₹1,409.92. Net Δ = −₹3,281.09 (−0.6 SE).

## 6. Are the cutoff's differences confined to artefact-driven decisions?

**Yes, on the evidence available:**

1. All 11 signal-caused differences happen at decisions whose 15:15–15:25 inputs come from auction-era sessions (from 3 Aug on). The one mixed case, #1, is decided by realizedVol2h, which reads only 3 Aug's bars.
2. At those 11 decisions, stripping only the genuine pre-3-Aug closing bars from the uncleaned data changes nothing that matters. The largest moves are vsBankNiftyZ by 0.044 (from its 20-session history) and ADX by 0.18 (on 4 Aug). RSI, DI, EMA21 and the Supertrend line move by ≤ 0.011, and no other feature moves at all.
3. The other 5 differences are knock-ons: a position limit (#3), and source weights from the performance record (#7–#10), whose inputs differ only because earlier trades differed.
4. No trade before 4 Aug differs, although every decision input on 23 Jul – 3 Aug changed slightly.

**Diagnostic, run and reported as is** (`reports/wp1-compare-genuine.md`, in the ledger). Replaying with only the pre-3-Aug closing bars physically removed and no flag gives 51 trades and −₹9,809.00: 7 trades differ.

The method has a confound the real cutoff does not. Removing the bars also moves the previous close to the 15:10 close on the day after each pre-auction session; the cutoff keeps the official close. That alone moved SENSEX's 29 Jul gap from 0.92% to 0.97%, which changed two exits that day. Those two exits then rippled through the per-source performance record into 5 more differences on 24–26 Aug.

So the diagnostic does not bound the genuine bars' effect cleanly. What it does show is how path-dependent this engine is: a 0.05-point change in one morning's gap moves 7 trades over the next month.

**What the size of the change does and doesn't mean.** The cutoff moving 16 of 51 trades measures the engine's fragility (hard thresholds, plus performance-record feedback with an active weight sitting at 0.29–0.31), not the size of the fix. It is also why −₹9.8k should not be read as a cost of the fix: the confounded diagnostic above moved 7 trades and ₹213 on a 0.05-point gap change.

**Recommendation (cutoff).** It qualifies as a demonstrated-bug fix:

- the removed inputs demonstrably are not prices;
- every difference traces to them;
- it lowers the trade count (51 → 50);
- it loosens nothing;
- defaults are unchanged.

Enable `features.indicatorCutoffIst: "15:15"` by default after WP8's review, outside market hours. That is a one-line change in `DEFAULT_CONFIG`; production builds its config from `makeConfig()` in `workers/engine/src/runtime.ts`.

Rejecting a correctness fix because the in-sample number got worse would itself be selecting on P&L.

"For safety, on all days" (PLAN §4) is kept. It also makes multi-year Groww replays use the same feature definition the live engine now sees.

**Recommendation (body clip).** Keep it off. It found no mid-session bad print in 59 sessions, and on the auction bars it is both redundant and harmful.

## 7. The 5-minute archive

`npm run fetch-history -- --save` was run at 09:19:56 IST today (`docs/DATA.md` has the details):

- **Capture:** `.cache/history/yahoo-5m-20261009.json` (13.0 MB, exactly as served).
- **Archive:** `.cache/history/yahoo-5m-archive.json` (13.8 MB). It holds NIFTY 4,371 bars (16 Jul 09:15 – 8 Oct 15:25), SENSEX 4,375, BANKNIFTY 4,370 and VIX 4,377, plus the 12 cross assets at 2,892–13,691 bars each (about 60 days).
- Today's forming bars were held back by the 10-minute settle rule.
- `.cache/` is gitignored and these files sit in this worktree. Copy them to wherever the nightly job runs, e.g. the main checkout's `.cache/history/`.

**Archive replay check.** `npm run backtest -- --history .cache/history/yahoo-5m-archive.json` with the same settings gives 48 trades and −₹14,516.24. The Indian 5-minute bars are identical to the snapshot: 0 value differences on all shared bars, and the archive lacks only the 8 Oct 15:30 tick, which is outside the session.

The difference is cross-asset coverage. The reference snapshot holds 5-minute cross-asset bars only from about 2–5 Oct, because `loadYahooHistory` fetches them with `range=5d`. Before that, the baseline's GAP/GLOBAL_BETA inputs come from daily-bar fallbacks, unlike live trading, where 5-minute cross-asset data is always present. Every WP comparing against 51 / −₹9,595.92 inherits this (§8).

**Nightly run:** weekdays at 16:45 IST, `15 11 * * 1-5 cd <repo> && npm run fetch-history -- --save` (cron in UTC). A missed night is caught up on the next run. No GitHub workflow was added: the repo's only workflow deploys on pushes to `main`. The caveats are in `docs/DATA.md`.

## 8. Found along the way (for the coordinator and other WPs)

1. **The reference baseline uses daily fallbacks for cross-asset moves on most sessions** (§7). Consider re-saving the reference snapshot with 60 days of cross-asset 5-minute bars, from the archive or by changing `range: "5d"` in `src/engine/backtest/history.ts`, which is not WP1's file. The same settings then give 48 trades / −₹14,516.24.
2. **The engine is fragile at three hard thresholds:** the 0.30 minimum active weight (typical active weight 0.29–0.31 after performance shrinkage), ADX 25 (trend regime, which also sets the time-stop horizon) and ADX 20 (mean-reversion eligibility). Small input changes flip trades. Relevant to WP2 and WP8, and to every before/after comparison.
3. `docs/FNO.md` still says "continuous trading 09:15–15:30 IST". Since 3 Aug it ends at 15:15 for F&O stocks. Not edited, because it is not WP1's file.
4. **Files outside the brief's list:**
   - `src/engine/market/candles.test.ts`: tests for the new `appendCandles` in `candles.ts`.
   - `scripts/wp1-compare.ts`: new.
   - `reports/*.md` and `reports/trials.jsonl`: force-added, because `reports/` is gitignored. Other WPs' ledgers will need concatenating on merge.

## 9. Reproduce

```
H=<path to scratchpad/why/hist.json>
npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits --history $H                          # 51, -9,595.92
npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits --history $H --indicator-cutoff 15:15  # 50, -19,400.94
npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits --history $H --body-clip               # 51, -12,877.01 (logs 6 clips)
npx tsx scripts/wp1-compare.ts --history $H                     # reports/wp1-compare.md + .json, appends to reports/trials.jsonl
npx tsx scripts/wp1-compare.ts --history $H --variants genuine --md reports/wp1-compare-genuine.md --out reports/wp1-compare-genuine.json
npm run fetch-history -- --save                                 # archive capture
npx vitest run src/engine/market                                # the 10 Sep fixture tests
```

## 10. Trials ledger

`reports/trials.jsonl` has 21 lines. The distinct runs are:

- 4 cleaning configurations on the snapshot: off, cutoff, body clip, both;
- 1 attribution diagnostic (genuine bars removed);
- 1 data check (archive replay).

The rest are re-runs, marked as such in `notes`: the default-behaviour proofs, the CLI confirmations and the table regenerations. Nothing was tuned: 15:15, 0.6% and 0.1% are the plan's values, and no other value was tried.
