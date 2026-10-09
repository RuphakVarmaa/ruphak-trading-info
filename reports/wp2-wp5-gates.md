# WP2 + WP5: an honest edge gate and a HAR-RV vol-cheapness gate

Fri 9 Oct 2026. Branch `worktree-agent-abcb2c2950f685936`, built on `9a80d7b`. The engine is PAPER only; nothing was deployed or pushed.
Data: the saved snapshot `scratchpad/why/hist.json` (Yahoo 5-minute bars 2026-07-16..10-08, daily bars 2024-10-08..2026-10-08) and Yahoo 1-hour bars `scratchpad/dl/y1h/` (NIFTY, SENSEX, India VIX, 2023-10-31..2026-10-08). No data was invented and none was fetched. Option prices in every backtest are synthetic (Black–Scholes on India VIX × `vixMultiplier`).
Machine-readable output: `reports/wp2-wp5-calibration.json`. Every run is in `reports/trials.jsonl`.

## TL;DR

* **Both gates, built honestly, block all 51 baseline trades.** With either gate on, the snapshot run takes 0 trades and nets ₹0, against 51 trades and −₹9,595.92 with the gates off. The gates did not find edge. They block because, on measured inputs, no trade the engine takes has positive expected value after time decay (theta) and costs.
* **WP2 (edge gate).** The legacy gate makes two assumptions that both let trades through:
  * It assumes the index moves 1.1× the option's implied σ over the holding horizon. Measured on 6,588 entry-window decision points, the realized move is **0.54×** (root-mean-square). So the legacy gate assumes moves about 2× too large.
  * It assumes the conviction score predicts direction with a slope (β) of about 2 in realized-σ units. Measured: **β = −0.10 ± 0.26** in-sample and **−0.06 ± 0.61** pooled out-of-sample.

  To keep even one of the 51 trades, β would need to be **≥ 0.70** (median 1.21). With the real option IV discussed below, the bar is ≥ 0.58. The data reject β ≥ 0.70 at about 3 standard errors.
* **WP5 (HAR-RV gate).** The HAR-RV model forecasts next-session variance with modest skill: out-of-sample R² ≈ 0.13 against the historical mean (daily Parkinson range estimator). But realized intraday variance averages only **0.45–0.48×** the variance the options charge per session, and the forecast averages 0.47–0.50×. With k = 1 (frozen), the gate passed **0 of 4,085 decision hours** over 20 months (Feb 2025 – Oct 2026). It also blocked all 51 trades at k = 0.8, 1.0 and 1.2.
* **Against the real-price findings:**
  * Pricing options at the measured real IV (0.88–0.91× India VIX for NIFTY, 0.92–0.93× for SENSEX) changes nothing for WP2: 0 of 51 trades kept, β needed 0.58–1.62.
  * For WP5 at real IV, the gate passes 1.4–2.0% of decision hours (7–9 sessions, all in post-shock weeks). On those days realized variance was *lower* than on blocked days: 0.26–0.36× implied against 0.54–0.58×.
  * This agrees with the research finding that a "buy only when 5-day realized ≥ implied" filter still lost ₹873 per NIFTY straddle on real prices.
* **Bottom line: these gates can cut negative carry, but only by not trading. They cannot create directional edge.** The flags are safe to merge because they are off by default. Turning `expectedMoveModel: "calibrated"` on equals pausing directional option buying with the current signal, which is what the numbers support.

## 0. Default behaviour is unchanged (proof)

```
npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits --history scratchpad/why/hist.json
trades 51  hit 0.3333  exp ₹ -188.16  net ₹ -9595.92  gross ₹ -6137.25  charges ₹ 3458.67  PF 0.79
```

The output JSON is **byte-identical** (`cmp`) to the run on the untouched tree. I checked this right after the change and again on the final commit; both runs are in the ledger. Other checks:

* `npx vitest run`: 58 files, 682 passed, 1 skipped.
* `npx tsc --noEmit -p .` and `npx tsc --noEmit -p workers/engine`: clean.
* eslint on every touched file: clean.

## 1. What was built

| piece | where | default |
|---|---|---|
| `gates.expectedMoveModel: "legacy" \| "calibrated"`, `gates.realizedVolFactor`, `gates.scoreMoveBeta` | `src/engine/config.ts` (delimited block; validated) | `"legacy"`, 0.54, −0.1 (the full-sample estimates below; only read in calibrated mode) |
| Calibrated edge: two extra gate rows (`edge_calibrated`, `move_calibrated`) **added after** the unchanged legacy rows | `src/engine/strategy/gates.ts` (`calibratedEdge`, `calibratedEdgeGates`) | off |
| `gates.volCheapness: { enabled, k }`: the `vol_cheapness` row | `src/engine/strategy/gates.ts` (`volCheapnessGate`), one call in `planner.ts` | `{ enabled: false, k: 1 }` |
| HAR-RV (Corsi 2009), Parkinson and intraday realized variance, expanding-window out-of-sample evaluation, point-in-time daily forecast | `src/engine/market/volForecast.ts` (new) | – |
| CLI: `--em-model`, `--realized-vol-factor`, `--move-beta`, `--vol-cheapness`, `--vol-k` | `scripts/backtest.ts` (delimited, additive block) | – |
| Calibration and diagnostics (this report's tables) | `scripts/research/wp2-wp5-gates.ts` (new) | – |
| Plain-language reasons for the 3 new gate ids (needed by the existing copy-desk test that every emitted gate id has one) | `src/lib/copy/action.ts`: **outside the owned file list**, additive only | – |
| Tests | `volForecast.test.ts` (12), `gates.test.ts` (12), `planner.test.ts` (+4) | – |

**Tightening only, by construction:**

* In calibrated mode the legacy `edge_ratio` and `expected_vs_implied` rows are computed and kept exactly as before. The calibrated rows are appended, so a decision the legacy gate rejects cannot pass. A randomized test checks this on 2,000 random draws, including absurdly optimistic calibrations (β up to 10, realized vol up to 3× implied).
* The plan and copy-ticket numbers (`expectedMovePct` and the rest) stay legacy.
* The vol-cheapness row is appended too, and it **fails closed** when no forecast exists.
* Path effects: a blocked trade frees a position slot, which in principle could let another decision through. In every gated run below, none did (0 trades).

**Calibrated edge, per unit of option**, as a second-order expansion of the long option's expected P&L over the horizon h:

  edge = |Δ| · β·|score|·σ_real·S + ½ Γ (σ_real·S)² − θ·h − (charges + spread),  with σ_real = realizedVolFactor × the option's implied σ over h.

The second check re-runs the legacy 0.35 rule against the realized σ: β·|score|·σ_real ≥ 0.35 σ_real. The convexity term is new. The legacy model omitted it, and once realized vol is modelled explicitly it belongs in the formula. It recovers only f² ≈ 29% of theta.

**Vol-cheapness rule.** The gate passes when HAR forecast of this session's realized variance ≥ k × (100 × the option's IV)² / 252.

* The forecast is HAR-RV on variance levels: OLS of RV[t+1] on RV[t], the 5-session mean and the 22-session mean.
* It uses each session's Parkinson range variance from daily bars dated **before** the session.
* The regression is refitted on those sessions only (an expanding window, needing at least 60 observations).
* It is computed once per index and day; a forecast built before the previous day's daily bar arrives is retried.

Why Parkinson in the engine: it is the only measure with enough history at run time. Production keeps about 6 months of daily bars, backtests 2 years, while 5-minute bars cover only about 60 days.

Why intraday RV against the full-session implied variance: the engine's pricer counts only trading minutes, so all of a day's theta is charged inside the session.

## 2. WP2: calibration

### 2.1 What is estimated, from which data, without look-ahead

**Data used.** The engine is replayed exactly like `npm run backtest -- --no-events --prod-limits`: same config, 90 s data lag, 5-minute decisions. The replay reproduces 51 trades and −₹9,595.92. Every decision inside the 09:25–14:30 entry window is recorded: 6,588 points over 54 sessions and both indices.

**What is measured at each point:**

* the conviction score;
* the engine's holding horizon h: the regime horizon (60/90/120/180 min), capped by the 15:05 square-off;
* the spot price;
* the option's implied σ over h: VIX × vixMultiplier × √(h / (375·252));
* the realized log move to t + h, taken from the 5-minute bars **visible at t + h** (the same visibility rule as the replay). The spot used matched the visible close at all 6,588 points.

**What is estimated:**

* f (`realizedVolFactor`) = RMS(realized move) / RMS(implied σ), over all points.
* β (`scoreMoveBeta`) = the through-origin OLS slope of z = sign(score)·move / (f·implied σ) on |score|. This is the functional form the gate uses. It is fitted on the 803 points whose score is not 0; the conviction abstains at the other 88% of points, and 6 sessions had no non-zero score at all. Standard errors are clustered by session.

**Walk-forward** follows protocol §5.2: 42 calendar days of training, then a 14-day test (`makeFolds`). A fold's f and β come from its training window only; its test window never feeds them.

**Limits of the walk-forward.** The 37 trades before 3 Sep have no out-of-sample parameters. They are shown with the full-sample (in-sample) parameters and labelled as such. The config defaults (0.54, −0.1) are the full-sample estimates. They are out-of-sample only for dates after 2026-10-08.

### 2.2 Realized vs implied by horizon

5-minute bars, all entry-window decision points, both indices. f_h is the RMS ratio. The last column, mean |move| ÷ mean σ, is the planning note's "0.41"-type figure.

| window | h (min) | n | mean \|move\| % | RMS move % | mean implied σ % | **f_h** | mean\|move\|/mean σ |
|---|---|---|---|---|---|---|---|
| all 07-23..10-08 | 15 | 6588 | 0.062 | 0.086 | 0.157 | **0.548** | 0.393 |
| | 30 | 6588 | 0.086 | 0.119 | 0.222 | **0.533** | 0.388 |
| | 60 | 6372 | 0.125 | 0.172 | 0.314 | **0.544** | 0.399 |
| | 90 | 5724 | 0.157 | 0.215 | 0.384 | **0.557** | 0.408 |
| | 120 | 5076 | 0.183 | 0.252 | 0.444 | **0.566** | 0.414 |
| | 180 | 3780 | 0.227 | 0.308 | 0.543 | **0.566** | 0.417 |
| fold 1 train 07-23..09-02 | 60 / 120 / 180 | 3540 / 2820 / 2100 | | | | 0.454 / 0.475 / 0.474 | 0.341 / 0.356 / 0.358 |
| fold 2 train 08-06..09-16 | 60 / 120 / 180 | 3422 / 2726 / 2030 | | | | 0.473 / 0.461 / 0.435 | 0.356 / 0.345 / 0.332 |
| fold 3 train 08-20..09-30 | 60 / 120 / 180 | 3422 / 2726 / 2030 | | | | 0.550 / 0.519 / 0.471 | 0.415 / 0.400 / 0.370 |

Hourly bars over three years, as a longer-run check. Starts are at 10:15–14:15 and ends at or before 15:15, so the closing-auction bar is excluded:

| period | f at h = 60 / 120 / 180 / 240 / 300 min |
|---|---|
| all (Nov 2023 – Oct 2026) | 0.625 / 0.636 / 0.627 / 0.634 / 0.659 |
| 2024 (election-result crash in June) | 0.714 / 0.715 / 0.679 / 0.686 / 0.737 |
| 2025 | 0.561 / 0.572 / 0.577 / 0.578 / 0.599 |
| 2026 | 0.588 / 0.612 / 0.627 / 0.637 / 0.630 |

The realized intraday move is 0.45–0.66× the option's implied σ at every horizon and in every period. The legacy gate assumes **1.1×**. In RMS terms that is ≈ 2.0× too large, and ≈ 2.7× against the mean absolute move. Two things explain the gap: the variance risk premium, and the overnight share of the variance that VIX prices.

### 2.3 β of the realized move on the score, by walk-forward fold

At the engine's own horizon; z is in realized-σ units.

| window | sessions | f | scored points | **β (through origin)** | SE | α / β with intercept (SE) | β, passing decisions only (n) | direction right |
|---|---|---|---|---|---|---|---|---|
| all 07-23..10-08 | 54 | 0.539 | 803 | **−0.096** | 0.258 | 0.095 / −0.256 (0.439) | −0.266 ± 0.302 (366) | 51.4% |
| fold 1 train 07-23..09-02 | 30 | 0.476 | 625 | −0.116 | 0.318 | 0.161 / −0.378 (0.490) | −0.356 ± 0.354 (298) | 51.5% |
| fold 1 test 09-03..09-16 | 9 | 0.478 | 73 | +0.525 | 1.180 | | +0.59 ± 1.66 (34) | 63.0% |
| fold 2 train 08-06..09-16 | 29 | 0.470 | 379 | −0.065 | 0.533 | | −0.203 ± 0.607 (174) | 51.5% |
| fold 2 test 09-17..09-30 | 10 | 0.590 | 44 | −1.474 | 0.339 | | −1.70 ± 0.57 (12) | 25.0% |
| fold 3 train 08-20..09-30 | 29 | 0.544 | 211 | +0.292 | 0.714 | | +0.134 ± 0.970 (61) | 54.0% |
| fold 3 test 10-01..10-08 | 5 | 0.748 | 61 | +0.053 | 0.533 | | −0.02 ± 0.36 (22) | 55.7% |
| **pooled test windows** | 24 | 0.605 | 178 | **−0.056** | 0.605 | −0.055 / 0.053 (1.32) | +0.012 ± 0.831 (68) | 51.1% |

Taking the legacy formula at face value (expected move = |score| × kEM × 1.1 × implied σ), it implicitly assumes β ≈ 1.1 / 0.54 ≈ **2.0** in these units. The measured value is indistinguishable from zero.

On the 51 trades themselves:

* The legacy expected move averaged **0.275%**; the realized signed move at the planned horizon averaged **−0.043%**.
* The OLS slope of realized on expected is **−2.14 (SE 0.95)**.
* Direction was right on 30 of 51.

These figures come from the point-in-time measurement above. The planning note's quicker estimate (−0.018%, slope −1.02) used a different end price and reached the same conclusion.

### 2.4 Trades kept and blocked by the calibrated gate (counterfactual on the 51 baseline trades)

Each trade's entry decision was re-evaluated with the calibrated rows. The ask was re-priced exactly for 51 of 51.

* **OOS verdict** uses the fold's training estimates and covers trades inside a test window.
* **In-sample verdict** uses the full-sample estimates (f 0.539, β −0.096).
* **β needed** is the smallest β at which both calibrated checks pass. The calibrated edge is linear in β, so this is well defined.

| # | entry (IST) | index | side | score | h | net ₹ | fold | cal. edge % | β needed | OOS | in-sample |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 07-23 10:06 | NIFTY | BULL | 0.60 | 90 | −1041 | – | −4.4 | 1.39 | – | blocked |
| 2 | 07-23 10:06 | SENSEX | BULL | 0.57 | 90 | −993 | – | −3.4 | 1.67 | – | blocked |
| 3 | 07-24 09:46 | SENSEX | BEAR | −0.58 | 60 | 419 | – | −2.8 | 1.65 | – | blocked |
| 4 | 07-24 09:51 | SENSEX | BEAR | −0.63 | 60 | −106 | – | −2.8 | 1.54 | – | blocked |
| 5 | 07-24 10:51 | SENSEX | BEAR | −0.57 | 120 | −1031 | – | −4.1 | 1.28 | – | blocked |
| 6 | 07-24 11:01 | SENSEX | BEAR | −0.78 | 120 | −1620 | – | −4.6 | 0.93 | – | blocked |
| 7 | 07-29 09:46 | SENSEX | BULL | 0.66 | 120 | −381 | – | −9.8 | 1.00 | – | blocked |
| 8 | 07-29 09:51 | SENSEX | BULL | 0.65 | 120 | −380 | – | −9.9 | 1.00 | – | blocked |
| 9 | 07-31 09:51 | SENSEX | BULL | 0.62 | 90 | −299 | – | −3.9 | 1.45 | – | blocked |
| 10 | 07-31 09:56 | SENSEX | BULL | 0.62 | 120 | −118 | – | −4.8 | 1.30 | – | blocked |
| 11 | 08-03 10:21 | NIFTY | BULL | 0.59 | 120 | −56 | – | −10.2 | 1.11 | – | blocked |
| 12 | 08-03 10:26 | NIFTY | BULL | 0.59 | 120 | 250 | – | −10.7 | 1.12 | – | blocked |
| 13 | 08-04 10:46 | SENSEX | BEAR | −0.57 | 90 | 4100 | – | −4.9 | 1.21 | – | blocked |
| 14 | 08-04 10:51 | SENSEX | BEAR | −0.56 | 90 | 4172 | – | −4.9 | 1.23 | – | blocked |
| 15 | 08-05 10:36 | NIFTY | BEAR | −0.60 | 90 | −1437 | – | −3.3 | 1.37 | – | blocked |
| 16 | 08-05 10:36 | SENSEX | BEAR | −0.57 | 90 | −2048 | – | −7.4 | 1.10 | – | blocked |
| 17 | 08-05 11:01 | SENSEX | BULL | 0.67 | 90 | −1034 | – | −8.8 | 1.01 | – | blocked |
| 18 | 08-10 09:36 | NIFTY | BEAR | −0.71 | 90 | −2452 | – | −6.5 | 0.89 | – | blocked |
| 19 | 08-10 09:41 | NIFTY | BEAR | −0.72 | 90 | −2290 | – | −6.4 | 0.89 | – | blocked |
| 20 | 08-11 09:41 | NIFTY | BEAR | −0.66 | 120 | 737 | – | −3.5 | 1.20 | – | blocked |
| 21 | 08-11 09:56 | SENSEX | BEAR | −0.65 | 120 | −58 | – | −6.3 | 0.98 | – | blocked |
| 22 | 08-12 10:06 | SENSEX | BEAR | −0.68 | 60 | 3079 | – | −5.6 | 1.03 | – | blocked |
| 23 | 08-12 10:06 | NIFTY | BEAR | −0.68 | 90 | 1394 | – | −3.7 | 1.19 | – | blocked |
| 24 | 08-13 10:36 | NIFTY | BEAR | −0.37 | 120 | −260 | – | −4.8 | 1.83 | – | blocked |
| 25 | 08-17 10:21 | SENSEX | BEAR | −0.68 | 90 | −86 | – | −4.1 | 1.11 | – | blocked |
| 26 | 08-17 10:26 | NIFTY | BEAR | −0.85 | 120 | −1618 | – | −9.5 | 0.70 | – | blocked |
| 27 | 08-19 09:36 | NIFTY | BEAR | −0.67 | 120 | 157 | – | −4.4 | 1.08 | – | blocked |
| 28 | 08-19 09:36 | SENSEX | BEAR | −0.75 | 120 | 317 | – | −8.5 | 0.79 | – | blocked |
| 29 | 08-19 11:41 | NIFTY | BEAR | −0.71 | 120 | −360 | – | −4.4 | 1.02 | – | blocked |
| 30 | 08-19 11:41 | SENSEX | BEAR | −0.71 | 120 | −662 | – | −9.5 | 0.82 | – | blocked |
| 31 | 08-24 10:01 | NIFTY | BEAR | −0.66 | 90 | 2805 | – | −7.6 | 0.96 | – | blocked |
| 32 | 08-24 10:01 | SENSEX | BEAR | −0.70 | 90 | 2472 | – | −4.2 | 1.07 | – | blocked |
| 33 | 08-25 10:26 | SENSEX | BEAR | −0.56 | 120 | −2284 | – | −6.3 | 1.13 | – | blocked |
| 34 | 08-26 09:51 | NIFTY | BULL | 0.53 | 120 | −2442 | – | −4.5 | 1.58 | – | blocked |
| 35 | 08-27 10:11 | NIFTY | BEAR | −0.40 | 120 | 197 | – | −4.4 | 1.71 | – | blocked |
| 36 | 08-27 10:16 | NIFTY | BEAR | −0.49 | 120 | 608 | – | −4.4 | 1.40 | – | blocked |
| 37 | 09-01 11:16 | NIFTY | BULL | 0.75 | 120 | −2475 | – | −4.5 | 1.16 | – | blocked |
| 38 | 09-04 09:56 | SENSEX | BULL | 0.63 | 90 | 713 | 1 | −4.2 | 1.44 | blocked | blocked |
| 39 | 09-09 10:06 | SENSEX | BEAR | −0.43 | 120 | −1229 | 1 | −8.2 | 1.38 | blocked | blocked |
| 40 | 09-09 10:11 | NIFTY | BEAR | −0.46 | 120 | −380 | 1 | −4.6 | 1.51 | blocked | blocked |
| 41 | 09-15 09:46 | NIFTY | BEAR | −0.60 | 60 | 5170 | 1 | −2.7 | 1.74 | blocked | blocked |
| 42 | 09-15 09:51 | NIFTY | BEAR | −0.65 | 60 | 5113 | 1 | −2.8 | 1.58 | blocked | blocked |
| 43 | 09-16 09:41 | SENSEX | BEAR | −0.67 | 60 | −2456 | 1 | −5.6 | 1.07 | blocked | blocked |
| 44 | 09-16 09:46 | NIFTY | BEAR | −0.74 | 60 | −2986 | 1 | −3.2 | 1.30 | blocked | blocked |
| 45 | 09-17 12:11 | NIFTY | BULL | 0.54 | 60 | −584 | 2 | −3.7 | 1.70 | blocked | blocked |
| 46 | 09-29 09:41 | SENSEX | BEAR | −0.56 | 60 | −1528 | 2 | −3.5 | 1.45 | blocked | blocked |
| 47 | 09-29 10:11 | SENSEX | BEAR | −0.58 | 120 | −3149 | 2 | −6.1 | 1.11 | blocked | blocked |
| 48 | 10-05 09:36 | SENSEX | BULL | 0.44 | 120 | −3775 | 3 | −1.7 | 1.71 | blocked | blocked |
| 49 | 10-05 09:41 | SENSEX | BULL | 0.48 | 120 | −3636 | 3 | −1.5 | 1.56 | blocked | blocked |
| 50 | 10-07 10:31 | NIFTY | BULL | 0.59 | 90 | −689 | 3 | −0.5 | 1.49 | blocked | blocked |
| 51 | 10-08 09:56 | NIFTY | BEAR | −0.47 | 120 | 4644 | 3 | −1.0 | 1.46 | blocked | blocked |

| evaluation | trades | kept | blocked | kept net ₹ | blocked net ₹ |
|---|---|---|---|---|---|
| out of sample: fold parameters, trades in the 3 test windows | 14 | 0 | 14 | 0 | −4,770.44 |
| in sample: full-sample f 0.539, β −0.096 | 51 | 0 | 51 | 0 | −9,595.92 |
| sensitivity: β at its upper 95% bound, 0.409 | 51 | 0 | 51 | 0 | −9,595.92 |
| sensitivity: priced at real IV (NIFTY 0.88–0.91× VIX, SENSEX 0.92–0.93×), same realized move, β −0.10 or 0.41 | 51 | 0 | 51 | 0 | −9,595.92 |

**β needed to keep a trade:** min 0.70, median 1.21, max 1.83. At real IV it is min 0.58–0.61, median 1.04–1.06, max 1.56–1.62.

The measured β is −0.096 ± 0.258. β ≥ 0.70 lies 3.1 SE above it (one-sided p ≈ 0.001), and β ≥ 0.58 lies 2.6 SE above it. The β pooled over the test windows is too noisy to reject anything on its own (−0.06 ± 0.61).

### 2.5 Backtests with the calibrated gate (path-dependent, logged)

| run | parameters (trained on) | trades | net ₹ |
|---|---|---|---|
| full period, legacy (default) | – | 51 | −9,595.92 |
| full period, calibrated, **in-sample** | f 0.539, β −0.096 (07-23..10-08) | 0 | 0 |
| full period, calibrated, β at upper 95% bound | f 0.539, β 0.409 | 0 | 0 |
| fold 1 test 09-03..09-16, legacy | – | 20 | +45.57 |
| fold 1 test, calibrated (OOS) | f 0.476, β −0.116 (07-23..09-02) | 0 | 0 |
| fold 2 test 09-17..09-30, legacy | – | 13 | −5,954.58 |
| fold 2 test, calibrated (OOS) | f 0.470, β −0.065 (08-06..09-16) | 0 | 0 |
| fold 3 test 10-01..10-08, legacy | – | 12 | +9,759.25 |
| fold 3 test, calibrated (OOS) | f 0.544, β +0.292 (08-20..09-30) | 0 | 0 |
| **pooled OOS folds** | | legacy 45 / calibrated 0 | legacy **+3,850.24** / calibrated 0 |

The fold runs start each test window with a fresh book. A fresh book also resets the signal-performance weights and the decay rule, so the legacy fold runs take more trades (45) than the full-period run takes in those windows (14).

The honest reading is that the pooled out-of-sample legacy result is **+₹3,850 over 45 trades**, almost all of it from one 5-session fold (+₹9,759, PF 2.28). The calibrated gate would have given that up, just as it avoids −₹9,596 over the full period. Neither P&L figure is distinguishable from noise: per-trade σ is about ₹2,000, so the standard error of a 45-trade mean is about ₹300 per trade. The gate's verdict rests on the measured β, not on either P&L number.

## 3. WP5: HAR-RV vol-cheapness gate

### 3.1 HAR fits and out-of-sample R²

Fits are OLS on variance levels, in %² per session. The out-of-sample evaluation uses an expanding window: each forecast is fitted on earlier sessions only, with at least 60 observations (20 for the 5-minute series). R²oos is measured against two benchmarks: the historical mean and the random walk RV[t] (labelled RW).

| index | measure | sessions | mean RV | b0 | bd | bw | bm | R² in-sample | OOS n (from) | R²oos vs mean | R²oos vs RW |
|---|---|---|---|---|---|---|---|---|---|---|---|
| NIFTY | 5-min RV 09:15–15:15 | 58 | 0.209 | −0.109 | 0.520 | −0.126 | 1.523 | 0.528 | 16 (2026-09-16) | 0.239 | −0.344 |
| NIFTY | hourly RV, 3 years | 719 | 0.402 | 0.287 | 0.102 | 0.009 | 0.193 | 0.017 | 637 (2024-02-29) | −0.074 | 0.387 |
| NIFTY | hourly RV, same 2-year span as daily | 490 | 0.383 | 0.128 | 0.068 | 0.216 | 0.367 | 0.087 | 408 (2025-02-04) | 0.084 | 0.380 |
| NIFTY | **daily Parkinson (the engine's)** | 496 | 0.397 | 0.101 | 0.024 | 0.257 | 0.457 | 0.126 | 414 (2025-02-03) | **0.129** | **0.358** |
| SENSEX | 5-min RV 09:15–15:15 | 58 | 0.234 | −0.060 | 0.542 | 0.059 | 0.887 | 0.495 | 16 (2026-09-16) | 0.154 | −0.404 |
| SENSEX | hourly RV, 3 years | 719 | 0.414 | 0.275 | 0.097 | 0.006 | 0.249 | 0.018 | 637 (2024-02-29) | −0.065 | 0.393 |
| SENSEX | hourly RV, same 2-year span as daily | 490 | 0.401 | 0.121 | 0.045 | 0.079 | 0.564 | 0.076 | 408 (2025-02-04) | 0.071 | 0.425 |
| SENSEX | **daily Parkinson (the engine's)** | 495 | 0.409 | 0.097 | 0.033 | 0.173 | 0.552 | 0.125 | 413 (2025-02-04) | **0.127** | **0.377** |

Notes on the fits:

* The 5-minute series (58 sessions) is too short to judge.
* The 3-year hourly fit is dominated by one session: 4 Jun 2024, the election-results day, with hourly RV 21.3 %² against a mean of 0.40. That one outlier wrecks a levels OLS. On the common 2-year span the hourly fit behaves like Parkinson but noisier, since it has only 6 returns a day.
* No winsorizing or log transform was applied to the gate. The model is used as published.

### 3.2 How much options charge compared with what is realized

Variance per session, 2 years of daily bars; the implied variance uses VIX × vixMultiplier at the previous close.

| index | sessions | mean Parkinson / implied | median | mean (overnight gap² + Parkinson) / implied | share of sessions with Parkinson ≥ implied |
|---|---|---|---|---|---|
| NIFTY | 492 | **0.483** | 0.352 | 0.885 | 8.7% |
| SENSEX | 492 | **0.451** | 0.319 | 0.847 | 7.3% |

An intraday buyer earns only the intraday part of the variance, but in this engine pays the whole session's implied variance as theta. Even a perfect forecaster would find the session "cheap" on only 7–9% of days.

### 3.3 Gate pass rate

Decision hours are the hourly VIX closes at 10:15–14:15, 5 per session. "Sessions" are those with an engine forecast.

| index | forecast | k | sessions | pass rate (hours) | sessions with a pass | mean forecast / implied |
|---|---|---|---|---|---|---|
| NIFTY | daily Parkinson (engine), 2025-02-03..2026-10-08 | 0.8 | 409 | 1.76% | 8 | 0.495 |
| NIFTY | | **1.0** | 409 | **0.00%** | **0** | |
| NIFTY | | 1.2 | 409 | 0.00% | 0 | |
| SENSEX | daily Parkinson (engine), 2025-02-04..2026-10-08 | 0.8 | 408 | 1.08% | 6 | 0.473 |
| SENSEX | | **1.0** | 408 | **0.00%** | **0** | |
| SENSEX | | 1.2 | 408 | 0.00% | 0 | |
| NIFTY | hourly-RV HAR (robustness), same sessions | 0.8 / 1.0 / 1.2 | 409 | 17.1% / 1.03% / 0.24% | 78 / 7 / 1 | 0.61 |
| SENSEX | hourly-RV HAR, same sessions | 0.8 / 1.0 / 1.2 | 407 | 9.1% / 0.25% / 0.25% | 42 / 1 / 1 | 0.56 |
| NIFTY | hourly-RV HAR, all its sessions 2024-02-29..2026-10-08 | 0.8 / 1.0 / 1.2 | 637 | 13.9% / 1.70% / 0.78% | 100 / 14 / 5 | 0.60 |
| SENSEX | hourly-RV HAR, all its sessions | 0.8 / 1.0 / 1.2 | 636 | 7.5% / 0.94% / 0.94% | 56 / 6 / 6 | 0.55 |

Sessions passing at k = 0.8 with the engine forecast:

* NIFTY: 2025-02-25, 2025-02-27, 2026-02-05, 06, 09, 10, 11, 12.
* SENSEX: 2026-02-04, 05, 06, 09, 10, 11.

Each of these follows a volatility shock. The HAR carries the shock forward for weeks while VIX has already come back down. Ex post, those sessions realized **less** than the blocked ones:

| index | k | sessions passed | realized/implied on passed sessions | on blocked sessions |
|---|---|---|---|---|
| NIFTY | 0.8 | 7 | **0.216** | 0.447 |
| SENSEX | 0.8 | 3 | **0.281** | 0.418 |

### 3.4 Against the real option prices (research note: weekly IV ≈ 0.88–0.91× VIX for NIFTY, 0.92–0.93× for SENSEX)

With implied variance taken from the real IV instead of the engine's VIX × multiplier (k = 1 frozen):

| index | IV / VIX | sessions | pass rate (hours) | sessions with a pass | mean forecast / implied | realized/implied: pass days (n) | other days (n) |
|---|---|---|---|---|---|---|---|
| NIFTY | 0.88 | 409 | 2.00% | 9 | 0.639 | **0.301** (9) | 0.578 (400) |
| NIFTY | 0.91 | 409 | 1.56% | 7 | 0.598 | **0.261** (7) | 0.539 (402) |
| SENSEX | 0.92 | 408 | 1.57% | 7 | 0.615 | **0.356** (7) | 0.547 (401) |
| SENSEX | 0.93 | 408 | 1.37% | 7 | 0.602 | **0.348** (7) | 0.535 (401) |

The real-IV sensitivity changes the pass rate from 0% to about 1.5%, and in this sample every extra pass is a false positive. That matches the research agent's result: a "buy only when 5-day realized ≥ implied" filter still lost ₹873 per NIFTY straddle trade on real prices.

The deeper problem is that realized intraday variance averages only about 0.55–0.6× even the real implied variance, so no realized-vs-implied filter can turn intraday long premium into a positive-carry position. That figure is the 3.2 means rescaled to real IV, about 0.58–0.62; the blocked days in the table above came out at 0.54–0.58. Only the close-to-close variance comes near the real IV: scaling the overnight-inclusive column of 3.2 gives ≈ 1.07–1.14. An intraday buyer does not earn that.

### 3.5 Effect on the engine's trades

* Counterfactual: the gate is false at the entry decision of **all 51 trades** for k = 0.8, 1.0 and 1.2. Forecast/implied at those entries ranged 0.33–0.52 (mean 0.41).
* Backtests with the gate on, k = 1 (frozen), 0.8 and 1.2: **0 trades, net ₹0** each, against 51 trades and −₹9,595.92.
* The effect on WP3's noise-area variant was not evaluated, because that code is not in this worktree. The gate applies to any variant through `planEntry`.

## 4. Conclusions

1. **The legacy edge gate passes trades on assumptions the data contradict.** The realized move is about half the implied σ, not 1.1×. The score has no measurable directional content: β −0.10 ± 0.26 in-sample, −0.06 ± 0.61 pooled out-of-sample. The edge the gate prints is mostly the sum of those two errors.
2. **Measured honestly, no trade the engine takes pays for an at-the-money weekly's theta and costs at 60–180-minute horizons.** Even at the upper 95% bound of β, and even priced at the real IV, the gate keeps 0 of 51. Any future signal must show a measured β of about **0.6–0.7 or more** on the decision grid, out of sample, before this structure can be positive. That β is roughly an information coefficient of 0.1 per trade sustained over hundreds of decisions, which the literature in §2 of the plan does not support for 5-minute index signals.
3. **The HAR-RV gate is a weak timing tool here.** It forecasts variance (R²oos ≈ 0.13), but options are rarely cheap for an intraday holder: intraday realized variance averages 0.45–0.48× the engine's implied and about 0.55–0.6× the real IV. Its rare passes came after volatility shocks and realized less than average.
4. **Neither gate creates edge. They only stop the carry by not trading.** The −₹9,596 → ₹0 change comes entirely from taking no trades, and in the out-of-sample fold windows the same rule gave up +₹3,850 of legacy P&L. Both numbers are noise at these sample sizes.
5. **Recommendation:**
   * Merge the flags. They are off by default and change no behaviour.
   * Turning `expectedMoveModel: "calibrated"` on in paper is equivalent to pausing directional buying with the current signal, which the evidence supports. Leave it on for any new variant until its out-of-sample β clears the bar. Re-estimate f and β walk-forward; the CLI flags exist for that.
   * Do not use the vol-cheapness gate as a reason to trade. At k = 1 it is close to "never", and its passes were false positives.

## 5. Caveats and what is left

* **Option prices are synthetic**, and the engine charges theta only in session.
  * Real weekly IV is about 0.9× VIX; the sensitivity above covers this.
  * Real options may also lose part of their value overnight (Bhat–Pandey–Rao 2024), which would lower the intraday theta the engine assumes. Pricing that belongs to WP6, which owns the pricer.
* **Small samples.**
  * β rests on 803 scored points over 48 sessions with overlapping horizons; the clustered standard errors with 48 clusters are approximate.
  * The folds hold 5–10 test sessions each, too few for per-fold conclusions.
  * The first 37 trades have no out-of-sample parameters.
* **f uses VIX × vixMultiplier as the implied σ** to match the engine. Measured against real IV, the same absolute realized move is about 0.59–0.61× (NIFTY).
* **HAR on variance levels is sensitive to outliers.** Jump-robust variants (HAR-CJ, bipower variation) and log-HAR were not tested. They would treat the February shocks as less persistent and pass even less often.
* **Daily-bar quirks.** Parkinson on daily bars includes the opening print and the closing auction. Three special sessions (two Muhurat hours and the Budget Saturday) sit unfiltered in the daily data, out of about 495.
* **Production keeps only about 6 months of daily bars** (around 100 HAR observations). If the gate is ever enabled there, `range=2y` would give parity with backtests. That is not changed here, because `yahooMarketData.ts` is outside WP5. When enabled, the gate reads the market snapshot once per index per day.
* **Edit outside the owned list:** `src/lib/copy/action.ts`, which gained plain-language reasons for `edge_calibrated`, `move_calibrated` and `vol_cheapness`.
* **`reports/` is in `.gitignore`**, so this file, `trials.jsonl` and `wp2-wp5-calibration.json` were force-added.

## 6. Reproduce

```
# calibration + diagnostics (about 40 s; reads only saved files)
npx tsx scripts/research/wp2-wp5-gates.ts --history <scratchpad>/why/hist.json --hourly <scratchpad>/dl/y1h --out reports/wp2-wp5-calibration.json

# backtests (each about 30 s; fold windows about 6 s)
npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits --history <hist.json>                                   # default: 51 / -9,595.92
npm run backtest -- ... --em-model calibrated --realized-vol-factor 0.539 --move-beta -0.096                                             # in-sample
npm run backtest -- --from 2026-09-03 --to 2026-09-16 --no-events --prod-limits --history <hist.json> --em-model calibrated --realized-vol-factor 0.476 --move-beta -0.116   # fold 1 OOS
npm run backtest -- --from 2026-09-17 --to 2026-09-30 ... --realized-vol-factor 0.470 --move-beta -0.065                                # fold 2 OOS
npm run backtest -- --from 2026-10-01 --to 2026-10-08 ... --realized-vol-factor 0.544 --move-beta 0.292                                 # fold 3 OOS
npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits --history <hist.json> --vol-cheapness --vol-k 1          # WP5 (0.8 / 1.2 as perturbations)
```

Trials ledger: 21 lines from WP2/WP5, all in `reports/trials.jsonl`.

* 12 backtest variants: the default, 2 full-period calibrated, 3 + 3 fold runs, and 3 vol-cheapness runs.
* 3 default-behaviour checks: before the change, after the change, and on the final commit.
* 6 identical baseline replays made by the research script. Their purpose is to record decision points; they are not new variants.
