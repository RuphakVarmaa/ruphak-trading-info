# R5 — Does participant-wise positioning (FII / DII / Client / Pro open interest) predict NIFTY? Evidence base for the pre-registered backtest

Research date: Sat 10 Oct 2026. Scope: the *positioning* form of the owner's "FIIs sold, so puts paid" belief. The source is NSE's `fao_participant_oi_DDMMYYYY.csv`, which gives long and short contracts for Client, DII, FII and Pro in index futures, index options, stock futures and stock options. FII *cash* flows were already tested and failed as a next-day signal (q2-gaps-trend-flows.md: next-day open→close corr 0.00, n = 1,877). r3-signals-evidence.md items #7 and #14 hold the first practitioner claims. This note is the evidence base for the backtest agent. It does not run the backtest.

Method: normal web search and page fetches only. No internal JSON endpoints were called. No bulk downloads. I fetched 16 single participant-OI files by hand (12 found, 4 not found) to check where the archive starts and how the schema has changed (§3).

Evidence grades (one per claim):
- **Replicated** — two or more independent tests agree on the sign and the horizon.
- **Single study** — one peer-reviewed or working-paper test with a stated sample. "Contested" is added when later work disagrees.
- **Practitioner untested** — a vendor, broker or blog states a rule and a hit rate, with no out-of-sample test.
- **Folklore** — widely repeated, with no stated rule or count, or with only negative tests.

Source tags such as [A3] point to §7. "(snippet)" means I saw the claim only in a search-result summary, because the page itself could not be opened.

---

## 0. Bottom line in seven points

1. **No peer-reviewed test exists of whether NSE participant-wise OI predicts NIFTY.** The searches turned up none (§1.1). The nearest Indian paper is Dhingra, Gandhi & Bulsara (2016), on daily data from Jan 2004 to Sep 2012. It finds that FIIs are return-chasers. A second-hand summary says FII futures longs and futures OI show no concurrent relation with NIFTY returns [A1].
2. **Foreign-investor evidence abroad comes from order flow in options, not from futures positions, and it decays.** Taiwan: foreign institutions' open-buy put/call ratio predicted next-day TAIEX returns over 2001–2005 [A3]. A later test on 2007–2008 found "very little evidence" that any group predicts returns. If anything, domestic individuals did slightly better [A4]. Korea: foreigners' KOSPI 200 option order imbalance predicts *same-day* index returns, intraday [A6]. None of these studies reports results after costs or out of sample.
3. **The closest analogue to participant OI is the US CFTC Commitments of Traders. There, the positioning signal is weak and unstable.** Wang (2003) found that large speculators signal continuation and hedgers are contrarian in S&P 500 futures over 1993–2000 [A8]. Chen & Maher (2013) found the relation unstable over time. They also found that a popular COT sentiment index "do[es] not produce significant average returns" [A9]. An independent in-sample check on 1995–2012 found R² ≈ 0.02 at 4 weeks, and the result split across subperiods [A10]. Applying Wang's method to petroleum futures gave no effect [A11]. The grade is **contested**, not replicated.
4. **Every specific Indian practitioner rule rests on 4 to 16 episodes, all in sample.** Examples: HDFC Securities says an FII long-short ratio below 0.15 at the start of a series was followed by higher NIFTY 4 of 4 times, averaging more than 7 % [P2]. Geojit says FII long % below 20 % since 2022 was followed by an average 9.86 % gain, 6 of 7 times [P3, snippet]. Marketcalls says the flip from net short to net long was followed by a rise within 30 sessions more than 90 % of the time, with no count given [P1]. The "below 20 %" rule has stopped discriminating: FII long % sat below 20 % on 159 of 182 sessions in 2026 [P4].
5. **The data contain a regime inversion, not a stable "FII = smart money" series.** In my spot files from 2012–2016, FIIs were 68–91 % long index futures and Clients 22–37 % long. By 2025–26 FIIs were 8–23 % long and Clients 66–84 % long (§3.3). Any full-sample "returns after FII net-long vs net-short days" test therefore compares two eras. Marketcalls' 17 % vs 6 % annualised split [P1] may be nothing more than that.
6. **The "FII" row is not a directional fund.** It mixes long-only funds that hedge cash books, index-arbitrage desks, hedge funds, ETF market-makers and prop firms registered as FPIs [P1]. Until 3 Jul 2025 it probably also held part of Jane Street's options book: the group traded through FPIs, and SEBI says it made ₹43,289 cr from NSE index options over Jan 2023–Mar 2025 [D9]. "Client" is not "retail option buyers" either. On 8 Oct 2026 Clients were net *short* 826,619 index puts (§4).
7. **Retail is on the losing side in aggregate P&L, but that does not make retail positioning a usable daily fade.** In FY26, 87.7 % of individual F&O traders lost money, options were about 92 % of their losses, and about 97 % of individuals were mainly option buyers [D11]. But 59 % of index-option turnover is in contracts expiring that day [D11]. Most retail option buying therefore never appears in end-of-day OI. **Grade: folklore** for "fade the Client row".

---

## 1. Academic and working-paper evidence

### 1.1 India

| # | Study | Measure | Sample | Horizon | IS / OOS | Effect | After costs | Later work | Grade | Tag |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Dhingra, Gandhi & Bulsara 2016, *IIMB Mgmt Review* 28(4) | Daily FII cash and futures activity (incl. futures long "FIIFB" and futures OI "FIIFOI") vs NIFTY return and volatility | Jan 2004–Sep 2012, daily | Lead–lag (VAR) | In-sample | FIIs are "return chasers" (feedback traders). Second-hand summary: no concurrent relation between FIIFB/FIIFOI and NIFTY returns. No predictive effect of positions reported | No | None found | **Single study** — no positioning signal | [A1] |
| 2 | Krishnan & Rangan 2016, NSE–NYU Stern WP | FII *quarterly cash* net buying, stock level | 2003 Q1–2014 Q2 | 3 and 12 months | In-sample panel | Portfolios on positive / zero / negative FII net buying: average quarterly returns 1.6 % / 3.8 % / 2.4 %. FII buying is *negatively* related to future returns | No | Matches Raizada & Nawn 2025 (r3) | **Replicated** (but cash, stock level, not index positioning) | [A2] |
| 3 | Mukherjee & Tiwari 2022; Raizada & Nawn 2025; Batra 2003 | FII cash flows | 2003–2019 | 1 day–1 year | In-sample | Flows follow returns; FII buys underperform their sells | No | — | **Replicated** (cash only; already in r3 §2.2) | r3 |
| 4 | Jose & Lazar 2015, *Asian Business Review* | NIFTY futures total OI (not by participant) | 2000–2011 | Daily VAR | In-sample | Spot return drives futures return; futures OI "also considered" a predictor of futures return (snippet; size not seen) | No | — | **Single study** (aggregate OI, not participant) | [A12] |

Searches for an NSE working paper, SEBI study or IIM/ISB paper that tests *participant-wise* OI (FII long ratio, FII net index futures, FII options) against later NIFTY returns found **none**. SEBI does publish a long FII derivatives history: "Daily Trends in FII Derivative Trades" has been published monthly since 2004, with index-futures OI in contracts and ₹ cr [D10]. That history gives FII gross OI, not a long/short split.

### 1.2 Taiwan (TAIFEX)

| # | Study | Measure | Sample | Horizon | IS / OOS | Effect | After costs | Later work | Grade | Tag |
|---|---|---|---|---|---|---|---|---|---|---|
| 5 | Chang, Hsieh & Lai 2009, *J. Banking & Finance* 33:757–764 | Open-buy put/(put+call) volume ratio by investor type in TAIEX options (account-level) | 21 Dec 2001–24 Dec 2005 | Next day (also 7, 9, 18 days for aggregate) | In-sample regression | Aggregate options volume: no information. Foreign institutions trade little, but their ratio has "significant predictive power" for next-day TAIEX returns, strongest in near-the-money, middle-maturity options. Coefficient size not seen (full text inaccessible) | No | Weakened by Chiu, Lee & Wang 2014 (#6) | **Single study, contested** | [A3] |
| 6 | Chiu, Lee & Wang 2014, *J. Derivatives* 21(4):63–81 | Same open-buy put/call ratio by group, VAR | 2007–2008 | Next day; intraday | In-sample | "Very little evidence that any group has much power to predict returns"; domestic individuals "a little better" than foreigners. NYCU abstract: foreign institutions' ratio has only weak predictability before late 2008 | No | — | **Single study** (negative for foreigners) | [A4] |
| 7 | Lai & Wang 2015, *J. Behavioral Finance* 16(4):311–326 | Net trading volume and net OI of foreign institutions, investment trusts, dealers in TAIEX futures | Not seen (paywalled) | Not seen | Not seen | Foreign institutions are *negative*-feedback traders. Their net trading volume has a significant positive effect on futures returns (timing unclear). *Dealers'* extreme net OI predicts futures returns | Not seen | None found | **Single study** | [A5] |
| 8 | Huang 2024, *Sun Yat-sen Mgmt Review* (ahead of print) | Account-level order imbalance by investor type, TAIEX futures and options | Not stated on page | Next day | Not stated | Foreign institutions' futures order imbalance "significantly correlated" with next-day futures returns and volatility; stronger in high uncertainty and low liquidity. Sign not stated on page | No | — | **Single study** | [A13] |
| 9 | TEJ 2025 strategy note (vendor) | Net OI of three institutional groups in TX futures; long if net OI > 5,000, short if < −5,000, exit when \|net OI\| < 1,000, ATR filter | 1 Jan 2016–1 Oct 2025 | Position-holding | No split stated | Results only in images; not readable | Not stated | — | **Practitioner untested** | [P8] |

Note on TAIFEX data: TAIFEX itself says its institutional figures are net results across many traders, not any single strategy [P8 search context]. NTU theses from 2012 (Wang; Tsai) report positive links between institutional net OI changes and next-period returns. They are unrefereed and were seen only as summaries [A14].

### 1.3 Korea (KOSPI 200)

| # | Study | Measure | Sample | Horizon | IS / OOS | Effect | After costs | Later work | Grade | Tag |
|---|---|---|---|---|---|---|---|---|---|---|
| 10 | Ahn, Kang & Ryu 2008, *J. Futures Markets* 28(12) | KOSPI 200 option trades by investor type | Not seen | Intraday / short | In-sample | Foreign investors are informed traders in KOSPI 200 options (as summarised by later papers; abstract not seen) | No | Supported by KAIST price-discovery study (foreigners most informative) | **Replicated** for *intraday price discovery*, not for daily positioning | [A6], [A15] |
| 11 | Ryu 2015, *J. Futures Markets* 35(3) | Option order imbalance, first 10 minutes | Not seen | Rest of same day | In-sample | First-10-minute option imbalances predict index and futures returns for the rest of the day; foreigners' trades and OTM options most predictive | No | Lee, Ryu, Yang & Yu 2026 (JFM): imbalances driven by convergence trades *negatively* predict related-market returns | **Single study** (intraday flow, not EOD positions) | [A6], [A16] |
| 12 | Kim & Woo (Emerald JDQS 2021) | National Pension Service net KOSPI 200 futures flow | Not seen | Not seen | Not seen | NPS net futures flow predicts KOSPI 200 futures and spot returns. Earlier work cited there finds no such predictability | No | Contested in its own literature review | **Single study, contested** (not foreigners) | [A17] |
| 13 | Ryu, Webb & Yu (XJTLU record) | KOSPI 200 futures trading frequency and performance by investor type | 2010–2023 | Performance | — | Foreign investors lose money when they trade more in bearish markets | — | — | **Single study** (performance, not prediction) | [A18] |

I found no Korean paper that tests foreigners' *end-of-day net futures position* as a next-day or next-week KOSPI predictor. The Korean "foreigners net-buy futures, so KOSPI rises" claim appears in press as same-day co-movement only. Example: a BigGo note says KOSPI rose on 35 of 39 foreign net-buy days in a 132-day window, all same-day [P9]. **Folklore** as a forecast.

### 1.4 United States (CFTC Commitments of Traders)

| # | Study | Measure | Sample | Horizon | IS / OOS | Effect | After costs | Later work | Grade | Tag |
|---|---|---|---|---|---|---|---|---|---|---|
| 14 | Wang 2003, *Applied Financial Economics* 13(12):891–898 | Position-based sentiment index (COT) for large speculators, large hedgers, small traders, S&P 500 futures | 1993–2000 (secondary source) | Weekly, multi-week | In-sample | Large speculators: continuation. Large hedgers: contrary. Small traders "hardly forecast". Extremes more reliable | No | Same method on petroleum 1996–2006: insignificant; on crude: prices cause sentiment, not the reverse | **Single study, contested** | [A8], [A11] |
| 15 | Chen & Maher 2013, *J. Int. Fin. Markets, Inst. & Money* 27:177–201 | Net positions of commercials, non-commercials, dealers, asset managers, hedge funds (legacy and disaggregated COT), S&P 500 + E-mini | Not seen on abstract page | Weekly | In-sample | Commercials' net position positively correlated with future returns but "unstable over time". Hedge funds' edge only at high frequency. Popular COT sentiment index: no significant average returns. Weekly COT with 3-day lag does not give the public timely access | No | — | **Single study** (mostly negative) | [A9] |
| 16 | CXO Advisory 2012 (independent check) | Short/long ratios of three COT groups vs SPY | Mar 1995–Sep 2012, 912 weeks | 4 weeks | In-sample | Non-commercial ratio vs next-4-week SPY: corr 0.15, R² 0.02; results differ "markedly" across two halves; "evidence does not support belief that aggregate S&P 500 Index futures positions reliably predict future stock market returns" | No | — | **Practitioner, negative** | [A10] |
| 17 | de Roon, Nijman & Veld 2000, *J. Finance* 55(3):1437–1456 | Hedging pressure (COT short − long of hedgers) | 20 futures markets incl. financials (1986–1994 per secondary sources) | Bi-weekly futures returns | In-sample | Own-market and cross-hedging pressure significantly affect futures returns after controlling for systematic risk. Equity-index-specific result not seen | No | Sanders et al. 2004, Bryant et al. 2006, Gorton et al. 2012 reject hedging pressure, mainly in commodities (secondary list) | **Contested** | [A19], [A20] |

What the analogues imply: where positioning has *any* documented power, it is (a) order flow of a better-informed group, measured from account-level data, (b) intraday or next-day, and (c) fading over later samples. Long-horizon "crowding" signals built from weekly positions, like COT, are weak (R² ≈ 0.02) and unstable. None of these studies survives as an after-cost trading rule.

---

## 2. Practitioner rules for India (with thresholds)

Definitions used below:
- **FII long %** = FII Future Index Long ÷ (Long + Short). Sources sometimes call this the "long-short ratio".
- **FII L/S ratio** = Long ÷ Short. Business Standard and HDFC use 0.09, 0.15 and so on. Note that 8.5 % long ≈ 0.093 L/S.
- **Net index futures** = Long − Short (contracts).
- **Net calls / net puts** = Call Long − Call Short; Put Long − Put Short.

| # | Rule (exact as stated) | Claimed hit rate / effect | Sample | Out-of-sample test? | Grade | Tag |
|---|---|---|---|---|---|---|
| R1 | FII L/S ratio **< 0.15 at the start of an F&O series** → NIFTY higher over the *next series* | 4 of 4, average > 7 % (episodes: 29 Sep 2022, 29 Mar 2023, 26 Oct 2023, 30 May 2024) | Since Mar 2020 (HDFC Securities, Nandish Shah, BS 7 Aug 2025) | No. The rule was published at 0.09 in Aug 2025. Forward outcome after 7 Aug 2025 not reported anywhere I found. The backtest can score it | **Practitioner untested** | [P2] |
| R2 | FII long % **falls below 20 %** → long % recovers above 20 % and rises to ≥ 55 %; NIFTY rises meanwhile | 6 of 7; average 43 days to peak (13–107); average NIFTY +9.86 % "from the first break below 20 to the subsequent peak" — measured to an ex-post peak, so it is look-ahead | Since Jan 2022 (Geojit; date unknown) | No. In 2026 long % was below 20 % on 159 of 182 sessions and below 10 % on 46 (BS, 4 Oct 2026), while NIFTY fell 14.25 % YTD to 22,421.95 on 1 Oct 2026 | **Practitioner untested; failing live** | [P3] (snippet), [P4] |
| R3 | **FII flip from net short to net long** → NIFTY higher over next 30 sessions | "> 90 % of the time", no count | 1 Sep 2016–11 Sep 2026, 2,476 sessions; 16 long→short flips (Marketcalls, 14 Sep 2026) | No; author says "observational, not a statistical test" | **Practitioner untested** | [P1] |
| R4 | **FII net-short state vs net-long state** → forward return | NIFTY annualised ~6 % on days after a net-short reading vs ~17 % after net-long | Same as R3 | No; confounded by era (see §3.3) | **Practitioner untested** | [P1] |
| R5 | **Long net-short streaks (≥ 20 sessions)** end higher | 8 of 15 | Same as R3 | No | **Practitioner untested** (≈ coin flip) | [P1] |
| R6 | **FII long % rising from ~11 % toward 25–30 %** → hedge being unwound (bullish) | No count | Same as R3 | No | **Folklore** (no count) | [P1] |
| R7 | **Low FII L/S → short-covering rally** ("shorts act as a cushion") | None | Analyst quotes, BS 15 Jul 2025, 4 Oct 2026 | No; Motilal Oswal (4 Oct 2026): "unlike in the past, this has not triggered a recovery" | **Folklore** | [P4], [P5] |
| R8 | **FII net selling of index futures in a new series** = "live bearish signal" | None | Systematix quote, BS 2 Sep 2026 | No | **Folklore** | [P6] |
| R9 | **FII index options: net call sellers + net put buyers = bearish** | None | TradingView posts; Kotak "FII net index options OI" (e.g. −777K on 1 Sep 2026, definition not stated) | No | **Folklore** | [P7], [P10] |
| R10 | **Client (retail) very long while FII very short → contrarian bearish** ("smart money vs retail") | "In every prior instance where clients were this long for this long, the market was in a bear phase" — no count; 8 Oct 2026 Client 83.6 % long index futures | Marketcalls (ten-year set) | No | **Folklore** | [P1], r3 #14 |
| R11 | **FII record net-short streak since 13 May 2025** | 333 (or 334) sessions to 11 Sep 2026, "more than twice the previous record"; net short ~2.85 lakh contracts, long ~11 %. IndiaCharts: record FPI shorts in NIFTY + BANKNIFTY futures 279,467 contracts on 27 Mar 2026 | Marketcalls; IndiaCharts via Multibagg (10 Jun 2026) | Descriptive only. During the streak NIFTY fell ~15 % from the Nov 2025 high to the Mar 2026 low | **Fact (descriptive)**, no forecast | [P1], [P11] |

Pattern across R1–R11: thresholds are chosen after the fact, episodes overlap, and outcomes are measured to ex-post peaks or over "the next series". None has costs, a holdout or a count of failures. The 2025–26 streak is the out-of-sample test that R2 and R7 are now failing.

---

## 3. Data mechanics that matter for the backtest

### 3.1 Archive coverage and publication time

| Item | Finding | How verified | Tag |
|---|---|---|---|
| URL | `https://archives.nseindia.com/content/nsccl/fao_participant_oi_DDMMYYYY.csv` (also `fao_participant_vol_…`) | GET, 10 Oct 2026 | [D1] |
| **First file** | **02 Jan 2012** exists (200). 15, 26 and 30 Dec 2011, plus 1 Jul, 3 Oct, 1 Nov and 1 Dec 2011, and 3 Jan 2011 all return 404 | Single GETs, 10 Oct 2026 | [D1] |
| Special sessions | Files exist for the Saturday special session of 20 Jan 2024, Budget Saturday 1 Feb 2025, and Muhurat sessions 1 Nov 2024 and 21 Oct 2025. Decide whether to drop these short sessions | GETs | [D1] |
| Publication time | Observed Last-Modified 18:35 IST (7 Oct 2026) and 19:02 IST (8 Oct 2026), so same evening, after the close. The 2019 NSE DotEx spec lists the file at "4:22 PM, Next day" — an older vendor schedule | r3 §2.1; EOD_FAO spec PDF (created 16 Oct 2019) | [D2] |
| Actionable | Earliest use is the **next session's open** (T+1 09:15). Same-day use is impossible | — | — |
| Missing days | Not audited (no bulk download). The backtest should list trading days with no file against NSE holidays and special sessions | — | — |

### 3.2 Schema and quirks (from the files I fetched)

| Date(s) | Quirk | Impact |
|---|---|---|
| Row 1, all years | A title line ("Participant wise Open Interest (no. of contracts) in Equity Derivatives as on …"). The header is on row 2 | Skip row 1 |
| 2012–2016 | Title single-quoted; header `Client Type` (but **`CLIENT_TYPE` on 02 Jan 2012**); totals row `TOTAL` (but **`Total` on 02 Jan 2012**) | Case-insensitive match |
| 2020–2026 | Title wrapped in doubled quotes; **tab characters and trailing spaces inside column names** (`Future Stock Short\t`, `Total Long Contracts\t`, `Future Stock Short       `) | Strip whitespace from every header |
| **02 Jan 2012** | Row order is Client, **FII, DII**, Pro (later files: Client, DII, FII, Pro). The "FII" row looks like a DII row: index futures 55,396 L / 1,387 S, *zero* option shorts. The "DII" row looks like an FII row (198,027 L / 208,336 S, 226,048 call shorts). Every DII row in later files I saw (to 21 Oct 2025) has zero option shorts | **Probable label swap.** Check every early-2012 file with header `CLIENT_TYPE`; by 01 Feb 2012 the order is normal |
| 2012–Oct 2025 | DII index option shorts are exactly 0 in every sampled file from 01 Feb 2012 to 21 Oct 2025. By 8 Oct 2026: 2,761 call short / 900 put short | DII option rows are structurally different over time |
| Columns (15) | Client Type; Future Index Long/Short; Future Stock Long/Short; Option Index Call Long, Put Long, Call Short, Put Short; Option Stock (same four); Total Long; Total Short | Same 15 fields in the 2019 NSE spec and in every file sampled 2012–2026 [D2] |
| Identity | Total row: long = short for each future and option column (e.g. 8 Oct 2026 index futures 440,198 = 440,198). Net calls across the four groups sum to 0 (8 Oct 2026: +410,031 − 404,278 − 90,652 + 84,899 = 0) | Good integrity check per file |

### 3.3 Spot readings that show the regime change (single days, not a series)

| Date | FII idx-fut long % | FII net idx fut | Client long % | Pro long % | Total idx-fut OI |
|---|---|---|---|---|---|
| 01 Feb 2012 | 69.6 % | +174,120 | 36.5 % | 36.6 % | 659,314 |
| 02 Jan 2014 | 80.2 % | +268,288 | 25.8 % | 15.6 % | 483,258 |
| 01 Sep 2016 | 90.8 % | +360,015 | 22.2 % | 20.2 % | 546,531 |
| 01 Sep 2020 | 63.7 % | +36,942 | 46.4 % | 49.2 % | 205,776 |
| 20 Jan 2024 | 45.9 % | −22,564 | 55.6 % | 50.4 % | 512,630 |
| 01 Nov 2024 | 22.6 % | −151,607 | 65.4 % | 42.7 % | 706,145 |
| 01 Feb 2025 | 12.1 % | −174,252 | 70.6 % | 60.8 % | 386,022 |
| 21 Oct 2025 | 18.9 % | −137,029 | 65.6 % | 56.6 % | 356,053 |
| 08 Oct 2026 | 8.5 % | −307,109 | 83.6 % | 64.2 % | 440,198 |

Reading: FIIs were *heavily net long* index futures in 2012–2016 and Clients heavily net short, and NIFTY rose a lot over that period. The sides have since inverted. "FIIs are structurally net short futures" is true only of the recent regime. A full-sample long-vs-short split mostly measures this one regime change. The backtest needs within-regime tests: rolling z-scores or percentiles of long %, and changes rather than levels.

### 3.4 Aggregation across indices

- "Future Index" and "Option Index" sum **all NSE index contracts**: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50 and any others listed at the time. NSE gives no per-index split [D3]. BS (15 Jul 2025) breaks one month's FII index-futures selling into NIFTY, BANKNIFTY and MidCap. 68,622 of 87,554 contracts (78 %) were NIFTY [P5]. So the mix is NIFTY-heavy but not pure.
- The options columns are **contract counts across all strikes and expiries**, not delta-weighted. A deep-OTM 0DTE put and an ATM monthly put count the same. Since one weekly expiry per exchange took effect (20 Nov 2024; NSE kept only NIFTY weeklies [D4]), index-options OI is mostly NIFTY. Before that, BANKNIFTY, FINNIFTY and MIDCPNIFTY weeklies inflated it.

### 3.5 Lot sizes (contracts vs notional)

| Index | Dated changes found | Tag |
|---|---|---|
| NIFTY | 200 (Jun 2000) → 100 (Apr 2005) → 50 (Feb 2007) → 25 (Oct 2014) → 75 (Oct 2015) per a forum thread; later 50 (dates conflict between sources); 25 → 75 for new contracts from 20 Nov 2024 (circular 18 Oct 2024); 75 → 65 from 30 Dec 2025 (monthly from Jan 2026 expiries) | [D5] (forum, unreliable pre-2024), [D6], [D7] |
| BANKNIFTY | 35 → 30 from 30 Dec 2025 | [D7] |
| FINNIFTY | 65 → 60 from 30 Dec 2025 | [D7] |
| MIDCPNIFTY | 140 → 120 from 30 Dec 2025 | [D7] |
| Rule | Since 20 Nov 2024: contract value ≥ ₹15 lakh at launch and ₹15–20 lakh at review (SEBI circular 1 Oct 2024); lot sizes are reviewed periodically (SEBI circular 30 Dec 2024) | [D4], [D6] |

Implications:
- **Ratios** (long %, L/S, Client share) are invariant to lot size *within a day*.
- **Net contract counts and day-to-day changes are not.** Around a lot change, old and new contracts coexist until the old ones expire. A 25 → 75 change cuts the contract count for the same notional by two-thirds over the roll. The total index-futures OI in contracts fell from 659,314 (Feb 2012) to 205,776 (Sep 2020) and rose again to 706,145 (Nov 2024), while notional rose. Normalise net positions by total OI (e.g. FII net ÷ total index-futures OI) or use z-scores within each lot-size regime.

### 3.6 What "FII" contains, and why the futures short is not a bearish vote

- Participant categories: Client = retail, HNIs, corporates and other non-institutional accounts. Pro = trading members' own books. FII = registered FPIs (FII and FPI merged into one category in 2014). DII = MFs, insurers, banks and pension funds [D3], [D8].
- The FII row mixes long-only funds that hedge a cash book by selling NIFTY futures, cash-futures arbitrage desks (long basket, short future when the basis is rich), hedge funds and macro funds (directional), ETF market-makers and prop firms registered as FPIs [P1]. HDFC Securities' analyst: part of the FII short "could be as a hedge position against the cash exposure" (BS, 20 Aug 2025) [P12]. Marketcalls attributes the 2.85 lakh short in 2026, versus 1.4 lakh in 2019, partly to a larger FII cash book [P1].
- **Foreign HFT is split across rows.** The Jane Street group named in SEBI's order included FPIs (Jane Street Singapore, Jane Street Asia Trading) and Indian subsidiaries (JSI Investments, JSI2 Investments). Reports say the Indian entity did same-day cash trades that FPIs may not do [D9]. Which participant row each entity's index-option OI landed in is not public. SEBI's FY26 study counts "foreign-owned global participants trading as trading-member proprietary" inside *Prop* [D11]. Both the FII and Pro option rows therefore contain market-making and arbitrage books.

### 3.7 Structural breaks to model explicitly

| Date | Event | Why it matters | Tag |
|---|---|---|---|
| 2014 | FII and sub-accounts merged into the FPI category | Category definition | [D8] |
| 20 Nov 2024 | SEBI index-derivative package: one weekly expiry per exchange (NSE: NIFTY only), contract value ₹15–20 lakh (NIFTY lot 25 → 75), upfront premium, +2 % ELM on short options on expiry day | Index-options OI composition and contract counts jump | [D4], [D6] |
| 3–4 Jul 2025 | SEBI interim order bars Jane Street entities, impounds ₹4,843.57 cr; 15 alleged BANKNIFTY expiry-day manipulation instances. Index-options turnover down ~17.4 % the week after (Kotak); Geojit says other factors were also at work | FII/Pro options rows lose a large market-maker | [D9], [D12] |
| 1 Sep 2025 | NSE expiry moves Thursday → Tuesday (SEBI circular 26 May 2025); BSE moves to Thursday | Expiry-cycle alignment of "start of series" rules (R1) | [D13] |
| 30 Dec 2025 | Lot sizes cut (NIFTY 75 → 65 etc.) | Contract-count discontinuity | [D7] |
| 13 May 2025 → present | FII net short every session (record streak) | Level-based rules have no variation inside the streak | [P1] |
| Pending | SEBI said in Sep 2025 a paper on ending weekly expiries would come "when ready"; no 2026 change confirmed | Watch for further breaks | [D14] |

---

## 4. Who holds which side of index options (SEBI / NSE)

| Fact | Value | Source |
|---|---|---|
| Individuals mainly buy options (FY26) | ~97 % of individual traders "predominantly followed options-buying strategies"; ~2 % mainly sellers; sellers were the only group with positive median return on capital | SEBI DEPA FY25–26 studies, via Moneylife 21 Aug 2026 [D11] |
| Individuals lose; Prop and FPIs win (gross, before costs) | FY26: Prop ~₹44,000 cr, FPIs ~₹14,000 cr, individuals −₹72,000 cr gross (−₹91,685 cr net); 87.7 % of individuals lost; options ≈ 92 % of individuals' losses; 99 % of FPI/Prop profit from algo entities | [D11] |
| Same in FY24 | Prop ₹33,000 cr and FPIs ₹28,000 cr gross profit; individuals lost > ₹61,000 cr; 97 % of FPI and 96 % of Prop profit from algos; 93 % of individuals lost over FY22–24 | SEBI Sep 2024 study, via Outlook Business/Money [D15] |
| Intraday nature of index options | ~59 % of index-option turnover in same-day-expiry contracts; ~75 % within one day; ~97 % within one week (FY26) | [D11] |
| Category shares of equity-options premium (NSE) | FY26 to Nov 2025: Individuals 34.1 %, Prop 29.5 %, FIs 15.2 %, DIIs 14.0 % (equity options, premium turnover; no separate index-options table found) | NSE Market Pulse Dec 2025 [D16] |
| EOD OI by category (8 Oct 2026) | Client: net calls **+410,031**, net puts **−826,619** (net *seller* of puts). FII: net calls −404,278, net puts +666,083. Pro: −90,652 / +104,152. DII: +84,899 / +56,384 | NSE participant OI file [D1] |

**No SEBI or NSE study I found reports who holds which side of index options *at end of day*, or who is the counterparty to individuals.** The FY26 coverage says so directly: it reports only category-level P&L, not counterparties [D11].

Implications for "retail positioning is contrarian":
- The P&L studies are about *intraday option buying*. That flow is mostly 0DTE and is closed before the close, so it barely appears in EOD OI.
- The "Client" row in EOD OI is dominated by positions held overnight. On 8 Oct 2026 it was net short puts and net long futures and calls — a *bullish seller* book, more like HNIs and corporates writing puts than retail buying lottery puts.
- So "retail loses, therefore fade the Client row" mixes two different populations. It is **folklore** until tested. If the backtest tests it, it should use *changes* in Client net index futures and Client net puts, not the level, and must beat the FII-only version.

---

## 5. Testable hypotheses for the backtest, ranked by evidence quality

All signals are computed from the file for day T and traded from the T+1 open. Index futures and options are aggregated across indices (see §3.4). Use ratios or OI-normalised values (see §3.5).

| Rank | Hypothesis (exact definition) | Claimed effect and horizon | Evidence grade | Basis |
|---|---|---|---|---|
| H1 | **FII index-options open-position skew → next-day NIFTY.** S_T = (FII Put Long − FII Put Short) − (FII Call Long − FII Call Short), divided by FII total index-option OI. Use the daily *change* ΔS_T as well as the level. A higher put skew predicts a lower T+1 open→close return | Taiwan analogue: foreign open-buy put ratio predicts next-day return (2001–05), weakening in 2007–08. Size unknown | **Single study, contested** (analogue only; EOD OI ≠ open-buy flow) | [A3], [A4] |
| H2 | **ΔFII net index futures (OI-normalised) → next 1 and 5 days.** x_T = (FII L − FII S)_T − (FII L − FII S)_{T−1}, ÷ total index-futures OI_T. Sign: positive x predicts higher NIFTY. Control for same-day return (FIIs chase returns) | Taiwan: foreign net futures trading positively related to futures returns (timing unclear); Taiwan account-level: foreign futures imbalance correlated with next-day return | **Single study** (analogue) | [A5], [A13] |
| H3 | **FII long % extreme, within regime → 20–30-session forward return (contrarian).** L_T = 5-day mean of FII long %. Signal when L_T is in the bottom decile of the trailing 250-session distribution (rolling, no look-ahead) | Practitioners: low readings precede rallies (R2: 6/7, +9.86 % to ex-post peak; R1: 4/4, >7 %). COT analogue says extremes matter more (Wang 2003) but R² ≈ 0.02 | **Practitioner untested**; analogue contested | [P2], [P3], [A8], [A10] |
| H4 | **FII L/S < 0.15 at the first session of a monthly series → next-series NIFTY return > 0** (exact HDFC rule; series = monthly expiry to monthly expiry; Thursday cycle until Aug 2025, Tuesday from Sep 2025). Score the 4 claimed episodes and every later qualifying series | 4/4, average > 7 % | **Practitioner untested** | [P2] |
| H5 | **Flip from net short to net long** (FII L − S crosses from < 0 to > 0, confirmed for 3 sessions) **→ 30-session forward return** | "> 90 %" up; count not given (≤ 16 flips in 10 years) | **Practitioner untested** | [P1] |
| H6 | **FII–Client divergence:** D_T = FII long % − Client long % (index futures). Contrarian on Client: extreme negative D (FII short, Client long) predicts a lower 5–20-session return. Test against H3 to see whether the Client leg adds anything | None quantified; "bear phase" anecdote | **Folklore** | [P1] |
| H7 | **State test (benchmark for H3–H6):** NIFTY forward 1-, 5- and 20-session returns when FII net index futures < 0 vs > 0, run *separately* for 2012–2019 and 2020–2026 | 6 % vs 17 % annualised (full sample, era-confounded) | **Practitioner untested** | [P1] |

Pre-registration notes:
- Report H7 by era. A full-sample win is expected from the regime split alone.
- Every hypothesis must beat (a) the same-day-return control, because flows follow returns [A1], and (b) the q2 result that FII cash flow has zero next-day correlation.
- Any options-based trade must clear the program's own costs and acceptance bar.

---

## 6. Access failures and gaps

| Item | What happened |
|---|---|
| Geojit "Larger Nifty upside yet to unfold…" (blog.geojit.com/?p=19714) | WebFetch 503; curl connection reset; no Wayback copy. R2 numbers come from the search snippet only; **publication date unknown** |
| insights.geojit.com (FIIs ease index future shorts; Jane Street volumes) | DNS failure (ENOTFOUND) |
| Chang, Hsieh & Lai 2009 (ScienceDirect; City/Bayes PDF) | 403. Sample period taken from a student slide deck at NYCU (finance.lab.nycu.edu.tw); coefficients not seen |
| Dhingra et al. 2016 full text (ScienceDirect) | 403; abstract from the IIMB page; the FIIFOI result is a search summary of the paper |
| Lai & Wang 2015; Ahn, Kang & Ryu 2008; Ryu 2015 (ResearchGate) | Paywall or 403; abstracts and secondary summaries only |
| Business Standard AMP pages | 403 to WebFetch; desktop pages fetched by curl worked |
| Kotak Neo Derivatives Daily PDFs | Text extracted, but no definition of "FII net index options OI" |
| SEBI FY25–26 study PDF; SEBI Jul 2024 consultation-paper tables | Not located on sebi.gov.in; press summaries used. No index-options-by-category premium table found |
| Pre-2024 NIFTY lot-size history | Only a forum thread with conflicting dates; NSE circulars not opened |
| Missing-day audit of the archive | Not done (no bulk download); left to the backtest agent |

---

## 7. Sources

Academic / working papers
- [A1] Dhingra, V. S., Gandhi, S., Bulsara, H. P. (2016). Foreign institutional investments in India: dynamic interactions with stock market return and volatility. *IIMB Management Review* 28(4). Abstract (Jan 2004–Sep 2012, daily): https://www.iimb.ac.in/imr/previous-issues/foreign-dec-2016.php ; https://www.sciencedirect.com/science/article/pii/S0970389616300854 (403)
- [A2] Krishnan, M., Rangan, S. (2016, version 11 Feb 2016). Foreign Institutional Investor Trading and Future Returns: Evidence From an Emerging Economy. NSE–NYU Stern WP. https://www.stern.nyu.edu/sites/default/files/assets/documents/Foreign%20Institutional%20Investor%20Trading%20and%20Future%20Returns.pdf
- [A3] Chang, C.-C., Hsieh, P.-F., Lai, H.-N. (2009). Do informed option investors predict stock returns? Evidence from the Taiwan stock exchange. *J. Banking & Finance* 33:757–764. https://www.sciencedirect.com/science/article/abs/pii/S0378426608002707 (403); slide summary with sample dates: https://finance.lab.nycu.edu.tw/Students/105吳俊輝/Do%20informed%20option%20investors%20predict%20stock%20return.pdf
- [A4] Chiu, W.-C., Lee, H.-H., Wang, C.-W. (2014). Have domestic institutional investors become as market savvy as foreign investors? Evidence from the Taiwan options market. *J. Derivatives* 21(4):63–81. https://eprints.gla.ac.uk/95449 ; https://ir.lib.nycu.edu.tw/handle/11536/24990
- [A5] Lai, H.-C., Wang, K.-M. (2015). Trading Behavior of Institutional Investors and Stock Index Futures Returns in Taiwan. *J. Behavioral Finance* 16(4):311–326. https://ideas.repec.org/a/taf/hbhfxx/v16y2015i4p311-326.html
- [A6] Ahn, H.-J., Kang, J., Ryu, D. (2008). Informed trading in the index option market: The case of KOSPI 200 Options. *J. Futures Markets* 28(12). https://www.researchgate.net/publication/254446844 ; Ryu, D. (2015). The Information Content of Trades: An Analysis of KOSPI 200 Index Derivatives. *JFM* 35(3). https://www.researchgate.net/publication/259538357 (403; abstract via search)
- [A8] Wang, C. (2003). Investor sentiment, market timing, and futures returns. *Applied Financial Economics* 13(12):891–898. https://ideas.repec.org/a/taf/apfiec/v13y2003i12p891-898.html
- [A9] Chen, H., Maher, D. (2013). On the predictive role of large futures trades for S&P500 index returns: An analysis of COT data as an informative trading signal. *JIFMIM* 27:177–201. https://ideas.repec.org/a/eee/intfin/v27y2013icp177-201.html
- [A10] CXO Advisory (19 Sep 2012). COT Data Predictive for S&P 500 Index? https://www.cxoadvisory.com/sentiment-indicators/cot-data-predictive-for-sp500-index/
- [A11] Petroleum and crude replications of Wang's method (via search summary): https://www.earticle.net/Article/A242572 ; https://www.inderscience.com/filter.php?aid=60071
- [A12] Jose & Lazar (2015). *Asian Business Review*. https://ideas.repec.org/a/ris/asbure/0068.html
- [A13] Huang, H.-G. (2024, ahead of print). Information content of trading activities of different investor types: account-level evidence, Taiwan futures and options. *Sun Yat-sen Management Review*. https://www.airitilibrary.com/Article/Detail/10232842-PP202401260017-PP2024080007-00001
- [A14] NTU theses (2012): https://tdr.lib.ntu.edu.tw/handle/123456789/16067 ; https://tdr.lib.ntu.edu.tw/handle/123456789/16392
- [A15] KAIST, Which Traders Contribute Most to Price Discovery? KOSPI 200 options. https://koasas.kaist.ac.kr/handle/10203/214642
- [A16] Lee, Ryu, Yang, Yu (2026). Cross-Market Convergence Trading in Options Order Flow. *JFM* e70142. https://onlinelibrary.wiley.com/doi/10.1002/fut.70142
- [A17] Kim & Woo, NPS futures trading, *J. Derivatives and Quantitative Studies*. https://www.emerald.com/insight/content/doi/10.1108/JDQS-02-2021-0004/full/html
- [A18] Ryu, Webb, Yu. Frequent Trading and Investment Performance: KOSPI 200 Futures. https://scholar.xjtlu.edu.cn/en/publications/frequent-trading-and-investment-performance-evidence-from-the-kos/
- [A19] de Roon, F., Nijman, T., Veld, C. (2000). Hedging pressure effects in futures markets. *J. Finance* 55(3):1437–1456. https://ideas.repec.org/a/bla/jfinan/v55y2000i3p1437-1456.html
- [A20] Rejections of hedging pressure (Sanders et al. 2004; Bryant et al. 2006; Gorton et al. 2012) as listed in: https://mpra.ub.uni-muenchen.de/36425/1/MPRA_paper_36425.pdf (via search summary)

Practitioner / press
- [P1] Marketcalls (Rajandran R., 14 Sep 2026). What Do We Actually Know About FII Index Futures Shorts? https://www.marketcalls.in/futures-and-options/what-do-we-actually-know-about-fii-index-futures-shorts.html
- [P2] Business Standard (7 Aug 2025). FIIs hold 10 short bets for every long trade in index futures (HDFC Securities study). https://www.business-standard.com/markets/news/fiis-hold-10-short-bets-for-every-long-trade-in-index-futures-125080700077_1.html
- [P3] Geojit blog, "Larger Nifty upside yet to unfold…" (date unknown; page inaccessible; snippet only). https://blog.geojit.com/larger-nifty-upside-yet-to-unfold-heres-what-to-watch-out-for/
- [P4] Business Standard (4 Oct 2026). FPIs most bearish in 2 months; rapid turnaround unlikely. https://www.business-standard.com/markets/news/markets-news-foreign-investors-short-on-indian-markets-as-global-risks-weigh-126100400229_1.html
- [P5] Business Standard (15 Jul 2025). FIIs net sold over 68,000 Nifty futures in July series. https://www.business-standard.com/markets/news/fiis-net-sold-over-68-000-nifty-futures-in-july-series-what-to-expect-now-125071500161_1.html
- [P6] Business Standard (2 Sep 2026). FIIs pile up 2.5 lakh index shorts. https://www.business-standard.com/markets/news/fiis-pile-up-2-5-lakh-index-shorts-analysts-decode-sep-market-outlook-126090200311_1.html
- [P7] TradingView idea, "Nifty Game of Positions – F&O data analysis". https://in.tradingview.com/chart/NIFTY/eKXDr4ge-Nifty-Game-of-Positions-F-O-Data-analysis ; Trendlyne participant table (net call/put definitions): https://trendlyne.com/futures-options/reports/participants-wise-oi/m/jun-2020
- [P8] TEJ (4 Dec 2025). Three Major Institutional Investors' Position-Based Trading Strategy for TAIEX Futures. https://www.tejwin.com/en/insight/three-major-institutional-investors-position-based-trading-strategy-for-taiex-futures/
- [P9] BigGo Finance, KOSPI and foreign net buying. https://finance.biggo.com/news/bd27e876-6b10-4c5c-9310-4af9212a9baa
- [P10] Kotak Securities, Derivatives Daily (1 Sep 2026). https://www.kotakneo.com/uploads/Derivatives_Daily_000105_1_Sep_2026_81217fd399.pdf
- [P11] Multibagg (10 Jun 2026), citing IndiaCharts. https://www.multibagg.ai/market-pulse/articles/fpi-shorts-nifty-bottom-signals-cmq7g0yx2axt1ph0j5jonnf3y
- [P12] Business Standard (20 Aug 2025). FIIs short bets intact even as Nifty rises nearly 700 pts. https://www.business-standard.com/markets/news/fiis-short-bets-intact-even-as-nifty-rises-nearly-700-pts-from-recent-lows-125082000295_1.html

Data / regulatory
- [D1] NSE participant-wise OI archive (single files fetched 10 Oct 2026: 02 Jan 2012, 01 Feb 2012, 02 Apr 2012, 01 Jan 2013, 02 Jan 2014, 01 Sep 2016, 01 Sep 2020, 20 Jan 2024, 01 Nov 2024, 01 Feb 2025, 21 Oct 2025, 08 Oct 2026; 404 for 03 Jan 2011, 01 Jul 2011, 03 Oct 2011, 01 Nov 2011, 01 Dec 2011, 15 Dec 2011, 26 Dec 2011, 30 Dec 2011). Pattern: https://archives.nseindia.com/content/nsccl/fao_participant_oi_DDMMYYYY.csv
- [D2] NSE DotEx Post Trade Data tech spec (PDF created 16 Oct 2019), field list and schedule: https://archives.nseindia.com/content/press/EOD_FAO.pdf
- [D3] AlgoTest explainer (categories; aggregated, EOD only): https://algotest.in/blog/participant-wise-open-interest/ ; Zerodha TradingQnA on Client/Pro tagging: https://tradingqna.com/t/who-are-the-clients-and-the-pro/5492
- [D4] SEBI circular 1 Oct 2024 measures (via Business Standard, 1 Oct 2024): https://www.business-standard.com/markets/news/sebi-announces-six-key-changes-to-curb-speculation-in-derivatives-trading-124100101316_1.html ; Zerodha Z-Connect: https://zerodha.com/z-connect/business-updates/sebis-new-rules-for-index-derivatives-heres-whats-changing ; NSE keeps only NIFTY weekly: https://www.outlookmoney.com/news/nse-discontinues-these-3-weekly-index-options-will-offer-only-nifty-50-weekly-option
- [D5] TradingQnA, Historical F&O lot sizes (5 Oct 2025; unreliable): https://tradingqna.com/t/historical-fno-lot-sizes/187320
- [D6] 5paisa, NSE lot size revision from 20 Nov 2024: https://www.5paisa.com/index.php/news/nse-revises-lot-sizes-for-key-index-derivatives-starting-november-2024
- [D7] Zerodha bulletin (4 Oct 2025), lot sizes from 30 Dec 2025: https://zerodha.com/marketintel/bulletin/429705/revision-in-lot-size-of-index-derivative-contracts-from-december-30-2025
- [D8] FII/FPI merged in 2014 (via search summary of NSE FPI pages): https://www.nseindia.com/static/invest/fpi/foreign-investment-avenues
- [D9] SEBI interim order on Jane Street, 3 Jul 2025 (summaries): https://www.mondaq.com/india/commoditiesderivativesstock-exchanges/1648134/ ; https://blogs.law.ox.ac.uk/oblb/blog-post/2025/07/jane-street-and-expiry-day-trap-unpacking-sebis-crackdown-algorithmic ; https://www.businesstoday.in/amp/markets/story/sebi-cracks-down-on-jane-street-in-landmark-derivatives-market-case-484348-2025-07-11
- [D10] SEBI, Daily Trends in FII Derivative Trades (monthly pages from 2004): https://www.sebi.gov.in/statistics/fpi-investment/derivative-trades/jun-2004.html
- [D11] SEBI DEPA FY25–26 profitability and trading-behaviour studies, via Moneylife (21 Aug 2026): https://www.moneylife.in/article/92-percentage-of-aggregate-losses-incurred-by-individuals-are-from-options-trading-sebi-study/81429.html ; Business Today (21 Aug 2026): https://www.businesstoday.in/markets/story/rs91685-cr-lost-88-of-individual-traders-lost-money-in-fy26-options-drove-92-of-losses-550474-2026-08-21
- [D12] Kotak Securities on post-order volumes: https://www.kotaksecurities.com/investing-guide/futures-and-options/jane-street-sebi-ban-f-and-o-volumes-drop
- [D13] Moneylife: NSE F&O to expire on Tuesdays from 1 Sep 2025: https://moneylife.in/article/nse-equity-fo-contracts-to-expire-on-tuesdays-bse-on-thursdays-from-1st-september/77434.html ; Business Standard (26 May 2025): https://www.business-standard.com/amp/markets/news/sebi-limits-equity-derivatives-expiry-to-tuesdays-and-thursdays-125052601285_1.html
- [D14] Outlook Money, SEBI chair on weekly-expiry consultation (Sep 2025): https://www.outlookmoney.com/news/sebi-to-float-consultation-paper-on-endin-futures-and-options-weekly-expiry-soon-tuhin-kanta-pandey
- [D15] SEBI Sep 2024 study (FY22–24), via Outlook Business and Outlook Money: https://www.outlookbusiness.com/markets/fo-frenzy-over-93-retail-investors-lost-average-rs-2-lakh-in-three-years-says-sebi ; https://www.outlookmoney.com/invest/93-of-individual-traders-suffered-losses-in-fo-in-last-3-years-sebi-study
- [D16] NSE Market Pulse, Dec 2025: https://nsearchives.nseindia.com//web/mediaattachment/2025-12/Market_Pulse_December_2025.pdf

Status: complete
