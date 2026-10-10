# WP16: weekly bull put spreads held to expiry, and the turn of the month, on NIFTY and SENSEX

Sat 10 Oct 2026. Branch `worktree-agent-abe2d9bacd1d2479a`, fast-forwarded to `38021fb` (head of `claude/gifted-wright-3d8r3j`). Analysis only: no paper trading, no deploys, no pushes; nothing in the engine changes.

**Data and licence.**
- **Exchange files:** the compact NSE and BSE F&O bhavcopy cache (NSE from 11 Feb 2019, BSE daily from 15 May 2023, both to 8 Oct 2026): closing prices, settlement prints, lots, listed expiries and strikes, near-month futures.
- **Index and India VIX:** Yahoo's daily ^NSEI, ^BSESN and ^INDIAVIX bars (Q2's download of 9 Oct 2026, before the open; the last bar is 8 Oct 2026).
- **1-minute prices:** the Hugging Face dataset **"India Index & Options – 1-minute OHLC" by TradeMarkk** (`thetrademarkk/india-index-options-1m`, revision `0f4800e43e6f96cec0794369d78eb4d3c4211ef5`, https://huggingface.co/datasets/thetrademarkk/india-index-options-1m), licensed **CC-BY-NC-4.0**: non-commercial research use only, attributed here. WP11 §2 verified it against the exchanges' own files. This study reads WP13's extract of it.
- **NSE's participant-OI archive** (WP14's download): its file names only, as a list of NSE sessions.
- Nothing was downloaded for this study. No raw or extracted data is committed (the repository is public); the scripts rebuild everything from the downloads.

**Status of this file:** §1 and §2 were written and committed before any premium-derived P&L, credit, win rate or conditional return was computed. The results follow in a later commit. §1 and §2 stay byte-identical; every later change or error is recorded in a "What changed after the freeze" section.

---

## 1. Frozen definitions (pre-registered before any premium-derived P&L, credit, win rate or conditional return)

### 1.0 The questions, and what was known before

- **H1, the main hypothesis.** Out-of-the-money index puts are priced richer than calls (the volatility skew), and the index drifts up. So a weekly defined-risk **bull put spread**, held to expiry, may earn the put premium with a capped tail. The spread sells an out-of-the-money put and buys a further out-of-the-money put on the same expiry. This also answers the owner's question: "which option to enter now and wait till expiry for the most benefit".
- **H2, the secondary hypothesis.** The turn of the month (TOM), R6 §2's one remaining untested candidate.
- **What the program already knew.** None of it measured the put side on its own; the ledger has no bull put spread, put credit spread or skew trade.
  - WP10 sold only symmetric premium. A naked strangle one expected move out, held to expiry, made +₹620 a NIFTY lot a week (N = 1), with single weeks of −₹46,000 to −₹93,000 in March 2020. With wings at 2 EM (an iron condor) the gain disappeared (−₹25 a week). WP10 did not report the put leg on its own.
  - WP15: NIFTY rose overnight, +10.2 bp a night since 2011, fading since 2025.
  - R6 §3: the only cost-inclusive Indian test of monthly put-writing (Pillai 2026, 119 monthly cycles) was negative after costs. The US PUT index earns a long-run premium, gross of trading costs.
  - The plan (§2, §5; R2): far out-of-the-money options carry the richest premium per rupee.
- **The expected sign.** A naked short put is expected to earn (WP10's strangle). Whether a vertical spread keeps any of that after its long leg and its costs is the open question.
- **The sample-size limit, stated before any result.**
  - Weekly NIFTY options start in Feb 2019: 398 usable weekly expiries to Oct 2026 (§2), so the last 40% holds 159. Weekly SENSEX in the data starts in May 2023: 171 usable expiries, 68 in the last 40%. On the 1-minute data: NIFTY 102 and SENSEX 54.
  - **So no H1 pick can reach the bar's 180 out-of-sample trades.** The best verdict an H1 pick can get is INSUFFICIENT ("FAIL: sample").
  - TOM has about 230 windows per index, about 92 of them out of sample: it cannot pass either.
  - Both are reported in full anyway, with their economics.

### 1.1 Data and sessions

- **The calendar** is every date with a complete Yahoo bar of either index (from 2 Jan 2007), an NSE or BSE bhavcopy, an NSE participant-OI file, or a Muhurat session. This is WP15's construction, extended back to 2007.
- **Special sessions** are never an entry, an exit or a turn-of-the-month day:
  - weekend sessions (Saturday and Sunday dates in the calendar, such as the Budget Saturdays);
  - NSE's Diwali Muhurat sessions, 2007–2025 (WP15's list, with 9 Nov 2007, 28 Oct 2008, 17 Oct 2009 and 5 Nov 2010 added);
  - the bhavcopy's short sessions (WP6's rule: NIFTY option volume below 0.3× the quietest of the three sessions on either side).
  - Every other date of the calendar is a **regular session**. A special session inside a holding period is simply held through: its price change is part of the trade.
- **Sessions to expiry (N)** count regular sessions of this calendar, for both indices. The entry is the N-th regular session before the expiry. A session without the index's own bhavcopy (NSE: 30 Mar 2021; BSE: seven sessions, §2.1) cannot be an entry or an exit for that index.
- **Index level:** the official close. That is NSE's UndrlygPric in the UDiFF bhavcopy (NIFTY, from 8 Jan 2024), else Yahoo's close.
- **India VIX:** Yahoo's ^INDIAVIX close of the last day strictly before the entry session. It is known before the session opens; no intraday VIX is used, by either family.
- **Lot:** the modal lot of the contract's bhavcopy rows on the entry day. Lots changed over the sample (NIFTY 75 → 50 → 25 → 75 → 65; SENSEX 10 → 20).

### 1.2 Expiries and settlement

- **Weekly expiries are the exchange's own.** For every regular session with the index's bhavcopy, the nearest listed expiry on or after it (WP10's rule).
  - The listed dates carry every holiday shift and every change of the expiry weekday (NIFTY Thursday → Tuesday from Sep 2025; SENSEX Friday → Tuesday → Thursday). So no weekday rule is assumed.
  - `expiryCalendar.ts` supplies the cut, the pick, the robustness rule and the verdict. The engine's `TradingCalendar.expiryOnOrAfter` is not used: it assumes one fixed weekday per index, so it cannot reconstruct 2019–2025.
  - An expiry date that is not a regular session (a contract re-dated after a holiday was declared) is skipped.
- **Settlement** is in cash, at each leg's intrinsic value at the final settlement level.
  - That level is the exchange's printed final settlement price: the median printed settle on that day's expiring options (NSE's SttlmPric, BSE's expiry-day Close; WP10's `settlementLevel`). By exchange rule it is the index's official close on the expiry day.
  - Where the exchange prints none (NSE's legacy files of Feb 2019 – Jan 2020 print 0), the official close (§1.1) is used.
  - The two agree to 0.00 points wherever both exist (§2.2).

### 1.3 Samples and the walk-forward split

- **Eligible expiries, family D (daily closes):** weekly expiries x that are regular sessions, with at least five regular sessions before x in the calendar, with the index's own bhavcopy on x and on each of the four regular sessions before it, and with a settlement level.
- **Eligible expiries, family M (1-minute bars):** the same, and also:
  - x within the 1-minute data;
  - each of the four sessions before x a valid 1-minute session (WP11 §1.1: at least 370 index bars from 09:15 to 15:29 with a 09:15 bar, the index's bhavcopy, not special);
  - the contract x in the extract on each of those four sessions.
- **The cut**, per family and index: the last expiry of the first ⌈0.6 n⌉ eligible expiries (`cutDate`). A trade belongs to the half of its expiry. Every configuration of a family and index shares the cut and the eligible expiry weeks. The cuts are in §2.3; they depend only on which expiries have data.
- **One trade per expiry per configuration.** The entry days N = 2, 3 and 4 of one expiry are separate configurations and are never pooled into one variant. So "a trade" is one position on one expiry, and the sample is not inflated.

### 1.4 H1: structures, strikes, entries, exits, fills and costs

- **Expected move to expiry:** EM = S × VIX/100 × √(N/252), with S the index level at the order and VIX the India VIX close before the entry session (§1.1).
  - The expected move comes from India VIX, not the ATM straddle: WP10 used India VIX, and it is known for every session independently of the option data.
- **The bull put spread** (the strategy), m expected moves out of the money:
  - **short put:** the strike strictly below S that traded on the entry day nearest S − m·EM (a tie goes to the strike nearer S);
  - **long put:** the traded strike strictly below the short one nearest (short strike − 0.5·EM) (a tie goes to the strike nearer the short one);
  - **width = 0.5 EM**, the brief's alternative to 1 and 2 strike steps. One width keeps the grid within the brief's limit of about 60 configurations. It also scales with the index level and with volatility (NIFTY moved from about 11,000 to 26,000 over the sample);
  - "traded" means contracts > 0 and a closing price in the entry day's bhavcopy.
- **The mirror bear call spread** (the placebo's other side): the short call is the traded strike strictly above S nearest S + m·EM; the long call is the traded strike strictly above it nearest (short strike + 0.5·EM).
- **Both sides must be priced** for an expiry to count, because the placebo needs the mirror.
- **Configurations**, per index and family: m ∈ {0.5, 1.0, 1.5} × N ∈ {2, 3, 4} × management ∈ {hold, early}, so 18.
  - **hold:** held to cash settlement (§1.2). There is no exit order; the long leg pays exercise STT on its intrinsic value when it finishes in the money.
  - **early:** closed on the session before expiry. Family D does so at that session's closing price (the daily stand-in for 15:20); family M at 15:20 on the 1-minute bars.
- **Family D (daily closes):** NIFTY 2019–2026, SENSEX 2023–2026.
  - Entry at each leg's closing price on the entry session (NSE: the VWAP of the last 30 minutes; BSE: the published close). The index level S is the official close of that session.
  - Early exit at each leg's closing price on the session before expiry. A leg that did not trade that day exits at its printed close anyway (counted). Without a printed close the trade is not booked (counted).
- **Family M (1-minute bars, 15:20):**
  - The order goes in at **15:20**. S is the close of the index bar before it (15:19).
  - A spread fills as a combination order: both legs in the first minute in [15:20, 15:22] in which both traded (`spreadEntry`). Without such a minute there is no trade (counted).
  - Early exit at 15:20 on the session before expiry: both legs in the first common minute in [15:20, 15:25]; else each leg at its last close at or before 15:20 (a stale exit, counted); without any bar, no trade (counted) (`spreadExit`).
  - Strikes are chosen from the bhavcopy's traded strikes of the entry day, exactly as in D. A chosen leg without 1-minute bars on the entry day means no trade (counted).
- **The M coverage rule** (bar presence only; decided before any price is read; §2.4):
  - An M cell (m, N) runs only if both spreads' legs share an entry minute on at least 90% of its eligible expiries.
  - The reason: the extract keeps only strikes within about 2.6 daily expected moves of the recent index range, so far-out cells are thin, and the weeks a thin cell misses are the weeks after the index moved (a selection bias).
  - §2.4 lists the 11 cells that run and the 7 that do not. That gives 36 (D) + 22 (M) = **58 configurations** in all.
- **Fills.** The verdict is decided at the conservative fill; the mid fill is reported beside it.
  - *D conservative:* sell at the close minus the engine's full spread, max(1 tick, 0.4% of premium) rounded up to whole ticks, and buy at the close plus it. The spread is paid in full on every order: WP10's 2× spread (`scaledSpread(2)` in `structurePnl`).
  - *D mid:* the closing price, with no spread.
  - *M conservative:* a sell fills at the 1-minute bar's low and a buy at its high (WP11). *M mid:* the bar's close. No further spread on either.
  - The daily closing price is a 30-minute average, not a price anyone traded at; the M family tests the same rule at a traded minute.
  - On a two-leg spread the M conservative fill charges both legs the minute's whole range. It is a hard bound, not an estimate of a real fill (WP11 §3.2).
- **Charges**, through `structurePnl` and `RESEARCH_CHARGE_SCHEDULES`, at the rates in force on each order's date:
  - STT on option sales: 0.05% → 0.0625% (1 Apr 2023) → 0.1% (1 Oct 2024) → 0.15% (1 Apr 2026) of premium;
  - STT on a long leg that finishes in the money: 0.125% of its intrinsic value (0.15% from 1 Apr 2026);
  - ₹20 brokerage per order; dated exchange charges (NSE for NIFTY, BSE for SENSEX); SEBI fee, stamp duty on buys, IPFT and 18% GST.
  - One lot per trade, at the lot in force.
- **Filters:** none. Weeks with scheduled events are traded, and reported separately.

### 1.5 Statistics

- **Units:** net ₹ per lot per trade, one trade per expiry. The per-week series counts every eligible expiry week of the window; a week without a trade counts as ₹0.
- **Bootstrap, clustered by expiry week** (the ISO week of the expiry, so positions that overlap in one week stay together): `dayBlockBootstrap` over `blocksOf`, one block per eligible week, per trade and per eligible week. 20,000 resamples (100,000 when both lower bounds are above zero), seed 7. One-sided p = (1 + #{resamples ≤ 0}) / (1 + resamples).
- **The placebo:** a fair coin between the bull put spread and its mirror bear call spread, at the same m, width, N, entry, exit and fill.
  - Its exact expectation in a week is (put spread + call spread) / 2: the generic short-premium return.
  - So the gap is (put spread − call spread) / 2, averaged over trades, with a standard error clustered by expiry week (`pairedGap`).
  - A gap above zero says the gain is specific to the put side. A gap of zero says it is just short premium.
- **Reported for every configuration, both sides and both fills:**
  - trades, the mean, its CI, PF and the win rate;
  - the average credit (₹ per lot at the fills), credit ÷ width, and payout ÷ width (what the spread was worth at the exit, ÷ its width);
  - the share of trades whose short strike finished in the money, and whose full width was lost;
  - the average win and the average loss, and each leg's gross;
  - the first 60% and the last 40%, the two halves, and calendar years (the ₹5 lakh account's yearly net at one lot);
  - before and from 1 Apr 2026 (the STT rise); for M, the two data eras (complete bars to Dec 2024; sampled bars from 2025);
  - scheduled events in the holding period (WP10 §1.6's Budgets, RBI decisions and election results).

### 1.6 The bar (plan §12), per pick

- **The picks:** per family (D, M), index, management (hold, early) and fill, the (m, N) with the highest mean net ₹ per trade of the bull put spread on the first 60% (`pickBest`, ties by name). It is then judged untouched on the last 40%. There are 16 picks; the 8 at the conservative fill decide the verdicts.
- **The criteria**, on the last 40%:
  1. **At least 180 trades.**
  2. **Placebo gap at least 2 SE** (§1.5).
  3. **Expiry-week-clustered 95% CI above zero**, per trade and per eligible week.
  4. **PF ≥ 1.3.**
  5. **±20% robustness**, run only for picks that pass 2–4:
     - m × 0.8 and × 1.2;
     - N − 1 and N + 1 (one session either way; never below 1, or below 2 for an early exit);
     - the width × 0.8 and × 1.2 (0.4 and 0.6 EM);
     - for M, also the entry minute and (early) the exit minute at 15:18 and 15:22 (their distance to 15:30 × 1.2 and × 0.8). The later minute also stands for copying by hand a few minutes late.
     - **Every** perturbation's last-40% net must be above zero. The program's rule must hold as well: at least 80% positive and the worst no lower than base − 50% × |base| (`robustness`).
  6. **Multiple testing:**
     - Bonferroni: the larger of the per-trade and per-week bootstrap p-values below 0.05 / N, where N is the number of lines in `reports/trials.jsonl` after this study's lines are appended (3,067 before);
     - **and** the deflated Sharpe ratio of the last 40%'s per-week returns (net ÷ ₹5 lakh) at least 0.95. N comes from the ledger. V[SR] is the larger of this study's bull-put-spread lines' Sharpe variance (`sharpeVariance`, as WP15 did) and the null variance 1/(T − 1), so it is never looser than WP15's rule. The null-variance DSR is reported too.
  7. **Family M only, the complete-bar era:** the trades to Dec 2024, in and out of sample, have a mean above zero with a CI above zero.
- **Verdicts** (`overallVerdict`):
  - *PASS* when every criterion passes;
  - *INSUFFICIENT* ("FAIL: sample") when the sample size is the only failure;
  - *FAIL* otherwise. A criterion not run because an earlier one failed counts as a failure.
  - A family that fails at the conservative fill but passes at mid is *mid only*: not actionable without quotes.
- **A paper-test spec is written only for a pick that passes every criterion.** Given criterion 1 (§1.0), none can.

### 1.7 H2: the turn of the month

- **One definition (R6 §2, [C10]).** The window is the month's last regular session (T−1) and the next month's first three regular sessions (T+1, T+2, T+3).
  - The trade is long the index from the close of the session before the window (T−2) to the close of T+3: four close-to-close days, on Yahoo's official closes.
  - NIFTY from Sep 2007, SENSEX from Jan 2007, up to the last window that ends by 8 Oct 2026.
  - A window without a complete bar at its start or its end is skipped (counted).
- **Against the other days.** Each regular session's close-to-close return (from the previous regular session; both bars complete) is either a window day or another day.
  - **The placebo gap** is the mean daily return on window days minus the mean on the other days, × 4 (one window), with a circular block bootstrap of the daily series in blocks of 21 sessions, about a month (`meanGapBootstrap`).
- **The cut**, per index: the last window end of the first ⌈0.6 n⌉ windows. The last 40% is the windows, and the days, after it.
- **The bar:** §1.6's criteria 1–4 and 6 on the last 40%. The CI is per window, each window a block. V[SR] is the larger of the TOM index lines' variance and the null variance.
  - Criterion 5 uses the windows [−1, +2] and [−2, +3], and runs only when criteria 2–4 pass.
  - **About 230 windows give about 92 out of sample, below 180, so TOM cannot pass** (§1.0).
- **The near-month future (descriptive).** The nearest futures contract expiring on or after the window's last session, traded (contracts > 0, a closing price) at the window's start and end.
  - ₹ per lot = (its close at T+3 − its close at T−2) × lot, net of the dated STT on the sale: 0.01% → 0.0125% (Apr 2023) → 0.02% (Oct 2024) → 0.05% (Apr 2026) of notional (WP15's rates).
  - Other futures charges, the spread and the margin are not modelled.
  - NIFTY from Feb 2019 (NSE), SENSEX from May 2023 (BSE).
- **No option trade is built on TOM.**

### 1.8 Tails, capital and margin (reported for every pick)

- **Tails:**
  - the 10 worst trades (expiry, entry, net ₹, index move, strikes, lot, credit);
  - the 5% and 1% value at risk and expected shortfall (`tailRisk`);
  - the maximum drawdown of cumulative ₹ at one lot a week, in expiry order, also as % of ₹5 lakh;
  - the longest losing run, and the worst 5% of trades summed as a multiple of the net;
  - how often the full width was lost;
  - the worst mark-to-market at a close between entry and exit (bhavcopy closes, before costs): what a margin call sees.
- **Named stress dates:** every trade whose holding period (after the entry, up to the exit) contains 9, 12, 16 or 23 Mar 2020 (the COVID crash), 4 Jun 2024 (the election result) or 7 Apr 2025 (the tariff gap). Reported for every pick and for the D hold configurations at m = 1.0 (conservative fill).
- **Margin**, WP10 §6's approximation (`spreadMargin`): SPAN ≈ width × lot, plus exposure margin of 2% of the short leg's notional (index × lot), plus another 2% when held into the expiry day from 20 Nov 2024 (SEBI's circular of 1 Oct 2024).
  - Also the maximum loss, width × lot − credit.
  - Whether a ₹10,000 account and a ₹5 lakh account could carry one lot is read from these (the smallest and the peak margin).
- **Every rupee figure is per lot in force on the entry day.** Lots changed over the sample, so rupee figures by year are not comparable without scaling.

### 1.9 Cross-check and ledger

- **The cross-check** (`scripts/research/wp16-xcheck.py`, standard library only, run with `python3 -I`) rebuilds from the raw files:
  - the calendar, the expiries, the settlement levels, the samples and the cuts;
  - every D and M configuration's trades: strikes, fills, charges and net;
  - the TOM windows and the daily means.
  - It compares them with the main script's `summary.json`.
- **The ledger** (`reports/trials.jsonl`), each line with `"wp": "WP16"` and a unique name:
  - one line per bull put spread configuration and fill (kind "strategy", or "perturbation");
  - one per mirror bear call spread (kind "placebo");
  - one per TOM index variant (strategy or perturbation), and one per TOM futures line (descriptive). The TOM index lines carry `net` and `meanPerTrade` in index basis points, not rupees (`params.unit` says so).
  - They are written once, in the final `--ledger` run. A rerun appends nothing.
- **The development run and the final `--ledger` run must give byte-identical tables** (`tables.md` and `summary.json`; both carry the ledger count after appending).

### 1.10 Tested before this freeze

- The `coverage` command: sessions, expiries, the settlement agreement (index levels only), the strike choice (index level, VIX and which strikes traded: no premium), bar presence and counts. No option price, credit, P&L or index return.
- A `--smoke` run of the whole pipeline (statistics, verdicts, tables), without the ledger. Every price-derived value was replaced by a deterministic synthetic number (an FNV-1a hash of its key): option prices and fills, settlement levels, index and futures returns. It prints counts only.
- A second smoke run with `--smoke-bias 0.05`, which tilts the synthetic numbers towards the put side and the TOM days, so that the ±20% robustness paths run too (115 perturbation runs and 4 TOM perturbations, all finite). Synthetic numbers only, and no ledger.
- `wp16-xcheck.py --counts-only`: the cross-check's calendar, expiries, samples, cuts and per-cell counts, without any price, compared with §2. They agree on the calendar (4,895 sessions, 4,865 regular), the four samples and cuts, all 36 per-cell entry counts of §2.4, and the TOM window counts, cuts and day counts of §2.5.
  - One difference was found and fixed in the cross-check before this freeze: it had counted BSE's two header-only files (28 Jun and 25 Jul 2023) as bhavcopies. The main script does not, so D SENSEX has 171 eligible expiries, not 173.
- Unit tests of the new pure helpers (`src/engine/backtest/putSpreads.test.ts`).

---

## 2. Data and samples (before any P&L)

Everything in this section comes from sessions, expiries, the strike choice (the index level, India VIX and which strikes traded), trade presence and bar presence (`wp16-put-spreads.ts coverage`). No option price, credit, P&L or index return entered it.

### 2.1 Calendars

- **The calendar:** 4,895 sessions, 2 Jan 2007 – 9 Oct 2026. They come from complete Yahoo bars of either index (from 2007), the NSE bhavcopy (11 Feb 2019 – 8 Oct 2026, 1,897 files), the BSE bhavcopy (15 May 2023 – 8 Oct 2026, 839 daily files), 3,658 NSE participant-OI file dates and the Muhurat days.
- **Regular sessions:** 4,865. **Special sessions:** 30.
  - Muhurat: 9 Nov 2007, 28 Oct 2008, 17 Oct 2009, 5 Nov 2010, 26 Oct 2011, 13 Nov 2012, 3 Nov 2013, 23 Oct 2014, 11 Nov 2015, 30 Oct 2016, 19 Oct 2017, 7 Nov 2018, 27 Oct 2019, 14 Nov 2020, 4 Nov 2021, 24 Oct 2022, 12 Nov 2023, 1 Nov 2024 and 21 Oct 2025.
  - Weekend and drill sessions: 7 Jan, 3 Mar and 8 Sep 2012; 22 Mar 2014; 28 Feb 2015; 1 Feb 2020; 20 Jan, 2 Mar and 18 May 2024; 1 Feb 2025; 1 Feb 2026.
- **Regular sessions without the index's own bhavcopy:**
  - NSE (from 11 Feb 2019): 1, on 30 Mar 2021.
  - BSE (from 15 May 2023): 7, on 28 Jun and 25 Jul 2023 (the cache holds header-only files for these two); 2 Aug, 29 Aug and 29 Nov 2024; 10 Feb and 2 Sep 2025.
- **India VIX** (Yahoo): 4,557 closes, 3 Mar 2008 – 8 Oct 2026.

### 2.2 Weekly expiries and settlement

The exchanges' own listed expiries. Every holiday shift and change of weekday is the exchange's.

| year | NIFTY expiries | NIFTY by weekday | SENSEX expiries | SENSEX by weekday |
|---|---|---|---|---|
| 2019 (from 14 Feb) | 46 | Thu 44, Wed 2 | – | – |
| 2020 | 53 | Thu 52, Wed 1 | – | – |
| 2021 | 52 | Thu 48, Wed 4 | – | – |
| 2022 | 52 | Thu 51, Wed 1 | – | – |
| 2023 | 53 | Thu 50, Wed 3 | 33 (from 19 May) | Fri 33 |
| 2024 | 52 | Thu 50, Wed 2 | 52 | Fri 47, Thu 5 |
| 2025 | 53 | Thu 33, Wed 2, Tue 17, Mon 1 | 52 | Fri 1, Tue 34, Thu 15, Wed 2 |
| 2026 (to 8 Oct) | 40 | Tue 37, Mon 3 | 42 | Thu 39, Wed 3 |
| **all** | **401** (14 Feb 2019 – 6 Oct 2026) | | **179** (19 May 2023 – 8 Oct 2026) | |

- **The changes of weekday:** NIFTY expired on Thursdays until 28 Aug 2025 and on Tuesdays from 2 Sep 2025. SENSEX expired on Fridays in 2023–2024, on Tuesdays from Jan 2025 and on Thursdays from Sep 2025. Wednesday and Monday expiries are holiday shifts.
- **Consecutive expiries** are usually 5 sessions apart. The shortest gaps are 2–3 sessions (holiday weeks and the weekday changes); the longest is 6 (SENSEX's move from Tuesday to Thursday).
- **Two listed expiry dates are not sessions** and are skipped: NIFTY 29 Jun 2023 (Bakri Id; the contract was re-dated to 28 Jun) and SENSEX 15 Jan 2026.
- **Settlement levels:**
  - NIFTY: the exchange's printed level on 349 expiries, the official close on 51 (NSE's legacy files of Feb 2019 – Jan 2020).
  - SENSEX: the printed level on 176, the official close on 2.
  - Wherever both exist (349 and 176 expiries), they agree to 0.00 points.

### 2.3 Samples and the walk-forward cuts

| family | index | candidate expiries | skipped | eligible expiries | first / last | **cut after** | first 60% / last 40% | last 40% to Dec 2024 / from 2025 | last 40% by year |
|---|---|---|---|---|---|---|---|---|---|
| D | NIFTY | 401 | 2 without a bhavcopy on x−4 … x; 1 not a session | **398** | 21 Feb 2019 / 6 Oct 2026 | **21 Sep 2023** | 239 / **159** | 66 / 93 | 2023 14, 2024 52, 2025 53, 2026 40 |
| D | SENSEX | 179 | 7 without a BSE file on x−4 … x; 1 not a session | **171** | 19 May 2023 / 8 Oct 2026 | **10 Jun 2025** | 103 / **68** | 0 / 68 | 2025 27, 2026 41 |
| M | NIFTY | 268 | 7 with an invalid 1-minute session on x−4 … x−1; 5 with the contract missing from the extract; 1 not a session | **255** | 3 Jun 2021 / 19 May 2026 | **16 May 2024** | 153 / **102** | 32 / 70 | 2024 32, 2025 50, 2026 20 |
| M | SENSEX | 153 | 5 without a BSE file; 9 with the contract missing from the extract; 3 with an invalid 1-minute session; 1 not a session | **135** | 11 Aug 2023 / 21 May 2026 | **25 Mar 2025** | 81 / **54** | 0 / 54 | 2025 34, 2026 20 |

- **Skipped expiries by date:**
  - D NIFTY, no bhavcopy on x−4 … x: 14 Feb 2019 (x−4 is before the first file) and 1 Apr 2021 (30 Mar 2021 missing).
  - D SENSEX, no BSE file on x−4 … x: 30 Jun 2023, 28 Jul 2023, 2 Aug 2024, 30 Aug 2024, 29 Nov 2024, 11 Feb 2025 and 4 Sep 2025.
  - M NIFTY, an invalid 1-minute session: 27 May 2021, 10 Mar 2022, 30 Sep 2025, 14 Oct 2025, 26 May, 2 Jun and 9 Jun 2026. The contract missing from the extract: 3 Nov 2021, 20 Oct 2025, and 16, 23 and 30 Jun 2026.
  - M SENSEX, no BSE file: 2 Aug 2024, 30 Aug 2024, 29 Nov 2024, 11 Feb 2025 and 4 Sep 2025. The contract missing: 31 Oct 2024, 30 Oct 2025, 14 Jan 2026, 27 May, 4, 11, 18 and 25 Jun, and 2 Jul 2026. An invalid 1-minute session: 1 Oct, 16 Oct and 6 Nov 2025.

### 2.4 Per configuration: entries with every leg priced, strike placement, lots and margin

"Priced" means all four legs (the bull put spread and the mirror bear call spread) traded on the entry day (D), or both spreads' legs share an entry minute in [15:20, 15:22] (M). The counts are for hold. The early-exit column says whether the exit day has every leg.

| family | index | m | N | priced at entry (of eligible) | share | early exit: priced (D: with an untraded leg) / M: every leg has a bar by 15:25 | \|short strike − target\| ÷ EM, median (share > 1 strike step) | put width ÷ EM, median | margin at entry, median / max |
|---|---|---|---|---|---|---|---|---|---|
| D | NIFTY | 0.5 | 2 | 397 / 398 | 99.7% | 397 (0) | 0.052 (0.0%) | 0.507 | ₹25,370 / ₹52,239 |
| D | NIFTY | 0.5 | 3 | 397 | 99.7% | 397 (0) | 0.040 (0.0%) | 0.496 | ₹27,103 / ₹59,887 |
| D | NIFTY | 0.5 | 4 | 396 | 99.5% | 396 (0) | 0.035 (0.0%) | 0.497 | ₹28,269 / ₹59,020 |
| D | NIFTY | 1.0 | 2 | 397 | 99.7% | 397 (0) | 0.046 (0.0%) | 0.507 | ₹25,370 / ₹52,239 |
| D | NIFTY | 1.0 | 3 | 397 | 99.7% | 397 (0) | 0.041 (0.0%) | 0.496 | ₹27,103 / ₹59,887 |
| D | NIFTY | 1.0 | 4 | 396 | 99.5% | 396 (0) | 0.032 (0.0%) | 0.497 | ₹28,269 / ₹59,020 |
| D | NIFTY | 1.5 | 2 | 397 | 99.7% | 397 (0) | 0.049 (0.0%) | 0.506 | ₹25,365 / ₹52,239 |
| D | NIFTY | 1.5 | 3 | 396 | 99.5% | 396 (0) | 0.038 (0.0%) | 0.496 | ₹27,098 / ₹59,887 |
| D | NIFTY | 1.5 | 4 | 396 | 99.5% | 396 (0) | 0.034 (0.1%) | 0.496 | ₹28,161 / ₹59,020 |
| D | SENSEX | 0.5 | 2 | 170 / 171 | 99.4% | 170 (0) | 0.026 (0.0%) | 0.493 | ₹37,707 / ₹47,282 |
| D | SENSEX | 0.5 | 3 | 169 | 98.8% | 169 (1) | 0.022 (0.0%) | 0.498 | ₹39,913 / ₹49,643 |
| D | SENSEX | 0.5 | 4 | 169 | 98.8% | 169 (3) | 0.019 (0.9%) | 0.494 | ₹41,016 / ₹54,109 |
| D | SENSEX | 1.0 | 2 | 167 | 97.7% | 167 (2) | 0.028 (0.0%) | 0.494 | ₹38,231 / ₹47,282 |
| D | SENSEX | 1.0 | 3 | 164 | 95.9% | 164 (1) | 0.024 (0.3%) | 0.496 | ₹40,704 / ₹49,643 |
| D | SENSEX | 1.0 | 4 | 162 | 94.7% | 162 (0) | 0.018 (1.9%) | 0.495 | ₹41,840 / ₹54,109 |
| D | SENSEX | 1.5 | 2 | 164 | 95.9% | 163 (1) | 0.024 (0.6%) | 0.495 | ₹38,734 / ₹51,079 |
| D | SENSEX | 1.5 | 3 | 161 | 94.2% | 161 (0) | 0.023 (0.9%) | 0.497 | ₹40,838 / ₹49,643 |
| D | SENSEX | 1.5 | 4 | 158 | 92.4% | 157 (0) | 0.021 (6.3%) | 0.498 | ₹41,840 / ₹54,109 |
| M | NIFTY | 0.5 | 2 | 254 / 255 | 99.6% | 254 | 0.046 (0.0%) | 0.504 | ₹25,044 / ₹52,238 |
| M | NIFTY | 0.5 | 3 | 254 | 99.6% | 254 | 0.038 (0.0%) | 0.485 | ₹26,025 / ₹59,912 |
| M | NIFTY | 0.5 | 4 | 252 | 98.8% | 252 | 0.030 (0.0%) | 0.506 | ₹27,573 / ₹58,995 |
| M | NIFTY | 1.0 | 2 | 254 | 99.6% | 254 | 0.046 (0.0%) | 0.504 | ₹25,044 / ₹52,238 |
| M | NIFTY | 1.0 | 3 | 254 | 99.6% | 252 | 0.035 (0.0%) | 0.485 | ₹26,025 / ₹59,912 |
| M | NIFTY | 1.0 | 4 | 193 | **75.7%** | 173 | 0.032 (0.0%) | 0.500 | ₹27,513 / ₹58,995 |
| M | NIFTY | 1.5 | 2 | 247 | 96.9% | 243 | 0.046 (0.0%) | 0.502 | ₹24,994 / ₹52,238 |
| M | NIFTY | 1.5 | 3 | 101 | **39.6%** | 76 | 0.042 (0.0%) | 0.478 | ₹26,305 / ₹52,433 |
| M | NIFTY | 1.5 | 4 | 19 | **7.5%** | 7 | 0.032 (0.0%) | 0.510 | ₹27,511 / ₹56,094 |
| M | SENSEX | 0.5 | 2 | 135 / 135 | 100.0% | 135 | 0.024 (0.0%) | 0.494 | ₹22,077 / ₹47,296 |
| M | SENSEX | 0.5 | 3 | 133 | 98.5% | 133 | 0.019 (0.0%) | 0.498 | ₹23,074 / ₹49,646 |
| M | SENSEX | 0.5 | 4 | 126 | 93.3% | 126 | 0.021 (0.8%) | 0.501 | ₹24,692 / ₹54,067 |
| M | SENSEX | 1.0 | 2 | 134 | 99.3% | 134 | 0.028 (0.0%) | 0.494 | ₹22,488 / ₹47,296 |
| M | SENSEX | 1.0 | 3 | 133 | 98.5% | 131 | 0.021 (0.4%) | 0.497 | ₹23,324 / ₹49,646 |
| M | SENSEX | 1.0 | 4 | 86 | **63.7%** | 74 | 0.019 (0.6%) | 0.491 | ₹43,728 / ₹53,339 |
| M | SENSEX | 1.5 | 2 | 115 | **85.2%** | 111 | 0.024 (0.0%) | 0.493 | ₹22,077 / ₹47,296 |
| M | SENSEX | 1.5 | 3 | 36 | **26.7%** | 21 | 0.022 (1.4%) | 0.486 | ₹32,530 / ₹49,435 |
| M | SENSEX | 1.5 | 4 | 5 | **3.7%** | 2 | 0.007 (20.0%) | 0.470 | ₹41,406 / ₹50,522 |

- **The unpriced D entries** are almost all a leg of one spread that did not trade on the entry day (SENSEX's far strikes most often). One NIFTY and one SENSEX N = 4 entry has no Yahoo close or VIX that day.
- **The strikes land where the rule aims.** The median short strike is 0.02–0.05 EM from its target, and the median put width is 0.47–0.51 EM. Among the cells that run, only SENSEX's daily 1.5 EM, N = 4 cell misses its target by more than one strike step on more than 2% of entries (6.3%).
- **Lots seen:** NIFTY 25, 50, 65 and 75; SENSEX 10 and 20.
- **Margin** (§1.8's approximation, at entry, without the expiry-day 2%): a median of ₹22,000–44,000 a lot, and at most ₹60,000.
  - **Not one entry needs ₹10,000 or less. A ₹10,000 account cannot carry one lot of any configuration.**
  - **A ₹5 lakh account can carry one lot of every configuration**, at 4–12% of its capital before the expiry-day surcharge.
- **The M coverage rule** (§1.4, 90%): 11 of the 18 cells run.
  - Run: NIFTY (m, N) = (0.5, 2), (0.5, 3), (0.5, 4), (1.0, 2), (1.0, 3) and (1.5, 2); SENSEX (0.5, 2), (0.5, 3), (0.5, 4), (1.0, 2) and (1.0, 3).
  - Not run and not logged: NIFTY (1.0, 4), (1.5, 3), (1.5, 4); SENSEX (1.0, 4), (1.5, 2), (1.5, 3), (1.5, 4). In those cells the extract lacks a far leg on 15–96% of expiries.
- **Configurations run:** D 2 × 18 = 36; M (6 + 5) × 2 = 22; **58 in all**, each at two fills, each with its mirror.

### 2.5 The turn of the month (windows and counts only)

| index | first complete Yahoo bar | windows [−1, +3] (skipped) | first / last month | **cut after** (the last window end of the first 60%) | first 60% / last 40% | daily returns: window days / other days | near-month future windows (skipped) |
|---|---|---|---|---|---|---|---|
| NIFTY | 17 Sep 2007 | 229 (0) | Sep 2007 / Sep 2026 | **6 Mar 2019** | 138 / **91** | 898 / 3,751 | 91 (1 without an NSE file at the start or end) |
| SENSEX | 2 Jan 2007 | 237 (0) | Jan 2007 / Sep 2026 | **5 Dec 2018** | 143 / **94** | 930 / 3,906 | 38 (2 without a BSE file; 1 without a traded future) |

### 2.6 What this fixes before any P&L

1. **No H1 pick can reach 180 out-of-sample trades.** The last 40% holds 159 NIFTY and 68 SENSEX expiries on daily closes, and 102 and 54 on 1-minute bars. Every H1 pick is INSUFFICIENT ("FAIL: sample") at best. The other criteria and the economics are still computed and reported.
2. **TOM cannot reach 180 out-of-sample windows either** (91 NIFTY, 94 SENSEX): INSUFFICIENT at best.
3. **SENSEX's last 40% lies wholly in 2025–2026,** in both families. NIFTY's daily last 40% starts after 21 Sep 2023 and covers the lot-25 year 2024 and the larger lots of 2025–26. Its 1-minute last 40% is two-thirds in the sampled-bar era.
4. **Neither the ₹10,000 account nor any account under about ₹22,000 can carry one lot** of any configuration (§2.4). Everything below is for the ₹5 lakh account.
5. **The 1.5 EM cells exist only on daily closes** (and NIFTY's N = 2 on 1-minute bars), because the 1-minute extract does not keep strikes that far out.
6. **The TOM index sample's first 60% ends in Dec 2018 – Mar 2019,** so its last 40% (2019–2026) overlaps the H1 period.
