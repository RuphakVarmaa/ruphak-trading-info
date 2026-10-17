# Overnight-gap betas: out-of-sample check and refit

Prepared 9 Oct 2026 on branch `worktree-agent-a706cc4e03594a15e`, which starts from `2ffba05` (the integration head with WP1, WP2 and WP5 merged). The engine stays in PAPER mode. Nothing was pushed or deployed.

**Commits**

| commit | change |
|---|---|
| `0ea8f94` | tooling only: `src/engine/market/gapFit.ts` (+ tests), `scripts/research/fit-gap-betas.ts`, `scripts/research/gap-betas-compare.ts` |
| `e02f114` | compare script: P&L-difference interval and the GLOBAL_BETA forecast check |
| `4c561bf` | **the fix**: fitted `features.gapBetas` defaults, with the tests that depended on them |
| `033e34b` | precise `config.ts` comment; compare script labels knock-ons by blocking gate |
| (last) | this report, the per-trade tables and the ledger lines |

## 1. Bottom line

- **The hand-set betas overstate India's opening gap about twice.**
  - On windows like live trading's (1-hour bars, 491 sessions) the actual gap is 0.48 × the engine's expected gap (90% CI 0.40–0.55). This reproduces the 0.48 found in `docs/research/notes/q2-gaps-trend-flows.md`.
  - On the archive's true 5-minute windows (49 sessions) the slope is 0.27, i.e. 3.7× too large.
  - On the daily-close windows that the reference backtest uses on most sessions, the slope is 0.18.
  - Out of sample they forecast the gap worse than simply forecasting no gap: MAE 0.49% vs 0.39% and RMSE 0.69% vs 0.68% on 1-hour windows.
- **`fitGapBetas` walk-forward is calibrated and about 40% more accurate.** Each session is fitted only on earlier sessions, with the penalty chosen on those sessions too. Over 371 sessions:
  - calibration slope 1.02 [0.85, 1.22];
  - MAE 0.30% (−39%) and RMSE 0.49% (−29%).
  - The directional hit rate is about the same: 72.6% vs 74.0%, with overlapping intervals.
- **Shipped defaults.** One fit on 2024-10-09..2026-07-22 (437 sessions, 1-hour windows):

  `ES 0.368, NQ −0.147, CL −0.042, DXY −0.038, USDINR −0.91, US10Y −0.0005, N225 0.083, HSI 0.067, SSE 0.044`

  On the sessions after the fit window, compared with the hand-set betas:
  - 1-hour windows (54 sessions): MAE 0.28% vs 0.42%;
  - 5-minute windows (49 sessions): MAE 0.26% vs 0.46%.
- **The backtests got worse in point estimate.** Neither difference is distinguishable from zero.
  - Reference snapshot: 51 trades / −₹9,595.92 → **56 / −₹17,060.41**. Δ −₹7,464, 90% interval −₹18,792 to +₹3,092.
  - 60-day archive: 48 / −₹14,516.24 → **44 / −₹18,835.50**. Δ −₹4,319, interval −₹17,343 to +₹8,028.
- **Why the backtests moved.** The differences run through GLOBAL_BETA moving decisions across the 0.30 minimum active weight. As a forecast of the next 90 minutes GLOBAL_BETA shows no edge with either beta set (correlation 0.05 vs 0.05 on the reference snapshot, 0.06 vs 0.10 on the archive, every interval spanning zero). Its attributed P&L is negative in all six replays.
- **Recommendation (§8): ship as a bug fix by default.** Separately, re-evaluate GLOBAL_BETA's vote and give the reference snapshot 5-minute cross-asset bars.

## 2. What the betas feed

- **`globalBetaSignal`** (`src/engine/strategy/signals.ts`, source GLOBAL_BETA, prior weight 0.05):
  - expected = Σ beta_k × move_k, where the moves run from the previous 15:30 IST close to now;
  - actual = gap + move since the open, and residual = expected − actual;
  - it abstains when |residual| < 0.15% (or fewer than three moves are known); otherwise its value is tanh(residual / 0.5) × 0.8, faded out between 10:45 and 11:45.
  - **Why a weight of 0.05 matters.** ORB plus MOMENTUM alone often weigh about 0.28 after shrinkage, below the 0.30 minimum active weight. So whether GLOBAL_BETA votes or abstains decides whether many morning scores exist at all; WP1 flagged this fragility.
- **`expectedGapPct` / `gapResidualPct`** (`src/engine/market/features.ts`) are shown on the dashboard.

## 3. Data

Every number in this report comes from these sources. No market data was typed in by hand.

| source | contents | used for |
|---|---|---|
| Reference snapshot `scratchpad/why/hist.json` (Yahoo, saved 2026-10-09 02:54 UTC) | daily bars 2024-10-08..2026-10-08 for the indices and the 12 cross assets; 5-minute index bars 2026-07-16..10-08; cross-asset 5-minute bars only from 2026-10-05 (^TNX 10-02, Shanghai 09-28) | daily-close windows (481 of 489 sessions), every index gap, the reference backtest |
| 60-day archive `scratchpad/archive/yahoo-5m-archive.json` (`npm run fetch-history -- --save`, saved 2026-10-09 09:55 UTC) | the same daily bars; 5-minute bars for the indices and all 12 cross assets (ES, NQ, CL, DXY from 2026-07-30 09:35 IST; USDINR 07-20; ^TNX 07-29; Nikkei 07-13; Hang Seng 07-17; Shanghai 07-10) | true 5-minute windows for the 49 sessions 2026-07-31..10-09; the archive backtest |
| Yahoo 1-hour bars, fetched 2026-10-09 10:22 UTC into `scratchpad/gapbetas/yahoo-1h/` (raw responses plus `manifest.json`) | `https://query1.finance.yahoo.com/v8/finance/chart/<symbol>?interval=1h&range=730d` for ES=F, NQ=F, CL=F, DX-Y.NYB, USDINR=X, ^TNX, ^N225, ^HSI and 000001.SS; one request each, 2 s apart. ES, NQ, CL and DXY start 2024-05-17; the others start late 2023 | live-like windows for all 491 sessions |

The q2 research fitted its model on its own 60-minute downloads; those files were not reused.

## 4. Method

**Observations.** One row per session and index, built with the engine's own `overnightObservations()`:
- gap = first 5-minute open (else the daily open) / previous session's last 5-minute close (else the daily close) − 1;
- moves = `globalMoves()` from the previous session's 15:30 IST to 09:15 IST, using exactly the code the engine trades on.

NIFTY and SENSEX rows are pooled in the fit, because one set of betas serves both. Every interval resamples whole sessions, so the two rows of a morning stay together.

**Calendar.** The bundled holiday list starts in 2026, so the script derives the earlier calendar from the data:
- the 28 weekdays without a NIFTY bar are treated as closed (all exchange holidays);
- the one weekend day with a bar, 2025-02-01 (budget day), counts as a session;
- the Muhurat sessions 2024-11-01 and 2025-10-21, and the sessions after them, are left out (8 rows).

**Window definitions.** What separates these results is how the overnight move is measured.

1. **Daily closes.** This is the engine's fallback when 5-minute bars are missing, and what the reference backtest feeds GLOBAL_BETA on all but its last few sessions. A daily close is used once it is final (`DAILY_FINAL_AFTER_MS`). For session D:
   - **ES, NQ, CL, DXY:** the New York close before D against the one before it, roughly 03:30 IST D−1 → 02:30 IST D. Twelve of those hours fall before India's previous close, so they are already in the gap's base, and 02:30–09:15 IST is missed.
   - **USDINR:** London-day bars, roughly 04:30 IST D−1 → 04:30 IST D. India's whole previous session is inside the window.
   - **US10Y:** New York close to close.
   - **Nikkei, Hang Seng, Shanghai:** today's session is not final before 12:30, 14:00 or 13:00 IST, so their move at 09:15 is 0 (non-zero only after an Indian holiday).
   - Example, 5 Aug 2026: daily windows give ES +1.80% and 0 for Asia. Hourly windows give ES +1.95%, Nikkei +2.98% and Shanghai +1.35% (`--show 2026-08-05`).
2. **1-hour bars (live-like).** Each bar is re-stamped 55 minutes later, so the engine's "usable 5 minutes after the stamp" rule means "once the hour has closed". The newest bar of each file is left out because it may have been forming at fetch time. At 09:15 IST the window ends with the last closed hour: 08:30 for futures, FX and Tokyo, 09:00 for Hong Kong and Shanghai.
3. **5-minute bars (live-exact).** The window runs to 09:15 IST, as the live engine computes it (it refreshes 5 days of cross-asset 5-minute bars every 2 minutes).

**Walk-forward.** An expanding window:
- for each session after the first 120, `fitGapBetas` is fitted on every earlier session;
- the ridge penalty is chosen from {0, 1, 3, 10, 30, 100, 300, 1000} by time-ordered validation inside those sessions only (5 consecutive blocks, each predicted from the blocks before it);
- on 1-hour windows the out-of-sample sessions run 2025-04-04..2026-10-08 (371).

**Metrics.**
- MAE and RMSE of the gap, in percent.
- Directional hit rate (rows where either value is 0 are left out), with a 90% Wilson interval.
- Calibration slope: OLS of the actual gap on the forecast. 1 means calibrated; 0.5 means forecasts twice too large. 90% interval from 1,000 session-bootstrap draws.
- R² against a zero forecast.

## 5. Out of sample: hand-set vs fitted

**1-hour windows (live-like), walk-forward, 371 sessions (2025-04-04..2026-10-08, 742 rows)**

| model | MAE % | RMSE % | hit rate [90%] | calibration slope [90%] | R² vs zero |
|---|---|---|---|---|---|
| hand-set betas | 0.492 | 0.693 | 74.0% [71.3–76.5] | 0.50 [0.42, 0.57] | −0.03 |
| **fitGapBetas walk-forward** | **0.300** | **0.494** | 72.6% [69.9–75.2] | **1.02 [0.85, 1.22]** | **0.48** |
| zero (no gap) | 0.386 | 0.684 | — | — | 0 |

The per-index results agree:
- NIFTY: MAE 0.291 vs 0.487, slope 1.01 vs 0.49.
- SENSEX: MAE 0.308 vs 0.497, slope 1.03 vs 0.50.

**After the fit window, 1-hour windows, 2026-07-23..10-08 (54 sessions)**

| model | MAE % | RMSE % | hit rate [90%] | calibration slope [90%] | R² vs zero |
|---|---|---|---|---|---|
| hand-set betas | 0.419 | 0.561 | 68.5% [60.8–75.3] | 0.34 [0.24, 0.48] | −0.86 |
| fitGapBetas walk-forward | 0.276 | 0.335 | 66.7% [58.9–73.6] | 0.85 [0.63, 1.18] | 0.34 |
| **shipped betas (fit to 2026-07-22)** | **0.277** | **0.337** | 66.7% [58.9–73.6] | 0.83 [0.61, 1.15] | 0.33 |
| zero (no gap) | 0.309 | 0.411 | — | — | 0 |

**True 5-minute windows (the archive, 2026-07-31..10-09, 49 sessions; the windows the live engine computes)**

| model | MAE % | RMSE % | hit rate [90%] | calibration slope [90%] | R² vs zero |
|---|---|---|---|---|---|
| hand-set betas | 0.463 | 0.682 | 72.4% [64.5–79.2] | 0.27 [0.18, 0.40] | −2.20 |
| **shipped betas (fit to 2026-07-22)** | **0.260** | **0.345** | 70.4% [62.4–77.4] | 0.59 [0.40, 0.84] | 0.18 |
| daily-close-window fit to 2026-07-22 (not shipped) | 0.264 | 0.322 | 64.3% [56.0–71.8] | 0.96 [0.63, 1.33] | 0.29 |
| zero (no gap) | 0.288 | 0.382 | — | — | 0 |

**Daily-close windows (the reference snapshot): the 361 walk-forward sessions whose windows are all daily closes (from 2025-04-08)**

| model | MAE % | RMSE % | hit rate [90%] | calibration slope [90%] | R² vs zero |
|---|---|---|---|---|---|
| hand-set betas | 0.696 | 0.982 | 62.8% [59.8–65.7] | 0.18 [0.11, 0.25] | −1.37 |
| fitGapBetas walk-forward (fitted on daily windows) | 0.344 | 0.592 | 67.2% [64.3–70.0] | 0.95 [0.71, 1.21] | 0.14 |
| shipped betas (1-hour fit) | 0.459 | 0.717 | 60.8% [57.8–63.8] | 0.26 [0.12, 0.41] | −0.26 |
| zero (no gap) | 0.377 | 0.638 | — | — | 0 |

**Reading the tables.**
- **The window decides the betas.** Fitted on daily closes, the walk-forward chose heavy shrinkage (penalties 30–300) and got ES 0.15 and USDINR **+0.11**, with the Asian betas not identified. USDINR's daily move mostly covers India's previous session, and Asia's daily move is 0 at the open except after Indian holidays. Those betas suit the backtest's fallback windows but not live trading: on 1-hour windows they under-predict (slope 1.45 [1.21, 1.67]).
- **The shipped betas fit the windows live trading uses.** On daily-close windows they are still about 4× too large (slope 0.26), though much less wrong than the hand-set values (0.18).
- **Lower sensitivity in the most recent months.** Even the shipped betas over-predict on the archive's 49 five-minute sessions (slope 0.59 [0.40, 0.84]) and less so on 1-hour windows over the same months (0.83). India followed global cues less in Aug–Oct 2026 than over the two years before (§9).
- **Hit rate.** The hand-set betas' directional hit rate is 1.4–2.0 points higher than the 1-hour fit's on every window type, never significantly so. They point the right way and get the size wrong.

## 6. The fitted betas

The shipped set is the 1-hour-window fit on 2024-10-09..2026-07-22 (437 sessions, 872 rows), with penalty 0 chosen on those sessions. Units: gap % per 1% move; US10Y per basis point.

| key | shipped | bootstrap 5% | median | 95% | SE (clustered by date) | hand-set | refit to 2026-10-08 (491 sessions) | daily-close fit to 07-22 (not shipped) |
|---|---|---|---|---|---|---|---|---|
| ES | 0.368 | 0.216 | 0.366 | 0.520 | 0.093 | 0.45 | 0.412 | 0.154 |
| NQ | −0.147 | −0.244 | −0.145 | −0.044 | 0.061 | 0.10 | −0.176 | 0.045 |
| CL | −0.042 | −0.073 | −0.045 | −0.024 | 0.013 | −0.08 | −0.042 | −0.018 |
| DXY | −0.038 | −0.244 | −0.046 | 0.121 | 0.111 | −0.15 | −0.038 | −0.172 |
| USDINR | −0.91 | −1.524 | −0.891 | −0.107 | 0.436 | −1.5 | −0.917 | 0.107 |
| US10Y | −0.0005 | −0.007 | −0.000 | 0.007 | 0.0045 | −0.01 | −0.0014 | −0.0025 |
| N225 | 0.083 | 0.056 | 0.083 | 0.110 | 0.017 | 0.10 | 0.074 | 0.017 |
| HSI | 0.067 | 0.026 | 0.064 | 0.102 | 0.024 | 0.10 | 0.065 | 0.087 |
| SSE | 0.044 | −0.028 | 0.035 | 0.105 | 0.040 | 0.05 | 0.046 | −0.028 |

The values are rounded to 3 decimals (US10Y to 4); the rounded set is the one backtested.

**How the numbers were produced.**
- Bootstrap: 1,000 resamples of sessions, refitted with the same penalty.
- Clustered standard errors and an independent check: the rows were exported with `--rows`, and a separate numpy OLS reproduces the fit to 4 decimals (penalty 0 is plain OLS).

**Notes on the coefficients.**
- **NQ** is negative because it nearly duplicates ES. Only the combination matters: a 1% move in both gives 0.22% of gap.
- **USDINR** rests on a few large sessions. Without the 10 most extreme sessions (top 1% of |gap| or |crude move|: 2025-04-07, 2025-06-13, 2026-02-03, 2026-03-02, 2026-03-09, 2026-03-10, 2026-03-19, 2026-04-01, 2026-04-08, 2026-04-15), USDINR becomes +0.07 and DXY −0.21. The forecasts barely change: correlation 0.94 with the full fit, standard deviation 0.39% vs 0.49%. Individual betas are fragile; the predicted gap is not.
- **US10Y and DXY** are indistinguishable from zero.
- **Refit to 2026-10-08:** every coefficient lies inside the shipped fit's bootstrap range. The shipped fit stops at 2026-07-22 so that backtests from 2026-07-23 stay out of sample.

## 7. Backtests before and after

All runs use the settings of `npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits` (main account, 54 sessions, synthetic option prices), replayed in-process by `scripts/research/gap-betas-compare.ts`. The CLI runs confirm both ends:
- the reference command on `2ffba05` prints 51 / −₹9,595.92;
- on `4c561bf` it prints 56 / −₹17,060.41, identical to the in-process replay;
- on the archive, `4c561bf` prints 44 / −₹18,835.50.

**The betas were chosen on the gap evidence of §5 before any of these backtests ran.** For the after run, both snapshots use the shipped betas, which were fitted only on sessions before 2026-07-23.

| snapshot | betas | trades | hit | net ₹ | gross ₹ | charges ₹ | PF | maxDD % | GLOBAL_BETA attributed ₹ | Δ net ₹ [90% session interval] |
|---|---|---|---|---|---|---|---|---|---|---|
| reference (`hist.json`) | hand-set (before) | 51 | 0.333 | −9,595.92 | −6,137.25 | 3,458.67 | 0.79 | 3.73 | −2,020.82 | |
| | **fitted defaults (after)** | **56** | 0.321 | **−17,060.41** | −13,337.25 | 3,723.16 | 0.67 | 4.34 | −2,823.84 | **−7,464.49 [−18,791.55, +3,092.16]** |
| | daily-close fit (sensitivity) | 47 | 0.319 | −10,760.56 | −7,575.00 | 3,185.56 | 0.74 | 3.34 | −1,698.75 | −1,164.64 [−14,874.08, +11,321.54] |
| 60-day archive | hand-set (before) | 48 | 0.333 | −14,516.24 | −11,240.00 | 3,276.24 | 0.67 | 4.05 | −486.87 | |
| | **fitted defaults (after)** | **44** | 0.341 | **−18,835.50** | −15,840.00 | 2,995.50 | 0.56 | 4.70 | −2,482.75 | **−4,319.26 [−17,342.60, +8,028.38]** |
| | daily-close fit (sensitivity) | 50 | 0.360 | −9,758.29 | −6,377.25 | 3,381.04 | 0.76 | 3.28 | −2,558.34 | +4,757.95 [−4,856.53, +15,114.25] |

On the archive, cross-asset windows are true 5-minute windows from 2026-07-31. Its hand-set run reproduces WP1's archive replay (48 / −₹14,516.24).

**Trades that differ (fitted defaults vs hand-set).** The full tables, with each decision, its gates and GLOBAL_BETA's view in both runs, are in `reports/gap-betas-compare-hist.md` and `reports/gap-betas-compare-archive.md`.

| snapshot | differ | removed / added / changed | identical | cause: score moved | cause: book knock-on | P&L Δ (score moved / knock-ons) |
|---|---|---|---|---|---|---|
| reference | 45 | 18 / 23 / 4 | 29 of 51 | 32 | 13 | −₹12,936.71 / +₹5,472.22 |
| archive | 30 | 16 / 12 / 2 | 30 of 48 | 20 | 10 | −₹3,803.32 / −₹515.94 |

**Why the trades differ.**
- **GLOBAL_BETA's view changes at most morning decisions:** at 2,989 of the 3,240 decision points before 11:45 (92%) on the reference snapshot. After 11:45 it abstains in both runs.
- **The most common change is vote → abstain.** With calibrated betas the residual more often falls inside the 0.15% abstain band. GLOBAL_BETA voted at 2,186 of 3,240 morning points instead of 2,421 (archive: 2,102 instead of 2,381).

How GLOBAL_BETA's view changed behind the trades whose score moved:

| snapshot | vote → abstain | abstain → vote | sign flip | same sign, different size |
|---|---|---|---|---|
| reference (32 trades) | 12 | 8 | 3 | 9 |
| archive (20 trades) | 11 | 2 | 2 | 5 |

The remaining trades are knock-ons: a position slot or the day's loss streak changed after an earlier difference the same day. Examples from the reference snapshot:

- **24 Jul, SENSEX 09:46, removed.** GLOBAL_BETA went from −0.71 (hand-set: "globals imply −1.68%, India −0.98%", i.e. more downside to come) to +0.45 (fitted: "globals imply −0.66%", i.e. India had already fallen further). The bearish score went from −0.581 to −0.390, under the 0.45 threshold. The baseline trade had made +₹418.54. The chain that day:
  - with this entry and the 09:51 one gone, the freed slots let two later bearish entries in (−₹899.06 and −₹1,192.12);
  - those in turn kept out two baseline entries that had lost −₹1,031.11 and −₹1,620.31;
  - the day's net change was +₹247.53.
- **31 Jul, SENSEX 09:51, removed.** GLOBAL_BETA went from +0.76 to abstain (residual −0.03%). The active weight fell under 0.30, the score went from 0.621 to 0 and there was no entry (baseline −₹299.48).
- **12 Aug, SENSEX 10:06, removed.** Same mechanism: −0.27 → abstain, score −0.681 → 0. The baseline's +₹3,079.04 target hit is lost.
- **31 Aug, SENSEX 09:56 and 10:01, added.** GLOBAL_BETA went from abstain to **+0.57 (bullish)**, yet the result was a **bearish** entry. Its contrary vote lifted the active weight over 0.30, so the bearish ORB/MOMENTUM mean became a −0.545 score and a put was bought. Both trades lost (−₹1,497.99, −₹1,491.13). This is a threshold effect, not a forecast.

**GLOBAL_BETA as a forecast (no thresholds, no trades).** At every decision point before 11:45 IST where GLOBAL_BETA votes, its value is compared with the index's log move over the next 90 minutes (its horizon). The 90% intervals resample sessions.

| snapshot | betas | votes / points | correlation [90%] | sign hit | mean move in its direction, bp [90%] |
|---|---|---|---|---|---|
| reference | hand-set | 2,421 / 3,240 | 0.053 [−0.111, 0.235] | 50.8% | +0.8 [−2.9, +4.7] |
| reference | fitted defaults | 2,186 / 3,240 | 0.052 [−0.119, 0.230] | 45.1% | −0.1 [−3.5, +3.5] |
| archive | hand-set | 2,381 / 3,240 | 0.056 [−0.103, 0.225] | 51.9% | +0.5 [−3.4, +4.4] |
| archive | fitted defaults | 2,102 / 3,240 | 0.104 [−0.078, 0.280] | 48.5% | +0.9 [−2.9, +5.1] |

With either set GLOBAL_BETA has no detectable edge over these 54 sessions. The q2 research found a small one on two years of hourly data with calibrated betas: 59% catch-up when the residual exceeds 0.3%, about 16 points.

## 8. Recommendation

**Ship as a bug fix by default (done in `4c561bf`).**

- **The gap evidence is one-sided.** The betas exist to predict India's opening gap. On the windows live trading uses, the hand-set values forecast it twice too large and worse than forecasting no gap. The fitted values are calibrated and cut the error by about 40%, both walk-forward over two years of 1-hour windows and on the archive's 5-minute windows after the fit window.
- **The backtests are worse, and I report that as it is:** −₹7,464 on the reference snapshot and −₹4,319 on the archive.
- **But the backtest evidence is weak.**
  - Both 90% intervals include zero.
  - The trades differ mostly because GLOBAL_BETA crosses its 0.15% abstain band and so moves decisions across the 0.30 minimum active weight. That is a threshold effect, not a better or worse forecast: GLOBAL_BETA forecasts the next 90 minutes no better with one set than the other.
  - Its attributed P&L is negative under every set.
- **Follow-up 1 (the coordinator's call, not part of this fix):** re-evaluate GLOBAL_BETA's vote now that its input is calibrated. It shows no edge in this sample, and with a weight of 0.05 it mainly acts as a switch on the active-weight floor.
- **Follow-up 2:** give the reference snapshot 5-minute cross-asset bars (re-save it from the archive, as WP1 suggested). Daily-close windows misstate the overnight move for any betas, so the reference backtest does not test the live behaviour of this signal.
- **Alternative.** If changing trading behaviour before follow-up 1 is unwanted, keep the hand-set values behind a flag for GLOBAL_BETA only. I would not keep them as the source of the dashboard's expected gap.

## 9. Caveats

- **Backtests.** Option prices are synthetic (Black-Scholes on India VIX). There are 54 sessions, all in one regime (a falling market with record FPI selling), and the engine is fragile at its thresholds (WP1 §8).
- **The recent regime is less sensitive to global cues.** On the archive's 49 five-minute sessions even the shipped betas over-predict (slope 0.59 [0.40, 0.84]); on 1-hour windows over the same months the slope is 0.83. If this persists, the fitted betas still overstate the gap by about 1.2–1.7× for now, against 3.7× for the hand-set ones. A refit once the archive holds about 3 months of 5-minute cross-asset bars would settle it (the script runs on the archive unchanged).
- **Window ends differ.**
  - The 1-hour windows end at 08:30 (futures, FX, Tokyo) or 09:00 IST; live windows run to 09:15, and for GLOBAL_BETA to the decision time.
  - `USDINR=X` is sparse overnight. On some sessions (e.g. 2026-08-05) its 1-hour window ends on the daily close (04:30 IST) because no later bar exists; the live engine applies the same fresher-of-the-two rule to its 5-minute bars.
- **Fragile coefficients.** USDINR's coefficient depends on a few large sessions, and NQ's on its overlap with ES (§6).
- **Calendar.** The 2024–25 calendar is inferred from the data (§4). The snapshot has no bar for Sunday 2026-02-01 (budget day). If the exchanges traded that day, 2026-02-02's gap is measured from 2026-01-30's close and carries that session's move.
- **Trials.** Two distinct beta sets were backtested on two snapshots: the shipped fit and the daily-close sensitivity fit. The hand-set replays reproduce the existing references. The other ledger lines are re-runs, marked as such.

## 10. Files and reproduction

| file | role |
|---|---|
| `src/engine/config.ts` | the fitted `features.gapBetas`, with a comment naming the fit window and script |
| `src/engine/market/gapFit.ts` (+ `gapFit.test.ts`, 11 tests) | penalty choice by time-ordered validation, walk-forward forecasts, metrics, session bootstrap; research helpers only |
| `scripts/research/fit-gap-betas.ts` | observations, out-of-sample comparison, fits with bootstrap ranges (`--hourly`, `--daily-only`, `--betas`, `--show`, `--rows`, `--json`) |
| `scripts/research/gap-betas-compare.ts` | backtest before/after, per-trade causes, P&L-difference interval, GLOBAL_BETA forecast check, ledger lines |
| `src/engine/config.test.ts`, `market/crossAsset.test.ts`, `market/features.test.ts` | the 0.2948 fixture reference stays pinned to the hand-set betas; the defaults are checked by formula from the independently scanned moves; a guard that the betas name known keys with finite values |
| `reports/gap-betas-compare-hist.md`, `reports/gap-betas-compare-archive.md` | every differing trade, with its cause |

To reproduce (S = the session scratchpad):

```
H=$S/why/hist.json; A=$S/archive/yahoo-5m-archive.json; D=$S/gapbetas/yahoo-1h   # D: Yahoo interval=1h&range=730d, 9 symbols (§3)
npx tsx scripts/research/fit-gap-betas.ts --history $H --hourly $D --json fit-1h.json   # shipped fit = "Fit on every session before 2026-07-23"
npx tsx scripts/research/fit-gap-betas.ts --history $H                                   # daily-close windows
npx tsx scripts/research/fit-gap-betas.ts --history $A --betas sets.json                 # 5-minute windows (archive)
npx tsx scripts/research/gap-betas-compare.ts --history $H --betas sets.json --md out.md # backtest before/after (+ ledger)
npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits --history $H   # 56 / -17,060.41 on 4c561bf
```

`sets.json` holds the shipped set and the daily-close sensitivity set:

```
{"fit 1h windows to 2026-07-22 (candidate default)": {"ES":0.368,"NQ":-0.147,"CL":-0.042,"DXY":-0.038,"USDINR":-0.91,"US10Y":-0.0005,"N225":0.083,"HSI":0.067,"SSE":0.044},
 "fit daily-close windows to 2026-07-22 (sensitivity, not for live)": {"ES":0.154,"NQ":0.045,"CL":-0.018,"DXY":-0.172,"USDINR":0.107,"US10Y":-0.0025,"N225":0.017,"HSI":0.087,"SSE":-0.028}}
```

Yahoo serves a rolling 730-day window, so a later fetch of the 1-hour bars covers a later period. The fit window is fixed by date, but the earliest sessions may then lack 1-hour bars.

## 11. Ledger

`reports/trials.jsonl` has 21 new lines with `"wp":"gap-betas"`:
- 6 first replays: 3 beta sets on each of the 2 snapshots;
- 6 re-runs that added the P&L intervals and the forecast check;
- 6 re-runs on the committed defaults with the corrected cause labels;
- 3 CLI confirmations: before on `2ffba05`, after on `4c561bf`, and the archive after.

All re-runs gave identical results and are marked "not a new trial".

Checks on the final code:
- `npx vitest run`: 59 files, 715 tests passed, 1 skipped.
- `npm run typecheck`: clean.
- `npx eslint` on every touched file: clean.
