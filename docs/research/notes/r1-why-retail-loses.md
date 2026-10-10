# Why retail loses in Indian index options, who wins, and what a retail option buyer must avoid

Research note R1 for the ruphak-trading-info options plan. Written 9 Oct 2026 (Fri). Scope: NIFTY / SENSEX / Bank Nifty index options; evidence-first. Every figure carries its source and date; where sources conflict or I could only reach a secondary summary, it is flagged. Companion notes (premium timing, signals, pre-open gaps) are owned by other agents and are not repeated here.

Primary documents read in full (text extracted locally from the PDFs, saved under `scratchpad/research/pdfs/`):

- SEBI, *Profitability of Individual Traders in the Equity Derivatives Segment (FY25–FY26)*, Aug 2026, 91 pp. ("SEBI-P26")
- SEBI, *Trading Behaviour of Individual Traders in the Equity Derivatives Segment (FY25–FY26)*, Aug 2026, 53 pp. ("SEBI-B26")
- SEBI press release PR 50/2026, 20 Aug 2026
- SEBI, *Comparative study of growth in EDS vis-à-vis Cash Market after recent measures*, Jul 2025, 7 pp. ("SEBI-J25")
- SEBI, *Analysis of Profits & Losses in the Equity Derivatives Segment (FY22–FY24)*, 23 Sep 2024, 33 pp., plus PR 22/2024 ("SEBI-S24")
- SEBI consultation paper on index derivatives, 30 Jul 2024, 18 pp. ("SEBI-CP24")
- SEBI circular SEBI/HO/MRD/TPD-1/P/CIR/2024/132, 1 Oct 2024 ("SEBI-C24")
- SEBI interim order in the matter of index manipulation by Jane Street Group, 3 Jul 2025, 105 pp., plus SEBI updates of 14 and 21 Jul 2025 ("JS-Order")
- Agarwal, Ghosh, Prabhala, Zhao, *Animal Spirits on Steroids: Evidence from Retail Options Trading in India*, working paper dated 30 Sep 2025 (FMA 2025 / CFR WP 25-09) ("AGPZ")

Secondary only (abstract or press summary; could not open the primary): SEBI Jan 2023 study (FY22), the two SSRN NIFTY variance-risk-premium preprints, Bryzgalova–Pavlova–Sikorskaya (JF 2023), Han–Lee–Liu (Taiwan, 2009), Business Standard / Business Today / Bloomberg coverage of the Jane Street appeal (Oct 2026).

---

## 1. The headline evidence: the base rate is roughly 9 in 10 losing, every year, before and after reforms

| Period | Sample | Share of individual traders with a net loss | Aggregate net loss | Average loss | Source |
|---|---|---|---|---|---|
| FY22 | top-10 brokers, 67% of individual F&O turnover; 45.2 lakh traders | 89% | — | ₹1.1 lakh | SEBI Jan 2023 (press summaries) |
| FY22–FY24 (3 yrs) | top-15 brokers; 1.13 crore unique traders | 92.8% (93%) | ₹1.81 lakh crore | ≈₹2 lakh over 3 yrs; top 3.5% of losers averaged ₹28 lakh | SEBI-S24 |
| FY24 | same | 91.1% | ₹74,812 crore | ₹86,728 | SEBI-S24 / SEBI-J25 Table 11 |
| FY25 | top-13 brokers (96 lakh traders) | 91.0% | ₹1,05,603 crore (+41% y/y) | ₹1,10,069 | SEBI-J25 Table 11 |
| FY25 (revised, 15 brokers) | ~90% of individual traders | 90.9% | ₹1,11,788 crore | ₹1.13 lakh | SEBI-P26 |
| FY26 | same | 87.7% net (82.1% before costs) | ₹91,685 crore | ₹1.17 lakh | SEBI-P26 |
| FY22–FY26 cumulative | — | 95.6% of the 167.7 lakh trader-years were losses | ₹3.85 lakh crore | — | SEBI-P26 Table 32 |

Context and caveats:

- Only ~7.2% of individuals were net profitable over FY22–FY24, and only 1% earned more than ₹1 lakh after costs (SEBI-S24). Over FY25–FY26 combined, 91.0% of 122.6 lakh unique individuals lost; profit-makers numbered 11.1 lakh and earned ₹16,211 crore in total against ₹2.03 lakh crore of losses (SEBI-P26 Table 15).
- The FY26 "improvement" to 87.7% came with a 20% fall in active traders (98.1 → 78.6 lakh) and a 40% fall in new entrants; SEBI itself says the lower loss share "does not necessarily mean trading outcomes have genuinely improved" (SEBI-P26 §6.23).
- Losses are concentrated: 22.9% of traders (those losing >₹1 lakh) produced 89.9% of FY26 losses; 2.7% (losing >₹10 lakh) produced 49.1% (SEBI-P26 Table 18). Among profit-makers the average profit (₹1.22 lakh) is 21% smaller than the average loss among loss-makers (₹1.47 lakh) (SEBI-P26 §6.25).
- NSE's own cut for FY24 (SEBI-CP24 §2.3.8): 92.5 lakh individuals traded NSE index derivatives, lost ₹51,689 crore *before* costs, and only 14.22 lakh (≈15%) had a gross profit. That loss equalled >32% of FY24 net inflows into equity mutual fund schemes.
- The same pattern holds abroad, so it is not an Indian quirk: Brazil index-futures day traders active >300 days, 97% lost (Chague et al. 2020); Taiwan index options 2002–05, individuals' average net return per trade −3.4%, only ~27% with positive overall net returns (Han, Lee & Liu 2009, via CXO summary); SEBI-P26 Table 1 collects ESMA 74–89%, FCA ~82%, ASIC 68%, CFTC ~67% for CFDs/forex.

## 2. Ranked reasons retail loses (with evidence)

Ranking is by how much of the aggregate loss each mechanism plausibly explains for an *option buyer* like our engine, weighted by the strength of the evidence.

### Reason 1 — Buying options is structurally the losing side of the trade (options are zero-sum before costs, and the other side is professional)

- Options account for 92% of individuals' aggregate losses in FY26 and 91.6% over FY25–FY26 (SEBI-P26). Loss incidence: 91.0% of options traders vs 68.4% of futures traders; only-futures traders 67.3%, only-options 91.6% (SEBI-P26 Table 20–21). In FY24 individuals lost ~₹55,000 crore gross in options while *making* ~₹13,400 crore in futures (SEBI-S24 §5.1).
- 97% of individual traders are predominantly option *buyers* (93% buy-only, 4% mostly-buy); ~2% are mostly sellers (SEBI-B26). Only-option-buyers had the worst median return on capital employed of any group: −187% in FY25 and −114% in FY26, i.e. half of them lost more than their peak margin during the year. Mostly-sellers were the only group with a positive median RoCE (+1% in FY26) (SEBI-B26 Table 8; sample of ~5,000 traders, flagged by SEBI as indicative).
- SEBI states the zero-sum fact plainly: "Derivatives trading is largely a zero-sum activity before transaction costs… The aggregate losses of individual traders were broadly matched by the aggregate profits of corporate and institutional participants" (SEBI-P26 §6.15). AGPZ, with trader-level NSE data 2007–2021, "check and verify that the aggregate losses borne by retail investors are the aggregate profits of the institutions", and note institutions "are more likely to be net sellers of options".
- Caveat: SEBI-B26 §5.2 warns that option *selling* is not the retail answer either: sellers' loss rate is 44% but the average loss per losing seller was ₹51.7 lakh in FY26 (11× a mostly-buyer's ₹4.6 lakh), and the seller group as a whole still lost (₹543 crore in the FY26 sample).

### Reason 2 — Time decay plus the volatility risk premium: the buyer pays for insurance that, on average, costs more than it pays out

- Mechanics (SEBI-CP24 §2.3.6): thirty minutes before expiry an ATM premium is typically "a fifth or less" of the prior day's close; 5–10 minutes before expiry "a tenth or less". SEBI's own words: this "makes F&O trading on that day an accessible, cheap, and enticing lottery ticket… irrespective of how low the odds of success may be."
- Implied-vs-realised evidence for NIFTY is thinner than for the US and only available as unreviewed preprints, so treat the sizes as indicative:
  - Agarwal (SSRN 6530119, 2026; ~43 million one-minute option bars Aug 2022–Mar 2026): the NIFTY 50 variance risk premium is positive (implied > realised) on most days, but the sign depends on the realised-volatility estimator and it reversed sharply in early 2026 (abstract via search; SSRN blocked direct access).
  - Pillai (SSRN 6876580, 2026; 119 monthly expiry cycles Jan 2015–Apr 2025): the premium exists, yet every short-volatility strategy tested (ATM short straddle, crash-neutral, put-write, delta-hedged straddle) was *negative* after STT, brokerage and slippage; straddle variants ≈ −44 to −45% a year. Conclusion: a retail trader cannot capture the premium under current microstructure (abstract via search).
  - A simple public replication (GitHub RajolKumar2003, undated) finds India VIX averaging 16.59 against 21-day realised volatility of 14.12, i.e. a ~2.5-point average premium. One sample period only.
  - A study of NIFTY options (title: "The asymmetry in day and night option returns: evidence from an emerging market", journal/date not verified) reports that the premium earned by sellers is mainly a reward for *overnight* risk: selling at the close and buying back at the open is profitable gross but not after costs. Implication for a buyer: holding a long option overnight pays the overnight premium to the seller; intraday-only buying avoids most of it but still pays spread and charges.
- Our backtest's ≈₹300 per trade bleed on flat-index days is this mechanism measured directly.

### Reason 3 — Transaction costs convert marginal winners into losers and absorb a third of losers' gross losses

- Individuals paid ~₹25,000 crore of transaction costs in each of FY25 and FY26; ~₹1 lakh crore over FY22–FY26, brokerage nearly half. STT paid rose from ₹1,291 crore (FY22) to ₹6,645 crore (FY26); STT's share of costs went from 13% to 27% while brokerage fell from 52% to 44% (SEBI-P26 executive summary and §6.37).
- Costs are regressive against losers: they equalled 35% of loss-makers' gross losses in FY26 (44% in FY25, 27% in FY24) but only 21% of profit-makers' gross profits (18–23% in FY24–FY26) (SEBI-P26 §6.25). Costs moved 5.6 points of traders from gross profit to net loss in FY26 (82.1% → 87.7%).
- Older figure for reference: SEBI's Jan 2023 study was reported as loss-makers spending an additional 28% of net trading losses on costs in FY22; SEBI-CP24 §2.3.8 cites the same study as 23% (and 15% for profit-makers). Conflict noted; the FY26 primary figure (35%) supersedes both.
- Per-person: ₹26,000 of F&O costs per trader in FY24; over FY22–FY24, 51% brokerage, 20% exchange fees, ₹13,800 crore to government as STT/GST/stamp (SEBI-S24 §5.4).
- STT path: options sell-side STT 0.0625% → 0.10% of premium from 1 Oct 2024 (Budget 2024), and 0.10% → 0.15% from 1 Apr 2026 (Budget 2026; NSE circular NSE/FATAX/73524 and BSE notice 20260331-7, both 31 Mar 2026); futures 0.0125% → 0.02% → 0.05% on the same dates (ICICI Direct, Upstox, Business Standard summaries). The repo's `CHARGE_SCHEDULES` already carries 0.15%.
- Illustration with the engine's own charge schedule (my arithmetic, not a source): one NIFTY lot (65) of a ₹150 option = ₹9,750 premium. Round trip ≈ ₹40 brokerage + ₹7 GST + ₹14.6 STT on the sell + ~₹7 exchange charges + ₹0.3 stamp ≈ ₹70, i.e. ~0.7% of premium before any bid–ask spread. At a 37% hit rate that is small per trade but it is paid 51 times.

### Reason 4 — Ultra-short horizons and expiry-day (0DTE) concentration, where gamma and theta are most violent

- 0DTE share of index-option turnover: 38% in FY22 → 70% in FY25 → 59% in FY26; within 1 day of expiry 80% → 75%; within 7 days 98% → 97%; only 3% of turnover is in contracts with >7 days left and 1% with >10 days (SEBI-P26 §6.13).
- Earlier weekly-expiry data (SEBI-CP24 Table 1): expiry day was 96% of the 5-day turnover for SENSEX and 64% for NIFTY; the last 30 minutes alone were 27% (SENSEX) / 16% (NIFTY) of expiry-day turnover. NIFTY's last half-hour on expiry days was the most volatile intraday window outside the open (SEBI-CP24 Table 4, Jan–Jul 2024), and 3-minute OI/volume data showed positions opened and closed inside 3 minutes just before expiry (Table 5).
- AGPZ (2007–2021): 87% of a contract's notional volume occurs in its last 6 days and 38% on the last day; retail is 42% of expiry-day volume; 82% of traders start trading a contract only in its final week; mean end-to-end holding 2.4 days, median 0; day trading reached 90% of retail index-option volume. Returns standardised to a 5-day horizon are "significantly lower for short-duration traders"; day-trading P&L is "flat to weakly positive", while "positions not closed in day trading result in significant losses" (disposition effect: winners are closed, losers are held to expiry).
- SEBI-C24 §5.5.1 (the rule-maker's own diagnosis): "Expiry day trading in index options, at a time when option premium are low, is largely speculative… hyperactive trading… with average position holding periods in minutes, accompanied by increased volatility in the value of the index through the day and at expiry."
- The engine already refuses 0DTE and stops entries 90 minutes before the close on an index's own expiry day (docs/FNO.md). This is the single most evidence-backed rule in the repo; keep it.

### Reason 5 — Preference for cheap OTM "lottery" strikes

- SEBI-CP24 Table 6–7 (NIFTY 4 Jul 2024 expiry): in strikes more than 5% away from the prior close, 18 strikes saw expiry-day volume 5–20× their prior-day OI, i.e. fresh positions created in near-worthless strikes on expiry day "regardless of how low the odds of success are".
- AGPZ natural experiments: when SEBI tripled the NIFTY lot (25 → 75) in 2015, small traders shifted to options that were "more out of the money, of shorter maturity, and nominally cheaper", shortened holding periods, and their returns fell by 1.5%; when physical settlement raised ITM margins in 2019, OTM maturity-day volume rose 55% and the cheap-OTM habitat cost those traders ₹23,984 a year more than others. Return skewness of OTM index options in the last week is 7.5–18.1 versus 1.1–3.9 for ATM (AGPZ App. B), which is exactly what a lottery buyer is paying for.
- US evidence on the same habit: retail gravitates to cheap weekly options with an average bid–ask spread of 12.6% and loses on average (Bryzgalova, Pavlova & Sikorskaya, *J. Finance* 2023, abstract). Spreads on far-OTM NIFTY weeklies are not published by NSE as a series; practitioner blogs claim ₹0.50–1.50 ATM spreads and wide OTM spreads in the last hour, but I found no measured Indian dataset. Treat Indian OTM slippage as unquantified but directionally the same.
- Direct relevance: the ₹5k account's SENSEX band (₹130–222 per unit, lot 20) can only reach near-ATM strikes late in the week when the premium has already decayed; early in the week the cap forces OTM strikes. Either way it is structurally buying what SEBI calls lottery tickets. See rule 6 below.

### Reason 6 — Overtrading and trading intensity relative to capital

- Loss incidence rises with turnover: 86.4% (<₹1 lakh/yr), 87.8% (₹1 lakh–1 crore), 89.7% (>₹1 crore); in options turnover >₹10 crore it is 95%. Large-turnover traders are 20% of traders, 96% of turnover, 82% of losses, trading 68× their equity portfolio (SEBI-P26 §6.31–6.33). Average loss rises ~12× for ~12× the turnover.
- Traders active >100 days a year are 42% of the sample but 94% of turnover and 87% of losses; median annual loss ₹76,722 vs ₹654 for <10 days (SEBI-B26 §5.17).
- 85% of trader-quarters are losing; the median losing quarter (−₹10,525) is 2.4× the median winning quarter (+₹4,366); 78.7% of traders with both kinds of quarter have a bigger average loss than average gain (SEBI-B26).
- FY24: average option trader made 870 transactions a year at an average trade size of ₹11,824 (SEBI-S24 Table 10). Zerodha's Nithin Kamath (Apr 2026, Business Today): 60–70% of F&O turnover comes from 1–2% of traders.

### Reason 7 — Small capital, no portfolio, young and low-income: the people most likely to be buying cheap weeklies

- 35% of EDS traders had no equity holdings and 78% had <₹1 lakh; the <₹1 lakh group produced 70% of losses on 51% of turnover; small-portfolio *and* high-turnover traders are 13% of traders and 52% of losses. Loss rate falls monotonically with portfolio size: 93% (none or <₹50k) → 88% (₹1–10 lakh) → 72% (₹50 lakh–1 crore) → 58% (>₹10 crore) (SEBI-P26 §6.43–6.48).
- 43% of traders are under 30 (31% in FY22); 89% of them lost in FY26 vs 81% of over-60s. Three-quarters declare income <₹5 lakh; they are 43% of turnover but 53% of losses (SEBI-P26). 77% of traders use peak margin <₹1 lakh (SEBI-B26).
- More cash-market activity relative to derivatives is associated with better outcomes: 90% loss rate with zero cash turnover vs 84% when cash turnover is >5× derivatives turnover; average loss ₹1.5 lakh vs ₹15k (SEBI-B26 Table 19–20). SEBI explicitly does not claim causation.
- AGPZ: traders who enter options had *worse* prior stock-trading performance and less experience, preferred volatile lottery-like stocks before, and trades routed through FinTech (app) brokers incurred triple the losses of the same traders' trades through traditional brokers.

### Reason 8 — Persistence: losses do not teach, and experience does not help

- 90–92% of traders who lost in each of the prior two years and kept trading lost again (FY24 91.6%, FY25 92.0%, FY26 90.0%) (SEBI-B26 Table 14). Over FY22–FY24, 76.3% of two-year losers kept trading and only 8.3% of them turned a profit in the third year (SEBI-S24).
- Loss rate *rises* with consecutive years traded: 91.0% (1 yr) → 94.4% (2) → 96.0% (3) → 96.5% (4) → 95.3% (5). Of traders active all five years FY22–FY26, 0.5% were profitable every year and 65.6% lost every year (SEBI-B26 §5.15).
- New and regular traders lose at the same rate (87.8% vs 87.7% in FY26); regulars just lose more (₹1.36 lakh vs ₹0.59 lakh) because they trade 46× their portfolio instead of 19× (SEBI-P26 §6.32).
- Among ~1.10 crore traders who lost in FY22–FY24, 77% had an FY26 equity portfolio below 25% of their cumulative losses; those who lost >₹1 crore had a median FY26 equity portfolio of ₹138 (SEBI-B26).

### Reason 9 — Expiry-day index manipulation by a large participant (the Jane Street case) made the deck worse on specific days

See §4. SEBI's own order says the profits were made "to the detriment of other traders (including many small retail traders)" and "may well account for some part" of the 93% loss statistic. It is a real but bounded factor: ₹4,474 crore of Bank Nifty option profit across 18 identified days versus retail's ~₹1 lakh crore annual losses.

## 3. Who wins, and through what

Gross trading P&L in the equity derivatives segment, before costs (SEBI-P26 §6.15–6.18, Table 11, ₹ crore):

| Category | FY24 (SEBI-S24) | FY25 | FY26 | FY26 share from options |
|---|---|---|---|---|
| Proprietary traders (incl. foreign-owned Indian prop desks) | +33,000 | +45,955 | +44,483 | 98% |
| FPIs | +28,000 | +31,085 | +13,896 | 77% |
| Corporates / trusts | — | +8,280 | +5,960 | — |
| Mutual funds | — | +5,610 | +2,590 | mostly futures |
| Partnership firms / LLPs | — | +4,740 | +2,950 | — |
| DIIs ex-MF | +200 | +100 | +220 | — |
| Individuals | −41,500 (plus −19,700 "others") | −97,882 | −72,243 | >90% |

How they win:

1. **Algorithmic, high-frequency trading in index options.** 97% of FPI and 96% of prop profits in FY24, and 99% of both in FY26, came from entities that placed at least one algo order (SEBI-S24; SEBI-P26 §6.18). In FY26, 86% of FPIs and 47% of prop traders used algos; only ~15% of individuals did, and that figure is inflated by broker auto-square-offs. The top 10 prop entities earned ~75% of prop profits and were 85% of prop options activity (SEBI-P26). This is market-making (capturing the bid–ask spread retail pays) and latency arbitrage, not forecasting.
2. **Being the net seller of options to retail buyers.** Institutions are "more likely to be net sellers of options" and their profits equal retail losses (AGPZ). Prop desks earned 98% of FY26 profit from options. The volatility-risk-premium preprints above measure the same transfer from the buyer's side.
3. **Expiry-day strategies at scale.** The Jane Street order describes a firm whose "business is to make profits from significant short-term High Frequency Trading", "most active on expiry days of index options", holding on average ₹15,325 crore of government securities as margin against only ₹311 crore of equity (JS-Order §48–49). Its index-option profits were ₹43,289 crore over Jan 2023–Mar 2025 while it *lost* ₹7,687 crore in cash and futures, which SEBI reads as the cost of moving the index (§31).
4. **Arbitrage and hedged structures.** Mutual funds (arbitrage and covered-call books) and corporates make steady but much smaller sums, mostly in futures (Table 11). This is the legitimate low-risk part of the market and it does not need to predict direction.
5. **The profitable individual minority (what the data says, not folklore).** SEBI-B26: the only group with a positive median return on capital was "majorly option sellers" (+1% RoCE in FY26), who also had the lowest loss incidence (44%) but catastrophic tails. Loss incidence falls with capital employed (90% below ₹1 lakh vs 67.6% at ₹10 lakh–1 crore), with equity-portfolio size (93% → 58%), with age (89% under-30 vs 81% over-60), with income (88% under ₹5 lakh vs ~75% at ₹25 lakh–1 crore in FY24), and with cash-market activity relative to derivatives. Pure futures traders lose less often (67%). Within every turnover bucket, bigger portfolios lose less often (93% → 64% among high-turnover traders). None of this is causal, and none of it says "small buyer wins"; the one trait shared by every lower-loss group is *less derivatives turnover relative to their resources*. AGPZ adds that the highest-volume retail decile has the least negative returns (value-weighted −1.4%) while the lowest-volume decile averages −21%, consistent with spreads and fixed costs eating small tickets. Zerodha (HDFC Securities report, 2023, secondary) describes its stickier F&O clients as "semi-professional" and "strategy-based", i.e. spreads and hedged books rather than naked buys. I found no SEBI table profiling the profitable 9–12% beyond these cross-tabs; that is a genuine gap.

## 4. SEBI vs Jane Street (2025–26): what was alleged, status, and what it means for a retail buyer on expiry days

What SEBI alleged (JS-Order, 3 Jul 2025; examination period 1 Jan 2023–31 Mar 2025):

- Total profit ₹36,502.12 crore across segments: +₹43,289.33 crore in index and stock options, −₹7,208 crore stock futures, −₹191 crore index futures, −₹288 crore cash (§31 and Table at §14.1). Bank Nifty options alone +₹17,319 crore (40% of index-option profit).
- Method: rank Bank Nifty option P&L by day → top 30 days → 19 were expiry days → 18 days analysed. On 15 of them an **"Intra-day Index Manipulation"** pattern: Patch I (open to ~11:47) aggressive buying of Bank Nifty constituents in cash and futures, often above last traded price and sometimes >20% of a stock's traded value, lifting the index while simultaneously building a much larger bearish option book (short calls, long puts) at "artificially inflated call premiums and subdued put premiums"; Patch II (from ~11:49 to close) selling it all back, pushing the index down into expiry. On the other 3 days (4 Oct 2023, 8 May 2024, 10 Jul 2024) an **"Extended Marking the Close"** pattern: large directional trades in the last two hours to steer the settlement price. The same close-marking pattern was seen in NIFTY 50 options on 3 days in May 2025, after an NSE caution letter in Feb 2025.
- Example day 17 Jan 2024 (Bank Nifty weekly expiry): ₹734.93 crore profit; index moved 46,573.93 → 47,176.97 within minutes in Patch I; Bank Nifty options notional ₹1.03 crore crore vs ₹1.05 lakh crore cash+futures in its 12 constituents. Across the 18 days: +₹4,474 crore in Bank Nifty options, −₹201 crore in the underlying (§28).
- SEBI on retail: "the vast majority of BANKNIFTY options participants that do not participate in the underlying cash or futures markets look to the index… to price and take a view on index options"; they "were induced to deal in options at a time… when the BANKNIFTY index and options markets were being artificially and temporarily influenced" (§15.20, §23); the profits came "at the cost of other participants and retail traders" and "may well account for some part of the conclusions of SEBI's… report… that 93% of… individual F&O traders incurred losses" (§35, §46).
- Remedies: ₹4,843.57 crore impounded into escrow (deposited 14 Jul 2025, PR 40/2025); trading bar lifted on 21 Jul 2025 once escrow was in place, but with a cease-and-desist on "any of the patterns identified" and ongoing exchange monitoring (PR 45/2025). Jane Street denies manipulation and calls it conventional index arbitrage.

Status as of 9 Oct 2026 (secondary: Business Today 6–7 Oct 2026, Business Standard 8 Oct 2026, Bloomberg 6 Oct 2026, NewsBytes): no show-cause notice or final order yet; SEBI told SAT the investigation is ongoing and has been widened to other indices; the current fight is over document access (Jane Street wants unredacted order logs; SEBI calls the demand dilatory); SAT ruling on that point is expected 21 Oct 2026. Reports say Jane Street has not resumed trading in India and said in July 2025 it had no immediate plans to re-enter equity options. On the first Bank Nifty/NIFTY expiry after the ban (10 Jul 2025) total derivatives premiums were ~40% below the year's expiry-day average and India VIX hit its lowest since April 2024 (Business Today 11 Jul 2025), which is at least consistent with a large expiry-day participant stepping away, though one day proves nothing.

Policy follow-through: SEBI consultation paper of 12 Sep 2026 proposes either keeping the last-30-minute VWAP settlement or a "blended VWAP" over the last 30 minutes of continuous trading plus a 10-minute closing auction, and restricting cancellation of far-from-reference orders; comments closed 3 Oct 2026; no decision yet (Business Standard / Business Today, 12 Sep 2026). SEBI chairman Pandey said in Sept 2026 that the regulator intends to address expiry-day settlement-price concerns.

What it implies for a retail option buyer:

- On an index's expiry day the index level itself can be a temporary artefact of one participant's cash/futures flow, and the option prices you see are priced off that artefact. A directional buyer "reading the trend" in the morning of an expiry day was, on the identified days, reading a move designed to reverse. SEBI's own December 2024 trigger was "abnormally high or low volatility on weekly index options expiry days".
- The last 30 minutes matter twice: they are the most volatile window (SEBI-CP24) and they set the settlement VWAP that a marker-of-the-close targets. Both argue for being flat, not long, into any index's own expiry close.
- The case does not prove manipulation on non-expiry days or on NIFTY generally; SEBI says other days "remain to be investigated". Do not over-read it. But the burden it adds falls precisely on the trade our engine likes least already (0DTE), and the engine's 90-minute pre-close cut-off on expiry days is justified by it.

## 5. SEBI's F&O measures from Nov 2024 and the 2025–26 changes that matter to a buyer now

From SEBI-C24 (1 Oct 2024) and SEBI-J25 Table 1 (actual effective dates):

| Measure | Effective | What it does to a buyer |
|---|---|---|
| One weekly expiry per exchange (NSE kept NIFTY, BSE kept SENSEX; Bank Nifty, FinNifty, Midcap, Bankex monthly only) | 20 Nov 2024 | Fewer "everyday expiry" lottery days; 0DTE share fell 70% → 59% (SEBI-P26) |
| +2% ELM on short options on expiry day | 20 Nov 2024 | Raises sellers' cost on expiry day; marginally thinner liquidity for buyers that day |
| Minimum contract value ₹15 lakh at launch, reviewed to stay in ₹15–20 lakh (was ₹5–10 lakh) | 20 Nov 2024 for new contracts; NSE 2 Jan 2025 / BSE 10 Jan 2025 for weeklies | NIFTY lot 25 → 75 (Nov 2024) → 65 (contracts from 30 Dec 2025, NSE/FAOP/70616); SENSEX 10 → 20 (27 Dec 2024) → 25 for expiries from Jan 2027 (BSE notice 20260930-58, effective 30 Oct 2026) |
| Upfront collection of full option premium from buyers | 1 Feb 2025 (SEBI-C24) / 10 Feb 2025 (SEBI-J25) | No intraday leverage on long options; the ₹5k/₹10k accounts' "premium ≤ cash" constraint is now the law for everyone |
| No calendar-spread margin benefit on expiry day | 1/10 Feb 2025 | Affects spread sellers, not naked buyers |
| Intraday monitoring of position limits (≥4 random snapshots) | 1 Apr 2025 | Irrelevant at retail size |
| Expiry days fixed to Tuesday or Thursday per exchange: NSE Tuesday, BSE Thursday (SEBI circular May 2025 /76) | 1 Sep 2025 | Matches the engine's calendar (NIFTY Tue, SENSEX Thu); Monday is the NIFTY 1DTE day |
| Delta-based (FutEq) open-interest metric and index-option position limits: EOD net ₹1,500 crore / gross ₹10,000 crore per index (29 May 2025); intraday net ₹5,000 crore / gross ₹10,000 crore with expiry-day breach penalties from 6 Dec 2025 (1 Sep 2025 circular) | Jul–Dec 2025 | Aimed at Jane-Street-sized books; indirectly limits how much one participant can lean on expiry day |
| STT 0.10% → 0.15% of premium on option sales and exercise; futures 0.02% → 0.05% | 1 Apr 2026 | +50% STT per round trip; already in `CHARGE_SCHEDULES` |
| Expiry settlement price / closing-auction consultation (blended VWAP) | CP 12 Sep 2026, comments to 3 Oct 2026 | Pending; would change where expiry-day gamma games are played, not whether |

Not happening (as far as I could verify): a ban on weekly expiries. SEBI's chairman said in July 2025 the regulator was not planning to curb weekly expiries; September 2025 press reports described a possible consultation on a glide path to monthly expiries and a retail participation threshold, but I found no 2026 consultation paper or board decision. Flag as "watch", not "assume".

What SEBI itself found the measures did (SEBI-P26 Section 2 and §7): participation in index options fell 26.8% between Q2 and Q4 FY25; average turnover per remaining index-option trader *rose* 12%; premium ADT fell 17% (₹66,000 → ₹55,000 crore) then recovered to ~₹82,000 crore in Oct 2025–Mar 2026, above the pre-policy level; 0DTE concentration eased but 97% of turnover is still within a week of expiry. SEBI's conclusion: the measures "moderated participation but did not fundamentally alter trading behaviour". AGPZ's earlier natural experiments predicted exactly this: cost-raising curbs shift speculation into cheaper, riskier contracts rather than ending it.

## 6. Rules that follow for a retail option buyer (our engine, our accounts)

Each rule names the evidence it rests on. "Must avoid" rules are those where the evidence is strong and the mechanism is structural; "should" rules are inferences.

1. **Must avoid 0DTE and the last 60–90 minutes of any index's own expiry day** (NIFTY Tuesday, SENSEX Thursday, and the holiday-shifted Mondays/Wednesdays). Evidence: premium ≤1/5 of prior close 30 minutes out (SEBI-CP24); last-30-minute volatility highest (SEBI-CP24 Table 4); 15 of 18 Jane Street days were expiry-day index moves designed to reverse; settlement VWAP window is the target of close-marking. The engine's existing rule is right; do not relax it for "expiry-day scalps", however tempting the cheap premiums look.

2. **Must not hold a bought weekly option overnight as a default.** Evidence: NIFTY option sellers' premium is mainly an overnight reward (day/night asymmetry study); AGPZ finds day-trading P&L roughly flat while positions carried beyond the day "result in significant losses"; the Monday → Tuesday NIFTY carry is 1DTE, where theta is steepest. Overnight longs should be an explicit, separately-logged event trade (owned by the pre-open gap note), never the residue of a trade that did not work.

3. **Must treat friction as the first opponent, and trade far less.** Evidence: costs were 35% of losers' gross losses in FY26 and tipped 5.6% of traders from gross profit to net loss (SEBI-P26); STT just rose 50%; our backtest paid ≈₹300 per trade on flat days and 51 trades lost ₹9,596. Loss incidence and loss size both rise with turnover (SEBI-P26 §6.31; SEBI-B26 §5.17). Concretely: (a) require an expected move that clears round-trip charges + spread + the expected theta over the planned holding time before an entry is allowed; (b) cap trades per week and per day; (c) measure realised friction per trade in the paper engine and refuse strategies whose edge is smaller than it. A 37% hit rate needs an average win ≥1.7× the average loss just to break even before costs.

4. **Must not buy the trend after the move: no entries in the first 15–30 minutes on momentum, and no chasing.** Evidence: our own backtest (late entries, index moved against the trade in the first 15–30 min, right only 37%); SEBI-CP24 and the Jane Street order both show the open and the expiry close as the windows where the index is most likely to move and then reverse; the 09:15–10:00 half-hour has the highest high-low range on every weekday (SEBI-CP24 Table 4). Let the signals note set the exact window; this note only says the open is the worst place to be a late directional buyer.

5. **Must keep the loss per trade smaller than the average win, mechanically.** Evidence: 78.7% of retail traders have a bigger average losing quarter than winning quarter; median losing quarter is 2.4× the median winning one (SEBI-B26); AGPZ documents the disposition effect (closing winners, riding losers to expiry) as the mechanism. For a bought option the premium is the maximum loss but not the planned loss: set a time stop (flat index for N minutes = exit, because theta is the certain cost) and a premium stop, and never add to a losing option.

6. **Must stop buying cheap OTM as a substitute for affordable ATM.** Evidence: lot-size and margin experiments pushed small traders into cheaper, more-OTM, shorter-dated options and their returns fell (AGPZ); expiry-day volume in strikes >5% away is fresh lottery positioning (SEBI-CP24 Table 6); OTM weeklies carry the widest spreads (Bryzgalova et al. 2023; practitioner reports for India, unquantified). Implication for the ₹5k account: with lot 20 and a ₹130–222 per-unit band it can rarely afford a SENSEX ATM option with more than a day of life, so it is structurally forced into either OTM strikes or near-expiry ATM strikes, both of which the evidence says lose. Either raise the account to a size where one ATM SENSEX lot with 2–4 days to expiry fits (roughly ₹7–10k at a 12% VIX; this is a Black–Scholes order-of-magnitude estimate, not a source), trade it only on the rare days an ATM strike falls inside the band, or accept that it exists to test execution, not edge. The same logic applies to the ₹10k account for NIFTY (lot 65): a ₹150 ATM premium is ₹9,750, so it is one lot, ATM only, or nothing. When SENSEX goes to 25 units for January-2027 expiries the ₹5k band must be re-derived (docs/FNO.md already notes this).

7. **Should prefer ATM or slightly ITM (delta ≥ ~0.5) with 2–5 days to expiry over anything cheaper or nearer.** Evidence: the mirror of rules 1 and 6; 97% of turnover is inside a week and only 3% beyond, so a buyer who wants the decay curve on his side is, by construction, not where the crowd is. (Premium-timing specifics belong to the other note.)

8. **Should size so that total weekly premium at risk is a small fraction of the account, and never scale up after wins.** Evidence: loss rate rises with turnover-to-capital (68× for large-turnover traders), and traders with large prior gains or losses are the most persistent (88% continue) (SEBI-B26). The ₹5L paper account should behave like a trader with capital, not like the median retail buyer whose RoCE was −114%.

9. **Should run a kill-switch and a statistical bar, because experience does not fix this.** Evidence: loss rates rise with consecutive years traded (91% → 96.5%); 0.5% of five-year traders were profitable every year; 90% of two-year losers lose again (SEBI-B26). Define in advance the number of trades after which the strategy must show positive expectancy net of friction, and stop (or go back to paper-only) if it does not. Do not let "we are learning" extend the sample.

10. **Should keep an equity/cash portfolio and treat options as a sleeve.** Evidence: loss rates fall steadily with equity-portfolio size and with cash-market activity relative to derivatives (SEBI-P26 §6.47; SEBI-B26 Table 19). Not causal, but every lower-loss cohort shares it, and it is cheap insurance against the "derivatives-only" profile (18.6 lakh traders) that loses most.

11. **Should not "switch to selling" as the fix.** Evidence: sellers lose less often (44%) but the average loss per losing seller was ₹51.7 lakh and the seller group still lost in aggregate (SEBI-B26 §5.2); every retail short-vol strategy tested on NIFTY was negative after costs (Pillai 2026, preprint); the engine's buy-only design caps the loss at the premium and needs no margin. The right lesson from the seller data is not "sell", it is "the buyer's median outcome is −114% of capital, so buy rarely and only with a measured edge".

12. **Should log, per trade, the index level at entry, time of day, days to expiry, moneyness, spread paid, charges, theta over the hold, and whether an expiry day was involved.** Evidence: these are exactly the dimensions along which SEBI, AGPZ and the Jane Street order sort winners from losers; without them the paper record cannot tell edge from noise.

## 7. Evidence vs folklore (short list)

- Evidence: 9 in 10 lose; losses concentrate in options buying, near expiry, among high-turnover small-portfolio traders; institutions' gross profits mirror retail's gross losses; costs are a third of losers' gross losses; experience does not help; curbs shift behaviour rather than end it.
- Weak or secondary evidence: the exact size and stability of the NIFTY volatility risk premium (two unreviewed preprints, abstract-only, one of them showing a 2026 sign flip); OTM weekly bid–ask spreads in India (no public series; only US evidence and Indian blogs); "sellers win" (lower loss *rate* but worse tails and negative aggregate in SEBI's sample).
- Folklore to discard: "expiry-day scalps are cheap and easy" (the cheapness is the decay); "learn by trading more" (loss rate rises with years and turnover); "the market is rigged so nothing works" (Jane Street explains a part of some expiry days, not ₹1 lakh crore a year); "buy far OTM for the big move" (highest skew, widest spread, worst returns).

## 8. Open items I could not settle

- Full text of SEBI's Jan 2023 FY22 study (only press summaries; 28% vs 23% cost ratio conflict).
- The two SSRN NIFTY VRP preprints (SSRN blocks automated access; figures above are from abstracts surfaced in search).
- Whether SEBI will act on the Sept 2026 blended-VWAP settlement proposal or on weekly expiries in FY27.
- A measured NIFTY/SENSEX weekly-option spread and slippage series by moneyness and time of day. Our own engine's fills are the best proxy we have; keep measuring them.
- SAT's 21 Oct 2026 ruling on document access in the Jane Street appeal.

---

## Sources (with dates)

SEBI primary
- SEBI, Profitability of Individual Traders in the Equity Derivatives Segment (FY25–FY26), Aug 2026 — https://www.sebi.gov.in/sebi_data/attachdocs/aug-2026/1787233506209.pdf
- SEBI, Trading Behaviour of Individual Traders in the Equity Derivatives Segment (FY25–FY26), Aug 2026 — https://www.sebi.gov.in/sebi_data/attachdocs/aug-2026/1787233601328.pdf
- SEBI PR 50/2026, 20 Aug 2026 — https://www.sebi.gov.in/media-and-notifications/press-releases/aug-2026/sebi-studies-indicate-key-trends-in-retail-participation-trading-behaviour-and-profitability-in-the-equity-derivatives_103838.html (PDF: https://www.sebi.gov.in/sebi_data/attachdocs/aug-2026/1787236407005.pdf)
- SEBI, Comparative study of growth in EDS vis-à-vis Cash Market after recent measures, Jul 2025 — https://www.sebi.gov.in/sebi_data/attachdocs/jul-2025/1751900271726.pdf
- SEBI, Analysis of Profits & Losses in the Equity Derivatives Segment (FY22–FY24), 23 Sep 2024 — https://www.sebi.gov.in/sebi_data/attachdocs/sep-2024/1727085659479.pdf; PR 22/2024 — https://www.sebi.gov.in/media-and-notifications/press-releases/sep-2024/updated-sebi-study-reveals-93-of-individual-traders-incurred-losses-in-equity-fando-between-fy22-and-fy24-aggregate-losses-exceed-1-8-lakh-crores-over-three-years_86906.html
- SEBI consultation paper, Measures to Strengthen Index Derivatives Framework, 30 Jul 2024 — https://www.sebi.gov.in/sebi_data/attachdocs/jul-2024/1722407296072.pdf
- SEBI circular SEBI/HO/MRD/TPD-1/P/CIR/2024/132, 1 Oct 2024 — https://www.sebi.gov.in/sebi_data/attachdocs/oct-2024/1727786261636.pdf
- SEBI interim order, Index manipulation by Jane Street Group, 3 Jul 2025 — https://www.sebi.gov.in/sebi_data/attachdocs/jul-2025/1751584518593.pdf; PR 40/2025 (14 Jul 2025) — https://www.sebi.gov.in/sebi_data/attachdocs/jul-2025/1752468099869.pdf; PR 45/2025 (21 Jul 2025) — https://www.sebi.gov.in/sebi_data/attachdocs/jul-2025/1753110530398.pdf
- SEBI Jan 2023 FY22 study (via press): Business Standard 25 Jan 2023 — https://www.business-standard.com/amp/article/markets/sebi-study-suggests-89-retail-traders-in-equity-f-o-suffered-losses-123012501466_1.html; Business Today 25 Jan 2023 — https://www.businesstoday.in/amp/markets/stocks/story/loss-makers-of-dalal-street-9-out-of-10-individual-fo-traders-lost-money-in-fy22-says-sebi-367628-2023-01-25

Academic / research
- Agarwal, Ghosh, Prabhala, Zhao, Animal Spirits on Steroids: Evidence from Retail Options Trading in India, 30 Sep 2025 — https://www.fma.org/assets/docs/Derivatives2025/Zhao.pdf (also CFR WP 25-09: https://www.cfr-cologne.de/download/workingpaper/cfr-25-09.pdf)
- Agarwal, Y., The Variance Risk Premium in Nifty 50: A Structural Anatomy Across Nine Empirical Filters, SSRN 6530119 (2026, preprint; abstract only) — https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6530119
- Pillai, S., Trading the Volatility Risk Premium on Nifty 50: Strategy Backtest with Realistic Frictions, SSRN 6876580 (2026, preprint; abstract only) — https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6876580
- Bryzgalova, Pavlova, Sikorskaya, Retail Trading in Options and the Rise of the Big Three Wholesalers, Journal of Finance, Oct 2023 (abstract) — https://paperguide.ai/papers/a661f87f-766d-4866-b061-fba8180d86b5-retail-trading-in-options-and-the-rise-of-the-big-three-wholesalers
- Han, Lee, Liu, Investor Trading Behavior and Performances: Evidence from Taiwan Stock Index Options, Jan 2009 (via CXO Advisory summary) — https://www.cxoadvisory.com/individual-investing/actual-index-options-trading-results
- The asymmetry in day and night option returns: evidence from an emerging market (NIFTY; journal/date not verified) — https://law-journals-books.vlex.com/vid/the-asymmetry-in-day-1115554990
- NSE Working Paper 9/2013, India VIX and risk — https://nsearchives.nseindia.com/research/content/res_WorkingPaper9.pdf
- VRP replication (VIX vs 21-day realised), GitHub, undated — https://github.com/RajolKumar2003/volatility-risk-premium-india
- International loss rates (Brazil, Korea, Taiwan, ESMA, FCA, ASIC, CFTC) as collected in SEBI-P26 Table 1.

Rules, lot sizes, STT, expiry days
- NSE lot revision NIFTY 75 → 65, circular NSE/FAOP/70616, 3 Oct 2025, effective for contracts from 30 Dec 2025 — https://nsearchives.nseindia.com/content/circulars/FAOP70616.pdf; Angel One summary — https://www.angelone.in/news/market-updates/nse-revises-lot-sizes-for-index-derivatives-from-december-2025-nifty-lot-size-to-reduce-to-65
- SENSEX lot 10 → 20 (BSE notice 20241021-13, effective 27 Dec 2024) and 20 → 25 for expiries from Jan 2027 (BSE notice 20260930-58) — https://zerodha.com/marketintel/bulletin/460276/revision-in-market-lot-of-derivative-contracts-on-indices-from-october-30-2026
- Expiry days NSE Tuesday / BSE Thursday from 1 Sep 2025 — Moneylife — https://moneylife.in/article/nse-equity-fo-contracts-to-expire-on-tuesdays-bse-on-thursdays-from-1st-september/77434.html; Business Standard 17 Jun 2025 — https://www.business-standard.com/amp/markets/news/bse-gets-sebi-approval-for-thursday-expiry-of-derivatives-contracts-125061700795_1.html
- SEBI 29 May 2025 risk-metrics circular and 1 Sep 2025 intraday limits — TaxGuru — https://taxguru.in/sebi/sebi-tightens-intraday-position-limits-derivatives.html; Business Standard 29 May 2025 — https://www.business-standard.com/amp/markets/news/sebi-fo-revamp-new-oi-metric-position-limits-july-december-rollout-125052901798_1.html
- STT Oct 2024 — Business Standard 23 Jul 2024 — https://www.business-standard.com/amp/budget/news/budget-2024-steep-stt-increase-to-tame-retail-frenzy-in-derivatives-market-124072301145_1.html; STT Apr 2026 — ICICI Direct — https://www.icicidirect.com/futures-and-options/articles/stt-changes-in-budget-2026-what-f-o-traders-need-to-know; Upstox — https://upstox.com/news/personal-finance/tax/explained-how-the-stt-hike-on-equity-futures-and-options-affects-traders-and-investors/article-189260/
- Expiry settlement-price consultation, 12 Sep 2026 — Business Standard — https://www.business-standard.com/markets/news/sebi-derivatives-settlement-closing-auction-cas-market-timings-126091200337_1.html; Business Today — https://www.businesstoday.in/markets/story/sebis-cas-proposals-expert-weighs-in-on-new-expiry-day-settlement-price-methodology-555191-2026-09-12
- Weekly-expiry status: Outlook Money (Sept 2025) — https://www.outlookmoney.com/news/sebi-to-float-consultation-paper-on-endin-futures-and-options-weekly-expiry-soon-tuhin-kanta-pandey; CAalley (Jul 2025, chairman rules out ban) — https://www.caalley.com/news-updates/indian-news/sebi-chief-tuhin-kanta-pandey-rules-out-weekly-expiry-ban-signals-tighter-derivatives-watch

Jane Street case status (press)
- Business Today, 6 Oct 2026 — https://www.businesstoday.in/markets/story/sebi-tells-sat-that-jane-street-has-enough-data-to-respond-to-market-manipulation-charges-559953-2026-10-06
- Business Today, 7 Oct 2026 — https://www.businesstoday.in/markets/story/sebi-asks-jane-street-to-respond-after-sharing-trade-data-in-market-manipulation-case-report-560196-2026-10-07
- Business Standard, 8 Oct 2026 — https://www.business-standard.com/amp/markets/news/jane-street-accuses-sebi-of-shifting-goalposts-in-sat-hearing-on-documents-126100801282_1.html
- Bloomberg, 6 Oct 2026 — https://www.bloomberg.com/news/articles/2026-10-06/sebi-says-jane-street-s-appeal-for-more-details-a-delaying-ploy
- NewsBytes (SAT to rule 21 Oct 2026) — https://www.newsbytesapp.com/news/business/sat-to-rule-oct-21-on-jane-street-evidence-access/tldr
- Business Today, 11 Jul 2025 (first expiry after ban) — https://www.businesstoday.in/markets/stocks/story/options-trading-india-falls-jane-street-ban-sebi-crackdown-484189-2025-07-11
- Outlook Money, Jul 2025 (resume trading, not options) — https://www.outlookmoney.com/invest/sebi-allows-jane-street-to-resume-trading-in-indias-stock-market-but-not-in-options
- Mondaq explainer, Jul 2025 — https://www.mondaq.com/india/commoditiesderivativesstock-exchanges/1648134/sebis-interim-order-against-jane-street-allegations-of-index-manipulation-explained
- Oxford Business Law Blog, Jul 2025 — https://blogs.law.ox.ac.uk/oblb/blog-post/2025/07/jane-street-and-expiry-day-trap-unpacking-sebis-crackdown-algorithmic

Other secondary
- Business Standard, 7 Jul 2025 (FY25 study) — https://www.business-standard.com/markets/news/net-losses-of-traders-in-fo-widens-in-fy25-sebi-study-125070701221_1.html
- Moneylife, 21 Aug 2026 (FY26 study) — https://www.moneylife.in/article/92-percentage-of-aggregate-losses-incurred-by-individuals-are-from-options-trading-sebi-study/81429.html
- Finnovate, 23 Sep 2026 (FY26 study) — https://www.finnovate.in/learn/blog/sebi-fno-trader-losses-fy26-individual-derivatives
- TradingQnA (Zerodha) summary of the Sept 2024 study — https://tradingqna.com/t/sebis-latest-analysis-of-profits-losses-in-the-equity-derivatives-segment-fy22-fy24/173596
- Business Today, 23 Apr 2026 (Kamath: 60–70% of F&O turnover from 1–2% of traders) — https://www.businesstoday.in/amp/markets/stocks/story/zerodhas-nithin-kamath-says-60-70-of-fo-volumes-come-from-just-1-2-traders-526999-2026-04-23
