# NIFTY and SENSEX options: why most people lose, where an edge can exist, and our plan

Prepared Friday 9 October 2026 (IST) from four web-research notes, two studies on our own market data, and the strategy planner's diagnosis of our engine. The full notes, with every source and date, are in [`notes/`](notes/). Figures below carry a short source tag; "our data" means Yahoo Finance bars replayed in this repo.

---

## 1. The short answer

1. **Most people lose because buying options is the losing side of a game that is zero-sum before costs.** SEBI's August 2026 studies: 87.7% of individual F&O traders lost money in FY26 (₹91,685 crore); 92% of the losses came from options; 97% of individuals are mostly option *buyers*; the median option-only buyer lost 114% of the capital they used in the year. The other side is algorithmic prop desks and foreign funds: 99% of their profit came from entities that trade by algorithm, mostly as market makers and net option sellers. [R1]
2. **Our engine is doing the same thing today.** Over 23 Jul–8 Oct it lost ₹188 per trade; random entries with the same rules lose ₹402 per trade. The difference is inside the noise: the current signals are statistically indistinguishable from random entry. [PLAN §1]
3. **There is no published example of a reliably profitable strategy that buys index options intraday.** For NIFTY, intraday long-option returns are about zero before costs (Bhat, Pandey & Rao 2024, NSE 2017–2020); the premium sellers earn is mostly earned overnight. [PLAN §2]
4. **What the evidence does support is a short list of rules** that remove the most expensive trades and keep the buyer only in the situations where buyers have been paid. That is the plan below: trade far less, pay less for each trade, ignore folklore signals, and prove every rule on data the rule never saw before risking real money.

---

## 2. Why most people lose (ranked by evidence)

| # | Reason | Key evidence |
|---|---|---|
| 1 | **Buying options is the structurally losing side.** | Options = 92% of losses; loss rate 91% for option traders vs 68% for futures traders; option-only buyers' median return on capital −114% (FY26), −187% (FY25). [R1: SEBI Aug 2026] |
| 2 | **Time decay plus the volatility risk premium:** the buyer pays for more movement than usually happens. | NIFTY implied vol exceeded the vol that followed on 74.9% of days (Aug 2022–Mar 2026), by +1.21 vol points on average; on the other 25.1% buyers were paid, and paid more. [R2: Agarwal 2026, preprint] Our backtest: a flat index costs ≈₹300 per trade. |
| 3 | **Costs.** | ₹25,000 crore a year paid by individuals; costs were 35% of losers' gross losses in FY26; option STT rose to 0.15% of premium from 1 Apr 2026. [R1] |
| 4 | **Trading the last day or two of a contract.** | 59% of index-option turnover is on expiry day, 97% within a week; an ATM premium is typically a fifth or less of the previous close 30 minutes before expiry. [R1: SEBI] |
| 5 | **Buying cheap far-out-of-the-money "lottery" strikes.** | Highest decay per rupee, widest spreads, worst returns; when lots grew, small traders moved further OTM and did worse. [R1, R2] |
| 6 | **Overtrading.** | Loss rate and loss size rise with turnover; traders active >100 days a year are 42% of traders and 87% of losses. [R1] |
| 7 | **Chasing moves that already happened.** | Our engine: right only 37% of the time 15–30 minutes after entry. Trend indicators describe the past; none predicts NIFTY's next move in tests. [R3, PLAN] |
| 8 | **Experience does not fix it.** | 90–92% of two-year losers who kept trading lost again; 0.5% of five-year traders were profitable every year. [R1] |
| 9 | **Expiry-day games by large players.** | SEBI's 2025 interim order alleges Jane Street moved Bank Nifty on expiry days against option buyers; the case is ongoing (tribunal ruling due 21 Oct 2026). A real but bounded factor. [R1] |

---

## 3. Where an edge can exist — and where it can't

| Who | Edge | Can we use it? |
|---|---|---|
| Market makers, latency algos | Earn the bid–ask spread retail pays; speed | No |
| Option sellers | Collect the volatility premium most days, mostly overnight | Not on the ₹5k/₹10k accounts (needs margin; losing sellers lost ₹51.7 lakh each on average in FY26; retail short-vol on NIFTY was negative after costs). Research only on the ₹5 lakh paper account (§9, WP7). |
| **Option buyers** | Paid on the minority of days when the index moves **more than the option price assumed**, and on unscheduled shocks | **Yes, if we can be present on those days and absent on the rest.** That is the whole strategy. |

---

## 4. When NOT to enter (hard rules)

Each rule removes trades; none adds trades. Each is tested on our data before it goes live (§9).

| Rule | Why | Source |
|---|---|---|
| **N1. No new position the session before a scheduled event** (Budget, RBI policy, election results, major US data), and none in the ±30 min around it. | Premium is bid up before and falls on the day: India VIX fell on Budget day in 15 of 15 Budgets (−9.3% on average); long straddles lost at nearly every Budget entry time. | R2 |
| **N2. No entry when India VIX has just jumped** (> +8% on the day) or sits above its 20-day high. | Buyers pay the top of the volatility; India VIX falls back fast after spikes. | R2 |
| **N3. No entry in the first 15–30 minutes** unless the first 15-minute candle is decisive (see E2). | Implied vol is highest after the open; price came back to the first candle's breakout level on 99.9% of days (2017–2026 study), so stops at the range edge get hit. | R2, R4 |
| **N4. Never buy a contract with 2 or fewer days left.** On Mondays use next week's NIFTY contract; on Wednesdays next week's SENSEX contract; otherwise skip. | A 1-day NIFTY ATM option loses ≈₹595 a lot on a flat Monday vs ≈₹250 for the 6-day contract (model). Our engine currently buys the 1-day contract on these days. | R2 |
| **N5. No overnight or weekend holds.** | A 4-day ATM option bought Friday is worth about half by Monday's close if the index doesn't move (model); overnight is where sellers earn the premium. | R2, R1 |
| **N6. No far out-of-the-money strikes because they are cheap.** | Worst returns per rupee; two-thirds expire worthless if held. | R1, R2 |
| **N7. No new entry on an index's own expiry day after 14:00**, and never the contract expiring that day. | Expiry-day gamma and settlement games. (Already in the engine.) | R1 |
| **N8. No buying puts the morning after a big fall "because FIIs sold".** | FII selling is published after the close and describes the same day. Our data, 2019–2026: FPI flow vs the next day's open→close has correlation 0.00 (1,877 days); after the 102 days of FPI selling worse than −₹5,000 crore, the next day favoured puts only 44% of the time; after a >1% NIFTY fall with heavy selling, the next open→close averaged +0.22% (42 days). After NIFTY days below −1.5%, the next day was up 64% of the time (2020–2026). | R3, Q2 |
| **N9. Don't trade the gap itself.** | The opening gap is known by 09:10 and is in the 09:15 price. Our data, 2011–2026: gap-up days closed above their open 48% of the time (1,639 days), gap-down days 48% (783); a "follow or fade" rule chosen on 2011–18 scored 49.5–51.4% on 2019–26. | R4, Q2 |

---

## 5. When premiums are at their highest (avoid paying then)

- **Before scheduled events** (Budget, RBI, results, US CPI/Fed), then they collapse on the day. [R2]
- **Right after the open** on ordinary days, then they settle over the first 30–60 minutes. [R2, R4; India-specific intraday IV data: §10, Q1]
- **After a VIX spike** (8 Oct: India VIX +10.3% to 15.31, so today's premiums are about 10% richer for the same move). [R3, R4]
- **Mondays**, which show a positive India VIX day-of-week effect, and the **last 2 days** of any contract, when decay accelerates. [R2]
- **Per rupee, far out-of-the-money strikes** always carry the richest premium. [R2]

---

## 6. When to enter (all must hold)

| Condition | Rule | Status |
|---|---|---|
| **E1. Options are cheap relative to how the market is moving** | Recent realized volatility ≥ implied (ratio 1.0–1.5), or a HAR-RV forecast (Corsi 2009) ≥ VIX-implied variance | Published model; being built and tested (WP5) |
| **E2. Direction confirmed early, not chased** | Either the first 15-minute candle is large (> 0.24%) and we trade in its direction after 09:30, or price breaks the published "noise area" band at a half-hour mark (Zarattini, Aziz & Barbon 2024) | First-candle rule: 73% day-direction agreement in a 2017–2026 non-peer-reviewed study (R4), checked on our data in Q2. Noise area: being built (WP3). |
| **E3. The expected move beats the cost of the trade** | An honest expected move (calibrated on realized moves, not on VIX × 1.1) must exceed the break-even of ≈9 NIFTY / ≈31 SENSEX points plus charges | The current gate overstates moves about 2.4× (PLAN §1.3); being fixed (WP2) |
| **E4. No rule in §4 applies** | — | — |
| **E5. One bet at a time across NIFTY and SENSEX** | They move together (5-minute return correlation 0.965 outside the closing auction); two positions are one bet twice | To be tested; the quick test so far made results worse, so not adopted yet |

---

## 7. Which option, and whether to hold to expiry

- **Strike: at the money or one strike in the money (delta 0.5–0.7).** OTM carries the most premium per rupee and the fastest percentage decay. [R2]
- **Expiry: at least 4 calendar days left, ideally 6–8.** Flat-session cost per NIFTY lot ≈ ₹416 at 2 days, ₹250 at 6, ₹221 at 8 (model). Beyond 7 days liquidity is thin (3% of turnover), so always use limit orders. [R2]
- **Holding period: the same day, exit on target, stop or time.** A 45-minute time stop cut the cost of a no-edge trade from ≈₹400 to ≈₹295 (random-entry test). [PLAN]
- **"Enter now and wait till expiry for the most benefit" is not supported.** Holding to expiry pays the whole premium plus the steepest last-day decay; held-to-maturity NIFTY options lose across moneyness (Pillai 2026, preprint), and "big-move" expiry bets on scheduled events mostly lost. The only case for holding is a well-founded view that the move will exceed what the straddle already prices, and even then the evidence is weak. [R2]
- **₹5k/₹10k accounts:** their premium bands (NIFTY ₹40–60/70, SENSEX ₹130–222) land on the worst region: ~+200 points OTM at 6 days (delta ≈0.3) or near-ATM at 1–2 days. Rule: trade only when every entry condition holds, take the highest delta in the band on the longest-dated contract, never the 1–2-day contract, and **skip the day when no lot with delta ≥ 0.30 and ≥ 4 days left fits.** SENSEX's lot rises to 25 for January 2027 expiries; re-derive the band then. [R2, R1]

---

## 8. Reading trends and "selling pressure": what works and what doesn't

| Signal | What it actually predicts | Use |
|---|---|---|
| India VIX level | **Size** of moves, not direction: predicts tomorrow's high–low range with out-of-sample R² 0.31 (2 years) to 0.41 (2011–2026); ADX adds nothing once VIX is known (+0.00–0.03) | Premium/expected-move gate; strike, stop and target distances |
| Big move yesterday (≥1.5%) | Mild next-day **reversal** in 2020–2026 (64% up after −1.5% days; 74% after −2% days) | "No chasing" rule N8 |
| FII/DII cash flows | **Same-day** relation (correlation 0.32 with that day's NIFTY return); **none for the next day** (0.00 for the next open→close, 1,877 days, 2019–2026); 5- and 20-day flows follow past returns (0.51–0.61) and don't predict the next 5–20 days. FPIs sold ₹1.28 lakh crore in 2024 and ₹2.39 lakh crore in 2025 while NIFTY rose 8.8% and 10.5%. | Context only, zero weight for direction |
| FII index-futures long/short (participant OI) | Untested multi-week positioning claims (FIIs net short a record 333+ sessions) | Context; candidate for a long-horizon test |
| Put–call ratio | Only at ≥12-day horizons (2001–2013 data); sign not reported | Not intraday |
| Max pain, OI "build-up" labels | Nothing (one 19-expiry check: worse than "no change") | Drop |
| ADX, moving averages, Supertrend, RSI, EMA crossovers | Our data: price vs 20/50/200-day averages, EMA 9/21, +DI/−DI, ADX > 25, RSI > 50 called the next day's direction 41–52% out of sample — none beat "always down" (52%). Only RSI extremes (> 70 or < 30) had a small contrarian tilt (55.8% out of sample, 260 days, worth ~5–15 points — less than option costs). Literature: 50/200-day crossover 4.0%/yr vs 9.9% buy-and-hold (2010–2022). | Describe the state; never the entry trigger |
| Opening-range breakout | The only costed NIFTY-options intraday test: buying won ≈48% with a 45% drawdown; selling the same break was much smoother | Tested as published (WP4) |
| Advance–decline breadth | Explains the same period's move, not the next | Confirmation only |

The 8 Oct example: FIIs sold ₹12,943.58 crore (NSE provisional; the depository-confirmed figure was −₹6,206 crore). NIFTY *opened flat* (−4 points) and fell during the day; the FII number came out after the close. Puts paid because of an intraday trend that no pre-open number showed. [R3, R4]

---

## 9. Before the open: can we know gap-up or gap-down?

**Yes, the open is knowable; the day is not.**

- **GIFT Nifty** trades from 06:30 IST; NSE IX publishes it live (no key). Read it at 09:05–09:12 and adjust for the futures basis: implied open = GIFT price − (NSE NIFTY futures close − spot close). The naïve "GIFT minus spot close" overstates the gap by the basis (today ≈ 60 points). [R4]
- **NSE pre-open auction (09:00–09:12)** publishes an indicative NIFTY open that is, by construction, the opening price after the 09:08–09:10 random close. [R4]
- **From global markets alone, at 09:00:** a four-input model (S&P futures since 15:30 IST, Asian mornings, the rupee, crude) called the gap's direction right on **71%** of days walk-forward (457 days); when it called a gap beyond ±0.3% (37% of days) it was right **87%**; typical miss ≈ 72 points. Rule of thumb: **NIFTY gap ≈ 0.4 × the S&P-futures % move since 15:30 IST.** Over 15 years the US session's direction matched NIFTY's gap 68–70% of the time, 82–89% when the S&P moved more than 1%. [Q2]
- **But the gap is already priced at 09:15.** Gap direction gave no edge for the rest of the day (48% of 1,639 gap-up days closed above the open, 2011–2026). Gaps of 0.5% or more pulled back in the first hour on 61% of days, by only ≈ 25 points (weaker since Aug 2025); big gaps (≥ 1%) rarely fill (7–26%). [Q2, R4]
- **Today's check:** at 09:00 the model said +0.09%; GIFT Nifty said +0.3 to +0.5%; NIFTY opened at 22,316.80, **+0.38%**. GIFT was the better guide, as expected for a contract that trades from 06:30.
- **What to do with it:** use the pre-open to decide *whether* to trade (small implied gap and no news → no early trade; big gap → expect fade or stabilisation, wait for 09:30), then let the first 15-minute candle decide direction (E2).

---

## 10. What our own data says

_[Q1 — premium timing, variance risk premium, hold-to-expiry grid on our data: pending]_

**Q2 — gaps, trend indicators and FII flows** (Yahoo daily 2007–2026, hourly 2 years, 5-minute 60 days; NSDL FPI flows 2019–2026; every rule fitted on an earlier period and scored on a later one) [notes/q2-gaps-trend-flows.md]:

| Question | Answer from our data |
|---|---|
| Can the gap be known before 09:15? | Direction right 71% at 09:00 from global markets (87% on clear calls); exactly at 09:08 from the pre-open auction |
| Does the gap say CE or PE for the day? | No: 48–50% |
| Do ADX, moving averages, EMA crosses or RSI call tomorrow's direction? | No: 41–52% out of sample; RSI extremes a 55.8% contrarian tilt worth less than costs |
| What predicts tomorrow's *range* (what a buyer needs)? | India VIX (R² 0.31–0.41); ADX adds nothing |
| Does heavy FII selling predict the next day? | No: correlation 0.00 with the next open→close; after big sell days puts won 44%, and after a >1% fall with heavy selling the next day bounced +0.22% on average |
| Engine bug found | The built-in gap model (`features.gapBetas`) overstates the gap ≈ 2.1× (actual = 0.48 × predicted; the fitting routine is never called), biasing the GAP and GLOBAL_BETA signals; re-fitted weights ≈ ES 0.40, USDINR −0.9, Nikkei 0.06, Hang Seng 0.07 |

---

## 11. The daily routine

| Time (IST) | What | Decides |
|---|---|---|
| 18:30–19:30 (day before) | FII/DII provisional, FII derivatives positions, F&O bhavcopy (futures basis), events calendar for tomorrow | Context; event-eve rule N1 |
| 06:30–09:05 | GIFT Nifty (basis-adjusted implied gap), US close, Asia, crude, USDINR, VIX | Expected gap and regime |
| 09:00–09:12 | NSE pre-open indicative open | The open, almost exactly |
| 09:15–09:30 | **No trades.** Watch the first 15-minute candle and IV settling | E2 |
| 09:30–14:30 | Entries only when E1–E5 hold; decisions at half-hour marks | Entry |
| During the trade | Index-level stop, premium stop, 45-minute time stop if the index goes nowhere | Exit |
| 15:05 | Square off everything (no overnight) | — |
| Weekly | Review paper results against the random-entry baseline | Kill or keep |

---

## 12. What we are building and how it must prove itself

Work in progress (each in its own branch, flags off by default, live engine unchanged during market hours):

| Package | What |
|---|---|
| WP0 | Evaluation harness: random-entry baseline, bootstrap confidence intervals, copy-delay costs, multiple-testing control, a pass/fail report |
| WP1 | Data fix: ignore the closing-auction bars (from 15:15) in indicators; start a nightly archive of 5-minute data |
| WP2 + WP5 | Honest expected-move gate; HAR-RV "options are cheap" gate |
| WP3 + WP4 | Two published strategies exactly as published: noise-area intraday momentum; 5-minute opening-range breakout |
| WP6 + WP7 | Real option prices from NSE/BSE daily files (3+ years, no keys) to replace model prices in tests; overnight option-selling study for the ₹5 lakh paper account only |
| Next | The rules from §4 and §6 that are not yet covered (N2–N4, N8, E2 first-candle) as switchable rules, tested the same way; re-fit the gap model's weights (a demonstrated bug: gaps overstated ≈ 2.1×) |

**A rule or strategy goes live on a paper account only if, on data it was not fitted to,** it has ≥ 180 trades, beats random entry by at least 2 standard errors, has a bootstrap 95% confidence interval above zero per trade and per day, profit factor ≥ 1.3, survives ±20% parameter changes, includes the cost of copying by hand a few minutes late, and passes an independent review for look-ahead bias. Every variant tried is logged and the bar rises with the number tried.

**Ship plan:** after 15:30 IST today only the harness, the data fix (if its before/after shows it only removes artefact-driven decisions) and the data fetchers; strategy modules stay switched off. Nothing changes the main account's behaviour during market hours.

---

## 13. Real money

Until a variant clears §12, **copying trades with real money has negative expected value** — the engine is indistinguishable from random entry, and the base rate for this activity is roughly 9 in 10 losing. If you copy anyway: use the ₹5k account's caps (≤ ₹1,500 a day, one lot, stop after one loss), only on trades that also satisfy §4, and treat it as the cost of learning.

---

## 14. Today, Friday 9 October

- GIFT Nifty at ~08:55 implied a **+0.3% to +0.5% gap-up** after Thursday's −1.64%; US tech fell, US futures firmer, Hong Kong up, Japan down; Brent ≈ $103; India VIX 15.31 after a +10% jump, so premiums are rich (N2). [R4]
- Contracts: NIFTY's Tuesday 13 Oct contract has 4 days left (allowed); SENSEX's Thursday 15 Oct has 6. It is Friday, so nothing is held over the weekend (N5).
- By the rules above: no trade before 09:30; trade only if the first 15-minute candle is large and in one direction and the expected move clears costs; otherwise no trade today.
- The live paper engine still runs the old rules today; the new rules are tested after the close.

---

## Notes and sources

- [R1 — why retail loses, who wins, SEBI studies, Jane Street case](notes/r1-why-retail-loses.md)
- [R2 — premium timing, decay, which option, hold to expiry](notes/r2-premium-timing.md)
- [R3 — trend, flow and options-market signals: evidence vs folklore](notes/r3-signals-evidence.md)
- [R4 — GIFT Nifty, pre-open auction, gaps, data sources](notes/r4-preopen-gaps.md)
- [PLAN — diagnosis of our engine, published strategies, acceptance criteria, work packages](notes/strategy-plan.md)
- [Q2 — gaps, trend indicators and FII flows on our data](notes/q2-gaps-trend-flows.md)
- Q1 — premium timing on our data (added when complete)
