# WP13: expiry-day afternoons, weekly calendars and event crush on real 1-minute option prices

Sat 10 Oct 2026. Branch `worktree-agent-aef22326f271a929a`, reset to `5a43466` (head of `claude/gifted-wright-3d8r3j`). Analysis only: no paper trading, no deploys, no pushes; nothing in the engine changes.

**Data and licence.** Every option and index price in this study comes from the Hugging Face dataset **"India Index & Options – 1-minute OHLC" by TradeMarkk** (`thetrademarkk/india-index-options-1m`, revision `0f4800e43e6f96cec0794369d78eb4d3c4211ef5`, https://huggingface.co/datasets/thetrademarkk/india-index-options-1m), licensed **CC-BY-NC-4.0**: non-commercial research use only, attributed here. The dataset calls itself "educational use only, provided as-is"; WP11 §2 verified it against the exchange's own files. No raw or extracted data is committed (the repository is public); the scripts rebuild everything from a download.

**Status of this file:** §1 and §2 were written and committed (`9c28ae7`) before any profit or loss was computed for these hypotheses, and they are unchanged. §0 and §3–§9 were added after the runs; §8 lists every change made after the freeze. No definition changed.

---

## 0. Bottom line

**Verdict: nothing passes, so there is no paper-test spec.**
- All 12 walk-forward picks fail out of sample: 3 families × 2 indices × 2 fills.
- None of the 232 H1 and H2 variants, picked or not, has a last-40% CI above zero, per trade or per session, on either index or at either fill. The best lower bound is −₹65 (NIFTY 14:00 → 15:20, +50% stop, bar close).
- H1 could not have passed anyway: neither index has 180 out-of-sample expiry days (§2.4).

| question | answer from the real 1-minute prices |
|---|---|
| **H1a.** Sell the naked ATM straddle on expiry-day afternoons? | **Positive at the bar close up to 2024; not out of sample.**<br>• NIFTY, at the bar close: all 18 variants are positive over 259 expiries (+₹86 to +₹371 a lot), 12 with CIs above zero. The best was 13:30 → 15:20 with a +50% stop: +₹371 (CI +₹125 … +₹615, PF 1.55).<br>• To Dec 2024, 14 of 18 have CIs above zero; from 2025, none does.<br>• That variant is the walk-forward pick. On the last 103 expiries it made +₹157 (CI −₹296 … +₹613, PF 1.18), and −₹199 a trade in 2025.<br>• At the conservative fill, only 1 of 18 is positive over all days (+₹4). The conservative pick lost −₹119 out of sample.<br>• SENSEX: no variant has an all-days CI above zero at either fill. Both picks lose out of sample (−₹47 mid, −₹325 conservative). |
| **H1b.** The same, defined risk (an iron fly)? | **Gives the edge back.**<br>• At the bar close: NIFTY −₹122 to +₹145, SENSEX −₹192 to +₹83, and no CI above zero.<br>• At the conservative fill, every one of the 72 variants loses: −₹225 to −₹1,079 a lot.<br>• Out-of-sample picks: NIFTY −₹85 / −₹373, SENSEX −₹259 / −₹627 (mid / conservative). |
| **H2.** A weekly calendar (sell this week's straddle, buy next week's, same strike)? | **Loses at every entry, exit and fill.**<br>• NIFTY, 463 sessions: −₹263 to −₹342 a trade at the bar close and −₹970 to −₹1,328 at the conservative fill.<br>• It is about flat before costs; its eight orders cost about ₹240.<br>• SENSEX: −₹284 to −₹433 at the bar close.<br>• It is short gamma and long vega. The morning fade of implied volatility and any 1% move eat its theta (§4.2). |
| **H3.** Sell the straddle the evening before Budget, RBI and election days? | **A handful of events decides it.**<br>• NIFTY, 37 events, bought back at 15:20 on the day: +₹226 a lot at the bar close (CI −₹2,142 … +₹2,392).<br>• SENSEX, 22 events: −₹1,401.<br>• Budgets paid: 5 of 6 (NIFTY) and 3 of 4 (SENSEX), +₹4.7–5.2k on average at the bar close.<br>• RBI days averaged −₹11 (NIFTY) and −₹1,474 (SENSEX).<br>• **4 June 2024 (election result): −₹22,508 (NIFTY) and −₹24,519 (SENSEX) a lot.**<br>• 8 April 2026 (RBI, a 3.4–3.6% gap up): −₹19,008 and −₹27,922. |
| **The naked afternoon's tail?** | **Bounded by how far the index moves in two hours.**<br>• Worst expiry: −₹13,725 a lot (NIFTY, 7 Aug 2025: +1.00% from 13:30 to 15:20, 3.1× the premium collected) and −₹9,704 (SENSEX, 2 Apr 2026: +1.04%).<br>• NIFTY's 10 worst expiries sum to −₹78,879 (conservative fill).<br>• Its worst 5% of days lost 0.97× the variant's whole five-year net at the bar close.<br>• Maximum drawdown: 4.4% (mid) to 8.4% (conservative) of ₹5 lakh.<br>• The largest 13:30 → 15:20 move in five years was 1.54% (NIFTY, 16 May 2024). |

**Verdict table.** For each family, index and fill this is the variant with the best mean on the first 60% of sessions, evaluated untouched on the last 40%. Figures are ₹ per lot per trade, net of dated charges, with day-block 95% CIs (expiry-week blocks for the held calendar). The verdict is decided at the conservative fill.

| hypothesis | index | fill | pick (fixed on the first 60%) | first 60% ₹/trade (n) | last 40%: trades | last 40%: ₹/trade (95% CI) | PF | worst day (all days) | verdict |
|---|---|---|---|---|---|---|---|---|---|
| H1a naked straddle | NIFTY | conservative | 13:30 → 15:20, no stop | ₹86 (156) | 103 | −₹119 (−₹696 … ₹419) | 0.89 | −₹13,725 (7 Aug 2025) | **FAIL** (and < 180) |
| | | mid | 13:30 → 15:20, stop +50% | ₹512 (156) | 103 | ₹157 (−₹296 … ₹613) | 1.18 | −₹6,239 (15 May 2025) | FAIL |
| | SENSEX | conservative | 14:00 → 15:20, no stop | ₹241 (86) | 56 | −₹325 (−₹1,038 … ₹348) | 0.73 | −₹9,073 (5 Mar 2026) | **FAIL** (and < 180) |
| | | mid | 14:00 → 15:00, no stop | ₹536 (86) | 56 | −₹47 (−₹784 … ₹591) | 0.95 | −₹12,456 (5 Mar 2026) | FAIL |
| H1b iron fly | NIFTY | conservative | wings 2 EMᵣ, 13:30 → 15:20, no stop | −₹156 (156) | 103 | −₹373 (−₹919 … ₹138) | 0.66 | −₹11,262 (7 Aug 2025) | **FAIL** |
| | | mid | wings 2 EMᵣ, 13:30 → 15:20, stop +50% | ₹297 (156) | 103 | −₹85 (−₹513 … ₹348) | 0.91 | −₹6,025 (15 May 2025) | FAIL |
| | SENSEX | conservative | wings 2 EMᵣ, 14:00 → 15:20, no stop | −₹73 (86) | 56 | −₹627 (−₹1,341 … ₹47) | 0.53 | −₹9,350 (5 Mar 2026) | **FAIL** |
| | | mid | wings 2 EMᵣ, 14:00 → 15:00, no stop | ₹284 (86) | 56 | −₹259 (−₹970 … ₹356) | 0.75 | −₹12,005 (5 Mar 2026) | FAIL |
| H2 calendar | NIFTY | conservative | 11:15 → 15:20 on the expiry day | −₹1,026 (278) | 185 | −₹887 (−₹1,793 … ₹5) | 0.63 | −₹21,254 (expiry 24 Feb 2022) | **FAIL** |
| | | mid | 09:30 → 15:20 the same day | −₹361 (278) | 185 | −₹117 (−₹330 … ₹85) | 0.77 | −₹9,103 (20 Dec 2023) | FAIL |
| | SENSEX | conservative | 11:15 → 15:20 on the expiry day | −₹484 (45) | 88 | −₹1,136 (−₹2,393 … ₹110) | 0.59 | −₹25,136 (expiry 12 Mar 2026) | **FAIL** |
| | | mid | 11:15 → 15:20 on the expiry day | −₹125 (45) | 88 | −₹474 (−₹1,704 … ₹762) | 0.80 | −₹23,457 (expiry 12 Mar 2026) | FAIL |
| H3 event crush (descriptive) | NIFTY | mid / conservative | sold 15:20 the session before, bought back 15:20 on the day | – | 37 events (all) | ₹226 (−₹2,142 … ₹2,392) / −₹80 (−₹2,454 … ₹2,084) | 1.10 / 0.97 | −₹22,508 / −₹22,895 (4 Jun 2024) | INSUFFICIENT |
| | SENSEX | mid / conservative | same | – | 22 events (all) | −₹1,401 (−₹5,694 … ₹2,359) / −₹1,671 (−₹5,944 … ₹2,069) | 0.62 / 0.57 | −₹27,922 / −₹28,123 (8 Apr 2026) | INSUFFICIENT |

- **Every pick fails** on its out-of-sample CI, its PF, and Bonferroni and the deflated Sharpe ratio. The smallest out-of-sample p is 0.25, against 0.05 / 2,708 = 1.8 × 10⁻⁵.
- **H1 also fails the sample-size criterion** by construction, and so does SENSEX H2.
- **No pick reached the ±20% robustness step,** so no perturbation was run.
- **The bar-close picks fail too, so no family is "mid only".**

**What it means.**
- **The expiry-day afternoon's decay is in the prints.** The straddle loses 15% of its value between 14:00 and 15:00 (WP11). A NIFTY seller at the bar close collected +₹80 to +₹485 a lot a trade through 2024 (14 of 18 variants with CIs above zero).
- **None of it survives the tests.** It does not survive the walk-forward split, the conservative fill, or 2025–26.
- **The calendar and the fly give it back** in wings and costs.
- **Event-eve selling earns on Budgets** and loses those gains on one surprise.
- **Why the afternoon edge faded cannot be told from the data.** The candidates are crowded expiry-day selling, SEBI's Nov 2024 – 2025 measures (bigger lots, +2% expiry-day margin, one weekly per exchange) and the departure of a dominant participant after SEBI's July 2025 order, or plain noise.
- Nothing here supports a paper test. The plan's §13 stands: no real money.

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

---

## 3. H1: selling the expiry-day afternoon

**Samples:** 259 NIFTY expiry days (27 May 2021 – 19 May 2026; walk-forward cut after 23 May 2024) and 142 SENSEX expiry days (11 Aug 2023 – 21 May 2026; cut after 15 Apr 2025). Every figure is net ₹ per lot per trade after dated charges, one lot at the lot in force. The premium collected averaged ₹3,184 a NIFTY lot at 13:30, ₹2,809 at 14:00 and ₹2,235 at 14:30 (bar close); SENSEX ₹3,108 / ₹2,698 / ₹2,155. Charges are about ₹100 a straddle and ₹194 a fly.

### 3.1 The grid

Each cell gives ₹ per trade at the bar close (mid) · at the conservative fill, over all expiry days and over the last 40%. † marks a mean whose day-block 95% CI is above zero per trade and per session.

**NIFTY H1a, naked straddle:**

| entry | stop | → 15:00, all days | → 15:00, last 40% | → 15:20, all days | → 15:20, last 40% |
|---|---|---|---|---|---|
| 13:30 | none | ₹319† · −₹471 | ₹189 · −₹670 | ₹335† · ₹4 | ₹258 · −₹119 |
| 13:30 | +30% | ₹222† · −₹654 | ₹36 · −₹953 | ₹266† · −₹485 | ₹111 · −₹801 |
| 13:30 | +50% | ₹291† · −₹546 | ₹59 · −₹881 | ₹371† · −₹228 | ₹157 · −₹523 |
| 14:00 | none | ₹323† · −₹474 | ₹274 · −₹566 | ₹343† · −₹4 | ₹373 · −₹9 |
| 14:00 | +30% | ₹138 · −₹715 | −₹26 · −₹985 | ₹218† · −₹535 | ₹134 · −₹837 |
| 14:00 | +50% | ₹225† · −₹638 | ₹192 · −₹853 | ₹286† · −₹326 | ₹337 · −₹524 |
| 14:30 | none | ₹86 · −₹730 | −₹5 · −₹934 | ₹103 · −₹251 | ₹167 · −₹244 |
| 14:30 | +30% | ₹93 · −₹686 | ₹29 · −₹829 | ₹143 · −₹585 | ₹129 · −₹740 |
| 14:30 | +50% | ₹114 · −₹706 | ₹44 · −₹935 | ₹210† · −₹423 | ₹200 · −₹699 |

**SENSEX H1a, naked straddle:**

| entry | stop | → 15:00, all days | → 15:00, last 40% | → 15:20, all days | → 15:20, last 40% |
|---|---|---|---|---|---|
| 13:30 | none | ₹258 · −₹416 | −₹112 · −₹1,049 | ₹272 · −₹30 | −₹42 · −₹418 |
| 13:30 | +30% | ₹59 · −₹599 | −₹108 · −₹690 | ₹106 · −₹457 | −₹14 · −₹454 |
| 13:30 | +50% | −₹48 · −₹536 | −₹380 · −₹852 | −₹43 · −₹349 | −₹300 · −₹600 |
| 14:00 | none | ₹306 · −₹358 | −₹47 · −₹1,001 | ₹314 · ₹18 | ₹74 · −₹325 |
| 14:00 | +30% | ₹230 · −₹355 | ₹104 · −₹607 | ₹256 · −₹237 | ₹214 · −₹398 |
| 14:00 | +50% | ₹236 · −₹390 | ₹65 · −₹681 | ₹211 · −₹191 | ₹67 · −₹349 |
| 14:30 | none | ₹81 · −₹590 | ₹106 · −₹920 | ₹116 · −₹173 | ₹347 · −₹54 |
| 14:30 | +30% | ₹39 · −₹631 | ₹59 · −₹945 | ₹131 · −₹528 | ₹205 · −₹802 |
| 14:30 | +50% | −₹17 · −₹682 | ₹44 · −₹1,012 | ₹94 · −₹438 | ₹241 · −₹647 |

**H1b, iron fly** (the no-stop rows; NIFTY's stop rows make −₹107 to +₹145 at the bar close and −₹508 to −₹1,013 at the conservative fill, SENSEX's −₹154 to +₹83 and −₹408 to −₹948):

| index | wings | entry | → 15:00, all days | → 15:00, last 40% | → 15:20, all days | → 15:20, last 40% |
|---|---|---|---|---|---|---|
| NIFTY | 1 EMᵣ | 13:30 | −₹4 · −₹941 | −₹184 · −₹1,239 | ₹21 · −₹390 | −₹74 · −₹551 |
| | | 14:00 | ₹28 · −₹904 | −₹54 · −₹1,041 | ₹34 · −₹388 | ₹50 · −₹411 |
| | | 14:30 | −₹122 · −₹1,079 | −₹216 · −₹1,303 | −₹114 · −₹551 | −₹99 · −₹597 |
| | 2 EMᵣ | 13:30 | ₹113 · −₹705 | −₹36 · −₹932 | ₹109 · −₹242 | ₹29 · −₹373 |
| | | 14:00 | ₹137 · −₹690 | ₹77 · −₹808 | ₹139 · −₹225 | ₹170 · −₹234 |
| | | 14:30 | −₹64 · −₹910 | −₹162 · −₹1,133 | −₹87 · −₹462 | −₹56 · −₹492 |
| SENSEX | 1 EMᵣ | 13:30 | −₹153 · −₹945 | −₹512 · −₹1,595 | −₹192 · −₹577 | −₹502 · −₹965 |
| | | 14:00 | −₹72 · −₹848 | −₹315 · −₹1,403 | −₹186 · −₹563 | −₹416 · −₹905 |
| | | 14:30 | −₹134 · −₹935 | −₹85 · −₹1,246 | −₹171 · −₹544 | −₹60 · −₹545 |
| | 2 EMᵣ | 13:30 | ₹16 · −₹691 | −₹349 · −₹1,313 | −₹18 · −₹346 | −₹336 · −₹729 |
| | | 14:00 | ₹70 · −₹627 | −₹259 · −₹1,244 | ₹30 · −₹291 | −₹210 · −₹627 |
| | | 14:30 | −₹97 · −₹805 | −₹51 · −₹1,110 | −₹107 · −₹422 | ₹110 · −₹312 |

The fly's four-leg entry and no-arbitrage checks passed on every expiry day; wings at 1 EMᵣ sat a mean 80–111 NIFTY points (277–391 SENSEX) from the strike (§2.3).

**By era** (the range over each family's variants; "CI" = 95% CI above zero per trade and per session):

| family | index | to Dec 2024, mid | from Jan 2025, mid | to Dec 2024, conservative | from Jan 2025, conservative |
|---|---|---|---|---|---|
| H1a | NIFTY (187 / 72 expiries) | +₹80 … +₹485 (CI: 14 of 18) | −₹89 … +₹353 (CI: 0) | −₹582 … +₹123 (0) | −₹1,185 … −₹123 (0) |
| H1a | SENSEX (70 / 72) | −₹53 … +₹434 (CI: 5 of 18) | −₹331 … +₹379 (0) | −₹410 … +₹211 (0) | −₹968 … −₹18 (0) |
| H1b | NIFTY | −₹115 … +₹264 (CI: 3 of 36) | −₹304 … +₹105 (0) | −₹883 … −₹98 (0) | −₹1,614 … −₹396 (0) |
| H1b | SENSEX | −₹220 … +₹227 (CI: 1 of 36) | −₹445 … +₹125 (0) | −₹644 … −₹43 (0) | −₹1,456 … −₹402 (0) |

**Reading.**
1. **At the bar close, a naked NIFTY afternoon straddle earned money up to 2024.** All 18 variants are positive over the five years, 12 with CIs above zero, and the no-stop 13:30 and 14:00 entries made +₹319 to +₹343 a lot (PF 1.43–1.69). This is WP11's expiry-day decay seen from the seller's side.
2. **It did not hold up.** From 2025 no variant has a CI above zero, and the worst calendar year was 2025 for 8 of the 18 NIFTY variants and 2026 for 6 more.
   - The 2025–26 bars are sampled, but their closes are still real traded prices, and the day's last trade and closing VWAP match the exchange (WP11 §2).
   - So the bar-close results of both eras rest on real prices, and the fade is not obviously a data artefact.
3. **SENSEX never had it clearly.** No variant has an all-days CI above zero at either fill.
4. **The conservative fill removes it** (§3.3). Only 2 of the 36 naked variants are positive over all days (NIFTY 13:30 → 15:20, +₹4; SENSEX 14:00 → 15:20, +₹18; both without a stop), and none in the last 40%.
5. **The fly gives back what the straddle earned.** It is flat at the bar close and negative at the conservative fill, as in WP10 and WP11.

### 3.2 The walk-forward picks against the bar

The rows of §0's verdict table, with each criterion:

| criterion | NIFTY H1a, conservative (13:30 → 15:20, no stop) | NIFTY H1a, mid (13:30 → 15:20, +50%) | SENSEX H1a, conservative (14:00 → 15:20, no stop) | SENSEX H1a, mid (14:00 → 15:00, no stop) |
|---|---|---|---|---|
| ≥ 180 trades out of sample | **insufficient** (103) | **insufficient** (103) | **insufficient** (56) | **insufficient** (56) |
| out of sample: CI > 0 per trade and per session | **fail**: −₹119 (−₹696 … ₹419) | **fail**: ₹157 (−₹296 … ₹613) | **fail**: −₹325 (−₹1,038 … ₹348) | **fail**: −₹47 (−₹784 … ₹591) |
| out of sample: PF ≥ 1.3 | **fail** (0.89) | **fail** (1.18) | **fail** (0.73) | **fail** (0.95) |
| ±20% robustness | not run | not run | not run | not run |
| Bonferroni (p < 1.8 × 10⁻⁵) and DSR ≥ 0.95 | **fail**: p 0.65; DSR 0.00 (null variance 0.00) | **fail**: p 0.25; DSR 0.00 (0.002) | **fail**: p 0.82; DSR 0.00 | **fail**: p 0.53; DSR 0.00 |
| complete-bar era (to Dec 2024): CI > 0 | **fail**: ₹123 (−₹190 … ₹421), 187 trades | pass: ₹485 (₹249 … ₹719) | **fail**: ₹55 (−₹171 … ₹263), 70 trades | pass: ₹329 (₹182 … ₹486) |
| last 40% to Dec 2024 / from 2025 | ₹311 (31) / −₹304 (72) | ₹347 (31) / ₹76 (72) | – / −₹325 (56) | – / −₹47 (56) |
| by year | 2021 ₹681, 2022 ₹134, 2023 −₹119, 2024 ₹22, 2025 −₹395, 2026 −₹67 | 2021 ₹851, 2022 ₹791, 2023 ₹209, 2024 ₹236, 2025 −₹199, 2026 ₹789 (20) | 2023 −₹135, 2024 ₹137, 2025 ₹241, 2026 −₹648 | 2023 ₹107, 2024 ₹424, 2025 ₹579, 2026 −₹436 |
| **verdict** | **FAIL** | FAIL | **FAIL** | FAIL |

- **The H1b picks fail every out-of-sample criterion too.**
  - NIFTY: −₹373 (conservative, p 0.92), −₹85 (mid, p 0.65).
  - SENSEX: −₹627 (p 0.97), −₹259 (p 0.77).
  - Only the NIFTY mid fly passes the complete-bar-era check (+₹264, CI +₹39 … +₹486).
- **Picking a different variant would not have helped.**
  - The best last-40% variants are NIFTY 14:00 → 15:20 at the bar close (+₹337 to +₹373, PF 1.49–1.50). They were not the in-sample picks, and their CIs span zero as well (lower bound −₹65 at best).
  - The best SENSEX one is 14:30 → 15:20 (+₹347, PF 1.58, CI −₹178 … +₹846).
  - Eight bar-close variants reach a last-40% PF ≥ 1.3; none reaches a CI above zero.

### 3.3 Why the conservative fill and the stops cost so much

- **The fill gap is about ₹300–330 a lot to 15:20, and ₹650–800 to 15:00.**
  - To 15:20, a naked straddle earns ₹331 (NIFTY) and ₹302 (SENSEX) less a trade at the conservative fill than at the bar close.
  - To 15:00 the gap more than doubles (₹790 and ₹674). The 15:00 minute opens the 30-minute window that sets the index's official close and hence the settlement price, and on expiry day its 1-minute range is enormous.
  - NIFTY, 15 Jun 2023, strike 18750, checked by hand against the bars: the put's 15:00 bar is 74.00 / 74.00 / 56.60 / 64.35 (o/h/l/c), a range of 27% of its close. Its 15:20 bar is 65.25 / 65.25 / 63.35 / 63.90 (3%). Buying back at the 15:00 high costs ₹9.65 a unit more than the close.
- **Stops checked on 1-minute highs fire on most afternoons.**
  - At the conservative fill the +30% stop closes 65–80% of NIFTY expiries and 58–80% of SENSEX ones; at the bar close, 28–46%.
  - The +50% stop closes 39–57% at the conservative fill and 15–35% at the bar close.
  - Each firing buys back at that minute's high, so every stop variant loses at the conservative fill.
  - At the bar close the +50% stop helps NIFTY's 13:30 entry (+₹335 → +₹371 to 15:20) and halves its worst day (−₹13,481 → −₹6,239).
- **Hand check of the fills** (`debug`, NIFTY 15 Jun 2023, 14:00 → 15:20, no stop):
  - The 18750 call and put close the 14:00 bar at 19.10 and 26.35 and the 15:20 bar at 0.10 and 63.90. That is (45.45 − 64.00) × 50 = −₹927.50 gross, and −₹1,026.68 after ₹99.18 of charges.
  - At the conservative fill (14:00 lows 17.25 / 26.00, 15:20 highs 0.15 / 65.25) it is −₹1,107.50 gross. Both match the run.

### 3.4 The tail (one lot; ₹5 lakh account)

| variant | fill | expiries | net ₹, five years | worst day | 10 worst days | max drawdown (% of ₹5 lakh) | worst 5% of days (× the net they lost) |
|---|---|---|---|---|---|---|---|
| NIFTY H1a 13:30 → 15:20, no stop | mid | 259 | ₹86,876 | −₹13,481 (7 Aug 2025) | −₹75,032 | ₹22,115 (4.4%) | −₹84,660 (0.97×) |
| | conservative | 259 | ₹1,149 | −₹13,725 (7 Aug 2025) | −₹78,879 | ₹42,102 (8.4%) | −₹89,314 (78×: the net is ~0) |
| NIFTY H1a 13:30 → 15:20, +50% stop (mid pick) | mid | 259 | ₹96,075 | −₹6,239 (15 May 2025) | −₹40,884 | ₹23,380 (4.7%) | −₹47,061 (0.49×) |
| NIFTY H1b 2 EMᵣ 13:30 → 15:20, no stop (conservative pick) | conservative | 259 | −₹62,666 | −₹11,262 (7 Aug 2025) | −₹76,019 | ₹82,675 (16.5%) | net < 0 |
| SENSEX H1a 13:30 → 15:20, no stop | mid | 142 | ₹38,663 | −₹8,641 (2 Apr 2026) | −₹49,873 | ₹37,922 (7.6%) | −₹39,924 (1.03×) |
| | conservative | 142 | −₹4,317 | −₹9,704 (2 Apr 2026) | −₹55,840 | ₹51,707 (10.3%) | net < 0 |
| SENSEX H1a 14:00 → 15:00, no stop (mid pick) | mid | 142 | ₹43,429 | −₹12,456 (5 Mar 2026) | −₹44,378 | ₹29,878 (6.0%) | −₹36,114 (0.83×) |

**The worst NIFTY expiries** (naked 13:30 → 15:20, no stop, conservative fill; the bar-close twin in brackets):

| expiry day | strike | index 13:29 close → 15:20 | move | largest excursion | premium ₹/lot | ₹ per lot |
|---|---|---|---|---|---|---|
| 7 Aug 2025 | 24350 | 24,358.0 → 24,602.8 | +1.00% | 1.04% | ₹4,361 | −₹13,725 (−₹13,481) |
| 22 Feb 2024 | 21950 | 21,965.2 → 22,243.2 | +1.27% | 1.31% | ₹2,630 | −₹11,291 (−₹10,737) |
| 31 Jul 2025 | 24950 | 24,927.0 → 24,752.2 | −0.70% | 0.71% | ₹5,498 | −₹8,422 (−₹7,669) |
| 12 Sep 2024 | 25000 | 24,996.2 → 25,364.1 | +1.47% | 1.75% | ₹2,233 | −₹7,696 (−₹7,488) |
| 20 Jan 2026 | 25400 | 25,416.8 → 25,191.8 | −0.89% | 0.89% | ₹4,115 | −₹7,252 (−₹6,908) |
| 25 Aug 2022 | 17700 | 17,704.2 → 17,498.5 | −1.16% | 1.22% | ₹2,410 | −₹7,148 (−₹6,988) |
| 12 May 2026 | 23550 | 23,531.0 → 23,387.5 | −0.61% | 0.77% | ₹4,960 | −₹6,440 (−₹6,197) |
| 5 May 2022 | 16850 | 16,835.2 → 16,681.7 | −0.91% | 1.09% | ₹2,753 | −₹5,651 (−₹5,336) |
| 2 Sep 2025 | 24700 | 24,684.8 → 24,583.5 | −0.41% | 0.65% | ₹3,345 | −₹5,649 (−₹5,312) |
| 2 Mar 2026 | 24700 | 24,679.5 → 24,905.4 | +0.92% | 0.95% | ₹6,383 | −₹5,605 (−₹4,916) |

**The biggest late moves**:
- **NIFTY's 10 largest 13:30 → 15:20 moves** are 16 May 2024 (+1.54%, −₹5,035), 12 Sep 2024 (+1.47%), 24 Feb 2022 (the invasion of Ukraine, −1.36%, −₹5,400), 22 Feb 2024 (+1.27%), 25 Aug 2022 (−1.16%), 23 Jun 2022 (+1.04%, −₹5,013), 7 Aug 2025 (+1.00%), 28 Oct 2021 (−0.95%, −₹3,306), 2 Mar 2026 (+0.92%) and 5 May 2022 (−0.91%). Every one of them lost.
- **SENSEX's worst expiries** were 2 Apr 2026 (+1.04%, −₹9,704), 23 Oct 2025 (−0.63%, −₹8,324), 19 Feb 2026 (−0.91%, −₹6,891), 19 Mar 2026 (−0.49%, −₹6,165), 21 Jan 2025 (−1.10%, −₹5,460) and 15 Dec 2023 (+0.76%, −₹4,405).

**Reading.**
- **The afternoon tail is short, but it is several premiums deep.** No NIFTY expiry in five years moved more than 1.54% between 13:30 and 15:20, so the worst day is −₹13.7k a lot, about half the worst full-day straddle loss in WP11 (−₹28.2k).
- **It still takes 1.3–3.1× the premium collected on the worst days.** On expiry day the options are almost pure intrinsic value near the close, so a 0.4% move (2 Sep 2025) already costs 1.7× the premium.
- **At the bar close the worst 5% of NIFTY days (12 expiries) took back 97% of five years' net.**
- **A +50% stop halves the worst day** at the bar close, but loses at the conservative fill (§3.3).

### 3.5 What the data cannot show: expiry-day manipulation

- **SEBI's interim order of 3 July 2025 against Jane Street** (docs/research/notes/r1-why-retail-loses.md §4) describes:
  - expiry-day index moves engineered by one participant;
  - on three Bank Nifty expiries (4 Oct 2023, 8 May 2024, 10 Jul 2024), "Extended Marking the Close": large directional trades in the last two hours to steer the settlement price;
  - the same pattern in NIFTY 50 options on three days in May 2025.
- **Those two hours are exactly the window H1 sells.**
- **The bars record those days' prices but cannot say:**
  - who moved them;
  - whether the pattern stopped after the July 2025 order, the trading bar and the escrow;
  - whether another participant does it now.
- **A seller of the expiry-day afternoon is short gamma to anyone who can move the index into the close.** That risk is real, bounded only by what one participant can move, and not in the sample in any measurable form.
- **The settlement mechanism itself may change.** SEBI's consultation of 12 Sep 2026 would change how the expiry settlement price is set; one option is a blended VWAP with a 10-minute closing auction (r1 note). That would move the window the last two hours trade against.

### 3.6 Verdict on H1

**FAIL on both indices, at both fills, for the naked straddle and the iron fly.** Even a perfect out-of-sample result could only have been *INSUFFICIENT* (103 and 56 expiries). The bar-close edge of 2021–2024 is the clearest pattern in this study, and the best guide to what it is worth is the last 40%: +₹157 a NIFTY lot with a CI from −₹296 to +₹613.

---

## 4. H2: the weekly calendar

**Samples:** 463 NIFTY sessions with 1 or 2 sessions to the current weekly (246 at DTE 1, 217 at DTE 2; cut after 27 Feb 2024) and 237 SENSEX sessions (cut after 13 Jan 2025). NIFTY's four legs always traded in one minute. SENSEX's did on only 57–60% of sessions, and mostly from 2025: only 45–56 trades fall in the first 60%.

### 4.1 Results

| index | entry → exit | fill | trades | all sessions ₹/trade (95% CI) | PF | last 40% ₹/trade (95% CI; n) | to Dec 2024 / from 2025 | DTE 1 / DTE 2 |
|---|---|---|---|---|---|---|---|---|
| NIFTY | 09:30 → 15:20 same day | mid | 463 | −₹263 (−₹386 … −₹148) | 0.50 | −₹117 (−₹330 … ₹85; 185) | −₹319 / −₹59 | −₹280 / −₹245 |
| | | conservative | 463 | −₹1,328 (−₹1,461 … −₹1,202) | 0.02 | −₹1,384 (−₹1,623 … −₹1,163; 185) | −₹1,190 / −₹1,834 | −₹1,337 / −₹1,317 |
| | 09:30 → 15:20 on the expiry day | mid | 463 | −₹337 (−₹816 … ₹137) | 0.82 | −₹220 (−₹1,097 … ₹646; 185) | −₹506 / ₹284 | −₹509 / −₹143 |
| | | conservative | 463 | −₹1,276 (−₹1,749 … −₹811) | 0.46 | −₹1,312 (−₹2,174 … −₹472; 185) | −₹1,286 / −₹1,240 | −₹1,443 / −₹1,087 |
| | 11:15 → 15:20 same day | mid | 463 | −₹342 (−₹441 … −₹245) | 0.32 | −₹249 (−₹417 … −₹80; 185) | −₹360 / −₹275 | −₹378 / −₹301 |
| | | conservative | 463 | −₹1,106 (−₹1,217 … −₹1,002) | 0.02 | −₹1,172 (−₹1,366 … −₹988; 185) | −₹985 / −₹1,551 | −₹1,161 / −₹1,043 |
| | 11:15 → 15:20 on the expiry day | mid | 463 | −₹326 (−₹818 … ₹165) | 0.82 | −₹130 (−₹1,041 … ₹781; 185) | −₹511 / ₹355 | −₹465 / −₹167 |
| | | conservative | 463 | −₹970 (−₹1,458 … −₹488) | 0.55 | −₹887 (−₹1,793 … ₹5; 185) | −₹1,047 / −₹689 | −₹1,132 / −₹788 |
| SENSEX | 09:30 → 15:20 same day | mid | 142 | −₹284 (−₹543 … −₹59) | 0.52 | −₹136 (−₹411 … ₹135; 86) | −₹312 / −₹267 | −₹125 / −₹577 |
| | | conservative | 142 | −₹1,206 (−₹1,490 … −₹966) | 0.06 | −₹1,300 (−₹1,585 … −₹1,020; 86) | −₹838 / −₹1,438 | −₹1,074 / −₹1,449 |
| | 09:30 → 15:20 on the expiry day | mid | 136 | −₹433 (−₹1,217 … ₹348) | 0.77 | −₹559 (−₹1,738 … ₹598; 86) | −₹215 / −₹559 | −₹113 / −₹1,039 |
| | | conservative | 136 | −₹1,306 (−₹2,110 … −₹522) | 0.45 | −₹1,645 (−₹2,836 … −₹486; 86) | −₹722 / −₹1,645 | −₹997 / −₹1,890 |
| | 11:15 → 15:20 same day | mid | 136 | −₹337 (−₹533 … −₹148) | 0.42 | −₹282 (−₹534 … −₹40; 88) | −₹480 / −₹263 | −₹140 / −₹665 |
| | | conservative | 136 | −₹972 (−₹1,169 … −₹788) | 0.05 | −₹1,033 (−₹1,293 … −₹794; 88) | −₹864 / −₹1,027 | −₹783 / −₹1,286 |
| | 11:15 → 15:20 on the expiry day | mid | 133 | −₹356 (−₹1,224 … ₹508) | 0.82 | −₹474 (−₹1,704 … ₹762; 88) | −₹228 / −₹417 | ₹188 / −₹1,259 |
| | | conservative | 133 | −₹916 (−₹1,797 … −₹44) | 0.60 | −₹1,136 (−₹2,393 … ₹110; 88) | −₹565 / −₹1,083 | −₹397 / −₹1,777 |

- **Size:** the calendar's net debit is about ₹9,000–9,800 a NIFTY lot and ₹10,300–11,800 a SENSEX lot. Charges are ₹240–254 a trade (eight orders).
- **SENSEX skips:** 91–97 SENSEX sessions are skipped because the four legs did not trade in one minute, 4 have no common strike, and the held variant loses 2–3 to an invalid expiry session and 1–3 to "no exit price" (an N leg without a bar on the expiry day, §2.3).

**Every one of the 16 variants loses over all sessions, at both fills.** The only positive era cells are the two held NIFTY variants at the bar close from 2025 (+₹284 and +₹355), and their CIs span zero.
- **Same-day:** the bar-close mean is −₹263 to −₹342 on both indices, each CI wholly below zero.
- **Held to the expiry day:** −₹326 to −₹433 at the bar close and −₹916 to −₹1,306 at the conservative fill.
- **The walk-forward picks:** NIFTY 11:15 → expiry at the conservative fill made −₹887 (CI −₹1,793 … +₹5) on 185 out-of-sample trades; 09:30 → 15:20 at the bar close made −₹117 (−₹330 … +₹85).
- **Both NIFTY picks have the 180 trades, and both fail the CI, the PF, multiple testing and the complete-bar era.** The SENSEX picks also fail the sample size.

### 4.2 Why it loses: the exposure

At each bar-close entry, Black-76 on each expiry's parity forward gives the calendar's net greeks per lot (medians over the sessions):

| index | entry | net gamma: ₹ lost for a 1% index move | net vega: ₹ per vol point | net theta: ₹ per session |
|---|---|---|---|---|
| NIFTY | 09:30 | −₹1,631 | +₹530 | +₹648 |
| | 11:15 | −₹1,809 | +₹549 | +₹759 |
| SENSEX | 09:30 | −₹2,263 | +₹833 | +₹835 |
| | 11:15 | −₹2,334 | +₹872 | +₹997 |

- **The calendar is short gamma, long vega and long theta.** The near week's gamma is several times the next week's, and the next week carries more vega.
- **It earns when the index stays near the strike and the next week's implied volatility holds.**
- **It loses on a move of about 1% or more, or when the next week's implied volatility falls.** Implied volatility usually does fall through the morning: WP11 §6.1 found the straddle richest at the open and at or below the day's average from 13:00.
- **At the bar close the same-day calendar's gross is about −₹20 (09:30 entry) to −₹100 (11:15).** Theta is paid back by gamma and vega, and the eight orders' ₹240 of charges is the loss.
- **The conservative fill charges eight 1-minute ranges** (four legs in, four out), so the same-day calendar loses ₹970–1,330 a lot.

**Margin** (approximated as in WP10 §6; no broker quote for this exact structure):
- **On a non-expiry day** the exchanges' SPAN margin offsets the two expiries. That leaves mainly the exposure margin on the short legs, about 2% of each leg's notional. With today's levels (NIFTY ≈ 22,600 × 65 ≈ ₹14.7 lakh a leg) that is roughly ₹0.6–0.8 lakh a lot, against ₹1.5–2.2 lakh for the naked straddle. That benefit is real.
- **The held variant meets two SEBI measures on its expiry day** (r1 note, table of measures):
  - from 1 Feb 2025 the calendar-spread benefit is withdrawn for contracts expiring that day;
  - from 20 Nov 2024 short options expiring that day carry another 2% extreme-loss margin.
- **So on its expiry day the held calendar is margined roughly like the naked straddle plus that 2%:** about ₹2.1–2.8 lakh a lot, 42–56% of the ₹5 lakh account.
- **The two entries of one week overlap** (DTE 2 and DTE 1, both held to the expiry), which doubles that on the day before expiry.

### 4.3 The tail

| variant | fill | trades | net ₹ | worst day / expiry week | 10 worst | max drawdown (% of ₹5 lakh) |
|---|---|---|---|---|---|---|
| NIFTY 09:30 → 15:20 same day (mid pick) | mid | 463 | −₹1,21,905 | −₹9,103 (20 Dec 2023, −2.0%) | −₹53,245 | ₹1,29,785 (26.0%) |
| NIFTY 11:15 → expiry 15:20 (conservative pick) | conservative | 463 | −₹4,49,295 | −₹21,254 (week to 24 Feb 2022) | −₹1,84,280 | ₹4,53,687 (90.7%) |
| | mid | 463 | −₹1,50,759 | −₹19,902 (week to 28 Aug 2025) | −₹1,68,931 | ₹1,99,502 (39.9%) |
| SENSEX 11:15 → expiry 15:20 (both picks) | conservative | 133 | −₹1,21,802 | −₹25,136 (week to 12 Mar 2026) | −₹1,42,622 | ₹1,30,464 (26.1%) |
| | mid | 133 | −₹47,338 | −₹23,457 (week to 12 Mar 2026) | −₹1,29,303 | ₹88,401 (17.7%) |

**The worst NIFTY expiry weeks of the held calendar** (conservative fill; two entries a week):
- **24 Feb 2022, the invasion of Ukraine:** −₹21,254 (−₹9,196 and −₹12,058, the index −4.5% and −5.5% from entry).
- **28 Aug 2025:** −₹21,233 (−1.8% / −1.2%).
- **17 Apr 2025:** −₹19,919 (+2.4% / +2.3%).
- **18 Jan 2024:** −₹19,186 (−3.0% / −1.3%).
- **2 Jan 2025:** −₹18,312 (+2.5% / +1.8%).
- **26 Oct 2023:** −₹17,717.

The worst SENSEX weeks are 12 Mar 2026 (−₹25,136) and 19 Mar 2026 (−₹21,322). The long next-week leg caps nothing on a 2–5% move into the near expiry: by then the short legs are nearly all intrinsic value, and the long legs gain only part of it back.

### 4.4 Verdict on H2

**FAIL on both indices, at both fills, for every entry and exit.** The calendar is the cheapest structure here to margin and the most expensive to trade. At the bar close it is about flat before costs and negative after them. Its only positive cells, two held NIFTY variants from 2025, have CIs that span zero.

---

## 5. H3: the event crush (descriptive)

**NIFTY** (37 events; one lot sold at 15:20 on the session before; ₹ per lot at the bar close · conservative):

| event day | kind | sold on | contract (sessions left on the day) | strike | premium ₹/lot (mid) | bought back 09:30 | bought back 15:20 | index from the sale to 09:30 / 15:20 |
|---|---|---|---|---|---|---|---|---|
| 2021-06-04 | RBI | 2021-06-03 | 2021-06-10 (4) | 15700 | ₹16,920 | −₹646 · −₹1,063 | ₹1,984 · ₹1,669 | +0.10% / −0.13% |
| 2021-08-06 | RBI | 2021-08-05 | 2021-08-12 (4) | 16300 | ₹10,000 | −₹230 · −₹490 | ₹978 · ₹608 | +0.16% / −0.31% |
| 2021-10-08 | RBI | 2021-10-07 | 2021-10-14 (4) | 17800 | ₹12,595 | −₹597 · −₹1,010 | ₹406 · ₹91 | +0.46% / +0.59% |
| 2021-12-08 | RBI | 2021-12-07 | 2021-12-09 (1) | 17200 | ₹9,472 | −₹1,948 · −₹2,388 | −₹5,055 · −₹5,140 | +1.11% / +1.68% |
| 2022-02-01 | Budget | 2022-01-31 | 2022-02-03 (2) | 17350 | ₹23,622 | ₹46 · −₹507 | ₹6,715 · ₹6,390 | +0.97% / +1.41% |
| 2022-02-10 | RBI | 2022-02-09 | 2022-02-10 (0) | 17450 | ₹5,960 | ₹293 · −₹590 | −₹2,044 · −₹2,226 | +0.02% / +0.78% |
| 2022-04-08 | RBI | 2022-04-07 | 2022-04-13 (3) | 17650 | ₹15,462 | ₹216 · −₹312 | ₹211 · −₹109 | +0.08% / +0.85% |
| 2022-06-08 | RBI | 2022-06-07 | 2022-06-09 (1) | 16400 | ₹10,812 | ₹44 · −₹289 | ₹3,929 · ₹3,651 | −0.17% / −0.41% |
| 2022-08-05 | RBI | 2022-08-04 | 2022-08-11 (3) | 17350 | ₹17,262 | ₹312 · −₹42 | ₹2,949 · ₹2,464 | +0.53% / +0.19% |
| 2022-09-30 | RBI | 2022-09-29 | 2022-10-06 (3) | 16800 | ₹18,628 | −₹125 · −₹838 | −₹1,999 · −₹2,486 | −0.33% / +1.65% |
| 2022-12-07 | RBI | 2022-12-06 | 2022-12-08 (1) | 18650 | ₹7,865 | ₹547 · ₹307 | ₹1,030 · ₹685 | −0.17% / −0.61% |
| 2023-02-01 | Budget | 2023-01-31 | 2023-02-02 (1) | 17700 | ₹14,990 | ₹392 · −₹426 | ₹5,617 · ₹5,078 | +0.48% / −0.34% |
| 2023-02-08 | RBI | 2023-02-07 | 2023-02-09 (1) | 17700 | ₹8,502 | −₹803 · −₹1,008 | −₹1,451 · −₹1,678 | +0.57% / +0.87% |
| 2023-04-06 | RBI | 2023-04-05 | 2023-04-06 (0) | 17550 | ₹4,305 | ₹113 · −₹102 | ₹1,866 · ₹1,714 | −0.18% / +0.19% |
| 2023-06-08 | RBI | 2023-06-07 | 2023-06-08 (0) | 18700 | ₹4,332 | ₹128 · −₹120 | ₹736 · ₹601 | +0.10% / −0.54% |
| 2023-08-10 | RBI | 2023-08-09 | 2023-08-10 (0) | 19650 | ₹4,675 | −₹1,456 · −₹1,746 | −₹929 · −₹1,149 | −0.33% / −0.53% |
| 2023-10-06 | RBI | 2023-10-05 | 2023-10-12 (4) | 19550 | ₹10,075 | ₹160 · −₹43 | −₹211 · −₹413 | +0.33% / +0.48% |
| 2023-12-08 | RBI | 2023-12-07 | 2023-12-14 (4) | 20900 | ₹12,418 | −₹37 · −₹145 | ₹741 · ₹548 | +0.21% / +0.28% |
| 2024-02-01 | Budget | 2024-01-31 | 2024-02-01 (0) | 21750 | ₹13,262 | ₹2,137 · ₹1,503 | ₹10,508 · ₹10,261 | −0.04% / −0.14% |
| 2024-02-08 | RBI | 2024-02-07 | 2024-02-08 (0) | 21950 | ₹7,692 | ₹1,185 · ₹667 | −₹4,279 · −₹4,554 | +0.29% / −0.98% |
| 2024-04-05 | RBI | 2024-04-04 | 2024-04-10 (3) | 22550 | ₹12,575 | −₹976 · −₹1,395 | ₹868 · ₹513 | −0.26% / −0.06% |
| **2024-06-04** | **election** | 2024-06-03 | 2024-06-06 (2) | 23300 | ₹17,115 | **−₹13,145 · −₹13,628** | **−₹22,508 · −₹22,895** | **−3.82% / −6.00%** |
| 2024-06-07 | RBI | 2024-06-06 | 2024-06-13 (4) | 22850 | ₹11,310 | −₹691 · −₹874 | −₹3,735 · −₹3,871 | +0.37% / +2.01% |
| 2024-07-23 | Budget | 2024-07-22 | 2024-07-25 (2) | 24500 | ₹10,782 | −₹94 · −₹340 | ₹4,830 · ₹4,684 | +0.05% / −0.17% |
| 2024-08-08 | RBI | 2024-08-07 | 2024-08-08 (0) | 24300 | ₹4,572 | −₹752 · −₹916 | −₹195 · −₹325 | −0.40% / −0.95% |
| 2024-10-09 | RBI | 2024-10-08 | 2024-10-10 (1) | 25000 | ₹6,612 | ₹231 · −₹14 | ₹2,359 · ₹2,087 | +0.15% / −0.04% |
| 2024-12-06 | RBI | 2024-12-05 | 2024-12-12 (4) | 24750 | ₹10,899 | −₹1,124 · −₹1,304 | ₹1,707 · ₹1,550 | −0.11% / −0.25% |
| 2025-02-01 | Budget (Saturday) | 2025-01-31 | 2025-02-06 (4) | 23500 | ₹37,526 | ₹612 · −₹251 | ₹15,559 · ₹15,049 | +0.07% / −0.21% |
| 2025-02-07 | RBI | 2025-02-06 | 2025-02-13 (4) | 23600 | ₹28,361 | −₹1,198 · −₹1,629 | ₹5,510 · ₹4,820 | −0.08% / −0.19% |
| 2025-04-09 | RBI | 2025-04-08 | 2025-04-09 (0) | 22550 | ₹25,744 | ₹6,100 · ₹4,821 | ₹14,275 · ₹13,934 | −0.72% / −0.58% |
| 2025-06-06 | RBI | 2025-06-05 | 2025-06-12 (4) | 24750 | ₹27,971 | ₹2,176 · ₹1,561 | −₹3,542 · −₹3,793 | −0.17% / +0.95% |
| 2025-08-06 | RBI | 2025-08-05 | 2025-08-07 (1) | 24650 | ₹13,856 | ₹326 · −₹169 | ₹2,179 · ₹1,970 | −0.04% / −0.34% |
| 2025-10-01 | RBI | 2025-09-30 | 2025-10-07 (3) | 24600 | ₹20,512 | ₹1,499 · ₹967 | −₹3,175 · −₹3,648 | +0.21% / +0.91% |
| 2025-12-05 | RBI | 2025-12-04 | 2025-12-09 (2) | 26050 | ₹15,435 | ₹31 · −₹633 | −₹356 · −₹659 | −0.04% / +0.56% |
| 2026-02-01 | Budget (Sunday) | 2026-01-30 | 2026-02-03 (2) | 25300 | ₹25,759 | −₹764 · −₹1,556 | −₹12,001 · −₹12,702 | −0.07% / −2.09% |
| 2026-02-06 | RBI | 2026-02-05 | 2026-02-10 (2) | 25650 | ₹17,397 | ₹1,421 · ₹972 | ₹3,905 · ₹3,547 | −0.25% / +0.26% |
| **2026-04-08** | **RBI** | 2026-04-07 | 2026-04-13 (3) | 23100 | ₹43,696 | **−₹14,049 · −₹14,605** | **−₹19,008 · −₹19,209** | **+3.35% / +3.78%** |
| 2026-06-05 | RBI | 2026-06-04 | contract missing from the dataset | | | | | |

**SENSEX** (22 events):

| event day | kind | sold on | contract (sessions left on the day) | strike | premium ₹/lot (mid) | bought back 09:30 | bought back 15:20 | index from the sale to 09:30 / 15:20 |
|---|---|---|---|---|---|---|---|---|
| 2023-06-08 | RBI | 2023-06-07 | contract missing from the dataset | | | | | |
| 2023-08-10 | RBI | 2023-08-09 | 2023-08-11 (1) | 66100 | ₹4,404 | −₹1,118 · −₹1,303 | −₹300 · −₹391 | −0.41% / −0.56% |
| 2023-10-06 | RBI | 2023-10-05 | 2023-10-06 (0) | 65600 | ₹3,390 | ₹224 · ₹162 | −₹826 · −₹883 | +0.30% / +0.49% |
| 2023-12-08 | RBI | 2023-12-07 | 2023-12-08 (0) | 69500 | ₹3,186 | ₹122 · ₹13 | −₹128 · −₹213 | +0.20% / +0.42% |
| 2024-02-01 | Budget | 2024-01-31 | 2024-02-02 (1) | 71700 | ₹12,188 | ₹1,254 · ₹686 | ₹7,086 · ₹6,846 | −0.05% / −0.11% |
| 2024-02-08 | RBI | 2024-02-07 | 2024-02-09 (1) | 72200 | ₹8,744 | ₹553 · ₹255 | ₹295 · −₹45 | +0.31% / −0.99% |
| 2024-04-05 | RBI | 2024-04-04 | 2024-04-05 (0) | 74300 | ₹4,437 | −₹567 · −₹752 | ₹3,702 · ₹3,644 | −0.28% / −0.02% |
| **2024-06-04** | **election** | 2024-06-03 | 2024-06-07 (3) | 76500 | ₹23,886 | **−₹13,012 · −₹14,114** | **−₹24,519 · −₹24,609** | **−3.75% / −5.80%** |
| 2024-06-07 | RBI | 2024-06-06 | 2024-06-07 (0) | 75100 | ₹6,415 | −₹1,110 · −₹1,653 | −₹9,851 · −₹10,140 | +0.35% / +2.17% |
| 2024-07-23 | Budget | 2024-07-22 | 2024-07-26 (3) | 80500 | ₹16,732 | ₹882 · ₹555 | ₹7,455 · ₹7,183 | +0.08% / −0.17% |
| 2024-08-08 | RBI | 2024-08-07 | 2024-08-09 (1) | 79500 | ₹8,822 | −₹246 · −₹521 | −₹43 · −₹183 | −0.36% / −0.83% |
| 2024-10-09 | RBI | 2024-10-08 | 2024-10-11 (2) | 81600 | ₹10,987 | ₹272 · −₹121 | ₹2,166 · ₹1,771 | +0.15% / −0.11% |
| 2024-12-06 | RBI | 2024-12-05 | 2024-12-06 (0) | 81900 | ₹7,944 | ₹1,189 · ₹754 | ₹5,885 · ₹5,744 | −0.14% / −0.26% |
| 2025-02-01 | Budget (Saturday) | 2025-01-31 | 2025-02-04 (2) | 77500 | ₹28,240 | ₹539 · −₹401 | ₹15,465 · ₹14,870 | +0.10% / −0.05% |
| 2025-02-07 | RBI | 2025-02-06 | 2025-02-11 (2) | 78100 | ₹21,534 | −₹1,133 · −₹1,488 | ₹5,526 · ₹5,046 | −0.06% / −0.26% |
| 2025-04-09 | RBI | 2025-04-08 | 2025-04-15 (2) | 74200 | ₹33,658 | ₹764 · −₹317 | ₹405 · −₹272 | −0.57% / −0.47% |
| 2025-06-06 | RBI | 2025-06-05 | 2025-06-10 (2) | 81500 | ₹20,216 | ₹1,158 · ₹622 | −₹488 · −₹770 | −0.20% / +0.86% |
| 2025-08-06 | RBI | 2025-08-05 | 2025-08-12 (4) | 80800 | ₹18,565 | ₹1 · −₹445 | ₹1,135 · ₹901 | −0.02% / −0.26% |
| 2025-10-01 | RBI | 2025-09-30 | 2025-10-01 (0) | 80200 | ₹9,422 | ₹1,128 · ₹754 | −₹6,260 · −₹6,375 | +0.21% / +0.94% |
| 2025-12-05 | RBI | 2025-12-04 | 2025-12-11 (4) | 85300 | ₹17,216 | ₹34 · −₹556 | −₹467 · −₹793 | −0.03% / +0.54% |
| 2026-02-01 | Budget (Sunday) | 2026-01-30 | 2026-02-05 (4) | 82300 | ₹28,577 | −₹904 · −₹1,709 | −₹11,268 · −₹11,823 | +0.03% / −1.99% |
| 2026-02-06 | RBI | 2026-02-05 | 2026-02-12 (4) | 83300 | ₹20,929 | ₹1,517 · ₹1,077 | ₹2,122 · ₹1,848 | −0.18% / +0.40% |
| **2026-04-08** | **RBI** | 2026-04-07 | 2026-04-09 (1) | 74600 | ₹32,129 | **−₹21,327 · −₹21,526** | **−₹27,922 · −₹28,123** | **+3.56% / +3.96%** |
| 2026-06-05 | RBI | 2026-06-04 | contract missing from the dataset | | | | | |

**By kind** (n, ₹ per trade, share profitable; bar close / conservative):

| index | bought back | all events | Budget | RBI | election | all but the election |
|---|---|---|---|---|---|---|
| NIFTY | 09:30 | 37: −₹559, 54% / −₹1,017, 19% | 6: ₹388, 67% / −₹263, 17% | 30: −₹328, 53% / −₹748, 20% | −₹13,145 / −₹13,628 | 36: −₹209 / −₹667 |
| | 15:20 | 37: ₹226, 59% / −₹80, 57% | 6: ₹5,205, 83% / ₹4,793, 83% | 30: −₹11, 57% / −₹294, 53% | −₹22,508 / −₹22,895 | 36: ₹858 / ₹554 |
| SENSEX | 09:30 | 22: −₹1,354, 64% / −₹1,819, 41% | 4: ₹443, 75% / −₹217, 50% | 17: −₹1,091, 65% / −₹1,473, 41% | −₹13,012 / −₹14,114 | 21: −₹798 / −₹1,234 |
| | 15:20 | 22: −₹1,401, 50% / −₹1,671, 41% | 4: ₹4,684, 75% / ₹4,269, 75% | 17: −₹1,474, 47% / −₹1,720, 35% | −₹24,519 / −₹24,609 | 21: −₹301 / −₹579 |

**Reading.**
1. **Budgets are the one event family where the crush showed up in prices,** sold the evening before and bought back near the close.
   - NIFTY won on 5 of 6 Budgets, by +₹4.8k to +₹15.6k a lot, and SENSEX on 3 of 4. Saturday 1 Feb 2025 alone made +₹15.6k (NIFTY) and +₹15.5k (SENSEX).
   - The exception is Sunday 1 Feb 2026, when the speech raised STT on derivatives. The index fell 2.1% and the sale lost −₹12.0k and −₹11.3k.
   - That is 6 and 4 observations. They are the Q1 note's "VIX falls on Budget day", not a tested rule.
2. **RBI days were about fair for NIFTY** (−₹11 a trade over 30 decisions).
   - SENSEX lost −₹1,474 a trade over 17 decisions, almost all of it on 8 Apr 2026. Without that day SENSEX's RBI average is +₹179.
   - On 8 Apr 2026 both indices were 3.4–3.6% higher at 09:30 than at the previous 15:20, and the sale lost −₹19k and −₹28k a lot. The NIFTY premium had been the richest of any NIFTY event (₹43.7k a lot): the options were already pricing a big move, and the move was bigger.
3. **The election result is the tail.** On 4 Jun 2024 the index fell 6.0% (NIFTY) and 5.8% (SENSEX) from the previous 15:20, and one lot lost −₹22.5k and −₹24.5k: 1.3× and 1.0× the premium collected.
   - The sale on exit-poll day, 3 Jun, came after India VIX had fallen more than 20% that day (R2): 23300 strike at ₹684.60 a unit × 25.
   - At 15:20 on the 4th the 23300 put was ₹1,415 in the money, and the buy-back cost about ₹1,580 a unit. The run's −₹22,508 matches.
4. **On Budget days the crush came with the speech, not the open.** Bought back at 09:30, the Budget sales made +₹388 (NIFTY) and +₹443 (SENSEX) at the bar close, against +₹5.2k and +₹4.7k at 15:20 (the speech starts at 11:00; RBI announces at 10:00).
5. **No conclusion is possible at 37 and 22 events.**
   - The NIFTY 15:20 bar-close mean's CI spans −₹2,142 to +₹2,392, and the election alone moves the mean from +₹226 to +₹858.
   - The plan's rule N1 (no new position the session before a scheduled event) stays as it is for buyers. Nothing here makes the event-eve sale a strategy.

---

## 6. The bar, multiple testing and the ledger

- **The ledger.** `reports/trials.jsonl` went from 2,468 to **2,708 lines**: 240 `"wp": "WP13"` strategy lines, one per variant.
  - No perturbation lines were written, because no pick passed the out-of-sample CI and PF (§1.6).
  - A rerun appends nothing: logged variants are skipped.
- **Bonferroni:** 0.05 / 2,708 = 1.85 × 10⁻⁵. The smallest out-of-sample p of any pick is 0.25 (NIFTY H1a at the bar close). Over all days, the best H1a bar-close variant (NIFTY 13:30 → 15:20, +50% stop) has p ≈ 2 × 10⁻³, also far from the level.
- **The deflated Sharpe ratio.** V[SR] over this study's 232 H1 and H2 lines is 0.163, so SR₀ = 1.43 per session.
  - That variance is dominated by the gap between the two fills, and it makes every DSR 0.000.
  - With the null variance 1/(T − 1) the best pick reaches 0.002. Nothing is close to 0.95.
- **The criteria, pick by pick** (§1.7 numbering):
  - No H1 or H2 pick passed criteria 2, 3 or 5, at either fill.
  - The NIFTY H2 picks passed criterion 1 (185 trades); every H1 pick and the SENSEX H2 picks failed it.
  - Only three bar-close picks passed the complete-bar-era check (criterion 6): NIFTY H1a, NIFTY H1b and SENSEX H1a. No conservative pick did.
  - None reached criterion 4.

## 7. Paper-test spec

**None.** No pick passes §1.7, so by the pre-registered rule no paper-test spec is written for the ₹5 lakh paper account. Writing one would turn three failed out-of-sample tests into an experiment with a negative or zero expected value. The nearest miss is NIFTY's naked afternoon straddle at the bar close. It is not a candidate:
- it is naked;
- its out-of-sample CI spans zero, and its 2025 was negative;
- even the bar's minimum sample (180 out-of-sample expiries) would take NIFTY about 3.5 years of weekly expiries to collect.

## 8. What changed after the freeze

1. **No definition changed.**
   - The development run (without the ledger) used the code committed at the freeze, unchanged.
   - The final run (`--ledger`) added only the presentation changes of item 2.
   - Their verdict tables are identical, and `git diff 9c28ae7` on the code shows only those lines.
2. **Presentation only**, after the development run:
   - The tail table now prints "the worst 5% of days lost N× the net" as a positive multiple; it was a negative ratio.
   - Duplicate worst-day lists, for a reference variant that was also a pick, are no longer printed.
   - A "stopped" column (the share of trades closed by the stop) was added.
   - Headers say that H2's "premium" is the net debit.
   - No number changed.
3. **Checks by hand with `debug`** (NIFTY, 14 and 15 Jun 2023) reproduce the H1 and H2 fills from the raw bars (§3.3).
4. **The report's §0 and §3–§9 and the status line** were written after the runs. §1 and §2 are byte-for-byte the freeze commit's.
5. **The raw download was deleted after the extract**, as planned. The extract (842 MB) stays in the scratchpad, outside the repository.

## 9. Reproduce

```bash
S=<scratchpad>; X=$S/wp11/data/x13; B=<bhavcopy cache with index-daily.json>   # WP10's compact cache
# 1. Download (1.33 GB, sha256-checked, 36 s) into a new empty directory; delete it after step 2:
python3 -I scripts/research/wp13_fetch.py --meta <dir for the HF file lists> --out <download dir>
# 2. Extract (untrusted input: python3 -I with a vendored pyarrow/pandas; ~25 min; 842 MB of csv.gz):
python3 -I scripts/research/wp13_extract.py --pylib <pyarrow+pandas dir> --raw <download dir> --daily $B/index-daily.json --out $X
# 3. Samples, cut dates and bar coverage (no prices; §2):
npx tsx scripts/research/wp13-expiry-calendar-events.ts coverage --x $X --dir $B --out reports/wp13
# 4. Every variant, the walk-forward picks, the bar, the tails, the events and the ledger (~5 min):
NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/research/wp13-expiry-calendar-events.ts run --x $X --dir $B --out reports/wp13 [--ledger]
# 5. One session by hand:
npx tsx scripts/research/wp13-expiry-calendar-events.ts debug --x $X --dir $B --index NIFTY --day 2023-06-15
# 6. Unit tests of the new pure helpers:
npx vitest run src/engine/backtest/expiryCalendar.test.ts
```

| file | what it holds |
|---|---|
| `scripts/research/wp13_fetch.py` | The download at the pinned revision, with the sha256 check |
| `scripts/research/wp13_extract.py` | The extractor: contracts A and N of every session, the strike window over four sessions, WP11's file formats and data checks |
| `scripts/research/wp13-expiry-calendar-events.ts` | The `coverage`, `run` and `debug` commands: samples, cuts, H1–H3, statistics, the bar, the tails, the events, the ledger and the tables |
| `src/engine/backtest/expiryCalendar.ts` (+ `.test.ts`) | The new pure helpers, with tests: `remainingSessionEm`, `syncMinute`, `calendarNoArbitrage`, `runOvernight` (with the expiring-leg fallback), `blocksOf`, `worstBlocks`, `sessionBefore`, `cutDate`, `pickBest`, `robustness`, `overallVerdict` |

- **Reused code.** Fills, positions and stops come from WP11's `intraday1m.ts` (`runPosition`, `nearestListed`, `perturbDistance`), and its loaders from `wp11-real-intraday.ts`. Charges, structure P&L, wings, tails and the event calendar come from WP10's `shortPremium.ts`; the bootstrap and the DSR from `metrics.ts`.
- **Isolation.** Nothing in the engine imports the new code.
- **Data.** No market data is committed. `reports/wp13/` (the generated tables and `summary.json`) is gitignored.
