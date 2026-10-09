# Q1: When are NIFTY/SENSEX option premiums richest, when has buying paid, and does holding to expiry ever win?

Prepared Fri 9 Oct 2026 for the owner's trading plan. Analysis only: no repo files edited, nothing committed, pushed or deployed.

The owner asked two things. First, "when is the premium at its highest, so we can avoid entering?" Second, "which option has the edge to enter now and hold till expiry for the most benefit?"

**About the prices:**

- Most results below use **real option prices** from the NSE and BSE daily files ("bhavcopies"). These are public and need no keys. They cover 684 NSE days and 679 BSE days, from January 2024 to 8 October 2026.
- Results for entries at 10:15 or 11:15 use **model prices**. The model is the repo's Black-Scholes pricer, run on India VIX. Each one is labelled. The repo's model makes weekly options about 10% too expensive (see §3), so I also show a **calibrated model** that uses 0.9× the repo's volatility.

---

## 0. The answers in plain language

### "When is the premium at its highest?"

1. **Inside the day, implied volatility is highest in the first hour and lowest near the close.**
   - On 65% [62, 68] of 678 days (2024–26), India VIX closed below its 10:15 level. The average fall was 0.6%.
   - On 34% [25, 45] of the 58 five-minute sessions, the day's highest VIX close came in the first 30 minutes. If the high were equally likely at any time, that share would be 8%.
   - The first hour is also when the index moves most. It holds 30% of the day's movement (variance) in 16% of the session time, about 1.9× its share.
   - The worst stretch to *hold* a long option is **11:15–14:15**. In those hours the index moves only about 0.7× as much as the time decay you pay for. This held in both halves of the sample and for both indices.
   - Waiting for the morning premium to cool does not help. With the calibrated model, buying at 09:15, 10:15 or 11:15 and selling at 15:15 lost about the same: ₹642, ₹705 and ₹627 per NIFTY lot.
   - Ignore the 09:15 VIX print. It is stale (it is roughly yesterday's close). The real opening level forms around 09:20 and can be 4–5% away from that print.
2. **Across the week, VIX is highest on Monday morning, but that is a quirk of how VIX is calculated.**
   - VIX rises +3.8% on average from Friday's close to Monday 10:15, and rose on 68–74% of Mondays.
   - The cause is that India VIX counts weekends and nights as time passing, while real option prices barely decay over a weekend.
   - Buying an ATM straddle on a Monday was no worse than on other days: −₹1,108 per straddle, against −₹1,104 on average.
3. **Across the expiry cycle, the premium is richest on expiry day and the day before.**
   - Buying ATM at the open and selling at the close (or holding to settlement on expiry day) lost this share of the premium:

     | sessions left to expiry | NIFTY | SENSEX |
     |---|---|---|
     | 0 (expiry day) | 19% | 17.5% |
     | 1 | 10.6% | 10.6% |
     | 2–5 | 4.6% | 7.0% |

   - The order is the same in both halves of the sample.
   - Real expiry-morning options are not expensive by implied volatility (0.84× VIX). The trouble is that the index rarely moves enough in one session to pay for them.
4. **Across market regimes, the premium is richest straight after volatility has jumped.** These patterns held in both halves and for both indices:

   | condition (known before entry) | NIFTY straddle | SENSEX straddle |
   |---|---|---|
   | all days (for comparison) | −₹1,104 | −₹1,582 |
   | India VIX up more than 10% over the last 5 sessions | −₹2,269 | −₹2,427 |
   | VIX in the top third of its past year | −₹1,526 | −₹1,997 |
   | index moved more than 2% over the last 5 days | −₹1,637 | −₹2,152 |

   - A straddle here is one ATM call plus one ATM put, bought at the open and sold at the close (two lots).
   - When VIX is 18 or higher, most of the index's movement happens in overnight gaps, which an intraday buyer cannot capture. On those days, movement during the session was only 0.36× what VIX implied.
5. **Before scheduled events, the premium builds up and then collapses.**
   - Union Budget days (3 of them): VIX rose 3% over the run-up and fell 13% on the day. The index moved only 0.12× what VIX implied. An ATM straddle bought the evening before lost 41–80% (0 of 3 made money).
   - RBI policy days (16) were roughly fairly priced. The straddle lost 2% on average and made money on 7 of 16.
   - The 2024 election result (one event) was the exception: the straddle made +126%.

### "Which option has the edge to enter now and hold till expiry?"

**None.** Every strike, expiry and entry time tested lost money on average over 2024–26.

- Holding to expiry roughly **doubled the loss** compared with selling the same option at that day's close:

  | ATM, 1–5 sessions to expiry, per lot | sell at the close | hold to expiry |
  |---|---|---|
  | NIFTY | −₹547 (−5.5% of premium) | −₹1,153 (−11.6%) |
  | SENSEX | −₹783 (−7.5%) | −₹1,419 (−13.6%) |

- The same holds in both halves for both indices. Holding beat selling on only 32–33% of trades.
- Holding a trade that was already in profit at the close added nothing on average: NIFTY −₹369 [−1,582, +914], SENSEX +₹228 [−1,140, +1,643].
- Holding a trade that was losing at the close made it worse: NIFTY −₹739 [−1,367, −60], SENSEX −₹1,140 [−1,722, −514].
- Out-of-the-money options held to expiry lost the most as a share of premium:

  | held to expiry | share of premium lost | expired worthless |
  |---|---|---|
  | NIFTY 2 strikes OTM | −16% | 62% |
  | NIFTY 2 strikes OTM, bought on expiry day | −30% | 76% |

- The 2-week contract held to expiry was not better: about −9% (NIFTY) and −10% (SENSEX) of premium.
- **Holding to expiry only beats selling the same day if your direction calls are right more than about 54–59% of the time.** The break-even hit rate for buying at all is 56–62%.
- With perfect knowledge of direction, holding to expiry would have paid 2–3× more than selling at the close. For example, NIFTY ATM with 2–3 sessions left: +₹7,360 per lot to expiry against +₹3,130 at the close.
- Two simple direction rules were tested. The 20-day trend rule was right 43–52% of the time, and the opening-gap rule 44–52%. Both lost money.

### Rules for the plan

**When to avoid buying.** Each rule held in both halves; the two exceptions are noted. None of them makes buying profitable; they only cut losses.

- Avoid buying on expiry day (0DTE) or with one session left. The share of premium lost was worst there in both halves. The one exception: in SENSEX's first half, the expiry-day and one-day losses were about equal.
- Avoid buying after VIX has jumped more than 10% in five sessions.
- Avoid buying when VIX is in the top third of its 1-year range. The effect was small in the first half.
- Avoid buying after a 2%-plus 5-day move.
- Avoid buying the evening before a Budget or a similar scheduled event (only 3 cases).
- Do not hold a long option through 11:15–14:15.

**Least-bad choices, if buying at all:**

- ATM or 1 strike in the money.
- 2–5 sessions to expiry.
- Entry in the first hour.
- Sold the same day by 15:15. This lost about 3.5–7.6% of premium per trade.
- The small accounts' cheap OTM band, sold the same day, lost less. Their puts came out about break-even in this sample (see §5.4), but only because of a handful of crash days. Without the best 5–10 trades out of about 640, they lose.

**Hold to expiry:** no, by default. It is only worth considering for a trade that rests on a directional view proven to be right more than 57% of the time. Nothing in this study provides such a view.

**What the losses are made of:**

- Brokerage, charges and the spread are only about ₹106 of NIFTY's ₹547 average loss per lot.
- The rest is time decay that the index's actual movement did not pay back.
- Option sellers are the ones who collect it. Realized NIFTY variance was 0.82× what VIX implied over 2 years [0.71, 0.95], and 0.86× over 10 years.

---

## 1. Data and method

| data | coverage | use |
|---|---|---|
| Yahoo 5-minute bars, NIFTY / SENSEX / India VIX (`scratchpad/why/hist.json`) | 16 Jul – 8 Oct 2026, 58 full sessions | Intraday VIX profile (a) |
| Yahoo hourly bars, same symbols (`research/q1/data/{NSEI,BSESN,INDIAVIX}.json`, copied from `scratchpad/dl/y1h`) | 31 Oct 2023 – 8 Oct 2026, 719 sessions | Hourly VIX profile; intraday movement by hour; model entries at 10:15 and 11:15 |
| Yahoo daily bars (fetched today, 10 years) | Oct 2016 – Oct 2026 | Day-of-week; variance risk premium (c); events. India VIX daily has 5 gaps since 2024, filled from the hourly 15:15 bar (e.g. Saturday 1 Feb 2025). |
| **NSE F&O bhavcopy** (`nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip`) | 1 Jan 2024 – 8 Oct 2026, 684 days; 232k NIFTY option rows within ±7% of spot and 16 days of expiry | Real open, close and settlement prices; actual expiry dates (146 weekly NIFTY expiries, including holiday-shifted ones) |
| **BSE derivative bhavcopy** (`bseindia.com/download/Bhavcopy/Derivative/bhavcopyDD-MM-YY.zip`) | 2 Jan 2024 – 8 Oct 2026, 679 days (5 dates unavailable); 196k SENSEX rows | Same, for SENSEX (146 weekly expiries: Friday in 2024, Tuesday Jan–Aug 2025, Thursday since Sep 2025) |

**How the real trades are priced:**

- **Entry:** buy at the day's first traded price (bhavcopy *open*), plus the repo's spread model: spread = max(1 tick, 0.4% of price), buy at the ask.
- **Strike:** ATM is set from the index's official open, which is known at 09:15. "OTM k" means k strikes further from ATM, in 50-point steps for NIFTY and 100-point steps for SENSEX.
- **Expiry:** the nearest weekly expiry that does not expire today, which is the engine's own rule. Expiry-day (0DTE) purchases are reported separately.
- **Exit at the close:** sell at the bid around the bhavcopy *close*. On NSE that close is computed from roughly the last 30 minutes of trades; on BSE it is the last trade. Using NSE's "last price" instead changes NIFTY ATM from −₹547 to −₹592.
- **Exit at expiry:** cash settlement at intrinsic value, using the official close on expiry day.

**Charges** follow `src/engine/broker/charges.ts`:

- ₹20 per order plus GST.
- STT on sales: 0.1%, rising to 0.15% from 1 Apr 2026.
- Exchange fee, SEBI fee and stamp duty as in that file.
- For options held in the money to expiry: STT on exercise at 0.125% (0.15% from April 2026), plus ₹20 and GST.
- An option that expires worthless has no exit charges.

**Lots** are NIFTY 65 and SENSEX 20 on every date, so rupee figures are comparable across the sample.

**Model trades** use the repo's pricer (`src/engine/pricing/syntheticOptionPricer.ts`):

- Black-Scholes with India VIX × 1.00 for NIFTY and × 1.05 for SENSEX, r = 6.5%.
- A trading-time clock: 375 minutes a day, 252 days a year, with time running only during market hours.
- The same spread model.
- Entries at 09:15 (using the first VIX print), 10:15 and 11:15 from hourly bars. Exit at 15:15, or held to expiry and settled at the real price.

**No look-ahead.** Every condition uses data up to the previous close, plus the 09:15 open where stated. The 20-day average, realized volatility (RV5, RV20) and VIX percentile are all lagged by a day.

**Statistics:**

- 90% bootstrap confidence intervals in [brackets].
- For trades held to expiry, the bootstrap resamples whole **expiry weeks**, because overlapping holds share one settlement. For same-day exits it resamples days.
- Rates come with 90% Wilson intervals.
- Each sample is split at its midpoint (about May 2025) into H1 and H2.

---

## 2. (a) Intraday India VIX: when is implied volatility highest during the day?

### 2.1 Five-minute VIX, 16 Jul – 8 Oct 2026 (58 sessions; NIFTY fell 8% over this period)

**The 09:15 print is stale.** It is close to the previous close: the move from the previous close to that print averaged +0.29%, with 80% of days between −0.32% and +0.92%. The real opening level forms by 09:20, where the move from the previous close ranged from −3.6% to +5.1% (10th to 90th percentile).

**VIX at each time of day, relative to its 09:20 level:**

| IST | mean % vs 09:20 [90% CI] | median | days below the 09:20 level |
|---|---|---|---|
| 09:30 | +0.55 [0.25, 0.84] | +0.22 | 36% |
| 10:00 | +0.57 [0.19, 0.97] | +0.46 | 38% |
| 11:00 | +0.43 [−0.06, 0.92] | +0.19 | 48% |
| 12:30 | +0.43 [−0.16, 1.03] | −0.01 | 50% |
| 14:00 | +1.00 [0.17, 1.87] | +0.48 | 41% |
| 15:00 | +0.44 [−0.37, 1.27] | −0.19 | 52% |
| 15:30 close | −0.08 [−0.92, 0.75] | −0.51 | 53% |

**Where the day's VIX extreme fell (5-minute closes):**

| window | day's VIX high | day's VIX low | share if equally likely |
|---|---|---|---|
| 09:15–09:45 | **34% [25, 45]** | 36% [27, 47] | 8% |
| 09:45–11:00 | 12% | 5% | 20% |
| 11:00–13:00 | 17% | 12% | 32% |
| 13:00–14:30 | 22% | 9% | 24% |
| 14:30–15:30 | 14% | **38% [28, 49]** | 16% |

Measured with 5-minute bar *highs* instead of closes, 52% of highs fall in the first 30 minutes. That figure is inflated: when VIX gaps down, the stale 09:15 print becomes the day's high. The extremes cluster at the two ends of the day.

The day's VIX change from 09:20 to the close had a median of −0.51%, with 10% of days below −4.45% and 10% above +4.59%. VIX fell on 54% of days. In this falling-market sample the average was flat (−0.08%).

By weekday the samples are tiny (10–13 days each). VIX fell intraday on 75% of Tuesdays (NIFTY expiry) and 80% of Fridays, and rose on Thursdays (+2.6%). The 3-year hourly data does not support a Thursday rise (see §2.2).

### 2.2 Hourly VIX, Oct 2023 – Oct 2026 (719 sessions; patterns by day type use Jan 2024 – Oct 2026)

**VIX at each hour, relative to its 10:15 level:**

| time | mean % vs 10:15 [90% CI] | median | days below the 10:15 level |
|---|---|---|---|
| 09:15 first print (stale) | −0.53 [−0.82, −0.25] | −0.45 | 57% |
| 11:15 | −0.10 [−0.21, 0.02] | −0.24 | 57% |
| 13:15 | −0.09 [−0.23, 0.07] | −0.39 | 58% |
| 14:15 | −0.14 [−0.31, 0.04] | −0.57 | 61% |
| 15:15 | −0.56 [−0.75, −0.36] | −0.96 | 65% |
| 15:30 close | **−0.65 [−0.85, −0.44]** | −0.99 | **65% [62, 68]** |

- **Which hourly reading was the day's highest** (10:15 to the close, excluding the stale first print): 10:15 on 35% [33, 38] of days, against 14% if equally likely.
- **Which reading was the day's lowest:** the close on 29% and 15:15 on 19% of days.
- **Overnight:** VIX rose from the previous close to the next day's 10:15 by +0.81% on average [0.51, 1.11]. The rise was **+3.8% on Mondays** [2.9, 4.8], +0.7% on Fridays, and about 0 on Tuesday to Thursday.

**Intraday change from 10:15 to the close, by type of day** (H1 / H2 is the average in each half of the sample):

| day type | change from 10:15 to close [90% CI] | VIX fell | H1 / H2 |
|---|---|---|---|
| NIFTY expiry day | −1.31% [−1.79, −0.81] | 73% | −1.14 / −1.49 |
| SENSEX expiry day | −0.61% [−1.03, −0.17] | 67% | −0.58 / −0.65 |
| day before NIFTY expiry | −0.58% [−0.94, −0.21] | 63% | −0.46 / −0.70 |
| Monday | −0.44% [−0.87, 0.01] | 60% | +0.04 / −0.90 |
| Friday | −0.23% [−0.66, 0.22] | 61% | −0.47 / +0.01 |
| all | −0.63% [−0.84, −0.42] | 65% | −0.59 / −0.67 |

### 2.3 How much the index moves in each hour, against the time decay paid for that hour

Under the repo's trading-time clock, an option holder pays the same time decay for every minute of the session. The index does not move evenly through the day, so some hours give more movement per rupee of decay than others.

**NIFTY hourly bars (719 sessions).** "Value" is the share of the day's movement (variance) in that hour divided by the hour's share of session time. Above 1, the hour moves more than the decay it costs.

| hour | share of day's movement [90% CI] | value | H1 / H2 |
|---|---|---|---|
| 09:15–10:15 | 30.2% [26.7, 34.3] | **1.89** | 1.64 / 2.23 |
| 10:15–11:15 | 17.1% | 1.07 | 1.35 / 0.70 |
| 11:15–12:15 | 11.8% | **0.74** | 0.86 / 0.57 |
| 12:15–13:15 | 11.6% | **0.72** | 0.73 / 0.71 |
| 13:15–14:15 | 11.3% | **0.70** | 0.65 / 0.77 |
| 14:15–15:15 | 15.0% | 0.94 | 0.89 / 1.00 |

SENSEX looks the same: 2.06 in the first hour and 0.70–0.73 at midday. On the 5-minute data, the first 15 minutes alone carry 18% of the day's movement.

**One-hour holds of an ATM option (1–5 sessions to expiry), calibrated model, P&L per lot after costs:**

| hour held | NIFTY | SENSEX |
|---|---|---|
| 09:15–10:15 | −₹60 (see note) | −₹34 |
| 10:15–11:15 | −₹207 | −₹221 |
| each hour from 11:15 to 15:15 | −₹244 to −₹261 | −₹255 to −₹274 |

The 09:15–10:15 figure is flattered by the stale first VIX print, by roughly ₹70.

**What this means:**

- Measured by VIX, options are "richest" in the first hour.
- The first hour is also when the index moves most. Per hour held, it is the least-bad time to own an option.
- Midday holds are the worst value: about ₹250 per ATM lot per hour, or roughly 2.5% of the premium.
- Comparing real weekly options at the open and at the close of the same day, their implied volatility is *lower* at the open: −0.50 volatility points [−0.66, −0.34] for NIFTY and −0.07 [−0.24, 0.10] for SENSEX. Real premiums are not over-inflated at the open; the price at the close also covers the overnight gap.

---

## 3. (b) Daily VIX: day of week, days to expiry, real weekly premiums, events

**Day of week (close-to-close VIX change):**

| weekday | 2 years: mean [90% CI] | VIX rose | 10 years: mean | VIX rose |
|---|---|---|---|---|
| Mon | **+2.95% [1.68, 4.48]** | 68% | **+3.19%** | 74% |
| Tue | −1.51% [−2.26, −0.79] | 34% | −0.66% | 42% |
| Wed | −0.79% | 32% | −0.36% | 43% |
| Thu | −0.17% | 42% | −1.07% | 32% |
| Fri | +0.38% | 50% | −0.33% | 40% |

Most of the Monday jump is the weekend counted in VIX's calendar-time maths. VIX falls most on the main weekly-expiry weekday. Over 10 years that is Thursday, NIFTY's old expiry day. Over the last 2 years it is Tuesday, which was SENSEX's expiry from January to August 2025 and has been NIFTY's since September 2025.

**Sessions to the NIFTY weekly expiry:**

- On expiry day VIX changed −0.95% [−1.64, −0.28] and rose on only 36% of days. This held in both halves (−0.99 / −0.92).
- No other day of the expiry cycle showed a pattern that held in both halves.

**Real weekly ATM straddle against the repo model** (2024–26, about 140 days per row). A straddle is one ATM call plus one ATM put. "Trading-time IV / VIX" is the real option's implied volatility, measured on the repo's clock (session minutes only) and divided by VIX; 1.0 would mean the repo prices it correctly.

| snapshot | sessions left | NIFTY trading-time IV / VIX (median) | NIFTY real vs model price | SENSEX trading-time IV / (VIX × 1.05) | SENSEX real vs model price |
|---|---|---|---|---|---|
| open (first trade) | 0 (expiry day) | 0.84 | −12.2% [−15.6, −8.5] | 0.85 | −11.5% |
| open | 1 | 0.86 | −12.4% | 0.87 | −8.9% |
| open | 3 | 0.90 | −9.4% | 0.89 | −9.8% |
| close | 1 | 0.91 | −5.9% [−8.5, −3.2] | 0.89 | −8.3% |
| close | 3 | 0.91 | −7.5% | 0.89 | −10.3% |
| close | 5 | 0.89 | −9.6% | 0.86 | −13.0% |

**Calibration finding (for the engine owner; no repo change made):**

- Real weekly ATM options trade at an implied volatility of about **0.88–0.91 × VIX for NIFTY** and **0.92–0.93 × VIX for SENSEX**, measured on the repo's trading-time clock.
- The repo's multipliers are 1.00 for NIFTY and 1.05 for SENSEX, so the model overprices weekly options by 10–12%.
- Matched trade by trade at 09:15, model premiums were 1.10× (NIFTY) and 1.11× (SENSEX) the real ones.
- As a result, model-based backtests overstate what buyers lose: for NIFTY held to expiry, −₹2,041 per lot in the model against −₹1,064 in real prices.

**Scheduled events** (dates checked against the RBI's MPC schedule press releases for 2024-25, 2025-26 and 2026-27, and news of each decision):

| event | n | VIX from 5 days before to the day before | VIX on the day | VIX the next day | NIFTY's move / VIX-implied move | ATM straddle from the evening before to the day's close |
|---|---|---|---|---|---|---|
| RBI policy | 16 | +2.1% | −2.2% [−4.7, −0.2] | +0.2% | 0.70 | −1.8% [−13.1, +9.6] (7 of 16 made money) |
| Union Budget | 3 | +3.4% | −13.4% | −1.6% | 0.12 | **−55.6%** (0 of 3; −80%, −46%, −41%) |
| Election results, 4 Jun 2024 | 1 | −13.5% | +27.7% | −29.4% | 4.63 | +125.6% |

- RBI dates: 8 Feb, 5 Apr, 7 Jun, 8 Aug, 9 Oct, 6 Dec 2024; 7 Feb, 9 Apr, 6 Jun, 6 Aug, 1 Oct, 5 Dec 2025; 6 Feb, 8 Apr, 5 Jun, 5 Aug 2026.
- 7 Oct 2026 is excluded because it is too recent.
- The Sunday 1 Feb 2026 Budget session is missing from the Yahoo data.

---

## 4. (c) Variance risk premium: is VIX more or less than what the index actually does?

The implied 1-day move for day t is VIX at the previous close ÷ √252, as a percentage of spot (× 1.05 for SENSEX). Ratios below 1 mean options priced at VIX were expensive compared with what followed.

**NIFTY, 8 Oct 2024 – 8 Oct 2026, 496 days:**

- Realized close-to-close variance was 0.82× the implied [0.71, 0.95]: H1 0.78, H2 0.86. Over 10 years it was 0.86× [0.74, 1.00]. For SENSEX it was 0.75× [0.65, 0.86].
- The day's move was bigger than the implied 1-day move on **23% [20, 27]** of days. If VIX were a fair, normally distributed forecast, that share would be 32%.
- **Open-to-close variance was only 0.49× the implied 1-day variance** [0.43, 0.56], and overnight gaps carried 55% of the daily variance (42% over 10 years). Someone who buys at the open and sells at the close pays for the whole day's implied move but only gets the session's half of it.

**By condition known the evening before (NIFTY, 2 years):**

| condition | n days | realized / implied variance, close-to-close | open-to-close variance / implied | days with a move bigger than implied |
|---|---|---|---|---|
| VIX < 11 | 59 | 0.70 [0.51, 0.93] | 0.49 | 22% |
| VIX 11–13 | 148 | **0.65** [0.52, 0.81] | 0.49 | 18% |
| VIX 13–15 | 147 | 0.86 [0.67, 1.09] | **0.65** | 27% |
| VIX 15–18 | 80 | 0.64 [0.49, 0.82] | 0.44 | 24% |
| VIX ≥ 18 | 62 | **1.09** [0.77, 1.45] | **0.36** | 27% |
| VIX in bottom third of its year | 182 | 0.65 | 0.47 | 19% |
| VIX in top third of its year | 171 | 0.91 | 0.43 | 27% |
| RV5/VIX ≥ 1.1 (last 5 days moved more than implied) | 65 | 1.05 [0.76, 1.35] | 0.48 | 32% |
| RV5/VIX 0.5–0.8 | 205 | 0.66 | 0.46 | 20% |
| Monday (includes the weekend gap) | 100 | 1.11 [0.77, 1.45] | 0.52 | 29% |
| Wednesday | 99 | 0.69 | **0.29** | 17% |

**When options are cheap or expensive:**

- No bucket has a ratio reliably above 1.
- The nearest to fair, for someone holding overnight, are high VIX (18 or more), the week after a burst of realized movement, and Mondays.
- Exactly those regimes are the *worst* for intraday holders, because their movement comes as overnight gaps (open-to-close variance 0.36× implied when VIX ≥ 18).
- Quiet regimes are consistently expensive: VIX 11–13, the bottom third of its year, and RV5/VIX of 0.5–0.8 all sit around 0.65.
- **Whether a big day is coming cannot be told in advance.** After a day that moved more than implied, the next day beat its implied move on 22% [16, 29] of occasions. After "RV20/VIX ≥ 1" it was 20%, against 23% unconditionally.
- Over 10 years, "RV5/VIX ≥ 1.0" gives 1.21× [0.86, 1.66]. That is driven by fat tails, not frequency: only 25% of those days beat the implied move.

---

## 5. (d) Long-option results by strike and days to expiry

### 5.1 Real prices, buy at the open. All P&L is per lot (NIFTY 65, SENSEX 20), with CE and PE pooled (a coin-flip direction)

**NIFTY:**

| slice | n | premium / lot | sell at close: mean [90% CI] | % of premium | profitable | hold to expiry: mean [90% CI] | % of premium | profitable | worthless |
|---|---|---|---|---|---|---|---|---|---|
| ATM, 0DTE (bought on expiry morning) | 290 | ₹4,949 | −951 [−1,411, −465] | −19.2% | 29% | (same) | | | 50% |
| ATM, 1 session left | 290 | ₹7,072 | −751 [−997, −476] | −10.6% | 36% | −1,135 [−1,749, −452] | −16.0% | 33% | 50% |
| ATM, 2 left | 290 | ₹8,816 | −322 [−748, 163] | −3.7% | 36% | −1,002 [−1,813, −146] | −11.4% | 33% | 50% |
| ATM, 3 left | 292 | ₹10,215 | −556 [−803, −288] | −5.4% | 37% | −1,165 [−2,232, −55] | −11.4% | 31% | 50% |
| ATM, 4 left | 284 | ₹11,647 | −406 [−721, −85] | −3.5% | 40% | −559 [−1,608, 584] | −4.8% | 35% | 50% |
| ATM, 5 left | 210 | ₹12,625 | −754 [−1,035, −473] | −6.0% | 38% | −2,177 [−3,462, −888] | −17.2% | 30% | 50% |
| 1 ITM, 1–5 left | 1,366 | ₹11,575 | −486 [−629, −338] | −4.2% | 40% | −1,089 [−1,823, −310] | −9.4% | 35% | 43% |
| ATM, 1–5 left | 1,366 | ₹9,919 | −547 [−697, −392] | −5.5% | 37% | −1,153 [−1,898, −377] | −11.6% | 33% | 50% |
| 1 OTM, 1–5 left | 1,366 | ₹8,476 | −608 [−746, −472] | −7.2% | 36% | −1,230 [−1,971, −461] | −14.5% | 30% | 57% |
| 2 OTM, 1–5 left | 1,366 | ₹7,050 | −484 [−621, −346] | −6.9% | 35% | −1,126 [−1,834, −385] | −16.0% | 26% | 62% |
| 1 OTM, 0DTE | 290 | ₹3,560 | −949 [−1,378, −516] | −26.7% | 23% | | | | 63% |
| 2 OTM, 0DTE | 290 | ₹2,336 | −696 [−1,067, −312] | −29.8% | 18% | | | | 76% |
| ATM CE only, 1–5 left | 683 | ₹10,538 | −830 | −7.9% | 37% | −2,260 | −21.4% | 29% | 53% |
| ATM PE only, 1–5 left | 683 | ₹9,301 | −264 [−642, 139] | −2.8% | 38% | −46 [−1,608, 1,629] | −0.5% | 36% | 47% |

- For a pooled ATM call and put, "worthless = 50%" holds by construction. Look at the OTM rows or at each side separately.
- For 0DTE, selling at the close and holding to settlement are the same trade.

**SENSEX:**

| slice | n | premium / lot | sell at close | % of premium | hold to expiry | % of premium | worthless |
|---|---|---|---|---|---|---|---|
| ATM, 0DTE | 286 | ₹5,246 | −921 [−1,438, −358] | −17.5% | (same) | | 50% |
| ATM, 1 left | 286 | ₹7,592 | −802 | −10.6% | −1,278 | −16.8% | 50% |
| ATM, 1–5 left | 1,347 | ₹10,396 | −783 [−923, −646] | −7.5% | −1,419 [−2,138, −695] | −13.6% | 50% |
| 1 ITM, 1–5 left | 1,347 | ₹11,417 | −783 | −6.9% | −1,406 | −12.3% | 47% |
| 2 OTM, 1–5 left | 1,347 | ₹8,494 | −711 | −8.4% | −1,371 | −16.1% | 57% |
| 2 OTM, 0DTE | 286 | ₹3,529 | −903 | −25.6% | | | 66% |
| ATM CE only, 1–5 left | 674 | ₹10,942 | −971 | −8.9% | −2,311 | −21.1% | 51% |
| ATM PE only, 1–5 left | 673 | ₹9,848 | −595 [−973, −203] | −6.0% | −526 [−2,207, 1,331] | −5.3% | 49% |

**Calls against puts:**

- **Puts did far better than calls only because of the path the market took.**
  - Bought at the open, NIFTY closed above its open on only 46.8% of days. The average open-to-close return was −3.9 basis points a day, against +4.2 overnight.
  - NIFTY rose to 24,610 by May 2025, then fell to 22,232.
  - Held to expiry, NIFTY ATM puts lost 7.3% in H1 and made 6.7% in H2. SENSEX puts lost 14.0% in H1 and made 5.0% in H2. Calls lost in both halves: NIFTY −6.7% and −35.7%.
- This is not a stable edge.

**Where the loss comes from** (ATM, 1–5 sessions left, per lot):

| | NIFTY, sell at close | NIFTY, hold to expiry | SENSEX, sell at close | SENSEX, hold to expiry |
|---|---|---|---|---|
| loss at traded prices, before costs | −446 | −1,081 | −682 | −1,347 |
| spread (repo model) | −40 | −20 | −41 | −21 |
| charges | −66 | −51 | −66 | −52 |
| net | −553 | −1,153 | −788 | −1,419 |

The ₹553 net here is the ₹547 from the tables above, computed on the slightly smaller set of trades that have a closing price.

**2-week contract** (second-nearest weekly, about 6–10 sessions left), ATM:

| | sell at close | hold to expiry |
|---|---|---|
| NIFTY | −₹516 (−3.3%) | −₹1,401 (−9.1%) |
| SENSEX | −₹709 (−4.7%) | −₹1,505 (−9.9%) |

### 5.2 Entry time (model prices, ATM, 1–5 sessions left, exit at 15:15)

| entry | NIFTY, repo model | NIFTY, calibrated model | SENSEX, repo model | SENSEX, calibrated model |
|---|---|---|---|---|
| 09:15 (stale VIX) | −₹883 [−995, −760] | −₹642 [−758, −515] | −₹946 | −₹694 |
| 10:15 | −₹908 [−988, −820] | −₹705 [−791, −612] | −₹1,003 | −₹795 |
| 11:15 | −₹790 [−852, −730] | −₹627 [−692, −563] | −₹862 | −₹693 |

- Held to expiry with the calibrated model: −₹1,044 to −₹1,181 per lot (NIFTY) and −₹1,370 to −₹1,441 (SENSEX), whatever the entry time. With the repo model: −₹2,082 to −₹2,241 (NIFTY) and −₹2,464 to −₹2,562 (SENSEX).
- For 0DTE with the calibrated model: −₹978 (09:15), −₹1,310 (10:15), −₹1,015 (11:15) for NIFTY.
- **Entry time does not create an edge.** It only changes how many hours of time decay you pay.
- All rows, including OTM strikes and 0DTE, are in `out/d_grid.md`.

### 5.3 How accurate does the direction call have to be? (real prices, one ATM option a day)

Expected P&L per lot at a given hit rate p, assuming the hit rate is unrelated to the size of the move. "Break-even" is the hit rate where the trade stops losing. "Hold beats sell above" is the hit rate above which holding to expiry earns more than selling at the close.

| index, sessions left | exit | p = 50% | 55% | 60% | 65% | break-even | hold beats sell above |
|---|---|---|---|---|---|---|---|
| NIFTY, 1 | close | −751 | −414 | −77 | +259 | 61% | |
| NIFTY, 1 | expiry | −1,135 | −517 | +100 | +718 | 59% | 57% |
| NIFTY, 2–3 | close | −440 | −79 | +281 | +641 | 56% | |
| NIFTY, 2–3 | expiry | −1,084 | −239 | +605 | +1,449 | 56% | 57% |
| NIFTY, 4–5 | close | −554 | −184 | +186 | +556 | 57% | |
| NIFTY, 4–5 | expiry | −1,246 | −160 | +926 | +2,012 | 56% | 55% |
| SENSEX, 2–3 | close | −747 | −398 | −50 | +298 | 61% | |
| SENSEX, 2–3 | expiry | −1,406 | −542 | +322 | +1,187 | 58% | 56% |
| SENSEX, 4–5 | expiry | −1,494 | −395 | +704 | +1,804 | 57% | 54% |

**Benchmarks (ATM):**

- **Perfect direction knowledge** (call on up days, put on down days), sell at the close: NIFTY +₹2,616 to +₹3,163 per lot; SENSEX +₹2,476 to +₹2,738.
- **Perfect direction knowledge, held to expiry:** NIFTY +₹5,040 (1 session left) to +₹9,613 (4–5 left); SENSEX +₹4,871 to +₹9,498.
- **20-day trend rule:** right 43–52% of the time. P&L −₹3 to −₹2,756.
- **Opening-gap rule:** right 44–52%. P&L between −₹1,764 and +₹389 (mostly negative).
- No rule tested reaches the 56–62% break-even.

### 5.4 Hold to expiry against selling at the close: same trades, real prices, 1–5 sessions left

| index | trades | extra P&L from holding [90% CI, by expiry week] | holding beat selling | average if sold | average if held |
|---|---|---|---|---|---|
| NIFTY ATM, all | 1,360 | −601 [−1,331, +155] | 32% [30, 34] | −552 | −1,153 |
| NIFTY ATM, in profit at the close | 506 | −369 [−1,582, +914] | 42% | +4,732 | +4,363 |
| NIFTY ATM, losing at the close | 854 | **−739 [−1,367, −60]** | 26% | −3,683 | −4,421 |
| SENSEX ATM, all | 1,339 | −626 [−1,308, +83] | 33% | −793 | −1,419 |
| SENSEX ATM, in profit at the close | 503 | +228 [−1,140, +1,643] | 42% | +4,533 | +4,761 |
| SENSEX ATM, losing at the close | 836 | **−1,140 [−1,722, −514]** | 27% | −3,997 | −5,137 |

By half, selling at the close against holding: NIFTY H1 −442 against −698, H2 −652 against −1,611. SENSEX H1 −835 against −1,138, H2 −732 against −1,702.

**The small accounts' premium band** (`src/engine/accounts.ts`): the strike nearest the money whose opening premium is ₹40–70 for NIFTY or ₹130–222 for SENSEX. That is typically 4 strikes out for NIFTY and 7 for SENSEX, at about ₹4,000 a lot.

| | NIFTY (1,299 trades) | SENSEX (1,277 trades) |
|---|---|---|
| sell at close, mean [90% CI] | −₹173 [−271, −79] (−4.3%) | −₹6 [−121, +121] (−0.2%) |
| hold to expiry, mean | −₹308 (−7.7%) | −₹425 (−10.7%) |
| expired worthless | 72% | 72% |
| paid 5× or more at expiry | 7% | 6% |
| calls only, sell at close | −₹356 | −₹240 |
| puts only, sell at close | +₹15 [−195, 233] | +₹230 [4, 479] (H1 +197 / H2 +263) |

- The median put trade lost: −₹938 for NIFTY and −₹707 for SENSEX.
- The positive average rests on a few crash days. SENSEX's best trade (+₹49k on 4 Jun 2024) is one of them. Without the best 5 trades of about 640, the SENSEX average falls to +₹34; without the best 10, it is −₹69.
- These are lottery tickets that the 2024–26 path happened to pay out, not a repeatable edge.
- Choosing the strike from its opening print may also make entries look cheaper than a live quote would have been.

---

## 6. (e) When did buying options pay?

The test: buy one ATM call and one ATM put (2 lots) at the open, with 1–5 sessions to expiry. All prices are real. H1 / H2 are the averages in each half of the sample.

| condition | known before entry? | NIFTY n | NIFTY, sell at close [90% CI] | NIFTY H1 / H2 | SENSEX, sell at close | SENSEX H1 / H2 |
|---|---|---|---|---|---|---|
| all days | – | 680 | −1,104 [−1,396, −792] | −878 / −1,330 | −1,582 | −1,668 / −1,497 |
| VIX < 12 | yes | 159 | −929 | −1,402 / −880 | −1,289 | −2,473 / −1,161 |
| VIX ≥ 18 | yes | 82 | −2,053 [−3,530, −150] | −698 / −3,114 | −2,414 | −2,100 / −2,660 |
| VIX in top third of its year | yes | 283 | −1,526 | −1,027 / −2,512 | −1,997 | −1,899 / −2,193 |
| VIX up more than 10% in 5 days | yes | 109 | **−2,269 [−3,044, −1,482]** | −2,466 / −2,010 | **−2,427** | −2,497 / −2,333 |
| moved more than 2% in 5 days | yes | 173 | −1,637 | −1,661 / −1,602 | −2,152 | −2,136 / −2,174 |
| RV5/VIX ≥ 1.0 | yes | 150 | −838 [−1,696, 199] | −442 / −1,448 | −1,693 | −1,450 / −2,062 |
| RV20/VIX ≥ 1.0 | yes | 148 | −1,496 | −1,482 / −1,517 | −2,255 | −2,728 / −1,667 |
| gap at the open > 1% | at 09:15 | 37 | −1,059 [−3,064, 818] | −1,181 / −965 | −1,628 | −1,683 / −1,584 |
| Friday | yes | 133 | −651 [−1,167, −125] | −928 / −377 | −1,297 | −1,704 / −896 |
| 1 session left | yes | 145 | −1,501 | −1,493 / −1,509 | −1,605 | −1,564 / −1,645 |
| RBI policy day | yes | 16 | −3 [−1,606, 1,615] | −866 / +859 | −908 (n = 17) | −2,169 / +213 |
| **Trend day: index moved open-to-close more than the VIX-implied 1-day move** | **no, only afterwards** | 106 | **+4,739 [3,554, 5,962]**, 87% made money | +5,738 / +3,384 | +3,916 | +4,028 / +3,742 |
| not a trend day | only afterwards | 574 | −2,183 | | −2,571 | |

**Held to expiry, in rupees:**

| | NIFTY | SENSEX |
|---|---|---|
| all days | −2,306 | −2,821 |
| VIX in bottom third of its year | +377 (H1 +7,039, H2 −1,104) | +580 (H1 +10,119, H2 −1,546) |
| VIX ≥ 18 | −5,992 | −6,855 |

The bottom-third result does not hold across halves, so it is not a rule.

**Can a trend day be spotted at the open?** Trend days are 16% of NIFTY days and 15% of SENSEX days. Information available at the open barely shifts those odds:

| known at the open | P(trend day), NIFTY |
|---|---|
| gap > 1% | 24% [15, 37] (n = 37) |
| VIX ≥ 18 | 7% |
| VIX < 12 | 16% |
| RV5/VIX ≥ 1 | 16% |
| previous day's move bigger than implied | 15% |
| Monday | 14% |

SENSEX is similar: gap > 1% gives 21%, VIX ≥ 18 gives 10%.

**Expiry-day straddles (0DTE, held to settlement):**

- NIFTY −₹1,901 [−2,821, −929]; SENSEX −₹1,841.
- With VIX ≥ 18: −₹6,288 (NIFTY) and −₹5,387 (SENSEX).
- The only positive bucket was NIFTY "RV5/VIX < 0.6": +₹672 [−989, +2,564], H1 +655 / H2 +692. It failed on SENSEX (H1 +842, H2 −3,099), so it is not a rule.

**Conclusion for (e):**

- Long options paid on trend days and on days that beat the implied move. Those are only knowable afterwards.
- No information available before entry made the long straddle profitable on average.
- The conditions that reliably made it worse are the ones in the "avoid buying" list in §0.

---

## 7. Caveats

- **Real prices are end-of-day only.**
  - The entry price is the day's first trade, which can be away from the market at 09:15. The exit is NSE's computed close (BSE: the last trade).
  - There are no real prices for entries during the day or exits before the close. Those are model prices, calibrated to real premiums at the open and close (0.9× the repo's volatility).
  - Spreads use the repo's assumption of 0.4% of premium. Real NIFTY ATM spreads are tighter; far-OTM SENSEX spreads are wider.
- **India VIX is a substitute for weekly-option volatility.** It is a 30-calendar-day index built on NIFTY's *monthly* options. SENSEX uses the same VIX. Its overnight and weekend jumps are partly an artifact of counting calendar time.
- **Sample, Jan 2024 – Oct 2026 (about 145 weekly expiries per index):**
  - It spans several rule changes: SEBI's November 2024 F&O rules (one weekly expiry per exchange, larger lots), NIFTY's expiry moving from Thursday to Tuesday (September 2025), SENSEX moving from Friday to Tuesday (January 2025) and then to Thursday (September 2025), and the STT increase (April 2026).
  - The index finished near where it started, with deep falls in H2, which drives the call/put asymmetry.
  - Lots are fixed at today's 65 and 20. Historical lots differed (NIFTY 50/25/75, SENSEX 10/20), which only changes how much the flat ₹20 brokerage weighs.
- **Multiple comparisons.** About 25 conditions were tested for each of 2 indices, so a few 90% intervals that exclude zero are expected by chance. Only effects that hold in both halves and on both indices are recommended. The event studies are small: 16 RBI days, 3 Budgets, 1 election.
- **Small or noisy samples:**
  - The 5-minute VIX sample is 58 sessions in one downtrend.
  - Since 3 August 2026, NSE's closing auction makes Yahoo's last 15 minutes of index bars unreliable. SENSEX's 15:15–15:30 hourly bar is also suspect (it shows only 1% of the day's movement).
- **Expiry charges are assumptions.** Exercise STT of 0.125% (0.15% from April 2026) and ₹20 brokerage plus GST on exercise are assumed. The effect is small.

---

## 8. Files

All files are under `/tmp/claude-0/-home-user-ruphak-trading-info/ce69818a-a157-5190-9186-5f96c704f981/scratchpad/research/q1/`.

**Scripts** (`scripts/`; run with `python3 -I`):

| step | file | what it does |
|---|---|---|
| 1 | `dl_nse.sh`, `dl_bse.sh` | Download the bhavcopies |
| 2 | `build_opts.py` | Extract NIFTY and SENSEX option rows into `data/nifty_opts.csv` and `data/sensex_opts.csv` |
| 3 | `panel.py` | Build the daily panels (lagged features, real expiries and sessions to expiry) and the real-option panels |
| 4 | `d_trades.py` | Build trade-level P&L: real, repo model, and calibrated model |
| – | `common.py` | Shared code: loaders, Black-Scholes, the repo's spread and charges, bootstrap and Wilson intervals |

**Analysis scripts:**

| section | file |
|---|---|
| (a) | `a_intraday_vix.py`, `a2_intraday_rv.py`, `a3_hour_holds.py` |
| (b) | `b_daily_vix.py` |
| (c) | `c_vrp.py` |
| (d) | `d_report.py`, `d2_band.py` |
| (e) | `e_conditions.py` |

**Full output tables** (`out/`):

- `a_intraday_vix.md`
- `a2_intraday_rv.md`
- `a3_hour_holds.md`
- `b_daily_vix.md`
- `c_vrp.md`
- `d_grid.md` (also includes direction benchmarks with the repo and calibrated models, OTM rows, and entry-time-by-strike tables)
- `d2_band.md`
- `e_conditions.md`

**Data:**

- `dl_nse/`: 684 NSE F&O bhavcopies, 806 MB.
- `dl_bse/`: 679 BSE derivative bhavcopies, 17 MB.
- `data/`: Yahoo bars, extracts, panels and trade pickles.

These are the real exchange EOD option prices the parent plan's WP6 needs. They are worth keeping, or archiving the extracts and deleting the zips.
