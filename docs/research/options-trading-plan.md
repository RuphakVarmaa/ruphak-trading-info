# NIFTY and SENSEX options: why most people lose, where an edge can exist, and our plan

Prepared Friday 9 October 2026 (IST) from four web-research notes, two studies on our own market data, and the strategy planner's diagnosis of our engine. The full notes, with every source and date, are in [`notes/`](notes/). Figures below carry a short source tag; "our data" means Yahoo Finance bars replayed in this repo.

---

## 1. The short answer

1. **Most people lose because buying options is the losing side of a game that is zero-sum before costs.** SEBI's August 2026 studies: 87.7% of individual F&O traders lost money in FY26 (₹91,685 crore); 92% of the losses came from options; 97% of individuals are mostly option *buyers*; the median option-only buyer lost 114% of the capital they used in the year. The other side is algorithmic prop desks and foreign funds: 99% of their profit came from entities that trade by algorithm, mostly as market makers and net option sellers. [R1]
2. **Our engine is doing the same thing today.** Over 23 Jul–8 Oct it lost ₹188 per trade; random entries with the engine's own contract choice, one-lot sizing, entry window and exits lose about ₹378 per trade (±₹50). The engine's advantage over random (₹190 a trade, ₹265 with the copy delay) is inside the noise: the evaluation protocol needs +₹885 to call it real, and the bootstrap 95% interval for the engine's own result runs from −₹884 to +₹849 per trade. The current signals are statistically indistinguishable from random entry. [PLAN §1, WP0]
3. **There is no published example of a reliably profitable strategy that buys index options intraday, and real NSE prices agree.** Bhat, Pandey & Rao (2024, NSE 2017–2020) found intraday long-option returns of about zero before costs; our replication on exchange prices is worse for buyers: an at-the-money straddle bought at the first trade and valued at the official closing price lost 3.1% a day before costs on NIFTY (2019–2026, t −5.7) and 5.5% on SENSEX (2023–2026, t −6.9), or 4.5% and 6.9% after charges and spreads [WP6]. On real exchange prices for 2024–2026, an at-the-money NIFTY weekly bought at the open lost ₹547 per lot on average when sold at the close (37% of trades profitable) and ₹1,153 when held to expiry (33% profitable; half expired worthless). With perfect hindsight on direction the same option made +₹3,027: **direction is everything, and nothing we tested predicts it.** [PLAN §2, Q1]
4. **What the evidence does support is a short list of rules** that remove the most expensive trades. **What it does not yet give us is a validated way to pick direction** — every candidate entry trigger we checked was a coin flip once measured from the moment a trader could actually enter (§6). So the plan is: trade far less, pay less for each trade, ignore folklore signals, test the published candidates properly, and risk no real money until one passes.

---

## 2. Why most people lose (ranked by evidence)

| # | Reason | Key evidence |
|---|---|---|
| 1 | **Buying options is the structurally losing side.** | Options = 92% of losses; loss rate 91% for option traders vs 68% for futures traders; option-only buyers' median return on capital −114% (FY26), −187% (FY25). [R1: SEBI Aug 2026] |
| 2 | **Time decay plus the volatility risk premium:** the buyer pays for more movement than usually happens. | NIFTY implied vol exceeded the vol that followed on 74.9% of days (Aug 2022–Mar 2026), by +1.21 vol points on average; on the other 25.1% buyers were paid, and paid more. [R2: Agarwal 2026, preprint] Real prices 2024–2026: of the ₹547 an ATM NIFTY lot lost on average per same-day trade, only ≈ ₹106 was charges and spread — the rest was decay the index's movement didn't pay back; realized variance was 0.82× what VIX implied over 2 years (0.86× over 10). [Q1] |
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
| Option sellers | Collect the volatility premium most days. On our exchange prices it is earned during the session, not overnight: the ATM straddle buyer lost 3.1% (NIFTY) and 5.5% (SENSEX) a day open→close, while close→open was flat for NIFTY (0.0%, t 0.0) and slightly in the buyer's favour for SENSEX (+1.6%, t 2.0). [WP6] | Not on the ₹5k/₹10k accounts (needs margin; losing sellers lost ₹51.7 lakh each on average in FY26; retail short-vol on NIFTY was negative after costs). The overnight iron-fly study for the ₹5 lakh paper account (WP7) is a **no-go**: end-of-day files can't price it (opening prints imply buy-back values no real position could get on 17% of NIFTY and 40% of SENSEX nights), and even the favourable reading is flat or negative in 2024–26. |
| **Option buyers** | Paid on the minority of days when the index moves **more than the option price assumed**, and on unscheduled shocks | **Yes, if we can be present on those days and absent on the rest.** That is the whole strategy. |

---

## 4. When NOT to enter (hard rules)

Each rule removes trades; none adds trades. Each is tested on our data before it goes live (§9).

| Rule | Why | Source |
|---|---|---|
| **N1. No new position the session before a scheduled event** (Budget, RBI policy, election results, major US data), and none in the ±30 min around it. | Premium is bid up before and falls on the day: India VIX fell on Budget day in 15 of 15 Budgets (−9.3% on average). On real prices, an ATM straddle bought the evening before each of the last 3 Budgets lost 41–80% (0 of 3 profitable); RBI days were roughly fairly priced (−2%, 7 of 16 profitable); the 2024 election result (+126%) was the exception nobody could schedule. | R2, Q1 |
| **N2. No entry after a volatility jump or a big run:** India VIX up > 10% over 5 sessions (or > 8% on the day), VIX in the top third of its 1-year range, or the index moved > 2% over 5 days. | Real prices, ATM straddle bought at the open (2024–2026): −₹2,269 after a VIX jump, −₹1,526 with VIX in its top third, −₹1,637 after a 2% run — vs −₹1,104 on an average day; held in both halves of the sample. With VIX ≥ 18 the in-session move was only 0.36× what VIX implied (the movement happens in overnight gaps). | R2, Q1 |
| **N3. Trade the morning only: enter after 09:30, be out by 11:15; no entries and no holding through 11:15–14:15.** | The first hour is when NIFTY moves most for the decay it costs (30% of the day's movement in 16% of the time, 719 sessions); from 11:15 to 14:15 the index moves only ≈ 0.7× the decay, in both halves of the sample and for both indices. Waiting for the morning premium to cool does not save money (buying at 09:15, 10:15 or 11:15 and selling at 15:15 cost about the same: ₹642, ₹705, ₹627 per NIFTY lot). The first 15 minutes are skipped only so a direction signal can form; the 09:15 VIX print is stale. Our engine's six 11:00–13:00 entries all lost. | Q1, R4 |
| **N4. Never buy a contract with one session or less left.** On Mondays use next week's NIFTY contract; on Wednesdays next week's SENSEX contract; otherwise skip. | Real prices, bought at the open and sold at the close: share of premium lost 19% on expiry day, 10.6% with one session left, 4.6% (NIFTY) / 7.0% (SENSEX) with 2–5 sessions left — same order in both halves. Our engine currently buys the one-session contract on Mondays (NIFTY) and Wednesdays (SENSEX). | Q1, R2 |
| **N5. No overnight or weekend holds.** | A single long option carries the whole overnight gap (55% of NIFTY's daily variance) and the overnight decay; holding a losing trade past the close made it worse (NIFTY −₹739 more per lot on average, real prices). The overnight leg is not where the premium is lost on average (ATM straddle close→open: NIFTY 0.0%, SENSEX +1.6% for the buyer), so this rule is about gap risk, not a cheaper night. | Q1, WP6 |
| **N6. No far out-of-the-money strikes because they are cheap.** | Worst returns per rupee; two-thirds expire worthless if held. | R1, R2 |
| **N7. No new entry on an index's own expiry day after 14:00**, and never the contract expiring that day. | Expiry-day gamma and settlement games. (Already in the engine.) | R1 |
| **N8. No buying puts the morning after a big fall "because FIIs sold".** | FII selling is published after the close and describes the same day. Our data, 2019–2026: FPI flow vs the next day's open→close has correlation 0.00 (1,877 days); after the 102 days of FPI selling worse than −₹5,000 crore, the next day favoured puts only 44% of the time; after a >1% NIFTY fall with heavy selling, the next open→close averaged +0.22% (42 days). After NIFTY days below −1.5%, the next day was up 64% of the time (2020–2026). | R3, Q2 |
| **N9. Don't trade the gap itself.** | The opening gap is known by 09:10 and is in the 09:15 price. Our data, 2011–2026: gap-up days closed above their open 48% of the time (1,639 days), gap-down days 48% (783); a "follow or fade" rule chosen on 2011–18 scored 49.5–51.4% on 2019–26. | R4, Q2 |

---

## 5. When premiums are at their highest (avoid paying then)

- **Before scheduled events** (Budget, RBI, results, US CPI/Fed), then they collapse on the day. [R2]
- **Right after the open.** India VIX made the day's high in the first hour on 61% of 719 sessions and fell from 10:15 into the close on 65% of days. [Q1, R2, R4]
- **Not Monday mornings, despite appearances:** India VIX reads ≈ 3.8% higher on Monday mornings, but only because VIX counts the weekend as time passing; real option prices barely decay over a weekend, and Monday straddles did no worse than other days (−₹1,108 vs −₹1,104). [Q1]
- **Right after volatility has jumped**, and when VIX is in the top third of its year (see N2). [Q1]
- **On expiry day and the day before:** 19% and 10.6% of the premium lost per same-day trade vs 4.6% with 2–5 sessions left. Real expiry-morning options aren't expensive by implied vol (0.84× VIX) — the index just rarely moves enough in one session to pay for them. [Q1]
- **The last 2 days** of any contract, when decay accelerates. [R2]
- **Per rupee, far out-of-the-money strikes** always carry the richest premium. [R2]

---

## 6. When to enter (all must hold)

| Condition | Rule | Status |
|---|---|---|
| **E1. Options are not expensive relative to how the market is moving** | Recent realized volatility ≥ implied (ratio 1.0–1.5), or a HAR-RV forecast (Corsi 2009) ≥ VIX-implied variance | A cost filter, not an edge: on real prices no condition known at the open (VIX level, recent realized/implied, gap size, weekday) made buying a straddle profitable on average — days with 5-day realized ≥ implied still lost ₹873 per NIFTY trade. HAR gate being tested (WP5). |
| **E2. A direction signal that works from the moment you can enter** | Candidates: (a) a large first 15-minute candle (> 0.24%), entered after it closes; (b) a break of the published "noise area" band at a half-hour mark (Zarattini, Aziz & Barbon 2024) | **Not validated yet.** The often-quoted "73% continuation" counts the candle's own move. Measured from the candle's close on our data: a big *first hour* had no follow-through (48.9% of 319 days, 2 years); a big first 15-minute candle continued 74% of the time but on only 19 days (range 55–87%) — too few to trust. The nightly 5-minute archive (WP1) builds the history to test it; noise area is being built (WP3). Until one passes §12, no entry trigger is trusted. |
| **E3. The expected move beats the cost of the trade** | An honest expected move (calibrated on realized moves, not on VIX × 1.1) must exceed the break-even of ≈9 NIFTY / ≈31 SENSEX points plus charges | The current gate overstates moves about 2.4× (PLAN §1.3); being fixed (WP2) |
| **E4. No rule in §4 applies** | — | — |
| **E5. One bet at a time across NIFTY and SENSEX** | They move together (5-minute return correlation 0.965 outside the closing auction); two positions are one bet twice | To be tested; the quick test so far made results worse, so not adopted yet |

---

## 7. Which option, and whether to hold to expiry

- **Strike: at the money or one strike in the money (delta 0.5–0.7).** OTM carries the most premium per rupee and the fastest percentage decay. [R2]
- **Expiry: at least 4 calendar days left, ideally 6–8.** Flat-session cost per NIFTY lot ≈ ₹416 at 2 days, ₹250 at 6, ₹221 at 8 (model). Beyond 7 days liquidity is thin (3% of turnover), so always use limit orders. [R2]
- **Holding period: the same day, exit on target, stop or time.** A 45-minute time stop cut the cost of a no-edge trade from ≈₹400 to ≈₹295 (random-entry test). On real prices, 1-strike-ITM options (DTE 1–5) lost the least per lot sold at the close (−₹486, 40% profitable) and OTM the most per rupee. [PLAN, Q1]
- **"Enter now and wait till expiry for the most benefit" is not supported — on real NSE/BSE prices it roughly doubled the loss.** ATM weeklies with 1–5 sessions left (2024–2026): NIFTY −₹547 per lot sold the same day vs −₹1,153 held to expiry; SENSEX −₹783 vs −₹1,419; holding beat selling on only 32–33% of trades, and holding a trade that was losing at the close lost a further ₹739 (NIFTY). Two strikes OTM held to expiry: 62% expired worthless. With *perfect* direction, holding would have paid 2–3× more than selling — so holding only makes sense with a direction call proven right more than ≈ 57% of the time; the 20-day-trend and gap rules we tested were right 44–56% and lost money. [Q1, R2]
- **₹5k/₹10k accounts:** their premium bands (NIFTY ₹40–60/70, SENSEX ₹130–222) land on the worst region: ~+200 points OTM at 6 days (delta ≈0.3) or near-ATM at 1–2 days. On real prices (2024–2026) a band option bought at 09:15 lost ₹173 per NIFTY lot sold at the close (35% profitable) and ₹308 held to expiry; 72% of them expired worthless and 7% returned five times or more — a lottery ticket. (Band *puts* came out near break-even in this falling sample, but only thanks to a handful of crash days; without the best 5–10 of ≈ 640 trades they lose.) Rule: trade only when every entry condition holds, take the highest delta in the band on the longest-dated contract, never the 1–2-day contract, and **skip the day when no lot with delta ≥ 0.30 and ≥ 4 days left fits.** SENSEX's lot rises to 25 for January 2027 expiries; re-derive the band then. [R2, R1]

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

- **GIFT Nifty** trades from 06:30 IST; NSE IX publishes it live (no key). Read it at 09:05–09:12 and adjust for the futures basis: implied open = GIFT price − (NSE NIFTY futures close − spot close). The naïve "GIFT minus spot close" overstates the gap by the basis (today ≈ 61 points). [R4]
- **NSE pre-open auction (09:00–09:12)** publishes an indicative NIFTY open that is, by construction, the opening price after the 09:08–09:10 random close. [R4]
- **From global markets alone, at 09:00:** a four-input model (S&P futures since 15:30 IST, Asian mornings, the rupee, crude) called the gap's direction right on **71%** of days walk-forward (457 days); when it called a gap beyond ±0.3% (37% of days) it was right **87%**; typical miss ≈ 72 points. Rule of thumb: **NIFTY gap ≈ 0.4 × the S&P-futures % move since 15:30 IST.** Over 15 years the US session's direction matched NIFTY's gap 68–70% of the time, 82–89% when the S&P moved more than 1%. [Q2]
- **But the gap is already priced at 09:15.** Gap direction gave no edge for the rest of the day (48% of 1,639 gap-up days closed above the open, 2011–2026). Gaps of 0.5% or more pulled back in the first hour on 61% of days, by only ≈ 25 points (weaker since Aug 2025); big gaps (≥ 1%) rarely fill (7–26%). [Q2, R4]
- **Today's check (9 Oct):** NIFTY's official open was 22,314.95, **+83 points (+0.37%)**. GIFT Nifty at 08:52–08:58, basis-adjusted, implied +72 to +77 points — **6–11 points off**; the naïve "GIFT minus yesterday's close" said +136 (50+ points off); the global-markets model at 09:00 said +0.09% (≈ +20 points). NSE's pre-open indicative open had the wrong sign at 09:00 (−111), was within 18 points by 09:05 and exact from 09:10. Then the day went the opposite way to Thursday's "FIIs sold, buy puts" logic: a gap-up that never filled, NIFTY +1.37% at 15:15. [R4, Q2]
- **What to do with it:** use the pre-open to decide *whether* to trade (small implied gap and no news → no early trade; big gap → expect fade or stabilisation, wait for 09:30), then let the first 15-minute candle decide direction (E2).

---

## 10. What our own data says

**Q1 — premium timing, volatility premium and holding period** (India VIX 5-minute and hourly bars; NIFTY/SENSEX hourly 2023–2026; **real option prices from NSE and BSE daily files, 2024-01 to 2026-10**) [notes/q1-premium-timing.md]:

| Question | Answer from our data |
|---|---|
| When is the premium highest during the day? | In the first hour: the day's India VIX high fell in 09:15–10:15 on 61% of 719 sessions; VIX fell from 10:15 into the close on 65% of days — but the first hour also moves most, so entering later doesn't save money (₹642 / ₹705 / ₹627 per lot for 09:15 / 10:15 / 11:15 entries held to 15:15) |
| Which days are richest? | Expiry day and the day before (19% and 10.6% of premium lost per trade vs 4.6% with 2–5 sessions left); days after a VIX jump or a 2% run. Not Mondays: VIX's Monday rise is a calculation quirk, Monday straddles did no worse than average |
| When does movement beat the decay? | 09:15–10:15 (30% of the day's movement in 16% of the time); 11:15–14:15 is the worst (index moves ≈ 0.7× what the decay costs). One-hour ATM holds cost ≈ ₹60 a lot in the first hour vs ≈ ₹250 in any hour after 11:15 (model calibrated to real prices) |
| Are options cheap or expensive vs what NIFTY then did? | Expensive: realized/implied variance 0.82 close-to-close and only ≈ 0.49 open-to-close (2 years); 55% of daily variance is the overnight gap, which an intraday buyer pays for but can't capture |
| Does holding to expiry pay? | No: ATM held to expiry −₹1,153 per lot vs −₹547 sold the same day; half expire worthless; 62% of 2-strike-OTM options expire worthless |
| Did any condition known before entry make buying pay? | No: straddles bought at the open lost under every pre-entry filter (VIX level, VIX percentile, recent realized/implied, gap size, weekday, DTE). Only *trend days* paid (+₹4,739 per straddle, 87% profitable) — 16% of days, and nothing known at the open raised that probability meaningfully |
| Small-account band options? | NIFTY band −₹173 per lot same day, −₹308 to expiry; 72% expire worthless, 7% return ≥ 5× |

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
| 09:30–10:45 | Entries only when E1–E5 hold (once a trigger passes §12); decisions at half-hour marks | Entry |
| 11:15 | Exit any open long option (N3: the index moves less than the decay until about 14:15) | Exit |
| 11:15–14:30 | No new entries | — |
| During the trade | Index-level stop, premium stop, 45-minute time stop if the index goes nowhere, hard exit by 11:15 | Exit |
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

**Known bias in our backtests:** real weekly options trade at about 0.87–0.93× India VIX (NIFTY, by sessions to expiry) and 0.91–0.93× (SENSEX); the engine's model uses 1.00× and 1.05×. Out of sample (Jul–Oct 2026) the model priced ATM straddles a median 7.5% (NIFTY) and 9.8% (SENSEX) too high; the calibrated setting (`pricing.ivSource: "calibrated"`, off by default) is 3.2–3.3% too low. Neither passes the real-price check: only 39% of the backtest's entry and exit prices fall inside the option's real high–low range for the day with the default model, and 67–70% calibrated, against a 90% bar (half the default entries are above the day's real high). Model backtests therefore overstate buyers' losses somewhat; calibrating does not turn any result positive (the calibrated backtest: 50 trades, −₹13,992). [Q1, WP6]

**Ship plan:** after 15:30 IST today only the harness, the data fix (if its before/after shows it only removes artefact-driven decisions) and the data fetchers; strategy modules stay switched off. Nothing changes the main account's behaviour during market hours.

---

## 13. Real money

Until a variant clears §12, **copying trades with real money has negative expected value** — the engine is indistinguishable from random entry, and the base rate for this activity is roughly 9 in 10 losing. If you copy anyway: use the ₹5k account's caps (≤ ₹1,500 a day, one lot, stop after one loss), only on trades that also satisfy §4, and treat it as the cost of learning.

---

## 14. Today, Friday 9 October

- GIFT Nifty at ~08:55 implied a **+0.3% to +0.5% gap-up** after Thursday's −1.64%; NIFTY **opened at 22,316.80 (+0.38%)**. India VIX opened lower (≈ 14.6 from 15.31). [R4, live feed]
- **Data warning:** Yahoo's SENSEX feed had no trades for today as of 09:21 (still Thursday's close). Don't copy SENSEX trades today; /copy pauses SENSEX entries; the engine's freshness check measures fetch time, not trade time, and is being fixed after the close.
- Contracts: NIFTY's Tuesday 13 Oct contract has 4 days left (allowed); SENSEX's Thursday 15 Oct has 6. It is Friday, so nothing is held over the weekend (N5).
- By the rules above there is **no validated entry trigger today**, so the plan's answer for real money is: no trade. The paper engine keeps running its current rules so we keep measuring.
- The new rules are tested after the close; nothing changes the live engine during market hours.

---

## 15. What the work packages found (Fri 9 Oct, after the close)

Every package was built behind a switch that is off by default; with all switches off the reference backtest is byte-identical (51 trades, −₹9,595.92). Reports are in [`reports/`](../../reports/); every run is logged in `reports/trials.jsonl` (362 runs so far, which raises the bar for any later claim).

| Package | What it found | State |
|---|---|---|
| **WP0** evaluation harness | The current engine **fails** the §12 bar on the ₹5 lakh and ₹10k accounts. It beats matched random entry by ₹265 a trade with the copy delay, against ₹885 needed (₹10k: ₹78 against ₹352); bootstrap 95% interval −₹884 to +₹849 per trade; 4 of 36 ±20% parameter changes come out positive on main, 3 of them only by loosening the edge gate, and 0 of 36 on ₹10k; p = 0.61 against 0.05/116 tries; deflated Sharpe 0.05. Copying a few minutes late made no consistent difference (noise at ~50 trades). | Tooling merged |
| **WP1** closing-auction bars | The bug is real: since 3 Aug NIFTY's 15:15 bar was flat on 37 of 47 days and its 15:20 bar on 46 of 46, and SENSEX's 15:20 bar printed up to 1.27% off. Leaving bars from 15:15 out of the indicators changes 16 of 51 trades: 50 trades, −₹19,401 (vs −₹9,596), a −1.25 standard-error difference, i.e. noise. The "body clip" alternative is not a clean fix (it fakes a NIFTY–Bank Nifty divergence). | Merged, off; owner decides |
| **WP2 + WP5** honest gates | Over the holding horizon the index moved 0.54× what the option's implied volatility charged (the gate assumed 1.1×), and the conviction score's slope on the next move was −0.10 ± 0.26 (keeping even one of the 51 trades needs ≥ 0.70). Either gate blocks all 51 trades. The HAR-RV forecast of the session's variance averaged 0.47–0.50× what the options charged and passed 0 of 4,085 decision hours over 20 months. | Merged, off; switching on = pausing buying |
| **WP3 + WP4** published rules | Noise-area momentum and the 5-minute opening-range breakout, built exactly as published, lose on our instrument: −₹226 to −₹546 a trade on 60 days of 5-minute data, −₹240 to −₹308 a trade over 2 years of hourly data (≈ 700 trades). Noise-area does move the index the right way (+4–5 basis points a trade, t ≈ 2.2), but that is worth ≈ ₹400 a lot against ≈ ₹650–700 of option costs. No variant beats its random-entry placebo by 2 standard errors; every ±20% change is negative. | Merged, dormant |
| **WP6** real option prices | Exchange files: NSE 2019–2026, BSE 2023–2026. The straddle buyer loses during the session (NIFTY −3.1% a day, SENSEX −5.5%, before costs) and roughly breaks even overnight. Our model prices fail the real-range check (39% in range; 67–70% calibrated; bar 90%). | Merged, `pricing.ivSource` off |
| **WP7** overnight iron fly | Can't be priced honestly from end-of-day files; even the favourable reading is flat or negative in 2024–26. | No-go |
| Gap model weights | The hand-set weights did worse than predicting no gap at all. Re-fitted on 437 sessions before 23 Jul, the opening-gap forecast's error fell from 0.49% to 0.30% out of sample (calibration slope 0.50 → 1.02; on live-like 5-minute windows 0.46% → 0.26%). Backtests got worse by noise-sized amounts (−₹7,464 and −₹4,319 on two samples, both intervals spanning zero) through the GLOBAL_BETA vote, which shows no edge with either set. | Merged (bug fix), not yet deployed |

**Decided on 9 Oct evening (owner):** deploy tonight; closing-auction cutoff on by default; buying paused on every paper account with `EDGE_GATE=calibrated`; research continues on buy signals under the §12 bar. Production since 19:49 IST (engine `5b225a01`, 2026.10.09-3) and 19:50 IST (dashboard `ef4a0644`); rollback: engine `3b3cc999`, dashboard `2a7bfd03`. The re-fitted gap weights are merged but not deployed. With these settings the reference backtest takes 0 trades.

**What this means.** Nothing we built or found gives an option *buyer* an edge on NIFTY or SENSEX after costs: not our signals, not the published rules, not a volatility filter. The one consistent premium in the data is on the *selling* side during the session, which needs margin, defined-risk structures and intraday option quotes to test honestly (end-of-day files can't time the entry, as WP7 showed). Until something passes §12, the choice is between keeping the paper engine running purely to measure, or switching on the honest gate (WP2), which stops it buying. Either way, §13 stands: no real money.

---

## Notes and sources

- [R1 — why retail loses, who wins, SEBI studies, Jane Street case](notes/r1-why-retail-loses.md)
- [R2 — premium timing, decay, which option, hold to expiry](notes/r2-premium-timing.md)
- [R3 — trend, flow and options-market signals: evidence vs folklore](notes/r3-signals-evidence.md)
- [R4 — GIFT Nifty, pre-open auction, gaps, data sources](notes/r4-preopen-gaps.md)
- [PLAN — diagnosis of our engine, published strategies, acceptance criteria, work packages](notes/strategy-plan.md)
- [Q2 — gaps, trend indicators and FII flows on our data](notes/q2-gaps-trend-flows.md)
- [Q1 — premium timing, volatility premium and holding period on real prices](notes/q1-premium-timing.md)
- [WP6 — exchange option prices: calibration, the real-price check, the day/night straddle split](../../reports/wp6-real-prices.md)
- [WP7 — overnight short-volatility study (no-go)](overnight-short-vol.md)
- [WP0 — evaluation harness and the current engine's verdict](../../reports/wp0-harness.md)
- [WP1 — closing-auction cleaning](../../reports/wp1-cleaning.md)
- [WP2 + WP5 — honest edge gate and HAR-RV gate](../../reports/wp2-wp5-gates.md)
- [WP3 + WP4 — published strategies](../../reports/wp3-wp4-published.md)
- [Gap model refit — out-of-sample forecast and backtests](../../reports/gap-betas.md)
