# WP11: option strategies on real 1-minute option prices

Sat 10 Oct 2026. Branch `worktree-agent-a939f8479e0f2a4de`, reset to `a6ee805` (head of `claude/gifted-wright-3d8r3j`). Analysis only: no paper trading, no deploys, no pushes; nothing in the engine changes.

**Data and licence.** Every option and index price in this study comes from the Hugging Face dataset **"India Index & Options – 1-minute OHLC" by TradeMarkk** (`thetrademarkk/india-index-options-1m`, revision `0f4800e43e6f96cec0794369d78eb4d3c4211ef5`, https://huggingface.co/datasets/thetrademarkk/india-index-options-1m), licensed **CC-BY-NC-4.0**: non-commercial research use only, attributed here. The dataset describes itself as "educational use only, provided as-is, verify against official exchange data before relying on it"; §2 does that. No raw or extracted data is committed (the repository is public); the scripts rebuild everything from a download.

**Status of this file:** §1 and §2 were written and committed before any profit or loss was computed on the real data. Sections after §2 are added after the runs, and any change to the implementation after the freeze is listed there. No definition in §1 changes after the commit.

---

## 1. Frozen definitions (pre-registered before any P&L)

### 1.1 Data

- **Download.** `index/NIFTY.parquet`, `index/SENSEX.parquet`, all 267 `options/NIFTY/*.parquet` (weekly expiries 2021-05-27 … 2026-08-04) and all 148 `options/SENSEX/*.parquet` (2023-08-11 … 2026-07-30) at the pinned revision; each file's sha256 matches the repository's LFS hash (the four sample files downloaded earlier match too).
- **Extract** (`scripts/research/wp11_extract.py`, run with `python3 -I`): index bars 09:00–15:59; for each session only the two contracts a day trader uses (the nearest expiry on or after the day and the nearest strictly after it), only strikes within max(6.5 strike steps, 2.6 daily expected moves + 1 step) of the day's index range (ATM ± 6 strikes at every minute, plus iron-fly wings out to 2.4 expected moves), only bars starting 09:15–15:30. Rows that repeat a (day, strike, type, minute) are dropped; every such repeat in the dataset is an exact copy of another row (`wp11_dupcheck.py`).
- **Bars.** `m` is the IST minute at which a bar starts; a bar holds the trades in [m, m + 1). A minute without a bar had no trade. **Bars with zero volume are treated as no trade** (they occur only from 2025, §2).
- **Sessions.** Index sessions with ≥ 370 one-minute bars starting 09:15–15:29 and a 09:15 bar, a bhavcopy for the day, and not one of WP6's short special sessions (Muhurat, DR drills).
- **Contracts.** Convention **A**: the exchange's nearest listed expiry on or after the session (the expiring contract on its expiry day). Convention **B**: the nearest listed expiry strictly after the session (never the expiring contract; the engine's rule). "Listed" is read from the bhavcopy, not from the dataset, so a weekly missing from the dataset drops the session instead of silently substituting a later contract.
- **Sessions to expiry (DTE):** NSE trading sessions after the day up to and including the expiry (0 on expiry day), for both indices (WP10's convention).
- **Lot:** the modal lot of that contract's bhavcopy rows that day. **India VIX known before the open:** Yahoo's ^INDIAVIX close of the previous session. **Previous index close:** Yahoo's daily close of the previous session. **Expected move (EM):** level × VIX/100 × √(1/252).
- **Two data eras (from the verification in §2, decided before any P&L):** bars to **31 Dec 2024 hold every trade** (they reproduce the exchange's open, high, low and last trade); bars **from 1 Jan 2025 are built from sampled prices** (closes, last trade and volume still match the exchange, but the day's first trade and most intraday extremes are missing). Every result is reported for both eras.

### 1.2 Orders, fills and costs

- **Fill modes.** *Conservative* (the verdict case): a sell fills at the 1-minute bar's **low**, a buy at its **high**. *Mid*: the bar's **close**. *Print* (reference only, for 09:15 sales): the entry at the 09:15 bar's **open**, which up to Dec 2024 is the exchange's first trade (WP10's assumption); later orders at closes; computed only on sessions up to 31 Dec 2024. No further spread is charged on top of these fills.
- **Order timing.** Scheduled orders (a clock time in a rule) fill in the bar starting at that minute. Signal orders (a decision on the close of an index bar ending at T) fill in the bar starting at T + 1 minute (about 60–120 s after the signal, like the engine's 90 s data lag).
- **Missing bars.** An entry order fills in each leg's first bar within [m, m + 2]; if any leg has none, there is no trade that session (counted). An exit order fills in the leg's first bar within [m, m + 5]; if none, at the leg's last close before m (a stale exit, counted).
- **Stops** on the position's value, checked every minute after the position is complete and before the exit minute. Value = long legs at their bar's low and short legs at their high (conservative), or closes (mid, print); a leg without a bar that minute is valued at its last close. The stop triggers when value ≤ V₀ − s·|V₀| (V₀ = value at the entry fills: a short premium s dearer, a long s cheaper) and fills at that minute's same prices.
- **ATM:** the listed strike (call and put both have a bar that day) nearest the index level known when the order goes in: the index's 09:15 open for a 09:15 order, otherwise the close of the index bar before the order minute; for a signal order, the signal bar's close. A tie goes to the lower strike. **1 ITM:** the next listed strike below the ATM for a call, above it for a put.
- **Charges:** `computeCharges` per order per leg at the rates in force on the day (`RESEARCH_CHARGE_SCHEDULES`, WP10: STT on option sales 0.05% → 0.0625% (Apr 2023) → 0.1% (Oct 2024) → 0.15% (Apr 2026); dated exchange charges; ₹20 brokerage per order; SEBI, stamp duty on buys, IPFT, GST); NSE for NIFTY, BSE for SENSEX. One lot per trade at the lot in force.

### 1.3 Candidates (all on the real 1-minute prices)

| id | rule | variants |
|---|---|---|
| **C1** first 15-minute candle (frozen as WP9b C5/C6) | 5-minute index bars built from the 1-minute bars (aligned to 09:15); the engine's own `firstCandlePlan`: candle 09:15–09:30, body = close at 09:30 ÷ the 09:15 open − 1; \|body\| > 0.24% buys the ATM call (up) or put (down) of contract B, signal at 09:30, order 09:31; premium stop −30% (the engine's main-account stop, a disaster stop); one trade per index per day | exit 11:15 / 15:05 (2) × fill (2) |
| **C2** noise-area momentum (frozen as WP3, base model) | the engine's `noiseAreaDecision` on the 5-minute bars: σ over the previous 14 sessions, VM 1, bands around max/min(open, previous close), decisions on bars ending HH:00/HH:30; enter long (call) above the upper band, short (put) below the lower band at decisions 09:30–14:00 (order at T + 1); exit at a crossover to the opposite band and reverse when the decision is ≤ 14:00; square-off 15:05; premium stop −30% with a 30-minute cooldown; at most 8 entries per index per day; contract B | ATM / 1 ITM (2) × fill (2) |
| **C3** 5-minute opening-range breakout (frozen as WP4) | the engine's `orb5Plan`: side of the first 5-minute candle (a doji, close = open, no trade); published entry (signal at 09:20, order 09:21) or the engine-window entry (09:25, order 09:26, skipped when the stop traded before); index stop at the candle's far side and a 10R target, checked on closed 5-minute bars after the signal (order one minute after the bar's end); else square-off 15:05; premium stop −30%; one trade per index per day; contract B | entry (2) × ATM / 1 ITM (2) × fill (2) |
| **C4** selling the opening print: short ATM straddle | sell the ATM call and put at 09:15, 09:16, 09:20, 09:30 or 11:15; buy back at 15:00 or 15:20; no stop, or a stop at +30% / +50% of the combined premium | convention (A, B) × entry (5) × exit (2) × stop (3) × fill (2); plus the print reference (09:15 only, to Dec 2024) |
| **C5** defined-risk iron fly | C4 plus a long call at the listed strike above K nearest K + m·EM and a long put below K nearest K − m·EM, m = 1 or 2, EM from the index level at the order; **sync checks**: the first minute within [entry, entry + 2] in which all four legs traded (none: no trade, counted), and the four closes of that minute must pass the no-arbitrage bounds of WP10 (`flyNoArbitrage`); the position is entered in that minute; contract B | wings (2) × entry (5) × exit (2) × stop (3) × fill (2) |
| **C6** premium timing for buyers (descriptive) | buy the ATM straddle at T = 09:15, 09:30, 10:00, …, 14:30 and sell it 60 minutes later (14:30 → 15:29); contract B (DTE ≥ 1) and, on expiry days, contract A (DTE 0); tabulated by time and DTE (0, 1, 2–5, 6+) | time (12) × contract (2) × fill (2) |
| **D1** opening-print diagnostic (prices only) | the B contract's ATM straddle (strike nearest the index open) at the exchange's first print, the 09:15 bar's open, low and close, and at 09:16 … 15:20, each ÷ the same straddle at the day's 1-minute VWAPs − 1 (WP10's "opening richness") | by era |

### 1.4 Placebos (where a placebo applies)

- **C1–C3, random entry time:** on every session the rule traded, 8 draws of an entry minute (C1: uniform in [the rule's order minute, exit − 30]; C2: a random half-hour decision 09:30–14:00; C3: uniform in [the rule's order minute, 14:30]) and a random side, with the same contract and strike rule, premium stop and exit (C1 the same clock exit; C2 the drawn side's own crossover or 15:05; C3 15:05, no index stop or target).
- **C1–C3, same moment, random side** (WP9b's placebo): its expectation at each rule entry is computed exactly as the mean of the rule's trade and the opposite side's trade at the same minute (C2: the opposite side's crossover exit; C3: the engine's `forceSide`, stop at the range's other side, 10R).
- **C4–C5, random entry time:** on every session, 8 draws of an entry minute uniform in [09:15, 14:00], with the same structure, contract, exit, stop and fill.
- **Gap:** strategy minus placebo per trade, paired by session (the strategy's mean that session minus the placebo's mean that session, weighted by the strategy's trades), with a cluster-robust standard error (one cluster per session). It must be ≥ 2 SE for every placebo that applies.

### 1.5 Statistics

- Net ₹ per lot per trade (primary) and net as % of premium (sold for C4/C5, paid for C1–C3 and C6).
- Day-block bootstrap (`dayBlockBootstrap`, seed 7) per trade and per session (sessions in the variant's sample without a trade count as ₹0): 20,000 resamples, rerun with 100,000 when both lower bounds are above zero.
- By calendar year; **walk-forward**: per index, the first 60% of the sessions on which contract B exists vs the last 40% (the same cut for every variant of that index); by era (§1.1).
- Tails (C4, C5): worst day, the 20 worst days summed, the worst 20-session run, maximum drawdown of cumulative ₹ per lot and as % of a ₹5 lakh account, and the worst 5% of trading days' sum as a multiple of the total net.
- **±20% robustness**, computed only for conservative-fill variants that already pass ≥ 180 trades, the CI, PF and every year (others fail regardless): C1 body threshold ×0.8 / ×1.2, candle 12 / 18 minutes, premium stop ×0.8 / ×1.2; C2 lookback 11 / 17, band ×0.8 / ×1.2, stop ×0.8 / ×1.2; C3 target 8R / 12R, range 4 / 6 minutes, stop ×0.8 / ×1.2; C4/C5 the entry's distance from 09:15 ×0.8 / ×1.2 and the exit's distance to 15:30 ×0.8 / ×1.2 (rounded, at least one minute, never before 09:15), stop ×0.8 / ×1.2, wings ×0.8 / ×1.2.
- **Ledger:** one line per run (strategy, placebo, perturbation) in `reports/trials.jsonl` with `wp: "WP11"`. N for Bonferroni = the ledger's lines after this study's are appended. The deflated Sharpe ratio uses net P&L per session ÷ ₹5 lakh, N from the ledger and V[SR] from this study's C1–C5 strategy and perturbation lines; the null-variance (1/(T−1)) version is reported too.

### 1.6 The bar (plan §12), per variant and index, at the conservative fill

1. ≥ 180 trades.
2. Placebo gap ≥ 2 SE, for each placebo that applies (§1.4).
3. Day-block 95% CI above zero per trade and per session.
4. Profit factor ≥ 1.3.
5. Net > 0 in every calendar year with ≥ 20 trades.
6. ±20% robustness: ≥ 80% of the perturbations net > 0, and the worst ≥ base − 50% × |base|.
7. Bonferroni: the larger of the per-trade and per-session bootstrap p-values < 0.05 / N; and DSR ≥ 0.95.
8. **Out of sample:** on the last 40% of sessions, mean > 0 with a day-block 95% CI above zero per trade, and PF ≥ 1.3.
9. **Complete-bar era** (to Dec 2024, where the conservative fill is really the minute's worst trade): mean > 0 with a CI above zero per trade.

**Verdicts.** *PASS*: every criterion. *Mid only*: fails at the conservative fill but would pass at the bar close: not actionable without quotes. *INSUFFICIENT*: fewer than 180 trades and no other failure. *FAIL*: otherwise. The print reference (C4 at the 09:15 open) and C6 are measurements, not candidates. **A frozen paper-test spec (entries, exits, stops, strikes, skip rules, ₹5 lakh sizing, kill rules) is written only for a variant that passes.**

---

## 2. Data verification (Step 1, before any P&L)

**Verdict: usable, in two eras.** Up to 31 Dec 2024 the option bars hold every trade: on 99.7–100% of at-the-money contract-days the dataset reproduces the exchange's first trade, high, low and last trade exactly. From 1 Jan 2025 the bars are built from sampled prices: closes, the last trade and total volume still match the exchange exactly, and every bar stays inside the day's real range, but the day's first trade is missing on 83–85% of at-the-money contract-days and the day's extremes on 90–98%. The index bars match Yahoo's hourly and daily bars throughout. The data is trustworthy for this study, with two consequences fixed in §1: results are reported per era, and the conservative fill (the minute's low/high) is truly the worst trade of the minute only up to Dec 2024.

Reference files: NSE and BSE bhavcopies (WP6's compact cache: NSE 2021-05 → 2026-07, BSE 2023-05 → 2026-07), Yahoo daily ^NSEI / ^BSESN, Yahoo 1-hour bars (Oct 2023 → Oct 2026). "Bhav OPEN" is the first trade, HIGH/LOW the day's extremes, CLOSE the volume-weighted price of the last 30 minutes (NSE), LAST the last trade (NSE's UDiFF files from Jan 2024). Every contract-day compared is one the extract kept (the A and B weeklies, ATM ± 6 strikes and the wings) and that traded that day.

### 2.1 Options against the exchange files

40 seeded random sessions per index (NIFTY seed 11, SENSEX seed 13), then every session. "ATM" = the strike nearest the index open, call and put.

| index | contracts | n | 09:15 bar open = bhav OPEN (±½ tick) | 1-min high and low = bhav HIGH and LOW | 1-min range inside the bhav range | 15:00–15:30 VWAP within 0.5% of bhav CLOSE (within 1%) | last bar close = bhav LAST | Σ 1-min volume ÷ (contracts × lot) |
|---|---|---|---|---|---|---|---|---|
| NIFTY | 40 random days, every kept contract | 2,629 | 86.0% | 84.8% | 100.0% | 81.0% (87.0%) | 98.2% | 1.000 |
| | 40 random days, ATM | 98 | 81.6% | 79.6% | 100.0% | 86.7% (91.8%) | 98.1% | 1.000 |
| | all 1,258 days, every kept contract | 79,783 | 78.4% | 76.9% | 100.0% | 82.8% (88.7%) | 99.0% | 1.000 |
| | all days, ATM | 3,004 | 76.0% | 72.8% | 100.0% | 87.4% (91.1%) | 99.0% | 1.000 |
| SENSEX | 40 random days, every kept contract | 3,171 | 62.3% | 68.4% | 100.0% | 81.6% (89.6%) | (no LAST in BSE files) | 1.000 |
| | 40 random days, ATM | 80 | 56.6% | 60.0% | 100.0% | 86.3% (89.0%) | | 1.000 |
| | all 767 days, every kept contract | 65,938 | 56.9% | 63.9% | 100.0% | 83.0% (90.9%) | | 1.000 |
| | all days, ATM | 1,633 | 54.2% | 55.0% | 100.0% | 87.0% (91.2%) | | 1.000 |

**By year (ATM, all days)** — the break is on 1 Jan 2025 for both indices:

| year | NIFTY: open = bhav OPEN | NIFTY: high & low exact | NIFTY: close within 0.5% | SENSEX: open = bhav OPEN | SENSEX: high & low exact | SENSEX: close within 0.5% |
|---|---|---|---|---|---|---|
| 2021 | 100.0% (361) | 100.0% | 87.9% | | | |
| 2022 | 100.0% (598) | 100.0% | 86.3% | | | |
| 2023 | 100.0% (586) | 99.8% | 86.2% | 91.7% (206) | 100.0% | 82.5% |
| 2024 | 99.7% (600) | 99.7% | 87.9% | 100.0% (528) | 99.8% | 86.4% |
| 2025 | 15.1% (590) | 2.4% | 88.3% | 14.6% (581) | 9.2% | 89.3% |
| 2026 | 17.1% (258) | 10.5% | 89.1% | 14.0% (222) | 10.6% | 86.8% |

- **Month by month** (`anatomy`, ATM call and put of contracts A and B): every month from May 2021 (NIFTY) and Oct 2023 (SENSEX) to Dec 2024 matches the exchange's first trade on 96–100% of legs and its high and low on 96–100%; every month from Jan 2025 matches the first trade on 3–29% and the high on 2–40% (months with ≥ 30 legs). From 2025 the exchange's first trade even lies inside the dataset's 09:15 bar on only 30–73% of legs, and where the dataset's 09:15 open differs from it, the monthly median gap is negative in 30 of 34 months (−0.1% to −5.7%): the first print the exchange records usually sits above every price the sampled feed caught in that minute. SENSEX's only earlier misses are its first two months (Aug–Sep 2023; in Sep 2023 the exchange's first trade still lies inside the 09:15 bar every time, median gap 0.03%).
- **The close.** NSE's CLOSE is the VWAP of the trades in the last 30 minutes; the 1-minute stand-in (typical price × volume, bars 15:00–15:29) is within 0.5% on 86–89% of ATM legs in every year (median gap 0.10–0.16%), including 2025–26: the late-day prices are intact in both eras.
- **Volume and open interest.** Σ 1-minute volume equals the exchange's contracts × lot on every contract-day (median 1.000, p5–p95 1.000–1.002); NIFTY's last open interest equals the bhavcopy's (median ratio 1.001; SENSEX's open interest is in other units).
- **Data checks in the extract** (`manifest.json`): 30.3 million NIFTY rows were exact repeats of another row and were dropped (the repeats never conflict: 0 of 30.4 million key groups differ, `wp11_dupcheck.py`); SENSEX has none. 10 SENSEX rows (one expiry file, 24 May 2024) have a low above the open or close. Zero-volume bars: 159,363 NIFTY and 1,224 SENSEX rows, all from 2025 (0.6% of NIFTY's 2025–26 rows), treated as no trade. No row has a timestamp outside its trading day or a wrong symbol or expiry.
- **Missing contracts.** The dataset has no file for the NIFTY weeklies of 3 Nov 2021, 20 Oct 2025 and 16, 23 and 30 Jun 2026, and for the SENSEX contracts of 31 Oct and 1 Nov 2024, 30 Oct 2025 and the six weeklies from 27 May to 2 Jul 2026. With the exchange's own expiry list (§1.1) those sessions are dropped for the affected convention: contract B is missing on 29 of 1,258 NIFTY sessions and 97 of 767 SENSEX sessions (mostly May–Jul 2026).

### 2.2 Spot (index) data

| | NIFTY (1,252 sessions) | SENSEX (760 sessions) |
|---|---|---|
| 1-hour bars rebuilt from the 1-minute bars vs Yahoo's 1-hour bars (Oct 2023 – Jul 2026) | 4,523 bars: median \|diff\| 0.000% in open, high, low and close; all four within 0.02% on 93.8% | 4,560 bars: median 0.000%; all four within 0.02% on 80.2% |
| day high / day low vs Yahoo daily | within 0.01% on 94.0% / 95.6% of sessions (median 0.000%) | 89.5% / 91.3% (median 0.000%) |
| 09:15 bar open vs Yahoo's daily open | median 0.035% (p99 0.21%): Yahoo's open is the official one from the pre-open auction, the dataset's 09:15 bar opens at the first continuous print | median 0.044% (p99 0.34%) |
| last bar close vs Yahoo close | median 0.040% (NSE's UndrlygPric: 0.036%): NIFTY's official close is a 30-minute average | median 0.000%; within 0.01% on 96.1% |

### 2.3 Coverage of the contracts the candidates trade (contract B, no prices used)

| order minute | NIFTY: ATM call and put both trade | NIFTY: all four fly legs (1 EM / 2 EM) trade in that minute | SENSEX: ATM call and put | SENSEX: four fly legs (1 EM / 2 EM) |
|---|---|---|---|---|
| 09:15 | 99.8% | 99.8% / 99.8% | 90.1% | 83.6% / 74.6% |
| 09:16 | 99.9% | 99.9% / 99.9% | 93.0% | 87.0% / 79.5% |
| 09:20 | 99.9% | 99.9% / 99.9% | 95.2% | 89.7% / 82.8% |
| 09:30 | 100.0% | 100.0% / 100.0% | 96.1% | 90.7% / 84.0% |
| 11:15 | 99.8% | 99.8% / 99.8% | 91.8% | 85.9% / 80.7% |
| 15:00 / 15:20 | 99.7% / 99.7% | – | 95.1% / 96.0% | – |

The ATM legs have a bar in every one of the 375 session minutes on the median NIFTY day (p10: 100%) and on the median SENSEX day (p10: 87%). SENSEX's thinner minutes are why the entry window allows two minutes (§1.2) and why the fly's sync check drops more SENSEX days.
