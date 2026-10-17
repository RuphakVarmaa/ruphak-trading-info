# NIFTY before the open: gaps, trend indicators and FII flows (Q2)

Prepared 9 Oct 2026, about 09:20 IST. This is analysis only: no repo files were changed. Market data comes from Yahoo's chart API and FPI flows come from NSDL. Every hit rate is shown as `rate [90% Wilson CI] (n)`, and every mean as `mean [90% bootstrap CI]`. "Out of sample" (OOS) means the rule or model was fitted on an earlier period and scored on a later one.

Owner's question: *"Can NIFTY's prices be found before the market opens — gap up or gap down?"* The owner also believes ADX, moving averages and FII selling let you plan trades. Their example: Thu 8 Oct 2026, FIIs sold ₹12,988 cr, NIFTY fell 1.64% and puts paid.

---

## 1. Answers in plain language

### Can the gap be known before 09:15?

* **At 09:08 IST: yes, exactly.** NSE's pre-open call auction (09:00–09:08) sets the official opening price. Yahoo already showed today's open (22,314.95, +0.37%) at 09:11. So "gap up or gap down" is fully known about 7 minutes before trading starts.
* **At about 09:00 IST, from global cues: about 7 days in 10.** The model uses only prices that had finished by 09:00:
  * S&P 500 futures (ES) since yesterday's 15:30 IST close;
  * Asian markets' morning sessions;
  * the rupee (USDINR);
  * crude oil.

  A four-input linear model called the gap direction right on **71% [68–75] (n=457)** of days, walk-forward. The baselines were 48–57% for "always gap-up" and 54.5% for "same direction as yesterday".
  * **Clear calls.** When the model expected a gap beyond ±0.3% (37% of days), the direction was right **87% [82–91] (n=171)**. Beyond ±0.5% (18% of days) it was right 90%.
  * **Size is harder to predict.** On those clear-call days, the actual gap went past 0.3% in the predicted direction only 49% of the time.
  * **Flat calls.** When the model expected a flat open (within ±0.1%, a quarter of days), it was a coin flip: 52%.
  * **Typical miss.** About 72 NIFTY points on average (median about 50). Without a model the average miss is about 100 points. One day in ten misses by 145 points or more.
  * **Rule of thumb.** NIFTY's gap ≈ 0.4 × the % move in S&P futures since 15:30 IST (R² 0.37). Adding Asia, the rupee and crude raises OOS R² to about 0.50.
  * **15-year check.** The direction of the overnight US session matched NIFTY's gap direction on 68–70% of days. When the S&P moved more than 1%, it matched on 82–89% of days.
* **GIFT Nifty could not be tested.** It is the most direct pre-open indicator, but:
  * Yahoo has no GIFT Nifty symbol. Searches for "GIFT NIFTY", "SGX Nifty" and "Nifty future" return nothing, and more than 20 candidate tickers (`^GIFTNIFTY`, `NIFTY=F`, `IN=F`, `SGXNIFTY`, …) return 404.
  * NSE IX serves its history only through an API that needs a browser-issued token. I did not automate around that.

  GIFT Nifty trades NIFTY futures from 06:30 IST, so it should beat these proxies. Even so, the 09:08 auction settles the open anyway.
* **Today, as a single example:** at 09:00 the model called +0.09% (+20 pts). The actual open was +0.37% (+83 pts). The direction was right and the size was 63 pts low, which is about a typical miss.

### Does knowing the gap tell you whether to buy CE or PE? No.

* **Rest of the day.**
  * Gap-up days (≥ +0.2%) closed above their open on **50%** of days over the last 2 years (n=148) and **48%** since 2011 (n=1,639).
  * Gap-down days (≤ −0.2%) closed below their open on **51%** and **52%** of days.
  * I picked "follow the gap" or "fade the gap" using 2011–18 data and scored it on 2019–26. It scored 49.5–51.4%.
* **Gap fill** (price gets back to the previous close by 15:30):

  | Gap size | Filled by the close |
  |---|---|
  | 0.2–0.5% | 45–65% of the time |
  | 0.5–1% | 29–42% |
  | ≥ 1% | 7% (last 2 years) to 21–26% (since 2011) |
* **First hour.** After gaps of 0.5% or more, NIFTY moved against the gap between 09:15 and 10:15 on **61% [54–68] (n=137)** of days. The average pull-back was only about 0.10% (≈ 25 pts). The effect has weakened in the last 14 months: 57% [46–67], mean −0.07% [−0.18, +0.04].
* **After the engine's 09:25 entry.** With only 58 days of 5-minute data, 09:25→15:05 went up on 50% of gap-up days (n=14) and 25% of gap-down days (n=16). That sample is far too small, and it came from a falling market. The 15-year daily data above is the reliable answer: the gap direction gives no CE/PE edge.
* **One small, consistent effect.** Sometimes NIFTY opened well away from where global cues pointed (more than 0.3% apart, n=157). In those cases the first hour moved back toward the cue-implied level on **59% [53–66]** of days, and both halves of the sample agree (58% and 60%). The move was only about 0.07% (≈ 16 pts).

### Do ADX, moving averages, EMA crossovers or RSI predict the next day? Not the direction.

* **Next-day open→close direction.** I tested each of these states:
  * close above its 20-, 50- or 200-day moving average;
  * EMA9 above EMA21;
  * +DI above −DI;
  * ADX above 25 with the DI direction;
  * RSI above 50;
  * all three trend states agreeing.

  Out of sample they scored **41–52%** in the last year (n≈170–240 each) and **50–52%** in 2019–26 (n≈700–1,900). None beat simply calling "down" every day (52%), which only reflects NIFTY's slight downward drift during the session.
* **Next-day gap direction.** None beat "always gap-up" (65% of days in 2019–26).
* **Hourly bars.** The same indicators on 60-minute bars at 10:15 scored 45–57% at calling the 10:15–15:15 move (main states 48–51%; n=272 test days). None beat "always down" (54%).
* **The only consistent tilt is contrarian RSI.**
  * After RSI > 70, the next day's open→close was down on 57.5% of days (2011–26, n=388); the mean was −0.12% against −0.07% on all days.
  * After RSI < 30, it was up on 55% of days.
  * Out of sample it scored 55.8% [50.7–60.8] (n=260).

  It fires on about 13% of days and is worth roughly 5–15 NIFTY points, which is smaller than option costs.
* **Size of the move (what option buyers need).**
  * High ADX goes with bigger next-day ranges: 0.82% when ADX < 20 versus 1.30% when ADX > 35 (last 2 years).
  * That is because ADX is high when volatility is high. **India VIX already contains it**: VIX alone predicts tomorrow's range with OOS R² 0.31 (2 years) and 0.41 (15 years). Adding ADX to VIX plus the 20-day average range adds only 0.00–0.03.
  * Intraday, hourly ADX at 10:15 has no relation to the size of the 10:15–15:15 move (correlation 0.03). Hourly ATR does (0.32).

### Does FII selling predict a fall? No. It moves with falls on the same day, but it does not forecast the next day.

* **Same day.** Net FPI buying has a correlation of **0.32 [0.27, 0.36]** (2019–26) and **0.36** (last 2 years) with that day's NIFTY return.
* **Next day.** The correlation with the next day's open→close is **0.00 [−0.04, 0.04]** (n=1,877) and −0.02 over the last 2 years. Out of sample, the model does worse than predicting the average (R² below 0).
* **Big-sell days.**
  * After the 102 days with net selling worse than −₹5,000 cr, the next day closed **above** its open 56% of the time. PE won only **44% [36–52]**, against 52% on all days. The mean next open→close was +0.05% [−0.10, +0.19].
  * After the 12 days worse than −₹10,000 cr, the next open→close averaged +0.21% [−0.23, +0.68].
  * After the 42 days with a NIFTY fall of more than 1% plus selling worse than −₹5,000 cr, the next day bounced: open→close **+0.22% [0.03, 0.41]**.
* **Weeks.** 5- and 20-day FPI totals correlate 0.51–0.61 with the *previous* 5 or 20 days of NIFTY returns. With the *next* 5 or 20 days the correlation is between −0.07 and +0.06, and every confidence interval spans zero.
* **Years.** FPIs sold a net ₹1.28 lakh cr through exchanges in 2024 and ₹2.39 lakh cr in 2025. NIFTY still rose 8.8% and 10.5% in those years.
* **The 8 Oct example.** NSE's provisional figure for 8 Oct was FII/FPI −₹12,943.58 cr and DII +₹10,703.11 cr. It was published *after the close*, so it describes the day; it could not have told anyone to buy puts that morning. The pre-open cues on 8 Oct pointed to a flat open (model −0.12%, actual −0.02%), and the −1.6% fall happened during the session. The next morning, 9 Oct, NIFTY opened +0.37%.
* **One weak effect, outside an intraday buyer's reach.** On days when selling was unusually heavy compared with the previous 60 days (z-score < −2, n=79), the next open was lower on average: **−0.24% [−0.46, −0.02]**. That move happens overnight. A buyer who enters at 09:25 cannot capture it; the next open→close averaged +0.04%.

---

## 2. What this means for the trading plan (and the engine)

1. **Before 09:15:** use the global cues to set expectations for the open: S&P futures move × 0.4, with Asia, the rupee and crude as cross-checks (or GIFT Nifty if you watch it). At 09:08, read the pre-open auction price. Use this for context and for stop and strike distances, **not as a CE/PE direction call**. By 09:25 the option premiums already include the gap.
2. **After the open:**
   * Gap direction says nothing about the rest of the day.
   * Gaps of 0.5% or more tend to pull back a little in the first hour (about 25 pts). That is too small to trade on its own with options.
   * Big gaps (≥ 1%) rarely fill completely, so do not count on a fill.
3. **Indicators:** ADX, SMA and EMA crossovers and RSI describe the trend so far; they do not forecast tomorrow's direction. For how much NIFTY is likely to move (strike choice, stop and target distances), use India VIX and recent range or ATR. ADX adds nothing once VIX is known.
4. **Flows:** treat FII and DII figures as an explanation of what already happened. A heavy-selling day has *not* been followed by a weaker next session for an intraday buyer. If anything, after heavy selling on a >1% down day, the next day leaned toward a bounce.
5. **Engine-specific findings** (in `/home/user/ruphak-trading-info`):
   * **The gap model's fixed coefficients overstate the gap by about 2.1×.** The engine uses `features.gapBetas` in `src/engine/config.ts` (ES 0.45, USDINR −1.5, …). `fitGapBetas` in `src/engine/market/crossAsset.ts` is never called, so these fixed values are what runs.
     * Over 562 sessions the actual gap = 0.002 + **0.48** × the engine's expected gap (90% CI of the slope 0.41–0.55). The mean expected size was 0.61%; the mean actual size was 0.35%.
     * Direction is good (74% right), but on size the fixed coefficients are *worse than no model* out of sample: average miss 116 vs 101 points, OOS R² ≈ 0.
     * Re-fitting the same inputs gives about: ES 0.40, USDINR −0.9, N225 0.06, HSI 0.07, and the rest ≈ 0. NQ comes out negative only because it duplicates ES.
     * Both the gap residual (`gapResidualPct`) and `globalBetaSignal` inherit this bias. On big global nights the engine will think "India lagged" and lean toward catch-up too often.
     * With correctly scaled coefficients, the catch-up idea has weak support: 59% when the residual is more than 0.3%, about 16 pts in the first hour.
   * **Trend weight.** The engine already gives the TREND component zero weight, which these results support. ADX is fine for labelling the regime but should not be used to forecast move size.
   * **Entry time.** The engine's first entry (09:25) falls inside the window in which big gaps partly retrace. That retracement is small (about 0.1%), and nothing here suggests the CE/PE odds after 09:25 depend on the gap direction.

---

## 3. Details

### (a) Gap prediction before 09:15

**Data and timing.**
* Target: gap = NIFTY daily open / previous close − 1, from Yahoo `^NSEI` daily bars. The daily open is the pre-open auction price.
* Predictors: the move from the previous NIFTY close (15:30 IST) to the 09:00 IST cutoff, using 60-minute bars. Only bars that had **finished** by the cutoff are used.
  * For markets whose bars start on the hour (ES, NQ, Nikkei, Kospi, ASX, USDINR, crude), the last finished bar ends at 08:30 IST. For Hang Seng and Shanghai it ends at 09:00.
  * A 15-minute check on the last 45 days shows the predictive power is the same whether ES is measured to 08:30, 09:00 or 09:15 (correlation 0.44 in each case).
* Sample: 22 May 2024 to 8 Oct 2026, **n = 577** sessions, excluding Muhurat and special sessions.
* Gap distribution: sd 0.59%; median |gap| 0.22% (54 pts); gap up on 56.8% of days; |gap| > 0.3% on 38% of days, > 0.5% on 19%, > 1% on 6%.

**Single predictors (whole sample, in-sample):**

| predictor (move to 09:00 IST) | corr with gap [90% CI] | R² | slope (gap % per 1% move) |
|---|---|---|---|
| ES (S&P 500 futures) | 0.61 [0.51, 0.70] | 0.37 | 0.39 |
| YM (Dow futures) | 0.60 [0.52, 0.69] | 0.36 | 0.41 |
| Asia average (N225, KS11, HSI, ASX, TWII) | 0.57 [0.47, 0.67] | 0.32 | 0.31 |
| USDINR (rupee; + = weaker rupee) | −0.56 [−0.66, −0.41] | 0.31 | −2.15 |
| NQ (Nasdaq futures) | 0.53 [0.43, 0.64] | 0.29 | 0.25 |
| ASX 200 | 0.53 [0.44, 0.62] | 0.29 | 0.43 |
| US VIX | −0.51 [−0.60, −0.42] | 0.26 | −0.04 per VIX % |
| Nikkei 225 | 0.50 [0.42, 0.57] | 0.25 | 0.19 |
| Hang Seng | 0.44 [0.31, 0.56] | 0.19 | 0.21 |
| Kospi | 0.37 [0.28, 0.46] | 0.14 | 0.10 |
| Crude (WTI) | −0.30 [−0.43, −0.15] | 0.09 | −0.07 |
| Dollar index | −0.23 [−0.33, −0.13] | 0.05 | −0.40 |
| US 10y yield (bp) | −0.07 [−0.17, 0.02] | 0.01 | — |
| NIFTY's own previous-day move | 0.02 [−0.08, 0.12] | 0.00 | — |

**Out-of-sample split.** Fitted on 22 May 2024 – 17 Oct 2025 (n=346), tested on 20 Oct 2025 – 8 Oct 2026 (n=231). In the test period "always gap-up" scored 48.1% and "same direction as yesterday" scored 54.5%.

| model | OOS R² [90% CI] | sign hit | clear call (\|pred\|>0.3%) hit | clear call and actual >0.15% same way | avg miss, pts (model / no model) | median miss, pts |
|---|---|---|---|---|---|---|
| ES only | 0.30 [0.20, 0.42] | 70.1% [65.0–74.8] (231) | 93.8% [85.4–97.5] (48) | 83.3% (48) | 82 / 100 | 59 |
| Nikkei only | 0.27 [0.17, 0.39] | 67.1% (231) | 78.5% (65) | 70.8% (65) | 89 / 100 | 67 |
| Asia average only | 0.17 [0.00, 0.35] | 67.1% (231) | 76.5% (115) | 63.5% (115) | 95 / 100 | 63 |
| USDINR only | 0.41 [0.17, 0.57] | 55.8% (231) | 78.6% (28) | 67.9% (28) | 87 / 100 | 59 |
| Crude only | −0.14 | 42.0% (231) | — | — | 106 / 100 | 62 |
| ES + Asia average | 0.33 [0.19, 0.48] | 64.5% (231) | 87.6% (89) | 74.2% (89) | 84 / 100 | 62 |
| **ES + Asia average + USDINR + crude** | **0.52 [0.40, 0.61]** | 67.1% [61.8–72.0] (231) | 88.3% [81.7–92.7] (94) | 77.7% (94) | **78 / 100** | 59 |
| Engine default `gapBetas` (no fit) | −0.00 [−0.55, 0.34] | 73.7% (224) | 84.6% (143) | 70.6% (143) | 116 / 101 | 85 |

**Walk-forward.** The model is trained on the first 120 sessions and refitted every 20 sessions; 457 OOS days.

| model | OOS R² | sign hit | clear call (\|pred\|>0.3%) | avg / median miss, pts |
|---|---|---|---|---|
| ES only | 0.36 | 71.8% [68.2–75.1] | 87.9% [82.1–92.1] (116) | 73 / 50 |
| ES + Asia average | 0.40 | 68.9% [65.3–72.4] | 87.2% [82.1–91.0] (156) | 72 / 49 |
| ES + Asia average + USDINR + crude | 0.50 | 71.3% [67.7–74.7] | 87.1% [82.3–90.8] (171) | 72 / 53 |

**What the walk-forward model said vs what happened** (4-input model):

| predicted gap | n | mean actual gap [90% CI] | actual gap was up | avg miss, pts |
|---|---|---|---|---|
| below −0.6% | 24 | −1.23% [−1.61, −0.90] | 0% [0–10] | 145 |
| −0.6 to −0.3% | 42 | −0.27% [−0.35, −0.18] | 24% [15–36] | 77 |
| −0.3 to −0.1% | 59 | −0.21% [−0.29, −0.14] | 24% [16–34] | 66 |
| −0.1 to +0.1% | 112 | −0.02% [−0.06, 0.02] | 49% [42–57] | 45 |
| +0.1 to +0.3% | 115 | +0.12% [0.06, 0.18] | 64% [57–71] | 66 |
| +0.3 to +0.6% | 73 | +0.23% [0.18, 0.28] | 88% [80–93] | 66 |
| above +0.6% | 32 | +0.89% [0.62, 1.18] | 91% [79–96] | 148 |

**Model coefficients.** On the full sample: gap % ≈ −0.01 + 0.23·ES + 0.10·Asia − 1.36·USDINR − 0.03·crude (R² 0.56, residual sd 0.39% ≈ 90 pts). The weights move between fits (USDINR was −0.83 on the training half). The ES-only slope is the most stable: 0.35 on the training data and 0.39 on the full sample.

**USDINR data quality.** Yahoo's `USDINR=X` is sparse overnight: many empty hours and stale quotes. Even so, every overnight window before the cutoff carries information (correlation with the gap −0.2 to −0.3 per window), so it is not look-ahead.

**Early direction (09:15–10:15) from what is known at 09:15.** Walk-forward, n=456. Residual = predicted gap − actual gap; a positive residual means NIFTY opened *below* what the cues implied.

| signal | target | corr [90% CI] | same sign | 1st half / 2nd half |
|---|---|---|---|---|
| predicted gap | first hour | −0.06 [−0.17, 0.07] | 50.0% | 46% / 54% |
| residual (pred − actual) | first hour | 0.20 [0.04, 0.36] | 53.5% | 52% / 55% |
| actual gap | first hour | −0.19 [−0.35, −0.02] | 49.6% | 45% / 54% |
| residual | open→close | 0.12 [−0.00, 0.24] | 49.6% | 50% / 49% |

When |residual| > 0.3% (n=157), the first hour moved in the catch-up direction **59.2% [52.7–65.5]** of the time (58% and 60% in the two halves). The regression is first hour ≈ −0.04 + 0.13·(predicted gap) − 0.19·(actual gap), with CIs that exclude zero for both terms. In words: part of the gap retraces and part of the move goes toward the global-implied level, about 0.07% on average.

**15-year check with daily data** (US session vs the next NIFTY gap):

| period | n | sign hit, S&P close-to-close | when \|S&P\| > 1% |
|---|---|---|---|
| 2011–18 | 1,951 | 69.4% [67.7–71.1] | 88.7% [85.9–91.1] (399) |
| 2019–22 | 987 | 69.6% [67.1–72.0] | 82.4% [78.6–85.7] (307) |
| 2023–26 | 929 | 68.5% [65.9–70.9] | 85.6% [81.0–89.2] (201) |

**How much of the day is the gap?** Over the last 2 years the gap accounts for about 55% of the close-to-close variance and the session for about 59%; they slightly offset each other (correlation between gap and open→close −0.13). Typical sizes: median |gap| 53 pts, median day range 207 pts.

### (b) Gap behaviour

**Last 2 years** (9 Oct 2024 – 8 Oct 2026, n=495). Unconditionally, NIFTY closed above its open on 46.1% of days (mean −0.04%).

| gap | n | closed above open | continued in gap direction | mean open→close [90% CI] | filled (touched prev close) | closed beyond prev close | day range |
|---|---|---|---|---|---|---|---|
| ≤ −1% | 15 | 73% [52–87] | 27% | +0.37% [−0.01, 0.74] | 7% [2–25] | 7% | 1.50% |
| −1 to −0.5% | 33 | 64% [49–76] | 36% | +0.09% [−0.11, 0.28] | 33% [22–48] | 27% | 1.04% |
| −0.5 to −0.2% | 67 | 36% [27–46] | 64% | −0.17% [−0.29, −0.06] | 45% [35–55] | 13% | 0.97% |
| flat ±0.2% | 232 | 42% [37–48] | — | −0.04% [−0.11, 0.02] | — | — | 0.89% |
| +0.2 to +0.5% | 102 | 49% [41–57] | 49% | −0.07% [−0.16, 0.02] | 56% [48–64] | 29% | 0.88% |
| +0.5 to +1% | 31 | 55% [40–69] | 55% | +0.07% [−0.12, 0.24] | 29% [18–44] | 13% | 0.99% |
| ≥ +1% | 15 | 47% [28–67] | 47% | −0.02% [−0.42, 0.38] | 7% [2–25] | 0% | 1.30% |

**2011–2026** (n=3,868). Unconditionally, NIFTY closed above its open on 46.7% of days (mean −0.07%).

| gap | n | continued in gap direction | mean open→close [90% CI] | filled by close | closed beyond prev close |
|---|---|---|---|---|---|
| ≤ −1% | 120 | 43% [36–51] | +0.16% [−0.09, 0.41] | 21% [15–28] | 10% |
| −1 to −0.5% | 243 | 51% [45–56] | +0.02% [−0.08, 0.13] | 38% [33–44] | 22% |
| −0.5 to −0.2% | 420 | 56% [52–60] | −0.14% [−0.20, −0.08] | 61% [57–64] | 24% |
| +0.2 to +0.5% | 1,024 | 46% [44–49] | −0.07% [−0.10, −0.03] | 65% [62–67] | 32% |
| +0.5 to +1% | 467 | 52% [48–56] | −0.01% [−0.08, 0.06] | 42% [38–45] | 20% |
| ≥ +1% | 148 | 48% [41–55] | −0.16% [−0.33, 0.02] | 26% [20–32] | 13% |

**CE or PE day, by gap direction** (|gap| ≥ 0.2%):

| sample | days | n | closed above open (CE day) | mean open→close |
|---|---|---|---|---|
| 2 years | gap up | 148 | 50.0% [43.3–56.7] | −0.04% [−0.12, 0.05] |
| 2 years | gap down | 115 | 48.7% [41.1–56.3] | −0.03% [−0.13, 0.08] |
| 2011–26 | gap up | 1,639 | 48.1% [46.1–50.2] | −0.06% [−0.09, −0.02] |
| 2011–26 | gap down | 783 | 47.8% [44.8–50.7] | −0.04% [−0.10, 0.02] |

**Follow or fade?** The rule was picked on the training period and scored on the test period:

| \|gap\| ≥ | train → test | chosen | train hit | test hit |
|---|---|---|---|---|
| 0.2% | 2011–18 → 2019–26 | fade | 51.0% (1,223) | 50.0% [47.7–52.4] (1,199) |
| 0.5% | 2011–18 → 2019–26 | fade | 50.5% (465) | 49.5% [45.9–53.1] (513) |
| 1.0% | 2011–18 → 2019–26 | fade | 57.1% (126) | 51.4% [44.5–58.2] (142) |
| 0.2% | Oct 24–Oct 25 → Oct 25–Oct 26 | fade | 54.0% (126) | 45.3% [38.4–52.3] (137) |

**First hour after the open** (60-minute bars, 31 Oct 2023 – 8 Oct 2026, n=721):

| days | n | first hour up | mean first-hour move | gap filled within first hour | 10:15→15:15 up | mean 10:15→15:15 |
|---|---|---|---|---|---|---|
| gap up ≥ 0.5% | 75 | 41% [32–51] | −0.11% [−0.20, −0.03] | 7% | 57% [48–66] | +0.16% [0.05, 0.28] |
| gap up 0.2–0.5% | 172 | 43% [37–49] | −0.05% [−0.09, −0.01] | 40% | 45% | −0.06% |
| flat | 324 | 50% | −0.01% | — | 49% | −0.01% |
| gap down 0.2–0.5% | 88 | 45% [37–54] | −0.08% [−0.15, −0.01] | 35% | 41% | −0.12% [−0.23, −0.01] |
| gap down ≤ −0.5% | 62 | 65% [54–74] | +0.09% [0.01, 0.17] | 5% | 57% [46–66] | +0.09% [−0.06, 0.24] |

* **Retracement after big gaps (|gap| ≥ 0.5%).** The first hour moved against the gap on 61.3% [54.3–67.9] of days. Split by period:
  * before Aug 2025: 64.9%, mean −0.13% [−0.20, −0.07];
  * from Aug 2025: 56.7% [46.1–66.7], mean −0.07% [−0.18, +0.04].
* **The afternoon continuation after big gap-ups does not hold up.** In the earlier part, 10:15→15:15 rose on 63% of big gap-up days (n=46); in the later part, 48% (n=29).
* **The first hour does not predict the rest of the day.** The first hour's direction matched the 10:15→15:15 direction on 50.3% of days (n=721); 47% in the earlier part and 55% in the later part.

**5-minute detail and the engine's window** (16 Jul – 8 Oct 2026, n=58 sessions; a falling market, so read with care):

| days | n | 09:15→09:30 up | 09:15→10:15 up | mean 09:15→09:25 (before the engine can enter) | 09:25→15:05 up (CE day) | mean 09:25→15:05 | days with a ≥0.5% move after 09:25, up / down |
|---|---|---|---|---|---|---|---|
| gap up ≥ 0.2% | 14 | 29% [14–51] | 36% | −0.10% | 50% [30–70] | −0.07% [−0.27, 0.10] | 1 / 4 |
| flat | 28 | 39% | 32% | −0.05% | 39% [26–55] | −0.12% [−0.24, −0.03] | 1 / 5 |
| gap down ≤ −0.2% | 16 | 44% | 38% | −0.06% | 25% [12–46] | −0.19% [−0.32, −0.05] | 1 / 7 |
| all | 58 | 38% | 34% | −0.07% | 38% [28–49] | −0.13% [−0.21, −0.05] | 3 / 16 |

I also tried to replay the engine's GAP signal (extending vs filling at 09:25 and at 09:45). Only 4–8 qualifying days were available in each branch, so no conclusion is possible.

### (c) Trend indicators

**Definitions.**
* ADX/DMI(14) with Wilder smoothing.
* SMA 20/50/200.
* EMA 9/21: the state (EMA9 above or below EMA21) and fresh crossovers.
* RSI(14).

Indicator states are taken at day *t*'s close; the targets are on day *t*+1. A rule's direction ("follow" = bullish state → up, or "fade") is chosen **on the training period only**.

**Daily states → next-day open→close direction.**
* 2 years: trained 9 Oct 2024 – 17 Oct 2025, tested 20 Oct 2025 – 7 Oct 2026.
* 2011–26: trained 2011–18, tested 2019–26.

| state | 2y rule | 2y test hit | 2011–26 rule | 2011–26 test hit |
|---|---|---|---|---|
| close > SMA20 | follow | 44.1% (238) | fade | 51.6% (1,915) |
| close > SMA50 | follow | 43.3% (238) | fade | 51.2% (1,915) |
| close > SMA200 | fade | 52.1% (238) | fade | 51.9% (1,915) |
| EMA9 > EMA21 | follow | 43.3% (238) | fade | 51.7% (1,915) |
| EMA9/21 fresh cross | fade | 69.2% (13) | follow | 57.0% [47.7–65.7] (79) |
| +DI > −DI | follow | 43.3% (238) | fade | 50.2% (1,915) |
| ADX > 25 with DI direction | follow | 43.1% (58) | fade | 51.3% (727) |
| RSI > 50 | follow | 43.3% (238) | fade | 51.3% (1,915) |
| RSI < 30 (up) vs > 70 (down) | follow (contrarian) | 67.9% [52.3–80.2] (28) | follow (contrarian) | 55.8% [50.7–60.8] (260) |
| all three trend states agree | follow | 40.9% (171) | fade | 51.4% (1,512) |
| baseline: yesterday's open→close | fade | 50.8% (238) | follow | 47.8% (1,915) |
| baseline: always up / always down | — | 46.6% / 53.4% | — | 47.9% / 52.1% |

* **No state beats the "always down" baseline** (NIFTY's intraday drift has been slightly negative: open→close up on only 46.7% of days since 2011, mean −0.07%). The fresh-cross and RSI-extreme rows are small samples whose chosen direction flips between samples (fresh cross) or whose edge is a few hundredths of a percent (RSI).
* **Next-day gap.** Bullish states coincide with more gap-ups (2011–26: close > SMA200 → 66.7% gap-up vs 59.7% below it). Still, no indicator rule beat "always gap-up" out of sample (60.4% vs 65.0%).
* **Hourly versions.** States at the 15:15 close scored 39–58% for the next day's open→close (test n=272; RSI extremes 58% with n=36). States at 10:15 scored 48–51% for 10:15→15:15 (n=272); the small fresh-cross and RSI-extreme subsets scored 45–57%, and none beat "always down" (54%).

**Next-day range (high−low, % of close).** Correlations and OOS R² are fitted on the first period and scored on the second.

| predictor | corr, 2y | OOS R², 2y | corr, 2011–26 | OOS R², 2011–26 |
|---|---|---|---|---|
| India VIX close | 0.45 | **0.31** | 0.57 | **0.41** |
| 20-day average range | 0.39 | 0.21 | 0.48 | 0.28 |
| today's range | 0.28 | 0.10 | 0.46 | 0.25 |
| ADX(14) | 0.33 | 0.17 | 0.17 | 0.02 |
| \|close − SMA50\| % | 0.34 | 0.17 | 0.39 | 0.20 |
| \|RSI − 50\| | 0.16 | 0.04 | 0.06 | 0.00 |
| VIX + 20-day range | — | 0.29 | — | 0.39 |
| VIX + 20-day range + ADX | — | 0.32 | — | 0.39 |

**Next-day range by ADX bucket** (last 2 years):

| ADX | n | next-day range [90% CI] | mean India VIX |
|---|---|---|---|
| < 20 | 206 | 0.82% [0.78, 0.87] | 12.8 |
| 20–25 | 132 | 0.94% | 14.5 |
| 25–35 | 110 | 1.03% | 14.2 |
| > 35 | 46 | 1.30% [1.19, 1.42] | 18.2 |

In 2011–26 the buckets run 1.07 / 1.16 / 1.14 / 1.37% with VIX 16.7 / 17.4 / 17.1 / 19.5. The ADX effect mostly tracks VIX.

**Hourly ADX at 10:15 vs the size of the 10:15–15:15 move:**

| ADX | n | mean move size | share of days moving ≥ 0.5% |
|---|---|---|---|
| < 20 | 147 | 0.40% | 30% |
| 20–25 | 148 | 0.39% | 26% |
| 25–35 | 235 | 0.36% | 25% |
| > 35 | 150 | 0.46% | 33% |

The correlation is 0.03 for ADX and 0.32 for hourly ATR%.

### (d) FII/FPI flows

**Source.**
* NSDL "Daily Trends in FPI Investments" (archive form at `fpi.nsdl.co.in/web/Reports/Archive.aspx`; public, no login; 94 monthly requests). I parsed the Equity / Stock-Exchange net for 1,879 reporting dates (Jan 2019 – 8 Oct 2026). I did not find a publicly downloadable history of NSE's same-evening *provisional* FII/DII figures: NSE's API (`/api/fiidiiTradeReact`) returns only the latest day.
* NSDL's figures are custodian-confirmed. NSDL says a reporting date covers trades "on and up to the previous trading day(s)".
* **Alignment check.** NSDL's figure for date D correlates 0.32 with NIFTY's return on D−1, 0.25 with D−2 and 0.05 with D, so each figure was assigned to the previous trading day.
* **Spot check against known provisional figures.** NSDL shows −₹15,525 cr for 3 Oct 2024 (NSE's provisional figure was about −₹15,243 cr; NIFTY fell 2.1% that day).
* **Why the next-day tests are fair.** The provisional figure for day *t* is published on the evening of day *t*, so testing flow(*t*) against day *t*+1 uses information that was available in time. NSDL's confirmed figure stands in for it.
* **DII history.** NSDL's DII archive starts only around May–June 2026 (the 4 May 2026 request returned "No Data Found"; 1 Jun 2026 returned data), so DII and retail-versus-FII tests were not possible.

**FPI flows by year vs NIFTY:**

| year | FPI net via exchanges (₹ cr) | worst day (₹ cr) | days below −₹5,000 cr | NIFTY change over the year |
|---|---|---|---|---|
| 2019 | +71,737 | −2,866 | 0 | +12.0% |
| 2020 | +100,759 | −6,690 | 2 | +14.9% |
| 2021 | −54,542 | −8,244 | 4 | +24.1% |
| 2022 | −150,250 | −8,956 | 12 | +4.3% |
| 2023 | +132,648 | −6,457 | 3 | +20.0% |
| 2024 | −127,883 | −15,525 | 23 | +8.8% |
| 2025 | −239,429 | −12,010 | 21 | +10.5% |
| 2026 to 7 Oct | −343,421 | −22,102 | 37 | −14.9% |

**Same day vs next day** (flow in ₹1,000 cr of net buying):

| sample | target | n | corr [90% CI] | R² |
|---|---|---|---|---|
| 2019–26 | same-day close-to-close | 1,877 | **0.32 [0.27, 0.36]** | 0.10 |
| 2019–26 | same-day open→close | 1,877 | 0.18 [0.13, 0.23] | 0.03 |
| 2019–26 | next-day gap | 1,877 | 0.07 [0.03, 0.11] | 0.005 |
| 2019–26 | next-day open→close | 1,877 | **0.00 [−0.04, 0.04]** | 0.000 |
| 2019–26 | next-day close-to-close | 1,877 | 0.05 [0.01, 0.09] | 0.002 |
| last 2 years | same-day close-to-close | 482 | **0.36 [0.27, 0.45]** | 0.13 |
| last 2 years | next-day gap | 482 | 0.01 [−0.07, 0.09] | 0.000 |
| last 2 years | next-day open→close | 482 | **−0.02 [−0.11, 0.06]** | 0.001 |

* **Controlling for the same day's return.** The flow coefficient (% per ₹1,000 cr of buying) is 0.018 [0.005, 0.032] for the next gap, 0.007 [−0.006, 0.020] for the next open→close, and 0.024 [0.006, 0.043] for the next close-to-close.
* **Out of sample (train 2019–22, test 2023–26).** "Selling → down" scored:
  * next gap: 52.9% (always-up 60.7%);
  * next open→close: 50.4% (always-down 52.8%);
  * next close-to-close: 55.9% [53.2–58.6] (always-up 52.8%).

  The linear models' OOS R² were all at or below 0 (−0.04 to 0.00).
* **Reading this.** There is a faint overnight tendency, partly because selling comes in streaks (day-to-day correlation of flows 0.45). It does not reach the 09:25–15:05 window.

**After big FPI selling days** (2019–26):

| day t | n | NIFTY that day | next gap [90% CI] | next open→close [90% CI] | next day PE (closed below open) | next close-to-close |
|---|---|---|---|---|---|---|
| all days | 1,877 | +0.04% | +0.10% [0.07, 0.13] | −0.06% [−0.09, −0.03] | 52.0% | +0.04% |
| net sell < −₹5,000 cr | 102 | −0.78% | −0.05% [−0.19, 0.09] | +0.05% [−0.10, 0.19] | **44.1% [36.3–52.3]** | 0.00% [−0.23, 0.23] |
| net sell < −₹10,000 cr | 12 | −1.99% | +0.17% [−0.19, 0.52] | +0.21% [−0.23, 0.68] | 41.7% [22–64] | +0.38% [−0.14, 0.96] |
| flow z-score < −2 (vs prior 60 days) | 79 | −1.12% | **−0.24% [−0.46, −0.02]** | +0.04% [−0.22, 0.30] | 43.0% | −0.20% [−0.57, 0.17] |
| NIFTY < −1% and sell < −₹5,000 cr | 42 | −1.93% | 0.00% | **+0.22% [0.03, 0.41]** | 35.7% [24.8–48.4] | +0.22% [−0.08, 0.51] |
| NIFTY < −1% without big selling | 161 | −1.80% | +0.07% | +0.06% | 49.1% | +0.13% |
| net buy > +₹5,000 cr | 66 | +0.70% | +0.27% [0.19, 0.35] | −0.06% [−0.26, 0.11] | 57.6% | +0.21% |

**Big-sell days by period** (next day PE / mean next open→close):

| period | n | next day PE | mean next open→close [90% CI] |
|---|---|---|---|
| 2019–22 | 18 | 33.3% | +0.04% [−0.51, 0.52] |
| 2023–26 | 84 | 46.4% | +0.05% [−0.08, 0.19] |
| last 2 years | 65 | 44.6% | +0.06% [−0.08, 0.21] |

**Sustained selling.** Overlapping windows, with block-bootstrap CIs:

| flow window → target | period | corr with the next return [90% CI] | corr with the past return |
|---|---|---|---|
| past 5 days → next 5 days | 2019–22 | 0.05 [−0.08, 0.18] | 0.51 |
| past 5 days → next 5 days | 2023–26 | −0.04 [−0.15, 0.06] | 0.51 |
| past 20 days → next 20 days | 2019–22 | 0.01 [−0.15, 0.17] | 0.61 |
| past 20 days → next 20 days | 2023–26 | −0.07 [−0.21, 0.08] | 0.61 |

**Range.** Flows add nothing to India VIX for predicting the next day's range (OOS R² 0.447 for VIX alone vs 0.414 with flows).

---

## 4. Caveats

* **Regime.** The latest test window (Oct 2025 – Oct 2026) was a falling market (NIFTY −14.9% in 2026, record FPI selling). Some rules flip between periods for that reason, which is why each claim is checked on 2011–26 or 2019–26 where possible.
* **Multiple testing.** Section (c) scores about 70 indicator × target combinations. At 90% CIs, around 7 would look "significant" by chance. Only effects that hold in both halves are reported as findings.
* **Index moves are not option profit and loss.** All results are for the index. Option buyers also pay time decay, spreads and IV changes, so small index edges (≤ 0.1%, about 20–25 pts) are unlikely to survive costs.
* **Yahoo data.**
  * NIFTY daily opens before 2011 are unreliable (open ≈ previous close on 50–70% of days), so 2007–10 is excluded.
  * NIFTY 5-minute volume is 0 on Yahoo (not used).
  * SENSEX 5-minute data was not used.
  * 60-minute bars give "as of 08:30 IST" for markets whose bars start on the hour.
  * `USDINR=X` is sparse overnight.
  * Muhurat and special sessions are excluded from the gap model.
* **Flows.** NSDL's custodian-confirmed series differs from NSE's provisional numbers. For example, the owner's ₹12,988 cr vs NSE's ₹12,943.58 cr for 8 Oct, and NSDL itself also includes block deals. The alignment was verified, but the provisional series itself was not available. DII history was too short (NSDL starts around mid-2026) and retail flows were not available.
* **Not tested.** GIFT Nifty (no free history) and the pre-open auction order book (no history). The 5-minute sample (58 days) is too short for engine-window conclusions; the daily and hourly results carry the weight.

## 5. Reproducing

Scripts live in `/tmp/claude-0/-home-user-ruphak-trading-info/ce69818a-a157-5190-9186-5f96c704f981/scratchpad/research/q2/`. Run each as `.venv/bin/python -I scripts/<name>.py`; the venv has numpy, pandas and scipy.

| script | what it does |
|---|---|
| `scripts/fetch_yahoo.py` | Downloads Yahoo chart JSON into `data/yahoo/` (60-minute bars for 730 days, daily since 2007, 5- and 15-minute bars for 60 days) |
| `scripts/fetch_nsdl.py` | Fetches the NSDL FPI archive (`--dii` for the DII archive) into `data/flows/` |
| `scripts/common.py` | Loaders, the no-look-ahead `value_asof`, Wilson and bootstrap CIs, OLS, OOS R² |
| `scripts/explore_quality.py` | Data-quality checks (daily-open quality by year, bar alignment, 60-minute vs 5-minute opens) |
| `scripts/a_gap_prediction.py` | Section (a) → `out/a_gap_prediction.md`, `out/gap_dataset.csv` |
| `scripts/b_gap_behaviour.py` | Section (b) → `out/b_gap_behaviour.md` |
| `scripts/c_trend_indicators.py` | Section (c) → `out/c_trend_indicators.md` (full tables for every state and target) |
| `scripts/d_flows.py` | Section (d) → `out/d_flows.md`, `out/nsdl_fpi_daily.csv` (parsed NSDL series) |
| `scripts/live_today.py` | The 9 Oct 2026 live check → `out/live_today.txt` |

Raw downloads are in `data/yahoo/`, `data/yahoo_live*/`, `data/flows/` (NSE latest FII/DII JSON, NSDL HTML) and `data/nseix/` (the probe showing the token-gated API).
