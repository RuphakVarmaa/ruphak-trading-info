# WP10: the seller's side of NIFTY and SENSEX weekly options on real exchange prices

Fri 9 Oct 2026. Branch `worktree-agent-aac3e0fbb005f12c3`, reset to `b0bd9c1` (head of `claude/gifted-wright-3d8r3j`). Analysis only: no paper trading, no deploys, no pushes; nothing in the engine changes.

**Status of this file:** §1 was written and committed (`12eedac`) before any profit or loss was computed, and it is unchanged. §0 and §2–§10 were added after the runs. §2 lists everything that changed in the implementation after the freeze. No definition in §1 changed.

---

## 0. Bottom line

**Verdict: no defined-risk rule clears the bar, so no paper test is warranted.** The only consistent seller's premium in these files sits in the day's first trade. End-of-day data cannot show whether anyone could actually sell at that price.

The verdict table below is per trade and net of dated charges and the engine's spread. Each row is one lot. The 95% CIs use day blocks (for hold-to-expiry, whole trades), with 100,000 resamples.

| structure | index | net % of premium (95% CI) | ₹ per lot (95% CI) | PF | worst day (₹ per lot) | verdict |
|---|---|---|---|---|---|---|
| Intraday short ATM straddle, open→close, current weekly (Q1) | NIFTY 2019–26 | **+2.9%** (+1.1 … +4.7) | +442 (+253 … +626) | 1.39 | −41,362 (13 Mar 2020) | untestable without intraday quotes; naked |
| | SENSEX 2023–26 | **+6.2%** (+3.4 … +8.9) | +864 (+595 … +1,131) | 1.91 | −21,908 (19 Feb 2026) | same |
| Intraday short iron fly, wings ±1 EM (C1) | NIFTY | **−3.3%** (−3.8 … −2.8) | −354 | 0.49 | −10,474 (15 Apr 2020) | not worth it |
| | SENSEX | **−2.4%** (−3.3 … −1.5) | −226 | 0.64 | −12,312 (9 Mar 2026) | not worth it |
| Intraday short iron fly, wings ±2 EM (C2) | NIFTY | **−1.6%** (−2.4 … −0.9) | −92 (−197 … +14) | 0.89 | −19,431 (12 May 2025) | not worth it |
| | SENSEX | **+0.2%** (−1.1 … +1.5) | +206 (+26 … +384) | 1.29 | −20,194 (12 May 2025) | not worth it (PF, 2023, VWAP entry, Bonferroni) |
| Hold to expiry: short strangle ±1 EM, N = 1, naked (Q3) | NIFTY | **+31%** (+8 … +51) | +620 (+197 … +988) | 1.82 | −46,369 (week of 12 Mar 2020) | positive, but naked: not a candidate |
| | SENSEX | **+7%** (−25 … +37) | +415 (−219 … +988) | 1.39 | −29,072 (week of 19 Mar 2026) | not significant |
| Hold to expiry: iron condor, N = 2 (C3) | NIFTY | **+3.9%** (−12.5 … +19.6) | −25 (−448 … +371) | 0.98 | −22,007 (week of 30 Mar 2026) | not worth it |
| | SENSEX | **+6.4%** (−20.6 … +29.4) | +258 (−350 … +806) | 1.24 | −18,717 (week of 15 Apr 2025) | not worth it (154 weeks < 180) |

**Q1, intraday short straddle.**
- Sold at each leg's first print and bought back at the closing VWAP, the ATM straddle earns +2.9% of premium a day on NIFTY (1,884 days) and +6.2% on SENSEX (824 days), after costs.
- The day-block CIs are well above zero. It survives 2× the spread, and it even clears Bonferroni over the 1,652 logged trials.
- **The whole edge is the opening print.**
  - The opening straddle sits a median 7.9% (NIFTY) and 11.3% (SENSEX) above the same straddle at the day's VWAPs.
  - Sold at the day's VWAP instead, the same trade loses −4.7% (NIFTY) and −13.2% (SENSEX).
  - Sold at the previous close and bought back at today's close (both reliable averaged prices), it makes +0.7% and +0.5%, with CIs spanning zero.
- Whether a seller can sell at the first print in a thin 09:15 book, at the bid rather than at a print that may have been someone's buy at the offer, is exactly what end-of-day files cannot show.
- Break-even: a real entry worse than the print by more than about 1.7% of premium (NIFTY, never trading the expiring contract) or 4.1% (SENSEX) erases the edge.

**The naked straddle's tail.**

| measure, per lot | ₹ | days of the average profit | % of a ₹5 lakh account |
|---|---|---|---|
| worst day (13 Mar 2020, −97% of the premium) | −₹41,362 | 94 | 8% |
| worst 20-session run | −₹92,577 | | 19% |
| maximum drawdown (15 Apr 2019 → 24 Mar 2020) | ₹1.26 lakh | | 25% |

- The worst 5% of days lost 1.25× everything the straddle netted in 7.6 years.

**Q2, defined risk gives the edge back.**
- The long wings are bought at the same rich opening prints and add four more orders of charges.
- With ±1 EM wings the iron fly loses −3.3% of premium a day on NIFTY (PF 0.48, negative in all 8 years) and −2.4% on SENSEX. With ±2 EM wings it is about flat.
- The cap works: the worst fly day is −₹10.5k to −₹20.2k per lot, against −₹41.4k for the straddle. But there is no profit left to protect.

**Q3, hold to expiry, is the only structure measured on reliable prices** (closes and the final settlement).
- The naked strangle 1 EM out is positive:
  - NIFTY: +₹620 per lot a week at N = 1 (PF 1.82) and +₹636 at N = 2 (PF 1.56), both with CIs above zero.
  - SENSEX: +₹674 at N = 2 and +₹938 at N = 4.
- But it is naked: one week cost −₹46,369 (N = 1) and −₹92,969 (N = 4, 5–12 Mar 2020). The worst 5% of N = 4 weeks lost 7.9× that variant's 7.6-year net.
- With wings at 2 EM (an iron condor) the edge disappears: the pre-registered C3 makes −₹25 a week on NIFTY and +₹258 on SENSEX (not significant).

**Q4, margin.** About ₹1.5–2.2 lakh per lot for a naked ATM straddle and ₹0.7–0.9 lakh for the iron flies at today's index levels. Short options held into their expiry day carry another 2% of notional per short leg (§6).

**Every pre-registered candidate fails the bar (§8).**
- C1 and C2 fail on the CI (except SENSEX C2), PF, calendar years, robustness and multiple testing.
- C3 fails on the CI, PF, calendar years, robustness and multiple testing, and SENSEX has only 154 weeks.
- The ledger now has 1,652 lines, 90 of them this study's. The Bonferroni level is 3.0 × 10⁻⁵.

**Recommendation:** no paper test of short premium, and nothing to enable. If the owner wants the intraday question answered, the missing input is intraday option quotes. The first thing to measure is whether the opening print can actually be sold (§7, §9).

---

## 1. Frozen definitions (pre-registered before looking at any P&L)

### 1.1 Data

- **Option prices:** the WP6 bhavcopy cache (compact extracts; NSE 2019-02-11 → 2026-10-08, BSE 2023-05-15 → 2026-10-08), loaded with `src/engine/backtest/realPrices.ts` through `loadResearchData` in `scripts/research/real_prices.ts`. Read-only; never committed.
- **Index and VIX:** Yahoo daily `^NSEI`, `^BSESN`, `^INDIAVIX` from the same cache (`index-daily.json`). Index open = Yahoo daily open (the official open). Index close = NSE's `UndrlygPric`, else the Yahoo close.
- **Sessions:** every session with a bhavcopy, minus WP6's short special sessions (Muhurat trading, DR drills). Weekend Budget sessions with a full day (2020-02-01, 2025-02-01, 2026-02-01) are kept.
- **VIX known before the open:** the last India VIX close on or before the previous session.
- **Bad prints:** WP6's filter. A leg whose opening print is below 10% of its previous close while the index moved less than 3% drops the day.

### 1.2 Contracts, strikes, sizes

- **Convention A, "current weekly":** the nearest listed expiry on or after the session. On expiry day this is the contract expiring that day.
- **Convention B, "never the expiring contract":** the nearest listed expiry strictly after the session (WP6's and the engine's rule).
- **Sessions to expiry (DTE):** sessions after the trade date up to and including the expiry; 0 on expiry day.
- **ATM strike K:** for day trades, the listed strike nearest the index open. For hold-to-expiry trades, the listed strike nearest the put–call-parity forward from closing prices (`parityForward`, field `close`), falling back to the official close.
- **Expected move:** daily EM = S × VIX/100 × √(1/252), with S the index open and VIX the last close before the session. Over N sessions, EM_N = F × VIX/100 × √(N/252), with F the closing parity forward and VIX that session's close.
- **Wings at m expected moves:** the call wing is the listed strike above K nearest K + m·EM; the put wing is the listed strike below K nearest K − m·EM.
- **Lot:** one lot per trade, at the lot size in force (the modal lot of that contract's rows that day).

### 1.3 Prices and costs

- **Day trades:** each leg enters at its OPEN (first trade at or after 09:15) and exits at its CLOSE (NSE: VWAP of the last 30 minutes; BSE: the published close). On the contract's own expiry day the exit is the intrinsic value at the final settlement price, with no exit order.
- **Hold to expiry:** entry at each leg's CLOSE N sessions before expiry; exit at intrinsic value at the final settlement price.
- **Spread:** the engine's model, full spread max(1 tick, 0.4% of premium), half paid on each leg at each order. Sensitivity: 2× that spread.
- **Charges:** per order, at the rates in force on the order's date. `computeCharges` from `src/engine/broker/charges.ts` takes a dated schedule list, and the research list extends the engine's `CHARGE_SCHEDULES` backwards:

| from | STT (sell, % of premium) | NSE txn | BSE txn (as billed to clients) | source |
|---|---|---|---|---|
| sample start | 0.05% | 0.053% | — | Zerodha bulletin, 3 Apr 2023 (the "old" column) |
| 2023-04-01 | 0.0625% | 0.05% | 0.05% (assumed equal to NSE's billed rate) | Zerodha bulletin, 3 Apr 2023 |
| 2024-04-01 | 0.0625% | 0.0495% | 0.0495% | Zerodha bulletins, 15 Mar 2024 and 28 Sep 2024 |
| 2024-10-01 | 0.1% | 0.03503% | 0.0325% | engine schedule; Zerodha bulletin, 28 Sep 2024 |
| 2026-04-01 | 0.15% | 0.03503% | 0.0325% | engine schedule (Budget 2026) |

  - The other charges are the same throughout: SEBI fee 0.0001%, IPFT 0.0005%, GST 18%, ₹20 brokerage per order.
  - Stamp duty is 0.003% on buys throughout. The uniform rate dates from 1 Jul 2020; earlier, state rates of similar size applied (approximation).
  - Settlement carries no order and no charges for short legs. A long leg that expires in the money pays exercise STT on its intrinsic value: 0.125%, or 0.15% from 2026-04-01.

### 1.4 Structures

- **Q1, intraday short ATM straddle:** sell the ATM call and put at the open, buy both back at the close (or let them settle on expiry day). Run under conventions A and B.
- **Q2, intraday short iron fly:** Q1 plus long wings at m = 1 and m = 2 daily EMs. A day is usable only if all of these hold, checked in this order; otherwise it is dropped with the first failing reason:
  - S1: all four legs traded and have an opening print.
  - S2: each wing traded ≥ 500 contracts that day (more than one a minute on average, so a late first trade is implausible).
  - S3: no arbitrage at the open. Each vertical (C_K − C_wing and P_K − P_wing) lies in [0, its width], and the fly's opening value lies in (0, the larger width).
  - S4: each wing's opening implied volatility is within a factor of 2 of a synchronous estimate: its previous-close IV × (ATM straddle IV at the open ÷ ATM straddle IV at the previous close). This uses Black-76 on the parity forward, with the engine's trading-time clock. When the wing has no previous close, S4 is not checked.
  - The straddle's P&L on dropped days is reported, to show whether the screen removes the tail.
- **Q3, hold to expiry:** sell a strangle at ±1 EM_N at the close of the session N = 1, 2 or 4 sessions before each weekly expiry, and hold it to settlement. One trade per expiry and index. The defined-risk version adds long wings at ±2 EM_N (an iron condor). Every leg must have traded on the entry day.

### 1.5 Statistics

- **Units:** net ₹ per lot (primary) and net P&L as % of the short legs' premium.
- **Measures:**
  - hit rate;
  - profit factor (gross profit ÷ gross loss of net P&L);
  - worst day;
  - worst 5- and 20-session runs (consecutive trades in date order; for Q3, 4- and 12-trade runs);
  - maximum drawdown of cumulative ₹ per lot;
  - the share of total net P&L carried by the worst 5% of trades.
- **Bootstrap:** 100,000 resamples of whole sessions (day blocks; for Q3, whole trades), seed 7, percentile 95% CIs per trade and per session (sessions without a trade count as ₹0).
- **Breakdowns:**
  - calendar year;
  - DTE (0 = expiry day, 1, 2–5, 6+);
  - India VIX tercile, point in time: the percentile rank of the last close among the previous 252 closes, split at 1/3 and 2/3;
  - scheduled events (§1.6): the event day, the session before, other days;
  - opening gap |open ÷ previous close − 1|: < 0.25%, 0.25–0.5%, 0.5–1%, ≥ 1%.

### 1.6 Scheduled events

Only events scheduled in advance count; the off-cycle RBI decisions of 27 Mar 2020, 22 May 2020 and 4 May 2022 are not on the list.

| kind | dates |
|---|---|
| Union Budget | 2019-02-01, 2019-07-05, 2020-02-01, 2021-02-01, 2022-02-01, 2023-02-01, 2024-02-01, 2024-07-23, 2025-02-01, 2026-02-01 |
| RBI policy decision | 2019-02-07, 04-04, 06-06, 08-07, 10-04, 12-05; 2020-02-06, 08-06, 10-09, 12-04; 2021-02-05, 04-07, 06-04, 08-06, 10-08, 12-08; 2022-02-10, 04-08, 06-08, 08-05, 09-30, 12-07; 2023-02-08, 04-06, 06-08, 08-10, 10-06, 12-08; 2024-02-08, 04-05, 06-07, 08-08, 10-09, 12-06; 2025-02-07, 04-09, 06-06, 08-06, 10-01, 12-05; 2026-02-06, 04-08, 06-05, 08-05, 10-07 |
| General-election results | 2019-05-23, 2024-06-04 |

### 1.7 The bar (plan §12, as far as end-of-day data allows), per candidate and index

1. At least 180 trades.
2. Day-block bootstrap 95% CI above zero per trade and per session.
3. Profit factor ≥ 1.3.
4. Net P&L > 0 in every calendar year with at least 20 trades.
5. ±20% robustness (the protocol's criterion 8): at least 80% of the perturbations net > 0, and the worst no lower than base − 50% × |base|.
6. Multiple testing:
   - Bonferroni: the larger of the per-trade and per-session bootstrap p-values must be below 0.05 / N, where N is the number of lines in `reports/trials.jsonl` after this study's lines are appended.
   - Deflated Sharpe ratio (Bailey & López de Prado 2014) on net P&L per session ÷ ₹5 lakh ≥ 0.95, with N from the ledger and V[SR] from this study's own variants (same data). The 1/(T−1) null variance is also reported.
- **Not testable on end-of-day data, so marked N/A:**
  - the random-entry placebo (a rule that trades every session *is* the unconditional benchmark);
  - the copy delay (2× spread is the proxy);
  - intraday entry times, stops and the real fill at the first print;
  - the independent look-ahead review.

### 1.8 Pre-registered candidates for a paper test

| id | rule |
|---|---|
| C1 | Intraday short iron fly, convention B, wings ±1 EM, all usable sessions except the event days of §1.6 |
| C2 | C1 with wings ±2 EM |
| C3 | Hold-to-expiry short iron condor: short ±1 EM_N, long ±2 EM_N, N = 2, skipped when an event day of §1.6 falls in the holding window |

- **Robustness sets:**
  - C1 and C2: wings ×0.8 and ×1.2; entry at the day's VWAP instead of the open; 2× spread; convention A.
  - C3: N = 1 and N = 4; short strikes ×0.8 and ×1.2; wings ×0.8 and ×1.2; 2× spread.
- **The naked straddle and strangle** are measured (Q1, Q3) but are not candidates: the brief asks for a defined-risk rule.
- **Verdict:**
  - **Worth a paper test:** a candidate passes every testable criterion on an index.
  - **Untestable without intraday option quotes:** the sign depends on the opening print. In that case open→close is positive but entry at the day VWAP, or a close→close hold, is not.
  - **Not worth it:** otherwise.

---

## 2. What changed after the freeze (implementation only)

1. **Settlement levels for 51 early NIFTY expiries.**
   - NSE's legacy files of Feb 2019 – Jan 2020 print `SETTLE_PR = 0` on expiring options, so the first run silently dropped those expiry days from convention A and from hold-to-expiry.
   - By exchange rule, an index option's final settlement price is the index's official close on expiry day. On every other expiry (349 NIFTY, 176 SENSEX) the printed level and the official close agree within 0.2%.
   - The official close is therefore used for those 51 expiries. This changed results: NIFTY hold-to-expiry went from 348 to 399 trades, and the strangle at N = 2 from +₹543 to +₹636 a week.
2. **Sessions to expiry are counted on NSE's calendar for both indices.** BSE's archive misses five trading days (2024-08-02, 2024-08-29, 2024-11-29, 2025-02-10, 2025-09-02), which made a few SENSEX days look like DTE 0 under convention B. This changed labels only.
3. **Data location.** The brief points to `research/q1/dl_nse` and `dl_bse`. Those hold 2024-01 → 2026-10 only, so the 2019–2023 NSE files come from WP6's compact cache. That cache was built from the same exchange archives and already includes those zips, and it was copied read-only to the scratchpad.
   - Index opens and closes and India VIX come from the 10-year Yahoo daily series in that cache (`index-daily.json`).
   - The hourly bars (`dl/y1h`) and `why/hist.json` were not needed: index paths cannot price the options.
4. **Added after the first look (reports, not rules).** These cannot change a verdict:
   - the ATM-print diagnostics (§3.4);
   - the worst mark-to-market at an interim close for hold-to-expiry trades;
   - the named stress weeks;
   - the "since 2025" table (§6).
5. **Runs and the ledger.**
   - Three development runs computed the same 90 variants, with bug fixes only (items 1–2). The final run appended one line per variant to `reports/trials.jsonl`: 90 lines (30 strategy, 60 perturbation), taking the ledger from 1,562 to 1,652.
   - Reruns are idempotent: a variant already logged is not counted again.
   - The descriptive breakdown cells (§3–§5) select nothing. Any rule built from one of them is a new trial and must be judged on new data.
6. **Two data facts worth knowing.**
   - Convention B has no trade on 12 Mar 2020: its ATM strike (10050, a 50-point strike) had no put trades that day.
   - The 13 Mar 2020 iron flies were dropped by the screen, correctly:
     - The ±1 EM call wing's first print (₹499.55) came after the circuit-breaker halt and sits above the ATM call's first print (₹204.55).
     - The ±2 EM put wing traded only 190 contracts.
     - Whatever the real fill, a ±1 EM fly could not have lost more than its width × lot (≈ ₹19k) that day.

---

## 3. Q1: intraday short ATM straddle (open → close)

### 3.1 Headline

Net of dated charges and the engine's spread; one lot at the lot in force; 95% CIs from 100,000 day-block resamples.

| variant | index | trades | net % of premium (95% CI) | ₹ per lot (95% CI) | hit | PF |
|---|---|---|---|---|---|---|
| **A: current weekly** (0DTE on expiry day) | NIFTY | 1,884 | **+2.9%** (+1.1 … +4.7) | +442 (+253 … +626) | 65% | 1.39 |
| | SENSEX | 824 | **+6.2%** (+3.4 … +8.9) | +864 (+595 … +1,131) | 69% | 1.91 |
| **B: never the expiring contract** | NIFTY | 1,882 | **+1.7%** (+0.6 … +2.7) | +412 (+249 … +571) | 66% | 1.44 |
| | SENSEX | 822 | **+4.1%** (+2.5 … +5.6) | +772 (+546 … +994) | 68% | 2.03 |
| A, 2× spread | NIFTY | 1,884 | +2.6% (+0.7 … +4.4) | +393 | 65% | 1.34 |
| | SENSEX | 824 | +5.8% (+3.0 … +8.6) | +818 | 68% | 1.85 |
| B, 2× spread | NIFTY | 1,882 | +1.3% (+0.2 … +2.3) | +350 | 65% | 1.37 |
| | SENSEX | 822 | +3.7% (+2.1 … +5.2) | +713 | 67% | 1.92 |
| A, entered at the day's VWAP | NIFTY | 1,837 | **−4.7%** (−6.3 … −3.2) | −477 (−588 … −370) | 53% | 0.50 |
| | SENSEX | 824 | **−13.2%** (−16.3 … −10.1) | −1,053 | 44% | 0.23 |
| B, entered at the day's VWAP | NIFTY | 1,840 | **−2.9%** (−3.6 … −2.3) | −376 (−466 … −290) | 53% | 0.51 |
| | SENSEX | 822 | **−6.4%** (−7.8 … −5.1) | −759 | 45% | 0.26 |
| close → next close (B; one night and one day; both prices averaged) | NIFTY | 1,886 | +0.7% (−1.2 … +2.6) | +74 (−147 … +288) | 64% | 1.05 |
| | SENSEX | 819 | +0.5% (−2.8 … +3.6) | +66 (−281 … +398) | 62% | 1.05 |
| B, only days whose ATM opening prints are within 0.5% of the index open | NIFTY | 1,819 | +1.4% (+0.4 … +2.5) | +342 | 66% | 1.38 |
| | SENSEX | 766 | +3.8% (+2.2 … +5.4) | +703 | 68% | 1.98 |

**Cross-check and costs.**
- B reproduces WP6's numbers: short net of charges and the engine spread, +1.66% (NIFTY) and +4.07% (SENSEX).
- Premium sold averages ₹15,059 per NIFTY lot and ₹15,038 per SENSEX lot.
- Charges are about ₹122 a lot and the modelled spread about ₹60, together about 1.2% of the premium.

**The two decisive rows are VWAP entry and close→close.**
- Day VWAP → close is a shorter hold than open → close, so it captures less decay. Even so, it flips the sign: the seller loses on average from the middle of the day to the close.
- Close → close uses two averaged prices (the 30-minute closing VWAPs) and adds the night. On both indices it is not distinguishable from zero.
- The open→close profit is therefore the premium in the opening prints (§3.4).

### 3.2 The tail

| per lot | NIFTY A | NIFTY B | SENSEX A | SENSEX B |
|---|---|---|---|---|
| worst day | −₹41,362 (13 Mar 2020; index +9.3% from a circuit-hit open) | −₹41,362 (same) | −₹21,908 (19 Feb 2026) | −₹21,767 (12 May 2025) |
| worst 5-session run | −₹84,678 (12–18 Mar 2020) | −₹61,666 (same) | −₹30,015 (7–13 May 2025) | −₹27,712 (same) |
| worst 20-session run | −₹92,577 (24 Feb – 23 Mar 2020) | −₹73,287 (same) | −₹19,549 | −₹13,830 |
| maximum drawdown | ₹1,25,689 (15 Apr 2019 → 24 Mar 2020) | ₹1,01,240 (13 Jun 2019 → 24 Mar 2020) | ₹31,572 (6–15 May 2025) | ₹29,269 (same) |
| worst 5% of days, summed | −₹10.37 lakh = **1.25×** the total net (+₹8.33 lakh) | −₹8.89 lakh = 1.15× | −₹4.01 lakh = 0.56× | −₹3.23 lakh = 0.51× |

**The 12 worst NIFTY days (A).**

| date | ₹ per lot | % of premium | index, open→close |
|---|---|---|---|
| 13 Mar 2020 | −41,362 | | +9.3% |
| 20 Sep 2019 (the corporate-tax-cut day) | −28,794 | | +4.9% |
| 4 Jun 2024 (election result) | −25,817 | −229% | −5.6% |
| 12 May 2025 | −25,313 | | +2.1% |
| 12 Mar 2020 | −23,012 | | −4.5% |
| 17 Apr 2025 | −22,899 | | +1.9% |
| 15 Sep 2026 | −21,819 | | −1.9% |

- They also include 31 Aug 2020, 18 Mar 2020, 21 Dec 2020, 20 Jan 2026 and 16 Jun 2022.
- Four of the twelve came from moves of only 1.4–2.1%. Three of those were on the contract's expiry day, where such a move costs two to three times the premium.

**SENSEX's worst days** were 19 Feb 2026, 12 May 2025, 8 Jul 2026 and 4 Jun 2024 (−₹19,418, −74%).

**Tail measured on the ₹5 lakh account at one NIFTY lot:**

| measure | % of capital |
|---|---|
| worst day | 8% |
| worst 20-session run | 19% |
| maximum drawdown | 25% |

### 3.3 Breakdowns (convention A)

Each cell gives net % of premium and ₹ per lot, with the 95% CI and the trade count in brackets.

| subset | NIFTY | SENSEX |
|---|---|---|
| **expiry day (DTE 0)** | **+9.2%**, ₹971 (+427 … +1,489; 400) | **+13.8%**, ₹1,427 (+585 … +2,257; 175) |
| DTE 1 | +4.2%, ₹620 (+288 … +940; 399) | +3.8%, ₹665 (+33 … +1,256; 173) |
| DTE 2–5 | +0.2%, ₹182 (−51 … +405; 1,085) | +4.2%, ₹730 (+465 … +995; 476) |
| VIX low third | +2.2%, ₹276 (+47 … +496; 725) | +4.7%, ₹541 (+207 … +855; 315) |
| VIX middle third | +2.5%, ₹332 (+27 … +627; 599) | +5.7%, ₹760 (+258 … +1,229; 213) |
| VIX top third | +4.5%, ₹774 (+331 … +1,224; 560) | +8.1%, ₹1,284 (+725 … +1,849; 296) |
| Budget day | +19.3%, ₹2,993 (7 days) | +44%, ₹5,980 (2) |
| RBI day | +3.8%, ₹659 (−628 … +2,053; 44) | +1.8%, ₹16 (−1,699 … +1,518; 21) |
| election-result day | 2019: +₹10,302; 2024: −₹25,817 | 2024: −₹19,418 |
| session before an RBI day | +21.3%, ₹1,671 (+912 … +2,426; 44) | +19.4%, ₹2,487 (21) |
| gap < 0.25% | +2.7%, ₹443 (+206 … +681; 845) | +6.8%, ₹832 (450) |
| gap 0.25–0.5% | +4.8%, ₹660 (527) | +8.0%, ₹1,033 (219) |
| gap 0.5–1% | +1.9%, ₹342 (−61 … +723; 366) | +2.3%, ₹687 (−58 … +1,416; 111) |
| gap ≥ 1% | −0.0%, −₹190 (−1,504 … +1,066; 142) | +2.8%, ₹1,149 (−1,188 … +3,510; 40) |

**By year (A):**

| year | NIFTY | SENSEX |
|---|---|---|
| 2019 | −1.4% (−₹42) | |
| 2020 | +3.1% | |
| 2021 | +4.6% | |
| 2022 | +1.7% | |
| 2023 | +1.2% | +5.9% |
| 2024 | +2.8% | +5.5% |
| 2025 | +5.8% | +6.2% |
| 2026 | +5.8% | +7.1% |

- **Convention B by year:**
  - NIFTY: 8 of 8 years positive in ₹, though 2019 and 2022 are negative in % of premium.
  - SENSEX: 4 of 4 years positive.
- **What the breakdowns say:**
  - The premium per trade is largest on the contract's last day: +9–14% of premium.
  - It is also larger when VIX is in its top third and on small-gap days.
  - Big-gap days (≥ 1%) are flat or worse.
- **These are descriptive only.**
  - "Session before an RBI day" is striking. But it is 21–44 trades, and on NIFTY it is confounded with Thursday expiries: RBI often announced on a Friday.
  - None of these cells was used to pick a rule.

### 3.4 Where the profit comes from: the opening print (diagnostics, not rules)

**Opening richness**, measured as the straddle at the first prints ÷ the same straddle at the day's VWAPs − 1. Both diagnostics use information from later in the day.

| | NIFTY | SENSEX |
|---|---|---|
| median, convention B | +7.9% | +11.3% |
| share of days above zero | 77% | 84% |
| median, convention A (includes 0DTE) | +10.1% | +14.8% |

**Open→close P&L by tercile of that richness (B):**

| tercile of opening richness | NIFTY | SENSEX |
|---|---|---|
| low third | −13.4% of premium (PF 0.11) | −10.2% |
| middle third | +5.2% | +5.4% |
| top third | +16.3% | +16.9% |

**By how consistent the ATM opening prints are with the index open (B).** The measure is |the parity forward implied by the two first prints ÷ (index open + the previous close's basis) − 1|.

| consistency of the ATM opening prints | NIFTY | SENSEX |
|---|---|---|
| < 0.1% (832 / 331 days) | +2.2%, ₹453 (+254 … +650) | +3.3%, ₹701 (+410 … +981) |
| 0.1–0.25% | +1.2%, ₹293 | +3.9%, ₹658 |
| 0.25–0.5% | −0.2%, ₹135 | +4.7%, ₹803 |
| ≥ 0.5% (59 / 47 days) | +7.4%, ₹2,349 | +10.2%, ₹2,139 |

**Reading.**
- The profit is not mainly a product of garbled prints: the most consistent days still earn.
- It is the premium in the first trades of the day. Some of that is genuine:
  - India VIX makes its daily high in the first hour on 61% of sessions (Q1).
  - Implied volatility bleeds out through the morning.
- Some of it is microstructure: first trades in a thin book, at whichever side of a wide 09:15 spread was hit.
- The days whose opening prints are least consistent (≥ 0.5%) carry the largest profits.
- End-of-day files cannot separate the genuine part from the microstructure. That takes quotes.

---

## 4. Q2: the defined-risk version, short iron fly

### 4.1 Usable days and why the others were dropped (convention B)

| | NIFTY ±1 EM | NIFTY ±2 EM | SENSEX ±1 EM | SENSEX ±2 EM |
|---|---|---|---|---|
| sessions | 1,884 | 1,884 | 830 | 830 |
| **usable** | **1,802 (95.6%)** | **1,862 (98.8%)** | **720 (86.7%)** | **746 (89.9%)** |
| S1 a leg did not trade | 2 | 2 | 10 | 16 |
| bad print (WP6) | 2 | 4 | 4 | 4 |
| S2 thin wing (< 500 contracts) | 3 | 7 | 26 | 56 |
| S3 opening fly value ≥ its width | 63 | 3 | 57 | 3 |
| S3 a vertical outside [0, width] | 12 | 1 | 13 | 4 |
| S4 wing IV more than 2× off the ATM's | 0 | 5 | 0 | 1 |

**Why so few S4 drops.** The calibration before the freeze showed liquid NIFTY wings' opening IVs within 20% of the synchronous estimate on 90% of days (p99 ≈ 47%). The factor-of-2 band therefore catches only gross staleness.

**S3 is the screen that matters** for the ±1 EM fly. There, the four first prints imply a fly worth more than its maximum payoff. These are the days the straddle's opening prints were richest:

| days (B) | NIFTY straddle | SENSEX straddle |
|---|---|---|
| kept by the ±1 EM screen | +1.4% (1,802 days) | +3.3% (720) |
| dropped by the ±1 EM screen | **+7.9%** (80 days, ₹2,563 a day) | **+9.2%** (102 days) |
| kept by the ±2 EM screen | +1.6% | +4.4% |
| dropped by the ±2 EM screen | +4.5% (20) | +0.8% (76) |

- The screen does not hide losing straddle days. The dropped days were more profitable for the straddle, not less.
- One dropped day is 13 Mar 2020 (see §2.6).

### 4.2 Results

| variant | index | trades | net % of premium (95% CI) | ₹ per lot (95% CI) | hit | PF | worst day (₹) | largest defined max loss (₹) |
|---|---|---|---|---|---|---|---|---|
| ±1 EM, B | NIFTY | 1,802 | **−3.3%** (−3.8 … −2.8) | −362 (−430 … −294) | 41% | 0.48 | −10,474 | 16,676 |
| | SENSEX | 720 | **−2.3%** (−3.2 … −1.5) | −223 (−337 … −113) | 45% | 0.64 | −12,312 | 15,397 |
| ±1 EM, A (incl. 0DTE) | NIFTY | 1,827 | −2.5% (−3.8 … −1.3) | −208 | 45% | 0.76 | −12,514 | 16,676 |
| | SENSEX | 763 | −0.9% (−2.9 … +1.0) | −41 | 50% | 0.95 | −12,312 | 15,397 |
| ±2 EM, B | NIFTY | 1,862 | **−1.6%** (−2.4 … −0.9) | −102 (−208 … +2) | 54% | 0.87 | −19,431 | 35,443 |
| | SENSEX | 746 | **+0.2%** (−1.1 … +1.5) | +205 (+29 … +380) | 60% | 1.29 | −20,194 | 32,097 |
| ±2 EM, A (incl. 0DTE) | NIFTY | 1,862 | −0.4% (−2.0 … +1.3) | +44 (−102 … +189) | 57% | 1.04 | −23,404 | 39,360 |
| | SENSEX | 780 | +2.3% (−0.4 … +4.9) | +351 (+117 … +584) | 62% | 1.38 | −20,194 | 32,786 |
| ±1 EM, close → close | NIFTY | 1,883 | −2.8% (−3.8 … −1.7) | −300 | 39% | 0.59 | −11,102 | 15,566 |
| | SENSEX | 795 | −2.3% (−4.0 … −0.7) | −271 | 36% | 0.64 | −9,496 | 11,207 |
| ±2 EM, close → close | NIFTY | 1,875 | −1.8% (−3.4 … −0.2) | −206 | 54% | 0.81 | −22,440 | 37,012 |
| | SENSEX | 750 | −2.1% (−5.0 … +0.8) | −219 | 53% | 0.82 | −23,404 | 30,112 |
| B, screen S1 + S3 only (no S2, S4) | NIFTY ±1 / ±2 | 1,803 / 1,874 | −3.3% / −1.6% | −363 / −94 | | 0.48 / 0.89 | | |
| | SENSEX ±1 / ±2 | 741 / 801 | −2.4% / −0.2% | −222 / +166 | | 0.64 / 1.23 | | |

**The cap.**
- The worst fly day is −₹10.5k (±1 EM) to −₹20.2k (±2 EM) per lot, against −₹41.4k for the naked straddle.
- The most a fly could lose on any day is its width × lot minus the credit plus costs: ≈ ₹15–17k (±1 EM) and ≈ ₹32–39k (±2 EM) at the largest.

**Maximum drawdown per lot.** The ±1 EM fly bleeds steadily rather than crashing:

| | ±1 EM, B | ±2 EM, B |
|---|---|---|
| NIFTY | ₹6.67 lakh (Apr 2019 → Apr 2026) | ₹2.84 lakh |
| SENSEX | ₹1.63 lakh | ₹29,897 |

**By year for the candidates C1 and C2 (convention B, event days skipped), ₹ per lot per trade:**

| year | NIFTY ±1 EM | NIFTY ±2 EM | SENSEX ±1 EM | SENSEX ±2 EM |
|---|---|---|---|---|
| 2019 | −398 | −137 | | |
| 2020 | −257 | −9 | | |
| 2021 | −440 | −3 | | |
| 2022 | −762 | −531 | | |
| 2023 | −403 | −237 | −321 | −15 |
| 2024 | −155 | −126 | −131 | +116 |
| 2025 | −179 | +124 | −188 | +317 |
| 2026 | −218 | +259 | −332 | +279 |

**Where the money goes.** Comparing ±1 EM fly days with straddle days, per NIFTY lot:
- The two long wings lose about ₹640 a day before costs: they are bought at the same rich opening prints and sold at the closing VWAP.
- The four extra orders cost about ₹130 more in charges and spread.
- Together that is more than the straddle's +₹412 net. On SENSEX the wings lose about ₹860 a day.
- Wider wings cost less, which is why ±2 EM is near flat. But the wider the wing, the less risk it removes.

**Verdict on Q2: not worth it.**
- The one positive cell, SENSEX ±2 EM, is +0.2% of premium (₹ +205). It fails PF ≥ 1.3, loses in 2023, and turns into −8.8% of premium when entered at the day's VWAP.

---

## 5. Q3: hold to expiry (closes and the final settlement)

### 5.1 Results

The strangle is ±1 EM_N; the condor adds long wings at ±2 EM_N. One trade per weekly expiry, entered at the closing VWAP N sessions before it.

| variant | index | trades | net % of premium (95% CI) | ₹ per lot (95% CI) | hit | PF | worst week (₹) | worst interim mark (₹) |
|---|---|---|---|---|---|---|---|---|
| strangle N = 1 | NIFTY | 399 | +31.1% (+8.4 … +50.6) | **+620** (+197 … +988) | 86% | 1.82 | −46,369 (12 Mar 2020) | — |
| | SENSEX | 176 | +7.3% (−25.2 … +36.8) | +415 (−219 … +988) | 82% | 1.39 | −29,072 (19 Mar 2026) | — |
| strangle N = 2 | NIFTY | 399 | +33.3% (+16.5 … +48.5) | **+636** (+138 … +1,097) | 83% | 1.56 | −38,068 (12 Mar 2020) | −8,440 |
| | SENSEX | 175 | +25.2% (−5.3 … +51.0) | **+674** (+62 … +1,237) | 81% | 1.63 | −16,351 (4 Oct 2024) | −26,337 |
| strangle N = 4 | NIFTY | 396 | +2.3% (−23.8 … +25.9) | +185 (−746 … +1,019) | 80% | 1.08 | **−92,969** (12 Mar 2020) | −46,140 |
| | SENSEX | 170 | +24.1% (−5.1 … +49.8) | **+938** (+2 … +1,816) | 79% | 1.56 | −26,259 (4 Oct 2024) | −38,854 |
| condor N = 1 | NIFTY | 399 | +8.4% (−7.3 … +22.7) | +234 (−27 … +476) | 84% | 1.36 | −16,502 (17 Apr 2025) | — |
| | SENSEX | 173 | −6.2% (−33.2 … +18.4) | +116 (−353 … +552) | 81% | 1.13 | −15,934 | — |
| condor N = 2 | NIFTY | 397 | +5.5% (−10.2 … +20.3) | +43 (−362 … +423) | 82% | 1.04 | −22,007 (30 Mar 2026) | −6,757 |
| | SENSEX | 168 | +5.0% (−20.0 … +26.8) | +136 (−463 … +678) | 77% | 1.12 | −18,717 (15 Apr 2025) | −20,820 |
| condor N = 4 | NIFTY | 385 | −6.5% (−25.3 … +10.7) | −133 (−783 … +478) | 78% | 0.93 | −37,500 (19 Mar 2020) | −31,474 |
| | SENSEX | 152 | +5.9% (−17.8 … +27.7) | +263 (−611 … +1,076) | 78% | 1.15 | −19,337 | −27,307 |
| **C3** (condor N = 2, no event weeks) | NIFTY | 375 | +3.9% (−12.5 … +19.6) | **−25** (−448 … +371) | 82% | 0.98 | −22,007 | −6,757 |
| | SENSEX | 154 | +6.4% (−20.6 … +29.4) | **+258** (−350 … +806) | 79% | 1.24 | −18,717 | −20,820 |

**Notes on the table.**
- "Worst interim mark" is the worst mark-to-market, before costs, at a close between entry and settlement. It is what a margin call sees: a position can recover by settlement and still have forced an exit on the way.
- % of premium and ₹ per lot can differ in sign. A strangle's premium is small (₹1,800–3,500 a lot), so single weeks swing the percentage by thousands of percent, and the ₹ figure weights the larger recent lots.
- The robustness rows are in §8.

**Reading.**
- Selling the last one or two sessions of a weekly 1 EM out, and holding to settlement, is the cleanest positive result in the study. It uses only closing VWAPs and the settlement price.
- But the defined-risk version has no edge: wings at 2 EM cost what the strangle earns.
- And the naked version's tail is what SEBI's ₹51.7-lakh average loss for losing sellers looks like in miniature:

| naked NIFTY strangle | worst week | ×7.6-year net |
|---|---|---|
| N = 1 | −₹46,369 | |
| N = 4 | −₹92,969 | |
| worst 5% of N = 4 weeks, summed | −₹5.76 lakh | **7.9×** |

### 5.2 The worst weeks

**NIFTY, the five worst of each:**

| N | entry → expiry | ₹ per lot | index move |
|---|---|---|---|
| 1 | 11 → 12 Mar 2020 | −46,369 | −8.3% |
| 1 | 23 → 24 Feb 2022 (invasion of Ukraine) | −26,482 | −4.9% |
| 1 | 2 → 3 Feb 2026 | −24,737 | +2.6% |
| 1 | 16 → 17 Apr 2025 | −15,674 | +2.0% |
| 1 | 23 → 24 Sep 2020 | −13,421 | −3.1% |
| 2 | 9 → 12 Mar 2020 | −38,068 | −8.5% |
| 2 | 1 → 3 Feb 2026 (Budget Sunday) | −32,906 | +3.8% |
| 2 | 8 → 12 May 2026 | −26,530 | −3.5% |
| 2 | 26 Feb → 2 Mar 2026 | −17,957 | −2.5% |
| 2 | 22 → 24 Feb 2022 | −17,711 | −4.8% |
| 4 | 5 → 12 Mar 2020 | −92,969 | −14.7% |
| 4 | 13 → 19 Mar 2020 | −54,587 | −16.6% |
| 4 | 29 Jan → 4 Feb 2021 (Budget week) | −48,948 | +8.9% |
| 4 | 9 → 17 Apr 2025 | −45,310 | +6.3% |
| 4 | 18 → 24 Sep 2020 | −30,474 | −6.2% |

**Named stress weeks, ₹ per lot.** Each figure is the result at settlement. Where an interim close was worse, that mark is given in brackets.

| week (expiry) | strangle N = 1 | N = 2 | N = 4 | condor N = 2 | condor N = 4 |
|---|---|---|---|---|---|
| March 2020 crash (12 Mar) | −46,369 | −38,068 | −92,969 | −17,907 | −19,175 |
| March 2020 rebound (26 Mar) | +8,238 | −789 | +18,298 (−27,007) | −8,144 | +11,729 (−14,839) |
| Budget 2021 (4 Feb) | +1,869 | +2,691 | −48,948 (−40,871) | +1,882 | −26,076 |
| Ukraine invasion (24 Feb 2022) | −26,482 | −17,711 | −23,066 | −18,301 | −21,741 |
| **Election result, 4 Jun 2024** (6 Jun expiry) | +2,966 | −7,108 | +8,431 | −9,566 | +6,731 |
| Tariff crash, 7 Apr 2025 (9 Apr) | +9,492 | +19,732 | −28,733 (−46,140) | +10,368 | −25,946 |
| India–Pakistan ceasefire rally, 12 May 2025 (15 May) | −9,362 | −3,976 | −22,020 | −5,145 | −25,836 |
| Budget 2026 (3 Feb) | −24,737 | −32,906 | +6,195 | −14,541 | +4,270 |

- **The election week shows path dependence.**
  - The N = 4 strangle entered on 31 May 2024 settled +₹8,431, because the index ended the week +0.9% after −5.9% on the 4th.
  - The N = 2 entry at the close of the 4th lost −₹7,108 on the next two days' +4.8% rebound.
- **SENSEX:**
  - The worst weeks were 4 Oct 2024 (−₹16,351 at N = 2; −₹26,259 at N = 4) and 19 Mar 2026 (−₹29,072 at N = 1).
  - The election week (7 Jun 2024 expiry) gave −₹6,086 / −₹6,071 / +₹10,069 at N = 1 / 2 / 4, with an interim mark of −₹21,197 at N = 4.

### 5.3 By year, ₹ per lot per week

| year | NIFTY strangle N=1 | NIFTY strangle N=2 | NIFTY condor N=1 | NIFTY C3 | SENSEX strangle N=2 | SENSEX C3 |
|---|---|---|---|---|---|---|
| 2019 | +748 | +1,308 | +199 | +616 | | |
| 2020 | −229 | +694 | −132 | +165 | | |
| 2021 | +1,045 | +699 | +553 | +52 | | |
| 2022 | +273 | +77 | +107 | −497 | | |
| 2023 | +494 | +192 | +191 | −256 | +57 | −113 |
| 2024 | +457 | +578 | +246 | +63 | +380 | +64 |
| 2025 | +1,311 | +1,199 | +501 | +23 | +1,198 | +523 |
| 2026 | +957 | +331 | +193 | −328 | +869 | +374 |

**VIX tercile.**
- The NIFTY strangle at N = 1 earned most per rupee of premium in the low-VIX third: +₹692 a week (CI +₹423 … +₹935), PF 3.18.
- The top third carried the worst week.
- This is descriptive only; it is not a rule.

---

## 6. Q4: margin and return on capital

**Sources (public, dated; no scraping):**

| source (date) | what it gives |
|---|---|
| Bajaj Broking, "Nifty Strategy: Short Straddle for 23rd September Expiry" (22 Sep 2025) | 1 lot of the NIFTY 25,300 straddle (lot 75): margin "around ₹2,00,000", about 10.5% of one leg's notional |
| TradingQnA, "Is it stupid to do an Iron Butterfly over a Short Straddle just for the margin benefit?" (29 Jan 2026) | "2.5 lakhs/lot vs 1 lakh/lot" for a short straddle against the same straddle hedged with wings 6–8 strikes out |
| Zerodha Z-Connect, "New margin framework for F&O trades" (30 May 2020) | Hedged positions need 60–70% less than naked ones. A 100-point NIFTY call spread (lot 75) needs SPAN ₹7,437 (≈ its maximum loss) + exposure ₹14,370 (2% of the short leg's notional) |
| SEBI circular of 1 Oct 2024, "Measures to strengthen equity index derivatives framework", as summarised by ICRA (Oct 2024) and DSK Legal (Nov 2024) | +2% extreme-loss margin on short options expiring that day, from 20 Nov 2024 |

**Approximation used here.**
- A hedged structure needs about its widest wing × lot (SPAN) plus 2% of each short leg's notional (exposure). Add another 2% per short leg if held into its expiry day.
- A naked ATM straddle needs 10.5–15% of one leg's notional, the range of the two public quotes.
- Today's inputs: NIFTY ≈ 22,600 × 65 = ₹14.7 lakh per leg; SENSEX ≈ 72,700 × 20 = ₹14.5 lakh; VIX ≈ 14.8.

| structure | margin per lot (NIFTY ≈ SENSEX) | return on margin, 2025-01 → 2026-10, annualised (net ₹ per lot per year ÷ margin) |
|---|---|---|
| naked ATM straddle (B) | ₹1.5–2.2 lakh | NIFTY +₹2.21 lakh/yr → **100–145%**; SENSEX +₹2.47 lakh/yr → 110–160%. **Only at first-print fills**: at the day's VWAP the same trade loses. |
| iron fly ±1 EM (C1) | ≈ ₹0.72 lakh (13k SPAN + 59k exposure) | NIFTY −₹45,932/yr → **−64%**; SENSEX −₹56,298/yr → −78% |
| iron fly ±2 EM (C2) | ≈ ₹0.85 lakh | NIFTY +₹43,911/yr → +52%, but negative in every year 2019–2024; SENSEX +₹71,496/yr → +83% |
| iron condor N = 2 (C3), into expiry day | ≈ ₹0.78 lakh, ₹1.37 lakh on expiry day | NIFTY −₹6,779/yr → −5%; SENSEX +₹22,449/yr → +16% |
| naked strangle N = 1, into expiry day | ≈ the straddle's, plus ₹0.59 lakh on expiry day (no direct source) | NIFTY +₹61,207/yr → ≈ 24–32% |

**The ₹5 lakh paper account at one lot.**
- **Iron fly:** one lot of either index uses about 15% of capital, both together about 30%. Convention B never holds the expiring contract, so the expiry-day surcharge does not apply. The worst fly day was 2–4% of capital.
- **Naked straddle:** one lot uses 30–45% of capital, both indices 60–90%. Its worst day was 8% of capital, and its maximum drawdown 25% (NIFTY, 2019–20).
- **Hold-to-expiry condor:** about 16% of capital, 27% on expiry day. Its worst week was 4.4%.

These are margins, not risk. One naked lot of the strangle at N = 4 lost 19% of the account in one week of March 2020.

---

## 7. What end-of-day data cannot test, and what intraday quotes would add

**Cannot be tested with these files:**

1. **Whether the first print is a price a seller gets.** The whole intraday result rests on it (§3.4). The bhavcopy OPEN is the first trade at or after 09:15. It may have been a buyer lifting the offer, or a stale quote, and the opening spread is unknown. The engine's 0.4% spread is a guess for 09:15; a full 2–3% spread at the open would erase NIFTY's +1.7%.
2. **Any other entry time.** Examples are 09:30 after the first candle, 10:15 after the first hour, 11:15 (the plan's N3 window), or 14:00. The day VWAP is a crude stand-in, and it loses.
3. **Intraday stops and targets.** Examples are stopping a fly at 2× the credit, an index-level stop, or a time stop. Each leg's high and low are not synchronous, so no path can be rebuilt.
4. **The synchronous value of a four-leg structure at any moment.** S1–S4 can only reject impossible prints; they cannot reconstruct the real fill.
5. **Expiry-day intraday dynamics** (gamma, settlement games) and the closing auction since 3 Aug 2026.
6. **The copy delay of a few minutes**, intraday margin calls and peak-margin snapshots.
7. **A placebo.** It is meaningless for a rule that trades every day.

**What intraday quotes would add.**
- Synchronous bid/ask on the ATM ±2.5 EM strikes of the current and next weekly, at fixed times (09:15:30, 09:16, 09:20, 09:30, 10:15, 11:15, 14:15, 15:10, 15:25), turn every result here into a fill.
- They would answer, in order:
  - Is the opening premium sellable at the bid?
  - Does a later entry (09:30–11:15) keep any of the premium?
  - What does a 2× credit stop do to the fly's tail and to its mean?
  - What does a real four-leg fly cost to open?
- Two sources:
  - **The broker's historical 1-minute candles.** Groww's API serves F&O candles from 2020 (docs/RESEARCH.md). They are trades, not quotes, but they allow entries at 09:16–11:15 and minute-level stops over several years, if expired weekly contracts are covered. That is the cheaper first check.
  - **Recording quotes from the paper feed.**

---

## 8. Q5: robustness, multiple testing and the bar

**The ledger.**
- 90 WP10 lines were appended (`wp: "WP10"`): 30 strategy and 60 perturbation, each with trades, net ₹, mean per trade and Sharpe ratio per session.
- N = 1,652, so the Bonferroni level is 0.05 / 1,652 = 3.0 × 10⁻⁵. The bootstrap uses 100,000 resamples, so its p-value floor is 1.0 × 10⁻⁵.

**The deflated Sharpe ratio.**
- V[SR] across this study's 90 variants is 0.033, which gives SR₀ = 0.61 per session. The variants deliberately include structures that lose (VWAP entries), so this benchmark is very harsh.
- With the null variance 1/(T−1), SR₀ is 0.078 (NIFTY, daily), 0.118 (SENSEX, daily), 0.17 (NIFTY, weekly) and 0.26 (SENSEX, weekly).
- No candidate's verdict depends on which is used.

### 8.1 The pre-registered candidates

| criterion | NIFTY C1 | SENSEX C1 | NIFTY C2 | SENSEX C2 | NIFTY C3 | SENSEX C3 |
|---|---|---|---|---|---|---|
| ≥ 180 trades | pass (1,751) | pass (699) | pass (1,809) | pass (727) | pass (375) | **insufficient (154)** |
| CI > 0 per trade and per session | fail (−₹422 … −₹286) | fail (−₹342 … −₹114) | fail (−₹197 … +₹14) | pass (+₹26 … +₹384; per session +₹23 … +₹336) | fail (−₹448 … +₹371) | fail (−₹350 … +₹806) |
| PF ≥ 1.3 | fail (0.49) | fail (0.64) | fail (0.89) | **fail (1.29)** | fail (0.98) | fail (1.24) |
| net > 0 in every year | fail (0 of 8) | fail (0 of 4) | fail (2 of 8) | fail (2023: −₹1,403) | fail (2022, 2023, 2026) | fail (2023) |
| ±20% robustness | fail (0 of 5 positive) | fail (0 of 5) | fail (2 of 5) | fail (4 of 5; VWAP entry −₹7.6 lakh vs +₹1.5 lakh) | fail (3 of 7; N = 4 −₹83,941) | fail (7 of 7 positive, but wings ×0.8 nets ₹10,225, below base − 50% = ₹19,883) |
| Bonferroni (p < 3.0 × 10⁻⁵) | fail (p 1.0) | fail (1.0) | fail (0.96) | fail (0.013) | fail (0.54) | fail (0.19) |
| DSR ≥ 0.95 (variants / null variance) | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.14 | 0.00 / 0.00 | 0.00 / 0.01 |
| placebo, copy delay, intraday timing, look-ahead | N/A (§7) | N/A | N/A | N/A | N/A | N/A |
| **verdict** | **FAIL** | **FAIL** | **FAIL** | **FAIL** | **FAIL** | **FAIL** |

**Robustness rows (net ₹ per trade per lot).**

| | NIFTY | SENSEX |
|---|---|---|
| **C1** | base −354; wings ×0.8 −489, ×1.2 −284; VWAP entry −812; 2× spread −442; convention A −211 | base −226; −368 / −74; −1,130; −313; −39 |
| **C2** | base −92; wings ×0.8 −162, ×1.2 +8; VWAP entry −679; 2× spread −167; convention A +48 | base +206; +70 / +297; −1,050; +132; +364 |
| **C3** | base −25; N = 1 +204, N = 4 −241; short ×0.8 +18, ×1.2 −13; wings ×0.8 −84, ×1.2 +84; 2× spread −34 | base +258; +141, +146; +215, +227; +66, +400; +251 |

### 8.2 Every strategy variant against the testable criteria

| variant | trades | ₹ per trade (95% CI) | PF | years positive | bootstrap p | Bonferroni | DSR (variants / null) |
|---|---|---|---|---|---|---|---|
| NIFTY straddle A | 1,884 | +442 (+253 … +626) | 1.39 | 7 of 8 | 1.0e-5 | pass | 0.00 / 0.87 |
| NIFTY straddle B | 1,882 | +412 (+249 … +571) | 1.44 | 8 of 8 | 1.0e-5 | pass | 0.00 / 0.92 |
| SENSEX straddle A | 824 | +864 (+595 … +1,131) | 1.91 | 4 of 4 | 1.0e-5 | pass | 0.00 / 0.99 |
| SENSEX straddle B | 822 | +772 (+546 … +994) | 2.03 | 4 of 4 | 1.0e-5 | pass | 0.00 / 1.00 |
| NIFTY fly ±1 EM A / B | 1,827 / 1,802 | −208 / −362 | 0.76 / 0.48 | 1 / 0 of 8 | 1.0 | fail | 0 / 0 |
| NIFTY fly ±2 EM A / B | 1,862 / 1,862 | +44 / −102 | 1.04 / 0.87 | 3 / 2 of 8 | 0.28 / 0.97 | fail | 0 / 0 |
| SENSEX fly ±1 EM A / B | 763 / 720 | −41 / −223 | 0.95 / 0.64 | 1 / 0 of 4 | 0.69 / 1.0 | fail | 0 / 0 |
| SENSEX fly ±2 EM A / B | 780 / 746 | +351 / +205 | 1.38 / 1.29 | 4 / 3 of 4 | 0.002 / 0.011 | fail | 0.00 / 0.33, 0.15 |
| NIFTY strangle N = 1 / 2 / 4 | 399 / 399 / 396 | +620 / +636 / +185 | 1.82 / 1.56 / 1.08 | 7 / 8 / 6 of 8 | 0.003 / 0.007 / 0.33 | fail | 0.00 / 0.41, 0.26, 0.00 |
| SENSEX strangle N = 1 / 2 / 4 | 176 / 175 / 170 | +415 / +674 / +938 | 1.39 / 1.63 / 1.56 | 3 / 4 / 4 of 4 | 0.09 / 0.016 / 0.025 | fail | 0.00 / 0.04, 0.16, 0.12 |
| NIFTY condor N = 1 / 2 / 4 | 399 / 397 / 385 | +234 / +43 / −133 | 1.36 / 1.04 / 0.93 | 7 / 5 / 5 of 8 | 0.04 / 0.41 / 0.65 | fail | 0.00 / 0.08, 0, 0 |
| SENSEX condor N = 1 / 2 / 4 | 173 / 168 / 152 | +116 / +136 / +263 | 1.13 / 1.12 / 1.15 | 3 / 3 / 2 of 4 | 0.30 / 0.31 / 0.27 | fail | 0 / 0 |

**What passes.**
- The open→close straddle passes the CI, PF, every-year and Bonferroni criteria on both indices, and the null-variance DSR on SENSEX.
- It is not a candidate for two reasons:
  - it is naked;
  - its robustness to entry timing fails outright (VWAP entry −₹477 / −₹1,053 per trade).
- By the pre-registered rule (§1.8), that makes it "untestable without intraday option quotes", not "worth a paper test".

---

## 9. Verdict, and what to do next

| question | answer |
|---|---|
| Is there a seller's edge after all costs? | **In the files, yes, intraday, but only at the first print.** NIFTY +1.7% to +2.9% and SENSEX +4.1% to +6.2% of premium a day. It vanishes or reverses at any later or averaged entry. **Untestable without intraday quotes.** |
| How big is the tail? | Naked straddle: worst day −₹41k a lot (8% of ₹5 lakh); the worst 5% of days lose 1.25× everything earned in 7.6 years. Naked strangle held to expiry: up to −₹93k in one week. Defined risk caps the day at ≈ ₹10–20k, but leaves no edge. |
| A concrete, defined-risk rule? | **None passes.** The iron fly is negative or flat (±1 EM −3.3% / −2.4%; ±2 EM −1.6% / +0.2%). The hold-to-expiry condor is flat with wide CIs. |
| Worth a paper test? | **No.** The verdict for C1, C2 and C3 is "not worth it", and for the intraday seller's premium in general "untestable without intraday option quotes". |

**No paper-test spec is given, because none is warranted.** Writing one would turn a failed backtest into an experiment on the ₹5 lakh account with a known negative or zero mean.

**If the owner wants to settle the intraday question**, the next step is measurement, not trading:
1. **Check the broker's 1-minute option candles for expired weeklies (2020 onward).**
   - If they exist, re-run §3–§4 with entries at 09:16, 09:20, 09:30 and 11:15 and with a 2× credit stop. It costs nothing but an API job.
   - Judge it under the same bar, with the trials logged.
2. **Otherwise, record quotes in shadow:** bid, ask and depth at the times in §7 for the ATM ±2.5 EM strikes of the current and next weekly, on both indices. Place no orders.
   - After about 60 sessions, compare the bid at 09:15–09:20 with the bhavcopy's first print. That alone decides whether the +1.7% to +6.2% is real.
   - Only if it is would a frozen defined-risk rule (C2's structure with quote-based fills) be worth about 180 sessions of paper trading.

Nothing in this study argues for selling naked premium, in the paper engine or with real money.

---

## 10. Reproduce

```bash
# 1. The WP6 bhavcopy cache (compact extracts + index-daily.json): scripts/fetch-bhavcopy.ts, or a copy of WP6's .cache/bhavcopy
# 2. Everything in this report (≈ 8 minutes; writes reports/wp10/tables.md, summary.json and per-trade CSVs, all gitignored):
npx tsx scripts/research/wp10-short-premium.ts --dir <bhavcopy cache> --out reports/wp10 [--ledger]
# 3. Unit tests of the pure helpers (dated charges, multi-leg P&L, strikes, no-arbitrage screen, Black-76 IVs, tail statistics, events):
npx vitest run src/engine/backtest/shortPremium.test.ts
```

**Code.**

| file | what it holds |
|---|---|
| `src/engine/backtest/shortPremium.ts` | Pure research helpers: research charge schedules, `structurePnl`, expected moves and strikes, the fly checks, Black-76 IVs, worst runs, drawdown, tail share, the event calendar. Nothing in the engine imports it. |
| `src/engine/backtest/shortPremium.test.ts` | Their tests |
| `scripts/research/wp10-short-premium.ts` | The runner |

**Data.**
- No market data is committed.
- `--ledger` appends only variants not already in `reports/trials.jsonl`.
