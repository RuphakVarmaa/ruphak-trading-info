# WP16: weekly bull put spreads held to expiry, and the turn of the month, on NIFTY and SENSEX

Sat 10 Oct 2026. Branch `worktree-agent-abe2d9bacd1d2479a`, fast-forwarded to `38021fb` (head of `claude/gifted-wright-3d8r3j`). Analysis only: no paper trading, no deploys, no pushes; nothing in the engine changes.

**Data and licence.**
- **Exchange files:** the compact NSE and BSE F&O bhavcopy cache (NSE from 11 Feb 2019, BSE daily from 15 May 2023, both to 8 Oct 2026): closing prices, settlement prints, lots, listed expiries and strikes, near-month futures.
- **Index and India VIX:** Yahoo's daily ^NSEI, ^BSESN and ^INDIAVIX bars (Q2's download of 9 Oct 2026, before the open; the last bar is 8 Oct 2026).
- **1-minute prices:** the Hugging Face dataset **"India Index & Options – 1-minute OHLC" by TradeMarkk** (`thetrademarkk/india-index-options-1m`, revision `0f4800e43e6f96cec0794369d78eb4d3c4211ef5`, https://huggingface.co/datasets/thetrademarkk/india-index-options-1m), licensed **CC-BY-NC-4.0**: non-commercial research use only, attributed here. WP11 §2 verified it against the exchanges' own files. This study reads WP13's extract of it.
- **NSE's participant-OI archive** (WP14's download): its file names only, as a list of NSE sessions.
- Nothing was downloaded for this study. No raw or extracted data is committed (the repository is public); the scripts rebuild everything from the downloads.

**Status of this file:** §1 and §2 were written and committed (`853017c`) before any premium-derived P&L, credit, win rate or conditional return was computed, and they are unchanged. §0 and §3–§10 were added after the runs; §9 lists every change made after the freeze. No definition changed.

---

## 0. Bottom line

**Verdict: nothing passes, so there is no paper-test spec.** The engine stays PAPER and nothing in it changes. In plain words: selling a weekly NIFTY or SENSEX bull put spread did not earn a reliable return after costs, whether it was held to expiry or closed the day before. What it did earn was not specific to puts. The turn of the month shows up in the index prints but fails the bar.

**The owner's question ("which option to enter now and wait till expiry for the most benefit").** On this evidence, none. The 16 walk-forward picks among the 58 pre-registered weekly put spreads (36 on daily closes, 22 on 1-minute bars) all fail the bar, at both fills. 13 of them lost money out of sample (from late 2023 for NIFTY, from 2025 for SENSEX). The few configurations that look good in hindsight are SENSEX's far (1.5 EM) spreads in 2025–2026, and their mirror call spreads earned too (§3.3).

**H1, the bull put spread: all 16 picks FAIL**, and not only on the sample size, which was known to fail before any P&L (§1.0, §2.6).
- **Per lot per trade on the last 40% of expiries**, at the conservative / mid fill (the pick is the (m, N) with the best mean on the first 60%):

  | family | management | NIFTY pick | NIFTY, last 40% | SENSEX pick | SENSEX, last 40% |
  |---|---|---|---|---|---|
  | D, daily closes | hold to settlement | m 0.5, N 4 | −₹173 / −₹145 (159 trades) | m 1.0, N 2 | −₹120 / −₹109 (67) |
  | D, daily closes | close the session before expiry | m 0.5, N 3 | −₹231 / −₹186 (159) | m 1.5, N 2 / m 0.5, N 4 | −₹24 / −₹933 (67) |
  | M, 1-minute 15:20 | hold to settlement | m 0.5, N 4 | −₹418 / −₹331 (100) | m 1.0, N 2 | −₹8 / +₹67 (54) |
  | M, 1-minute 15:20 | close the session before expiry | m 0.5, N 4 | −₹338 / −₹152 (100) | m 1.0, N 2 | +₹108 / +₹229 (54) |

- **Every pick fails at least four criteria.** All 16 fail the sample (fixed in advance), the CI and multiple testing, and the eight M picks fail the complete-bar era. All but one fail the placebo, and all but two fail PF 1.3.
  - The closest is SENSEX's 1-minute early exit at the mid fill: +₹229 a trade (CI −₹135 … +₹536), placebo gap 2.01 SE, PF 1.80. On the first 60% the same configuration lost −₹83 a trade; it was picked as the least bad.
- **What the spreads earned was not the put skew.** The placebo gaps (the bull put spread against a fair coin between it and the mirror bear call spread) run from −1.33 to +2.01 SE.
  - Over the whole sample, 18 of the 58 configurations have a positive mean at the conservative fill, 2 have a CI above zero, and 1 has a placebo gap of 2 SE (its own mean is −₹9 a trade).
  - The two with a CI above zero are SENSEX's daily 1.5 EM spreads held to settlement from N = 2 and 3 sessions: +₹152 and +₹184 a trade, May 2023 – Oct 2026. Their mirror call spreads also earned (+₹30 and +₹172), and their placebo gaps are 1.01 and 0.10 SE: far out-of-the-money premium on both sides, not a put-specific edge. The first 60% did not pick them, and with 67 trades out of sample they could not pass.
- **The market priced the spread at about its average payout.** NIFTY's 0.5 EM spread entered 4 sessions before expiry took in 16.9% of its width and paid out 16.3% of it on average.
  - The short put made +₹397 a trade gross and the long put lost −₹215. Charges (₹56) and the spread (₹27) took ₹83 of the ₹182 left.
  - Net: +₹100 a trade over 396 expiries (CI −₹302 … +₹477), and −₹173 on the last 40%.

**The economics, per lot, all trades, conservative fill (§3.4):**

| pick | credit ₹/lot | win rate | average win / average loss | net ₹ per eligible week: all / last 40% | the ₹5 lakh account at one lot a week: worst / best year |
|---|---|---|---|---|---|
| NIFTY D, hold, 0.5 EM, N 4 | ₹1,896 | 79.0% | ₹1,852 / −₹6,510 | +₹99 / −₹173 | 2026 −₹33,367 (−6.7%) / 2020 +₹32,977 (+6.6%) |
| NIFTY D, early, 0.5 EM, N 3 | ₹1,612 | 69.0% | ₹1,088 / −₹2,208 | +₹67 / −₹231 | 2026 −₹21,895 (−4.4%) / 2020 +₹40,441 (+8.1%) |
| NIFTY M, hold, 0.5 EM, N 4 | ₹1,673 | 78.6% | ₹1,601 / −₹6,208 | −₹72 / −₹410 | 2026 −₹45,162 (−9.0%) / 2021 +₹19,728 (+3.9%) |
| NIFTY M, early, 0.5 EM, N 4 | ₹1,673 | 69.8% | ₹1,224 / −₹3,367 | −₹159 / −₹332 | 2026 −₹39,886 (−8.0%) / 2025 +₹6,481 (+1.3%) |
| SENSEX D, hold, 1.0 EM, N 2 | ₹622 | 89.8% | ₹562 / −₹4,536 | +₹42 / −₹118 | 2026 −₹19,981 (−4.0%) / 2025 +₹17,724 (+3.5%) |
| SENSEX D, early, 1.5 EM, N 2 | ₹304 | 58.9% | ₹208 / −₹435 | −₹54 / −₹24 | 2026 −₹3,230 (−0.6%) / 2025 −₹1,111 (−0.2%) |
| SENSEX M, hold, 1.0 EM, N 2 | ₹606 | 90.3% | ₹560 / −₹4,058 | +₹111 / −₹8 | 2026 −₹6,397 (−1.3%) / 2025 +₹15,484 (+3.1%) |
| SENSEX M, early, 1.0 EM, N 2 | ₹606 | 67.2% | ₹397 / −₹950 | −₹45 / +₹108 | 2024 −₹3,987 (−0.8%) / 2026 +₹3,886 (+0.8%) |

- "Net ₹ per eligible week" counts every eligible expiry week, a week without a trade as ₹0: the expectancy of one lot a week. 2026 runs to 8 Oct (to Jul on 1-minute bars). Lots changed over the sample, so years are not comparable in rupees.
- The high win rates come with average losses 2.0–8.1 times the average win.

**The tails (one lot):**
- **A held spread loses its whole width about one expiry in eight.** NIFTY's 0.5 EM spread held 4 sessions did so on 47 of 396 expiries (11.9%). Its worst trade was −₹16,116 (expiry 24 Mar 2026: NIFTY −3.6% from entry, lot 65), and 6 of its 10 worst trades came in 2025–2026.
- **The named stress dates**, for that pick: March 2020 cost −₹9,036 (expiry 12 Mar) and −₹14,629 (19 Mar; NIFTY −17.0% from entry to expiry), and then made +₹6,479 (26 Mar). The 4 Jun 2024 election result made +₹4,682, held through. The 7 Apr 2025 tariff gap cost −₹11,897.
- **The width caps the loss.** The largest possible loss on one lot was ₹23,959. The largest maximum drawdown among the conservative picks was ₹56,235 (11.2% of ₹5 lakh: NIFTY's 1-minute early exit, Sep 2023 → Mar 2026).

**Margin and the two accounts.** The picks needed ₹30,393–33,633 a lot at entry on average (smallest ₹13,355), and up to ₹95,540 with the expiry-day 2% (from 20 Nov 2024).
- **A ₹10,000 account cannot carry one lot of any configuration**: not one entry needed ₹10,000 or less.
- **A ₹5 lakh account can carry one lot.** The peak margin is 19% of it, and the largest possible loss on a lot is 4.8%.

**H2, the turn of the month: FAIL**, on more than the sample size (which §2.6 had already ruled out).
- **The rise is there.** Long the index from the close before the month's last session to the close of the next month's third session: NIFTY +53.0 bp a window on the last 40% (91 windows after the cut of 6 Mar 2019; CI +11.1 … +95.7 bp; PF 1.94; up in 62.6%). SENSEX +52.2 bp (94 windows; CI +10.1 … +95.0 bp; PF 1.89).
- **It fails the bar** on three counts:
  - the placebo: window days beat the other days by +44.5 and +45.3 bp a window, 1.84 SE for both, against the required 2;
  - multiple testing: p 6.4 × 10⁻³ and 7.5 × 10⁻³ against 0.05 / 3,303 = 1.5 × 10⁻⁵, and a DSR of 0.115 and 0.111;
  - the sample: 91 and 94 windows, against 180.
- **It has faded.** NIFTY made +151 bp a window in 2021, +102 in 2023, +17 in 2024, −11 in 2025 and −7 in 2026 (9 windows).
- **The near-month future over the same window** (descriptive; STT only): NIFTY +₹3,321 a lot a window (91 windows from Feb 2019; CI −₹828 … +₹7,485), with losses in 2019, 2025 and 2026. SENSEX −₹3,061 (38 windows). No option trade was built on TOM.

**Checks.** An independent standard-library Python re-computation agrees with all 116 H1 runs and both TOM variants: trade counts exactly, means to within ₹4 × 10⁻¹³ (§7). The ledger went from 3,067 to 3,303 lines (§6).

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

---

## 3. H1: the bull put spread

All figures are net ₹ per lot per trade at the lot in force, after the dated charges, from the final `--ledger` run (byte-identical to the development run before it; §9). The verdict is decided at the conservative fill.

### 3.1 The picks against the bar, per index

The pick is the (m, N) with the best first-60% mean, per family, management and fill (§1.6). "Placebo gap" is the bull put spread's mean minus the mean of a fair coin between it and the mirror bear call spread, paired by expiry week, in ₹ a trade (with its multiple of the clustered SE). "Era" is the M family's complete-bar era (criterion 7). "Robustness (not run)" counts as a failure (§1.6).

**NIFTY** (last 40%: daily closes after 21 Sep 2023, 1-minute bars after 16 May 2024)

| family | management | fill | pick | first 60% ₹/trade (n) | last 40% trades | last 40% ₹/trade (95% CI) | placebo gap ₹ (SE) | PF | verdict: fails on |
|---|---|---|---|---|---|---|---|---|---|
| D | hold | conservative | m 0.5, N 4 | ₹283 (237) | 159 | −₹173 (−₹900 … ₹510) | −₹162 (−0.53) | 0.90 | FAIL: sample, placebo, CI, PF, robustness (not run), multiple testing |
| D | hold | mid | m 0.5, N 4 | ₹309 (237) | 159 | −₹145 (−₹874 … ₹539) | −₹162 (−0.53) | 0.91 | FAIL: the same |
| D | early | conservative | m 0.5, N 3 | ₹266 (238) | 159 | −₹231 (−₹592 … ₹106) | −₹220 (−1.32) | 0.74 | FAIL: the same |
| D | early | mid | m 0.5, N 3 | ₹303 (238) | 159 | −₹186 (−₹542 … ₹147) | −₹220 (−1.33) | 0.79 | FAIL: the same |
| M | hold | conservative | m 0.5, N 4 | ₹154 (152) | 100 | −₹418 (−₹1,425 … ₹507) | −₹299 (−0.74) | 0.79 | FAIL: the same, and era |
| M | hold | mid | m 0.5, N 4 | ₹240 (152) | 100 | −₹331 (−₹1,337 … ₹593) | −₹302 (−0.75) | 0.83 | FAIL: the same, and era |
| M | early | conservative | m 0.5, N 4 | −₹44 (152) | 100 | −₹338 (−₹1,038 … ₹289) | −₹297 (−0.95) | 0.75 | FAIL: the same, and era |
| M | early | mid | m 0.5, N 4 | ₹105 (152) | 100 | −₹152 (−₹823 … ₹455) | −₹281 (−0.92) | 0.88 | FAIL: the same, and era |

**SENSEX** (last 40%: daily closes after 10 Jun 2025, 1-minute bars after 25 Mar 2025)

| family | management | fill | pick | first 60% ₹/trade (n) | last 40% trades | last 40% ₹/trade (95% CI) | placebo gap ₹ (SE) | PF | verdict: fails on |
|---|---|---|---|---|---|---|---|---|---|
| D | hold | conservative | m 1.0, N 2 | ₹153 (100) | 67 | −₹120 (−₹745 … ₹411) | −₹180 (−0.86) | 0.84 | FAIL: sample, placebo, CI, PF, robustness (not run), multiple testing |
| D | hold | mid | m 1.0, N 2 | ₹161 (100) | 67 | −₹109 (−₹734 … ₹422) | −₹179 (−0.86) | 0.85 | FAIL: the same |
| D | early | conservative | m 1.5, N 2 | −₹79 (96) | 67 | −₹24 (−₹226 … ₹136) | ₹62 (0.72) | 0.86 | FAIL: the same |
| D | early | mid | m 0.5, N 4 | −₹69 (102) | 67 | −₹933 (−₹1,991 … ₹54) | −₹451 (−0.97) | 0.55 | FAIL: the same |
| M | hold | conservative | m 1.0, N 2 | ₹193 (80) | 54 | −₹8 (−₹721 … ₹583) | −₹57 (−0.21) | 0.99 | FAIL: the same, and era |
| M | hold | mid | m 1.0, N 2 | ₹229 (80) | 54 | ₹67 (−₹652 … ₹662) | −₹45 (−0.17) | 1.09 | FAIL: the same, and era |
| M | early | conservative | m 1.0, N 2 | −₹149 (80) | 54 | ₹108 (−₹284 … ₹430) | ₹436 (1.94) | 1.32 | FAIL: sample, placebo, CI, robustness (not run), multiple testing, era |
| M | early | mid | m 1.0, N 2 | −₹83 (80) | 54 | ₹229 (−₹135 … ₹536) | ₹432 (2.01) | 1.80 | FAIL: sample, CI, robustness (not run), multiple testing, era |

- The per-eligible-week CIs (criterion 3) are within ₹33 of the per-trade CIs above, because nearly every eligible week has a trade.
- **No pick is "mid only"**: every pick fails at the mid fill too (§1.6).
- **The first 60% did not carry over.** Every NIFTY pick has a negative last-40% mean; all but one (M early at the conservative fill, −₹44) had a positive first-60% mean. SENSEX's best last-40% picks, the 1-minute early exits (+₹108 and +₹229), had lost on the first 60% (−₹149 and −₹83): they were the least bad of SENSEX's 1-minute early-exit cells.

### 3.2 Why each criterion fails

1. **The sample** (all 16): 159 NIFTY and 67 SENSEX trades on daily closes, 100 and 54 on 1-minute bars, against 180 (fixed before any P&L, §2.6). Up to two eligible weeks per pick have no trade (an unpriced leg; §2.4).
2. **The placebo** (15 of 16): the gaps run from −1.33 to +1.94 SE (−₹451 to +₹436 a trade). Only SENSEX's 1-minute early exit at the mid fill reaches 2 SE (₹432, 2.01 SE): on those 54 weeks the mirror bear call spread lost −₹635 a trade.
3. **The CI** (all 16): every interval includes zero. The highest lower bound is −₹135 (SENSEX M early, mid).
4. **PF ≥ 1.3** (14 of 16): 0.55–1.09. SENSEX's 1-minute early exit passes (1.32 at the conservative fill, 1.80 at mid).
5. **±20% robustness**: not run for any pick, because none passed criteria 2–4. No perturbation was built or logged.
6. **Multiple testing** (all 16): the larger bootstrap p-value is 0.095–0.97 against 0.05 / 3,303 = 1.51 × 10⁻⁵. The deflated Sharpe ratio is 0.000–0.033 against 0.95, and the same with the null variance 1/(T − 1).
7. **The M family's complete-bar era** (all 8 M picks): on the trades to Dec 2024 no CI is above zero. NIFTY's held pick made +₹126 a trade (CI −₹274 … +₹502) over 184 trades, then −₹609 over 68 trades in the sampled era. SENSEX's early exit lost −₹104 (conservative) and −₹51 (mid) in the complete-bar era.

### 3.3 Every configuration (whole sample, descriptive)

This is not the bar's test: the bar judges only the picks, on the last 40%. Over the whole sample:

- **Signs at the conservative fill**: 18 of the 58 configurations have a positive mean (30 at mid). Two have a CI above zero: SENSEX's daily 1.5 EM spreads held from N = 2 and 3 sessions (+₹152 and +₹184 a trade; both fills).
- **Placebo**: one configuration has a placebo gap of at least 2 SE: SENSEX's 1-minute 0.5 EM spread closed the day before, from N = 2 (₹314 a trade, 2.09 SE). Its own mean is −₹9 at the conservative fill and +₹135 at mid; the mirror call spread lost −₹638.
- **No mirror bear call spread has a CI above zero at the conservative fill.** At mid, one does: NIFTY's daily 1.5 EM, N = 2, held (+₹81 a trade).
- **The last 40% of every configuration, in hindsight** (not a pick, so not a verdict): 15 of 58 positive at the conservative fill, and 3 with a CI above zero, all SENSEX daily 1.5 EM held: N = 2, 3, 4 (+₹257, +₹420, +₹295 a trade over 67 trades). Their first-60% means were +₹79, +₹16 and +₹93, below the pick (1.0 EM, N 2: +₹153). On the same weeks their mirror call spreads made +₹125, +₹438 and +₹418, and their placebo gaps are +0.89, −0.58 and −0.90 SE. **In 2025–2026, far out-of-the-money SENSEX weekly spreads earned on both sides; nothing in that is specific to puts.**
- **Closing the day before expiry usually did worse than holding**: in 21 of the 29 cells at the conservative fill (daily NIFTY 6 of 9, daily SENSEX 7 of 9, 1-minute NIFTY 5 of 6, 1-minute SENSEX 3 of 5).
  - It almost removes the full-width losses (0–2.4% of trades, against 1.2–15.1% when held). But it pays a second round of costs (the early picks' charges are ₹96–106 a trade, the held picks' ₹50–56), and it gives up the last session's decay.
  - All 11 early-exit cells on 1-minute bars lose at the conservative fill, four with a CI below zero (NIFTY 0.5 EM from N = 2 and 3, and 1.0 and 1.5 EM from N = 2). At that fill each leg pays the minute's whole range on the way out as well.
- **The credit tracks the width, and so does the payout.** At 0.5 EM the credit is 15–17% of the width and the payout 15–21%; at 1.0 EM, 7–8% and 5–11%; at 1.5 EM, 3–4% and 2–5% (conservative fill).

The table lists every configuration: conservative mean (95% CI) and mid mean; first 60% / last 40% at the conservative fill; the credit at the conservative fills and how many entries had a credit of ₹0 or less (§5); what the spread was worth at the exit (payout ÷ width); how often the short strike finished in the money and the full width was lost; the mirror bear call spread; and the placebo gap over all trades.

**D daily closes, NIFTY**

| management | m | N | trades | bull put spread ₹/trade, conservative (95% CI) | mid | first 60% / last 40% (conservative) | credit ₹/lot (÷ width); entries with credit ≤ ₹0 | payout ÷ width | short strike breached / full width lost | mirror bear call spread ₹/trade (conservative) | placebo gap (SE) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hold | 0.5 | 2 | 397 | ₹12 (−₹267 … ₹279) | ₹31 | −₹44 / ₹96 | ₹1,307 (16%); ≤ ₹0: 0 | 16.5% | 24% / 10.6% | −₹50 | ₹31 (0.26) |
| hold | 0.5 | 3 | 397 | ₹71 (−₹261 … ₹389) | ₹94 | ₹223 / −₹156 | ₹1,612 (17%); ≤ ₹0: 0 | 16.1% | 24% / 10.1% | −₹31 | ₹51 (0.36) |
| hold | 0.5 | 4 | 396 | ₹100 (−₹302 … ₹477) | ₹126 | ₹283 / −₹173 | ₹1,896 (17%); ≤ ₹0: 0 | 16.3% | 23% / 11.9% | −₹107 | ₹103 (0.60) |
| hold | 1.0 | 2 | 397 | −₹35 (−₹254 … ₹168) | −₹23 | −₹13 / −₹67 | ₹607 (7%); ≤ ₹0: 0 | 7.0% | 10% / 4.3% | ₹50 | −₹42 (−0.54) |
| hold | 1.0 | 3 | 397 | ₹130 (−₹88 … ₹333) | ₹143 | ₹130 / ₹130 | ₹769 (8%); ≤ ₹0: 0 | 7.0% | 11% / 5.3% | −₹89 | ₹109 (1.17) |
| hold | 1.0 | 4 | 396 | −₹100 (−₹400 … ₹181) | −₹85 | ₹8 / −₹260 | ₹859 (8%); ≤ ₹0: 3 | 8.6% | 12% / 5.1% | −₹13 | −₹43 (−0.39) |
| hold | 1.5 | 2 | 397 | −₹13 (−₹157 … ₹117) | −₹5 | ₹84 / −₹157 | ₹281 (3%); ≤ ₹0: 0 | 2.9% | 4% / 1.8% | ₹74 | −₹43 (−1.06) |
| hold | 1.5 | 3 | 396 | ₹56 (−₹84 … ₹174) | ₹64 | ₹65 / ₹41 | ₹344 (3%); ≤ ₹0: 1 | 2.9% | 5% / 1.3% | −₹8 | ₹32 (0.61) |
| hold | 1.5 | 4 | 396 | −₹6 (−₹218 … ₹182) | ₹4 | −₹47 / ₹55 | ₹437 (4%); ≤ ₹0: 0 | 3.7% | 5% / 2.8% | −₹10 | ₹2 (0.03) |
| early | 0.5 | 2 | 397 | −₹22 (−₹169 … ₹120) | ₹13 | ₹39 / −₹112 | ₹1,307 (16%); ≤ ₹0: 0 | 15.2% | 15% / 0.0% | −₹129 | ₹54 (0.75) |
| early | 0.5 | 3 | 397 | ₹67 (−₹139 … ₹265) | ₹107 | ₹266 / −₹231 | ₹1,612 (17%); ≤ ₹0: 0 | 15.1% | 18% / 0.0% | −₹186 | ₹126 (1.21) |
| early | 0.5 | 4 | 396 | ₹34 (−₹277 … ₹321) | ₹83 | ₹136 / −₹119 | ₹1,896 (17%); ≤ ₹0: 0 | 16.0% | 20% / 0.3% | −₹218 | ₹126 (0.91) |
| early | 1.0 | 2 | 397 | −₹17 (−₹103 … ₹65) | ₹4 | ₹42 / −₹105 | ₹607 (7%); ≤ ₹0: 0 | 6.3% | 4% / 0.0% | −₹52 | ₹18 (0.48) |
| early | 1.0 | 3 | 397 | ₹76 (−₹39 … ₹185) | ₹100 | ₹182 / −₹83 | ₹769 (8%); ≤ ₹0: 0 | 6.2% | 7% / 0.0% | −₹41 | ₹59 (1.10) |
| early | 1.0 | 4 | 396 | −₹4 (−₹207 … ₹178) | ₹24 | ₹86 / −₹138 | ₹859 (8%); ≤ ₹0: 3 | 6.9% | 8% / 0.0% | −₹124 | ₹60 (0.74) |
| early | 1.5 | 2 | 397 | −₹37 (−₹82 … ₹6) | −₹21 | −₹7 / −₹81 | ₹281 (3%); ≤ ₹0: 0 | 2.5% | 0% / 0.0% | −₹54 | ₹9 (0.49) |
| early | 1.5 | 3 | 396 | ₹21 (−₹35 … ₹73) | ₹37 | ₹68 / −₹49 | ₹344 (3%); ≤ ₹0: 1 | 2.3% | 1% / 0.0% | −₹25 | ₹23 (1.07) |
| early | 1.5 | 4 | 396 | ₹1 (−₹143 … ₹123) | ₹20 | ₹7 / −₹7 | ₹437 (4%); ≤ ₹0: 0 | 2.8% | 3% / 0.0% | −₹97 | ₹49 (1.06) |

**D daily closes, SENSEX**

| management | m | N | trades | bull put spread ₹/trade, conservative (95% CI) | mid | first 60% / last 40% (conservative) | credit ₹/lot (÷ width); entries with credit ≤ ₹0 | payout ÷ width | short strike breached / full width lost | mirror bear call spread ₹/trade (conservative) | placebo gap (SE) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hold | 0.5 | 2 | 170 | −₹250 (−₹726 … ₹200) | −₹233 | −₹122 / −₹446 | ₹1,279 (17%); ≤ ₹0: 0 | 19.0% | 26% / 12.4% | −₹277 | ₹13 (0.07) |
| hold | 0.5 | 3 | 169 | −₹322 (−₹862 … ₹193) | −₹302 | −₹307 / −₹346 | ₹1,570 (17%); ≤ ₹0: 0 | 20.3% | 30% / 11.8% | ₹195 | −₹259 (−1.16) |
| hold | 0.5 | 4 | 169 | −₹384 (−₹1,027 … ₹227) | −₹361 | −₹68 / −₹865 | ₹1,770 (17%); ≤ ₹0: 0 | 20.4% | 27% / 14.2% | ₹151 | −₹268 (−1.03) |
| hold | 1.0 | 2 | 167 | ₹43 (−₹251 … ₹305) | ₹52 | ₹153 / −₹120 | ₹622 (8%); ≤ ₹0: 0 | 6.2% | 11% / 3.0% | −₹29 | ₹36 (0.31) |
| hold | 1.0 | 3 | 164 | ₹101 (−₹247 … ₹403) | ₹112 | −₹56 / ₹328 | ₹782 (8%); ≤ ₹0: 1 | 7.6% | 12% / 4.3% | ₹178 | −₹39 (−0.31) |
| hold | 1.0 | 4 | 162 | −₹187 (−₹684 … ₹263) | −₹175 | −₹81 / −₹339 | ₹909 (8%); ≤ ₹0: 0 | 10.2% | 15% / 5.6% | ₹237 | −₹212 (−1.21) |
| hold | 1.5 | 2 | 164 | ₹152 (₹31 … ₹253) | ₹157 | ₹79 / ₹257 | ₹303 (4%); ≤ ₹0: 0 | 1.7% | 3% / 1.2% | ₹30 | ₹61 (1.01) |
| hold | 1.5 | 3 | 161 | ₹184 (₹16 … ₹323) | ₹191 | ₹16 / ₹420 | ₹387 (4%); ≤ ₹0: 0 | 2.3% | 4% / 1.2% | ₹172 | ₹6 (0.10) |
| hold | 1.5 | 4 | 158 | ₹179 (−₹39 … ₹395) | ₹186 | ₹93 / ₹295 | ₹479 (4%); ≤ ₹0: 5 | 2.8% | 6% / 1.3% | ₹184 | −₹3 (−0.03) |
| early | 0.5 | 2 | 170 | −₹28 (−₹281 … ₹207) | ₹3 | −₹136 / ₹137 | ₹1,279 (17%); ≤ ₹0: 0 | 16.8% | 16% / 0.6% | −₹356 | ₹164 (1.30) |
| early | 0.5 | 3 | 169 | −₹220 (−₹598 … ₹136) | −₹179 | −₹194 / −₹260 | ₹1,570 (17%); ≤ ₹0: 0 | 19.2% | 22% / 0.0% | −₹12 | −₹104 (−0.61) |
| early | 0.5 | 4 | 169 | −₹460 (−₹979 … ₹32) | −₹412 | −₹106 / −₹998 | ₹1,770 (17%); ≤ ₹0: 0 | 20.5% | 24% / 0.6% | −₹146 | −₹157 (−0.68) |
| early | 1.0 | 2 | 167 | −₹35 (−₹206 … ₹118) | −₹18 | −₹88 / ₹44 | ₹622 (8%); ≤ ₹0: 0 | 7.5% | 5% / 0.0% | −₹251 | ₹108 (1.27) |
| early | 1.0 | 3 | 164 | −₹161 (−₹440 … ₹89) | −₹140 | −₹237 / −₹52 | ₹782 (8%); ≤ ₹0: 1 | 9.7% | 11% / 0.0% | −₹106 | −₹28 (−0.23) |
| early | 1.0 | 4 | 162 | −₹303 (−₹690 … ₹48) | −₹278 | −₹173 / −₹488 | ₹909 (8%); ≤ ₹0: 0 | 11.0% | 14% / 0.0% | −₹105 | −₹99 (−0.65) |
| early | 1.5 | 2 | 163 | −₹56 (−₹173 … ₹42) | −₹46 | −₹79 / −₹24 | ₹304 (4%); ≤ ₹0: 0 | 3.5% | 2% / 0.0% | −₹162 | ₹53 (0.96) |
| early | 1.5 | 3 | 161 | −₹91 (−₹271 … ₹63) | −₹78 | −₹152 / −₹6 | ₹387 (4%); ≤ ₹0: 0 | 4.4% | 6% / 0.0% | −₹74 | −₹9 (−0.13) |
| early | 1.5 | 4 | 157 | −₹138 (−₹405 … ₹116) | −₹123 | −₹111 / −₹173 | ₹482 (4%); ≤ ₹0: 5 | 5.1% | 8% / 0.0% | −₹46 | −₹46 (−0.47) |

**M 1-minute 15:20, NIFTY**

| management | m | N | trades | bull put spread ₹/trade, conservative (95% CI) | mid | first 60% / last 40% (conservative) | credit ₹/lot (÷ width); entries with credit ≤ ₹0 | payout ÷ width | short strike breached / full width lost | mirror bear call spread ₹/trade (conservative) | placebo gap (SE) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hold | 0.5 | 2 | 254 | −₹47 (−₹373 … ₹258) | ₹45 | −₹197 / ₹177 | ₹1,143 (15%); ≤ ₹0: 0 | 16.2% | 25% / 11.0% | −₹45 | −₹1 (−0.01) |
| hold | 0.5 | 3 | 254 | −₹80 (−₹480 … ₹290) | ₹12 | −₹18 / −₹173 | ₹1,422 (16%); ≤ ₹0: 0 | 16.6% | 25% / 10.6% | ₹137 | −₹108 (−0.70) |
| hold | 0.5 | 4 | 252 | −₹73 (−₹560 … ₹386) | ₹13 | ₹154 / −₹418 | ₹1,673 (16%); ≤ ₹0: 0 | 16.0% | 23% / 11.5% | −₹183 | ₹55 (0.27) |
| hold | 1.0 | 2 | 254 | −₹91 (−₹359 … ₹149) | −₹39 | −₹74 / −₹116 | ₹527 (7%); ≤ ₹0: 0 | 7.2% | 11% / 4.3% | −₹14 | −₹38 (−0.42) |
| hold | 1.0 | 3 | 254 | ₹31 (−₹235 … ₹272) | ₹80 | −₹35 / ₹130 | ₹661 (7%); ≤ ₹0: 0 | 7.5% | 11% / 5.5% | ₹83 | −₹26 (−0.27) |
| hold | 1.5 | 2 | 247 | −₹118 (−₹325 … ₹57) | −₹89 | −₹51 / −₹219 | ₹242 (3%); ≤ ₹0: 0 | 3.8% | 4% / 2.0% | ₹63 | −₹91 (−1.65) |
| early | 0.5 | 2 | 254 | −₹270 (−₹467 … −₹88) | −₹93 | −₹289 / −₹241 | ₹1,143 (15%); ≤ ₹0: 0 | 17.4% | 14% / 0.0% | −₹181 | −₹45 (−0.51) |
| early | 0.5 | 3 | 254 | −₹270 (−₹534 … −₹24) | −₹87 | −₹189 / −₹391 | ₹1,422 (16%); ≤ ₹0: 0 | 17.7% | 20% / 0.4% | −₹8 | −₹131 (−1.12) |
| early | 0.5 | 4 | 252 | −₹161 (−₹517 … ₹169) | ₹3 | −₹44 / −₹338 | ₹1,673 (16%); ≤ ₹0: 0 | 16.5% | 21% / 1.2% | −₹211 | ₹25 (0.15) |
| early | 1.0 | 2 | 254 | −₹167 (−₹289 … −₹57) | −₹71 | −₹180 / −₹148 | ₹527 (7%); ≤ ₹0: 0 | 7.7% | 4% / 0.0% | −₹97 | −₹35 (−0.72) |
| early | 1.0 | 3 | 252 | −₹90 (−₹240 … ₹47) | ₹2 | −₹69 / −₹122 | ₹655 (7%); ≤ ₹0: 0 | 7.4% | 8% / 0.0% | ₹27 | −₹58 (−1.03) |
| early | 1.5 | 2 | 243 | −₹110 (−₹178 … −₹48) | −₹57 | −₹117 / −₹98 | ₹243 (3%); ≤ ₹0: 0 | 3.2% | 0% / 0.0% | −₹75 | −₹17 (−0.69) |

**M 1-minute 15:20, SENSEX**

| management | m | N | trades | bull put spread ₹/trade, conservative (95% CI) | mid | first 60% / last 40% (conservative) | credit ₹/lot (÷ width); entries with credit ≤ ₹0 | payout ÷ width | short strike breached / full width lost | mirror bear call spread ₹/trade (conservative) | placebo gap (SE) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hold | 0.5 | 2 | 135 | −₹94 (−₹637 … ₹392) | −₹6 | −₹20 / −₹204 | ₹1,251 (17%); ≤ ₹0: 0 | 16.3% | 23% / 10.4% | −₹428 | ₹167 (0.75) |
| hold | 0.5 | 3 | 133 | −₹415 (−₹1,052 … ₹169) | −₹335 | −₹476 / −₹325 | ₹1,519 (17%); ≤ ₹0: 0 | 20.9% | 29% / 12.0% | ₹8 | −₹212 (−0.83) |
| hold | 0.5 | 4 | 126 | −₹415 (−₹1,190 … ₹313) | −₹321 | −₹273 / −₹609 | ₹1,763 (17%); ≤ ₹0: 0 | 20.3% | 26% / 15.1% | −₹119 | −₹148 (−0.47) |
| hold | 1.0 | 2 | 134 | ₹112 (−₹204 … ₹375) | ₹164 | ₹193 / −₹8 | ₹606 (8%); ≤ ₹0: 0 | 5.3% | 10% / 2.2% | −₹112 | ₹112 (0.88) |
| hold | 1.0 | 3 | 133 | ₹147 (−₹231 … ₹471) | ₹201 | −₹134 / ₹558 | ₹764 (8%); ≤ ₹0: 0 | 7.2% | 12% / 3.8% | ₹28 | ₹60 (0.41) |
| early | 0.5 | 2 | 135 | −₹9 (−₹287 … ₹248) | ₹135 | −₹225 / ₹314 | ₹1,251 (17%); ≤ ₹0: 0 | 16.4% | 17% / 0.0% | −₹638 | ₹314 (2.09) |
| early | 0.5 | 3 | 133 | −₹326 (−₹795 … ₹96) | −₹186 | −₹476 / −₹107 | ₹1,519 (17%); ≤ ₹0: 0 | 19.9% | 23% / 0.8% | −₹279 | −₹23 (−0.11) |
| early | 0.5 | 4 | 126 | −₹462 (−₹1,113 … ₹140) | −₹317 | −₹323 / −₹654 | ₹1,763 (17%); ≤ ₹0: 0 | 20.3% | 22% / 2.4% | −₹464 | ₹1 (0.00) |
| early | 1.0 | 2 | 134 | −₹45 (−₹237 … ₹120) | ₹43 | −₹149 / ₹108 | ₹606 (8%); ≤ ₹0: 0 | 7.7% | 5% / 0.0% | −₹380 | ₹168 (1.65) |
| early | 1.0 | 3 | 131 | −₹181 (−₹524 … ₹115) | −₹72 | −₹297 / −₹9 | ₹763 (8%); ≤ ₹0: 0 | 9.8% | 11% / 0.8% | −₹315 | ₹67 (0.45) |

### 3.4 The economics of the picks

Per lot, over all trades. "Net per eligible week" is the net ÷ the eligible expiry weeks (a week without a trade counts as ₹0), that is, the expectancy of one lot a week. The conservative fill's spread cost is in the "charges + spread" column for D; for M it is inside the fill prices (the 1-minute low and high), so M shows charges only.

**Conservative fill (decides):**

| pick | trades | credit ₹/lot (÷ width) | payout ÷ width | win rate | average win / average loss | short strike breached | full width lost | charges + spread ₹ a trade | gross ₹ a trade: short leg / long leg | net per eligible week: all / last 40% | net ₹, all |
|---|---|---|---|---|---|---|---|---|---|---|---|
| NIFTY D, hold, 0.5 EM, N 4 | 396 | ₹1,896 (16.9%) | 16.3% | 79.0% | ₹1,852 / −₹6,510 | 22.7% | 47 (11.9%) | ₹56 + ₹27 | ₹397 / −₹215 | +₹99 / −₹173 | ₹39,469 |
| NIFTY D, early, 0.5 EM, N 3 | 397 | ₹1,612 (16.8%) | 15.1% | 69.0% | ₹1,088 / −₹2,208 | 17.6% | 0 | ₹102 + ₹41 | ₹854 / −₹645 | +₹67 / −₹231 | ₹26,494 |
| NIFTY M, hold, 0.5 EM, N 4 | 252 | ₹1,673 (15.9%) | 16.0% | 78.6% | ₹1,601 / −₹6,208 | 23.4% | 29 (11.5%) | ₹54 | ₹466 / −₹484 | −₹72 / −₹410 | −₹18,314 |
| NIFTY M, early, 0.5 EM, N 4 | 252 | ₹1,673 (15.9%) | 16.5% | 69.8% | ₹1,224 / −₹3,367 | 20.6% | 3 (1.2%) | ₹103 | ₹515 / −₹573 | −₹159 / −₹332 | −₹40,486 |
| SENSEX D, hold, 1.0 EM, N 2 | 167 | ₹622 (8.3%) | 6.2% | 89.8% | ₹562 / −₹4,536 | 11.4% | 5 (3.0%) | ₹50 + ₹9 | ₹670 / −₹568 | +₹42 / −₹118 | ₹7,258 |
| SENSEX D, early, 1.5 EM, N 2 | 163 | ₹304 (3.9%) | 3.5% | 58.9% | ₹208 / −₹435 | 1.8% | 0 | ₹96 + ₹10 | ₹124 / −₹74 | −₹54 / −₹24 | −₹9,185 |
| SENSEX M, hold, 1.0 EM, N 2 | 134 | ₹606 (8.0%) | 5.3% | 90.3% | ₹560 / −₹4,058 | 10.4% | 3 (2.2%) | ₹50 | ₹807 / −₹646 | +₹111 / −₹8 | ₹15,005 |
| SENSEX M, early, 1.0 EM, N 2 | 134 | ₹606 (8.0%) | 7.7% | 67.2% | ₹397 / −₹950 | 5.2% | 0 | ₹98 | ₹290 / −₹237 | −₹45 / +₹108 | −₹6,079 |

**Mid fill:**

| pick | trades | credit ₹/lot (÷ width) | payout ÷ width | win rate | average win / average loss | net per eligible week: all / last 40% | net ₹, all |
|---|---|---|---|---|---|---|---|
| NIFTY D, hold, 0.5 EM, N 4 | 396 | ₹1,922 (17.2%) | 16.3% | 79.0% | ₹1,880 / −₹6,485 | +₹126 / −₹145 | ₹50,051 |
| NIFTY D, early, 0.5 EM, N 3 | 397 | ₹1,635 (17.1%) | 15.1% | 69.5% | ₹1,111 / −₹2,182 | +₹107 / −₹186 | ₹42,610 |
| NIFTY M, hold, 0.5 EM, N 4 | 252 | ₹1,759 (16.8%) | 16.0% | 79.4% | ₹1,671 / −₹6,362 | +₹13 / −₹324 | ₹3,399 |
| NIFTY M, early, 0.5 EM, N 4 | 252 | ₹1,759 (16.8%) | 15.7% | 71.8% | ₹1,296 / −₹3,291 | +₹3 / −₹149 | ₹818 |
| SENSEX D, hold, 1.0 EM, N 2 | 167 | ₹631 (8.4%) | 6.2% | 89.8% | ₹572 / −₹4,528 | +₹51 / −₹107 | ₹8,767 |
| SENSEX D, early, 0.5 EM, N 4 | 169 | ₹1,794 (17.5%) | 20.5% | 67.5% | ₹1,364 / −₹4,091 | −₹407 / −₹920 | −₹69,553 |
| SENSEX M, hold, 1.0 EM, N 2 | 134 | ₹658 (8.7%) | 5.3% | 90.3% | ₹613 / −₹4,016 | +₹162 / +₹67 | ₹21,917 |
| SENSEX M, early, 1.0 EM, N 2 | 134 | ₹658 (8.7%) | 7.2% | 69.4% | ₹453 / −₹887 | +₹43 / +₹229 | ₹5,738 |

- **What the trade is.** At 0.5 EM the spread collects about a sixth of its width (₹1,600–1,900 a NIFTY lot). Held to expiry it wins about four weeks in five; the average loss is about three and a half average wins, and about one expiry in eight the whole width goes.
- **Where the money went** (NIFTY daily, held, conservative): the short put made +₹397 a trade gross, the long put −₹215, charges −₹56 and the spread −₹27: +₹100 a trade (net ₹ per eligible week +₹99). On the last 40%: −₹173.
- **Against the mirror call spread.** Over the whole sample, the NIFTY picks' mirror call spreads lost −₹107 (D hold), −₹186 (D early), −₹183 (M hold) and −₹211 (M early) a trade at the conservative fill. So the put side did do better, by ₹207, ₹253, ₹110 and ₹50 a trade. But on the last 40% the call spreads did better (+₹150, +₹210, +₹180, +₹257), and the placebo gaps there are negative (§3.1).

### 3.5 By year, half, era and the STT rise

**The ₹5 lakh account at one lot a week** (net ₹, % of ₹5 lakh; conservative fill). 2019 runs from Feb, 2021 on 1-minute bars from Jun, SENSEX's 2023 from May (daily) or Aug (1-minute), and 2026 to 8 Oct (daily) or Jul (1-minute). The lot changed (NIFTY 75 → 50 → 25 → 75 → 65; SENSEX 10 → 20), so years are not comparable in rupees.

| NIFTY pick | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|
| D, hold, 0.5 EM, N 4 | −₹6,452 (−1.3%) | ₹32,977 (+6.6%) | ₹23,932 (+4.8%) | ₹13,561 (+2.7%) | ₹6,776 (+1.4%) | −₹97 (−0.0%) | ₹2,140 (+0.4%) | −₹33,367 (−6.7%) |
| D, early, 0.5 EM, N 3 | ₹5,207 (+1.0%) | ₹40,441 (+8.1%) | ₹7,789 (+1.6%) | ₹10,747 (+2.1%) | −₹5,391 (−1.1%) | −₹19,924 (−4.0%) | ₹9,520 (+1.9%) | −₹21,895 (−4.4%) |
| M, hold, 0.5 EM, N 4 | – | – | ₹19,728 (+3.9%) | ₹3,048 (+0.6%) | ₹3,825 (+0.8%) | −₹3,479 (−0.7%) | ₹3,727 (+0.7%) | −₹45,162 (−9.0%) |
| M, early, 0.5 EM, N 4 | – | – | ₹2,396 (+0.5%) | ₹1,808 (+0.4%) | ₹1,104 (+0.2%) | −₹12,389 (−2.5%) | ₹6,481 (+1.3%) | −₹39,886 (−8.0%) |

| SENSEX pick | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|
| D, hold, 1.0 EM, N 2 | ₹2,998 (+0.6%) | ₹6,517 (+1.3%) | ₹17,724 (+3.5%) | −₹19,981 (−4.0%) |
| D, early, 1.5 EM, N 2 | −₹2,303 (−0.5%) | −₹2,541 (−0.5%) | −₹1,111 (−0.2%) | −₹3,230 (−0.6%) |
| M, hold, 1.0 EM, N 2 | ₹876 (+0.2%) | ₹5,043 (+1.0%) | ₹15,484 (+3.1%) | −₹6,397 (−1.3%) |
| M, early, 1.0 EM, N 2 | −₹3,067 (−0.6%) | −₹3,987 (−0.8%) | −₹2,912 (−0.6%) | ₹3,886 (+0.8%) |

- **The best year on daily closes was 2020**, the year of the COVID crash and the rebound after it: +6.6% and +8.1% of ₹5 lakh at one lot. **2026 was the worst year for every NIFTY pick** (−4.4% to −9.0%).
- **The halves and the eras** (₹ a trade, conservative): NIFTY's held daily pick made ₹312 in the first half and −₹113 in the second; ₹233 to Dec 2024 and −₹336 from Jan 2025. Its 1-minute pick made ₹126 and −₹609 in the two eras. The SENSEX picks are within ±₹170 a trade in both halves.
- **The STT rise of 1 Apr 2026** cannot be judged: only 26–27 daily and 6–7 one-minute trades come after it. NIFTY's held daily pick made ₹116 a trade before (370 trades) and −₹139 after (26); SENSEX's ₹131 before (140) and −₹409 after (27).
- **Scheduled events** (descriptive; WP10 §1.6's list; no filter is tested here). NIFTY's held daily pick made +₹2,742 a trade over 8 Budget weeks, +₹1,154 over 28 RBI weeks and +₹4,054 over 2 election weeks, and −₹64 over the 358 weeks without a scheduled event. Its 1-minute pick: +₹2,431 (6), +₹879 (21), +₹4,309 (1) and −₹248 (224). The event weeks made money and the ordinary weeks lost. This was not a pre-registered variant, so it is not a finding; it would need its own pre-registration and its own sample.

### 3.6 Tails, drawdowns and the named stress dates

**The conservative picks** (one lot; trades in expiry order). "Worst 5% summed" is the sum of the worst 5% of trades as a multiple of the whole net: negative when the net is positive, positive when it is negative.

| pick | 5% VaR / ES | 1% VaR / ES | max drawdown (% of ₹5 lakh), peak → trough | longest losing run | worst 5% summed (× net) | worst mark at a close in the holding period | worst trade |
|---|---|---|---|---|---|---|---|
| NIFTY D, hold, 0.5 EM, N 4 | −₹9,712 / −₹12,114 | −₹13,991 / −₹14,912 | ₹52,469 (10.5%), 21 Aug 2025 → 24 Mar 2026 | 3 | −5.83 | −₹19,234 (expiry 19 Mar 2020) | −₹16,116 (24 Mar 2026) |
| NIFTY D, early, 0.5 EM, N 3 | −₹4,235 / −₹6,272 | −₹8,469 / −₹10,095 | ₹47,933 (9.6%), 14 Sep 2023 → 9 Jun 2026 | 4 | −4.50 | −₹6,135 (15 Apr 2021) | −₹11,050 (19 Mar 2020) |
| NIFTY M, hold, 0.5 EM, N 4 | −₹9,111 / −₹12,218 | −₹13,939 / −₹15,271 | ₹54,697 (10.9%), 26 Sep 2024 → 12 May 2026 | 3 | 8.01 | −₹16,133 (24 Mar 2026) | −₹16,602 (24 Mar 2026) |
| NIFTY M, early, 0.5 EM, N 4 | −₹6,425 / −₹8,572 | −₹10,576 / −₹13,612 | ₹56,235 (11.2%), 14 Sep 2023 → 24 Mar 2026 | 6 | 2.54 | −₹13,196 (9 Apr 2025) | −₹16,648 (24 Mar 2026) |
| SENSEX D, hold, 1.0 EM, N 2 | −₹4,575 / −₹7,118 | −₹10,304 / −₹10,304 | ₹23,501 (4.7%), 5 Mar 2026 → 8 Oct 2026 | 2 | −7.85 | −₹6,255 (8 Apr 2025) | −₹10,304 (12 Mar 2026) |
| SENSEX D, early, 1.5 EM, N 2 | −₹773 / −₹2,390 | −₹5,033 / −₹5,033 | ₹11,976 (2.4%), 21 Jul 2023 → 8 Apr 2025 | 9 | 2.08 | – | −₹5,033 (8 Apr 2025) |
| SENSEX M, hold, 1.0 EM, N 2 | −₹4,608 / −₹6,549 | −₹10,365 / −₹10,365 | ₹15,333 (3.1%), 5 Mar 2026 → 19 Mar 2026 | 2 | −2.62 | −₹6,248 (8 Apr 2025) | −₹10,365 (12 Mar 2026) |
| SENSEX M, early, 1.0 EM, N 2 | −₹2,095 / −₹3,825 | −₹6,942 / −₹6,942 | ₹18,953 (3.8%), start → 8 Apr 2025 | 4 | 3.78 | – | −₹6,942 (8 Apr 2025) |

- The worst marks are at a bhavcopy close strictly between the entry and the exit, before costs; "–" means the holding period has no such close (N = 2 with an early exit).
- **The worst mid-fill pick** was SENSEX's daily early exit at 0.5 EM, N 4: −₹69,553 over 169 trades, a maximum drawdown of ₹77,675 (15.5% of ₹5 lakh, 27 Sep 2024 → 1 Oct 2026).
- **The ten worst trades of NIFTY's held daily pick** (net ₹, NIFTY from entry to expiry, strikes, lot): 24 Mar 2026 −₹16,116 (−3.64%, 23500/23200, 65); 19 Mar 2020 −₹14,629 (−16.99%, 9700/9450, 75); 12 May 2026 −₹13,991 (−3.91%, 24050/23800, 65); 2 Mar 2026 −₹13,525 (−2.20%, 25200/24950, 65); 28 Aug 2025 −₹13,148 (−2.32%, 24900/24700, 75); 4 Nov 2025 −₹12,988 (−1.75%, 25850/25650, 75); 28 Jan 2021 −₹12,673 (−5.30%); 13 Feb 2025 −₹12,160 (−2.24%); 7 May 2020 −₹12,080 (−6.70%); 25 Mar 2021 −₹12,068 (−2.84%). Seven of the ten came from falls of only 1.75–3.91% between entry and expiry.

**The named stress dates** (every trade whose holding period, after the entry and up to the exit, contains the date; conservative fill):
- **The COVID crash, 9–23 Mar 2020** (NIFTY daily only; the 1-minute and SENSEX samples start later):
  - NIFTY's held pick lost −₹9,036 on the 12 Mar expiry (entered 5 Mar; NIFTY −14.90% to expiry) and −₹14,629 on the 19 Mar expiry (entered 13 Mar; −16.99%). It made +₹6,479 on the 26 Mar expiry (entered 20 Mar at 8350/7950, after the fall).
  - Its early-exit pick lost −₹8,469 on the 12 Mar expiry (−4.83% from 6 to 11 Mar).
  - The held daily 1.0 EM spreads lost −₹6,501 to −₹10,013 on the 12 Mar expiry and −₹15,551 on the 19 Mar expiry (N = 4). The mirror call spreads made +₹949 to +₹7,443 in those weeks.
  - With the long put 0.5 EM below the short one, the worst expiry of the crash cost −₹14,629 to −₹15,551 a lot (the width less the credit, plus charges). WP10's naked strangle lost −₹46,000 to −₹93,000 in single weeks of March 2020.
- **The election result, 4 Jun 2024** (NIFTY −5.9% that day, then a recovery):
  - NIFTY's held picks made +₹4,682 (daily) and +₹4,309 (1-minute): entered 31 May at 22200/21850, NIFTY +1.29% (daily) and +1.15% (1-minute) to the 6 Jun expiry.
  - Its daily early-exit pick, entered on 3 Jun at the post-exit-poll high, lost −₹4,235 (−2.77% by 5 Jun).
  - SENSEX's daily early-exit pick at the mid fill lost −₹707.
- **The tariff gap, 7 Apr 2025:**
  - NIFTY: the held picks lost −₹11,897 (daily) and −₹11,879 (1-minute), entered 3 Apr (−3.66% to the 9 Apr expiry). The early-exit picks lost −₹3,653 (daily) and −₹10,576 (1-minute).
  - SENSEX: −₹4,575 (daily hold), −₹5,033 (daily early), −₹4,568 (1-minute hold) and −₹6,942 (1-minute early).
  - The held daily 1.0 EM spreads lost −₹10,314 (NIFTY, N 3), −₹13,456 (NIFTY, N 4), −₹10,758 (SENSEX, N 3) and −₹12,762 (SENSEX, N 4).

### 3.7 Margin and the two accounts

- **Margin** (WP10 §6's approximation, §1.8):
  - The picks needed ₹30,393–33,633 a lot at entry on average, ₹13,355 at the least.
  - Held into the expiry day, the expiry-day 2% (from 20 Nov 2024) raises the peak to ₹78,565–95,540. Closed the day before, the peak is ₹47,282–59,887.
  - Across all configurations (§2.4, no prices) the median at entry is ₹22,000–44,000 a lot and the maximum about ₹60,000.
- **A ₹10,000 account cannot carry one lot of any configuration.** Not one of the entries in §2.4 needed ₹10,000 or less, and the smallest margin among the picks' trades was ₹13,355. The answer does not depend on the P&L.
- **A ₹5 lakh account can carry one lot of every configuration.**
  - Its peak margin is 19.1% of the account (₹95,540) and the largest possible loss on a lot is 4.8% (₹23,959).
  - The deepest drawdown of a conservative pick at one lot a week was 11.2% (₹56,235).
  - At one lot, the most the account made in a calendar year with a conservative pick was +₹40,441 (8.1%; NIFTY daily early exit, 2020). The conservative pick with the largest whole-sample net, NIFTY's held daily spread, made ₹39,469 in all from Feb 2019 to Oct 2026, and lost on its last 40%.

---

## 4. H2: the turn of the month

Long the index from the close of the session before the window to the close of the window's last session, the window being the month's last regular session and the next month's first three (§1.7). Yahoo's official closes; one window a month.

### 4.1 Against the bar

| index | windows (first 60% / last 40%) | last 40% per window (95% CI) | up | PF | window days − other days, last 40%, per window (SE) | p (Bonferroni: 1.51 × 10⁻⁵) | DSR | verdict: fails on |
|---|---|---|---|---|---|---|---|---|
| NIFTY (Sep 2007 – Sep 2026) | 229 (138 / 91) | +53.0 bp (+11.1 … +95.7 bp) | 62.6% | 1.94 | +44.5 bp (24.1 bp; 1.84 SE) | 6.4 × 10⁻³ | 0.115 | FAIL: sample, placebo, robustness (not run), multiple testing |
| SENSEX (Jan 2007 – Sep 2026) | 237 (143 / 94) | +52.2 bp (+10.1 … +95.0 bp) | 62.8% | 1.89 | +45.3 bp (24.6 bp; 1.84 SE) | 7.5 × 10⁻³ | 0.111 | FAIL: sample, placebo, robustness (not run), multiple testing |

- **What passes:** the CI per window (each window a block) and PF ≥ 1.3, on both indices.
- **What fails:**
  - the sample: 91 and 94 windows, against 180 (fixed in §2.6);
  - the placebo: the window days beat the other days by +11.12 bp (NIFTY) and +11.32 bp (SENSEX) a day, × 4 days a window, with a circular block bootstrap SE (blocks of 21 sessions) that leaves them at 1.84 SE;
  - multiple testing: the p-value is 6.4 × 10⁻³ and 7.5 × 10⁻³, and the DSR 0.115 (SR 0.255 a window, SR₀ 0.377) and 0.111.
  - Criterion 5 (the windows [−1, +2] and [−2, +3]) was not run, because the placebo failed.

### 4.2 Detail

| index | sample | windows | per window | 95% CI | up | PF | window days − other days, per window (SE) |
|---|---|---|---|---|---|---|---|
| NIFTY | all | 229 | +56.4 bp | +23.3 … +90.0 bp | 60.7% | 1.79 | +47.9 bp (19.7 bp) |
| NIFTY | first 60% (to 6 Mar 2019) | 138 | +58.6 bp | +12.8 … +106.3 bp | 59.4% | 1.72 | +50.2 bp (28.4 bp) |
| NIFTY | last 40% | 91 | +53.0 bp | +11.1 … +95.7 bp | 62.6% | 1.94 | +44.5 bp (24.1 bp) |
| NIFTY | first half / second half | 115 / 114 | +72.9 / +39.7 bp | +17.8 … +127.4 / +0.5 … +78.1 bp | 61.7% / 59.6% | 1.89 / 1.65 | +66.3 (32.2) / +29.5 (21.2) bp |
| SENSEX | all | 237 | +51.0 bp | +17.5 … +85.1 bp | 60.3% | 1.68 | +40.8 bp (19.6 bp) |
| SENSEX | first 60% (to 5 Dec 2018) | 143 | +50.1 bp | +2.5 … +98.6 bp | 58.7% | 1.59 | +37.9 bp (27.9 bp) |
| SENSEX | last 40% | 94 | +52.2 bp | +10.1 … +95.0 bp | 62.8% | 1.89 | +45.3 bp (24.6 bp) |
| SENSEX | first half / second half | 119 / 118 | +62.2 / +39.6 bp | +6.6 … +118.6 / +4.0 … +76.7 bp | 59.7% / 61.0% | 1.70 / 1.66 | +54.9 (33.5) / +26.7 (20.9) bp |

- **By year** (NIFTY, mean per window): 2007 +271.1 bp (4 windows) · 2008 +0.8 · 2009 +192.5 · 2010 +133.5 · 2011 +44.8 · 2012 +90.8 · 2013 −15.1 · 2014 +88.3 · 2015 +3.3 · 2016 +51.4 · 2017 +36.9 · 2018 −84.3 · 2019 −19.6 · 2020 +140.5 · 2021 +151.1 · 2022 +67.5 · 2023 +102.3 · 2024 +17.1 · 2025 −10.7 · 2026 −7.1 (9 windows). SENSEX follows NIFTY closely: 2024 +9.5, 2025 −15.7, 2026 −4.5 bp.
- **Over the whole sample** the window-day gap is 2.43 SE (NIFTY) and 2.08 SE (SENSEX), but the bar is judged on the last 40%, and multiple testing would fail either way.
- **It has faded**: the second half's mean is 54% (NIFTY) and 64% (SENSEX) of the first half's, and 2024–2026 are near zero or negative.

### 4.3 The near-month future over the window (descriptive)

The nearest future expiring on or after the window's last session, traded at the window's start and end, net of the dated STT on its sale only (no other charges, spread or margin; §1.7):

| index | windows | per window | ₹ per lot: gross / STT / net (95% CI) | profitable | last 40% net ₹ (windows) | by year, net ₹ a lot |
|---|---|---|---|---|---|---|
| NIFTY (Feb 2019 –) | 91 | +46.5 bp | ₹3,510 / ₹189 / ₹3,321 (−₹828 … ₹7,485) | 60.4% | ₹3,162 (90) | 2019 −₹52,955 · 2020 ₹1,37,060 · 2021 ₹1,70,622 · 2022 ₹65,686 · 2023 ₹85,203 · 2024 ₹7,224 · 2025 −₹77,695 · 2026 −₹32,971 |
| SENSEX (May 2023 –) | 38 | −14.2 bp | −₹2,753 / ₹308 / −₹3,061 (−₹9,192 … ₹2,689) | 55.3% | −₹3,061 (38) | 2023 ₹10,997 · 2024 −₹15,513 · 2025 −₹74,088 · 2026 −₹37,706 |

- The CI includes zero on both indices, and 2025–2026 lost on both.
- **No option trade is built on TOM** (§1.7), and TOM fails the bar on the index itself.

---

## 5. Data caveats

1. **The daily closing price is not a traded price.** NSE's is the volume-weighted average of the last 30 minutes, and BSE's is its published close. The M family repeats the rule at 15:20 on real 1-minute bars, and its picks agree in sign: every NIFTY pick loses on the last 40% in both families.
2. **Entries with a credit of ₹0 or less** (counted after the freeze; §9). They come from a thin strike whose close or bar is stale.
   - The example that showed it, NIFTY's 6 Jun 2024 expiry at 1.0 EM, N = 4 (entered 31 May 2024): the short 21850 put closed at ₹83.50 on 3,021 contracts, below the long 21500 put's ₹119.45 on 709,350 contracts, so the "credit" was −₹920 a lot.
   - Such entries are rare and none is in a pick. On daily closes: 8 of the 7,138 bull-put-spread entries across NIFTY's 18 configurations, and 12 of 2,966 across SENSEX's 18 (the same at both fills). On 1-minute bars: none in the 11 cells that run.
   - The rule is mechanical and frozen, so they stay in. A trader would not open a spread at a debit.
3. **The M conservative fill is a hard bound, not an estimate.** Each leg pays the whole 1-minute range at entry, and again at an early exit (WP11 §3.2). The mid fill (the bar's close) pays no spread at all. The verdict is the same at both.
4. **Lots changed** (NIFTY 75 → 50 → 25 → 75 → 65; SENSEX 10 → 20), so rupees by year are not comparable. The NIFTY lot was 50 or 25 for most of 2024 and 75 in 2025, which shrinks 2024's figures against 2025's.
5. **SENSEX's weekly history is short**: May 2023 – Oct 2026 on daily closes, Aug 2023 – Jul 2026 on 1-minute bars. Its last 40% lies wholly in 2025–2026 (§2.6).
6. **The 1-minute extract keeps strikes near the index**, so 7 far M cells did not run (§2.4). On 1-minute bars the 1.5 EM spreads exist only for NIFTY at N = 2.
7. **Margin is WP10 §6's approximation**, not the exchange's SPAN file. The ₹10,000 answer does not depend on fine detail: no entry of any configuration came to ₹10,000 or less (§2.4), and the picks' smallest was ₹13,355.
8. **Settlement** is at the exchange's printed level; where both exist, it agrees with the official close to 0.00 points (§2.2).

---

## 6. The bar, multiple testing and the ledger

- **N = 3,303**: the 3,067 ledger lines before this study plus its 236. Bonferroni's threshold is 0.05 / 3,303 = 1.51 × 10⁻⁵.
- **V[SR] for the deflated Sharpe ratio**:
  - H1: this study's 116 bull-put-spread lines have a Sharpe variance of 5.83 × 10⁻³ (per eligible week, net ÷ ₹5 lakh). The null variance 1/(T − 1) was larger for every pick (6.33 × 10⁻³ at 159 weeks, up to 1.89 × 10⁻² at 54), so it is the one used (§1.6).
  - TOM: the 2 index lines' variance is 3.54 × 10⁻⁴ (per window). The null variance, 1.11 × 10⁻² and 1.08 × 10⁻², was used.
  - Either way the DSR is 0.000–0.115, far from 0.95.
- **The ledger** (`reports/trials.jsonl`): 3,067 → **3,303** lines. All 236 carry `"wp": "WP16"` and unique variant names, none of them a name another work package uses. They were appended once, by the final `--ledger` run:
  - 116 bull put spread lines (kind "strategy"): 72 daily (D), 44 on 1-minute bars (M); 58 configurations × 2 fills;
  - 116 mirror bear call spread lines (kind "placebo");
  - 2 TOM index lines (kind "strategy"; `net` and `meanPerTrade` in index basis points, `params.unit` says so);
  - 2 TOM near-month-future lines (descriptive, ₹ per lot; kind "strategy", as WP15 logged its descriptive lines).
  - No perturbation line: no pick or TOM variant passed criteria 2–4, so no perturbation was run.
- The ledger's first 3,067 lines are unchanged (their SHA-256 before and after: `76c64f10ee978a73654711efdfabd1b56ccaa1847df84dd750c521c26f4df4ff`).

---

## 7. The cross-check and the hand checks

**The independent re-computation** (`scripts/research/wp16-xcheck.py`, standard library only, `python3 -I`; it shares no code with the main script). It rebuilds from the raw files the calendar, the short sessions, the expiries, the settlement levels, the samples and the cuts. Then it rebuilds every D and M configuration's trades at both fills, with its own charge arithmetic, and the TOM windows and daily series.
- **Before the freeze** (`--counts-only`, no price): the calendar (4,895 sessions, 4,865 regular), the four samples and cuts, all 36 per-cell entry counts and the TOM window counts and cuts agree with §2 (§1.10).
- **After the runs** (`--summary` on the final `summary.json`): it agrees on all 116 runs (72 D, 44 M) and both TOM variants.
  - Trade counts, all and last 40%: identical.
  - The mean net of the bull put spread and of the mirror call spread (all trades), and the bull put spread's last-40% mean: to within ₹3.7 × 10⁻¹³.
  - The mean credit: identical.
  - TOM: the window counts are identical, and the means (all and last 40%) and the daily window-day gaps agree to within 1.8 × 10⁻¹⁴ bp.
- **Not re-computed independently**: the bootstrap CIs and p-values, the placebo SEs, PF, the DSR, the tails, the margins, the splits by year, half and era, and the futures windows. These come from the program's shared, unit-tested functions (`metrics.ts`, `expiryCalendar.ts`, `intraday1m.ts`, `overnight.ts`, `shortPremium.ts`) and this study's `putSpreads.ts`.

**By hand** (`debug`: entries, levels, VIX, EM, strikes, the legs' bhavcopy rows and 1-minute bars, fills, charges):
- **NIFTY, 6 Jun 2024, 0.5 EM, N 4, held, daily, conservative.**
  - Entry 31 May 2024: NIFTY 22,530.70, VIX 24.18, EM = 22,530.70 × 0.2418 × √(4/252) = 686.37.
  - The short target 22,187.5 gives 22200; the long target 21,856.8 gives 21850.
  - The 22200 put closed at ₹274.50 and the 21850 put at ₹83.50. The engine's spread (0.4% of premium, rounded up to ticks) is ₹1.10 and ₹0.35, so the fills are ₹273.40 and ₹83.85: credit (273.40 − 83.85) × 25 = ₹4,738.75.
  - Settlement 22,821.40, so both legs expired worthless. Charges ₹56.81; net +₹4,681.94.
- **NIFTY, 19 Mar 2020, 0.5 EM, N 4.**
  - Entry 13 Mar 2020: NIFTY 9,955.20, VIX 41.16, EM 516.24, strikes 9700/9450.
  - Credit at the closes (271.55 − 212.10) × 75 = ₹4,458.75. Settlement 8,263.45, so the spread is worth its full 250 points: −₹18,750.
  - With the exercise STT on the long put's intrinsic value, charges ₹191.99 and net −₹14,629.49 at the conservative fill.
- **SENSEX, 7 Jun 2024, 0.5 EM, N 2, held, daily, mid.** Entry 5 Jun 2024 at 74,382.24, VIX 26.75, EM 1,772.59; strikes 73500/72600 (targets 73,495.9 and 72,613.7, steps of 100). Credit (359.60 − 151.80) × 10 = ₹2,078. Settlement 76,693.36, so both legs expired worthless; charges ₹52.51, net +₹2,025.49.
- **NIFTY, 24 Mar 2026, 0.5 EM, N 4, held, daily** (the worst trade). Entry 18 Mar 2026 at 23,777.80, VIX 19.79, EM 592.85; strikes 23500/23200. Credit at the closes (124.85 − 70.70) × 65 = ₹3,519.75. Settlement 22,912.40, so the spread is worth its full 300 points: −₹19,500. At the conservative fill the credit is ₹3,467.75, the spread ₹52 and charges ₹84.13: net −₹16,116.38.

---

## 8. Paper-test spec

**None. Nothing passes every criterion**, so no paper-test spec is written and the engine stays PAPER, unchanged. No pick even passed criteria 2–4 (the placebo, the CI and PF), so the robustness step never ran.

---

## 9. What changed after the freeze

The freeze is commit `853017c` (10 Oct 2026, 16:56 UTC).
- **No definition changed.** No variant, perturbation, sample, cut, fill, charge or criterion was added, removed or altered, and §1–§2 are byte-identical to the freeze.
- **One descriptive count was added to the main script**: entries whose bull put spread (or mirror) credit at the entry fills is ₹0 or less (`Econ.creditNonPos`).
  - It is printed in the picks' economics lines, the mirror lines and the per-configuration tables (§3.3, §5).
  - It came from the first hand check, which showed a negative credit (NIFTY, 6 Jun 2024, 1.0 EM, N 4).
  - It changes no trade, statistic, pick or verdict, and no ledger line.
- **The development run was therefore repeated.**
  - The first development run (before the addition) and the second have identical `summary.json` apart from the new field (checked by comparing the two with that field removed).
  - The second development run and the final `--ledger` run are byte-identical: `tables.md` SHA-256 `54c4b52d9cd27ab9aeaf8fedf10ac6b180e1ed83bffe7a7022bc70f286119bd1`, `summary.json` `65b7644b3552dc42299adff18c9afa96d431af00b1dc7cb31021467d323bd356`.
- **The cross-check script did not change after the freeze.** Its fix for BSE's header-only files was made and recorded before it (§1.10).
- **No errors were found** in the frozen definitions or in the results.
- **In this report, not the code**: the generated tables print a negative SE multiple with a hyphen ("-0.53"), and the tables here print it with a minus sign ("−0.53"). This is typography only.

---

## 10. Reproduce

```bash
S=<scratchpad>; B=<the compact NSE and BSE bhavcopy cache>; Y=$S/research/q2/data/yahoo
IN="--nsei $Y/^NSEI_1d_since2007.json --bsesn $Y/^BSESN_1d_since2007.json --vix $Y/^INDIAVIX_1d_since2007.json \
    --x $S/wp11/data/x13 --dir $B --oi $S/wp14/raw/participant_oi"
# Inputs reused from earlier packages: Q2's Yahoo daily bars, WP13's 1-minute extract ($S/wp11/data/x13),
# the bhavcopy cache (WP6, with BSE from 15 May 2023) and WP14's participant-OI files (their names only).
# 1. Sessions, expiries, samples, cut dates, strike placement, bar presence and margins (no prices; §2):
NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/research/wp16-put-spreads.ts coverage $IN --out $S/wp16/out
# 2. The whole pipeline on synthetic numbers (no data-derived values; no ledger); --smoke-bias 0.05 also runs the robustness paths:
NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/research/wp16-put-spreads.ts run --smoke $IN --out $S/wp16/out_smoke
# 3. Every configuration, the walk-forward picks, the bar, the tails and TOM: a development run, then the final run that
#    appends the ledger lines once. Their tables.md and summary.json must be byte-identical. A later rerun appends nothing;
#    against the ledger as committed here, only the ledger counts differ (tables.md's "Ledger:" line, summary.json's ledgerBefore):
NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/research/wp16-put-spreads.ts run $IN --out $S/wp16/out_dev
NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/research/wp16-put-spreads.ts run $IN --out $S/wp16/out_final --ledger
cmp $S/wp16/out_dev/tables.md $S/wp16/out_final/tables.md && cmp $S/wp16/out_dev/summary.json $S/wp16/out_final/summary.json
# 4. One expiry by hand (entries, levels, VIX, EM, strikes, the legs' bhavcopy rows and 1-minute bars, fills, charges):
npx tsx scripts/research/wp16-put-spreads.ts debug $IN --index NIFTY --expiry 2020-03-12
# 5. The independent re-computation (standard library only; --counts-only reads no price):
python3 -I scripts/research/wp16-xcheck.py $Y/^NSEI_1d_since2007.json $Y/^BSESN_1d_since2007.json $Y/^INDIAVIX_1d_since2007.json \
  $S/wp11/data/x13 $B $S/wp14/raw/participant_oi [--counts-only] [--summary $S/wp16/out_final/summary.json]
# 6. Unit tests of the new pure helpers:
npx vitest run src/engine/backtest/putSpreads.test.ts
```

| file | what it holds |
|---|---|
| `scripts/research/wp16-put-spreads.ts` | The `coverage`, `run` and `debug` commands: the calendar, the expiries and settlement levels, the samples and cuts, families D and M of the bull put spread and its mirror, the statistics, the picks and the bar, the tails and margin, TOM and its future, the ledger and the tables; `--smoke` replaces every price-derived value with a hashed synthetic number |
| `scripts/research/wp16-xcheck.py` | The independent re-computation |
| `src/engine/backtest/putSpreads.ts` (+ `.test.ts`) | The new pure helpers, with tests: `spreadStrikes`, `spreadWidth`, `spreadValueAt`, `spreadMargin`, `weekKey`, `nthSessionBefore`, `spreadEntry`, `spreadExit`, `tomWindows`, `meanGapBootstrap`, `futuresSttPct` |

- **Reused code.**
  - The bhavcopy loaders come from `real_prices.ts`; the 1-minute loaders, `lotOf` and the formatting from `wp11-real-intraday.ts`.
  - `structurePnl`, the dated charges, `scaledSpread`, `strikeBeyond`, `intrinsic`, `maxDrawdown` and the event calendar come from WP10's `shortPremium.ts`.
  - `syncMinute`, `cutDate`, `pickBest`, `robustness`, `overallVerdict` and `blocksOf` from WP13's `expiryCalendar.ts`; `fillPrice` and `pairedGap` from WP11's `intraday1m.ts`; `tailRisk` from WP15's `overnight.ts`.
  - The day-block bootstrap, profit factor and the DSR from `metrics.ts`; the ledger from `trials.ts`.
- **Isolation.** Nothing in the engine imports the new code.
- **Data.** No market data is committed. The generated `coverage.md`, `coverage.json`, `tables.md` and `summary.json` stay in the scratchpad.
