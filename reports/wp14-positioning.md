# WP14: does FII positioning (vs retail) predict NIFTY, and can an option buyer profit from it?

Sat 10 Oct 2026. Branch `worktree-agent-a94277d8be4ff1dee`, reset to `19ad6d4` (head of `claude/gifted-wright-3d8r3j`). Analysis only: no paper trading, no deploys, no pushes; nothing in the engine changes.

**Data and licence.**
- **Positioning:** NSE's published daily report "Participant wise Open Interest (no. of contracts) in Equity Derivatives", one file per trading day at `https://archives.nseindia.com/content/nsccl/fao_participant_oi_DDMMYYYY.csv`, downloaded from the archive only (no nseindia.com, bseindia.com or broker website API was called).
- **Option prices:** the Hugging Face dataset **"India Index & Options – 1-minute OHLC" by TradeMarkk** (`thetrademarkk/india-index-options-1m`, revision `0f4800e43e6f96cec0794369d78eb4d3c4211ef5`, https://huggingface.co/datasets/thetrademarkk/india-index-options-1m), licensed **CC-BY-NC-4.0**: non-commercial research use only, attributed here; WP11 §2 verified it against the exchange's own files. NSE F&O bhavcopies (WP6's compact cache) for lots, expiries, short sessions and end-of-day option prices.
- **Index and flows:** Yahoo's ^NSEI daily bars (Q2's download); NSDL's custodian-confirmed FPI daily series (Q2's parsed archive) for the owner's example.
- No raw or extracted data is committed (the repository is public); the scripts rebuild everything from a download.

**Status of this file:** §1 and §2 were written and committed (the freeze commit) before any signal-conditional return or P&L was computed, and they are unchanged. §0 and §3–§12 were added after the runs; §11 lists every change made after the freeze.

---

## 1. Frozen definitions (pre-registered before any signal-conditional return or P&L)

### 1.0 The question and what was known before

- **The owner's belief:** "FIIs sold, so puts paid" (8 Oct 2026). Q2 tested the cash-flow form: FII cash flows have correlation 0.00 with the next open→close over 1,877 days. This package tests the *positioning* form: what FIIs (and retail "Clients") hold in index futures and options, from NSE's participant-wise open interest.
- **Prior evidence** (docs/research/notes/r3-signals-evidence.md #7 and #14; r5-positioning-evidence.md, read before this freeze):
  - No peer-reviewed test of whether NSE participant-wise OI predicts NIFTY was found. The nearest analogues (Taiwan, Korea, the US Commitments of Traders) are order-flow studies or weekly positions, weak (R² ≈ 0.02) and unstable across samples (R5 §1).
  - Every Indian practitioner rule rests on 4–16 episodes, all in sample (R5 §2): Marketcalls' 6% vs 17% annualised after FII net-short vs net-long readings, "8 of 15" 20-session short streaks ended higher, "a flip to net long → up over the next 30 sessions > 90%"; HDFC's "FII long/short < 0.15 at the start of a series → higher, 4 of 4".
  - **The data hold a regime inversion** (R5 §3.3): FIIs were 70–91% long index futures in 2012–2016 and 8–23% long in 2025–26, with Clients the mirror image. A full-sample "after net-short vs net-long" split mostly compares two eras. The signals below are therefore percentile ranks within a trailing window, and the two regimes are reported side by side.
  - **"FII" is not one directional fund** (R5 §3.6): it mixes long-only funds hedging cash books, arbitrage desks, hedge funds, ETF market-makers and prop firms registered as FPIs.
- **Two questions, two tests.** "Do FII positions predict NIFTY?" is a direction test on the index (§1.4). "Can an option buyer profit from it?" is a test on real option prices with costs (§1.5). A direction effect too small to pay an option's decay and costs answers the first question and not the second.

### 1.1 Data

- **Participant OI files** (`scripts/research/wp14_fetch.py`):
  - Probed first: files exist from 2 Jan 2012; none for 1 Jul, 3 Oct, 1 Nov, 1 Dec, 15 Dec or 23 Dec 2011 (R5 §3.1 found the same, plus 26 and 30 Dec 2011).
  - Downloaded: every weekday from 26 Dec 2011 to 9 Oct 2026, plus the weekend sessions known from Yahoo and the bhavcopy cache; one GET at a time, at least 1.2 s apart, User-Agent `research-download/1.0 (read-only)`; a 403 or 429 would have stopped the run. Each request's status and the file's `Last-Modified` header are logged.
  - **Parsed by label, never by position** (`parseParticipantOi`): the title row's "as on" date, the header row (columns matched by name after stripping quotes, tabs and spaces), and the rows Client, DII, FII (or FPI), Pro and TOTAL. Cells are split as quoted CSV, and lines may end in CRLF, LF or a bare CR (4 Oct 2017); a file may also start at its header row, without the title (17 Jul 2014, 13 Jun 2018). A count may be plain (`307664`), quoted with Indian digit grouping (`"2,38,483.00"`, 20 Jan 2012), fractional (stock futures in 21 files of 2012–2018, presumably contracts adjusted for corporate actions; a warning), or `NA` for no position (3 Jan 2012), which is read as 0 with a warning and must then agree with the TOTAL row like any other count.
  - **Integrity checks per file:** every category present once with non-negative counts; the four categories add up to TOTAL in every column; TOTAL longs equal TOTAL shorts in every futures and options column (so net calls and net puts across the four categories add to zero). A miss of at most 0.01% of the total (or 10 contracts) is a rounding warning. A larger miss **in an index futures or index options column** (the six columns the signals read; `INDEX_COLUMNS`), a missing row or column, a value that is not a count, a title date that differs from the file's date, or the FII/DII check below excludes the file. A larger miss confined to the stock or "Total Long/Short Contracts" columns is a reported warning: five 2016–2017 files have miscomputed Total columns while every instrument column ties out.
  - **The FII/DII label check** (R5 §3.2: the 2 Jan 2012 file's "FII" row looks like a DII row): FIIs always write index options and DIIs wrote none in the files of 2012–2025, so a file whose FII row has no index-option shorts while its DII row has some is treated as mislabelled and **excluded** (never relabelled).
  - Coverage, missing days, layouts and publication times: §2.1.
- **Sessions** (`buildWorld`):
  - The calendar is every day with a participant file, a complete Yahoo bar or a bhavcopy.
  - **Special sessions:** weekend sessions; NSE's Diwali Muhurat sessions (about one hour; the 14 Lakshmi Puja days 2012–2025, a calendar constant checked against the data in §2.1); and the bhavcopy's short sessions (WP6's `shortSessions`: NIFTY contracts below 30% of the neighbouring sessions, from Feb 2019; DR-drill Saturdays). All other sessions are **regular**.
- **NIFTY daily index:** Yahoo's ^NSEI daily bars (official open and close), downloaded on 9 Oct 2026 before the open, so the last bar is 8 Oct 2026. Checked against the bhavcopy cache's own Yahoo download and against the 1-minute index bars (§2.2).
- **Real 1-minute option prices** (NIFTY): WP13's extract of the TradeMarkk dataset, which holds, for every session from 24 May 2021 to 2 Jul 2026, the nearest expiry on or after the day (A) and the next one (N), strikes within max(6.5 steps, 2.6 expected moves + 1 step) of the index range of the session and the three before it, bars 09:15–15:30. Valid sessions as WP11 §1.1 (≥ 370 index bars from 09:15 with a 09:15 bar, a bhavcopy, not a short session). **Two data eras** (WP11 §2): to 31 Dec 2024 the bars hold every trade; from 1 Jan 2025 they are built from sampled prices (closes, last trade and volume exact; extremes mostly missing), so the conservative fill is a true worst case only in the first era.
- **End-of-day option prices** (M1 only): the bhavcopy cache's NSE closing prices, Feb 2019 – Oct 2026, options expiring within 45 calendar days.
- **Lots and expiries:** the exchange's, from the bhavcopy: the listed expiries of the day and the modal lot of the contract's rows that day.
- **FII cash flows** (the owner's example): NSDL's Equity / Stock Exchange net (₹ crore) by report date, assigned to the session before the report date (Q2's verified alignment).

### 1.2 Timing: no same-day use

- Day T's file is published after the close (about 19:00 IST; §2.1 measures it), so it is used **from the next session's 09:15**, never on T.
- **Entry sessions E are regular sessions.** E trades on the latest file published before its open: the file of the session immediately before E, skipping special sessions that have no usable file. If that session is regular and its file is missing or excluded, E has no signal (skipped and counted). A special session is never an entry and is not counted in a hold, but its file, when it has one, is a reading (so a Saturday Budget session's file feeds the Monday).
- Holds count regular sessions, the entry included: **D1** = E; **W1** = E … E+4; **M1** = E … E+19.

### 1.3 The signals

- **L** = FII Future Index Long ÷ (Future Index Long + Future Index Short).
- **S1** = L. **S2** = L_T − L_{T−1}, only across consecutive file sessions (a missing or excluded file breaks it). **S3** = L_FII − L_Client (Client index futures, same formula). **S4** = the FII index-options net direction, [(Call Long − Call Short) − (Put Long − Put Short)] ÷ (Call Long + Call Short + Put Long + Put Short), in [−1, 1] (long calls and short puts bullish).
- **Rank:** the percentile of each reading within the **trailing 250 readings**, itself included (the share below plus half the ties; `trailingRank`). No rank before 250 readings exist.
- **Buckets:** bottom tercile (rank < 1/3) and top tercile (rank > 2/3) trade; the middle tercile is no trade (`extremeBucket`).
- **Sign:** *follow* = top tercile bullish (long the index, buy the call), bottom tercile bearish (short, buy the put); *fade* = the reverse. For S3 "follow" means follow the FIIs against the Clients.
- All four are ratios of contract counts, so a lot-size change does not move them within a day (R5 §3.5); S2 can still jump while old and new lots coexist.

### 1.4 Direction tests on the NIFTY index (does it predict?)

- **Variants:** 4 signals × 3 horizons (D1, W1, M1) × 2 signs = 24, over the longest history the files allow (from the first ranked reading, about 250 sessions after Jan 2012, to the last Yahoo bar).
- **Return:** for each entry session E with a signal, r = close(E+h−1) ÷ open(E) − 1 at the official open and close. Daily bars have no 09:30 price, so the index test enters at the open; the option test enters at 09:30.
- **Signed return:** x = s·r with s = ±1 from the bucket and the sign; x = 0 on middle-tercile sessions.
- **Statistics:**
  - Mean signed return per trade; per session (sessions without a trade are 0); profit factor of x over the trades.
  - **Hit rate** (x > 0) against the **base rate**: the hit rate of a random side drawn at the strategy's own share of long trades, on the same days, mean of p·1(r > 0) + (1 − p)·1(r < 0); and the share of the same days on which the index rose.
  - **Circular block bootstrap** (Politis & Romano; `blockBootstrap`) of the session series, block length 1 for D1 (the day block) and **twice the hold** for W1 (10) and M1 (40), so overlapping holds stay inside a block; per trade and per session; 20,000 resamples (100,000 when both lower bounds are above zero), seed 7; one-sided p = (1 + #{resamples ≤ 0}) / (1 + resamples).
  - **Placebo:** a random side at the strategy's own share of longs, on the same days; its expectation per trade is (2p − 1)·r, so the gap is the mean of x − (2p − 1)·r over the trades, with the SE of the same block bootstrap of the gap series.
- **Descriptive splits:** each calendar year; the two positioning regimes, entries to 31 Dec 2019 and from 1 Jan 2020 (R5 §3.3).

### 1.5 Can an option buyer profit? D1 on real 1-minute prices (NIFTY)

- **Sessions:** every regular entry session E with a signal from 24 May 2021 to 2 Jul 2026 that is a valid 1-minute session.
- **Contract:** the nearest listed expiry (bhavcopy) with **at least 2 NSE sessions after E** up to and including it (plan rule N4), present in the dataset; one lot at the lot in force on E.
- **Strike:** the listed strike (call and put both have bars that day) nearest the index level known at 09:30, the close of the 09:29 index bar; a tie goes to the lower strike.
- **Orders:** buy the ATM call (bullish) or put (bearish) at **09:30**, filled in the leg's first bar within [09:30, 09:32]; sell at **15:20**, filled in the first bar within [15:20, 15:25], else at the last close before 15:20 (a stale exit, counted). No stop.
- **Fills (WP11 §1.2):** *conservative* (the verdict case): buy at the 1-minute bar's high, sell at its low; *mid*: the bar's close. No further spread.
- **Charges:** `computeCharges` per order at the rates in force on the day (`RESEARCH_CHARGE_SCHEDULES`, NSE: STT on option sales 0.05% → 0.0625% (Apr 2023) → 0.1% (Oct 2024) → 0.15% (Apr 2026), dated exchange charges, ₹20 brokerage per order, SEBI fee, stamp duty on buys, IPFT, GST), through `structurePnl`; a multi-session hold pays its exit charges at the exit day's rates.
- **Both sides priced:** the call and the put at the same strike and minute must both fill for E to count, because the placebo needs both; an E without both is skipped (counted).
- **Placebo:** a random side at the strategy's own share of calls; its exact expectation on each traded session is p·call + (1 − p)·put; the gap is paired by session with a cluster-robust SE (`pairedGap`).
- **Per-session statistics** count every entry session with a signal and both sides priced; middle-tercile sessions are ₹0.
- **Variants:** 4 signals × 2 signs × 2 fills = 16.

### 1.5a W1 and M1 option holds: descriptive only

- **W1 (1-minute bars):** buy at E 09:30 and sell at E+4 15:20 (entry and exit fills as D1; `runOvernight` of WP13 for the exit: a leg without a bar in [15:20, 15:25] exits at its last close that day, and a leg without any bar that day has no exit price, so the trade is skipped). Contract: the nearest expiry with **at least 6 sessions** at E (so ≥ 2 remain on the exit session), present in the extract on both days. **One position at a time:** the next entry is the first signal after the exit session. Both sides priced, as D1. 4 signals × 2 signs × 2 fills = 16 variants.
- **M1 (end-of-day bhavcopy, Feb 2019 –):** buy at E's NSE closing price and sell at E+19's. Contract: the nearest expiry with **at least 21 sessions** at E. Strike: nearest the official index close of E among strikes whose call and put both traded on E; both must trade on E+19 (else skipped). Fills: the closing price (*close*), and the closing price with half the engine spread on each order (*close+spread*, max(1 tick, 0.4% of premium)). One position at a time. 16 variants.
- **Why descriptive:** one position at a time leaves at most about 217 W1 holds in the whole 1-minute sample and about 95 M1 holds in the bhavcopy era (§2.4), so neither can reach 180 out-of-sample trades. Their walk-forward picks are reported, with no verdict.

### 1.6 The walk-forward split and the pick

- **Index:** per signal, the cut is the last entry session of the first ⌈0.6 n⌉ D1 signal days of the base variant (terciles, trailing 250; `cutDate`). The same cut serves every horizon, sign and perturbation of that signal. **In sample** = entries whose whole hold ends on or before the cut (holds that straddle it are purged); **out of sample** = entries after the cut.
- **Options:** per family (D1, W1, M1) and signal, the cut is the last of the first ⌈0.6 n⌉ trade sessions of the family's base variant (both signs and both fills trade the same sessions); in sample = entries on or before the cut, out of sample = after it.
- **The pick:** the sign with the higher in-sample mean per trade (`pickBest`, ties by name): per signal and horizon for the index, per signal and fill for the options. It is then evaluated **untouched on the last 40%**; the other sign's last 40% is reported but decides nothing.

### 1.7 The bar (plan §12)

**Index picks** ("does it predict?"; 12 picks):
1. **≥ 180 independent out-of-sample trades:** out-of-sample signal days ÷ sessions held (D1 ÷ 1, W1 ÷ 5, M1 ÷ 20), so overlapping holds are not counted as independent.
2. **Placebo gap ≥ 2 SE** out of sample.
3. **Block-bootstrap 95% CI > 0** out of sample, per trade and per session.
4. **PF ≥ 1.3** out of sample.
5. **±20% robustness**, run only for picks that pass 2–4: quartiles, quintiles, trailing 200, trailing 300 (4 variants); at least 80% of them with out-of-sample summed signed return > 0, and the worst ≥ base − 50% × |base| (`robustness`).
6. **Multiple testing:** the larger of the per-trade and per-session bootstrap p-values < 0.05 / N, N = the lines in `reports/trials.jsonl` after this study's lines are appended (2,708 before); and the deflated Sharpe ratio of the out-of-sample per-session signed returns ≥ 0.95, N from the ledger and V[SR] from this study's index lines (the 1/(T − 1) version reported too).

**D1 option picks** ("can a buyer profit?"; 8 picks, the verdict at the conservative fill):
1. **≥ 180 out-of-sample trades.**
2. **Placebo gap ≥ 2 SE** out of sample (`pairedGap`).
3. **Day-block bootstrap 95% CI > 0** out of sample, per trade and per session (`dayBlockBootstrap`, seed 7, 20,000 resamples, 100,000 when both lower bounds are above zero).
4. **PF ≥ 1.3** out of sample.
5. **±20% robustness**, run only for picks that pass 2–4: quartiles, quintiles, trailing 200, trailing 300, entry 09:45, exit 15:05 (6 variants); the same rule as above on the out-of-sample net.
6. **Multiple testing** as above (V[SR] from this study's D1 option lines).
7. **Complete-bar era** (entries to 31 Dec 2024, in and out of sample): mean > 0 with a day-block CI above zero per trade (10,000 resamples).

- **Verdicts** (`overallVerdict`): *PASS* when every criterion passes; *INSUFFICIENT* when the sample size is the only failure; *FAIL* otherwise (a criterion not run because an earlier one failed counts as a failure). The mid-fill picks are judged by the same criteria and reported beside; a family that fails at the conservative fill and passes at mid is *mid only*: not actionable without quotes.
- **A paper-test spec is written only for a pick that passes.**

### 1.8 Published rules (R5 §2 and §5; untuned; descriptive)

- **P1, HDFC Securities** (Business Standard, 7 Aug 2025): FII L/S (long ÷ short, index futures) **< 0.15** in the file of a monthly NIFTY expiry day (the start of the next series) → NIFTY higher at the next monthly expiry. Monthly expiries: the NIFTY futures expiry dates in the bhavcopy cache (Feb 2019 –). Measured from the open of the next regular session to the next expiry's close (tradeable) and from that expiry day's close (as published); the series after its publication (7 Aug 2025) are reported separately. The four claimed episodes (29 Sep 2022, 29 Mar 2023, 26 Oct 2023, 30 May 2024) are checked against the files.
- **P2, Marketcalls flip** (R5 H5): FII net index futures turn from short (< 0) to long (> 0) and stay long for **3** consecutive sessions → NIFTY from the open of the next regular session to the close **30** sessions later.
- **P3, the bottom decile** (R5 H3): the mean of the last **5** readings of L in the **bottom decile** (rank < 0.10) of its trailing 250 → long NIFTY (contrarian), from E's open to the close **20** and **30** sessions later (two lines), on every signal session (overlapping; block bootstrap with blocks of twice the hold), against all entry sessions.
- Each is reported with n, independent episodes, mean (95% CI) and the share up (Wilson 95%). None can reach 180 independent out-of-sample trades (§2.5), so all three are descriptive.

### 1.9 Replications (descriptive, not picks)

- **(a) Marketcalls' state split:** NIFTY's next-session return after FII net-short (long < short) and net-long readings, annualised (mean × 252 and compounded), from the close before E to E's close (Marketcalls' framing; it includes the overnight gap that a trader acting on the evening file cannot capture) and from E's open to its close (tradeable), one observation per regular entry session as §1.2; for Sep 2016 – Sep 2026 (Marketcalls' window), all files, 2012–2019 and 2020–2026.
- **(b) Net-short streaks of ≥ 20 consecutive sessions:** NIFTY during each streak (the close before it to its last close: "8 of 15 ended higher"), and after its flip to net long (E's open to 20 and 30 sessions later).
- **(c) Flips to net long** after ≥ 1 and after ≥ 20 net-short sessions: NIFTY over the next 30 sessions, from E's open and from the flip day's close ("> 90% up").
- **The owner's example:** FII cash net selling worse than **−₹10,000 crore** on T (NSDL) → E's open to close: count, mean (95% CI), and the share of next days down (a put buyer's direction) with its Wilson interval. NSE's own provisional figures exist locally only for 26 Aug – 8 Oct 2026 (30 sessions, `scratchpad/fiidata`); their days below −₹10,000 crore are listed beside the NSDL result, one by one.

### 1.10 Tails (reported)

- D1 options, every variant: worst and best trade, the 10 worst, the 10 best as a share of the net, the net without the best 5 and 10, the maximum drawdown of cumulative ₹ (and as % of a ₹5 lakh account), the longest losing run, premium and charges per trade.
- Index picks: the 5 worst and 5 best signed holds.

### 1.11 Ledger

- One line per evaluated variant in `reports/trials.jsonl` with `wp: "WP14"`: the 24 index variants, the 48 option variants (D1, W1, M1), any perturbations run, and every published-rule and replication line. Lines for index and descriptive variants carry `net` and `meanPerTrade` in **index basis points, not rupees** (`params.unit` says so). Variants already logged are not appended again.

### 1.12 Tested before this freeze

- A `--smoke` run of the code paths, on the files downloaded by then (2020 onward) and again on the complete download, replaced every signal with a fixed cycle (+1, −1, 0 by file) and every index bar with a flat one, and printed only counts, skips and finiteness checks. The option trades it priced followed that cycle, not any signal, and no return or P&L figure was printed; the index, published-rule and replication paths saw only flat bars.
- The `coverage` command reads files, bars and signal readings only: bar presence, file checks and data-quality comparisons, no return.

---

## 2. Data and samples (before any P&L)

Everything in this section comes from file contents, file lists, bar presence and signal readings (`wp14-positioning.ts coverage`). No return or P&L entered it; the only price comparisons are the data-quality checks of §2.2.

### 2.1 The participant-wise OI files

**Download** (10 Oct 2026, 10:20–12:10 UTC):
- 3,877 dates requested: every weekday from 26 Dec 2011 to 9 Oct 2026, plus 17 weekend sessions known from Yahoo and the bhavcopy cache. One GET at a time, about 1.6 s apart.
- **3,658 files** (HTTP 200) and 219 not found (404). No 403, no 429, no other status: nothing was blocked.
- Two files (17 Jul 2014, 13 Jun 2018) start at the header row instead of the title. The downloader's first check (the title text) declined them; after widening it to "title or header row", each was fetched once more.
- **First file: 2 Jan 2012.** 26–30 Dec 2011 return 404, as do the earlier probes (§1.1). Last file: 9 Oct 2026.
- **Missing trading days:** 9 Oct 2013 and 10 Feb 2016 have a Yahoo bar but no file. Every other 404 is a holiday or a weekend.

**Exclusions (3 files; 3,655 usable):**

| file | what is wrong | consequence |
|---|---|---|
| 2 Jan 2012 | Header `CLIENT_TYPE`, rows Client, **FII, DII**, Pro, Total. The "FII" row has no index-option shorts and the "DII" row has 226,048-plus call shorts: the FII/DII check of §1.1 (R5 §3.2) | Excluded |
| 22 Aug 2013 | The column names follow the title on line 1, and every row label sits one row too high (the "Pro" row holds the totals, "TOTAL" is empty) | Excluded |
| 24 Feb 2014 | No header row (title, then data) | Excluded rather than read by an assumed column order |

**Layouts:** `CLIENT_TYPE` with rows Client, DII, FII, Pro, TOTAL on 3–5 Jan 2012; `Client Type` with the same rows on 3,651 files from 6 Jan 2012 to 9 Oct 2026; plus the three broken files above.

**Warnings (files kept):**
- **Rounding:** from late 2015 the categories miss TOTAL, or TOTAL longs miss TOTAL shorts, by a few contracts in many files, mostly in the index-option columns (for example 785 files in Option Index Call Long). All are within 10 contracts or 0.01%.
- **Miscomputed Total columns:** in 5 files (6 Jan 2016, 20 Apr 2016, 24 Jan 2017, 29 May 2017, 22 Sep 2017) "Total Long Contracts" ≠ "Total Short Contracts" by up to 1.4 million, while every instrument column ties out. They feed no signal.
- **Fractional counts:** 21 files from 2012 to 2018 hold stock-futures counts with decimals (e.g. 679,462.5846 on 28 Mar 2012). The sums still tie out.
- **Odd notation:** `NA` for no position (3 Jan 2012); Indian-grouped counts like `"2,38,483.00"` (20 Jan 2012); bare carriage-return line ends (4 Oct 2017); no title row (17 Jul 2014, 13 Jun 2018); a title without its year (8 Jun 2021).

**Special sessions** (never an entry; their files are readings): 25, all with a file:
- Saturdays and Sundays: 7 Jan, 3 Mar and 8 Sep 2012; 22 Mar 2014; 28 Feb 2015; 1 Feb 2020; 20 Jan, 2 Mar and 18 May 2024; 1 Feb 2025; 1 Feb 2026.
- Muhurat: the 14 dates of §1.1.
- Checked against the data, every Muhurat date has a file. Where Yahoo has a bar, it is a short session's: high/low 0.26–0.42% against 0.74–1.36% around it. The exception is 19 Oct 2017 (0.88%): NIFTY fell 0.6% within that one-hour session.
- The bhavcopy's volume rule (from Feb 2019) flags every Muhurat session except 24 Oct 2022. That is why the list is needed.

**Publication time** (the archive's Last-Modified header, IST):
- **The 1,742 files dated 2 Jan 2012 – 16 Jan 2019 were all last written on 17 Jan 2019, in one batch.** Their original publication time cannot be measured, and NSE may have regenerated their content.
- Of the 1,916 later files, **1,750 were last written on their own date, at a median 18:55 IST** (10th–90th percentile 18:10–20:15; earliest 17:22, latest 23:57; the first such file is 2 Aug 2019).
- 78 were last written one day later, 17 within a week and 71 later still (e.g. Jan–Mar 2019 files rewritten on 6 Mar 2019; 15 Jan 2024 rewritten on 15 Jan 2025).
- So, where it can be measured, the file is out on the evening of T, after the close and before the next open. The design uses it only from the next session (§1.2).

### 2.2 The NIFTY daily index

- **Yahoo ^NSEI daily**, Dec 2011 – 8 Oct 2026: 3,670 rows.
- **15 regular sessions with a participant file have no complete Yahoo bar**, and an index trade entering or exiting on one is skipped:
  - 12 have a Yahoo row with a missing field: 2 Jan, 21 May and 28 Aug 2012; 1 Jan 2013; 1 Jan and 17 Feb 2014; 1 Jan and 15 Apr 2015; 1 Jan and 12 Aug 2016; 1 Jan 2018; 1 Jan 2019;
  - 3 have no Yahoo row at all: 26 Oct 2012, 13 Feb 2019 and 29 Mar 2019.
  - Yahoo's other 12 rows with a missing field are special sessions, holidays without an NSE file (24 Apr and 15 Oct 2014, 15 Jan 2026), a day before the archive (26 Dec 2011), or no session at all (11 Nov 2012).
- **Stale opens** (open = previous close): 27 Apr 2012 and 2 Nov 2017.
- **Against the bhavcopy cache's own Yahoo download** (Oct 2016 – Oct 2026): 2,465 common days, none differing by more than 0.5 point in the open or close.
- **Against the 1-minute index bars** (TradeMarkk, 24 May 2021 – 2 Jul 2026, 1,252 days): Yahoo's open differs from the 09:15 bar's open by a median 3.5 bp (99th percentile 20.5 bp, maximum 71 bp). The official close differs from the last 1-minute print by a median 4.5 bp, because the official close is set from the constituents' closing prices.

### 2.3 Signals, regimes and the walk-forward cuts (frozen here)

| signal | readings | ranked (trailing 250) | first ranked | bottom / middle / top tercile | D1 signal days with an index bar | **cut after** | first 60% / last 40% (D1) | last 40% W1 / M1 signal days (÷ 5 / ÷ 20 = independent) |
|---|---|---|---|---|---|---|---|---|
| S1 L | 3,655 | 3,406 | 1 Jan 2013 | 1,391 / 1,030 / 985 | 2,350 | **17 Jun 2021** | 1,410 / 940 | 936 (187) / 931 (47) |
| S2 ΔL | 3,650 | 3,401 | 2 Jan 2013 | 1,111 / 1,160 / 1,130 | 2,217 | **20 Nov 2020** | 1,331 / 886 | 883 (177) / 879 (44) |
| S3 L − L(Client) | 3,655 | 3,406 | 1 Jan 2013 | 1,451 / 993 / 962 | 2,389 | **31 May 2021** | 1,434 / 955 | 951 (190) / 936 (47) |
| S4 options net direction | 3,655 | 3,406 | 1 Jan 2013 | 1,131 / 1,100 / 1,175 | 2,281 | **2 Aug 2021** | 1,369 / 912 | 908 (182) / 898 (45) |

The terciles are not a third each because the rank is taken within a moving window: S1 and S3 spent long spells near the bottom of their trailing year (the regimes below).

**Positioning by period** (levels; the regime inversion of R5 §3.3):

| period | files | FII long share L: median (10th–90th pct) | Client long share: median | L − L(Client): median | S4: median | FII net short (share of days) |
|---|---|---|---|---|---|---|
| 2012–2016 | 1,233 | 67.8% (47.2–85.1%) | 36.9% | +0.312 | −0.243 | 13.0% |
| 2017–2019 | 739 | 53.0% (35.1–74.7%) | 48.8% | +0.032 | −0.123 | 39.6% |
| 2020–2022 | 748 | 56.6% (23.5–71.4%) | 52.7% | +0.043 | −0.064 | 33.4% |
| 2023–2024 | 495 | 43.5% (18.8–68.8%) | 55.7% | −0.128 | −0.032 | 65.3% |
| 2025–2026 | 440 | 13.8% (8.6–29.0%) | 70.7% | −0.563 | −0.147 | 99.3% |

**FII net short in index futures:** 1,463 of 3,655 usable days. There are 17 runs of ≥ 20 consecutive sessions; the 15 inside Sep 2016 – Sep 2026 match Marketcalls' count of 15. The longest are 7 Oct 2024 – 6 May 2025 (143 sessions) and **13 May 2025 – 9 Oct 2026 (352 sessions, still running)**. There are 79 flips from net short to net long, 55 of them confirmed for 3 sessions.

**Latest readings** (the last file, 9 Oct 2026, feeds the session of 12 Oct, beyond the index data):

| file | FII index futures long / short | L | L (Client) | S1 rank | S2 rank | S3 rank | S4 rank |
|---|---|---|---|---|---|---|---|
| 8 Oct 2026 | 31,583 / 3,38,692 | 8.5% | 83.6% | 10% (bottom) | 23% (bottom) | 1% (bottom) | 14% (bottom) |
| 9 Oct 2026 | 34,943 / 3,28,931 | 9.6% | 82.4% | 21% (bottom) | 83% (top) | 5% (bottom) | 34% (middle) |

### 2.4 The option samples (NIFTY; bar presence only)

| signal | entry sessions in the 1-minute data with a signal | with the contract (≥ 2 sessions) in the dataset, a lot, and ATM call and put bars at 09:30–09:32 | both legs with a 15:20–15:25 bar | D1 trade days | **cut after** | first 60% / last 40% | last 40%: to Dec 2024 / from 2025 |
|---|---|---|---|---|---|---|---|
| S1 | 1,248 | 1,215 | 1,215 | 884 | **6 Jun 2024** | 531 / 353 | 112 / 241 |
| S2 | 1,248 | 1,215 | 1,215 | 758 | **26 Apr 2024** | 455 / 303 | 110 / 193 |
| S3 | 1,248 | 1,215 | 1,215 | 854 | **29 Apr 2024** | 513 / 341 | 130 / 211 |
| S4 | 1,248 | 1,215 | 1,215 | 845 | **19 Jul 2024** | 507 / 338 | 76 / 262 |

- The D1 contract has 2–7 sessions to expiry (S1's sessions: 2: 254, 3: 257, 4: 254, 5: 255, 6: 193, 7: 2).
- The 33 sessions lost between the second and third columns are contracts missing from the dataset, or an ATM leg without a bar at 09:30–09:32.
- **W1:** one position at a time leaves at most 217 holds in the whole 1-minute sample, even if every session were a signal; at most about 87 fall in a last 40%.
- **M1:** the bhavcopy era (11 Feb 2019 – 8 Oct 2026) holds at most about 95 non-overlapping 20-session holds.

### 2.5 Published rules and the owner's example (event counts only)

- **P1 (HDFC):** 97 monthly NIFTY expiries in the bhavcopy cache (28 Feb 2019 – 29 Dec 2026). 13 have a file with FII L/S < 0.15: 29 Mar 2023, 26 Oct 2023, 30 May 2024, 30 Jan 2025, 31 Jul 2025, 28 Aug 2025, 30 Sep 2025, 30 Dec 2025, 27 Jan 2026, 30 Jun 2026, 28 Jul 2026, 25 Aug 2026 and 29 Sep 2026 (the last has no series end in the data yet).
  - Of HDFC's four claimed episodes, three qualify. **29 Sep 2022 does not:** its L/S is 0.151, a hair above the published 0.15. The rule is applied as published.
  - The episodes after the rule's publication (7 Aug 2025) are the out-of-sample ones.
- **P2:** 55 confirmed flips to net long (§2.3).
- **The owner's example (NSDL):** 1,879 report dates, 1 Jan 2019 – 8 Oct 2026. Twelve show net selling worse than −₹10,000 crore (report dates 18 Jan, 5 Jun, 6 Aug and 4 Oct 2024; 3 Mar and 21 May 2025; 16, 20 and 24 Mar, 2 Apr, 1 Jun and 30 Sep 2026). NSE's provisional window (26 Aug – 8 Oct 2026) has two such days, 30 Sep and 8 Oct 2026.

### 2.6 What this fixes before any P&L

1. **The index D1 tests can reach the sample bar:** 886–955 out-of-sample signal days per signal.
2. **The index W1 tests are at the edge.** 187 (S1), 190 (S3) and 182 (S4) independent out-of-sample trades just clear 180, but **S2 W1 (177) cannot**: at best *INSUFFICIENT*.
3. **The index M1 tests cannot reach it** (44–47 independent out-of-sample trades): at best *INSUFFICIENT*.
4. **The D1 option buyer can:** 303–353 out-of-sample trades per signal.
   - 62–78% of them fall in 2025–26, where the bars are sampled and the conservative fill is not the minute's true worst trade (§1.1).
   - The complete-bar check (criterion 7) therefore leans on the first 60%.
5. **W1 and M1 option holds are descriptive only**, as are the three published rules (13 HDFC series, 55 flips, a handful of bottom-decile spells) and the replications.
6. **The index history's first 60% (2013 – mid 2021) is mostly the FII-net-long regime; its last 40% is mostly the net-short regime** (§2.3). A sign chosen in one regime is judged in the other. That is the point of the walk-forward, and also the main reason it can fail.
