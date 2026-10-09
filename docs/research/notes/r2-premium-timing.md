# R2 — When NIFTY/SENSEX premiums are richest, when buying has an edge, and which option a directional buyer should hold

Researched 9 October 2026 (Friday). Scope: Indian index weeklies (NIFTY Tuesday expiry, lot 65; SENSEX Thursday expiry, lot 20), for a buy-only intraday engine that exits the same day and never buys the contract expiring that day. Every figure below carries its source and date; items marked **[model]** are my own Black–Scholes calculations (code in the appendix), **[folklore]** are practitioner claims with no data behind them, and **[US]** are findings from US markets that have not been replicated on NIFTY.

## 0. The short version

1. The premium a buyer pays contains a *variance risk premium* (implied vol above the vol that is then realised). On NIFTY it was positive on **74.9 %** of days (Aug 2022–Mar 2026, 887 days, 43 M one-minute option bars; mean **+1.21 vol points**, median net of costs **+1.13**) and inverted on **25.1 %** of days; the inversions are fatter than the premia (left-tail asymmetry **1.98×**), and in **early 2026 the mean flipped to −4.63 vol points** (Agarwal, SSRN 6530119, posted 20 Apr 2026; abstract only, full text behind SSRN's bot block). So the default state is "buyer overpays a little, most days", broken by a minority of days when the buyer is paid a lot. A buyer's whole job is to avoid the first state and be present for the second.
2. Premiums are *richest* (buyer should stay out): the session before a scheduled binary event (Budget, RBI, election results, US Fed/CPI), the first 30–45 minutes after the open on ordinary days, any day India VIX is high or has just jumped, Monday for the NIFTY contract that dies on Tuesday (and Wednesday for the SENSEX contract that dies Thursday), the Friday-to-Monday weekend on a current-week contract, and expiry day itself.
3. Buying has had an edge: when short-horizon realised vol is already running above ATM implied vol, when the weekly ATM IV sits below the 30-day India VIX (upward-sloping term structure), on intraday trend days (first-half-hour direction persisting into the last half hour, US evidence), and on unscheduled shocks — which cannot be timed, so the practical edge is "be long only when the market is cheap relative to how it is actually moving, not when it is calm".
4. For a directional buyer the evidence-backed contract is **ATM or slightly ITM (delta 0.5–0.7) on the contract with ≥4 calendar days left, exited the same day on a target/stop**. Holding to expiry is the worst holding period for a long option unless the thesis is a move larger than the straddle-implied move; "wait till expiry for the most benefit" is folklore. A ₹5k–₹10k account whose band forces ₹40–70 NIFTY premiums is being pushed to the strikes with the worst expectancy (far-OTM on the fresh contract or near-ATM on the dying one); the honest answer is fewer trades, delta ≥0.30 on the longest-dated contract the band allows, and never the 1–2-DTE contract.

---

## 1. When premiums are richest — "do NOT buy" rules

### Rule N1 — Do not hold a long option into a scheduled binary event; IV builds before and collapses on the day

* **Union Budget.** India VIX closed lower on Budget day in **all 15** Budgets studied, average fall **−9.3 %**; in the following week volatility eased in 11 of 15 (SBI Securities analysis, reported by Business Standard, 30 Jan 2026). Zerodha's *In The Money* test of nine Budgets (26 Jan 2026): VIX "almost always closes lower on Budget day" whatever NIFTY does; NIFTY's intraday range on Budget days was 0.8–4.9 % (median ≈2.07 %); **long straddles were poor at nearly every intraday entry window**, and a 2 %-OTM long strangle bought T-5 and sold T-1 was inconsistent year to year. The author's conclusion favours short-vol into the Budget, with a small-sample caveat. Exception that proves the mechanism: Budget 2026 (1 Feb 2026) saw VIX jump >18 % intraday when an STT hike on derivatives was announced (Business Standard / Whalesbook, Jan–Feb 2026) — a surprise inside the event.
* **General elections.** Result-day VIX fell **≈34 % (2014)** and **≈30 % (2019)** (Angel One, "Election result day and market volatility"). 2024 was the opposite: VIX hit a five-year-low 10.2 on 23 Apr 2024 (−19.7 % in a day), climbed to a 52-week high 26.2 by 27 May, fell >20 % on exit-poll day (3 Jun), then on results day 4 Jun 2024 rose ~28 % at the close (intraday above 31) as NIFTY fell 5.93 %, and was back below 15 by 11 Jun (Business Standard 23 Apr 2024 and 5 Jun 2024; Angel One; Shoonya). Lesson: the pre-event run-up is reliable, the direction of the crush is not; a buyer who was long *through* exit polls was crushed, one long through results was paid. Nobody could schedule the second.
* **RBI policy.** No event study with implied-vs-realised data exists (searched). Daily reports show the pattern: VIX spiked to 16.37 intraday on 5 Jun 2026 before the policy and closed 15.78; on 6 Oct 2026 VIX fell 8.25 % to 13.56 the day before the 7 Oct policy; on 7 Oct 2026 (25 bp hike to 5.50 %) VIX printed 14.31 intraday and closed 13.88 (HDFC Sky market notes, those dates). A 72-meeting study (Jan 2014–Apr 2025) found NIFTY up on 62.5 % of announcement days with a signed average of +0.21 % — small, and it says nothing about size vs implied (IJNTI paper 2026; low-tier journal, treat as indicative). Treat RBI like the Budget: premium is bid the day before and usually gives it back.
* **US macro.** Straddles held across CPI, non-farm payrolls, ISM and industrial-production releases earned **significantly negative** average returns (Jan 2001–Jun 2017); only FOMC straddles were positive (+1.7 %) (OptionMetrics, "Long vol losses: where do they come from"). Wright (NBER w28306, Dec 2020) finds event-day variance risk premia "large and significantly positive, especially for FOMC days" **[US]**. For an Indian intraday buyer the relevant window is the 9:15 open after a US CPI/Fed evening: the gap is already in the price and the IV is at its richest.
* **Engine mapping.** The EVENT regime (high-impact event within −15/+30 min, or VIX up ≥8 %) already blocks entries; extend it to *no fresh long position in the last session before* Budget/RBI/election results and *no overnight hold* (which the engine does not do anyway).

### Rule N2 — Do not buy when IV is high or has just jumped

* Expected call returns are a **decreasing** function of the underlying's volatility, and S&P 500 index call returns are negatively related to index volatility (Hu & Jacobs, *JFQA* 55(3), 2020) **[US]**.
* Retail 0DTE trades are "particularly poor in high-IV contracts and in high-IV times"; a one-s.d. rise in Vega exposure earned only 0.018–0.094 % extra over the rest of the day (Beckmeyer, Branger & Gayda, Dec 2023 version, Feb 2021–Sep 2023) **[US]**.
* India VIX mean-reverts (Thenmozhi & Chandra, NSE Working Paper 9/2013) and falls fast after spikes (31.7 → <15 within five sessions in June 2024). A buyer entering *after* a VIX jump is buying the top of the vol, not the move.
* **Engine mapping.** HIGH_VOL (VIX ≥18) and the VIX-up-≥8 % gate are consistent with the evidence. Add: no entry while VIX's 1-day change is > +8 % *or* VIX is above its 20-day high.

### Rule N3 — Do not buy in the first 30–45 minutes on an ordinary day

* Intraday model-free implied volatility shows "a similar diurnal pattern as implied volatility indices such as the VIX, with higher levels after opening hours and declining levels until closing hours" (MDPI *J. Risk Financial Manag.* 17(1):39, 2024; single-stock data) **[US]**. Realised intraday volatility is U-shaped with a high left tail (first interval) across SPX studies.
* For NIFTY no published intraday-IV study exists (searched twice). Practitioner data vendors (stockmojo.in, page dated 6 Oct 2026) say "NIFTY 50 IV often opens elevated" on overnight gap risk and "settles as the market finds its range" — **[folklore]** consistent with the US evidence but unmeasured.
* Counter-evidence to keep in mind: in US equity options the opening half-hour straddle return is *positive* on average (+29 bps for 9:35–10:00) because of delayed reaction to overnight volatility news — "morning momentum" (Da, Filippou, Goyenko, Zhang, Zhou & Zhou, version 2 Oct 2026) **[US]**. So "wait" is right on a quiet open, but a buy in the first half hour *with* a volatility/news trigger is not ruled out.
* **Engine mapping.** Already in place for the ₹5k/₹10k books if entries start after 09:45–10:00; make it explicit for the main book outside TREND/EVENT regimes.

### Rule N4 — Do not buy the contract with ≤2 calendar days left (NIFTY on Monday, SENSEX on Wednesday); never the 0DTE

* **[model]** Black–Scholes, NIFTY 22,700, IV 13 %, r 6.5 %: the ATM call worth ₹91 with 2 days left loses **₹28 (30 %) per calendar day**; with 6 days left (Wednesday's fresh contract) it is worth ₹163 and loses ₹15 (9 %) a day. On a *flat* index over the 6¼-hour session, one lot (65) loses about **₹416 on Monday vs ₹250 on Wednesday**; +200 OTM loses 67 % of its value per day at 2 DTE vs 16 % at 6 DTE (full table in §2). The backtest's ≈₹235 average flat-day loss sits inside this range, so the engine's cost of carry is behaving as the model predicts.
* Day-of-week in India VIX: a significant **positive Monday** effect (VIX rises at the start of the week) and a negative Wednesday effect (expected volatility eases Wednesday–Friday); VIX **falls significantly on option expiry day** (Shaikh & Padhi, *Business: Theory and Practice* 16(2), 2015; ARCH/GARCH on daily data, pre-weekly-expiry sample). Monday is therefore both the highest-theta day *and* a day premiums tend to be bid.
* Expiry day: 0DTE contracts were **70 % of index-option turnover in FY25 and 59 % in FY26**; 75 % of FY26 turnover was within one day of expiry, 97 % within a week, only 3 % beyond seven days (SEBI, *Profitability of Individual Traders in the Equity Derivatives Segment FY25–FY26*, PR 50/2026, 20 Aug 2026, §6.13). 0DTE retail trades lose **4.7 % more per trade** than other option trades (−2.95 % with trader and date controls), driven by far wider relative spreads (Bogousslavsky & Muravyev, Aug 2024) **[US]**; >25 % of single-leg 0DTE retail trades expire worthless (Beckmeyer et al.) **[US]**. Gamma is "especially large near the money" on 0DTE (Bandi, Fusari & Renò, *0DTE option pricing*, 2014–2023 data) **[US]**.
* **Engine mapping.** The never-0DTE rule is right. Extend the ban to 1 DTE: on Monday trade NIFTY only on the *following* Tuesday's contract (8 DTE) or not at all; on Wednesday do the same for SENSEX. Trade-off: beyond 7 DTE liquidity is thin (3 % of turnover, SEBI above), so limit orders inside the spread are mandatory and the synthetic-spread model must be re-calibrated for those contracts.

### Rule N5 — Do not carry a current-week contract over a weekend

* **[model]** NIFTY ATM, 4 days left at Friday's close (₹131) is worth ₹64 at Monday's close with the index unchanged: **−51 % for a flat weekend**. The engine never holds overnight, so this is for the owner's discretionary trades.
* Equity options lose on average **−0.58 % per weekend** (t = −16.1), the loss is about **1 % larger on expiration weekends**, and "total implied volatility declines over twice as much [over the weekend] as any other day" even though Friday-close-to-Monday-close realised volatility is no higher (Jones & Shemesh, *The Weekend Effect in Equity Option Returns*, Aug 2012, OptionMetrics 1996–2007). Caveat: for S&P 500 *index* options the effect was "inconclusive" and absent for index calls **[US]**. The claim that "market-makers price the weekend into Friday's close so there is nothing to avoid" is **[folklore]**; the one measured study says prices still fell over the weekend.

### Rule N6 — Do not buy far-OTM "cheap" strikes because they are cheap

* Deep-OTM index call returns "decrease with the strike price and are negative" across major markets (later literature summarised against Coval & Shumway) **[US]**; expected returns of OTM options are the most negative per unit of premium because they carry the most variance-risk premium per rupee.
* For NIFTY, held-to-maturity put returns across four moneyness buckets reject the no-premium null at p = 0.000 under Black–Scholes, Heston and Bates, and "tail-risk protection is priced more expensively in Indian equity options than in the U.S." (Pillai, *Nifty 50 Index Put Option Mispricing: A BCJ-Style Test 2015–2025*, SSRN 6816718; abstract via search, full text not retrieved). The same author's cost-inclusive backtest (SSRN 6876580, 30 May 2026) finds every *short*-vol strategy on NIFTY also loses after costs (straddle variants −44 to −45 %/yr) because of tail risk — i.e. the premium exists but neither side harvests it cheaply at retail costs.
* **[model]** ₹40–70 strikes (the small-account band) are +200 OTM at 6 DTE (delta 0.32, loses 16 %/day flat) or +100 at 2 DTE (delta 0.34, loses 48 %/day). Delta ≈ probability of finishing ITM, so roughly two-thirds of these expire worthless *if held*.

---

## 2. Theta and gamma profile of a NIFTY weekly **[model]**

Black–Scholes, NIFTY spot 22,700, r = 6.5 %, 365-day basis, calendar-day decay; "6h loss" is the premium lost per lot (65) over one 6¼-hour session with the index unchanged. The engine's real quotes will differ (vol smile, weekend/holiday time conventions, spread), but the *shape* is what matters. IV 13 % ≈ India VIX 13–14 as on 7 Oct 2026; IV 18 % ≈ the HIGH_VOL gate.

| Days left | Strike | Price (IV 13 %) | Loss/day | Loss % | Delta | 6h flat loss ₹/lot | Price (IV 18 %) | Loss/day | 6h flat loss ₹/lot |
|---|---|---|---|---|---|---|---|---|---|
| 1 (Mon, NIFTY) | ATM | 63.7 | 63.7 | 100 % | 0.51 | 595 | 87.4 | 87.4 | 811 |
| 2 | ATM | 91.2 | 27.6 | 30 % | 0.52 | 416 | 124.7 | 37.4 | 563 |
| 4 (Fri) | ATM | 131.4 | 18.6 | 14 % | 0.52 | 300 | 178.8 | 24.9 | 402 |
| 6 (Wed, fresh) | ATM | 163.3 | 15.2 | 9 % | 0.53 | 250 | 221.2 | 20.3 | 333 |
| 8 (Mon, next week) | ATM | 190.8 | 13.3 | 7 % | 0.53 | 221 | 257.7 | 17.6 | 292 |
| 11 | ATM | 227.2 | 11.6 | 5 % | 0.54 | 194 | 305.5 | 15.2 | 254 |
| 2 | +100 | 49.0 | 23.7 | 48 % | 0.34 | 370 | 80.5 | 34.5 | 529 |
| 6 | +100 | 116.4 | 14.5 | 12 % | 0.42 | 240 | 173.7 | 19.8 | 325 |
| 2 | +200 | 23.1 | 15.4 | 67 % | 0.19 | 266 | 48.6 | 27.6 | 445 |
| 6 | +200 | 79.7 | 13.0 | 16 % | 0.32 | 215 | 133.6 | 18.6 | 308 |
| 2 | +300 | 9.4 | 7.7 | 82 % | 0.09 | 155 | 27.4 | 19.1 | 335 |
| 6 | +300 | 52.2 | 10.8 | 21 % | 0.24 | 181 | 100.6 | 16.9 | 281 |
| 6 | −200 (ITM) | ≈246 | ≈17 | 7 % | ≈0.76 | — | — | — | — |

Reading the table:

* Decay in rupees per day is *roughly flat* across strikes for a given DTE (₹10–15 a day at 6 DTE) but decay as a *percentage of premium* explodes out of the money — that is why cheap strikes feel like they "melt".
* On the last two calendar days ATM loses 30 % then 100 % of its value; the hourly profile on expiry day is convex (ATM worth 64.9 at 24 h, 32.6 at 6¼ h, 12.9 at 1 h, 6.4 at 15 min — IV 12 %, S = 25,000 run), which is the quantitative content of the vendor claim that "ATM loses 70–90 % between morning and close on expiry day" **[folklore but model-consistent]**. An Option Alpha study of SPX 0DTE spreads (mid-2024, 30 days) found decay "accelerates noticeably in the afternoon" and that ATM structures hold value longer than OTM **[US, small sample]**.
* Break-even: at 6 DTE ATM, a flat session costs ≈₹250/lot ≈ 3.8 NIFTY points of delta (0.53 × 65); add spread + ≈₹68 charges and you get the backtest's ≈9-point break-even. On Monday's 2-DTE contract the same arithmetic needs ≈13 points.
* Gamma on expiry day: SEBI's own description — "even a small index move can cause a large percentage change in the option's price" — is the regulator's reason for the expiry-day ELM and calendar-spread withdrawal (SEBI FY25–26 study §6.13; consultation paper 30 Jul 2024).

---

## 3. What long options actually return

* **Coval & Shumway (JF 2001):** zero-beta ATM S&P straddles lost **≈3 % per week**; theory says call expected returns exceed the underlying's and rise with strike, but the data for OTM index calls do not deliver it; later work finds deep-OTM index calls negative and decreasing in strike **[US]**.
* **Broadie, Chernov & Johannes (RFS 2009):** hold-to-expiry index put returns are strongly negative (they cite Bondarenko's ≈−40 %/month ATM, ≈−95 % deep OTM) but "not inconsistent" with jump-risk premia — i.e. the loss is compensation, not mispricing **[US]**.
* **India:** variance risk is priced on NIFTY (Sankar, Ramachandran & Lukose, *IREF* 70, 2020); the premium averages +1.2 vol points with 25 % inversions (Agarwal 2026); held-to-maturity NIFTY puts lose across moneyness (Pillai 2026). EM VRP including India predicts returns at >6-month horizons (Qiao, Xu, Zhang & Zhou, *JBF* 167, 2024).
* **Retail buyers, measured:** US retail option *purchases* lose 3.95 % per trade on average while naked sales earn 20 %; index/ETF option trades −3 % vs +0.15 % single-stock; median option holding period 0.54 hours; traders "realize gains earlier than losses on option purchases" (Bogousslavsky & Muravyev 2024). 0DTE single-leg puts/calls: mean margin-adjusted return −5.6 %/−9.4 %, median −0.7 %/−0.8 %, only 25 % of trades return >0.6 %, top 5 % return >178 %, ≈60 % of daily losses are transaction costs (Beckmeyer et al. 2023) **[US]**.
* **India, measured by SEBI:** 87.7 % of individual derivatives traders lost in FY26 after costs (82.1 % before costs), ₹91,685 cr aggregate, 92 % of losses from options, ₹25,000 cr transaction costs in each of FY25 and FY26; ~90 % of two-year losers who kept trading lost again (SEBI PR 50/2026, 20 Aug 2026). Secondary summaries add ~97 % of individuals predominantly option *buyers* and sellers the only group with positive median return — not verified in the PDF text I retrieved; treat as provisional. FY25: 91 % lost, ₹1,05,603 cr (SEBI, Jul 2025).
* **Hold to expiry vs exit early.** No Indian study isolates holding period. The mechanics are unambiguous: holding to expiry pays the *whole* variance-risk premium plus the convex last-day decay, and realises the option's full lottery skew (delta ≈ P(ITM): 0.5 ATM, 0.3 at +200/6 DTE, 0.1 at +200/1 DTE). Bogousslavsky & Muravyev find retail's short holding periods remove the lottery skew but not the loss. The *only* case for holding to expiry is a view that the realised move will exceed the straddle-implied move (≈0.85 × ATM straddle is the vendor convention for the 1-s.d. implied move **[folklore]**); the Budget evidence says that view has usually been wrong on scheduled days.
* **Share expiring worthless.** No NSE/SEBI figure exists (searched). US: ≈10 % exercised, 55–60 % closed early, 30–35 % expire worthless (CBOE answer, 2011, as cited by OptionsTradingIQ; McMillan ≈30 % since 1973); the "80–90 % expire worthless" number is a misreading of the 10 %-exercised statistic **[folklore debunked]**. For NIFTY weeklies the model probability of a *held* option finishing ITM is its delta, so ATM ≈50 %, the ₹40–70 band ≈20–35 %.

---

## 4. When buying has had an edge — "buy" rules

### Rule B1 — Buy only when the market is already moving more than the option implies

* NIFTY VRP inverts on 25.1 % of days with inversions ~2× the size of premia; early 2026 was a whole epoch of negative VRP (mean −4.63 vol points) (Agarwal 2026). Buyers were paid when realised vol ran above implied — a *regime*, not a date.
* Cross-sectionally, long straddles on names whose realised vol exceeds implied vol outperform (Goyal & Saretto, *JFE* 2009; returns survive but shrink after costs per Do, Foster & Gray 2016) **[US]**.
* **Filter:** 5–10-day Yang-Zhang realised vol of NIFTY ÷ ATM weekly IV ≥ 1.0 → long options are allowed; < 0.8 → stand down. The engine already computes realised/implied and treats ≥1.5 as HIGH_VOL *risk*; the evidence says the 1.0–1.5 band is where a buyer's expectancy is best, and ≥1.5 is where the IV is about to be marked up (then Rule N2 applies).

### Rule B2 — Buy when the weekly IV is below the 30-day IV (upward-sloping term structure)

* Straddle portfolios with high (steep positive) IV term-structure slope beat low-slope ones, robust to factor and jump controls (Vasquez, *JFQA* 2017) **[US]**. In India the proxy is weekly ATM IV vs India VIX (30-day); the engine's `vixMultiplier` of 1.0/1.05 assumes they are equal — measure it from Groww chain IV and allow entries only when weekly IV ≤ VIX.

### Rule B3 — Buy direction on confirmed intraday trend days, size for the last half hour

* First-half-hour return predicts last-half-hour return (S&P 500 ETF 1993–2013, R² 1.6 %, stronger on volatile days; Gao, Han, Li & Zhou, *JFE* 2018). The 16-market replication (Li, Sakkas & Urquhart, *JFM* 2022) does **not** include India (checked the accepted manuscript). An Indian adaptation (Motwani, Burrin & Sharma, 2024) finds "certain elements translate", without a clean half-hour test — so for NIFTY this is plausible, not proven. The engine's TREND regime (60-min move ≥0.35 % with efficiency ≥0.6 or ADX ≥25 agreement) is the right kind of filter; the US result says the payoff concentrates late in the session, which collides with Rule N4 on 1-DTE days — another reason to be on the ≥4-DTE contract.

### Rule B4 — Low absolute IV helps calls, but only together with B1

* Expected call returns are higher when volatility is low (Hu & Jacobs 2020). India VIX below ~12 (its 2024 trough was 10.2) makes ATM calls cheap in rupees (₹163 at 6 DTE at 13 % vs ₹221 at 18 %), but low VIX is also when the VRP is most reliably positive, so B4 alone is not an edge. Use VIX percentile as a *sizing* input, B1 as the *entry* gate.

### Rule B5 — Events are a buyer's edge only when the move is unscheduled or under-priced

* Scheduled: Budget/RBI long-vol lost (§1). FOMC straddles +1.7 % (US), CPI/NFP negative. Unscheduled: 4 Jun 2024 (VIX +28 % close, NIFTY −5.9 %), early-2026 regime shift. These cannot be timed; the buyer's protection is B1 (be long only when the tape is already moving) and never paying the pre-event premium.

---

## 5. Which option: strike, expiry, holding period

### For the main (₹5 L) book — directional, same-day exit

| Choice | Rule | Why (evidence) |
|---|---|---|
| Strike | **ATM or one step ITM, delta 0.50–0.70** | OTM carries the most VRP per rupee and the worst per-day % decay (§2); deep-OTM index calls have negative returns decreasing in strike; ATM retains value longest into expiry (Option Alpha, US). ITM-200 at 6 DTE: delta 0.76, decay 7 %/day, costs ≈₹16k/lot — better expectancy, more capital at risk per lot. |
| Expiry | **≥4 calendar days left; prefer 6–8 DTE; next week's contract on NIFTY Mondays and SENSEX Wednesdays** | Theta per day falls from 30 % (2 DTE) to 9 % (6 DTE) to 7 % (8 DTE) of ATM value; flat-session cost per lot ₹416 → ₹250 → ₹221 (§2). Cost: beyond 7 DTE only 3 % of turnover (SEBI FY26) → wider spreads; use limit orders and re-calibrate the synthetic spread. |
| Holding period | **Same day; exit on target/stop; never hold over a weekend or into a scheduled event** | §1 N1, N5; Bogousslavsky & Muravyev: short holds avoid the full VRP; Coval–Shumway −3 %/week for straddles **[US]**. |
| Hold to expiry? | **No, unless the thesis is a move > implied move** | Holding pays the whole VRP plus last-day convexity; Budget data say the "big move" thesis has mostly lost (§1). |
| Entry time | **After 09:45 unless TREND/news trigger; not in the last 90 min on a ≤2-DTE contract** | N3, N4; morning momentum caveat (Da et al. 2026). |

### For the ₹10k / ₹5k books (NIFTY ₹40–70, SENSEX ₹130–222 premium band)

* The band is the problem: at IV 13 % ₹40–70 is +200 OTM at 6 DTE (delta ≈0.32) or +100 at 2 DTE (delta ≈0.34); at 1 DTE it is the ATM itself (₹64, 100 % decay by close). Every reachable contract is in the highest-%-decay region of §2, and the evidence on cheap/OTM/short-dated options (N6, §3) is uniformly negative. A ₹5k account buying one NIFTY lot is making the trade the SEBI data describe.
* What the evidence supports, in order: (1) **trade less** — only Rule B1+B3 days; (2) **longest-dated contract the band allows, highest delta inside the band** (prefer +200 at 6–8 DTE, delta ≈0.3, over +100 at 2 DTE, delta ≈0.34 but 48 %/day decay); (3) **never the 1–2-DTE contract** (Monday NIFTY, Wednesday SENSEX) — on those days the band is unfillable at acceptable expectancy, so skip; (4) prefer SENSEX only if its band buys a *higher delta* than NIFTY's — SENSEX's lot of 20 means ₹130–222 buys ₹2,600–4,440 of premium, the same rupee outlay as NIFTY's ₹40–70, so compare deltas, not rupees (SENSEX ATM 6-DTE premium is ≈3.3× NIFTY's, so ₹130–222 is also ≈+600–900 OTM, delta ≈0.2–0.3 **[model, SENSEX level not checked today]**); (5) when the lot *cannot* be bought at delta ≥0.30 on a ≥4-DTE contract, do not trade — the backtest's ₹235 + ₹68 per flat trade is the floor cost of being wrong about timing, and it is 6 % of a ₹5k account per trade.
* The SENSEX lot rises to 25 for contracts expiring from January 2027 (BSE notice 20260930-58), which shrinks the ₹5k band to ≈₹178 — re-derive then.

### What the engine's backtest result means in this light

51 trades, −₹9,596, ≈₹235 decay + spread and ≈₹68 charges per flat trade: the engine is paying the average VRP on every entry (Rule B1 absent), on the highest-theta days (Monday 1-DTE NIFTY, Wednesday 1-DTE SENSEX, Rule N4 absent), with no event-eve exclusion beyond ±30 min (Rule N1 partial). Those three gates are the cheapest things to test first; strike choice (ATM) is already the evidence-backed one for the main book.

---

## 6. Evidence vs folklore — quick table

| Claim | Status |
|---|---|
| IV builds before Budget/RBI/elections and falls on the day | **Evidence** (15/15 Budgets −9.3 %; 2014/2019 results −30–34 %); 2024 results and Budget 2026 are the documented exceptions |
| NIFTY IV is highest in the first 30–45 min | **US evidence** for diurnal IV; India **[folklore]** |
| Weekend decay is "already in Friday's price" | **[folklore]**; measured equity-option weekend returns are −0.58 % (index inconclusive) |
| "80 % of options expire worthless" | **Debunked**; 30–35 % (US) |
| "Weekly options lose 70–80 % in the last 3 days" | Model-consistent for ATM (2-DTE 30 %/day), vendor numbers unsourced |
| "Hold to expiry for maximum benefit" | **Contradicted** by hold-to-maturity return studies (US and NIFTY puts) |
| "Sellers always win" | **Wrong in India after costs** (Pillai 2026: all short-vol variants negative); the premium exists but tail risk and costs eat it on both sides |
| Realised > implied → buyers paid | **Evidence** (Agarwal 25.1 % inversion days; early-2026 regime; Goyal–Saretto cross-section) |
| First-half-hour direction persists into the close | **US evidence**, India unproven |

---

## 7. Gaps and uncertainty

* No peer-reviewed intraday-IV, day-of-week-IV, or implied-vs-realised event study exists for NIFTY weeklies; Agarwal (2026) is the only minute-level NIFTY VRP paper and I could read only its abstract. Shaikh & Padhi's day-of-week results pre-date weekly expiries and the Tuesday switch (1 Sep 2025).
* Pillai's two NIFTY papers were read via search abstracts only (SSRN blocks automated reads).
* SEBI's buyer-vs-seller split (97 %/2 %, sellers' positive median) comes from secondary coverage; the PDF text I extracted confirms the turnover-concentration and loss figures but my grep did not find the strategy split, so flag it provisional.
* All theta/gamma numbers are Black–Scholes with flat IV and calendar time; real NIFTY quotes use a smile and market-makers decay weekends unevenly. Re-run with Groww chain IV once real option candles are wired into the replay (docs/RESEARCH.md already lists this).
* SENSEX figures are scaled from NIFTY; I did not fetch today's SENSEX level or IV.

---

## Sources

Primary / academic
* Agarwal, Y., *The Variance Risk Premium in Nifty 50: A Structural Anatomy Across Nine Empirical Filters*, SSRN 6530119, written 6 Apr 2026, posted 20 Apr 2026 — https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6530119 (abstract; also https://www.researchgate.net/publication/403996082)
* Pillai, S., *Trading the Volatility Risk Premium on Nifty 50: Strategy Backtest with Realistic Frictions*, SSRN 6876580, 30 May 2026 — https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6876580
* Pillai, S., *Nifty 50 Index Put Option Mispricing: A BCJ-Style Test 2015–2025*, SSRN 6816718 — https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6816718
* Sankar, G., Ramachandran, S., Lukose, P.J., *Dynamics of variance risk premium: Evidence from India*, IREF 70 (2020) 321–334 — https://researcher.manipal.edu/en/publications/dynamics-of-variance-risk-premium-evidence-from-india
* Qiao, Xu, Zhang, Zhou, *Variance risk premiums in emerging markets*, J. Banking & Finance 167 (2024) 107259 — https://ideas.repec.org/a/eee/jbfina/v167y2024ics0378426624001730.html
* Shaikh, I., Padhi, P., *The behavior of option's implied volatility index: a case of India VIX*, Business: Theory and Practice 16(2), 2015 — https://zenodo.org/records/817228
* Thenmozhi, M., Chandra, A., *India VIX and Risk Management in the Indian Stock Market*, NSE Working Paper 9/2013 — https://nsearchives.nseindia.com/research/content/res_WorkingPaper9.pdf
* SEBI, *Profitability of Individual Traders in the Equity Derivatives Segment (FY25–FY26)*, PR 50/2026, 20 Aug 2026 — https://www.sebi.gov.in/sebi_data/attachdocs/aug-2026/1787233506209.pdf (read §6.13 and summary)
* SEBI FY25 study coverage (91 %, ₹1,05,603 cr), 7 Jul 2025 — https://www.business-standard.com/markets/news/net-losses-of-traders-in-fo-widens-in-fy25-sebi-study-125070701221_1.html
* SEBI consultation paper 30 Jul 2024 coverage — https://moneylife.in/article/sebi-suggests-changes-in-index-derivative-framework-to-reduce-speculation-recommends-fewer-weekly-expiries-increase-in-contract-size-by-34-times/74788.html
* Coval, J., Shumway, T., *Expected Option Returns*, J. Finance 56(3), 2001 — https://deepblue.lib.umich.edu/items/455dbe73-b56b-44f3-841f-c7751deffc7a/full
* Broadie, Chernov, Johannes, *Understanding Index Option Returns*, RFS 22(11), 2009 — https://papers.ssrn.com/abstract=965739
* Hu, G., Jacobs, K., *Volatility and Expected Option Returns*, JFQA 55(3), 2020 — https://ideas.repec.org/a/cup/jfinqa/v55y2020i3p1025-1060_10.html
* Goyal, A., Saretto, A., *Cross-section of option returns and volatility*, JFE 2009 — https://docs.lib.purdue.edu/ciberwp/55
* Vasquez, A., *Equity Volatility Term Structures and the Cross Section of Option Returns*, JFQA 2017 — https://www.cambridge.org/core/journals/journal-of-financial-and-quantitative-analysis/article/equity-volatility-term-structures-and-the-cross-section-of-option-returns/F0A40E99FD2458367DD9A56A89783D38
* Jones, C.S., Shemesh, J., *The Weekend Effect in Equity Option Returns*, working paper 30 Aug 2012 — https://business.uq.edu.au/sites/default/files/events/files/weekend_paper_uq.pdf (full text read)
* Da, Filippou, Goyenko, Zhang, Zhou, Zhou, *Intraday Option Return Predictability*, version 2 Oct 2026 — https://academicweb.nd.edu/~zda/IntraOption.pdf (full text read)
* Beckmeyer, Branger, Gayda, *Retail Traders Love 0DTE Options… But Should They?*, version 15 Dec 2023 — https://wp.lancs.ac.uk/fofi2024/files/2024/04/FoFI-2024-146-Leander-Gayda.pdf (full text read; SSRN 4404704)
* Bogousslavsky, V., Muravyev, D., *An Anatomy of Retail Option Trading*, 29 Aug 2024 — https://www.lsu.edu/business/files/event-files/2025-finance-mardi-gras/retail_option_trading_v2.pdf (full text read)
* Bandi, Fusari, Renò, *0DTE option pricing* — https://westernfinance-portal.org/viewpaper?n=915376
* Gao, Han, Li, Zhou, *Market intraday momentum*, JFE 2018 — https://www.sciencedirect.com/science/article/abs/pii/S0304405X18301351
* Li, Sakkas, Urquhart, *Intraday time series momentum: global evidence*, J. Financial Markets 57 (2022) — https://centaur.reading.ac.uk/95566/1/Accepted-Version.pdf (checked: India not in sample)
* Wright, J.H., *Event-Day Options*, NBER w28306, Dec 2020 — https://www.nber.org/system/files/working_papers/w28306/w28306.pdf
* OptionMetrics, *Long Vol Losses: Where Do They Come From* (2001–2017 announcement straddles) — https://www.globalvolatilitysummit.com/wp-content/uploads/2021/05/OptionMetrics-Long-Vol-Losses-Where-Do-They-Come-From.pdf
* MDPI J. Risk Financial Manag. 17(1):39 (2024), intraday MFIV diurnal pattern — https://www.mdpi.com/1911-8074/17/1/39
* Motwani, Burrin, Sharma, *Hedging Demand and Intraday Momentum within the Indian Stock Market* (2024) — https://www.researchgate.net/publication/383567351

Press / exchange / practitioner (data-bearing)
* Business Standard, 30 Jan 2026, SBI Securities 15-Budget VIX analysis — https://www.business-standard.com/amp/markets/news/markets-often-rebound-after-pre-budget-corrections-sbi-securities-126013000305_1.html
* Zerodha *In The Money*, 26 Jan 2026, *Budget 2026 trading strategies* — https://inthemoneybyzerodha.substack.com/p/budget-2026-trading-strategies-what
* Business Standard, 23 Apr 2024, VIX −19.7 % to 10.2 — https://www.business-standard.com/amp/markets/news/india-vix-index-sharply-slumps-20-the-biggest-drop-in-five-years-124042301001_1.html
* Business Standard, 4–5 Jun 2024, results-day crash and VIX −25 % next day — https://www.business-standard.com/amp/markets/news/sensex-plunges-over-4-000-points-intraday-check-factors-behind-the-fall-124060400591_1.html ; https://www.business-standard.com/amp/markets/capital-market-news/nifty-above-21-950-mark-fmcg-shares-advance-vix-slumps-25-32-124060500281_1.html
* Angel One, *Election result day and market volatility* (2014/2019 VIX falls; 2024 spike) — https://www.angelone.in/news/market-updates/election-result-day-and-market-volatility ; https://www.angelone.in/news/market-updates/india-vix-comparing-this-volatility-with-previous-major-events
* Shoonya blog, VIX +41 % on 4 Jun 2024 — https://blog.shoonya.com/india-vix/
* HDFC Sky daily VIX notes, 5 Jun 2026, 6 Oct 2026, 7 Oct 2026 — https://hdfcsky.com/news/india-vix-closes-near-15-78-after-intraday-swing-ahead-of-rbi-policy-as-volatility-eases-from-day-high-on-june-5-2026 ; https://hdfcsky.com/news/india-vix-falls-8-25percent-as-softer-oil-global-cues-ease-volatility-ahead-of-rbi-policy-october-6-2026 ; https://hdfcsky.com/news/india-vix-rises-1-98percent-to-13-88-as-rbi-rate-hike-keeps-markets-on-edge-october-7-2026
* IJNTI (2026), 72 RBI MPC announcement days 2014–2025 — https://www.rjpn.org/ijnti/papers/IJNTI2605086.pdf (low-tier journal)
* Open Magazine / Finnovate / corplawupdates summaries of SEBI FY26 (buyer/seller split, provisional) — https://openthemagazine.com/business/sebi-fo-loss-study-explained-why-9-in-10-retail-traders-lost-91685-crore-in-fy26 ; https://www.corplawupdates.in/updates/sebi-equity-derivatives-retail-trader-study-fy26
* OptionsTradingIQ, CBOE "expire worthless" statistic — https://optionstradingiq.com/do-80-of-options-expire-worthless/
* Option Alpha, SPX 0DTE decay study (2024) — https://optionalpha.com/blog/0dte-options-time-decay
* stockmojo.in NIFTY IV page (practitioner, 6 Oct 2026) — https://stockmojo.in/implied-volatility-chart/nifty
* Repo context: README.md, docs/FNO.md, src/engine/strategy/optionSelect.ts, src/engine/accounts.ts, src/engine/config.ts (VIX gates, premium bands, expiry choice).

## Appendix — model code

```python
# Black–Scholes call, 365-day basis; S=22700, r=0.065; IV 0.13 / 0.18
from math import log, sqrt, exp, erf, pi
N = lambda x: 0.5*(1+erf(x/sqrt(2)))
def bs(S,K,T,r,s):
    if T<=0: return max(0,S-K)
    d1=(log(S/K)+(r+s*s/2)*T)/(s*sqrt(T)); d2=d1-s*sqrt(T)
    return S*N(d1)-K*exp(-r*T)*N(d2)
# loss/day = bs(S,K,dte/365) - bs(S,K,(dte-1)/365); 6h flat loss per lot = 65*(bs(dte) - bs(dte-6.25/24))
```
