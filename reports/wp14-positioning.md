# WP14: does FII positioning (vs retail) predict NIFTY, and can an option buyer profit from it?

Sat 10 Oct 2026. Branch `worktree-agent-a94277d8be4ff1dee`, reset to `19ad6d4` (head of `claude/gifted-wright-3d8r3j`). Analysis only: no paper trading, no deploys, no pushes; nothing in the engine changes.

**Data and licence.**
- **Positioning:** NSE's published daily report "Participant wise Open Interest (no. of contracts) in Equity Derivatives", one file per trading day at `https://archives.nseindia.com/content/nsccl/fao_participant_oi_DDMMYYYY.csv`, downloaded from the archive only (no nseindia.com, bseindia.com or broker website API was called).
- **Option prices:** the Hugging Face dataset **"India Index & Options – 1-minute OHLC" by TradeMarkk** (`thetrademarkk/india-index-options-1m`, revision `0f4800e43e6f96cec0794369d78eb4d3c4211ef5`, https://huggingface.co/datasets/thetrademarkk/india-index-options-1m), licensed **CC-BY-NC-4.0**: non-commercial research use only, attributed here; WP11 §2 verified it against the exchange's own files. NSE F&O bhavcopies (WP6's compact cache) for lots, expiries, short sessions and end-of-day option prices.
- **Index and flows:** Yahoo's ^NSEI daily bars (Q2's download); NSDL's custodian-confirmed FPI daily series (Q2's parsed archive) for the owner's example.
- No raw or extracted data is committed (the repository is public); the scripts rebuild everything from a download.

**Status of this file:** §1 and §2 were written and committed (`fdb2b87`) before any signal-conditional return or P&L was computed, and they are unchanged. §0 and §3–§12 were added after the runs; §11 lists every change made after the freeze. No definition changed.

---

## 0. Bottom line

**Verdict: nothing passes, so there is no paper-test spec.** In plain words: what FIIs hold in index futures and options, as NSE publishes it each evening, did not reliably predict NIFTY out of sample, and an option buyer who traded on it lost money.

- **Does FII positioning predict NIFTY?** Not well enough to pass. All 12 walk-forward index picks fail (4 signals × 1 day, 1 week and 1 month). On the first 60% of the signal days, every pick chose to *follow* the FIIs: long when their reading is in the top third of its trailing year, short when it is in the bottom third.
  - **The nearest miss is S4 over a week**: the FIIs' net direction in index options (long calls and short puts count as bullish), followed for five sessions.
    - Out of sample it made +21.3 bp a trade (CI +2.0 … +40.4 bp) and was right on 56.1% of trades against a 49.7% base. Its placebo gap is 2.45 SE, its PF 1.35, and all four ±20% perturbations stay positive.
    - **It fails only the multiple-testing step.** p = 0.016 against 0.05 / 2,814 = 1.8 × 10⁻⁵, and the deflated Sharpe ratio is 0.26 (0.52 with the null variance), against a bar of 0.95.
    - Its history is also lopsided. It lost 12.6 bp a trade over 2013–2019 and made all of its money from 2020.
  - **The other signals show nothing that holds up.**
    - S1, the FIIs' long share of index futures: +2.6 bp a day out of sample (CI −1.8 … +7.0).
    - S2, the daily change in that share: +8.5 bp a day in the first 60% (3.35 SE), then −0.5 bp in the last 40%.
    - S3, the FIIs against the Clients: +3.5 bp a day (CI −0.9 … +7.9).
    - S4 over one day: +5.1 bp (CI +0.8 … +9.4), but its PF is 1.23 (the bar is 1.3).
- **Can an option buyer profit from it?** No. All 8 one-day option picks lose out of sample. Each bought the ATM call or put at 09:30 and sold it at 15:20.
  - The loss is −₹532 to −₹880 a lot a trade at the conservative fill and −₹187 to −₹580 at mid, over 303–353 trades each.
  - **No signal beat a random side by 2 SE**: the placebo gaps run from −1.95 to +0.57 SE. A random side on the same days lost ₹549–652 a lot at the conservative fill (₹213–301 at mid), to time decay, the spread and charges. A tilt of a few basis points cannot pay that.
- **"FIIs sold, so puts paid"?** Not in these data.
  - The 12 days since 2019 with FII cash selling worse than −₹10,000 crore were followed, on average, by a NIFTY *rise* from the next open to close: +0.21% (CI −0.30 … +0.78%). NIFTY fell on 5 of the 12 days.
  - Following the FIIs' positioning meant mostly buying puts in 2024–26: 71% of S1's out-of-sample trades were puts, because the FIIs' long share sat in the bottom of its range. Those trades lost ₹724 a lot a trade at the conservative fill, and ₹1,039 a trade from January 2025.

| question | answer from the data |
|---|---|
| **S1, S2.** Do the FIIs' index-futures positions predict NIFTY? | **No.**<br>• S1 (the long share), last 40% per trade: +2.6 bp at 1 day (CI −1.8 … +7.0), −7.9 bp at 1 week, −56.3 bp at 1 month.<br>• S2 (its daily change) at 1 day: +8.5 bp in the first 60% (3.35 SE), −0.5 bp in the last 40% (CI −5.2 … +4.3). The effect faded after 2020; by year it has been negative since 2024. |
| **S3.** The FIIs against retail ("Client")? | **No better than S1.**<br>• +3.5 bp at 1 day (CI −0.9 … +7.9; placebo 1.17 SE), −4.1 bp at 1 week, −34.6 bp at 1 month.<br>• "Client" is not the retail option buyer. Most retail buying is closed intraday and never reaches end-of-day OI (§8.2). |
| **S4.** The FIIs' index-options book? | **The only hint, at one week. It does not survive multiple testing.**<br>• 1 week: +21.3 bp a trade (CI +2.0 … +40.4), hit 56.1% vs 49.7%, placebo 2.45 SE, PF 1.35, robust 4 of 4; p 0.016 vs 1.8 × 10⁻⁵; DSR 0.26.<br>• 2013–2019: −12.6 bp; 2020–2026: +37.1 bp.<br>• 1 day: +5.1 bp (CI +0.8 … +9.4), PF 1.23. 1 month: 45 independent trades, too few. |
| **Can an option buyer profit?** (one day, ATM, 09:30 → 15:20, one lot) | **No.**<br>• −₹532 to −₹880 a trade at the conservative fill, −₹187 to −₹580 at mid, out of sample.<br>• Placebo gaps from −1.95 to +0.57 SE: the signals pick sides no better than a coin.<br>• To Dec 2024, at the conservative fill, every pick also loses over all days (−₹188 to −₹277). |
| **A week or a month instead?** (descriptive: 67–72 and 32–34 out-of-sample holds) | **No better.**<br>• 1 week: −₹3,118 to +₹497 a trade at the conservative fill, every CI spanning or below zero.<br>• 1 month: all four picks were positive in the first 60% (₹4,344–₹9,017) and negative after (−₹1,242 to −₹7,419). |
| **The published rules?** (R5; untuned, descriptive) | **Not as claimed.**<br>• HDFC, FII long/short < 0.15 at a monthly expiry: 3 of the 4 claimed episodes qualify (29 Sep 2022 reads 0.151), and all 3 rose. Since the rule was published (Aug 2025), 7 series: 5 rose, mean −0.14%.<br>• Marketcalls, 17% vs 6% a year after net-long vs net-short readings: reproduced close to close (+17.3% vs +4.6%, Sep 2016 – Sep 2026). But it sits in the overnight gap: from the next open to the close, both are negative (−17.7% and −14.2% a year). In 2012–2019 the split ran the other way (+11.4% vs +20.0%).<br>• Flips to FII net long: NIFTY was higher 30 sessions later 72.7% of the time (77 flips), against 63.6% for any 30 sessions, not "> 90%".<br>• The contrarian bottom decile of FII long %: +0.34% over 20 sessions, against +0.79% for any entry day. |
| **The owner's example** (FII cash < −₹10,000 crore → buy puts next day) | **No.** 12 days (NSDL, 2019–2026): next open → close +0.21% on average; NIFTY fell on 5 of them (Wilson 19–68%). |

**Verdict tables.** Each pick is the sign with the better mean on the first 60% of signal days (purged for the index), evaluated untouched on the last 40%. Index figures are NIFTY basis points per trade from the official open of E to the close of the hold's last session. Option figures are ₹ per lot per trade, net of dated charges, with day-block 95% CIs. The option verdict is decided at the conservative fill.

*Index direction* ("does it predict?"):

| signal | hold | pick | first 60% per trade (n) | last 40%: independent trades | last 40% per trade (95% CI) | hit vs base | placebo gap (SE) | PF | verdict: fails on |
|---|---|---|---|---|---|---|---|---|---|
| S1 FII long share | 1 day | follow | +1.2 bp (1,410) | 940 | +2.6 bp (−1.8 … +7.0) | 51.1% vs 50.9% | +1.2 bp (0.65) | 1.11 | **FAIL**: placebo, CI, PF, multiple testing |
| | 1 week | follow | +7.9 bp (1,400) | 187 | −7.9 bp (−29.9 … +14.0) | 48.4% vs 48.8% | −2.8 bp (−0.30) | 0.90 | **FAIL**: placebo, CI, PF, multiple testing |
| | 1 month | follow | +40.8 bp (1,390) | 47 | −56.3 bp (−130.5 … +12.7) | 46.0% vs 47.7% | −37.9 bp (−1.15) | 0.69 | **FAIL**: sample, placebo, CI, PF, multiple testing |
| S2 daily change in L | 1 day | follow | +8.5 bp (1,331) | 886 | −0.5 bp (−5.2 … +4.3) | 49.7% vs 50.0% | −0.5 bp (−0.19) | 0.98 | **FAIL**: placebo, CI, PF, multiple testing |
| | 1 week | follow | +3.2 bp (1,322) | 177 | +6.6 bp (−6.9 … +20.5) | 52.7% vs 50.0% | +6.6 bp (0.94) | 1.09 | **FAIL**: sample, placebo, CI, PF, multiple testing |
| | 1 month | follow | +1.7 bp (1,310) | 44 | +23.3 bp (−6.6 … +55.2) | 53.8% vs 50.0% | +23.1 bp (1.48) | 1.17 | **FAIL**: sample, placebo, CI, PF, multiple testing |
| S3 FII minus Client long share | 1 day | follow | +2.3 bp (1,434) | 955 | +3.5 bp (−0.9 … +7.9) | 51.9% vs 50.7% | +2.1 bp (1.17) | 1.15 | **FAIL**: placebo, CI, PF, multiple testing |
| | 1 week | follow | +9.2 bp (1,424) | 190 | −4.1 bp (−25.7 … +17.3) | 50.2% vs 48.9% | +1.5 bp (0.17) | 0.94 | **FAIL**: placebo, CI, PF, multiple testing |
| | 1 month | follow | +49.5 bp (1,412) | 47 | −34.6 bp (−106.8 … +32.2) | 48.2% vs 47.0% | −12.3 bp (−0.43) | 0.79 | **FAIL**: sample, placebo, CI, PF, multiple testing |
| S4 FII index-options net direction | 1 day | follow | +1.8 bp (1,369) | 912 | +5.1 bp (+0.8 … +9.4) | 51.0% vs 50.5% | +4.2 bp (2.05) | 1.23 | **FAIL**: PF, multiple testing |
| | **1 week** | follow | +8.1 bp (1,357) | 182 | **+21.3 bp (+2.0 … +40.4)** | 56.1% vs 49.7% | +22.0 bp (2.45) | 1.35 | **FAIL: multiple testing only** (p 0.016; DSR 0.26) |
| | 1 month | follow | +22.4 bp (1,347) | 45 | +33.6 bp (−30.2 … +100.4) | 53.5% vs 48.1% | +44.4 bp (1.33) | 1.26 | **FAIL**: sample, placebo, CI, PF, multiple testing |

*One-day option buyer* ("can a buyer profit?"; NIFTY ATM, 09:30 → 15:20, real 1-minute prices):

| signal | fill | pick | first 60% ₹/trade (n) | last 40% trades | last 40% ₹/trade (95% CI) | PF | placebo gap (SE) | last 40%: to Dec 2024 / from 2025 | worst day (all days) | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| S1 | conservative | follow | −₹326 (531) | 353 | −₹724 (−₹1,111 … −₹324) | 0.59 | −₹174 (−1.15) | −₹45 (112) / −₹1,039 (241) | −₹12,375 (2 Jan 2025) | **FAIL** |
| | mid | follow | −₹82 (531) | 353 | −₹414 (−₹804 … −₹10) | 0.74 | −₹176 (−1.15) | ₹124 / −₹664 | −₹11,831 (2 Jan 2025) | FAIL |
| S2 | conservative | follow | −₹188 (455) | 303 | −₹691 (−₹1,146 … −₹224) | 0.63 | −₹142 (−0.63) | −₹364 (110) / −₹877 (193) | −₹12,590 (30 Mar 2026) | **FAIL** |
| | mid | follow | ₹62 (455) | 303 | −₹338 (−₹798 … ₹133) | 0.80 | −₹125 (−0.54) | −₹224 / −₹403 | −₹11,322 (30 Mar 2026) | FAIL |
| S3 | conservative | follow | −₹259 (513) | 341 | −₹880 (−₹1,299 … −₹451) | 0.53 | −₹307 (−1.95) | −₹179 (130) / −₹1,311 (211) | −₹12,375 (2 Jan 2025) | **FAIL** |
| | mid | follow | −₹13 (513) | 341 | −₹580 (−₹1,000 … −₹152) | 0.66 | −₹312 (−1.94) | −₹11 / −₹931 | −₹11,831 (2 Jan 2025) | FAIL |
| S4 | conservative | follow | −₹139 (507) | 338 | −₹532 (−₹1,032 … −₹11) | 0.73 | ₹120 (0.57) | −₹515 (76) / −₹536 (262) | −₹12,375 (2 Jan 2025) | **FAIL** |
| | mid | follow | ₹88 (507) | 338 | −₹187 (−₹690 … ₹336) | 0.89 | ₹114 (0.53) | −₹334 / −₹145 | −₹11,831 (2 Jan 2025) | FAIL |

- **Every pick fails.** The index picks fail on the placebo, the CI, the PF or the sample size, and all 12 fail multiple testing. The option picks fail on everything but the sample size, the complete-bar check included.
- **Only one pick reached the ±20% robustness step** (S4 at one week; 4 of 4 perturbations positive), so 4 perturbation lines were run.
- **The smallest out-of-sample p of any pick is 0.011** (S4 at one day), about 600 times the Bonferroni level of 1.8 × 10⁻⁵.
- **The mid-fill option picks fail too, so no family is "mid only".**

**What it means.**
- **The FII rows say who holds what, not where NIFTY goes next.** The *level* of the FIIs' long share is a regime variable: 68% median in 2012–2016, 14% in 2025–26, and net short every session since 13 May 2025 (§2.3). Its rank within its own trailing year predicted nothing out of sample.
- **The FIIs' options book (S4) is the one reading with an out-of-sample hint**, at a weekly horizon and only since 2020. With 2,814 trials in the ledger it cannot be told apart from luck. It is worth logging forward as a hypothesis, not trading: the same signal bought as a one-day option lost ₹532 a trade, and held as a one-week option it was flat (descriptive, 72 holds).
- **A one-day ATM option costs its buyer ₹550–650 a lot at the conservative fill (₹210–300 at mid) whichever side is chosen**, against premiums of about ₹7,400–8,300: roughly 7% (3%) of the premium in a day. A positioning tilt worth a few basis points cannot pay that.
- **The practitioner rules rest on few episodes and on the regime.**
  - The 17% vs 6% split is in the overnight gap and in the era.
  - Flips to net long were followed by more than an ordinary 30 sessions' gain (+1.9% to +2.7% against +1.3%). But there are 54–77 of them in 14 years, their windows overlap, and they fall well short of "> 90%".
  - The bottom-decile rule did worse than buying on any day.
- Nothing here supports a paper test. The plan's §13 stands: no real money.

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

---

## 3. Does FII positioning predict NIFTY? The index tests

### 3.1 Every index variant, by sample

Each row is the *follow* variant. The *fade* variant trades the same days on the other side, so its signed returns are exactly the negatives of these (both are in the ledger). Figures are mean signed returns per trade, NIFTY from E's official open to the hold's last close, with block-bootstrap 95% CIs (blocks of 1, 10 and 40 sessions).

| signal | hold | all signal days: n, per trade (95% CI) | placebo gap, all days, in SE | first 60% (purged) | last 40% | 2013–2019 | 2020–2026 |
|---|---|---|---|---|---|---|---|
| S1 | 1 day | 2,350, +1.7 bp (−1.7 … +5.2) | 0.30 | +1.2 bp | +2.6 bp | +0.2 bp | +3.2 bp |
| | 1 week | 2,340, +1.5 bp (−15.4 … +19.1) | 0.36 | +7.9 bp | −7.9 bp | −8.6 bp | +11.2 bp |
| | 1 month | 2,336, +2.2 bp (−57.6 … +70.1) | 0.43 | +40.8 bp | −56.3 bp | −40.3 bp | +43.4 bp |
| S2 | 1 day | 2,217, **+4.9 bp (+1.4 … +8.4)** | **2.73** | **+8.5 bp** | −0.5 bp | +6.5 bp | +3.2 bp |
| | 1 week | 2,207, +4.6 bp (−4.9 … +13.7) | 0.95 | +3.2 bp | +6.6 bp | +1.8 bp | +7.6 bp |
| | 1 month | 2,205, +9.2 bp (−12.0 … +30.2) | 0.79 | +1.7 bp | +23.3 bp | +10.3 bp | +8.0 bp |
| S3 | 1 day | 2,389, +2.8 bp (−0.7 … +6.3) | 0.91 | +2.3 bp | +3.5 bp | +0.8 bp | +4.7 bp |
| | 1 week | 2,377, +4.0 bp (−12.8 … +21.3) | 0.80 | +9.2 bp | −4.1 bp | −7.6 bp | +15.3 bp |
| | 1 month | 2,363, +12.9 bp (−46.8 … +80.5) | 0.92 | +49.5 bp | −34.6 bp | −32.9 bp | +58.1 bp |
| S4 | 1 day | 2,281, +3.1 bp (−0.4 … +6.5) | 1.80 | +1.8 bp | +5.1 bp | +0.3 bp | +5.7 bp |
| | 1 week | 2,269, +12.9 bp (−2.6 … +29.3) | 1.54 | +8.1 bp | **+21.3 bp** | −12.6 bp | **+37.1 bp** |
| | 1 month | 2,259, +24.1 bp (−32.9 … +88.0) | 0.72 | +22.4 bp | +33.6 bp | −61.1 bp | +105.5 bp |

- **Over all days, only S2 at one day has a CI above zero**: +4.9 bp a day, 53.4% right against a 50.0% base, placebo gap 2.73 SE. The first 60% (Jan 2013 – Nov 2020) carries it: +8.5 bp (3.35 SE), then −0.5 bp in the last 40%. By year, S2 earned +12 to +15 bp a day in 2013–2015 and +20 bp in 2020, and has been negative since 2024 (−10, −5 and −5 bp in 2024, 2025 and 2026). A daily jump in the FIIs' long share used to lead the next day's NIFTY a little. It no longer does.
- **The longer holds swing with the regime.** For S1, S3 and S4, following the FIIs lost at a week and a month in 2013–2019 and gained in 2020–2026. The year 2020 is a large part of that: at a month, S1, S3 and S4 made +508 to +533 bp a trade in 2020, the COVID crash and rebound.
- **The first 60% picked "follow" every time**, but at a week and a month the first 60% and the last 40% often disagree in sign (S1 and S3 at W1 and M1). That is what a sign chosen in one regime and judged in the other looks like (§2.6).
- **NIFTY's open-to-close drift is negative.** Over the signal days, NIFTY rose from open to close on only 46.6–47.3% of days (the "up" share in `reports/wp14/tables.md`), because most of its gain comes overnight (§6.4). That is why the hit-rate base, not 50%, is the yardstick.

### 3.2 S4 at one week: the near miss

- **What it is.** S4 = [(call long − call short) − (put long − put short)] ÷ (all four), the FIIs' index-options book. A reading in the top third of its trailing year means long NIFTY for five sessions; the bottom third, short. Out of sample, 39% of the signal days were long.
- **Against the bar** (§1.7):
  1. 908 last-40% signal days ÷ 5 = 182 independent trades ≥ 180: **pass**.
  2. Placebo gap +22.0 bp a trade, SE 9.0 bp (2.45 SE): **pass**.
  3. +21.3 bp a trade (CI +2.0 … +40.4), +15.2 bp a session (CI +1.4 … +29.3), 100,000 resamples: **pass**.
  4. PF 1.35: **pass**.
  5. ±20% robustness, last 40%: quartiles +28.1 bp (714 days), quintiles +28.9 bp (602), trailing 200 +21.4 bp (897), trailing 300 +21.8 bp (942). All 4 positive and none below half the base: **pass**.
  6. Multiple testing: p = 0.016 against 0.05 / 2,814 = 1.8 × 10⁻⁵. The deflated Sharpe ratio is 0.260 (SR 0.101 a session against SR₀ = 0.119 from 2,814 trials and this study's index V[SR] = 1.13 × 10⁻³), and 0.522 with V = 1/(T − 1). Both are below 0.95: **fail**.
- **By year** (all signal days, mean per trade): 2013 +18, 2014 −20, 2015 −37, 2016 −10, 2017 +3, 2018 −24, 2019 −22, 2020 +151, 2021 +17, 2022 +54, 2023 +15, 2024 −24, 2025 +15, 2026 +19 bp. Since 2020, 6 of 7 years are positive; before it, 2 of 7.
  - The last 40% starts in Aug 2021, so the 2020 crash is in the first 60%, not in the out-of-sample result.
  - The regime split: 2013–2019 −12.6 bp a trade (placebo gap −1.48 SE); 2020–2026 +37.1 bp (CI +12.6 … +62.6; gap 3.21 SE).
- **Its worst and best holds:** worst 25 Mar 2020 (−11.15%), 27 Mar 2020 (−9.67%), 1 Feb 2021 (−8.47%, Budget day), 20 Sep 2019 (−7.67%, the corporate-tax cut) and 28 Jan 2021 (−7.09%); best 17 Mar 2020 (+18.04%) and four more holds of March 2020 (+13.2% to +15.7%).
- **Why this is not a result.** The study ran 106 variants and the ledger holds 2,814. A best pick with p = 0.016 is what the 12 picks of this study alone would produce by chance about one time in six (1 − 0.984¹² ≈ 0.18 if they were independent), before counting the rest of the ledger. Its sign flipped between the two regimes. And the option trades on the same signal did not make money (§4, §5).

### 3.3 Verdict on the index

**FII positioning does not predict NIFTY out of sample, at the bar's standard.** No pick passes. S4 at one week passes every criterion except multiple testing; it is the one reading worth logging forward as a hypothesis. It is not evidence.

---

## 4. Can an option buyer profit? One-day ATM options on real 1-minute prices

### 4.1 The picks against the bar

The verdict table of §0 has the eight picks. Criterion by criterion (§1.7 numbering), at the conservative fill:

| signal | 1. trades ≥ 180 | 2. placebo gap (SE) | 3. last 40% per trade; per session (95% CI) | 4. PF | 5. robustness | 6. p; DSR | 7. to Dec 2024, all days |
|---|---|---|---|---|---|---|---|
| S1 | 353: pass | −₹174 (−1.15): fail | −₹724 (−₹1,111 … −₹324); −₹539 (−₹830 … −₹240): fail | 0.59: fail | not run | 1.0; 0.000: fail | −₹277 (−₹498 … −₹52), 643 trades: fail |
| S2 | 303: pass | −₹142 (−0.63): fail | −₹691 (−₹1,146 … −₹224); −₹418 (−₹694 … −₹135): fail | 0.63: fail | not run | 1.0; 0.000: fail | −₹222 (−₹472 … ₹29), 565: fail |
| S3 | 341: pass | −₹307 (−1.95): fail | −₹880 (−₹1,299 … −₹451); −₹600 (−₹891 … −₹305): fail | 0.53: fail | not run | 1.0; 0.000: fail | −₹243 (−₹464 … −₹17), 643: fail |
| S4 | 338: pass | ₹120 (0.57): fail | −₹532 (−₹1,032 … −₹11); −₹404 (−₹787 … −₹8): fail | 0.73: fail | not run | 0.98; 0.000: fail | −₹188 (−₹422 … ₹47), 583: fail |

At mid, the four picks lose −₹187 to −₹580 a trade out of sample, and their complete-bar-era means are −₹46 to +₹33 with CIs spanning zero.

### 4.2 Why buying loses whichever side the signal picks

| D1, follow, all trades | trades | premium paid a lot (conservative fill) | charges a trade | NIFTY 09:30 → 15:20 in the trade's direction (share right) | ₹/trade conservative / mid |
|---|---|---|---|---|---|
| S1 | 884 | ₹7,676 | ₹61 | +0.01% (51%) | −₹485 / −₹215 |
| S2 | 758 | ₹8,114 | ₹62 | +0.02% (50%) | −₹389 / −₹98 |
| S3 | 854 | ₹7,589 | ₹61 | +0.01% (51%) | −₹507 / −₹240 |
| S4 | 845 | ₹7,966 | ₹62 | +0.04% (52%) | −₹296 / −₹22 |

- **The signals barely pick the right side.** Between 09:30 and 15:20 NIFTY moved their way by 1–4 bp on average, and on 50–52% of days.
- **The side does not decide the result; the premium does.** On the same out-of-sample days, a random side at each pick's own share of calls lost ₹549–652 a lot a trade at the conservative fill and ₹213–301 at mid. The signals moved that by −₹307 to +₹120, never by 2 SE.
- **The contract is two to seven sessions from expiry** (rule N4), so one day's time decay is a large share of its value. Charges are about ₹62 a trade, small next to the decay and the spread (the gap between the two fills, ₹270–350 a trade).

### 4.3 By era and by year

- **The last 40% falls mostly in 2025–26** (62–78% of its trades), where the 1-minute bars are built from sampled prices and the conservative fill is not a true worst case (§1.1). The picks lost there too: −₹536 to −₹1,311 a trade at the conservative fill and −₹145 to −₹931 at mid, out of sample from Jan 2025.
- **The complete-bar era gives no support either.** To Dec 2024 over all days, the conservative picks lost −₹188 to −₹277 a trade and the mid picks −₹46 to +₹33.
- **By year (conservative, ₹ a trade):** S1 2021 −566, 2022 −123, 2023 −131, 2024 −453, 2025 −1,118, 2026 −801. S4 2021 −95, 2022 −61, 2023 +44, 2024 −617, 2025 −337, 2026 −1,062. Of the 24 pick-years at the conservative fill, two are positive: S2 in 2022 (+₹30) and S4 in 2023 (+₹44).

### 4.4 Verdict on the option buyer

**An option buyer could not profit from FII positioning.** All eight picks fail, at both fills and in both data eras. The tilt in direction, where there is one, is a few basis points; a one-day ATM option costs several times that.

---

## 5. W1 and M1 option holds (descriptive)

One position at a time left 168–180 one-week holds and 80–87 one-month holds in all (against upper bounds of 217 and about 95; §2.4), so neither reaches 180 out-of-sample trades and neither gets a verdict.

| hold | signal | fill | pick (first 60%) | first 60% ₹/trade (n) | last 40% ₹/trade [95% CI] (n) | PF last 40% | placebo gap, last 40% (SE) |
|---|---|---|---|---|---|---|---|
| 1 week | S1 | conservative | fade | −₹154 (101) | ₹497 [−₹2,573 … ₹3,914] (67) | 1.11 | ₹943 (0.95) |
| | | mid | fade | ₹54 (101) | ₹819 [−₹2,266 … ₹4,279] (67) | 1.18 | ₹949 (0.95) |
| | S2 | conservative | fade | −₹339 (104) | −₹3,118 [−₹5,644 … −₹560] (68) | 0.48 | −₹1,621 (−1.19) |
| | | mid | fade | −₹89 (104) | −₹2,859 [−₹5,374 … −₹304] (68) | 0.51 | −₹1,693 (−1.24) |
| | S3 | conservative | fade | ₹199 (101) | −₹253 [−₹3,184 … ₹2,874] (67) | 0.95 | ₹742 (0.85) |
| | | mid | fade | ₹420 (101) | ₹16 [−₹2,927 … ₹3,145] (67) | 1.00 | ₹731 (0.84) |
| | S4 | conservative | follow | ₹82 (108) | −₹206 [−₹2,431 … ₹2,181] (72) | 0.95 | ₹941 (0.80) |
| | | mid | follow | ₹311 (108) | ₹144 [−₹2,091 … ₹2,539] (72) | 1.04 | ₹970 (0.82) |
| 1 month | S1 | close | follow | ₹9,017 (48) | −₹7,419 [−₹13,521 … −₹844] (32) | 0.39 | −₹4,467 (−1.14) |
| | | close+spread | follow | ₹8,921 (48) | −₹7,486 [−₹13,585 … −₹917] (32) | 0.39 | −₹4,455 (−1.14) |
| | S2 | close | follow | ₹4,344 (53) | −₹4,041 [−₹11,966 … ₹4,848] (34) | 0.67 | −₹3,019 (−0.61) |
| | | close+spread | follow | ₹4,255 (53) | −₹4,124 [−₹12,035 … ₹4,749] (34) | 0.66 | −₹3,016 (−0.61) |
| | S3 | close | follow | ₹7,990 (50) | −₹4,269 [−₹10,692 … ₹2,371] (32) | 0.59 | −₹2,085 (−0.47) |
| | | close+spread | follow | ₹7,892 (50) | −₹4,339 [−₹10,755 … ₹2,287] (32) | 0.58 | −₹2,078 (−0.47) |
| | S4 | close | follow | ₹7,322 (53) | −₹1,242 [−₹11,461 … ₹10,936] (34) | 0.90 | −₹260 (−0.06) |
| | | close+spread | follow | ₹7,225 (53) | −₹1,325 [−₹11,522 … ₹10,831] (34) | 0.89 | −₹258 (−0.06) |

- **No CI is above zero.** One-week S2 is below zero at both fills.
- **The one-month picks reverse.** All four made ₹4,300–9,000 a trade in the first 60% (to Jul–Oct 2023) and lost ₹1,200–7,500 after. The one-month index tests behave the same way (§3.1).
- **S4 at one week, the index near miss, is flat as an option** (−₹206 conservative, +₹144 mid, 72 holds). An ATM option held for five sessions pays about a week of decay. The +21 bp index edge is too small to cover it.

---

## 6. Published rules and replications (descriptive)

Every row here is descriptive: none can reach 180 independent out-of-sample trades (§2.5). The CIs of P2 and (c) treat overlapping 30-session windows as independent, so they are too narrow; P3's use blocks of twice the hold.

### 6.1 HDFC Securities: FII long/short < 0.15 at a monthly expiry (P1)

| rule | series | mean (95% CI) | share up (Wilson 95%) |
|---|---|---|---|
| From the next open to the next monthly expiry's close | 12 | +0.99% (−1.31% … +3.19%) | 66.7% (39.1% … 86.2%) |
| As published: the expiry's close to the next expiry's close | 12 | +1.23% (−1.14% … +3.51%) | 66.7% (39.1% … 86.2%) |
| After the rule's publication (7 Aug 2025), from the next open | 7 | −0.14% (−2.88% … +2.29%) | 71.4% (35.9% … 91.8%) |

- **The claimed episodes.** 29 Mar 2023 (L/S 0.101), 26 Oct 2023 (0.122) and 30 May 2024 (0.148) qualify and rose +4.1%, +6.4% and +6.5% from the next open (+4.9%, +6.8%, +6.9% as published). **29 Sep 2022 reads 0.151**, a hair above the rule, so it does not qualify. The three average about +5.7% (+6.2% as published), not "> 7%".
- **Every later series is from 2025–26**, when FIIs were short most of the time and L/S stayed low. Of the 9 (30 Jan 2025 – 25 Aug 2026), 5 rose and 4 fell; the worst was 25 Aug 2026 → 29 Sep 2026 (−6.7%). The 13th qualifying expiry (29 Sep 2026) has no series end in the data yet.
- **Out of sample (after publication)** the rule was right 5 times of 7, with a mean of −0.14%.

### 6.2 Marketcalls: a flip to net long, confirmed for 3 sessions → 30 sessions (P2)

- **54 confirmed flips** (of 55; the 55th, confirmed on 31 Dec 2018, has no complete Yahoo bar on its entry session, 1 Jan 2019): from the open after the confirmation to the close 30 sessions later, **+1.94% (CI +0.72% … +3.17%), up 77.8%** (Wilson 65.1% … 86.8%).
- **The yardstick:** any 30-session window from an entry day rose 63.6% of the time, by +1.27% on average (3,330 windows; P3's base line).
- **The flips cluster.** Several fall within 30 sessions of each other (May–Jun 2015, Feb–Mar 2016, Jan 2020, Apr–Jul 2020), so the 54 windows are fewer independent episodes than they look. The worst were 31 Dec 2015 (−10.0%), 17 Jan 2020 (−7.9%) and 24 Jan 2018 (−6.4%).
- **The last confirmed flip was on 20 Aug 2024.** FIIs have been net short every session since 13 May 2025.

### 6.3 The bottom decile of the 5-session mean of FII long % → long NIFTY (P3, contrarian)

| hold | signal days (spells) | mean (95% CI) | share up | every entry day |
|---|---|---|---|---|
| 20 sessions | 590 (51) | +0.34% (−1.77% … +1.96%) | 60.7% | 3,340 days: +0.79%, up 60.2% |
| 30 sessions | 588 (51) | +0.77% (−1.78% … +2.77%) | 63.3% | 3,330 days: +1.27%, up 63.6% |

**Buying after the FIIs' long share reached the bottom tenth of its year did worse than buying on any day.** The "very short FIIs mean a rally is coming" reading (R5's H3, Geojit's < 20%) has no support here.

### 6.4 (a) Marketcalls' state split: after FII net-short vs net-long readings

NIFTY's next-session return, one observation per regular entry session, annualised as mean × 252 (compounded in brackets):

| window | FII on T | n | the previous close → E's close | E's open → E's close (tradeable) |
|---|---|---|---|---|
| Sep 2016 – Sep 2026 (Marketcalls) | net long | 1,192 | **+17.3%** (+17.7%) | −17.7% (−16.8%) |
| | net short | 1,286 | **+4.6%** (+3.0%) | −14.2% (−14.1%) |
| All files (2012–2026) | net long | 2,166 | +15.7% (+15.8%) | −16.2% (−15.6%) |
| | net short | 1,448 | +6.5% (+4.9%) | −11.6% (−11.9%) |
| 2012–2019 | net long | 1,495 | +11.4% (+11.1%) | −17.9% (−16.9%) |
| | net short | 450 | **+20.0%** (+20.6%) | −5.8% (−6.6%) |
| 2020–2026 | net long | 671 | +25.3% (+27.2%) | −12.5% (−12.5%) |
| | net short | 998 | +0.4% (−1.4%) | −14.2% (−14.2%) |

- **Marketcalls' 17% vs 6% reproduces** in their window, close to close: +17.3% vs +4.6% a year. The difference per session is 0.05% (net long +0.07%, CI +0.02 … +0.12%; net short +0.02%, CI −0.05 … +0.08%).
- **It cannot be traded on the evening file.** The difference sits in the overnight gap, from T's close to E's open, which no NSE order placed after the 19:00 file can capture. From E's open to its close, both states lose (−17.7% and −14.2% a year) and the difference is within noise.
- **It is the era.** In 2012–2019 the net-short days were followed by the *better* close-to-close returns (+20.0% vs +11.4%); in 2020–2026 by the worse (+0.4% vs +25.3%).
- **NIFTY's whole gain is overnight.** In every window and state, the open-to-close return is negative (−6% to −18% a year), while close to close is positive. An intraday option buyer starts against that drift.

### 6.5 (b) Net-short streaks of ≥ 20 sessions

- **17 streaks**; 15 fall in Marketcalls' window, matching their count. The current one runs from 13 May 2025 to the last file (9 Oct 2026): **352 sessions**, more than twice the previous record (143, Oct 2024 – May 2025).
- **"8 of 15 ended higher":** of the 16 completed streaks, NIFTY rose over 8 (mean −1.94%, CI −7.49% … +1.86%; the COVID streak of Jan–Mar 2020 lost 37.5%). In Marketcalls' window, 7 of the 14 completed streaks rose. That is a coin flip, as R5 graded it.
- **After the flip back to net long:** +2.03% over 20 sessions (62.5% up) and +3.29% over 30 sessions (14 of 16 up), from the open after the flip day. 16 episodes; the 30-session figure includes the +18.9% after the 24 Mar 2020 flip.

| net-short streak | sessions | NIFTY during the streak | flip day | flip → 20 sessions | flip → 30 sessions |
|---|---|---|---|---|---|
| 11 May – 25 Jun 2012 | 32 | +3.00% | 26 Jun 2012 | −0.41% | +3.64% |
| 12 Mar – 22 Apr 2013 | 27 | −1.82% | 23 Apr 2013 | +1.89% | +1.12% |
| 16 Mar – 25 Apr 2018 | 27 | +2.03% | 26 Apr 2018 | −0.44% | +1.09% |
| 22 May – 11 Jul 2018 | 37 | +4.10% | 12 Jul 2018 | +3.74% | +5.74% |
| 6 Sep – 28 Nov 2018 | 54 | −6.52% | 29 Nov 2018 | −0.30% | −0.89% |
| 2 Jan – 5 Feb 2019 | 25 | +0.66% | 6 Feb 2019 | −0.11% | +3.49% |
| 22 Jul – 27 Nov 2019 | 85 | +5.97% | 28 Nov 2019 | +0.82% | +0.91% |
| 22 Jan – 23 Mar 2020 | 43 | −37.47% | 24 Mar 2020 | +20.00% | +18.89% |
| 22 Apr – 27 May 2022 | 25 | −5.98% | 30 May 2022 | −4.50% | −2.19% |
| 1 Jun – 27 Jul 2022 | 41 | +0.35% | 28 Jul 2022 | +1.37% | +5.80% |
| 19 Aug – 25 Oct 2022 | 46 | −1.67% | 27 Oct 2022 | +4.26% | +4.17% |
| 25 Jan – 28 Apr 2023 | 62 | −0.29% | 2 May 2023 | +2.87% | +3.33% |
| 2 – 30 Aug 2023 | 20 | −1.96% | 31 Aug 2023 | +1.97% | +2.46% |
| 25 Sep – 5 Dec 2023 | 49 | +6.00% | 6 Dec 2023 | +3.47% | +2.53% |
| 18 Jan – 8 Apr 2024 | 55 | +5.07% | 9 Apr 2024 | −2.93% | +0.93% |
| 7 Oct 2024 – 6 May 2025 | 143 | −2.54% | 7 May 2025 | +0.77% | +1.56% |
| 13 May 2025 – 9 Oct 2026 | 352 | – | still short | – | – |

### 6.6 (c) Every flip to net long ("> 90% up within 30 sessions")

| flips | n | from E's open, 30 sessions: mean (95% CI) | share up (Wilson 95%) | from the flip day's close |
|---|---|---|---|---|
| after ≥ 1 net-short session | 77 | +2.71% (+1.63% … +3.85%) | 72.7% (61.9% … 81.4%) | +2.94%, 72.7% |
| after ≥ 20 net-short sessions | 16 | +3.29% (+1.42% … +5.78%) | 87.5% (64.0% … 96.5%) | +3.39%, 87.5% |
| (any 30-session window) | 3,330 | +1.27% | 63.6% | – |

- **"> 90%" is not reproduced** at the 30-session close: 72.7% of all flips, and 14 of the 16 flips that end a long streak. (Marketcalls may mean "higher at some point within 30 sessions", which is a lower bar and look-ahead as a trading rule.)
- **The flips did beat an average 30 sessions**, by about 1.4–2.0 percentage points. But the windows overlap, 2 of the 79 flips have no complete 30-session window in the index data, and there is nothing to hold out: FIIs have not flipped to net long since 13 May 2025.

### 6.7 The owner's example: FII cash net selling worse than −₹10,000 crore

| T (NSDL report date − 1 session) | FII net (₹ cr) | E | NIFTY E open → close |
|---|---|---|---|
| 17 Jan 2024 | −10,496 | 18 Jan 2024 | +0.22% |
| 4 Jun 2024 | −12,259 | 5 Jun 2024 | +2.22% |
| 5 Aug 2024 | −10,229 | 6 Aug 2024 | −0.82% |
| 3 Oct 2024 | −15,525 | 4 Oct 2024 | −0.66% |
| 28 Feb 2025 | −12,010 | 3 Mar 2025 | −0.34% |
| 20 May 2025 | −10,078 | 21 May 2025 | +0.28% |
| 13 Mar 2026 | −10,933 | 16 Mar 2026 | +1.27% |
| 19 Mar 2026 | −11,073 | 20 Mar 2026 | +0.02% |
| 23 Mar 2026 | −11,458 | 24 Mar 2026 | +0.15% |
| 1 Apr 2026 | −20,390 | 2 Apr 2026 | +1.47% |
| 29 May 2026 | −22,102 | 1 Jun 2026 | −1.15% |
| 29 Sep 2026 | −10,743 | 30 Sep 2026 | −0.20% |

- **12 days, mean +0.21% (CI −0.30% … +0.78%); NIFTY fell on 5** (41.7%, Wilson 19.3% … 68.0%). A put bought at the open after a big FII selling day would have needed the index to fall; it rose more often than not.
- **None of the 12 is before 2024**: the NSDL series starts in 2019 and no day in 2019–2023 reached −₹10,000 crore.
- **NSE's provisional figures** (26 Aug – 8 Oct 2026, 30 sessions) have two such days: 30 Sep 2026 (−₹10,148 cr) → 1 Oct −0.54%, and 8 Oct 2026 (−₹12,944 cr), whose next session is beyond the index data.
- Q2 had already found a correlation of 0.00 between FII cash flows and the next open-to-close over 1,877 days. The big days are no exception.

---

## 7. Tails (one lot)

**D1 option picks** (all days, 2021–2026):

| pick | trades | net ₹ | worst trade | best trade | 10 worst | net without the best 5 / 10 | max drawdown (% of ₹5 lakh) | longest losing run |
|---|---|---|---|---|---|---|---|---|
| S1 conservative | 884 | −₹4,28,444 | −₹12,375 (2 Jan 2025) | ₹20,857 (6 Jan 2025) | −₹91,375 | −₹5,07,636 / −₹5,66,431 | ₹4,36,270 (87%) | 16 |
| S1 mid | 884 | −₹1,89,752 | −₹11,831 (2 Jan 2025) | ₹21,959 (6 Jan 2025) | −₹86,685 | −₹2,72,677 / −₹3,35,034 | ₹2,14,339 (43%) | 16 |
| S2 conservative | 758 | −₹2,94,724 | −₹12,590 (30 Mar 2026) | ₹20,857 (6 Jan 2025) | −₹99,339 | −₹3,75,698 / −₹4,34,915 | ₹3,13,940 (63%) | 13 |
| S2 mid | 758 | −₹74,449 | −₹11,322 (30 Mar 2026) | ₹21,959 (6 Jan 2025) | −₹92,897 | −₹1,59,354 / −₹2,21,865 | ₹1,83,567 (37%) | 13 |
| S3 conservative | 854 | −₹4,32,789 | −₹12,375 (2 Jan 2025) | ₹23,154 (12 May 2025) | −₹1,03,230 | −₹5,22,159 / −₹5,81,011 | ₹4,40,615 (88%) | 15 |
| S3 mid | 854 | −₹2,04,608 | −₹11,831 (2 Jan 2025) | ₹23,949 (12 May 2025) | −₹97,448 | −₹2,97,836 / −₹3,60,437 | ₹2,35,682 (47%) | 15 |
| S4 conservative | 845 | −₹2,50,327 | −₹12,375 (2 Jan 2025) | ₹28,842 (17 Apr 2025) | −₹1,02,296 | −₹3,59,945 / −₹4,27,398 | ₹2,65,413 (53%) | 12 |
| S4 mid | 845 | −₹18,668 | −₹11,831 (2 Jan 2025) | ₹29,097 (17 Apr 2025) | −₹95,901 | −₹1,32,254 / −₹2,02,396 | ₹1,10,951 (22%) | 12 |

- **A bought option's loss is capped at its premium**, so the worst day is about −₹12,000 a lot: a put bought at 09:30 on 2 Jan 2025 (₹16,245 paid; NIFTY +1.7% from the open), sold at ₹3,930.
- **The gains are concentrated in a few days.** Every pick is negative overall, and removing its 5 best days takes another ₹79,000–1,14,000 off.
- **The drawdowns are large for a ₹5 lakh account:** 22–88% for the picks over five years, and 103% for S4 fade at the conservative fill (the worst variant).
- **The index picks' extremes are in March 2020.** At one week, S4's worst hold was −11.2% (25 Mar 2020) and its best +18.0% (17 Mar 2020); S1's and S3's worst one-day trade was −9.3% (13 Mar 2020).

---

## 8. Data caveats

### 8.1 Aggregation across indices

- **One number for every NSE index.** "Future Index" and "Option Index" in the file sum all NSE index contracts: NIFTY, BANKNIFTY, FINNIFTY (from 2021), MIDCPNIFTY (from 2022), NIFTYNXT50 (from 2024) and whatever else was listed at the time. NSE publishes no per-index split (R5 §3.4). The mix is NIFTY-heavy but not pure: in one month of 2025, 78% of the FIIs' net index-futures selling was NIFTY (R5 [P5]).
- **Options are contract counts, not exposure.** Every strike and expiry counts the same: a deep out-of-the-money weekly put weighs as much as an at-the-money monthly. Until 20 Nov 2024 the BANKNIFTY, FINNIFTY and MIDCPNIFTY weeklies inflated the index-options columns; afterwards NSE kept only the NIFTY weekly. S4 therefore measures something different before and after Nov 2024, and its out-of-sample period straddles the change.
- **The tests use NIFTY only.** SENSEX trades on BSE, which the NSE file does not cover.

### 8.2 The composition of "FII"

- **Not one fund.** The FII (FPI) row mixes long-only funds that hedge cash holdings by selling index futures, cash–futures arbitrage desks, hedge and macro funds, ETF market-makers and prop firms registered as FPIs (R5 §3.6). A futures short is often a hedge of a cash book, not a bet on the index. The long share is a composition measure, not a flow.
- **The FII and Pro option rows contain market-making books.** Until the SEBI order of 3–4 Jul 2025, part of the Jane Street group's index-options book sat in FPI entities; SEBI's FY26 study counts foreign-owned prop traders inside Pro (R5 §3.6). S4's out-of-sample period (from Aug 2021) runs across that order.
- **"Client" is not the retail option buyer.** About 59% of index-option turnover is in contracts expiring that day and most retail buying is closed before the close, so it never reaches end-of-day OI. On 8 Oct 2026 the Client row was net short 826,619 index puts: an overnight, put-writing book (R5 §4). S3 compares FIIs with that book, not with intraday retail buyers.

### 8.3 Structural breaks

- **The regime inversion** (§2.3): the FIIs' median long share was 68% in 2012–2016 and 14% in 2025–26; FIIs were net short every session from 13 May 2025. A level rule has no variation inside such a regime, which is why the signals are trailing ranks. The walk-forward split puts most of the net-long regime in the first 60% and most of the net-short regime in the last 40% (§2.6).
- **Lot sizes** (R5 §3.5): NIFTY 25 → 75 for new contracts from 20 Nov 2024 and 75 → 65 from 30 Dec 2025, with earlier changes in 2015–2024. The file counts contracts, so while old and new lots coexist a ratio can move without any change in exposure. The option tests use the bhavcopy's modal lot of the day, which went 75 → 50 (mid-2021) → 25 (Apr 2024) → 75 (Nov–Dec 2024) → 65 (Dec 2025 – Jan 2026), so their rupee figures per lot are not comparable across years without that scaling.
- **Product and rule changes:** FII and FPI merged into one category (2014); SEBI's index-derivatives package of 20 Nov 2024 (one weekly per exchange, bigger contracts, +2% expiry-day margin); the Jane Street order (3–4 Jul 2025); NSE's expiry moved to Tuesday (1 Sep 2025); STT on option sales raised in Apr 2023, Oct 2024 and Apr 2026 (all in the dated charges).

### 8.4 Timing and revisions

- **Publication time is known only from Aug 2019.** Where it can be measured the file is out at a median 18:55 IST, after the close (§2.1). The 1,742 files of 2012 – 16 Jan 2019 were all rewritten on 17 Jan 2019. The design never uses a file before the next session's open, so a late file matters only if it appeared after that open. 166 of the later files were last written a day or more after their date; whether they were first published on time cannot be told from the archive.
- **What the archive serves today may not be what was published that evening.** No original copies were available to compare.

### 8.5 Prices

- **Index:** Yahoo's daily open and close (official), so the index test enters at the open, not at 09:30. 15 regular sessions with a file have no complete Yahoo bar and are skipped as entries or exits (§2.2), including 1 Jan 2019, which drops one P2 flip.
- **Options:** the TradeMarkk 1-minute bars, NIFTY only, 24 May 2021 – 2 Jul 2026. From Jan 2025 they are built from sampled prices, so the conservative fill is not a true worst case there (WP11 §2). 62–78% of the out-of-sample option trades fall in that era; criterion 7 is the complete-bar check, and every pick fails it too.
- **M1 options** use NSE's end-of-day closing prices, not quotes, with or without the engine spread. They are descriptive only.

---

## 9. The bar, multiple testing and the ledger

- **The ledger.** `reports/trials.jsonl` went from 2,708 to **2,814 lines**: 106 `"wp": "WP14"` lines.
  - 24 index variants and 4 perturbations of S4 at one week (quartiles, quintiles, trailing 200, trailing 300), the only pick that reached the robustness step.
  - 48 option variants: 16 each for D1, W1 and M1.
  - 6 published-rule lines (P1 ×3, P2, P3 ×2) and 24 replication lines ((a) ×16, (b) ×3, (c) ×4, the owner's example).
  - The index, published-rule and replication lines carry `net` and `meanPerTrade` in **index basis points, not rupees** (`params.unit` says so). A rerun appends nothing: logged variants are skipped.
- **Bonferroni:** 0.05 / 2,814 = 1.78 × 10⁻⁵. The smallest out-of-sample p of any pick is 0.011 (S4 at one day), then 0.016 (S4 at one week). Every option pick has p ≥ 0.77.
- **The deflated Sharpe ratio.**
  - V[SR] over this study's 28 index-direction lines (the 24 variants and the 4 perturbations) is 1.13 × 10⁻³, so SR₀ = 0.119 a session with N = 2,814. The best index pick, S4 at one week, has SR 0.101 a session: DSR 0.260, and 0.522 with the null variance 1/(T − 1).
  - V[SR] over the 16 D1 option lines is 1.76 × 10⁻³ (SR₀ = 0.148). Every option pick's SR is negative, so every DSR is 0.000.
- **The criteria, pick by pick** (§1.7 numbering):
  - *Index:*
    - Criterion 1 (sample): passed by 8 picks (all four at one day; S1, S3 and S4 at one week); failed by S2 at one week (177) and all four at one month (44–47).
    - Criteria 2 and 3 (placebo, CI): passed only by S4 at one day and at one week.
    - Criterion 4 (PF): passed only by S4 at one week (1.35; S4 at one day had 1.23).
    - Criterion 5 (robustness): run and passed only for S4 at one week.
    - Criterion 6 (multiple testing): none.
  - *D1 options:* all 8 passed criterion 1 (303–353 trades); none passed 2, 3, 4, 6 or 7; criterion 5 was not run.

## 10. Paper-test spec

**None.** No pick passes §1.7, so by the pre-registered rule no paper-test spec is written for the ₹5 lakh paper account. The nearest miss, S4 at one week, is not a candidate:
- it fails multiple testing by three orders of magnitude;
- its sign held only from 2020 (2013–2019: −12.6 bp a trade);
- it is an index-direction tilt, and the option trades on it lost (one day, −₹532 a lot a trade) or were flat (one week, descriptive);
- a fresh out-of-sample test at the bar's size (180 independent weekly trades) would take about five years of new files to collect.

## 11. What changed after the freeze

1. **No definition or code changed.**
   - The development run (without the ledger) and the final run (`--ledger`) both used the code of the freeze commit `fdb2b87`, unchanged.
   - Their generated tables are byte-identical.
   - `git diff fdb2b87` shows no change to `scripts/research/wp14-positioning.ts`, `scripts/research/wp14_fetch.py` or `src/engine/backtest/positioning.ts`.
2. **Added after the runs: `scripts/research/wp14-xcheck.py`**, an independent re-computation in Python (standard library only, no shared code). It changes no result. From the raw files it reproduces:
   - every index pick's signal-day count, mean per trade and hit rate, over all days and the last 40%, exactly;
   - every D1 option pick's trade count, mean premium and mean gross P&L at both fills, exactly (gross = the main script's net plus its charges per trade), with the same skips (33 contracts missing, 10 sessions not valid).
3. **Checks by hand with `debug`:**
   - Two sessions, 15 Jun 2023 and 2 Jan 2025 (the picks' worst day), were checked against the raw participant file, the raw 1-minute bars and the bhavcopy.
   - The checks cover the file's counts, the four readings, the expiry (N4), the lot, the 09:29 index level, the ATM strike, both fills and the charges.
4. **P2 has 54 of the 55 confirmed flips.** This is the frozen rule at work, not a change: it skips a flip whose entry session has no complete index bar (1 Jan 2019).
5. **The report's §0 and §3–§12 and the status line** were written after the runs. §1 and §2 are byte-for-byte the freeze commit's.
6. **Presentation:** the generated tables print counts in the `en-IN` digit grouping ("1,00,000 resamples"); this report writes 100,000.

## 12. Reproduce

```bash
S=<scratchpad>; P=$S/wp14; B=<the compact NSE bhavcopy cache, with index-daily.json>
# 0. The participant OI files, into a new empty directory (one GET at a time, ≥ 1.2 s apart; about 1 h 50 min).
#    Weekend sessions known from Yahoo and the bhavcopy cache go in --extra.
python3 -I scripts/research/wp14_fetch.py --out $P/raw/participant_oi --log $P/logs/fetch_participant_oi.jsonl \
  --from 2011-12-26 --to 2026-10-09 --extra 2012-01-07,2012-03-03,2012-09-08,2012-11-11,2013-11-03,2014-03-22,2015-02-28,2016-10-30,2019-10-27,2020-02-01,2020-11-14,2023-11-12,2024-01-20,2024-03-02,2024-05-18,2025-02-01,2026-02-01
# 1. Inputs reused from earlier packages: WP13's 1-minute extract ($S/wp11/data/x13), the bhavcopy cache ($B),
#    Q2's Yahoo ^NSEI daily and NSDL csv, and NSE's provisional FII/DII window ($S/fiidata, optional).
IN="--oi $P/raw/participant_oi --fetchlog $P/logs/fetch_participant_oi.jsonl --daily $S/research/q2/data/yahoo/^NSEI_1d_since2007.json \
    --x $S/wp11/data/x13 --dir $B --fpi $S/research/q2/out/nsdl_fpi_daily.csv --nsefii $S/fiidata/fii_dii_daily.json"
# 2. Files, sessions, signal readings, cut dates and bar coverage (no returns; §2):
npx tsx scripts/research/wp14-positioning.ts coverage $IN --out reports/wp14
# 3. Every variant, the walk-forward picks, the bar, the tails, the published rules, the replications and the ledger (~7.5 min):
NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/research/wp14-positioning.ts run $IN --out reports/wp14 [--ledger]
# 4. One entry session by hand (the file it trades on, its readings, the D1 fills and the raw bars):
npx tsx scripts/research/wp14-positioning.ts debug $IN --day 2025-01-02
# 5. The independent re-computation (~10 min):
python3 -I scripts/research/wp14-xcheck.py $P/raw/participant_oi $S/research/q2/data/yahoo/^NSEI_1d_since2007.json $S/wp11/data/x13 $B
# 6. Unit tests of the new pure helpers:
npx vitest run src/engine/backtest/positioning.test.ts
```

| file | what it holds |
|---|---|
| `scripts/research/wp14_fetch.py` | The download of NSE's participant-wise OI archive files: sequential GETs, an honest User-Agent, a stop on 403/429 or repeated failures, every request logged with the file's Last-Modified |
| `scripts/research/wp14-positioning.ts` | The `coverage`, `run` and `debug` commands: files and sessions, the four signals, the index direction tests, the D1 / W1 / M1 option buyer, the published rules, the replications, the bar, the tails, the ledger and the tables |
| `scripts/research/wp14-xcheck.py` | The independent re-computation of the index picks and the D1 option trades (§11) |
| `src/engine/backtest/positioning.ts` (+ `.test.ts`) | The new pure helpers, with tests: `parseParticipantOi` (by label, with the integrity checks), `fiiDiiLabelsSwapped`, `longShare`, `optionsNetDirection`, `trailingRank`, `extremeBucket`, `blockBootstrap` (circular blocks for overlapping holds), `runsOf`, `wilson` |

- **Reused code.** Fills and positions come from WP11's `intraday1m.ts` (`runPosition`, `nearestListed`, `pairedGap`) and WP13's `expiryCalendar.ts` (`runOvernight`, `cutDate`, `pickBest`, `robustness`, `overallVerdict`). The loaders come from `wp11-real-intraday.ts` and `real_prices.ts`, and charges, structure P&L and tails from WP10's `shortPremium.ts`. The day-block bootstrap and the DSR come from `metrics.ts`, the ledger from `trials.ts`.
- **Isolation.** Nothing in the engine imports the new code.
- **Data.** No market data is committed. `reports/wp14/` (the generated tables, `coverage.md`, `coverage.json` and `summary.json`) is gitignored.
