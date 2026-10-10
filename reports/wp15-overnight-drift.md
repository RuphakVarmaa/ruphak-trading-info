# WP15: does NIFTY's (and SENSEX's) overnight drift give a retail option buyer an edge?

Sat 10 Oct 2026. Branch `worktree-agent-a1034c1e778172446`, fast-forwarded to `555c290` (head of `claude/gifted-wright-3d8r3j`). Analysis only: no paper trading, no deploys, no pushes; nothing in the engine changes.

**Data and licence.**
- **Index:** Yahoo's daily ^NSEI, ^BSESN and ^INDIAVIX bars (Q2's download of 9 Oct 2026, before the open; the last bar is 8 Oct 2026).
- **Option prices:** the Hugging Face dataset **"India Index & Options – 1-minute OHLC" by TradeMarkk** (`thetrademarkk/india-index-options-1m`, revision `0f4800e43e6f96cec0794369d78eb4d3c4211ef5`, https://huggingface.co/datasets/thetrademarkk/india-index-options-1m), licensed **CC-BY-NC-4.0**: non-commercial research use only, attributed here. WP11 §2 verified it against the exchanges' own files. This study reads WP13's extract of it.
- **Exchange files:** NSE and BSE F&O bhavcopies (the compact cache: NSE from 11 Feb 2019, BSE daily from 15 May 2023, both to 8 Oct 2026) for lots, expiries, holidays, short sessions, near-month futures and end-of-day option prices; the file names of NSE's participant-OI archive (WP14's download, 2 Jan 2012 – 9 Oct 2026) as a list of NSE sessions.
- Nothing was downloaded for this study. No raw or extracted data is committed (the repository is public); the scripts rebuild everything from the downloads.

**Status of this file:** §1 and §2 were written and committed before any overnight mean, conditional return or P&L was computed.

---

## 1. Frozen definitions (pre-registered before any overnight mean, conditional return or P&L)

### 1.0 The question and what was known before

- **The question.** Does the overnight drift exist in NIFTY and SENSEX, and can a retail option buyer capture it after costs?
- **Why now.** WP14 (§6.4) reproduced Marketcalls' "+17% a year after FII net-long readings" close to close, but found it sits entirely in the overnight gap: from the next open to the close both FII states lost (−17.7% and −14.2% a year, Sep 2016 – Sep 2026).
- **The literature** (note R6, complete and read before this freeze, and r4):
  - Cliff, Cooper & Gulen (2008): US stocks earned their return outside trading hours (R6 saw only press coverage).
  - Lou, Polk & Skouras (2019, *JFE* 134): cross-sectional strategy profits accrue entirely overnight or entirely intraday, a tug of war between clienteles. A cross-sectional result, not an index-timing rule.
  - Boyarchenko, Larsen & Whelan (NY Fed Staff Report 917): S&P 500 futures returns concentrate in an overnight window, and sell-offs are followed by positive overnight reversals. Close → open earned 4.62% a year at mid quotes and 0.38% after the bid–ask (2004–2020); "buy the dip" overnight kept 4.04% after the spread. Their 2026 update: the drift has averaged close to zero since 2021.
  - Muravyev & Ni (2020): delta-hedged S&P options lose about 1% close → open.
  - India: four write-ups (2020–2026), all gross of costs and in sample, agree that since 2011 NIFTY's return has come overnight. R6's arithmetic puts it at about 9, 7 and 4 bp a night in successive samples (2007–2020, 2015–2026, 2024–2026).
- **What the program's own data already showed.** These priors are why this is not a blind test of the sign:
  - WP6 (bhavcopy prints, NIFTY Feb 2019 – Oct 2026, 1,866 nights): the ATM straddle bought at NSE's close and sold at the next first trade returned +0.01% for the buyer; the call +3.39% and the put −3.24% of premium (t 3.5 and −3.4), gross. That night starts at a 30-minute VWAP and ends on the first print, which WP11 found rich, so it flatters the call.
  - Q1 (Jan 2024 – Oct 2026): +4.2 bp overnight, −3.9 bp open → close. Q2: NIFTY rose from open to close on 46.7% of days since 2011 (mean −0.07%).
  - WP14 §6.4: close to close positive and open to close negative in every window, state and era.
- **So the expected sign of NIFTY's unconditional overnight mean is positive.** What this study fixes before computing it: the bar it must clear out of sample, its placebos, the night subsets, the option expression, the three published variants and the tails.
- **Rule N5** ("no overnight holds") exists for gap risk. This study measures that risk (§1.7) as well as the mean.

### 1.1 Data

- **Daily index bars:** Yahoo ^NSEI and ^BSESN (official open, high, low and close), from Dec 2010 to 8 Oct 2026; a row with a missing field is no bar. India VIX: Yahoo ^INDIAVIX daily closes.
- **1-minute prices:** WP13's extract (`scripts/research/wp13_extract.py`) of the TradeMarkk dataset. For every session it holds the index bars 09:00–15:59 and, for the nearest expiry on or after the day (A) and the next one (N), every strike within max(6.5 steps, 2.6 expected moves + 1 step) of the index range of the session and the three sessions before it, bars 09:15–15:30. A strike chosen on D therefore stays in E's file. NIFTY: option files 24 May 2021 – 2 Jul 2026; SENSEX: 7 Aug 2023 – 2 Jul 2026 (SENSEX index bars from 1 Sep 2022).
- **Bars** (WP11 §1.1): `m` is the IST minute the bar starts; a bar holds the trades in [m, m + 1). A bar with zero volume is no trade.
- **Two data eras** (WP11 §2): bars to 31 Dec 2024 hold every trade; bars from 1 Jan 2025 are built from sampled prices. Closes, the last trade and the volume are still exact, but the day's first trade and most intraday extremes are missing, so the conservative fill is a true worst case only in the first era.
- **Valid 1-minute sessions** (WP11 §1.1): at least 370 index bars starting 09:15–15:29 with a 09:15 bar, a bhavcopy of the index's own exchange (NSE for NIFTY, BSE for SENSEX), and not a special session (§1.2).
- **Bhavcopies:** the listed expiries and the lot (the modal lot of a contract's rows on the day) of the index's own exchange. Sessions to expiry (DTE): NSE sessions after the day up to and including the expiry (WP10's convention, for both indices).

### 1.2 Sessions and nights

- **The calendar** is every date with a complete Yahoo bar of either index (from Dec 2010), an NSE or BSE bhavcopy, an NSE participant-OI file, or a Muhurat session.
- **Special sessions** are never the start or the end of a night:
  - weekend sessions (a Saturday or Sunday date in the calendar);
  - NSE's Diwali Muhurat sessions, about an hour each: 26 Oct 2011 and WP14's 14 dates for 2012–2025;
  - the bhavcopy's short sessions (WP6's rule: NIFTY option contracts below 0.3× the quietest of the three sessions on either side, from Feb 2019).
- **A night** runs from a regular session D to the next regular session E. A night with a special session between D and E (a Saturday Budget session, a Muhurat session) holds trading, not just a gap, and is skipped (counted).
- **Kind of night** (`nightKind`):
  - *weekday*: E is the next calendar day;
  - *weekend*: only Saturdays and Sundays lie between D and E;
  - *holiday*: a weekday without a session lies between them (R6's "pre-holiday" nights).
- **Index nights** start on or after 1 Jan 2011 (NSE's and BSE's pre-open call auction sets the official open from Oct 2010). D and E need complete Yahoo bars. A night on which E's open equals D's close exactly is a stale open and is skipped.
- **The index night return** is r = open(E) ÷ close(D) − 1, at the official open and close. **The intraday leg** of the same night is p = close(E) ÷ open(E) − 1.
- **The change of D** is close(D) ÷ close(D⁻) − 1, where D⁻ is the regular session before D. It is unknown when D⁻ has no complete bar.
- **The India VIX tercile** of a night: the VIX close of the last session before D, ranked within its trailing 250 closes (`trailingRank`): low below 1/3, high above 2/3.

### 1.3 A. Index direction: does the drift exist?

- **Variants (12):** for each index (NIFTY, SENSEX), long from close(D) to open(E) on:
  - all nights;
  - weekday nights;
  - weekend and holiday nights;
  - after a down day (change < 0);
  - after an up day (change > 0);
  - after a sell-off (change ≤ −1%).
- **These are fixed hypotheses.** No sign or subset is picked: the long side is the hypothesis, and each variant is judged on its own last 40%.
- **The cut**, per index: the last D of the first ⌈0.6 n⌉ valid nights (all nights). In sample: nights whose E is on or before the cut; out of sample: nights whose D is after it.
- **Statistics:**
  - The mean per night (per trade) and per session: every valid night of the window counts, nights outside the subset as 0.
  - A circular block bootstrap (`blockBootstrap`) with blocks of 5 sessions; 20,000 resamples (100,000 when both lower bounds are above zero); seed 7; one-sided p = (1 + #{resamples ≤ 0}) / (1 + resamples).
  - The hit rate (r > 0) with its Wilson interval, and the profit factor of r over the subset's nights.
- **Placebos:**
  - (a) *The intraday leg of the same nights* (E's open → close). The gap is the mean of r − p over the subset's nights, with the SE of the same block bootstrap of that series.
  - (b) *A fair-coin side* on the same nights. Its expectation is 0, so the gap is the mean, with its bootstrap SE.
- **Splits** (descriptive): each calendar year; the two halves of each variant's nights; D to 2019 against D from 2020; the night kind; the VIX tercile.

### 1.4 B. The retail option buyer on real 1-minute prices

- **Nights:** the calendar's nights with D from the first session with an option file (NIFTY 24 May 2021, SENSEX 7 Aug 2023) and E by 2 Jul 2026. D and E must be valid 1-minute sessions.
- **Contract:** the nearest listed expiry with at least 2 sessions to expiry at D (plan rule N4: never one expiring the next session), present in the extract on D and on E. One lot, at the lot in force on D.
- **Strike:** *ATM* is the listed strike (call and put both have bars on D) nearest the index level known at the order, the close of the index bar before the entry minute; a tie goes to the lower strike. *1 ITM* is the next listed strike below the ATM.
- **Orders:**
  - Buy the call at **15:20 or 15:25** on D, filled in its first bar within [m, m + 2].
  - Sell it at **09:15, 09:16 or 09:20** on E, filled in its first bar within [m, m + 5]. Without one it sells at the last close before m on E (a stale exit, counted); without any bar by then the night has no exit price and is skipped (counted).
  - No stop.
- **Fills** (WP11 §1.2): *conservative*, the verdict case (buy at the 1-minute bar's high, sell at its low); *mid* (the bar's close). No further spread.
- **Charges:** `computeCharges` per order at the rates in force on the day (`RESEARCH_CHARGE_SCHEDULES`, through `structurePnl`): STT on option sales 0.05% → 0.0625% (Apr 2023) → 0.1% (Oct 2024) → 0.15% (Apr 2026); dated exchange charges; ₹20 brokerage per order; SEBI fee, stamp duty on buys, IPFT, GST. NSE for NIFTY, BSE for SENSEX. The entry pays D's rates, the exit E's.
- **Night filters**, known at the order:
  - all nights;
  - weekday nights;
  - after a down day: the index at the order below the previous session's official close (Yahoo);
  - after a sell-off: at least 1% below it.
- **Both sides priced:** the mirrored put must fill at the same minutes for a night to count, because the placebo needs it. The mirrored put is at the ATM strike for an ATM call, and at the next strike above the ATM for a 1-ITM call. A night without it is skipped (counted).
- **Variants (192):** 2 indices × 4 filters × 2 entries × 3 exits × 2 strikes × 2 fills.
- **The cut**, per index: the last D of the first ⌈0.6 n⌉ trade nights of the base variant (all nights, ATM, 15:20 → 09:15, conservative). The same cut serves every option variant of that index, in families B and C.
- **The pick:** per index, filter and fill, the variant with the best in-sample mean per trade among the 12 timings and strikes (`pickBest`, ties by name), then judged untouched on the last 40%. That is 16 picks. The verdict is decided at the conservative fill; the mid pick is judged by the same criteria and reported beside. A family that passes only at mid is *mid only*: not actionable without quotes.
- **Placebo:** a fair coin between the call and the mirrored put at the same minutes (`fairCoinDays`). Its exact expectation on a night is (call + put) / 2, so the gap is the mean of (call − put) / 2: what choosing the call adds over the straddle's overnight P&L. Its SE is cluster-robust by night (`pairedGap`).
- **Statistics:** a night-clustered bootstrap (`dayBlockBootstrap`, each night a block), per trade and per session. Every slot counts, a slot being a night with both sides priced and the filter's input known; nights the filter rejects count as ₹0. 20,000 resamples (100,000 when both lower bounds are above zero), seed 7.
- **Splits** (descriptive): years; halves; the two data eras; before and from 1 Apr 2026 (the STT rise); the night kind; the VIX tercile.

### 1.5 C. R6's published variants (untuned)

These are R6's candidate cards C1 and C2 (§6 of the note), at most three variants, with R6's own parameters.

- **C1, the synthetic long** (₹5 lakh account only: the short put needs margin, which is not modelled).
  - At **15:25** on D (fills in [15:25, 15:27]), buy the call and sell the put at **K(fwd)**, the listed strike nearest the synthetic forward known at the order.
  - The forward is the median, over the three listed strikes nearest the index level, of K + C − P, each leg at its last close at or before 15:24. Both bars must have started within the 5 minutes before the order. Without one, the night has no forward and is skipped.
  - At **09:30** on E (fills in [09:30, 09:35]), sell the call and buy back the put.
  - Same contract rule (N4), lot, fills and charges as §1.4.
- **C1-B, the single long call** at K(fwd), the same minutes. This is the retail variant.
  - Its P&L is decomposed (mid fills, gross) in two ways: as ½ (call − put) plus ½ (call + put), the directional half and half the straddle; and as 0.5 × the index move × lot plus the rest (theta, vega and the opening print).
- **C2, the synthetic long after a weak session:**
  - C1 only on nights when D's session was weak. The session return is the index from 09:30 to 15:25 (the close of the 15:24 bar ÷ the close of the 09:29 bar − 1).
  - Three thresholds, fixed by R6: the return in the bottom 20% or the bottom 33% of its trailing 250 sessions (the rank as `trailingRank`: the share below plus half the ties, the session itself included), or below −0.5%.
  - A night is eligible only once 250 ranked sessions exist, for all three thresholds.
  - The threshold is picked on the first 60% (the same cut), per index and fill, and judged on the last 40%.
- **Placebos:**
  - C1 and C2: a fair coin between the long and the short synthetic (short call, long put) at the same minutes, so the gap is (long − short) / 2.
  - C1 and C2: the same synthetic held over E's session instead (bought at 09:30 and sold at 15:25 on E, `runPosition`, no stop); the gap is the night minus that session, paired by night.
  - Both gaps must be at least 2 SE.
  - C1-B: a fair coin between the call and the put at K(fwd).
- **The bar:** §1.6 criteria 1–7, plus R6's own rules:
  - 8. The same sign on the other index: the same variant's last-40% mean above zero on SENSEX for NIFTY, and on NIFTY for SENSEX, at the same fill. For C2 the other index's own pick is used, since each index picks its threshold on its own first 60%.
  - 9. Kill check 1: the net above zero on the nights from 1 Apr 2026, when STT rose.
  - 10. Kill check 2 (for the base timings): on the complete-bar nights (to Dec 2024), the same position exited at the first print (the 09:15 bar's open, the exchange's first trade in that era) against R6's 09:30. A gain at the first print (> 0) that is gone at 09:30 (≤ 0) is an opening-print artefact and kills the variant.
  - 11. C2 only: it must beat C1 on the same nights, meaning C2's mean minus the mean over every eligible night has a bootstrap CI above zero (10,000 resamples). It must also beat a random draw of the same number of nights from the same out-of-sample nights (p < 0.05, 10,000 draws).
- **Robustness** (R6's list): entry 15:20 / 15:28; exit 09:20 / 09:45; strike K(fwd) ± 1. C2 also moves its threshold to 0.8× and 1.2× its value.
- **Variants (20):** 2 indices × (C1, C1-B, and C2's three thresholds) × 2 fills. **Picks (12):** C1, C1-B and C2's pick, per index and fill.

### 1.6 The bar (plan §12)

**Index variants** ("does the drift exist?"; 12):
1. **At least 180 out-of-sample nights.**
2. **Both placebo gaps at least 2 SE** out of sample.
3. **Block-bootstrap 95% CI above zero** out of sample, per night and per session.
4. **PF ≥ 1.3** out of sample.
5. **±20% robustness:** only the sell-off subset has a parameter (thresholds −0.8% and −1.2%), run when criteria 2–4 pass. The other subsets have nothing to perturb (N/A).
6. **Multiple testing:**
   - Bonferroni: the larger of the per-trade and per-session bootstrap p-values must be below 0.05 / N, where N is the number of lines in `reports/trials.jsonl` after this study's lines are appended (2,814 before).
   - The deflated Sharpe ratio of the out-of-sample per-session returns must be at least 0.95. N comes from the ledger and V[SR] from this study's index lines; the 1/(T − 1) version is reported too.

**Option picks** ("can a buyer capture it?"; 16 in family B, 12 in family C; the verdict at the conservative fill):
1. **At least 180 out-of-sample trades.**
2. **Placebo gap at least 2 SE** out of sample (§1.4, §1.5).
3. **Night-clustered 95% CI above zero** out of sample, per trade and per session.
4. **PF ≥ 1.3** out of sample.
5. **±20% robustness**, run only for picks that pass criteria 2–4:
   - Family B, six perturbations: the entry at the two other values of 15:15 / 15:20 / 15:25; the exit at 09:30 and at the nearest other value of 09:15 / 09:16 / 09:20; the strike one step either way (ATM → 1 OTM and 1 ITM; 1 ITM → ATM and 2 ITM).
   - The sell-off picks also move the threshold to −0.8% and −1.2%.
   - Family C: R6's list (§1.5).
   - The rule (`robustness`): at least 80% of the perturbed variants with out-of-sample net above zero, and the worst no lower than base − 50% × |base|.
6. **Multiple testing** as above; V[SR] from this study's option lines.
7. **Complete-bar era:** the variant's trades with D to 31 Dec 2024, in and out of sample, must have a mean above zero with a night-clustered CI above zero (10,000 resamples).

Plus R6's criteria 8–11 for family C (§1.5).

- **Verdicts** (`overallVerdict`): *PASS* when every criterion passes; *INSUFFICIENT* when the sample size is the only failure; *FAIL* otherwise. A criterion not run because an earlier one failed counts as a failure.
- **A paper-test spec is written only for a pick that passes.**
- **The copy delay:** criterion 5's later entry (15:25 for a 15:20 pick) and later exit (09:30) are a hand copier's delay. The independent review for look-ahead bias is the cross-check script (`wp15-xcheck.py`).

### 1.7 D. Descriptive series and the tails

- **D1, the bridge.** On the nights valid in both the index family and the 1-minute sample, three measures:
  - the official close → open;
  - D's 15:29 bar close → E's 09:15 bar open;
  - the index's bar closes 15:20 and 15:25 → 09:15, 09:16 and 09:20, and 15:25 → 09:30.

  Together they show how much of the official overnight return falls in minutes a buyer can trade.
- **D2, near-month futures** (robustness only):
  - The nearest futures expiry after D that traded on D (a closing price) and on E (an open). The measure is E's open ÷ D's closing price − 1, and ₹ per lot at D's lot.
  - NIFTY from Feb 2019 (NSE); SENSEX from 15 May 2023 (BSE). NSE's last trade → open is reported from 2024, when the UDiFF files carry the last trade.
  - The sell-side STT at E's open is reported at its dated rate: 0.01% → 0.0125% (Apr 2023) → 0.02% (Oct 2024) → 0.05% (Apr 2026). These are the Finance Act dates the option schedule already encodes, and R6 [K1] for 2026. Other futures charges are not modelled.
- **D3, the ATM call at end-of-day prints:**
  - The call is bought at the exchange's closing price on D and sold at the next session's first trade. Its strike is nearest the official close, among calls that traded; the contract follows N4; dated charges apply; WP6's bad-print filter is used.
  - NIFTY from Feb 2019, SENSEX from May 2023. It gives the tails before the 1-minute data (2020).
- **D4, the overnight straddle:** the ATM call plus put, 15:20 → 09:15, both fills (the placebo's expectation × 2).
- **Tails** (required), for every option pick:
  - the 10 worst nights (₹ per lot, dated);
  - the worst 5% and 1% of nights: the value at risk (the count-th worst night) and the expected shortfall (their mean);
  - the maximum drawdown of cumulative ₹ at one lot a night, also as % of ₹5 lakh and of ₹10,000;
  - the longest losing run;
  - the share of nights whose one-lot premium exceeds ₹10,000, which the small account cannot buy.
- **What a stop cannot do overnight:**
  - For each pick: the nights on which the exit fill was already 30% (or 50%) below the entry fill. A stop at that level could not have filled there, because nothing trades overnight. The study reports their number and the mean ₹ per lot lost beyond the stop (`gapThroughStop`). For a synthetic (C1, C2) this is computed on its call leg; the synthetic itself has no premium cap, and its gap risk is the index's.
  - For the index: the nights with a gap ≤ −1%, ≤ −2% and ≤ −3%, and the mean beyond a 1% or a 2% stop.
- **Index tails:** the 10 worst nights 2011–2026 and the 5% and 1% value at risk and expected shortfall. Also a futures lot's 8 worst nights (2019–2026).
- **Named nights:** the nights into 13 Mar 2020 and 23 Mar 2020 (two COVID-crash gaps) and into 4 and 5 Jun 2024 (the election result), on every series that covers them.

### 1.8 Ledger

- One line per evaluated variant in `reports/trials.jsonl` with `wp: "WP15"`:
  - the 12 index variants and any perturbations run;
  - the 212 option variants (192 in family B, 20 in family C) and any perturbations run;
  - the descriptive lines (bridge, futures, end-of-day calls, straddles).
- Index, bridge and futures lines carry `net` and `meanPerTrade` in **index basis points, not rupees** (`params.unit` says so). Variants already logged are not appended again.

### 1.9 Tested before this freeze

- The `coverage` command reads bars, sessions and counts only. It runs data-quality checks: missing fields, stale opens, Yahoo against two other sources, and the two indices' gaps against each other as a correlation and counts of large disagreements, with no mean. No overnight mean, conditional return or P&L.
- A `--smoke` run of the whole pipeline (statistics, verdicts, tables) without the ledger, in which **every price-derived value was replaced by a deterministic synthetic number** (an FNV-1a hash of its key) and the night conditions by a fixed cycle. Its tables are marked as synthetic and say nothing about the data.

---

## 2. Data and samples (before any P&L)

Everything in this section comes from bars, sessions, file lists and counts (`wp15-overnight-drift.ts coverage`). No overnight mean, conditional return or P&L entered it. The only price comparisons are the data-quality checks of §2.1.

### 2.1 The daily index series

| index | rows from Dec 2010 | rows with a missing field (from 2011) | of them regular sessions of the calendar | stale opens (open = previous close) | open or close outside the high–low | against the bhavcopy cache's own Yahoo download (Oct 2016 –): days, > 0.5 pt apart | against NSE's official close (UDiFF, Jan 2024 –): days, > 0.5 pt apart |
|---|---|---|---|---|---|---|---|
| NIFTY | 3,917 | 27 | 19 | 2 (27 Apr 2012, 2 Nov 2017) | 0 | 2,465, 0 | 679, 0 |
| SENSEX | 3,917 | 22 | 13 | 1 (20 Jul 2026) | 0 | 2,462, 0 | – (BSE's file has no index close) |

- **Missing fields.** Most are holidays, special sessions or days without a session. The regular sessions without a complete bar are:
  - NIFTY: 31 May, 14 Jul, 24 Nov and 26 Dec 2011; 2 Jan, 21 May, 28 Aug and 26 Oct 2012; 1 Jan 2013; 1 Jan and 17 Feb 2014; 1 Jan and 15 Apr 2015; 1 Jan and 12 Aug 2016; 1 Jan 2018; 1 Jan, 13 Feb and 29 Mar 2019.
  - SENSEX: 2 Jan and 26 Oct 2012; 1 Jan 2013; 26 and 29 Dec 2014; 1 Jan 2015; 1 Jan 2016; 1 Jan, 13 Feb and 29 Mar 2019; 1 Jan 2020; 7 May 2021; 1 Jan 2024.
  - A night touching one of these is skipped. So is a night with a stale open.
- **Against the 1-minute index bars** (TradeMarkk):
  - The official open differs from the 09:15 bar's open by a median 3.5 bp for NIFTY (1,248 sessions; 99th percentile 20.5 bp, maximum 71 bp) and 4.4 bp for SENSEX (759; 34.2 bp, 93 bp).
  - The official close differs from the last 1-minute print by a median 4.5 bp and 4.2 bp. The official close is set from the constituents' closing prices, a 30-minute VWAP.
  - The official open is the pre-open auction's index value, and on gap days the index can move far in the first minute. On 2 Mar 2026 SENSEX's official open was 78,544; its 09:15 bar opened at 78,689 and closed at 80,194. On 5 Aug 2024 the open was 78,588 and the 09:15 bar opened at 79,322. NIFTY's official open on 5 Aug 2024 equals its 09:07 pre-open print (24,302.85).
  - This is why the option family trades real minutes and the bridge (§1.7, D1) measures the difference.
- **The two indices' gaps against each other.** R6 warned that Yahoo's early SENSEX opens may be bad.
  - The correlation of NIFTY's and SENSEX's close → open gaps is 0.93–0.99 in every year from 2011 to 2026.
  - The two gaps differ by more than 1 percentage point on 5 nights: those starting 20, 23 and 27 Mar 2020 (the COVID-crash opens), 2 Aug 2024 (into 5 Aug) and 27 Feb 2026 (into 2 Mar). In the last two, SENSEX's official open sits far below its 09:15 trades.
  - No year shows a stale or broken open series. The pre-2011 opens R6 suspected are outside this sample.

### 2.2 Sessions and nights

- **The calendar:** 3,929 sessions, 1 Dec 2010 – 9 Oct 2026. They come from complete Yahoo bars of either index, the NSE bhavcopy (11 Feb 2019 –), the BSE bhavcopy (15 May 2023 –), 3,658 NSE participant-OI file dates (2 Jan 2012 –) and the Muhurat days.
- **Special sessions from 2011:** 26.
  - Muhurat: 26 Oct 2011, 13 Nov 2012, 3 Nov 2013, 23 Oct 2014, 11 Nov 2015, 30 Oct 2016, 19 Oct 2017, 7 Nov 2018, 27 Oct 2019, 14 Nov 2020, 4 Nov 2021, 24 Oct 2022, 12 Nov 2023, 1 Nov 2024 and 21 Oct 2025.
  - Weekend and drill sessions: 7 Jan, 3 Mar and 8 Sep 2012; 22 Mar 2014; 28 Feb 2015; 1 Feb 2020; 20 Jan, 2 Mar and 18 May 2024; 1 Feb 2025; 1 Feb 2026.

| year | 2011 | 2012 | 2013 | 2014 | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 (to 8 Oct) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| regular sessions | 246 | 246 | 248 | 242 | 246 | 246 | 247 | 245 | 244 | 250 | 247 | 247 | 245 | 245 | 247 | 190 |
| special sessions | 1 | 4 | 1 | 2 | 2 | 1 | 1 | 1 | 1 | 2 | 1 | 1 | 1 | 4 | 2 | 1 |
| weekday holidays | 13 | 14 | 13 | 18 | 14 | 15 | 12 | 15 | 17 | 12 | 13 | 12 | 15 | 16 | 13 | 12 |

**Index nights (D from 1 Jan 2011 to 7 Oct 2026; counts only):**

| index | candidate nights | skipped | valid nights | weekday / weekend / holiday | after a down day / an up day / a sell-off ≤ −1% | change unknown | **cut after** | last 40%: all / weekday / weekend and holiday / down / up / sell-off |
|---|---|---|---|---|---|---|---|---|
| NIFTY | 3,880 | 39 no complete bar on D or E; 26 span a special session; 2 stale opens | 3,813 | 2,909 / 706 / 198 | 1,789 / 2,001 / 441 | 19 | **15 Jul 2020** | 1,525 / 1,165 / 360 / 701 / 823 / 156 |
| SENSEX | 3,880 | 26 no complete bar; 26 span a special session; 1 stale open | 3,827 | 2,922 / 706 / 199 | 1,816 / 1,999 / 442 | 12 | **1 Jul 2020** | 1,530 / 1,171 / 359 / 716 / 812 / 161 |

- The India VIX tercile is known on every valid night (VIX from 2008).

### 2.3 The exchange calendars

- **The NSE bhavcopy cache** misses one regular session, 30 Mar 2021, before the 1-minute sample starts. Futures and end-of-day nights touching it are skipped.
- **The BSE cache** misses 7 NSE sessions: 28 Jun and 25 Jul 2023; 2 Aug, 29 Aug and 29 Nov 2024; 10 Feb and 2 Sep 2025. BSE has no file NSE lacks.
  - Without the BSE file, SENSEX has no lot or expiry list that day, so it is not a valid 1-minute session.
  - The nights touching these dates are skipped for SENSEX, never merged into a two-session "night". This is why the option, futures and end-of-day nights use the full calendar rather than one exchange's file list.
- **Short sessions** by WP6's volume rule: 27 Oct 2019, 14 Nov 2020, 4 Nov 2021, 12 Nov 2023, 2 Mar 2024, 18 May 2024, 1 Nov 2024 and 21 Oct 2025.

### 2.4 The option samples (bar presence only)

| index | nights in the option range | skipped before any bar | base B nights (ATM call and put, 15:20 → 09:15) | **cut after** | first 60% / last 40% | last 40%: to Dec 2024 / from 2025 / from 1 Apr 2026 | last 40% by filter (at 15:20): all / weekday / down / sell-off | C1 nights (15:25 → 09:30) | C2 nights with a rank | DTE at entry |
|---|---|---|---|---|---|---|---|---|---|---|
| NIFTY | 1,257 | 33 contract missing on D or E; 15 not valid sessions; 10 span a special session | 1,199 | **15 May 2024** | 720 / 479 | 153 / 326 / 35 | 479 / 368 / 240 / 48 | 1,199 | 956 | 2: 254, 3: 250, 4: 250, 5: 250, 6: 193, 7: 2 |
| SENSEX | 710 | 43 contract missing; 16 not valid; 8 span a special session | 628 | **9 Apr 2025** | 377 / 251 | 0 / 251 / 32 | 251 / 189 / 126 / 26 | 626 | 451 | 2: 138, 3: 139, 4: 134, 5: 129, 6: 100, 7: 3 |

- A missing contract is the N4 contract without a file in the extract on D or on E. For SENSEX this includes the dataset's expiry gaps (no weekly file between 25 Oct and 8 Nov 2024, 26 Aug and 4 Sep 2025, 23 Oct and 6 Nov 2025, and 21 May and 9 Jul 2026; WP13's manifest).
- **NIFTY's 1-minute index starts on 24 May 2021**, so its first 250 sessions (to about May 2022) have no C2 rank. SENSEX's index starts on 1 Sep 2022, so C2 covers almost all of its option nights.
- **Every one of SENSEX's last-40% nights falls in the sampled-bar era.** NIFTY's last 40% has 153 complete-bar nights.

### 2.5 Futures and end-of-day calls (bhavcopy; counts only)

| index | futures nights (near month traded on D and E) | first / last D | skipped | from 1 Apr 2026 | ATM call close → open nights | skipped |
|---|---|---|---|---|---|---|
| NIFTY | 1,868 | 11 Feb 2019 / 7 Oct 2026 | 13 span a special session; 3 without an NSE file on D or E; 1 not traded on E | 129 | 1,864 | 13 span; 4 without a contract with ≥ 2 sessions or an index close; 3 without a file; 1 bad opening print |
| SENSEX | 815 | 15 May 2023 / 7 Oct 2026 | 15 without a BSE file on D or E; 8 span | 129 | 808 | 15 without a file; 8 span; 4 without a contract or a close; 3 the call did not trade |

### 2.6 What this fixes before any P&L

1. **Index:** the five subsets other than the sell-off reach 180 out-of-sample nights (359–1,530). **The sell-off subsets cannot** (156 NIFTY, 161 SENSEX): *INSUFFICIENT* at best.
2. **Options, family B:**
   - NIFTY: all nights (479), weekday (368) and down-day (240) can reach 180 trades out of sample. The sell-off filter (48) cannot.
   - SENSEX: all nights (251) and weekday (189) can. Down-day (126) and sell-off (26) cannot.
3. **Family C:**
   - C1 and C1-B can reach 180 (about 479 NIFTY and 250 SENSEX nights out of sample).
   - **C2 cannot.** A rank threshold of 1/3 selects about a third of the eligible nights (≈ 160 NIFTY, ≈ 84 SENSEX out of sample) and 20% fewer still: *INSUFFICIENT* at best. Its other criteria are still reported.
4. **SENSEX's last 40% lies wholly in the sampled-bar era**, where the conservative fill is not a true worst case. Its complete-bar check (criterion 7) leans on SENSEX's first 60% (Aug 2023 – Dec 2024).
5. **The index's last 40% begins in July 2020** (after the COVID crash, through the rally and the 2024–26 period); its first 60% covers 2011 – mid-2020.
6. **The post-STT-rise window is short:** 35 NIFTY and 32 SENSEX option nights from 1 Apr 2026. R6's kill check 1 rests on that small sample.
