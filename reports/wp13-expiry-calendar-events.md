# WP13: expiry-day afternoons, weekly calendars and event crush on real 1-minute option prices

Sat 10 Oct 2026. Branch `worktree-agent-aef22326f271a929a`, reset to `5a43466` (head of `claude/gifted-wright-3d8r3j`). Analysis only: no paper trading, no deploys, no pushes; nothing in the engine changes.

**Data and licence.** Every option and index price in this study comes from the Hugging Face dataset **"India Index & Options – 1-minute OHLC" by TradeMarkk** (`thetrademarkk/india-index-options-1m`, revision `0f4800e43e6f96cec0794369d78eb4d3c4211ef5`, https://huggingface.co/datasets/thetrademarkk/india-index-options-1m), licensed **CC-BY-NC-4.0**: non-commercial research use only, attributed here. The dataset calls itself "educational use only, provided as-is"; WP11 §2 verified it against the exchange's own files. No raw or extracted data is committed (the repository is public); the scripts rebuild everything from a download.

**Status of this file:** §1 and §2 were written and committed before any profit or loss was computed for these hypotheses. Everything after §2 was added after the runs, and a closing section lists every change made after the freeze.

---

## 1. Frozen definitions (pre-registered before any P&L)

### 1.0 Where the three hypotheses come from, and why they are judged out of sample only

| id | the descriptive result that suggested it (same data, or the bhavcopies of the same years) |
|---|---|
| H1 expiry-day afternoon short premium | WP11 §6.2 (C6): on expiry day the ATM straddle loses 15% of its premium between 14:00 and 15:00 at the bar close (−₹504 to −₹521 a lot for a buyer) and 34–39% at the conservative fill; WP10 §3.3: the expiry day (DTE 0) was the open→close straddle's richest cell (+9.2% NIFTY, +13.8% SENSEX). |
| H2 weekly calendar | Plan §4 N4 (Q1, real prices): a straddle buyer lost 19% of the premium on expiry day, 10.6% with one session left and 4.6–7.0% with 2–5 left; WP10 §3.3: the open→close seller made +4.2% (NIFTY) / +3.8% (SENSEX) of premium with one session left, against +0.2% / +4.2% with 2–5 left. The next week's contract decays more slowly, so selling the near week against it would collect the difference while the long leg caps the tail. |
| H3 event volatility crush | WP10 §3.3: "session before an RBI day" +21.3% / +19.4% for the open→close straddle, Budget days +19.3% / +44%; R2: India VIX closed lower on Budget day in all 15 Budgets studied; Q1 §3: VIX fell 2.2% on average on 16 RBI days, and a straddle bought the evening before the last 3 Budgets lost 41–80%; the 2024 election result was the exception (+126% for a buyer). |

These are in-sample suggestions from descriptive tables. They prove nothing by themselves. Each hypothesis's parameters are therefore fixed on the **first 60%** of its sessions and judged **untouched on the last 40%** (§1.5). H3 has fewer than 180 events in five years and is reported descriptively only.

### 1.1 Data

- **Download** (`scripts/research/wp13_fetch.py`): `index/NIFTY.parquet`, `index/SENSEX.parquet`, all 267 `options/NIFTY/*.parquet` and all 148 `options/SENSEX/*.parquet` at the pinned revision, each checked against the sha256 of its LFS pointer. These are WP11's files; each option file holds one weekly expiry, so the "next week" contracts a calendar needs and the expiry-day bars are both inside them.
- **Extract** (`scripts/research/wp13_extract.py`, run with `python3 -I` and a vendored pyarrow): index bars 09:00–15:59; for every session, two contracts: **A**, the dataset's nearest expiry on or after the day (the expiring contract on its expiry day), and **N**, the next expiry after A. Only strikes within max(6.5 strike steps, 2.6 daily expected moves + 1 step) of the index range of that session **and the three sessions before it** (so the strike of a position opened one or two sessions earlier stays in the file), and only bars starting 09:15–15:30. Rows that repeat a (day, strike, type, minute) are dropped (they are exact copies, WP11 §2). The raw download is deleted after the extract.
- **Bars.** `m` is the IST minute at which a bar starts; it holds the trades in [m, m + 1). A minute without a bar had no trade. Bars with zero volume are no trade (only from 2025).
- **Sessions** (WP11 §1.1): index sessions with ≥ 370 one-minute bars starting 09:15–15:29 and a 09:15 bar, a bhavcopy for the day, and not one of WP6's short special sessions.
- **Contracts are the exchange's.** A = the nearest expiry on or after the session listed in the bhavcopy; N = the next listed expiry after A. When the dataset has no file for a contract the hypothesis needs, that session is dropped for the hypothesis (counted in §2), never filled with another contract.
- **Sessions to expiry (DTE):** NSE sessions after the day up to and including the expiry (0 on expiry day), for both indices (WP10's convention).
- **Lot:** the modal lot of the contract's bhavcopy rows that day. **India VIX known before the open:** Yahoo's ^INDIAVIX close of the previous session. **Daily expected move:** level × VIX/100 × √(1/252).
- **Two data eras** (WP11 §2): option bars to **31 Dec 2024 hold every trade**; from **1 Jan 2025 they are built from sampled prices** (closes, last trade and volume still exact; most intraday extremes missing). The conservative fill (§1.2) is a true worst case of the minute only in the first era. Every result is reported for both eras.

### 1.2 Orders, fills and costs (as WP11 §1.2)

- **Fill modes.** *Conservative* (the verdict case): a sell fills at the 1-minute bar's **low**, a buy at its **high**. *Mid*: the bar's **close**. No spread is added on top.
- **Clock orders** fill in the bar starting at that minute. An entry order fills in each leg's first bar within [m, m + 2]; when a leg has none, there is no trade that session (counted). An exit order fills in each leg's first bar within [m, m + 5]; when there is none, at the leg's last close at or before m on the exit day (a stale exit, counted). For a position held overnight, a leg with no bar at all on the exit day up to m + 5 exits at its intrinsic value at the index level known at m (the close of the index bar before m) when its contract expires that day (the price it settles near), and otherwise has no exit price: the trade is not booked and is counted as "no exit price" (`runOvernight`).
- **Four-leg orders** (iron fly, calendar): the position is entered in the first minute within [m, m + 2] in which all four legs have a bar (none: no trade, counted), and that minute's four closes must pass a no-arbitrage check, else no trade (counted): for the fly WP10's `flyNoArbitrage` (each vertical in [0, its width], the fly's value in (0, the wider width)); for the calendar, the later expiry's straddle must cost more than the nearer expiry's at the same strike.
- **Stops** (H1 only): on the position's value, checked every minute after the position is complete and before the exit minute. Value = short legs at their bar's **high** and long legs at their **low** (conservative), or at closes (mid); a leg without a bar that minute is valued at its last close. The stop triggers when the cost to close reaches the credit received × (1 + s), i.e. value ≤ V₀ − s·|V₀| with V₀ the value at the entry fills, and fills at that minute's same prices (WP11's `runPosition`). For the fly the credit is the net credit.
- **ATM strike:** the listed strike (call and put both have a bar that day; for the calendar, in both contracts) nearest the index level known when the order goes in: the close of the index bar before the order minute. A tie goes to the lower strike.
- **Charges:** `computeCharges` per order per leg at the rates in force on each order's date (`RESEARCH_CHARGE_SCHEDULES`: STT on option sales 0.05% → 0.0625% (Apr 2023) → 0.1% (Oct 2024) → 0.15% (Apr 2026); dated exchange charges; ₹20 brokerage per order; SEBI fee, stamp duty on buys, IPFT, GST); NSE for NIFTY, BSE for SENSEX. A position held overnight pays its exit charges at the exit day's rates. One lot per trade at the lot in force on the entry day.

### 1.3 The hypotheses and their variants

| id | rule | variants per index |
|---|---|---|
| **H1a** expiry-day afternoon, naked | On the index's own expiry day (DTE 0, contract A expiring that day): sell the ATM call and put at **13:30, 14:00 or 14:30**; buy both back at **15:00 or 15:20**; **no stop, or a stop at +30% / +50%** of the premium received | entry (3) × exit (2) × stop (3) × fill (2) = 36 |
| **H1b** expiry-day afternoon, defined risk | H1a plus a long call at the listed strike above K nearest K + m·EMᵣ and a long put at the listed strike below K nearest K − m·EMᵣ, **m = 1 or 2**, where **EMᵣ = level × VIX/100 × √(((15:30 − entry minute) / 375) / 252)** is the expected move for the rest of the session (`remainingSessionEm`); four-leg entry and no-arbitrage check (§1.2) | wings (2) × entry (3) × exit (2) × stop (3) × fill (2) = 72 |
| **H2** weekly calendar | On sessions with **1 or 2 sessions to A**: sell A's ATM call and put and buy N's call and put **at the same strike**, at **09:30 or 11:15** (four-leg entry and the calendar's no-arbitrage check); exit at **15:20 the same day**, or **held to 15:20 on A's expiry day**. No stop. Sessions where A's and N's lots differ are skipped (one lot of each would not be the same quantity). | entry (2) × exit (2) × fill (2) = 8 |
| **H3** event crush (descriptive) | On the NSE session before each scheduled event (Union Budget, scheduled RBI policy decision, general-election result; the dates of `SCHEDULED_EVENTS` in `shortPremium.ts`, which are WP10 §1.6's list and include every date in docs/research/notes/q1-premium-timing.md and r2-premium-timing.md that falls inside the data): sell at **15:20** the ATM straddle of the nearest expiry **strictly after** that session (never a contract that expires before the event); buy it back on the event day at **09:30 or 15:20**. No stop. | exit (2) × fill (2) = 4 |

That is 120 variants per index, 240 in all. The variants within a family share the eligible sessions of §1.4.

### 1.4 Samples

- **H1:** the index's expiry days (A expires that day) that are valid sessions, with A in the dataset and a lot.
- **H2:** valid sessions with DTE 1 or 2 to A, with A and N in the dataset, both lots known and equal. The held variant also needs A's expiry day to be a valid session (else "expiry session missing", counted).
- **H3:** every event date inside the index's data whose day and the NSE session before it are valid sessions, with the contract in the dataset on both days.
- **Bootstrap blocks** ("per day", day-clustered): the exit session. That is one block per session for H1 and the same-day H2 variants, **one per expiry week** for the held H2 variant (its DTE 2 and DTE 1 entries share one expiry and one block), and one per event for H3.

### 1.5 The walk-forward split and the pick

- Per index and hypothesis, the eligible sessions of §1.4 are sorted; the first ⌈0.6 n⌉ are **in sample**, the rest **out of sample** (`cutDate`). The split depends only on which sessions have data (no prices), and the cut dates are listed in §2 before any P&L. A trade belongs to the half of its entry session.
- **The pick:** for each family (H1a, H1b, H2), index and fill, the variant with the highest mean net ₹ per trade on the first 60% (`pickBest`, ties by name). Its parameters are then frozen and it is evaluated **untouched on the last 40%**. Every other variant's last-40% result is reported but decides nothing.

### 1.6 ±20% robustness (computed only for picks that pass criteria 2 and 3 on the last 40%)

- **H1:** the entry's distance to 15:30 × 0.8 and × 1.2, the exit's distance to 15:30 × 0.8 and × 1.2 (rounded, moved by at least one minute; `perturbDistance`), the stop × 0.8 / × 1.2 when there is one, the wings × 0.8 / × 1.2 (H1b).
- **H2:** the entry's distance from 09:15 × 0.8 / × 1.2, the exit's distance to 15:30 × 0.8 / × 1.2.
- Each perturbed variant runs on every eligible session, is logged, and is judged on the last 40%.

### 1.7 The bar (plan §12), on each pick, at the conservative fill

1. **≥ 180 trades out of sample** (the last 40%).
2. **Out of sample:** day-block bootstrap 95% CI above zero **per trade and per session** (blocks of §1.4; `dayBlockBootstrap`, seed 7, 20,000 resamples, rerun with 100,000 when both lower bounds are above zero).
3. **Out of sample:** profit factor ≥ 1.3.
4. **±20% robustness** out of sample: ≥ 80% of the perturbed variants net > 0, and the worst ≥ base − 50% × |base| (`robustness`).
5. **Multiple testing**, out of sample: the larger of the per-trade and per-session bootstrap p-values < 0.05 / N, with N the number of lines in `reports/trials.jsonl` after this study's lines are appended (2,468 before); **and** the deflated Sharpe ratio of the per-session net ÷ ₹5 lakh ≥ 0.95, with N from the ledger and V[SR] from this study's H1 and H2 strategy and perturbation lines (the 1/(T−1) null-variance version is reported too).
6. **Complete-bar era** (sessions to 31 Dec 2024, in and out of sample, where the conservative fill is the minute's real worst trade): mean > 0 with a day-block CI above zero per trade (10,000 resamples, like every sub-sample other than the last 40%).

- **Verdicts** (`overallVerdict`): *PASS* when every criterion passes; *INSUFFICIENT* when fewer than 180 out-of-sample trades is the only failure; *FAIL* otherwise (a criterion that was not run because an earlier one failed counts as a failure). The mid-fill pick is judged by the same criteria at mid fills and reported beside it; a family that fails at the conservative fill but passes at the bar close is *mid only*: not actionable without quotes.
- **Reported, not judged:** every calendar year; both eras, in and out of sample; DTE 1 against DTE 2 (H2); the H3 events one by one. The random-entry placebo of plan §12 is not part of this brief's bar and is not run.
- **A frozen paper-test spec for the ₹5 lakh paper account (entries, exits, stops, strikes, skip rules, one lot, a maximum loss per day and kill rules) is written only for a pick that passes.**

### 1.8 Tails and exposures (reported for every variant)

- Per lot: the worst day (the worst block), the 10 worst days (or expiry weeks, or events), the maximum drawdown of the cumulative ₹ in date order and as % of a ₹5 lakh account, and the worst 5% of traded days' sum as a multiple of the variant's total net (`tailShare`).
- H1: the worst expiries by date with the index's move from entry to exit and its largest excursion in between, and the 10 largest entry-to-exit index moves of the naked 13:30 → 15:20 straddle with their P&L.
- H2: at each mid-fill entry, the calendar's net gamma (₹ per lot for a 1% index move), net vega (₹ per vol point) and net theta (₹ per session) from Black-76 on each expiry's parity forward (`black76Iv`, the engine's trading-time clock); margin from WP10 §6 and the SEBI measures in docs/research/notes/r1-why-retail-loses.md (the expiry-day calendar-spread benefit was removed from Feb 2025; +2% extreme-loss margin on short options on their expiry day from 20 Nov 2024).
- What the data cannot show: SEBI's 3 Jul 2025 interim order against Jane Street (r1 note §4) describes expiry-day index moves engineered by one participant, including "marking the close" in the last two hours; the 1-minute bars record such days but cannot say which ones they were or whether they will recur.

### 1.9 Ledger

- One line per variant and perturbation in `reports/trials.jsonl` with `wp: "WP13"`: full-sample trades, net ₹, mean per trade, sessions (blocks) and the per-session Sharpe ratio; the notes carry both halves. Variants already logged are not appended again.

---

## 2. Data and samples (before any P&L)

Everything in this section comes from file lists, bar presence and the bhavcopy calendar (`wp13-expiry-calendar-events.ts coverage`). No option price entered it.

### 2.1 Download and extract

- **Download:** 417 files (1.33 GB) at `0f4800e4`, every sha256 matching its LFS pointer, in 36 s. Deleted after the extract.
- **Extract:** 842 MB of csv.gz. NIFTY: 1,258 index sessions (24 May 2021 – 2 Jul 2026), 2,186 day-contract files. SENSEX: 936 index sessions (from 1 Sep 2022; its options start in Aug 2023), 1,156 day-contract files. Wanted (session, contract) pairs without data: NIFTY 330, SENSEX 716. Most are a next-week contract N before the dataset's coverage of it begins (each option file holds only its contract's last 7–12 sessions), and SENSEX's sessions before its options exist.
- **Same bars as WP11.** Every one of WP11's day-contract files (NIFTY 1,508, SENSEX 825) is also in the WP13 extract. In 80 random shared files per index, all 1.42 million (NIFTY) and 1.80 million (SENSEX) of WP11's rows appear unchanged; the WP13 files are wider (more strikes) in 78 and 74 of them.
- **Data checks** (`manifest.json`): the same as WP11 (exact repeated rows dropped, zero-volume bars treated as no trade); 59 SENSEX files from 2025–26 hold up to 36 rows timed outside 09:15–15:30, which the extract drops.

### 2.2 Samples and the walk-forward cuts (frozen here)

| index | hypothesis | eligible sessions | first 60% (to the cut) | last 40% | last 40% to Dec 2024 / from 2025 | dropped |
|---|---|---|---|---|---|---|
| NIFTY | H1 expiry days | 259 (27 May 2021 – 19 May 2026) | 156, cut after **23 May 2024** | **103** | 31 / 72 | expiring contract missing from the dataset 6 |
| NIFTY | H2 DTE 1–2 (DTE 1: 246, DTE 2: 217) | 463 (25 May 2021 – 18 May 2026) | 278, cut after **27 Feb 2024** | **185** | 86 / 99 | next week missing 41; current week missing 14; the two weeks' lots differ 9 |
| NIFTY | H3 events | 37 of 38 in range | – | – | – | 5 Jun 2026: contract missing |
| SENSEX | H1 expiry days | 142 (11 Aug 2023 – 21 May 2026) | 86, cut after **15 Apr 2025** | **56** | 0 / 56 | expiring contract missing 19 |
| SENSEX | H2 DTE 1–2 (DTE 1: 133, DTE 2: 104) | 237 (9 Aug 2023 – 13 May 2026) | 143, cut after **13 Jan 2025** | **94** | 0 / 94 | next week missing 41; current week missing 36; no next expiry listed 4; lots differ 4 |
| SENSEX | H3 events | 22 of 24 in range | – | – | – | 8 Jun 2023 and 5 Jun 2026: contract missing |

### 2.3 Bar coverage at the order minutes

**H1** (share of expiry days; the ATM strike from the index level, the wings from EMᵣ):

| index | entry | ATM call and put both have a bar within 2 min | both have a bar in the 15:00 / 15:20 exit window (5 min) | iron fly 1 EMᵣ: four legs in one minute within 2 min (mean wing distance) | iron fly 2 EMᵣ: same |
|---|---|---|---|---|---|
| NIFTY | 13:30 | 100.0% | 100.0% / 97.7% | 100.0% (111 points) | 100.0% (223 points) |
| | 14:00 | 100.0% | 100.0% / 98.5% | 100.0% (96) | 100.0% (193) |
| | 14:30 | 100.0% | 100.0% / 98.1% | 100.0% (80) | 100.0% (156) |
| SENSEX | 13:30 | 100.0% | 100.0% / 100.0% | 100.0% (391) | 100.0% (774) |
| | 14:00 | 100.0% | 100.0% / 100.0% | 100.0% (331) | 100.0% (668) |
| | 14:30 | 100.0% | 100.0% / 100.0% | 100.0% (277) | 100.0% (548) |

**H2** (share of eligible sessions):

| index | entry | all four legs in one minute within 2 min | all four have a bar at 15:20–15:25 the same day | all four have a bar at 15:20–15:25 on A's expiry day | an A leg with no bar at all on its expiry day (exits at intrinsic) | an N leg with no bar at all that day (no exit price) |
|---|---|---|---|---|---|---|
| NIFTY | 09:30 | 100.0% | 100.0% | 99.8% | 0 | 0 |
| | 11:15 | 100.0% | 100.0% | 99.1% | 0 | 0 |
| SENSEX | 09:30 | 59.9% | 83.1% | 84.4% | 0 | 7 |
| | 11:15 | 57.4% | 83.1% | 84.4% | 0 | 7 |

For SENSEX, A's expiry day is not a valid session for 4 entries. **H3:** at every usable event the ATM legs have a bar at 15:20 the session before and at 09:30 and 15:20 on the day.

**H3 events used.** NIFTY: the 37 Budget, RBI and election days from 4 Jun 2021 to 8 Apr 2026 (Budgets 1 Feb 2022, 1 Feb 2023, 1 Feb 2024, 23 Jul 2024, Saturday 1 Feb 2025 and Sunday 1 Feb 2026; the election result of 4 Jun 2024; 30 RBI decisions). SENSEX: the 22 from 10 Aug 2023 to 8 Apr 2026 (4 Budgets, the election, 17 RBI decisions).

### 2.4 What this fixes before any P&L

1. **H1 cannot reach 180 out-of-sample trades on either index.** NIFTY has 103 last-40% expiry days, SENSEX 56 (159 even pooled). An H1 pick can therefore be at best *INSUFFICIENT*; the other criteria are still computed and reported.
2. **SENSEX H2 cannot either:** 94 last-40% sessions, of which about 58–60% have all four legs in one minute.
3. **NIFTY H2 is the only family that can reach the bar's sample size:** 185 last-40% sessions, so it needs at least 180 of them to trade.
4. **SENSEX's last 40% lies entirely in the sampled-bar era** for both H1 and H2, where the conservative fill is not the minute's real worst trade (§1.1). NIFTY's last 40% is a third (H1) to a half (H2) complete-bar sessions.
