# R6 — Untested candidates: overnight drift, calendar effects, monthly-tenor selling, box and parity arbitrage

Research date: Sat 10 Oct 2026.

**Update, same evening: overnight drift (points 2–5) has now been tested in WP15** ([report](../../../reports/wp15-overnight-drift.md)). It fails.
- The drift is real in NSE's and BSE's official prints: NIFTY +10.2 bp a night, 2011–2026. It fails the bar at the deflated Sharpe step and is fading (−0.6 bp a night in 2026).
- "Buy the dip overnight" does not show up in India. After a fall of 1% or more the night averaged +4.8 bp, and its CI includes zero.
- A trader cannot capture the drift. The near-month future keeps +1.7 bp a night, less than the STT on the sale. All 28 option picks fail on real 1-minute prices, including R6's synthetic long and its single-call version.
- Of the remaining candidates, turn-of-the-month is still untested. Point 7's evidence is negative, and point 8 is not accessible to retail.

This is a final completeness sweep. It looks for documented strategies on Indian index options, or on NIFTY/SENSEX through options or futures, that meet three conditions:
- (a) a retail trader with ₹5,000 to ₹5 lakh can run them;
- (b) they have out-of-sample, or live and audited, evidence of positive returns after costs;
- (c) the program has not already tested them. The plan's §0 and §15 list what has been tested: 2,814 logged variants across WP0–WP14.

Topics already covered in r1–r5 and the work packages are not re-researched. They are: why retail loses, premium timing, indicators, FII flows and positioning, pre-open gaps, intraday straddle and iron-fly selling, expiry afternoons, calendars, event eves, and the first-candle, noise-area and ORB rules.

This note is the evidence base for the backtest agent. It does not run a backtest.

**Method.** Normal web search and page fetches only. No internal JSON endpoints of nseindia.com, bseindia.com or groww.in were called, and nothing was bulk-downloaded. Four PDFs could not be parsed by the fetch tool: NY Fed SR 917, Knuteson 2020, Lou–Polk–Skouras 2019 and Girish & Rastogi 2013. I fetched each as a single file and converted it to text locally, to read the tables.

**Evidence grades** (the same scale as r5):
- **Replicated**: two or more independent tests agree on the sign and the horizon.
- **Single study**: one peer-reviewed or working-paper test with a stated sample. "Contested" is added when later work disagrees.
- **Practitioner untested**: a vendor, broker, blog or forum states a rule or a result, with no out-of-sample test.
- **Folklore**: widely repeated, with no stated rule or count, or with only negative tests.

**Labels.**
- "(snippet)": I saw the claim only in a search-result summary.
- "(abstract)": I read only the abstract.
- "[my arithmetic]": a calculation made in this note from the stated inputs. It is not a published number.
- Source tags such as [O1] point to §8. Internal tags point to the program's own files: [Q1] = notes/q1-premium-timing.md, [Q2] = notes/q2-gaps-trend-flows.md, [WP6] = reports/wp6-real-prices.md, [WP10], [WP11], [r2], [r4], [plan] = options-trading-plan.md.

---

## 0. Bottom line in eight points

1. **Nothing I found meets all three conditions.**
   - I found no India-specific strategy outside the program's tested set with out-of-sample or audited after-cost evidence of positive returns.
   - The two nearest candidates have after-cost evidence only abroad, and that evidence has faded since 2021.

2. **Overnight drift is the strongest untested pattern in India, but every Indian source is gross of costs and in sample.**
   - Four independent write-ups from 2020–2026, plus the program's own data, agree on the sign: since about 2011, NIFTY's return has come overnight, while the trading session has lost.
   - Mar 2015–Mar 2026, measured 15:25 → 09:25: overnight +531% cumulative (+18.3% a year), against −55% intraday [O1].
   - Sep 2007–Oct 2020: overnight +1,868%, against −87% intraday [O4].
   - Jan 2024–Oct 2026: +4.2 bp a night, against −3.9 bp a session [Q1].
   - Per night, that is about 9 bp (2007–2020), 7 bp (2015–2026) and 4 bp (2024–2026): smaller in each later sample [my arithmetic].
   - No source deducts costs.

3. **In the US, the unconditional close-to-open trade does not survive costs, and the drift itself has disappeared since 2021.**
   - S&P 500 futures, 2004–2020: close-to-open earned 4.62% a year at mid quotes and 0.38% a year after bid–ask spreads (Sharpe −0.04) [O5].
   - The 2:00–3:00 ET drift has averaged close to zero over Jan 2021–Dec 2025 [O6].

4. **The conditional version, "buy the dip overnight", is the only one with positive after-cost evidence. It is US-only and fading.**
   - Long S&P futures from 1:30 to 3:30 ET, only after negative closing order flow: 6.07% a year gross and 4.04% after spreads, Sharpe 1.10, 2004–2020 [O5].
   - The NY Fed's 2026 update says the imbalance → overnight link is "much narrower" in 2021–2025 [O6].
   - In India it is untested. The program's nearest check points the other way: after heavy FII-selling days, the next open was *lower* (−0.24%, n = 79) [Q2].

5. **Since 1 Apr 2026, futures STT is about as large as an average night's drift. Options carry overnight exposure far more cheaply.**
   - Futures STT is 0.05% of notional, on the sell side [K1].
   - One NIFTY lot (65 × ≈ 22,400 ≈ ₹14.6 lakh) pays ≈ ₹728 of STT per round trip. Five bp of drift on the same notional is also ≈ ₹728 [my arithmetic].
   - Option STT is 0.15% of the *premium* sold [K1]. Per unit of index exposure, that is 20–40× less [my arithmetic; §1.4].
   - The open question is the option buyer's overnight theta and vega. The program's end-of-day split gives a first reading for NIFTY, 2019–2026, before costs [WP6]:
     - an ATM call bought at the close and sold at the next open gained +3.39% of premium a night;
     - an ATM put lost 3.24%.
   - That reading is biased upward by the rich opening print [WP6, WP11]. Only the 1-minute data can settle it.

6. **Turn-of-the-month (TOM) has in-sample Indian support and global replication. It has no after-cost Indian test, and it has decayed in US futures.**
   - Significant for NIFTY 50 and SENSEX over Apr 2007–Feb 2023 (abstract) [C1].
   - Found in 31 of 35 countries; whether India is among them is not verified [C3].
   - Gone from S&P 500 futures after 1990 [C4].
   - Pre-holiday and day-of-week effects are contested or absent in recent NIFTY samples [C5–C9]. As a direction rule they are **folklore**.

7. **Monthly-tenor defined-risk selling has no positive after-cost evidence in India.**
   - The only cost-inclusive test I found is negative for every short-volatility variant after costs, including put-writing (Pillai 2026, 119 monthly cycles, Jan 2015–Apr 2025) [M1].
   - The positive covered-call results are in sample and gross of costs [M2–M4].
   - I found no NSE or third-party PutWrite or BuyWrite index for NIFTY.
   - Only 3% of index-option turnover is in contracts more than seven days from expiry (SEBI FY26) [r2].
   - The program's data give about 90 monthly NIFTY cycles. That is too few for §12's 180 trades without overlapping entries.

8. **Box-spread and put–call-parity arbitrage are not accessible to retail.**
   - Two studies of time-stamped NIFTY option trades agree. After-cost opportunities were "quite frequent" but did not persist "even for two minutes" [B1].
   - Only 78 of 1,358 exercisable boxes were profitable after costs over 2002–2005, and the count fell every year [B2].
   - Today a retail trader also pays STT of 0.15% on sold premium and 0.15% on exercised intrinsic value [K1], plus four legs of spread.
   - A correctly priced box earns only the risk-free rate.
   - The program's trade-based data can describe parity deviations. They cannot show that a quote was there to execute against.

---

## 1. Overnight drift

### 1.1 India: what has been published

| # | Source | Data and definitions | Result | Costs | Grade | Tag |
|---|---|---|---|---|---|---|
| 1 | "The market gives during the night and takes during the day", Substack (handle theschrodingercat), 24 Mar 2026 | NIFTY 50 spot, Mar 2015–Mar 2026, 2,704 days. Overnight = previous 15:25 → 09:25; intraday = 09:25 → 15:25 | Overnight only: +531% cumulative (+18.3% a year). Intraday only: −55%. Overnight positive in 10 of 11 full years, intraday negative in 9 of 11 (intraday +0.2% in 2023, +0.6% in 2025). Overnight win rate ≥ 55% in every full year (69% in 2017); intraday win rate above 52% only twice. The year table is an image and was not read. No weekend split | None | Practitioner untested (in sample, gross) | [O1] |
| 2 | Sandeep Rao, "The overnight drift: why markets move when you're asleep", Zerodha *In The Money*, 15 Oct 2025 | NIFTY 2000–2025, split into 2000–10 and 2011–25; SENSEX from 2000 | Overnight was "muted" before 2011. From 2011: "consistent greens in the overnight column and consistent reds in the intraday column". Links the change to NSE's pre-open call auction (Oct 2010). Figures are only in images. Flags that the official close is the 15:00–15:30 VWAP, not the last trade. Suggests testing on futures, 15:20 → 09:20 | Named (spreads, depth, impact), not quantified | Practitioner untested | [O2] |
| 3 | Praveen Kumar, LinkedIn, 12 May 2020 | NIFTY 2011–Apr 2020; summed log returns; prior close → open and open → close | "92% of the total up move comes in the overnight session". More than all of each down move happened intraday | Author: "trading costs would largely rule out any profits" | Practitioner untested | [O3] |
| 4 | Bruce Knuteson, "Strikingly Suspicious Overnight and Intraday Returns", arXiv 2010.01727 v1, 5 Oct 2020 | Yahoo daily prices for 21 indices to about Oct 2020; NIFTY 50 from 17 Sep 2007, SENSEX from 1 Jul 1997 | NIFTY 50: overnight +1,868%, intraday −87%. SENSEX: overnight +628,056%, intraday −99.86%. Same sign in all 21 indices. The author's explanation (deliberate manipulation) is his own and unreviewed | None | Pattern: replicated across markets (gross). Explanation: folklore | [O4] |
| 5 | Program data [Q1] | NIFTY, real-price sample Jan 2024–Oct 2026 | Open→close averaged −3.9 bp a day; overnight +4.2 bp. NIFTY closed above its open on 46.8% of days | None | Our data, in sample | [Q1] |
| 6 | Program data [WP6] | NSE bhavcopies 2019–2026. "Night" = closing-window midpoint (≈ 15:15) → first print | ATM call bought at the close and sold at the open: +3.39% of premium a night. ATM put: −3.24%. Straddle: +0.01% (1,866 nights). Quiet nights (\|gap\| < 0.86%) cost a straddle buyer 1.65% (t −6.0); top-decile gap nights paid +14.8%. Straddle buyers on NIFTY weekend nights: +0.25%, against −0.07% on weekday nights | Before costs | Our data, in sample; opening-print bias | [WP6] |

Reading:
- **The sign is consistent.** It holds across four authors, two indices, samples starting in 1997, 2007, 2011 and 2015, and the program's own 2024–26 data. For an Indian anomaly, the *gross* pattern is as close to replicated as it gets.
- **The size is falling.** The averages are ≈ 9.2 bp a night for 2007–2020 (from [O4]), ≈ 6.8 bp for 2015–2026 (from [O1]'s 18.3% a year over about 246 nights a year) and 4.2 bp for 2024–2026 [Q1] [my arithmetic].
- **There is no out-of-sample test.** No Indian source deducts costs, trades a real instrument, or holds anything out of sample. The Substack's data end in Mar 2026. The 1-minute data for Apr–Aug 2026, about 100 nights, are the only true post-publication sample.
- **Weekends and periods are missing.** No Indian source splits weekend from weekday nights, or reports magnitudes by period in its text. Both have to come from the program's data (§6, C1 and C5).
- **Definitions matter.**
  - Until 2 Aug 2026 the official index close was the VWAP of the last 30 minutes [O2]; from 3 Aug 2026 it is an auction price [overnight-short-vol.md]. Close-to-open measured from it includes up to about 15 minutes of the session, and nobody could trade at that price.
  - The open is set by the pre-open auction, and the program found options' first prints rich: the ATM straddle's first trade is a median 7.4% above the day's average on NIFTY [WP11, plan §0].
  - Lou, Polk & Skouras use the VWAP of the first half hour as "the open" for this reason [O8].
- **Yahoo opens may be bad.** In Knuteson's chart, SENSEX's overnight return (+628,056% since 1997) is far larger than NIFTY's. That points to bad early opening prices on Yahoo, not a real return [my inference]. Before using Yahoo's 2011–2026 opens, the backtest should check a sample against the official NSE/BSE opens.

### 1.2 Global literature

| # | Study | Sample and instrument | Finding | After costs | Later work | Grade | Tag |
|---|---|---|---|---|---|---|---|
| 7 | Cliff, Cooper & Gulen 2008, working paper, "Return differences between trading and non-trading hours: like night and day" | US stock returns 1993–2006 (from AP coverage; paper not accessed) | Trading at night was more profitable than during the day; the coverage attributes it to after-hours trading by hedge funds | Not seen | Kelly & Clark 2011, *J. Asset Mgmt* 12(2):132–145, "…The difference is day and night" (title only; sign not confirmed) | Single study (US; details unverified) | [O7] |
| 8 | Lou, Polk & Skouras 2019, *JFE* 134:192–213 | US CRSP/TAQ 1993–2013; nine international markets via TRTH as a robustness check. "Open" = the 09:30–10:00 VWAP | Across 14 strategies, profits are earned "entirely overnight (for reversal and a variety of momentum strategies) or entirely intraday". They read this as a tug of war between clienteles. It is a cross-sectional result, not an index-timing rule | Not the focus | — | Replicated (cross-section) | [O8] |
| 9 | Boyarchenko, Larsen & Whelan, NY Fed Staff Report 917, Feb 2020, revised Aug 2022. Published in RFS in 2023 according to a search summary (snippet) | E-mini S&P tick data 1998–2020; strategies 2004–2020, at mid quotes and at bid/ask | The 2:00–3:00 ET drift averages 3.7% a year (1.48 bp a day) and is positive in 20 of 23 years. "Market selloffs generate robust positive overnight reversals, while reversals following market rallies are much more modest." Table IX gives the strategy returns (see below) | Yes, from best bid/ask | See #10 | Single study (in sample) | [O5] |
| 10 | Boyarchenko, Larsen & Whelan, "The Disappearing Overnight Drift", *Liberty Street Economics*, 1 Jul 2026 | E-mini S&P (NQ and YM similar); 1998–2020 against Jan 2021–Dec 2025 (1,245 days) | The 2:00–3:00 window "previously generated roughly 3.7 percent per annum" and "has averaged close to zero since 2021". The spread of closing imbalances fell from 6.5% to 2.9%; the authors call this the only input that "has shifted substantially". Mean VIX moved only from 20.4 to 19.4. The imbalance → overnight link is "much narrower" in 2021–25 | — | — | Out-of-sample decay of #9 | [O6] |
| 11 | Muravyev & Ni 2020, *JFE* 136:219–238 | S&P 500 index options, delta-hedged | Average return about −0.7% a day: about −1% close→open and +0.3% open→close. Their reading: option prices do not reflect that volatility is much higher during the session than overnight | Not seen | India: Bhat et al. 2024 (#12) find the same sign; the program's WP6 did not find it for NIFTY 2019–26 | Replicated in the US; contested for NIFTY | [O9] |
| 12 | Bhat, Pandey & Rao 2024, *J. Futures Markets* 44(8):1320–1337 | NIFTY options, NSE 2017–2020 [strategy-plan] | Short options earn positive, significant returns overnight and negative returns intraday, weaker on jump days. The sellers' variance premium "is mainly a reward for overnight risk" | A third-party summary says the strategy is not profitable after costs (secondary, snippet) | WP6 (2019–2026) finds the reverse: NIFTY nights ≈ 0 for buyers | Single study, contested | [O10] |
| 13 | Della Corte & Kosowski, "Market Closure and Short-Term Reversal" (CICF paper 357) | International indices and index futures | About 25–39% of the overnight return reverses intraday, against about 2% of intraday returns (via r4) | Not seen | Program: the gap's direction gave no intraday edge (48% of gap-up days closed above the open) [plan N9] | Already covered by r4 (pre-open gaps) | [O11] |

SR 917, Table IX (2004–2020, annualised; returns at mid quotes, then after paying the bid–ask spread):

| Strategy | Return at mid | Return after spread | Sharpe at mid | Sharpe after spread |
|---|---|---|---|---|
| Close → open (16:15 → 09:30) | 4.62% | 0.38% | 0.34 | −0.04 |
| Overnight drift, 2:00–3:00 | 3.75% | −0.59% | 1.10 | −0.54 |
| Extended drift, 1:30–3:30 | 6.21% | 1.91% | 1.30 | 0.26 |
| **Buy the dip**: 1:30–3:30, only after negative closing order flow | 6.07% | **4.04%** | 1.78 | **1.10** |

### 1.3 Trading the drift with index options: the buyer's overnight theta and vega

- **The mechanics.** A long ATM call carries about 0.5 of the drift and pays one night's theta plus any overnight change in implied volatility.
- **In the US the drift is roughly used up by the option's overnight loss.**
  - Delta-hedged index options lose about 1% of their value close-to-open [O9].
  - A 0.5-delta call gains about 0.5 × 4 bp ≈ 2 bp of spot from the drift. That is about 1% of a premium worth 2% of spot [my arithmetic].
  - The two roughly cancel.
- **The program's end-of-day reading for NIFTY is different [WP6].**
  - The straddle's night return is about zero, so the call/put split (+3.39% / −3.24%) is the drift showing through the call's exposure to the index.
  - Two biases favour the call, and both need the 1-minute data to remove:
    - the exit is the first print, which is rich [WP11];
    - the entry is the closing-window midpoint (≈ 15:15), not a tradeable 15:25 price.
  - On quiet nights the straddle buyer loses 1.65%. That is the theta-and-vega cost a single call pays when the gap is small [WP6].
- **The exit time matters.** Implied volatility settles after the open [r4, Q1]. Exiting at 09:30 instead of 09:15 gives up the rich opening print in exchange for a price that can actually be traded, and pays the first quarter-hour's decay.
- **Practitioner use.**
  - The Zerodha piece lists long calls, short puts, synthetic futures and long OTM puts as hedges as ways to express the drift. It has no backtest [O2].
  - "BTST options" tips (buy a call at 15:20, sell at 09:20) circulate widely; I found no costed test of them. **Folklore.**

### 1.4 Costs by route (dated)

| Route | Main tax | Other costs | Per night |
|---|---|---|---|
| NIFTY futures, 1 lot (65 × ≈ 22,400 ≈ ₹14.6 lakh notional) | STT 0.02% of notional on the sell side until 31 Mar 2026; **0.05% from 1 Apr 2026** [K1] | Brokerage, exchange, SEBI, stamp and GST: use the program's dated charges model (WP10). Spread: from the data | STT alone is ≈ ₹291 per round trip before Apr 2026 (2 bp) and ≈ ₹728 from Apr 2026 (5 bp). The published average drift is ≈ 4–9 bp a night [my arithmetic; O1, O4, Q1] |
| Synthetic long via options (long ATM call + short ATM put) | STT 0.1% of sold premium until 31 Mar 2026; **0.15% from 1 Apr 2026** [K1] | Four legs of spread (WP11's cautious fill); brokerage per order | STT falls on the premium of the two legs sold. With ATM legs at 100–200 points [assumption], that is ≈ 0.3–0.6 index points per round trip, against 11.2 points for a future (0.05% of 22,400). The four legs' spread is the main cost |
| Single long ATM call (₹5 lakh account; also measures the buyer's theta) | STT as above, on the one sale | Two legs of spread | Captures about half the index move; pays theta and vega |
| NIFTY ETF (e.g. NIFTYBEES), bought today and sold tomorrow (BTST) | STT 0.001% on the sell side for equity ETFs (broker help pages) [K2] | Stamp duty 0.015% on delivery buys (IBKR fee table; ETF-specific rate not confirmed) [K2]. A DP charge per sell day. A forum post puts NIFTYBEES's impact cost at 0.06% (date not seen) [K3] | Fits even the ₹5,000 account. But stamp duty (1.5 bp) plus the spread or impact may be larger than the drift. Measure the spread before testing |

Rule of thumb [my arithmetic]: since April 2026, an unconditional overnight hold in NIFTY futures must earn more than 5 bp a night before any other cost. Per unit of index exposure, an ATM synthetic pays roughly 20–40× less STT.

### 1.5 Mechanism: who is on the other side

- **Dealer inventory risk** [O5, O6]. Liquidity providers absorb the sell imbalances at the end of the day and are paid when overnight and foreign buyers arrive. The drift shrank in the US when the closing imbalances did. The model predicts a larger drift after sell-offs, which is the "buy the dip" variant.
- **Clienteles** [O8]. Different investors trade at the open and at the close. In India the open is set by the pre-open call auction, in place since Oct 2010 [O2].
- **India-specific hypotheses. These are untested and folklore-grade:**
  - brokers automatically square off intraday (MIS) positions in the last 15–20 minutes, which may depress the close;
  - the cash market allows no naked overnight shorts (a commenter on [O3]);
  - the US session's news arrives overnight [r4].
- **It is risk, not free money.** Overnight gaps are 42–55% of NIFTY's daily variance [Q1]. Whoever holds overnight carries the gap.

---

## 2. Turn of the month, pre-holiday and day of week

| # | Study | Sample | Finding | Out of sample? Costs? | Grade | Tag |
|---|---|---|---|---|---|---|
| 1 | Satish & Bheemanagouda 2023, *Review of Finance and Banking* 15(2):101–118 | NIFTY 50, SENSEX and two small-cap indices, Apr 2007–Feb 2023; t-tests and Mann-Whitney | TOM effect "significant", stronger in small caps. DIIs trade heavily at month-end; individuals do not. The abstract gives no window definition and no magnitudes | Neither | Single study (in sample) | [C1] |
| 2 | Mangala & Sharma 2007, *Paradigm* 11(2):16–22 | NIFTY 1994–2005 | High mean returns on the days just before the month and in its first half, especially the first few trading days (snippet) | No | Single study (old) | [C2] |
| 3 | McConnell & Xu 2008, *FAJ* 64(2):49–64 | 35 countries | TOM effect in 31 of 35. Not explained by month-end buying pressure, volume or fund flows. Whether India is in the sample is not verified | No | Replicated (global) | [C3] |
| 4 | Maberly & Waggoner 2000, Atlanta Fed WP 2000-11 | S&P 500 spot and futures | The effect disappeared from S&P futures after 1990. The patterns are "subject to change without notice" | — | Evidence of decay | [C4] |
| 5 | Lu & Patel 2016, *Economics Bulletin* (eb-16-00286) | BSE indices | Pre-holiday effect "completely missing". A strong post-holiday effect, stronger during the financial crisis | No | Single study (negative for pre-holiday) | [C5] |
| 6 | Sing, Ropuii & Singh 2025, *Indian Journal of Finance* | SENSEX and NIFTY 50, Jul 2020–Dec 2022 | Pre-holiday effects around Christian and Jain holidays; post-holiday effects around Hindu and Sikh holidays; none around Islamic holidays (snippet) | No; only 2.5 years, with many subgroup tests | Folklore-grade (data-mined subgroups) | [C6] |
| 7 | Inflibnet thesis, "An Empirical Analysis of Calendar Anomalies in Stock Returns: Evidence from India" | NIFTY, SENSEX and BSE 500, 2002–2014 | "No Holiday effect" in any period (snippet) | No | Single study (negative) | [C7] |
| 8 | Saxena, Purohit & Malhotra, "Diminishing calendar anomalies: case of Indian equity markets", *GBER* 24(1):43–58 (online 22 Dec 2020) | NIFTY 50 and three sector indices, Jan 2011–Jan 2018 | No day-of-week effect in any index; no month-of-year effect in NIFTY 50 | No | Single study (negative) | [C8] |
| 9 | COVID-era study (PMC7995132); MPRA paper 46805 | NIFTY 50 and related indices 2005–2020; NIFTY and SENSEX 1997–2012 | Monday negative during the crisis and positive before it (snippet). The older GARCH paper finds positive Monday and Wednesday effects | No | Contested | [C9] |
| 10 | Quantpedia, "Turn of the month in equity indexes" | — | The standard practitioner window: the last trading day plus the first three trading days of the next month | — | Definition only | [C10] |

Reading:
- **TOM is the only calendar effect with a recent, positive Indian study.** It is in sample, has no costs, and its abstract gives no magnitudes. The global record says the effect fades in liquid futures.
- **Pre-holiday and day-of-week effects in NIFTY.** Recent studies are either negative or mine many subgroups. As a direction rule they are **folklore**. The program has already shown that Monday's higher premiums are a quirk of how India VIX counts time [Q1].
- **Mechanism for TOM in India (hypotheses).**
  - Inflows at the start of the month: salaries and SIP debits.
  - DIIs trading at month-end [C1].
  - The other side is whoever sells into predictable flow, mostly liquidity providers.

---

## 3. Monthly-tenor (30–45 days to expiry) defined-risk premium selling

| # | Source | Strategy and sample | Result | Costs | Grade | Tag |
|---|---|---|---|---|---|---|
| 1 | Pillai 2026, SSRN 6876580, 30 May 2026 (abstract via search; see r1 and r2) | ATM short straddle, crash-neutral, put-write and delta-hedged straddle; 119 NIFTY monthly expiry cycles, Jan 2015–Apr 2025 | Every variant negative after costs; the straddles lose about 44–45% a year. The premium exists, but tail risk and costs absorb it | STT, brokerage, slippage | Single study (preprint), negative | [M1] |
| 2 | Aggarwal 2011, *Asia-Pacific Business Review* | Covered calls on NIFTY: five strikes, one- to three-month expiries, NSE daily closes, Oct 2005–Sep 2010 | The 5%-in-the-money covered call beat the index on standard measures at every expiry (snippet) | Not stated | Single study (in sample) | [M2] |
| 3 | Misra & Dalmia 2007, *Management Dynamics* 7(2) | Covered call and protective put on NIFTY | Both beat the unhedged index on risk and return; the covered call earned more (snippet) | Not stated | Single study (in sample) | [M3] |
| 4 | TradingQnA, "Nifty Covered Call Strategy – Backtest results", 17 Jun 2020 | Long NiftyBeES plus a short 3%-OTM monthly call, 2007–2020 | +₹1.12 lakh on top of ₹4.5 lakh from the index; "only 2 years negative". One reply says excluding 2008 "would have completely nullified the gains"; another says a manual check of 2020–21 is "not looking good" | None | Practitioner untested | [M4] |
| 5 | Shivaprasad et al. 2022, *Cogent Economics & Finance* | Covered calls and covered puts on NSE sector indices, 2009–2020 | Effective as hedges. Not a test of returns after costs (snippet) | — | Not relevant to (b) | [M5] |
| 6 | Cboe on Bondarenko's paper, post of 29 May 2019 | US PUT index (cash-secured monthly ATM S&P 500 puts), Jun 1986–Dec 2018 | +1,835% cumulative. Volatility 9.95%, against 14.93% for the S&P 500. Beta 0.56, monthly alpha 0.2%, skew −2.09. Over 1990–2018, VIX averaged 19.3 against 15.1 realised | It is an index (no trading costs) | Replicated premium (US) | [M6] |
| 7 | Search for an NSE or third-party NIFTY PutWrite or BuyWrite index | — | None found. I searched only; I did not browse the NSE Indices site | — | — | [M7] |

Reading and constraints:
- **Evidence.** The only cost-inclusive Indian test is negative. The positive Indian results have no costs; in the forum test, the covered call's gain depends on one crash year (2008).
- **Liquidity.** Only 3% of index-option turnover is in contracts more than seven days from expiry (SEBI FY26) [r2]. Strikes at 30–45 days will have wide spreads.
- **Capital.**
  - A covered call on one NIFTY lot needs ≈ ₹14–15 lakh of ETF units [my arithmetic], above the ₹5 lakh ceiling.
  - The ₹5 lakh version has to be a synthetic (long future plus short call, which is close to a short put) or a put spread.
  - WP10 sized a weekly iron condor at ≈ ₹0.78 lakh of margin, ₹1.37 lakh on expiry day [WP10]. Monthly margins are not verified.
- **Mechanism.** Hedgers demand index puts, which creates the variance and skew premium; the seller is paid for carrying crash risk. In India the premium exists, but the tail and the costs take it: [M1] for monthlies, WP10 for weeklies.
- **The §12 bar.** NIFTY 2019–2026 gives about 90 monthly cycles. Reaching 180 trades needs overlapping weekly entries into the monthly contract, and those trades are correlated, so they need a bootstrap that resamples whole cycles.

---

## 4. Box-spread and put–call-parity arbitrage on NSE index options

| # | Study | Data | Finding | Grade | Tag |
|---|---|---|---|---|---|
| 1 | Vipul 2009, *J. Futures Markets* 29(6):544–562 | NIFTY options, time-stamped trades | After-cost opportunities were "quite frequent" but "do not persist even for two minutes". They were larger in contracts with more liquidity risk, which the paper ties to moneyness and volatility (abstract) | Single study | [B1] |
| 2 | Girish & Rastogi 2013, *Gadjah Mada International Journal of Business* 15(3):269–285 | NIFTY options, time-stamped trades, 1 Jan 2002–31 Dec 2005 | 1,358 exercisable boxes, of which 78 were profitable after costs: 32 in 2002, 19 in 2003, 14 in 2004 and 13 in 2005. Efficiency improved over the period | Single study (agrees with #1) | [B2] |
| 3 | Mutum et al. 2018, *Indian Journal of Finance* | Daily closing prices, 2012–2017 | "Frequent" violations of box parity, concentrated in illiquid and near-expiry options (snippet). Closing prices are not simultaneous, so most of these could not have been traded | Single study (non-synchronous data) | [B3] |
| 4 | Practitioner explainer (onetradejournal; date not seen) | — | Calls the STT on exercised in-the-money options (then 0.125%) "a major drag". Treats the box as a synthetic loan whose implied rate is compared with 6.5–7% FD or T-bill rates | Practitioner | [B4] |

Retail arithmetic [my arithmetic; the bracketed items are assumptions]:
- A 1,000-point NIFTY box pays 1,000 × 65 = ₹65,000 at expiry.
- Held to settlement, the exercised long legs pay STT of 0.15% of intrinsic value [K1]: at least ≈ ₹97.5.
- On top come 0.15% STT on the premium of the two legs sold [K1], four orders of brokerage, GST, and four half-spreads [WP11 model].
- One month's interest at 6.5% a year is ≈ ₹350 on ₹65,000. The STT and spread on a one-month box are of the same order.
- So even a correctly priced box leaves a retail lender with less than the T-bill rate. Any arbitrage needs a mispricing larger than all of these costs.
- No source I found documents a retail after-cost profit. The latency evidence (opportunities gone within two minutes, in 2009) rules out executing by hand.

Grade: **replicated** that after-cost opportunities exist only fleetingly. **Not accessible to retail.**

---

## 5. Other candidates considered

| Candidate | Evidence | Grade | Why not prioritised | Tag |
|---|---|---|---|---|
| Pre-FOMC drift in NIFTY | Lucca & Moench 2015 (*JF* 70(1)): US and other major indices rose ahead of FOMC announcements. Kurov, Wolfe & Gilbert 2021 (*FRL* 40): largely gone after 2015. No India study found | Replicated, then decayed (US). Folklore for NIFTY | About 8 events a year. WP13 covers the option side of event eves | [X1], [X2] |
| Volatility-managed index exposure (scale exposure by inverse variance) | Cederburg, O'Doherty, Wang & Yan 2020 (*JFE* 138:95–117): across 103 strategies, the versions that can be run in real time do not beat the unmanaged ones; the regression alphas cannot be implemented | Replicated in sample; fails out of sample | Not an edge on its own | [X3] |
| Knuteson's "manipulation" explanation of the overnight pattern | One unreviewed author [O4] | Folklore (as an explanation) | The pattern is real; the story is untested | [O4] |
| "BTST options" and overnight call tips | Social-media claims; no costed test found | Folklore | Covered by C1's options route | — |
| Cash–futures arbitrage (arbitrage funds) | Earns roughly the money-market rate (my characterisation; not researched here) | Not an edge | Serves only as the benchmark for box rates | — |

---

## 6. Candidate cards, ranked by evidence quality × testability

### Conventions shared by every sketch

- **Split.** Fit on the first 60% of days and judge on the last 40%, as in WP13 and WP14. Unconditional variants have nothing to fit, because the published claims fix them in advance. Report the full sample, the last 40%, and the post-publication window (Apr–Aug 2026 for C1).
- **Costs and fills.** Costs: the program's dated charges model plus the STT schedule in §1.4. Fills: WP11's cautious fill at minute closes, never the first print.
- **§12 bar.**
  - ≥ 180 trades;
  - bootstrap 95% CI above zero, per trade and per day;
  - profit factor ≥ 1.3;
  - survives ±20% parameter changes;
  - positive in each half and in most years.
- **Placebos.** The same structure held over the same day's session (09:30 → 15:25), and a sign-flipped (short) version. Log every variant in reports/trials.jsonl.
- **Scope.** Owner rule N5 (no overnight holds) applies to the live engine. These are paper studies for the ₹5 lakh account only.

### C1 — Unconditional overnight long on NIFTY (and SENSEX), options route

- **Definition.**
  - **Main variant.** Every trading day at the 15:25 minute close, buy one synthetic long: an ATM call plus a short ATM put, at the strike nearest the 15:25 synthetic forward. Use the nearest NIFTY weekly with ≥ 2 sessions left. Sell at the 09:30 minute close of the next session.
  - **Variant B.** A single long ATM call. This measures the buyer's overnight theta and vega.
  - **Variant C.** The near-month future from the bhavcopies, close → next open. Robustness only, because of the opening-print bias.
  - **Spot decomposition.** Yahoo 2011–2026: close → open against open → close, by year, weekday against weekend night, and VIX tercile.
- **Evidence.**
  - India: gross and in sample, from four independent sources plus the program's data [O1–O4, Q1, WP6].
  - US after costs: the unconditional close → open trade fails (0.38% a year net), and the drift vanished in 2021–25 [O5, O6].
  - **Grade: replicated pattern (gross). No positive after-cost or out-of-sample evidence anywhere.** It fails condition (b).
- **Mechanism.** Being paid for providing liquidity against closing imbalances and for bearing overnight risk [O5]; clienteles at the auction open [O8].
- **Capital.**
  - Synthetic or future: one lot is ≈ ₹14.6 lakh of notional. Margin not verified; use the WP10 margin model.
  - Single ATM call: one lot's premium.
  - The ₹5,000 account could only use ETF units or a far-OTM call, and the plan rejects far-OTM calls (N6).
- **Testable?** Yes, well:
  - NIFTY 1-minute data, May 2021–Aug 2026 (about 1,300 nights);
  - SENSEX 1-minute data, Aug 2023–Jul 2026 (about 740 nights);
  - bhavcopies 2019–2026;
  - Yahoo 2011–2026.
- **Pre-registration sketch.**
  - **Hypothesis.** The mean net P&L per night of the NIFTY synthetic long, 15:25 → 09:30, is above zero at the cautious fill with dated costs.
  - **Fixed parameters.** Entry 15:25; exit 09:30; ATM chosen by the synthetic forward; nearest weekly with ≥ 2 sessions left (next week's contract when only one session is left); one lot; no filters.
  - **Robustness checks.** These are reported, never used to pick a variant: exit at 09:20 or 09:45, or the 09:16–09:45 VWAP; entry at 15:20 or 15:28; strike ±1.
  - **Report:** results by year; weekend against weekday nights; pre-holiday nights; VIX terciles; before and after the 1 Apr 2026 STT change; and variant B's split of the call's P&L into the part explained by the index move (0.5 × the move) and the rest (theta plus vega).
  - **Pass** only if C1 clears §12 on NIFTY and shows the same sign on SENSEX.
  - **Kill** if the net is ≤ 0 after Apr 2026, or if the gain disappears when the exit moves from the first print to 09:30 (an opening-print artefact).

### C2 — Conditional overnight long after a weak session ("buy the dip overnight")

- **Definition.**
  - As C1, but only on days when NIFTY's 09:30 → 15:25 return is in the bottom third of its trailing 250 sessions. The signal is known at 15:25.
  - An alternative signal, fixed in advance: the last hour's return (14:25 → 15:25) is negative. This is the closest proxy for SR 917's negative closing order flow.
- **Evidence.**
  - US 2004–2020: 4.04% a year after bid–ask, Sharpe 1.10 [O5]. The conditional link narrowed in 2021–2025 [O6].
  - India: untested. The program's hints are mixed:
    - after NIFTY days below −1.5%, the next day was up 64% of the time (2020–26) [plan N8];
    - after heavy FII-selling days, the next open was lower (−0.24%, n = 79) [Q2].
  - **Grade: single study (US, in sample, after costs), with out-of-sample decay.**
- **Mechanism.** Dealers who absorb a sell-off demand a larger premium for carrying that inventory overnight [O5].
- **Capital.** As C1.
- **Testable?** Yes. About a third of nights qualify (≈ 430 NIFTY nights in the 1-minute data).
- **Pre-registration sketch.**
  - Fit the threshold on the first 60% of days, choosing from: bottom 20%, bottom 33%, or a return below −0.5%. Judge on the last 40%.
  - It must beat C1 on the same nights (the CI of the difference above zero), and beat a random draw of the same number of nights.
  - Same costs and §12 bar as C1.

### C3 — Turn-of-the-month long

- **Definition.** Long NIFTY (synthetic or near-month future) from the 15:25 close of the second-to-last trading day of month m to the 15:25 close of the third trading day of month m+1. This is the standard four-day window [C10]. One trade a month.
- **Evidence.** India: significant in sample over 2007–2023, with no costs and no magnitudes seen [C1, C2]. Global: 31 of 35 countries [C3]. Decayed in US futures [C4]. **Grade: single study (India), replicated abroad, decayed in futures.**
- **Mechanism.** Predictable flows at the start of the month (salaries, SIPs) and DII trading at month-end [C1]. A hypothesis.
- **Capital.** As C1, but held four sessions, through overnight and weekend gaps.
- **Testable?** Yes, for the size of the effect: Yahoo 2011–2026 gives about 185 windows; options and futures 2019–2026 give about 90. Too few for §12 on its own; it can serve as a filter on C1.
- **Pre-registration sketch.**
  - **Primary.** The mean four-day TOM return minus the mean of all other four-day windows. Yahoo 2011–2018 against 2019–2026, with a block bootstrap.
  - **Secondary.** The synthetic's net P&L over 2019–2026 with dated costs.
  - **Variants.** Only the [−1, +3] window.
  - Report TOM nights inside C1 as a breakdown, not as a selection rule.

### C4 — Monthly put-credit spread, iron condor or synthetic covered call (30–45 days to expiry)

- **Definition.**
  - **Put spread.** On the first session with 30–45 calendar days to the monthly NIFTY expiry, at the closing VWAP (the WP10 convention): sell the put nearest one 30-day expected move (EM_30) below the forward, buy the put two EM_30 below, and hold to cash settlement.
  - **Iron condor.** Add the mirrored call spread.
  - **Synthetic covered call.** Long near-month future plus a short call one EM_30 above.
  - No discretionary management.
- **Evidence.** India after costs: negative [M1]. Positive results are gross and in sample [M2–M4]. The US PUT index shows a long-run premium [M6]. **Grade: one negative study (India); practitioner untested (positive).** It fails condition (b).
- **Mechanism.** Hedgers' demand for crash insurance; the seller bears the tail.
- **Capital.** Put-spread margin not verified (a weekly condor is ≈ ₹0.78 lakh [WP10]). A covered call on ETF units is ≈ ₹14–15 lakh per lot, above ₹5 lakh.
- **Testable?** Yes, on bhavcopies 2019–2026 (closes and settlement prices). On the 1-minute data only if it carries monthly contracts, which the backtest agent should check. About 90 cycles.
- **Pre-registration sketch.**
  - Fix the wing and short-strike distances in advance: one and two expected moves.
  - Enter weekly into the 30–45-day monthly contract. Compute P&L per cycle, with a block bootstrap by cycle.
  - Report the worst cycle (March 2020) explicitly.
  - Apply the §12 bar, but state that fewer than 180 independent cycles limits the test's power.

### C5 — Weekend against weekday nights, day of week, pre-holiday (breakdown only)

- **Definition.** Split C1's nights by type: Friday → Monday, pre-holiday, and ordinary weekday nights.
- **Evidence.** Contested or negative [C5–C9]. WP6 found weekend nights no worse for NIFTY straddle buyers.
- **Grade: folklore** as a stand-alone rule.
- **Pre-registration sketch.** No separate trade. Report C1's mean by night type, with CIs. Promote a split only if it holds in both halves and passes multiple testing at C1's family size.

### C6 — Box-spread and parity arbitrage (descriptive only)

- **Definition.** A long box with strikes K1 < K2 on the same NIFTY expiry: long call K1, short call K2, long put K2, short put K1. Compute the implied annual rate from the four legs' prices in the same minute and compare it with the 91-day T-bill.
- **Evidence.** After-cost opportunities were rare (78 of 1,358 boxes over 2002–2005) and lasted under two minutes [B1, B2]. **Grade: replicated; not accessible to retail.**
- **Mechanism.** Market makers and arbitrage desks with low latency.
- **Capital.** The net premium (about the discounted box value) plus margin on the short legs.
- **Testable?** Only descriptively. The data are trades, not quotes, and the four legs rarely print in the same second.
- **Pre-registration sketch.** Count the minutes in which all four legs traded and the implied rate differs from the T-bill rate by more than the full retail cost. Expect a count near zero. No trade unless recorded quotes (the WP10/WP11 quote-recording plan) show executable deviations.

### Ranking summary

| Rank | Candidate | Meets (a)? | Meets (b)? | Meets (c)? | Evidence grade | Testable on program data |
|---|---|---|---|---|---|---|
| 1 | C1 overnight long, options route | ₹5 lakh only | No (gross only; US net fails) | Yes | Replicated pattern, gross | Yes: 1-minute options 2021–26, bhavcopies, Yahoo |
| 2 | C2 buy the dip overnight | ₹5 lakh only | US only, in sample, decaying | Yes | Single study (US) | Yes: 1-minute options |
| 3 | C3 turn of the month | ₹5 lakh only | No | Yes | Single study (India, in sample); replicated abroad | Effect size yes; too few trades for §12 alone |
| 4 | C4 monthly defined-risk selling | ₹5 lakh only (not the covered call) | No (India net negative) | Yes (weeklies only in WP10) | Single study, negative | Bhavcopies; about 90 cycles |
| 5 | C5 night-type and day-of-week breakdown | — | No | Partly (WP6 for options) | Folklore | Yes, as a breakdown of C1 |
| 6 | C6 box and parity | No (latency, costs) | No | Yes | Replicated (fleeting) | Descriptive only |

---

## 7. Access failures and gaps

| Item | What happened |
|---|---|
| Medium, "India's Best Investor Was Asleep the Whole Time" | HTTP 403; not read |
| Pillai 2026, SSRN 6876580 | HTTP 403 again; the abstract-level claims come from r1 and r2 |
| Cliff, Cooper & Gulen 2008 | Paper and abstract not accessed. The claim comes from AP coverage (ksl.com); co-authors and the exact abstract not seen |
| Kelly & Clark 2011 | Title only (IDEAS); the sign was not confirmed |
| NY Fed SR 917 | The fetch tool could not parse the PDF. I converted the single PDF to text locally and read the abstract, §V and Table IX. The RFS 2023 publication is from a search summary only |
| Knuteson 2020; Lou–Polk–Skouras 2019; Girish & Rastogi 2013 | PDFs converted to text locally and read; Knuteson's numbers are labels on a chart |
| Della Corte & Kosowski | Not re-fetched; the numbers are taken from r4 |
| Bhat, Pandey & Rao 2024 | Full text not accessed; the after-cost claim is from a third-party summary (snippet) |
| Theschrodingercat Substack; Zerodha *In The Money* | The year tables and charts are images, so per-year magnitudes and any weekend splits were not read |
| Satish & Bheemanagouda 2023 | Abstract only: no window definition and no magnitudes |
| McConnell & Xu 2008 | Abstract only; whether India is in the 35-country sample is not verified |
| Vipul 2009; Mutum et al. 2018; Aggarwal 2011; Misra & Dalmia 2007; Shivaprasad 2022; Sing et al. 2025; Lu & Patel 2016; COVID-era DOW study | Abstracts or search snippets only. For Mutum et al., the search surfaced two listing pages, and I could not confirm which one is the paper (see [B3]) |
| A Zerodha *In The Money* episode testing turn-of-the-month on NIFTY | Seen only in a search summary, with no figures and no URL captured; not used |
| NSE or third-party NIFTY PutWrite/BuyWrite index | None found by search; the NSE Indices site was not browsed |
| NIFTY futures margin and bid–ask spread; DP charges; ETF-specific stamp duty | Not verified. The backtest should take them from the WP10 margin and charges models and from data |
| Indian magnitudes by period, weekend vs weekday nights, and post-2020 behaviour for the index drift | No web source reports them in text. They must come from the program's data (C1, C5) |

---

## 8. Sources

Overnight drift: India
- [O1] theschrodingercat (Substack), "The market gives during the night and takes during the day.", 24 Mar 2026. https://theschrodingercat.substack.com/p/the-market-gives-during-the-night
- [O2] Rao, S. (Zerodha, *In The Money*), "The overnight drift: why markets move when you're asleep", 15 Oct 2025. https://inthemoneybyzerodha.substack.com/p/the-overnight-drift-why-markets-move
- [O3] Kumar, P. (LinkedIn), "Overnight vs intraday returns in Indian equity markets", 12 May 2020. https://www.linkedin.com/pulse/overnight-vs-intraday-returns-indian-equity-markets-praveen-kumar
- [O4] Knuteson, B., "Strikingly Suspicious Overnight and Intraday Returns", arXiv 2010.01727 v1, 5 Oct 2020. https://arxiv.org/pdf/2010.01727
- Not read (403): Medium, "India's Best Investor Was Asleep the Whole Time". https://medium.com/@divyanshs1ngh/indias-best-investor-was-asleep-the-whole-time-e7fe990118e8

Overnight drift: global
- [O5] Boyarchenko, N., Larsen, L. C., Whelan, P., "The Overnight Drift", Federal Reserve Bank of New York Staff Report 917, Feb 2020, revised Aug 2022. https://www.newyorkfed.org/medialibrary/media/research/staff_reports/sr917.pdf ; blog version, 26 May 2021: https://libertystreeteconomics.newyorkfed.org/2021/05/the-overnight-drift-in-us-equity-returns ; IDEAS: https://ideas.repec.org/p/fip/fednls/92064.html
- [O6] Boyarchenko, N., Larsen, L. C., Whelan, P., "The Disappearing Overnight Drift", *Liberty Street Economics*, 1 Jul 2026. https://libertystreeteconomics.newyorkfed.org/2026/07/the-disappearing-overnight-drift/
- [O7] Cliff, Cooper & Gulen (2008), "Return differences between trading and non-trading hours: like night and day", working paper (not accessed); AP coverage (date not seen): https://www.ksl.com/article/7287966 ; Kelly & Clark (2011), "Returns in trading versus non-trading hours: The difference is day and night", *J. Asset Management* 12(2):132–145: https://ideas.repec.org/a/pal/assmgt/v12y2011i2d10.1057_jam.2011.2.html
- [O8] Lou, D., Polk, C., Skouras, S. (2019), "A tug of war: Overnight versus intraday expected returns", *JFE* 134:192–213 (online 25 Apr 2019). https://personal.lse.ac.uk/polk/research/TugOfWar.pdf
- [O9] Muravyev, D., Ni, X. (2020), "Why do option returns change sign from day to night?", *JFE* 136(1):219–238. https://ideas.repec.org/a/eee/jfinec/v136y2020i1p219-238.html
- [O10] Bhat, A., Pandey, P., Rao, S. V. D. N. (2024), "The asymmetry in day and night option returns: Evidence from an emerging market", *J. Futures Markets* 44(8):1320–1337. https://ideas.repec.org/a/wly/jfutmk/v44y2024i8p1320-1337.html ; third-party summary (date not seen): https://harbourfrontquant.substack.com/p/volatility-risk-premium-is-a-reward
- [O11] Della Corte & Kosowski, "Market Closure and Short-Term Reversal", CICF paper 357 (via r4). https://www.cicfconf.org/sites/default/files/paper_357.pdf

Costs and regulation
- [K1] STT from 1 Apr 2026: futures 0.02% → 0.05% (sell side); options premium 0.1% → 0.15%; exercise 0.125% → 0.15%. ICICI Direct: https://www.icicidirect.com/ilearn/futures-and-options/articles/stt-changes-in-budget-2026-what-f-o-traders-should-know ; Zerodha support: https://support.zerodha.com/category/account-opening/resident-individual/ri-charges/articles/how-is-the-securities-transaction-tax-stt-calculated ; Outlook Money: https://www.outlookmoney.com/invest/stt-hike-from-april-1-2026-budget-what-it-means-for-futures-and-options-traders (all accessed 10 Oct 2026; page dates not seen)
- [K2] ETF charges: Groww help page on STT (snippet): https://groww.in/help/stocks/sx-pricing/what-is-stt ; TradingQnA on NiftyBees charges: https://tradingqna.com/t/charges-and-transaction-costs-for-buying-1-unit-of-niftybees-on-kite-zerodha/181452?page=2 ; Interactive Brokers India fee table (stamp duty 0.015% on delivery buys): https://institutions.interactivebrokers.com/en/accounts/fees/indiaStockExchangeFees.php
- [K3] TradingQnA, NiftyBees impact cost 0.06% (date not seen): https://tradingqna.com/t/uti-nifty-etf-x-niftybees-etf/60942/5

Calendar effects
- [C1] Satish, N., Bheemanagouda (2023), "Indian Stock Market Regularity: The Turn of the Month Effect", *Review of Finance and Banking* 15(2):101–118. https://rfb.ase.ro/Vol15-2023/dec2a.asp ; https://ideas.repec.org/a/rfb/journl/v15y2023i2p101-118.html
- [C2] Mangala & Sharma (2007), *Paradigm* 11(2):16–22 (snippet). https://ideas.repec.org/a/sae/padigm/v11y2007i2p16-22.html
- [C3] McConnell & Xu (2008), "Equity Returns at the Turn of the Month", *FAJ* 64(2):49–64. https://rpc.cfainstitute.org/research/financial-analysts-journal/2008/equity-returns-at-the-turn-of-the-month ; https://ideas.repec.org/a/taf/ufajxx/v64y2008i2p49-64.html
- [C4] Maberly, E. D., Waggoner, D. F. (2000), Atlanta Fed Working Paper 2000-11. https://www.atlantafed.org/research/publications/wp/2000/11.aspx
- [C5] Lu & Patel (2016), holiday anomalies in India, *Economics Bulletin* (snippet). https://ideas.repec.org/a/ebl/ecbull/eb-16-00286.html
- [C6] Sing, Ropuii & Singh (2025), "Religious Holiday Anomaly: Evidence from the Indian Equity Market", *Indian Journal of Finance* (snippet). https://indianjournalofentrepreneurship.com/index.php/IJF/article/view/174848
- [C7] Inflibnet thesis, "An Empirical Analysis of Calendar Anomalies in Stock Returns Evidence from India" (snippet). https://sgbeta.inflibnet.ac.in/items/1960e11b-8db2-4cda-abc2-0605ba4cf29b
- [C8] Saxena, S., Purohit, H., Malhotra, N. (2021), "Diminishing calendar anomalies: case of Indian equity markets", *Global Business and Economics Review* 24(1):43–58, online 22 Dec 2020. https://www.inderscience.com/filter.php?aid=111999 ; https://ideas.repec.org/a/ids/gbusec/v24y2021i1p43-58.html
- [C9] COVID-era day-of-week study (snippet): https://pmc.ncbi.nlm.nih.gov/articles/PMC7995132 ; MPRA paper 46805 (1997–2012, snippet): https://mpra.ub.uni-muenchen.de/46805/1/MPRA_paper_46805.pdf
- [C10] Quantpedia, "Turn of the Month in Equity Indexes" (definition). https://quantpedia.com/strategies/turn-of-the-month-in-equity-indexes

Monthly-tenor selling
- [M1] Pillai, S. (2026), "Trading the Volatility Risk Premium on Nifty 50: Strategy Backtest with Realistic Frictions", SSRN 6876580, 30 May 2026 (abstract via search; 403). https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6876580
- [M2] Aggarwal, N. (2011), covered calls on S&P CNX Nifty, *Asia-Pacific Business Review* (snippet). https://gnanaganga.inflibnet.ac.in:8443/jspui/handle/123456789/1663
- [M3] Misra & Dalmia (2007), *Management Dynamics* 7(2) (snippet). https://managementdynamics.researchcommons.org/journal/vol7/iss2/3
- [M4] TradingQnA (KirubaKaran), "Nifty Covered Call Strategy – Backtest results", 17 Jun 2020. https://tradingqna.com/t/nifty-covered-call-strategy-backtest-results/81302
- [M5] Shivaprasad, S. P. et al. (2022), *Cogent Economics & Finance* (snippet). https://doaj.org/article/a22f18f028064d25be87eb9ad38b9473
- [M6] Cboe, "White Paper Shows Volatility Risk Premium Facilitated Higher Risk-Adjusted Returns for PUT Index", 29 May 2019. https://www.cboe.com/insights/posts/white-paper-shows-volatility-risk-premium-facilitated-higher-risk-adjusted-returns-for-put-index/
- [M7] No NIFTY PutWrite/BuyWrite index found (searches of 10 Oct 2026; no NSE page found).

Box spreads and parity
- [B1] Vipul (2009), "Box-spread arbitrage efficiency of Nifty index options: The Indian evidence", *J. Futures Markets* 29(6):544–562. https://ideas.repec.org/a/wly/jfutmk/v29y2009i6p544-562.html
- [B2] Girish, G. P., Rastogi, N. (2013), "Efficiency of S&P CNX Nifty Index Option of the National Stock Exchange (NSE), India, using Box Spread Arbitrage Strategy", *Gadjah Mada International Journal of Business* 15(3):269–285. https://journal.ugm.ac.id/gamaijb/article/download/5473/4447
- [B3] Mutum et al. (2018), *Indian Journal of Finance* (snippet). The search surfaced these two listing pages without confirming which is the paper: https://www.i-scholar.in/index.php/ijf/article/view/202662 ; https://indianjournalofentrepreneurship.com/index.php/IJF/article/view/132492
- [B4] OneTradeJournal, "Box Spread Strategy in Indian Markets" (date not seen). https://onetradejournal.com/strategies/box-spread-strategy

Other candidates
- [X1] Lucca & Moench (2015), "The Pre-FOMC Announcement Drift", *JF* 70(1):329–371. https://ideas.repec.org/r/bla/jfinan/v70y2015i1p329-371.html
- [X2] Kurov, Wolfe & Gilbert (2021), "The disappearing pre-FOMC announcement drift", *Finance Research Letters* 40. https://ideas.repec.org/a/eee/finlet/v40y2021ics1544612320315956.html ; https://www.skidmore.edu/economics/documents/KurovWolfeGilbert-TheDisappearingPre-FOMC-Announce-Drift-200914.pdf
- [X3] Cederburg, O'Doherty, Wang & Yan (2020), "On the performance of volatility-managed portfolios", *JFE* 138:95–117. https://www.lehigh.edu/~xuy219/research/COWY.pdf ; summary: https://alphaarchitect.com/does-portfolio-timing-based-on-volatility-signals-outperform-buy-and-hold/

Program files cited
- [Q1] docs/research/notes/q1-premium-timing.md: overnight +4.2 bp against open→close −3.9 bp (2024–2026); overnight gaps 55% of daily variance (2 years) and 42% (10 years); Monday VIX quirk.
- [Q2] docs/research/notes/q2-gaps-trend-flows.md: after heavy FII-selling days (z < −2, n = 79), the next open was −0.24% [−0.46, −0.02].
- [WP6] reports/wp6-real-prices.md: night/day straddle split; call +3.39%, put −3.24% a night (NIFTY 2019–2026); quiet and gap nights; weekend nights; definition and bias of "night".
- [WP10] reports/wp10-short-premium.md: weekly hold-to-expiry condor; margins ≈ ₹0.72–0.78 lakh (₹1.37 lakh on expiry day).
- [WP11] reports/wp11-real-intraday.md and plan §0: first-minute richness (ATM straddle's first trade a median 7.4% above the day's average on NIFTY, 15.0% on SENSEX); cautious-fill model.
- docs/research/overnight-short-vol.md: official index close from an auction since 3 Aug 2026.
- [r2] notes/r2-premium-timing.md: SEBI FY26, only 3% of index-option turnover more than seven days from expiry.
- [r4] notes/r4-preopen-gaps.md: Della Corte & Kosowski; implied volatility settles after the open.
- [plan] options-trading-plan.md: N5 (no overnight holds), N6 (no far-OTM strikes), N8 (64% up after −1.5% days, 2020–26), N9 (gaps), §12 bar; NIFTY open 22,314.95 on 9 Oct 2026. Lot of 65 from 30 Dec 2025: r5 [D7].
- strategy-plan.md: Bhat et al. sample (NSE 2017–2020).

Status: complete
