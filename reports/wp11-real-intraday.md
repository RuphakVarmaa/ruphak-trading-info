# WP11: option strategies on real 1-minute option prices

Sat 10 Oct 2026. Branch `worktree-agent-a939f8479e0f2a4de`, reset to `a6ee805` (head of `claude/gifted-wright-3d8r3j`). Analysis only: no paper trading, no deploys, no pushes; nothing in the engine changes.

**Data and licence.** Every option and index price in this study comes from the Hugging Face dataset **"India Index & Options – 1-minute OHLC" by TradeMarkk** (`thetrademarkk/india-index-options-1m`, revision `0f4800e43e6f96cec0794369d78eb4d3c4211ef5`, https://huggingface.co/datasets/thetrademarkk/india-index-options-1m), licensed **CC-BY-NC-4.0**: non-commercial research use only, attributed here. The dataset describes itself as "educational use only, provided as-is, verify against official exchange data before relying on it"; §2 does that. No raw or extracted data is committed (the repository is public); the scripts rebuild everything from a download.

**Status of this file:** §1 and §2 were written and committed (`34bc06a`) before any profit or loss was computed on the real data. They are unchanged apart from one rounding correction in §2, listed in §8. §0 and §3–§10 were added after the runs; §8 lists every change to the implementation after the freeze. No definition in §1 changed.

---

## 0. Bottom line

**Verdict: nothing passes. 0 of 656 variants clears the plan's §12 bar, on either index, at either fill, so there is no paper-test spec.** No positive, actionable entry plan exists in five years of real 1-minute NIFTY option prices and three years of SENSEX.

| question | answer from the real 1-minute prices |
|---|---|
| Is the data trustworthy? | **Yes, in two eras (§2).** To Dec 2024 the option bars hold every trade: they reproduce the exchange's first trade, high, low and last trade on 99.7–100% of ATM contract-days. From Jan 2025 they are sampled: closes, last trade and volume are still exact, but the first trade is missing on 83–86% of ATM contract-days and the extremes on 90–98%. The index bars match Yahoo's hourly bars exactly. |
| Buying: first 15-minute candle, noise area, 5-minute ORB? | **All lose, at both fills, over 5 years.** First candle to 15:05: −₹333 a NIFTY lot at the bar close and −₹679 at the conservative fill (363 trades). Its side did *worse* than a random side at the same minute (−1.2 SE): WP9b's one directional effect does not survive five years. Noise area: about zero at the bar close (−₹17 to +₹14) and −₹271 to −₹386 at the conservative fill. ORB: −₹138 to −₹164 at the close and −₹421 to −₹551 conservative. No placebo gap is above +0.9 SE. |
| Selling the opening print? | **Positive only at prices nobody can count on.** Sold at the exchange's first trade (to Dec 2024, where the bars have it), the ATM straddle makes +₹230–283 a NIFTY lot (2.0–3.0% of premium) and +₹502–583 a SENSEX lot (5.4–7.4%): WP10 reproduced. Sold at the close of that same first minute, a real traded price, it keeps +₹157–254 (NIFTY, 1.1–2.2%) and +₹223–384 (SENSEX, 1.8–3.0%). By 09:30 most of that is gone (NIFTY +₹45 to +₹103, SENSEX −₹23 to +₹97), and by 11:15 all of it. At the conservative fill (each leg sold at its own 1-minute low and bought back at its high) **every one of the 120 straddle variants loses**: −₹1,086 to −₹1,845 a lot for a 09:15 sale and −₹390 to −₹949 for later entries. That fill charges both legs the index's whole first-minute swing, so it overstates the cost of a real order; but what a real 09:15 order would get is unknowable without quotes. |
| Even at the bar close, why does it fail? | The best variants are positive with day-block CIs above zero (32 mid-fill variants), and they beat random entry times by 1.8–4.2 SE. But none clears Bonferroni: the best p is 5.7 × 10⁻⁴ against 0.05 / 2,468 = 2.0 × 10⁻⁵. NIFTY's best (current week, 09:15 → 15:00, +30% stop) makes +₹254 (CI +₹104 … +₹406, PF 1.30), but only +₹103 (CI −₹27 … +₹234) in the complete-bar era. SENSEX's best (+₹304–384, PF 1.33–1.49) have last-40% CIs that span zero, and some lose in 2026. |
| The defined-risk iron fly? | **Loses everywhere:** −₹76 to −₹254 a lot at the bar close and −₹703 to −₹3,568 at the conservative fill, at every entry, exit and stop. The wings cost more than the opening premium they protect. |
| The tail (naked straddle, one lot, bar close)? | Worst day −₹28,203 (NIFTY, 12 May 2025) and −₹27,620 (SENSEX, 4 Jun 2024). A +30% stop on the combined premium cuts the worst day to −₹11,080 / −₹11,142 and keeps the mean. The worst 5% of days lose 0.9–2.4× the whole sample's net. Max drawdown is 4–10% of ₹5 lakh at the bar close, and 138–451% at the conservative fill (a steady bleed). |
| When is premium highest; when not to enter (buyers)? | **In the first minute** (§6). In the complete-bar era the first trade prices the ATM straddle a median 7.4% (NIFTY) / 15.0% (SENSEX) above the day's average. The figure is 5.3% / 9.2% at the 09:15 close, 4.3% / 6.2% at 09:30, 2.0% / 3.0% at 11:15 and −1.5% / −1.6% at 15:00. Buying the straddle at 09:15 for an hour costs ₹2,176 a NIFTY lot / ₹2,352 a SENSEX lot at the conservative fill (₹818 / ₹827 from 09:30). At the bar close an hour costs ₹109–276 from 09:30 onward. On expiry day the afternoon costs most: 15% of premium in the 14:00–15:00 hour. |

**What it means.** Buying stays a losing game on real prices: no rule picks the side better than chance. The seller's open→close premium is real in the prints. It sits in the first minute, and it is worth roughly 1–3% of premium if a seller can trade near the minute's last price. Whether that is possible decides the question, and it cannot be answered from trade bars: a market order at 09:15 sells at the bid, and the bid is not in any of these files. The next step is measurement, not a paper trade (§9).

**Verdict table** (per family and index: the variant with the best mean on the first 60% of sessions, i.e. the one a walk-forward would pick, at each fill; ₹ per lot per trade, net of dated charges; day-block 95% CIs):

| candidate | index | fill | variants | picked on the first 60% | trades | ₹/trade (95% CI) | PF | first 60% / last 40% ₹/trade (last-40% CI) | to Dec 2024 / from 2025 | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| C1 first 15-min candle | NIFTY | conservative | 2 | exit 15:05 | 363 | −₹679 (−₹1,026 … −₹326) | 0.60 | −₹340 / −₹1,103 (−₹1,707 … −₹483) | −₹375 / −₹1,317 | FAIL |
| | | mid | 2 | exit 15:05 | 363 | −₹333 (−₹695 … ₹34) | 0.78 | −₹46 / −₹693 (−₹1,312 … −₹54) | −₹75 / −₹875 | FAIL |
| | SENSEX | conservative | 2 | exit 11:15 | 198 | −₹722 (−₹1,050 … −₹388) | 0.44 | −₹425 / −₹1,044 (−₹1,626 … −₹434) | −₹407 / −₹954 | FAIL |
| | | mid | 2 | exit 11:15 | 198 | −₹328 (−₹652 … ₹4) | 0.69 | −₹220 / −₹445 (−₹1,025 … ₹165) | −₹215 / −₹411 | FAIL |
| C2 noise area | NIFTY | conservative | 2 | ATM | 807 | −₹355 (−₹564 … −₹143) | 0.72 | −₹234 / −₹515 (−₹882 … −₹122) | −₹229 / −₹647 | FAIL |
| | | mid | 2 | 1 ITM | 773 | −₹14 (−₹257 … ₹234) | 0.99 | ₹71 / −₹130 (−₹551 … ₹321) | ₹71 / −₹215 | FAIL |
| | SENSEX | conservative | 2 | ATM | 433 | −₹271 (−₹550 … ₹18) | 0.78 | −₹185 / −₹399 (−₹949 … ₹201) | −₹112 / −₹424 | FAIL |
| | | mid | 2 | ATM | 424 | ₹9 (−₹276 … ₹303) | 1.01 | ₹17 / −₹3 (−₹557 … ₹605) | ₹55 / −₹37 | FAIL |
| C3 5-minute ORB | NIFTY | conservative | 4 | engine window, ATM | 1,071 | −₹477 (−₹629 … −₹321) | 0.59 | −₹342 / −₹672 (−₹951 … −₹373) | −₹369 / −₹749 | FAIL |
| | | mid | 4 | engine window, ATM | 1,071 | −₹150 (−₹309 … ₹12) | 0.84 | −₹53 / −₹292 (−₹582 … ₹22) | −₹99 / −₹280 | FAIL |
| | SENSEX | conservative | 4 | published, ATM | 658 | −₹479 (−₹688 … −₹260) | 0.59 | −₹381 / −₹624 (−₹1,029 … −₹186) | −₹353 / −₹605 | FAIL |
| | | mid | 4 | published, ATM | 658 | −₹151 (−₹361 … ₹72) | 0.84 | −₹151 / −₹150 (−₹562 … ₹290) | −₹155 / −₹146 | FAIL |
| C4 short straddle | NIFTY | conservative | 60 | B 11:15 → 15:20, +50% stop | 1,222 | −₹400 (−₹503 … −₹297) | 0.46 | −₹380 / −₹429 (−₹637 … −₹226) | −₹372 / −₹471 | FAIL |
| | | mid | 60 | A 09:15 → 15:00, +30% stop | 1,222 | ₹254 (₹104 … ₹406) | 1.30 | ₹119 / ₹458 (₹151 … ₹771) | ₹103 / ₹647 | FAIL (Bonferroni, DSR, complete-bar era) |
| | SENSEX | conservative | 60 | B 11:15 → 15:20, +50% stop | 663 | −₹416 (−₹579 … −₹259) | 0.48 | −₹136 / −₹833 (−₹1,184 … −₹517) | −₹191 / −₹644 | FAIL |
| | | mid | 60 | A 09:15 → 15:20, +30% stop | 663 | ₹304 (₹80 … ₹531) | 1.33 | ₹501 / ₹10 (−₹423 … ₹452) | ₹336 / ₹271 | FAIL (year 2026, Bonferroni, DSR, out of sample) |
| C5 iron fly | NIFTY | conservative | 60 | 2 EM 11:15 → 15:20, +50% stop | 1,221 | −₹721 (−₹792 … −₹653) | 0.10 | −₹679 / −₹785 (−₹921 … −₹654) | −₹665 / −₹865 | FAIL |
| | | mid | 60 | 2 EM 09:15 → 15:00, +30% stop | 1,221 | −₹105 (−₹187 … −₹23) | 0.81 | −₹135 / −₹60 (−₹227 … ₹104) | −₹138 / −₹20 | FAIL |
| | SENSEX | conservative | 60 | 2 EM 11:15 → 15:20, no stop | 594 | −₹704 (−₹813 … −₹598) | 0.14 | −₹492 / −₹973 (−₹1,187 … −₹777) | −₹479 / −₹897 | FAIL |
| | | mid | 60 | 2 EM 09:15 → 15:00, +30% stop | 550 | −₹76 (−₹217 … ₹64) | 0.88 | −₹16 / −₹150 (−₹413 … ₹107) | −₹70 / −₹81 | FAIL |

The verdict is decided at the conservative fill (§1.6). At that fill no variant has a CI above zero, so none qualified for the ±20% perturbations. No variant is "mid only" either: every mid-fill twin fails Bonferroni and at least one other criterion. The full per-variant tables (656 strategy variants and 160 placebo runs, with years, halves, eras and placebo gaps) are regenerated by the script (§10).

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

**Verdict: usable, in two eras.** Up to 31 Dec 2024 the option bars hold every trade: on 99.7–100% of at-the-money contract-days the dataset reproduces the exchange's first trade, high, low and last trade exactly. From 1 Jan 2025 the bars are built from sampled prices: closes, the last trade and total volume still match the exchange exactly, and every bar stays inside the day's real range, but the day's first trade is missing on 83–86% of at-the-money contract-days and the day's extremes on 90–98%. The index bars match Yahoo's hourly and daily bars throughout. The data is trustworthy for this study, with two consequences fixed in §1: results are reported per era, and the conservative fill (the minute's low/high) is truly the worst trade of the minute only up to Dec 2024.

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

---

## 3. Selling the opening print (C4): the short ATM straddle

**Samples.**
- **NIFTY:** 1,251 sessions from 24 May 2021 to 2 Jul 2026. Contract B exists on 1,222 of them; the walk-forward cut falls after 27 May 2024.
- **SENSEX:** 763 sessions with an index bar and a bhavcopy. Contract B exists on 666, from 7 Aug 2023 to 2 Jul 2026; the cut falls after 2 Apr 2025.

Every figure is net ₹ per lot per trade, after dated charges, one lot at the lot in force.

### 3.1 The grid: bar close (mid) / conservative fill

Each cell gives ₹ per trade at the bar close / at the conservative fill. † marks a mid-fill mean whose day-block 95% CI is above zero both per trade and per session. A is the current weekly (the expiring contract on its expiry day); B never trades the expiring contract.

**NIFTY** (1,221–1,222 trades per cell):

| entry | stop | B → 15:00 | B → 15:20 | A → 15:00 | A → 15:20 |
|---|---|---|---|---|---|
| 09:15 | no stop | 174† / −1,742 | 170† / −1,451 | 221† / −1,687 | 197 / −1,383 |
| 09:15 | +30% | 157† / −1,834 | 158† / −1,654 | 254† / −1,845 | 238† / −1,724 |
| 09:15 | +50% | 185† / −1,756 | 183† / −1,506 | 244† / −1,724 | 224† / −1,513 |
| 09:16 | no stop | 137 / −881 | 143 / −578 | 145 / −889 | 125 / −575 |
| 09:16 | +30% | 95 / −949 | 99 / −716 | 148 / −940 | 130 / −748 |
| 09:16 | +50% | 138 / −918 | 158† / −634 | 186† / −875 | 181† / −613 |
| 09:20 | no stop | 107 / −816 | 114 / −513 | 105 / −843 | 96 / −520 |
| 09:20 | +30% | 94 / −863 | 91 / −638 | 130 / −872 | 117 / −686 |
| 09:20 | +50% | 97 / −829 | 111 / −545 | 129 / −779 | 135 / −514 |
| 09:30 | no stop | 70 / −802 | 81 / −494 | 99 / −797 | 103 / −458 |
| 09:30 | +30% | 45 / −839 | 55 / −600 | 70 / −816 | 68 / −606 |
| 09:30 | +50% | 57 / −826 | 74 / −535 | 87 / −796 | 97 / −521 |
| 11:15 | no stop | 4 / −714 | 16 / −401 | 8 / −734 | −3 / −407 |
| 11:15 | +30% | 6 / −738 | 24 / −452 | 32 / −709 | 38 / −449 |
| 11:15 | +50% | 3 / −705 | 16 / −400 | −7 / −688 | −7 / −402 |

**SENSEX** (634–668 trades per cell):

| entry | stop | B → 15:00 | B → 15:20 | A → 15:00 | A → 15:20 |
|---|---|---|---|---|---|
| 09:15 | no stop | 326† / −1,300 | 308† / −1,086 | 263 / −1,389 | 223 / −1,163 |
| 09:15 | +30% | 358† / −1,364 | 334† / −1,229 | 345† / −1,531 | 304† / −1,435 |
| 09:15 | +50% | 379† / −1,306 | 384† / −1,111 | 368† / −1,451 | 347† / −1,288 |
| 09:16 | no stop | 283† / −729 | 274† / −514 | 175 / −840 | 130 / −618 |
| 09:16 | +30% | 279† / −785 | 281† / −634 | 242† / −886 | 191 / −785 |
| 09:16 | +50% | 289† / −746 | 299† / −522 | 250† / −847 | 215 / −678 |
| 09:20 | no stop | 116 / −690 | 96 / −480 | 81 / −750 | 23 / −534 |
| 09:20 | +30% | 98 / −725 | 85 / −557 | 115 / −778 | 55 / −653 |
| 09:20 | +50% | 92 / −720 | 85 / −508 | 181 / −752 | 116 / −597 |
| 09:30 | no stop | 97 / −656 | 79 / −435 | 30 / −752 | −23 / −525 |
| 09:30 | +30% | 84 / −657 | 70 / −495 | 70 / −715 | 12 / −602 |
| 09:30 | +50% | 55 / −687 | 52 / −460 | 89 / −740 | 28 / −580 |
| 11:15 | no stop | −19 / −632 | −20 / −390 | −47 / −691 | −69 / −431 |
| 11:15 | +30% | −70 / −704 | −51 / −492 | −63 / −773 | −82 / −607 |
| 11:15 | +50% | −38 / −656 | −34 / −416 | −58 / −718 | −81 / −510 |

**The first-print reference.** Each leg is sold at its first trade (the bhavcopy OPEN), on sessions to Dec 2024 only, and bought back at closes. Each cell gives ₹ per trade with no stop / with a +30% stop / with a +50% stop:

| | B → 15:00 | B → 15:20 | A → 15:00 | A → 15:20 |
|---|---|---|---|---|
| NIFTY (882–883 trades) | 239 / 231 / 230 (2.0–2.1% of premium; PF 1.33–1.35) | 260 / 232 / 233 | 270 / 283 / 281 (2.9–3.0%; PF 1.34–1.40) | 265 / 266 / 255 |
| SENSEX (308 B, 334 A trades) | 544 / 502 / 523 (5.4–5.9%; PF 1.87–1.98) | 583 / 522 / 554 | 513 / 582 / 573 (6.5–7.4%; PF 1.75–2.02) | 526 / 578 / 580 |

**Reading.**

1. **The first print is worth what WP10 said.** Sold at the exchange's first trade and bought back near the close, the straddle makes 2.0–3.0% of premium on NIFTY and 5.4–7.4% on SENSEX.
   - WP10 found +2.9% / +1.7% (NIFTY, A / B) and +6.2% / +4.1% (SENSEX) on the bhavcopies.
   - The SENSEX first-print rows are the only results in this study below Bonferroni's level (p ≈ 1–2 × 10⁻⁵). All of those sessions fall before the walk-forward cut, so they have no out-of-sample half.
2. **One minute later about a third of it is gone; by 09:30, most of it.**
   - At the 09:15 bar's close the same straddles make 1.1–2.2% (NIFTY) and 1.8–3.0% (SENSEX).
   - Entered at 09:30 they make +₹45 to +₹103 (NIFTY) and −₹23 to +₹97 (SENSEX).
   - Entered at 11:15 they make about zero or less.
   - The gain is in the first minute's prices, not in holding through the day.
3. **The opening minute is richer than the rest of the day.** The placebo enters the same structure, with the same exit and stop, at a random minute between 09:15 and 14:00 (8 draws a session). The 09:15 mid-fill sales beat it by 1.8–4.2 SE. That is a low bar, though: a seller earns less the later they enter.
4. **At the conservative fill every variant loses**, the 09:15 sales most of all (−₹1,086 to −₹1,845 a lot). The minute's own price range swamps the premium.
5. **Stops shift the mean at the bar close by −₹51 to +₹124 and cut the tails (§3.4).** At the conservative fill they mostly make things worse: a stop checked on 1-minute highs fires on spikes and buys back at the spike.

### 3.2 Why the conservative fill costs so much: one session by hand

NIFTY, 14 Jun 2023, contract B (15 Jun expiry, lot 50), strike 18,750 (index open 18,753.8):

| | call 09:15 bar (o / h / l / c) | put 09:15 bar | call 15:00 bar | put 15:00 bar | net ₹ per lot |
|---|---|---|---|---|---|
| prices | 51.60 / 52.65 / 46.70 / 49.30 | 47.25 / 56.30 / 45.50 / 50.80 | 51.45 / 58.00 / 51.45 / 55.50 | 37.55 / 37.55 / 31.70 / 33.50 | |
| first print (open → 15:00 close) | sells 51.60 | sells 47.25 | buys 55.50 | buys 33.50 | +₹389 |
| mid (09:15 close → 15:00 close) | 49.30 | 50.80 | 55.50 | 33.50 | +₹452 |
| conservative (09:15 lows → 15:00 highs) | 46.70 | 45.50 | 58.00 | 37.55 | −₹271 |

- **The opening prices are right.** The bhavcopy prints 51.60 and 47.25 as the day's OPEN, the same as the dataset.
- **The two lows are not a price anyone could trade.** In the first minute the index moved 23 points (18,731 to 18,754), so the call's low and the put's low came at opposite ends of that move. Their sum, 92.20, is 8% below the straddle's last price in the minute (100.10). No straddle traded at 92.20.
- **The conservative case is a bound, not a fill.** It charges that first-minute swing on both legs, and the closing minute's swing on the way out. It is a hard lower bound, not an estimate of what a market order would get.
- **Over all sessions the two fills differ by about ₹1,900 a NIFTY lot** for a 09:15 sale held to 15:00 (−₹1,742 against +₹174, contract B). Roughly ₹1,300 of that is the opening minute: the same sale entered at 11:15 shows a gap of only ₹718, most of it the exit minute.

**How far a real fill can be from the bar close.** The best mid-fill variants make 1.1–3.0% of premium. If a real 09:15 sale and its buy-back each fill worse than the bar's close by more than about half of that (0.5–1.5% of premium per side), nothing is left. The 1-minute bars cannot say whether a 09:15 market order gives up less or more than that to the spread. Only bid and ask quotes can.

### 3.3 The best mid-fill variants against the bar

| criterion | NIFTY: A 09:15 → 15:00, +30% stop, mid | SENSEX: B 09:15 → 15:20, +50% stop, mid |
|---|---|---|
| trades | 1,222 (pass) | 634 (pass) |
| ₹/trade (95% CI); % of premium | +₹254 (+₹104 … +₹406); 2.2% | +₹384 (+₹153 … +₹618); 2.6% |
| placebo gap (random entry time) | +₹222, 3.4 SE (pass) | +₹401, 4.1 SE (pass) |
| PF | 1.30 (pass) | 1.49 (pass) |
| every year positive | pass (2021–2026) | pass (2023–2026) |
| Bonferroni (p < 2.0 × 10⁻⁵) and DSR ≥ 0.95 | **fail**: p 5.7 × 10⁻⁴; DSR 0.00 (null variance: 0.41) | **fail**: p 6.2 × 10⁻⁴; DSR 0.00 (0.39) |
| last 40% | +₹458 (+₹151 … +₹771), PF 1.44, 487 trades (pass) | +₹368 (−₹79 … +₹828), PF 1.36 (**fail**) |
| complete-bar era (to Dec 2024) | +₹103 (−₹27 … +₹234), PF 1.15 (**fail**); from 2025: +₹647 | +₹264 (+₹37 … +₹470) (pass); from 2025: +₹496 |
| ±20% robustness | not run (the conservative twin fails) | not run |
| the same variant at the conservative fill | −₹1,845 a lot (PF 0.10) | −₹1,111 (PF 0.32) |

- **Both carry selection.** Each is the best of its index's 60 mid-fill straddle variants on the full sample. Their walk-forward twins (the variant with the best first-60% mean, §0) fail as well.
- **Both look better from 2025**, the period with sampled bars.

### 3.4 The tail (one lot, ₹5 lakh account)

| index | variant | fill | trades | ₹/trade | worst day | 20 worst days | worst 20-session run | max drawdown (% of ₹5 lakh) | worst 5% of days (× the total net) |
|---|---|---|---|---|---|---|---|---|---|
| NIFTY | B 09:15 → 15:20, no stop | mid | 1,221 | ₹170 | −₹28,203 (12 May 2025) | −₹2,62,095 | −₹30,155 | ₹52,058 (10.4%) | −₹4,90,626 (2.4×) |
| | | conservative | 1,221 | −₹1,451 | −₹33,238 (12 May 2025) | −₹3,34,360 | −₹88,358 | ₹17,72,171 (354%) | net < 0 |
| | B 09:15 → 15:20, +30% stop | mid | 1,221 | ₹158 | −₹11,080 (1 Feb 2026) | −₹1,62,274 | −₹21,177 | ₹31,828 (6.4%) | −₹3,67,712 (1.9×) |
| | | conservative | 1,221 | −₹1,654 | −₹33,724 (7 Apr 2025) | −₹2,22,941 | −₹1,16,465 | ₹20,19,959 (404%) | net < 0 |
| | B 09:15 → 15:20, +50% stop | mid | 1,221 | ₹183 | −₹16,601 (1 Feb 2026) | −₹1,91,527 | −₹27,962 | ₹45,497 (9.1%) | −₹4,24,313 (1.9×) |
| | A 09:15 → 15:00, +30% stop | mid | 1,222 | ₹254 | −₹11,080 (1 Feb 2026) | −₹1,47,133 | −₹29,033 | ₹30,950 (6.2%) | −₹3,34,480 (1.1×) |
| | iron fly 1 EM, 09:15 → 15:20 | mid | 1,221 | −₹192 | −₹7,267 (12 May 2025) | −₹63,644 | −₹12,619 | ₹2,36,301 (47%) | net < 0 |
| | iron fly 2 EM, 09:15 → 15:20 | mid | 1,221 | −₹136 | −₹18,089 (12 May 2025) | −₹1,52,591 | −₹23,254 | ₹1,87,316 (37%) | net < 0 |
| SENSEX | B 09:15 → 15:20, no stop | mid | 634 | ₹308 | −₹27,620 (4 Jun 2024) | −₹2,16,833 | −₹30,579 | ₹31,480 (6.3%) | −₹2,72,892 (1.4×) |
| | | conservative | 634 | −₹1,086 | −₹33,150 (4 Jun 2024) | −₹2,67,922 | −₹89,045 | ₹6,88,783 (138%) | net < 0 |
| | B 09:15 → 15:20, +30% stop | mid | 634 | ₹334 | −₹11,142 (1 Feb 2026) | −₹1,33,194 | −₹24,184 | ₹26,993 (5.4%) | −₹1,89,684 (0.9×) |
| | B 09:15 → 15:20, +50% stop | mid | 634 | ₹384 | −₹17,417 (1 Feb 2026) | −₹1,60,206 | −₹17,593 | ₹19,972 (4.0%) | −₹2,14,081 (0.9×) |
| | | conservative | 634 | −₹1,111 | −₹15,657 (9 Mar 2026) | −₹2,02,246 | −₹89,053 | ₹7,04,216 (141%) | net < 0 |
| | iron fly 1 EM, 09:15 → 15:20 | mid | 594 | −₹190 | −₹8,856 (12 May 2025) | −₹57,544 | −₹13,307 | ₹1,13,406 (23%) | net < 0 |
| | iron fly 2 EM, 09:15 → 15:20 | mid | 550 | −₹150 | −₹20,948 (12 May 2025) | −₹1,30,537 | −₹26,646 | ₹91,874 (18%) | net < 0 |

- **The naked straddle at the bar close:** its worst day costs about one eighteenth (5.6%) of the ₹5 lakh account per lot.
  - Its 20 worst days add up to 1.3× (NIFTY) and 1.1× (SENSEX) everything the variant netted.
  - Its worst 5% of days lose 1.4–2.4× that net.
- **A +30% stop on the combined premium**, checked minute by minute, cuts the worst day by 60% and the worst 5% of days to 0.9–1.9× the net. The mean moves by −₹12 (NIFTY) and +₹26 (SENSEX).
- **These tails come from a calmer period.** The dataset starts in May 2021, so it misses March 2020 and WP10's −₹41,362 day.

### 3.5 Verdict on C4

**FAIL on both indices.**
- **At the conservative fill:** no variant has a CI above zero, a PF above 0.79 or a single positive year.
- **At the bar close:** the 09:15–09:16 sales are positive but fail multiple testing.
  - NIFTY's are not significant in the complete-bar era.
  - SENSEX's fail out of sample, and several lose in 2026.

The open question from WP10 has narrowed. The premium is in the first minute's prices. Whether a seller can capture it depends on the first minute's bid–ask spread, which no trade data shows.

---

## 4. The defined-risk iron fly (C5)

**NIFTY** (1,221–1,222 trades per cell; ₹ per trade, mid / conservative):

| entry | stop | 1 EM → 15:00 | 1 EM → 15:20 | 2 EM → 15:00 | 2 EM → 15:20 |
|---|---|---|---|---|---|
| 09:15 | no stop | −179 / −3,346 | −192 / −2,927 | −114 / −2,708 | −136 / −2,381 |
| 09:15 | +30% | −183 / −3,528 | −194 / −3,524 | −105 / −2,898 | −120 / −2,788 |
| 09:15 | +50% | −180 / −3,568 | −193 / −3,482 | −105 / −2,761 | −122 / −2,521 |
| 09:16 | no stop | −191 / −1,736 | −199 / −1,310 | −148 / −1,407 | −162 / −1,072 |
| 09:20 | no stop | −189 / −1,570 | −197 / −1,146 | −158 / −1,283 | −172 / −949 |
| 09:30 | no stop | −186 / −1,489 | −196 / −1,066 | −170 / −1,227 | −184 / −891 |
| 11:15 | no stop | −206 / −1,263 | −208 / −834 | −189 / −1,048 | −194 / −703 |

**SENSEX** (550–635 trades per cell; the four-leg sync check drops 10–25% of SENSEX sessions, §2.3):

| entry | stop | 1 EM → 15:00 | 1 EM → 15:20 | 2 EM → 15:00 | 2 EM → 15:20 |
|---|---|---|---|---|---|
| 09:15 | no stop | −173 / −2,923 | −190 / −2,588 | −110 / −2,334 | −150 / −2,081 |
| 09:15 | +30% | −180 / −3,348 | −204 / −3,330 | −76 / −2,560 | −107 / −2,467 |
| 09:15 | +50% | −182 / −3,267 | −204 / −3,183 | −92 / −2,457 | −124 / −2,296 |
| 09:16 | no stop | −194 / −1,719 | −213 / −1,394 | −126 / −1,400 | −165 / −1,155 |
| 09:20 | no stop | −217 / −1,468 | −235 / −1,143 | −181 / −1,189 | −225 / −947 |
| 09:30 | no stop | −211 / −1,361 | −232 / −1,034 | −173 / −1,126 | −217 / −881 |
| 11:15 | no stop | −208 / −1,130 | −225 / −794 | −200 / −974 | −221 / −704 |

- **The stop rows from 09:16 to 11:15** (not shown) fall in the same ranges: −₹113 to −₹254 a lot at the bar close and −₹721 to −₹2,105 at the conservative fill.
- **At the first print** (to Dec 2024):
  - NIFTY's flies make −₹166 to −₹300 a lot (−1.5% to −2.7% of premium).
  - SENSEX's 1 EM fly makes −₹54 to +₹6.
  - SENSEX's 2 EM fly makes +₹130 to +₹167 (1.5–1.9%, PF 1.29–1.40, CIs touching zero).
  - These are WP10's flies again.

**Verdict: FAIL on both indices, at every entry, exit, stop and fill.** The long wings are bought in the same rich first minute and need four more orders. At the bar close they cost more than the straddle's whole edge: −₹76 to −₹254 a lot. The cap works (the worst fly day at the bar close is −₹7k to −₹21k a lot, §3.4), but there is no profit left to protect.

---

## 5. Buying on real prices (C1–C3)

Figures are ₹ per lot per trade, with 95% CIs from day blocks. Placebo gaps are in ₹ and SE: random entry time / same moment with a random side. "Years +" counts calendar years with at least 20 trades.

**NIFTY** (C1 363 trades; C2 773–807; C3 1,071–1,222):

| variant | fill | ₹/trade (95% CI) | % of premium | hit | PF | years + | first 60% / last 40% | to Dec 2024 / from 2025 | placebo gaps |
|---|---|---|---|---|---|---|---|---|---|
| C1 first candle → 11:15 | conservative | −₹717 (−₹949 … −₹484) | −8.8% | 36% | 0.44 | 0/6 | −₹371 / −₹1,152 | −₹385 / −₹1,415 | −₹312 (−2.8) / −₹91 (−0.9) |
| | mid | −₹333 (−₹560 … −₹102) | −4.2% | 41% | 0.67 | 1/6 | −₹80 / −₹649 | −₹108 / −₹806 | −₹279 (−2.3) / −₹73 (−0.7) |
| C1 first candle → 15:05 | conservative | −₹679 (−₹1,026 … −₹326) | −8.3% | 29% | 0.60 | 0/6 | −₹340 / −₹1,103 | −₹375 / −₹1,317 | −₹250 (−1.4) / −₹209 (−1.3) |
| | mid | −₹333 (−₹695 … ₹34) | −4.2% | 33% | 0.78 | 1/6 | −₹46 / −₹693 | −₹75 / −₹875 | −₹257 (−1.4) / −₹207 (−1.2) |
| C2 noise area, ATM | conservative | −₹355 (−₹564 … −₹143) | −4.9% | 33% | 0.72 | 0/6 | −₹234 / −₹515 | −₹229 / −₹647 | −₹50 (−0.6) / −₹37 (−0.5) |
| | mid | −₹17 (−₹233 … ₹207) | −0.2% | 39% | 0.99 | 2/6 | ₹47 / −₹104 | ₹47 / −₹167 | −₹56 (−0.6) / −₹3 (−0.0) |
| C2 noise area, 1 ITM | conservative | −₹386 (−₹623 … −₹145) | −4.5% | 35% | 0.74 | 0/6 | −₹253 / −₹567 | −₹252 / −₹702 | −₹88 (−0.9) / −₹34 (−0.4) |
| | mid | −₹14 (−₹257 … ₹234) | −0.2% | 42% | 0.99 | 2/6 | ₹71 / −₹130 | ₹71 / −₹215 | −₹116 (−1.1) / −₹7 (−0.1) |
| C3 ORB published, ATM | conservative | −₹489 (−₹636 … −₹339) | −6.9% | 23% | 0.58 | 0/6 | −₹354 / −₹691 | −₹344 / −₹864 | −₹100 (−1.3) / −₹31 (−0.7) |
| | mid | −₹138 (−₹287 … ₹15) | −2.0% | 27% | 0.85 | 1/6 | −₹74 / −₹234 | −₹78 / −₹294 | −₹19 (−0.2) / −₹26 (−0.6) |
| C3 ORB published, 1 ITM | conservative | −₹551 (−₹713 … −₹385) | −6.4% | 24% | 0.59 | 0/6 | −₹418 / −₹750 | −₹406 / −₹927 | −₹158 (−1.8) / −₹39 (−0.8) |
| | mid | −₹148 (−₹314 … ₹21) | −1.8% | 28% | 0.86 | 1/6 | −₹93 / −₹230 | −₹97 / −₹280 | −₹17 (−0.2) / −₹31 (−0.6) |
| C3 ORB engine window, ATM | conservative | −₹477 (−₹629 … −₹321) | −6.7% | 24% | 0.59 | 0/6 | −₹342 / −₹672 | −₹369 / −₹749 | −₹128 (−1.6) / −₹54 (−0.6) |
| | mid | −₹150 (−₹309 … ₹12) | −2.2% | 28% | 0.84 | 1/6 | −₹53 / −₹292 | −₹99 / −₹280 | −₹39 (−0.5) / −₹44 (−0.5) |
| C3 ORB engine window, 1 ITM | conservative | −₹519 (−₹689 … −₹344) | −6.1% | 25% | 0.61 | 0/6 | −₹385 / −₹713 | −₹414 / −₹785 | −₹140 (−1.6) / −₹63 (−0.6) |
| | mid | −₹147 (−₹322 … ₹34) | −1.8% | 29% | 0.87 | 2/6 | −₹75 / −₹251 | −₹123 / −₹207 | −₹98 (−1.0) / −₹47 (−0.5) |

**SENSEX** (C1 198 trades; C2 420–433; C3 564–658):

| variant | fill | ₹/trade (95% CI) | % of premium | hit | PF | years + | first 60% / last 40% | to Dec 2024 / from 2025 | placebo gaps |
|---|---|---|---|---|---|---|---|---|---|
| C1 first candle → 11:15 | conservative | −₹722 (−₹1,050 … −₹388) | −8.4% | 32% | 0.44 | 0/3 | −₹425 / −₹1,044 | −₹407 / −₹954 | −₹229 (−1.4) / −₹81 (−0.5) |
| | mid | −₹328 (−₹652 … ₹4) | −3.9% | 42% | 0.69 | 0/3 | −₹220 / −₹445 | −₹215 / −₹411 | −₹140 (−0.8) / −₹54 (−0.3) |
| C1 first candle → 15:05 | conservative | −₹761 (−₹1,262 … −₹253) | −8.8% | 29% | 0.58 | 0/3 | −₹569 / −₹969 | −₹459 / −₹983 | −₹442 (−1.6) / −₹265 (−1.1) |
| | mid | −₹446 (−₹953 … ₹71) | −5.3% | 32% | 0.73 | 0/3 | −₹369 / −₹529 | −₹266 / −₹579 | −₹342 (−1.3) / −₹283 (−1.1) |
| C2 noise area, ATM | conservative | −₹271 (−₹550 … ₹18) | −3.8% | 36% | 0.78 | 0/4 | −₹185 / −₹399 | −₹112 / −₹424 | −₹70 (−0.6) / ₹70 (0.7) |
| | mid | ₹9 (−₹276 … ₹303) | 0.1% | 39% | 1.01 | 2/4 | ₹17 / −₹3 | ₹55 / −₹37 | −₹28 (−0.2) / ₹85 (0.9) |
| C2 noise area, 1 ITM | conservative | −₹278 (−₹572 … ₹27) | −3.5% | 37% | 0.79 | 0/4 | −₹193 / −₹405 | −₹113 / −₹438 | −₹58 (−0.4) / ₹74 (0.7) |
| | mid | ₹14 (−₹289 … ₹325) | 0.2% | 40% | 1.01 | 2/4 | ₹7 / ₹24 | ₹46 / −₹18 | −₹144 (−1.1) / ₹89 (0.8) |
| C3 ORB published, ATM | conservative | −₹479 (−₹688 … −₹260) | −6.5% | 22% | 0.59 | 0/4 | −₹381 / −₹624 | −₹353 / −₹605 | −₹165 (−1.5) / −₹20 (−0.3) |
| | mid | −₹151 (−₹361 … ₹72) | −2.1% | 29% | 0.84 | 0/4 | −₹151 / −₹150 | −₹155 / −₹146 | −₹82 (−0.7) / −₹19 (−0.3) |
| C3 ORB published, 1 ITM | conservative | −₹528 (−₹754 … −₹289) | −6.5% | 22% | 0.58 | 0/4 | −₹450 / −₹639 | −₹421 / −₹632 | −₹249 (−2.1) / −₹7 (−0.1) |
| | mid | −₹164 (−₹391 … ₹76) | −2.1% | 29% | 0.84 | 0/4 | −₹198 / −₹115 | −₹204 / −₹125 | −₹45 (−0.4) / −₹6 (−0.1) |
| C3 ORB engine window, ATM | conservative | −₹421 (−₹635 … −₹201) | −5.8% | 25% | 0.63 | 0/4 | −₹435 / −₹401 | −₹420 / −₹421 | −₹113 (−1.0) / ₹74 (0.6) |
| | mid | −₹159 (−₹377 … ₹64) | −2.3% | 28% | 0.84 | 0/4 | −₹269 / −₹3 | −₹273 / −₹42 | −₹19 (−0.2) / ₹53 (0.4) |
| C3 ORB engine window, 1 ITM | conservative | −₹434 (−₹663 … −₹195) | −5.4% | 26% | 0.65 | 0/4 | −₹445 / −₹418 | −₹431 / −₹436 | −₹105 (−0.9) / ₹96 (0.7) |
| | mid | −₹158 (−₹392 … ₹81) | −2.0% | 29% | 0.85 | 0/4 | −₹268 / −₹3 | −₹272 / −₹42 | −₹62 (−0.5) / ₹67 (0.5) |

**Verdict: FAIL for C1, C2 and C3 on both indices, at both fills.** At the conservative fill every buy rule loses money, with the CI wholly below zero in 14 of 16 rows. At the bar close none is positive beyond noise.

1. **No rule picks its side better than chance.** Every gap over a random side at the same minute lies between −1.3 and +0.9 SE.
2. **WP9b's first-candle effect does not survive.** On 21 days it was WP9b's one directional effect: +25 bps from the candle's close. On 363 NIFTY candles over five years the rule's side is *worse* than a random side (−₹207, −1.2 SE). It lost money in every year at the conservative fill and in five of six years at the bar close.
3. **In-the-money strikes do not help.** 1 ITM is within ₹62 of ATM in every pair.
4. **The morning exit does not help.** The first candle closed at 11:15 loses about as much as one held to 15:05.
5. **Real prices are kinder to buyers than WP3 and WP4's model prices, but not kind enough.** At the bar close the noise area is about flat (WP3's model: −₹240 to −₹308 a trade), and the ORB costs about ₹150 a trade (WP4: −₹226 to −₹237). Neither is positive.

---

## 6. When premium is highest, and when not to enter (C6, D1)

### 6.1 The ATM straddle through the day (D1, prices only)

This table uses the B contract's ATM straddle, the strike nearest the index open. Each entry is that straddle at the time shown, divided by the same straddle at the day's 1-minute VWAPs, minus 1 (WP10's "opening richness"). Cells give medians, with the share of sessions above zero in brackets:

| straddle at | NIFTY to Dec 2024 (881 sessions) | NIFTY from Jan 2025 (339) | SENSEX to Dec 2024 (281) | SENSEX from Jan 2025 (320) |
|---|---|---|---|---|
| the exchange's first trade (bhav OPEN) | +7.4% (77%) | +8.7% (79%) | +15.0% (86%) | +11.4% (88%) |
| the dataset's 09:15 bar open | +7.4% (77%) | +6.0% (79%) | +15.0% (86%) | +9.6% (87%) |
| sum of the two legs' 09:15 lows (the conservative sale) | −6.3% (19%) | −2.9% (32%) | −1.3% (44%) | −1.0% (45%) |
| 09:15 bar close | +5.3% (80%) | +4.8% (78%) | +9.2% (86%) | +6.7% (84%) |
| 09:16 | +5.0% (83%) | +4.8% (78%) | +8.2% (87%) | +5.4% (84%) |
| 09:20 | +4.6% (81%) | +4.5% (80%) | +7.2% (88%) | +5.5% (85%) |
| 09:30 | +4.3% (82%) | +3.7% (80%) | +6.2% (85%) | +5.3% (85%) |
| 10:00 | +3.7% (84%) | +4.1% (83%) | +5.5% (88%) | +4.4% (85%) |
| 11:15 | +2.0% (73%) | +2.3% (73%) | +3.0% (79%) | +3.1% (76%) |
| 13:00 | +0.9% (57%) | +0.3% (53%) | +1.7% (61%) | +0.5% (55%) |
| 15:00 | −1.5% (42%) | −1.3% (44%) | −1.6% (42%) | −0.1% (49%) |
| 15:20 | −1.8% (41%) | −1.1% (44%) | −1.5% (44%) | +0.5% (51%) |

- **The straddle is dearest at the first trade.** It loses a quarter (NIFTY) to two-fifths (SENSEX) of that richness within the first minute and keeps falling all morning.
- **From about 13:00 it trades at or below the day's average.**
- These ratios are taken against the day's own average, so they also contain the day's decay and its moves: they say when prices are high, not what a trade would make.

### 6.2 What a buyer pays to hold the ATM straddle for an hour (C6)

The straddle is bought at T and sold 60 minutes later. Cells give the net ₹ per lot, with the gross change as % of premium (before costs) in brackets. DTE ≥ 1 uses contract B; on expiry days (DTE 0) contract A.

**NIFTY**

| buy at | DTE 0 (expiry day), mid | DTE 1, mid | DTE 2–5, mid | all B, mid | all B, conservative |
|---|---|---|---|---|---|
| 09:15 | −₹395 (−4.5%) | −₹358 (−2.5%) | −₹188 (−0.4%) | −₹223 (−0.7%) | **−₹2,176 (−13.1%)** |
| 09:30 | −₹266 (−2.9%) | −₹244 (−1.4%) | −₹150 (−0.2%) | −₹171 (−0.4%) | −₹818 (−4.9%) |
| 10:00 | −₹303 (−3.8%) | −₹193 (−0.9%) | −₹159 (−0.3%) | −₹169 (−0.4%) | −₹720 (−4.3%) |
| 10:30 | −₹220 (−2.4%) | −₹212 (−1.1%) | −₹179 (−0.4%) | −₹186 (−0.5%) | −₹689 (−4.1%) |
| 11:00 | −₹78 (+0.6%) | −₹134 (−0.3%) | −₹153 (−0.2%) | −₹148 (−0.2%) | −₹608 (−3.6%) |
| 11:30 | −₹282 (−4.2%) | −₹107 (0.0%) | −₹122 (0.0%) | −₹119 (0.0%) | −₹582 (−3.4%) |
| 12:00 | −₹261 (−3.9%) | −₹85 (+0.3%) | −₹114 (+0.1%) | −₹109 (+0.1%) | −₹568 (−3.3%) |
| 12:30 | −₹132 (−0.8%) | −₹159 (−0.6%) | −₹155 (−0.2%) | −₹157 (−0.3%) | −₹643 (−3.9%) |
| 13:00 | −₹106 (−0.2%) | −₹164 (−0.6%) | −₹189 (−0.5%) | −₹185 (−0.5%) | −₹687 (−4.3%) |
| 13:30 | −₹296 (−6.2%) | −₹173 (−0.8%) | −₹183 (−0.4%) | −₹183 (−0.5%) | −₹696 (−4.4%) |
| 14:00 | **−₹521 (−15.0%)** | −₹140 (−0.4%) | −₹215 (−0.7%) | −₹203 (−0.7%) | −₹930 (−6.2%) |
| 14:30 (to 15:29) | −₹309 (−9.4%) | −₹270 (−2.0%) | −₹277 (−1.1%) | −₹276 (−1.2%) | −₹697 (−4.5%) |

**SENSEX**

| buy at | DTE 0 (expiry day), mid | DTE 1, mid | DTE 2–5, mid | all B, mid | all B, conservative |
|---|---|---|---|---|---|
| 09:15 | −₹577 (−7.1%) | −₹228 (−1.2%) | −₹464 (−2.1%) | −₹410 (−2.0%) | **−₹2,352 (−13.6%)** |
| 09:30 | −₹338 (−4.0%) | −₹191 (−0.8%) | −₹219 (−0.6%) | −₹213 (−0.6%) | −₹827 (−4.8%) |
| 10:00 | −₹159 (−1.0%) | −₹140 (−0.3%) | −₹180 (−0.4%) | −₹172 (−0.4%) | −₹704 (−4.1%) |
| 10:30 | −₹107 (−0.1%) | −₹218 (−1.2%) | −₹166 (−0.3%) | −₹176 (−0.4%) | −₹638 (−3.7%) |
| 11:00 | −₹111 (−0.2%) | −₹238 (−1.4%) | −₹143 (−0.1%) | −₹166 (−0.3%) | −₹587 (−3.4%) |
| 11:30 | −₹144 (−0.9%) | −₹158 (−0.5%) | −₹115 (0.0%) | −₹128 (−0.1%) | −₹537 (−3.0%) |
| 12:00 | −₹48 (+1.3%) | −₹19 (+1.0%) | −₹150 (−0.2%) | −₹122 (0.0%) | −₹533 (−3.0%) |
| 12:30 | −₹117 (−0.4%) | −₹91 (+0.2%) | −₹160 (−0.3%) | −₹143 (−0.2%) | −₹577 (−3.3%) |
| 13:00 | −₹268 (−4.7%) | −₹180 (−0.8%) | −₹189 (−0.5%) | −₹185 (−0.5%) | −₹605 (−3.6%) |
| 13:30 | −₹353 (−8.1%) | −₹74 (+0.4%) | −₹205 (−0.6%) | −₹175 (−0.4%) | −₹610 (−3.7%) |
| 14:00 | **−₹504 (−15.0%)** | −₹74 (+0.4%) | −₹173 (−0.4%) | −₹154 (−0.3%) | −₹758 (−4.8%) |
| 14:30 (to 15:29) | −₹326 (−10.6%) | −₹312 (−2.4%) | −₹265 (−1.0%) | −₹274 (−1.2%) | −₹745 (−4.7%) |

DTE 6+ has only 3–4 sessions per row and is left out. Samples: NIFTY 259 expiry days, 258 sessions at DTE 1 and 960 at DTE 2–5; SENSEX 142, 140–141 and 490–521.

**The premium-timing headline:**

1. **The first minute is the dearest time to buy and the richest time to sell.** The straddle prints 5–15% above the day's average in the 09:15 minute.
   - Bought then and sold an hour later, it costs ₹2,176 a NIFTY lot and ₹2,352 a SENSEX lot at the conservative fill. That is 2.3–4.4 times any later hour (₹533–930).
   - At the bar close the same hour costs ₹223 (NIFTY) and ₹410 (SENSEX), SENSEX's dearest hour of the day.
   - The 1-minute ranges alone take about 12% of premium on that round trip: 13.1–13.6% at the conservative fill against 0.7–2.0% at the bar close.
2. **After 09:30 an hour's hold costs about the same all day.** At the bar close, with DTE ≥ 1, it costs ₹109–203 a NIFTY lot and ₹122–213 a SENSEX lot (gross −0.7% to +0.1% of premium); most of that is charges, not decay.
   - Midday hours (11:30–13:30) are no dearer than morning ones on these prices.
   - The plan's N3 window (out by 11:15, no entries 11:15–14:15) therefore cuts holding time; it does not dodge an unusually expensive part of the day.
3. **Expiry-day afternoons are the worst time to own premium.** Between 14:00 and 15:00 on expiry day, 15% of the straddle disappears at the bar close (−₹504 to −₹521 a lot) and 34–39% at the conservative fill.
4. **The last half hour costs more than midday.** On both indices, the 14:30–15:29 hold costs −₹274 / −₹276 a lot at the bar close.

**When not to enter (buyers):** the 09:15 minute, an expiring contract after 13:00, and the last hour. These tables show where the drag on a long straddle is largest; none of it creates an edge for a buyer.

---

## 7. The bar, multiple testing and the ledger

- **The ledger.** `reports/trials.jsonl` went from 1,652 to **2,468 lines**. That is 816 WP11 lines (`"wp": "WP11"`): 656 strategy and 160 placebo. No perturbation lines were written, because no variant qualified. The ledger was appended once; rerunning a logged variant adds nothing.
- **Bonferroni:** 0.05 / 2,468 = 2.0 × 10⁻⁵.
  - Bootstraps used 20,000 day-block resamples, rerun at 100,000 for the 57 variants with both lower bounds above zero.
  - The smallest p among the mid-fill variants is 5.7 × 10⁻⁴ (NIFTY A 09:15 → 15:00, +30% stop).
  - Only the SENSEX first-print reference rows reach Bonferroni's level. Selling at the first trade is not an order anyone can place.
- **The deflated Sharpe ratio:** V[SR] over this study's C1–C5 lines is 0.142, so SR₀ = 1.32 per session.
  - That variance is dominated by the deeply negative conservative-fill variants, and it makes every DSR 0.00.
  - With the null variance 1/(T − 1), the best mid-fill variant reaches 0.41 and the best first-print reference row 0.93. Nothing reaches 0.95.
- **At the conservative fill** (the verdict case; 256 C1–C5 variants):
  - No variant has a CI above zero, a PF above 0.79 or every year positive, so none reached the robustness step.
  - Every one fails at least six of the nine criteria.
  - Two NIFTY iron flies entered at 11:15 beat their placebo, only because random entry times lose even more.
- **At the bar close** (256 variants):
  - 32 have both CIs above zero, all of them C4 sales at 09:15–09:16.
  - None passes Bonferroni, and every variant fails at least two criteria.

---

## 8. What changed after the freeze

1. **No definition changed.** A development run without the ledger and the final run with `--ledger` gave byte-identical tables. Both used the code committed at the freeze, plus items 2 and 3 below, which change no number.
2. **A `debug` command** prints one session's inputs and a few trades in full. It was used to check fills by hand: NIFTY on 14 Jun 2023 (§3.2) and SENSEX on 12 Mar 2025 both reproduce from the raw bars.
3. **`summary.json` gained the era statistics and a few totals.** These are for reporting only.
4. **The first-print reference was also computed for the iron fly** (24 variants, logged). §1.2 defines the print fill for any 09:15 sale, but §1.3's C5 row does not list it. These variants are measurements, like C4's.
5. **The verification was rerun after the freeze, with zero-volume bars dropped as §1.1 defines.** §2's tables did not change.
   - The month-by-month anatomy in §2 comes from the first run, which included zero-volume bars. Those bars exist only from 2025 and are 0.6% of the rows.
   - The anatomy rerun was stopped to free memory.
6. **One number in §2's summary sentence was corrected after the freeze.** It said the first trade is missing on "83–85%" of ATM contract-days from 2025; the by-year table below it gives 82.9–86.0%, so it now reads 83–86%. Nothing else in §1–§2 changed.

---

## 9. What would settle the remaining question

The one open question is WP10's, now pinned to one minute: can the opening premium be sold, and at what spread? Trade bars cannot answer it. A shadow recorder can, without placing any orders:

1. **Record quotes.** Log the best bid and ask, with sizes, for the ATM call and put and the ±1 EM wings of contracts A and B on both indices. Log them every second from 09:15:00 to 09:17:00, and at 15:00 and 15:20.
2. **Compare after about 60 sessions.** Set the bid during 09:15:00–09:15:59 against the first print and against the minute's close. The mid-fill edge is 1.1–3.0% of premium, so it survives only if the bid sits within about 0.5–1.5% of premium of the close.
3. **Only if it does, paper-test a frozen C4-style rule under §12:** a 09:15 sale, a +30% stop, a buy-back at 15:00–15:20 and one lot, with the tails of §3.4. That test would need about 180 sessions, and N will be higher by then.

Until then the plan's §13 stands: no real money, and no paper test of selling or of buying.

---

## 10. Reproduce

```bash
S=<scratchpad>; X=$S/wp11/data/x
# 1. Download (sha256-checked; 1.3 GB) at revision 0f4800e4 (file lists from the HF tree API):
#    index/{NIFTY,SENSEX}.parquet, options/NIFTY/*.parquet (267), options/SENSEX/*.parquet (148)
# 2. Extract (untrusted input: python3 -I with a vendored pyarrow/pandas; ~25 min; 610 MB of csv.gz):
python3 -I scripts/research/wp11_extract.py --pylib <pyarrow+pandas dir> --raw <download dir> \
    --daily <bhavcopy cache>/index-daily.json --out $X
python3 -I scripts/research/wp11_dupcheck.py --pylib <dir> --raw <download dir>    # repeated rows never conflict
# 3. Verification against the bhavcopies and Yahoo (section 2; ~8 min):
npx tsx scripts/research/wp11-real-intraday.ts verify  --x $X --dir <bhavcopy cache> --hourly $S/dl/y1h --out reports/wp11
npx tsx scripts/research/wp11-real-intraday.ts anatomy --x $X --dir <bhavcopy cache> --out reports/wp11
# 4. Every candidate, the placebos, the bar and the tables (sections 0 and 3-7; ~15 min, 8 GB heap):
NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/research/wp11-real-intraday.ts run --x $X --dir <bhavcopy cache> --out reports/wp11 [--ledger]
# 5. One session by hand:
npx tsx scripts/research/wp11-real-intraday.ts debug --x $X --dir <bhavcopy cache> --index NIFTY --day 2023-06-14
# 6. Unit tests of the pure helpers:
npx vitest run src/engine/backtest/intraday1m.test.ts
```

| file | what it holds |
|---|---|
| `scripts/research/wp11_extract.py` | The extractor: the A and B weeklies, ATM ± 6 strikes plus the wings, 1-minute bars, and per-file data checks written to `manifest.json` |
| `scripts/research/wp11_dupcheck.py` | The check that repeated rows are exact copies |
| `scripts/research/wp11-real-intraday.ts` | The `verify`, `anatomy`, `run` and `debug` commands: the candidates, placebos, statistics, the bar, the ledger and the tables |
| `src/engine/backtest/intraday1m.ts` (+ `.test.ts`) | The pure helpers, with tests: minute series with gap-aware lookups, fills, n-minute bars, windowed VWAP, multi-leg positions with a combined-premium stop, strike pickers, the paired placebo gap, the ±20% time perturbation and the walk-forward split |

- **Reused code.** The published rules run through the engine's own `firstCandlePlan`, `noiseAreaDecision` and `orb5Plan`, unchanged. Charges, structure P&L, wings and tail statistics come from WP10's `shortPremium.ts`; the bootstrap and the DSR from `metrics.ts`.
- **Isolation.** Nothing in the engine imports the new code.
- **Data.** No market data is committed. `reports/wp11/` (the generated tables and summary JSON) is gitignored.
