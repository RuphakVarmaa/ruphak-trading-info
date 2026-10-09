# WP10: the seller's side of NIFTY and SENSEX weekly options on real exchange prices

Fri 9 Oct 2026. Branch `worktree-agent-aac3e0fbb005f12c3`, reset to `b0bd9c1` (head of `claude/gifted-wright-3d8r3j`). Analysis only: no paper trading, no deploys, no pushes; nothing in the engine changes.

**Status of this file:** §1 was written and committed before any profit or loss was computed. Results follow in later commits; any change to §1 after that point is listed as a deviation in the results.

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
