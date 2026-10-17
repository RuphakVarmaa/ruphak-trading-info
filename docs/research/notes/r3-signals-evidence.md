# R3 — Which trend / flow / options signals have documented predictive value for NIFTY/SENSEX, and which are folklore

Research date: Fri 9 Oct 2026 (IST morning, before open). Scope: signals the owner named (ADX, moving averages, "selling pressure" = FII net selling), plus options-market signals (PCR, max pain, OI build-up, India VIX), technicals already in the engine (RSI, ADX/DMI, EMA 9/21, Supertrend, Bollinger %B, VWAP, opening range), breadth, delivery %, block deals, and the data plumbing for each. Horizons: intraday, next day, next week.

Conventions: "Evidence" = peer-reviewed/working-paper tests on Indian data with a stated sample, or our own reproducible check in this container; "Practitioner" = vendor/blog backtests with stated rules but no review; "Folklore" = widely repeated, no test found or the only test is negative. Every number carries its source. Where a source was only seen second-hand it is flagged "(second-hand)".

---

## 0. Bottom line in six points

1. **FII net cash selling is a same-day fact, not a next-day forecast.** The academic literature on India (daily data, 2003–2019) finds returns → flows (FIIs are positive-feedback / return-chasing traders) far more robustly than flows → next-day returns; where a flows→returns lag-1 effect appears it is marginal (5% level) and has no reported economic size (Mukherjee & Tiwari 2022; Dhingra, Gandhi & Bulsara 2016; Raizada & Nawn 2025 find FII buys *underperform* their sells at every horizon from 1 day to 1 year). The 8 Oct 2026 example ("FIIs sold ₹12,944 cr, so puts paid") is a contemporaneous relation: the number is published ~2.5–3 h *after* the close of the day it describes. Our own check (§4.2) could only cover 29 sessions (no headless source of older provisional data) and found same-day corr +0.17 vs next-day corr −0.09, t = −0.47 — no next-day signal, though the sample is too small to prove absence.
2. **Big down days themselves have had mild next-day reversal, not continuation, in the last six years** (our Yahoo check, 8 Oct 2020–8 Oct 2026: after NIFTY days < −2 %, n = 27, next-day mean +0.81 %, up 74 % of the time; after < −1.5 %, n = 64, +0.29 %, up 64 %). Small samples, regime-dependent (dominated by 2020–22 dip-buying) — but it is the opposite of "heavy selling yesterday → buy puts today".
3. **Options-market signals:** the only peer-reviewed Indian evidence is for the put–call ratio (Jena, Tiwari & Mitra 2019, NSE 2001–2013): PCR-OI Granger-causes NIFTY returns only at ≥12-day horizons, PCR-volume only at ~2.5-day horizons in rolling tests, neither during crises, and the paper does not even report the sign. Max pain, OI build-up quadrants and "FII put/call positioning" have no supporting test; the one structured max-pain check (vendor, 19 expiries) was negative.
4. **India VIX predicts the *size* of moves, not direction.** VIX level is a decent 1–4-week realised-volatility forecast (Bahadur & Kothari 2016: r = 0.74 with the next 21-day realised SD; Thenmozhi & Chandra 2013: VIX beats GARCH), and the VIX–return relation is contemporaneous, negative and asymmetric. No Indian study tests lagged VIX → next-day direction. For an option *buyer* VIX is a premium/expected-move input, not a buy/sell signal.
5. **Technical indicators on NIFTY:** daily MA rules looked profitable in old samples (1996–2003) but the most recent academic test (50/200 SMA, 2010–Jun 2022) earned a 4.0 % CAGR vs 9.9 % buy-and-hold, and a 2022–2026 state test shows no next-day difference between golden-cross and death-cross regimes (t < 1). No peer-reviewed Indian test exists for ADX, Supertrend, RSI, VWAP or Bollinger on intraday index data; practitioner backtests that model costs show Supertrend losing with default parameters on NIFTY 50. Opening-range breakout is the only intraday rule with a stated-rules, costed test on NIFTY options (Zerodha "In the Money", Jan 2022–Feb 2026): option *buying* on an ORB had ~48 % win rate and ~45 % max drawdown; option *selling* on the same break was smoother.
6. **Breadth / delivery / block deals:** advance–decline explains the *same-period* index move (adj R² 0.64 monthly) and nothing about the next period (Patel 2015, NSE 2000–2013). Delivery % and block/bulk deals are stock-level, not index-direction, signals.

---

## 1. Ranked table — signals by strength of evidence

Ranking is by quality of evidence for *predicting* NIFTY (not for describing it). "Effect" is as reported; blank = none reported.

| # | Signal | What it predicts (documented) | Horizon | Effect size / stats | Best source (sample) | Data: where / when available | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | **India VIX level** | Realised volatility magnitude (not direction) | 5–21 trading days | r(VIX, next-21-day realised SD) = 0.741; r(VIX, next-5-day SD) lower; VIX beats GARCH/EGARCH as realised-vol predictor | Bahadur & Kothari 2016 (Mar 2009–Dec 2015, 1,656 obs); Thenmozhi & Chandra NSE WP/9/2013 | NSE `api/allIndices` (live, 8 Oct close: 15.31, +10.26 %) | **Evidence** — use for expected move / premium sanity, never for direction |
| 2 | **Large same-day index move (|r| ≥ 1.5–2 %)** | Mild next-day *reversal* | Next day | After < −2 %: n=27, +0.81 % (t=3.3), up 74 %; after < −1.5 %: n=64, +0.29 % (t=1.9), up 64 %; after < −1 %: n=151, +0.08 % (t=0.8) | Our check, Yahoo ^NSEI daily closes 8 Oct 2020–8 Oct 2026 (§4.1) | Known at close; actionable at next open | **Evidence (weak, regime-dependent)** — argues *against* chasing yesterday's selling with puts |
| 3 | **Put–call ratio, open-interest based (PCR-OI)** | NIFTY return, low-frequency component only | ≥ 12 trading days (6–12 d at 10 %) | Granger-causal at 5 % in frequency band ω≈0.51 (12 d+); not significant at short horizons; sign not reported; not significant in 2008 crisis or post-2012 | Jena, Tiwari & Mitra 2019, *Economies* (NSE daily 1 Jun 2001–16 May 2013) | NSE `api/option-chain-v3` live (8 Oct 13-Oct expiry: CE OI 3.48 m, PE OI 2.14 m) | **Evidence (thin, dated, wrong horizon for us)** |
| 4 | **Put–call ratio, volume based (PCR-vol)** | NIFTY return, short-run component, intermittently | ~2.5 days | Rolling 250-day out-of-sample frequency-domain causality significant in some sub-periods (incl. 2008); in-sample: no causality | Same paper | Same endpoint (8 Oct: CE vol 32.0 m, PE vol 34.0 m contracts) | **Evidence (unstable)** — "short-lived and fleeting" per authors |
| 5 | **FII net cash flow (NSE provisional)** | Next-day NIFTY return — *marginal*; same-day — strong | Next day (lag 1) | Flows→returns: F = 2.70/2.77 (5 %) at lag 1 only, no coefficient reported; returns→flows: F = 3.6–7.7 (1 %) at lags 1–4 | Mukherjee & Tiwari 2022, *Asia-Pacific Financial Markets* (daily Apr 2014–Nov 2019) | NSE `api/fiidiiTradeReact`, published ~18:00–18:30 IST on T (see §7) | **Mostly folklore as a next-day signal**; our 29-session check (§4.2): next-day corr −0.09, t = −0.47 |
| 6 | **FII trades as information** | FII buys *underperform* FII sells at all horizons | 1 day – 1 year | "trade informativeness remains negative across all holding periods" | Raizada & Nawn 2025, *J. Asset Management* (2003–2019) | — | **Evidence against** copying FII direction |
| 7 | **FII index-futures long/short ratio (participant-wise OI)** | Positioning gauge; practitioner claims of multi-week mean reversion | 20–30 sessions | Practitioner: NIFTY annualised ~6 % after FII net-short readings vs ~17 % after net-long; 8 of 15 20+-session short streaks ended higher; "flip to net long → up over next 30 sessions > 90 %" (no count) | Marketcalls, Sep 2016–Sep 2026 (observational, no test) | `archives.nseindia.com/content/nsccl/fao_participant_oi_DDMMYYYY.csv`, published 18:35–19:02 IST on T (file Last-Modified) | **Practitioner / untested**; 8 Oct: FII index-fut long 31,583 vs short 338,692 (8.5 % long) |
| 8 | **Opening-range breakout (ORB) on NIFTY** | Intraday continuation | Same day | Spot (Jan 2019–Feb 2026, no costs): 9:15–11:15 range best; long win ≈ 60 %, short ≈ 50 %. Options (Jan 2022–Feb 2026, costs + 0.2 % slippage): buying win ≈ 48 %, max DD ≈ 45 %; selling max DD ≈ 6 %, all years positive | Zerodha "In the Money" parts 1–2 | Engine already computes | **Practitioner, costed** — the only intraday rule with a stated NIFTY-options test |
| 9 | **Advance–decline ratio** | Same-month return only | Next month: none | Concurrent: β = 30.51, t = 16.96, adj R² 0.636; lagged: β = 3.40, t = 1.16, p = 0.248, adj R² 0.002 | Patel 2015, *J. Finance Issues* (NSE monthly Apr 2000–Dec 2013, 165 obs) | NSE `api/allIndices` gives live advances/declines (8 Oct NIFTY 50: 3 up / 47 down) | **Descriptive, not predictive** (no daily/intraday Indian test found) |
| 10 | **50/200-DMA state, MA crossovers** | Trend description | Next day: none | Golden-cross days: next-day +0.024 % (n=779, t=0.84); death-cross days: +0.028 % (n=366, t=0.56). Strategy 2010–Jun 2022: CAGR 4.01 % vs B&H 9.90 % | emaindicator.com (15 Feb 2022–6 Oct 2026); Lakshan 2026 (Zenodo) | Any daily feed | **Folklore for direction at ≤ 1-week horizon** |
| 11 | **Supertrend / ADX / RSI / EMA 9-21 / Bollinger / VWAP on NIFTY** | — | intraday / daily | No peer-reviewed Indian test. Supertrend default params on NIFTY 50: strategy balance dipped ~6.6 % below start (arXiv 2405.14262); Share.Market 2012–2025 Nifty-500 test: "most traders lose" (blog). Optimised RSI/MACD on NIFTY-50 stocks beat buy-and-hold only in-sample (Mahajan 2020-ish, SSRN) | — | Engine computes | **Folklore / unproven** |
| 12 | **OI build-up quadrants (long/short build-up etc.)** | — | — | No test on NIFTY found; only secondary citations (Srivastava NSE WP 2003 on stock-option OI) | — | option chain / bhavcopy | **Folklore** |
| 13 | **Max pain** | Expiry settlement level | Expiry day | Only structured check (vendor, 19 expiries): max pain predicted the close *worse* than "no change"; level shifts 100+ points day to day | MarketsEasy; Zerodha Varsity | option chain | **Folklore** |
| 14 | **FII vs retail/"Client" positioning as contrarian** | — | — | 8 Oct: Client index-fut 83.6 % long, FII 8.5 % long. No test. | NSE participant OI | same file as #7 | **Folklore** |
| 15 | **Delivery %** | — | — | One two-stock Granger study (Bajaj Auto yes, BPCL no) | — | NSE bhavcopy (next day) | **No evidence** |
| 16 | **Block / bulk deals** | Stock-level abnormal returns, mostly *before* the deal (front-running) | days around event | NSE bulk deals 2010–2019: +5–7 % within a week around event; BSE block deals 2006–2012: +1.32 % on deal date | Indian event studies (see sources) | NSE after close | Stock-level; **irrelevant to index direction** |
| 17 | **India VIX change as direction signal** ("VIX up → go short") | — | — | Relation is contemporaneous (corr NIFTY level vs VIX −0.83; adj R² 0.25 with negative returns vs 0.11 with positive). No lagged-direction test | Thenmozhi & Chandra 2013 | live | **Folklore** |

---

## 2. FII / DII flows — detail

### 2.1 What the data are and when they appear (verified 9 Oct 2026 from this container)

| Dataset | What | Timing | Verified |
|---|---|---|---|
| NSE "FII/FPI & DII trading activity" (provisional, cash market) | Gross buy/sell/net ₹ cr for FII/FPI and DII, compiled from PAN (NSDL) and trading codes; "provisional and subject to change… custodial confirmation" (NSE page note, via search) | Published after close on T. Secondary sources cluster at 18:00–18:30 IST (NiftyTrader), "4:00–5:30 PM" (Moneycontrol FAQ), "after 6 pm" (others); none official. Final figures next morning | `GET https://www.nseindia.com/api/fiidiiTradeReact` → 200, 220 bytes: 08-Oct-2026 FII/FPI buy 15,725.45 / sell 28,669.03 / **net −12,943.58**; DII net **+10,703.11** |
| NSDL "Daily Trends in FPI Investments" | Custodian-confirmed FPI trades, "on and up to the previous trading day(s)"; equity vs debt, exchange vs primary | T+1-ish; SEBI: daily dissemination since 1 Jun 2014 | `https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx` → 200; "on 08-Oct-2026": equity (stock exchange) net **−6,206.30 cr** — note it differs from NSE's −12,944 because of coverage/timing |
| NSE participant-wise OI (`fao_participant_oi_DDMMYYYY.csv`) | Long/short contracts by Client/DII/FII/Pro for index futures, index options (call long/put long/call short/put short), stock futures/options | Published T evening. File Last-Modified: **8 Oct 13:32 UTC = 19:02 IST**; 7 Oct 13:05 UTC = 18:35 IST | `https://archives.nseindia.com/content/nsccl/fao_participant_oi_08102026.csv` → 200 (HEAD requests get 503; use GET) |
| NSE participant-wise volume (`fao_participant_vol_…csv`) | Same breakdown, traded volume | Same evening | → 200 |

8 Oct 2026 participant-wise OI (contracts): FII index futures **long 31,583 / short 338,692**; FII index options call-long 737,159, put-long 1,122,843, call-short 1,141,437, put-short 456,760. Client (retail) index futures long 307,664 / short 60,271. (Marketcalls notes FIIs have been net short index futures every session since 13 May 2025 — 333+ sessions, a record — and that "FII" mixes long-only funds, hedge funds, arbitrage desks and ETF market-makers, so the long/short ratio is a *composition* measure, not a flow.)

### 2.2 Evidence on predictive power

| Study | Sample | Finding |
|---|---|---|
| Mukherjee & Tiwari 2022, *Asia-Pacific Financial Markets* 29:605–629 | Daily FII net equity/debt flows, NIFTY 50 & BSE 30, Apr 2014–Nov 2019; VAR/Granger | NIFTY returns Granger-cause equity inflows at lags 1–4 (F ≈ 3.6–7.7, mostly 1 %); equity in/outflows Granger-cause NIFTY returns only at lag 1 (F = 2.70 / 2.77, 5 %). Debt flows: no effect on returns. Only F-stats reported — no coefficient, so economic size unknown. Authors: FIIs are positive-feedback traders. |
| Dhingra, Gandhi & Bulsara 2016, *IIMB Management Review* 28(4) | Daily 2004–2012 | FIIs are "return chasers"; feedback trading; FII activity raises NIFTY volatility. (Second-hand summary adds: futures long positions and futures OI show no concurrent relation with NIFTY returns.) |
| Raizada & Nawn 2025, *J. Asset Management* 26(1) | 2003–2019, calendar-time portfolios | Holdings-based FI portfolios: no abnormal return. Trade-based: **stocks FIs bought underperform stocks they sold at every holding period from 1 day to 1 year**; DMA narrows but does not remove it; positive-feedback trading = informational disadvantage. |
| Batra 2003, ICRIER WP 109 | Daily/monthly to 2002 | Strong evidence FIIs chase trends daily (positive feedback); none monthly. |
| Griffin, Nardari & Stulz 2004, *REStat* 86(3) | 9 EMs incl. India, daily 1996–2001 | Net foreign flows rise after high local and world returns; effects "remarkably robust at daily frequency but dissipate quickly". Flows are *pulled* by returns. |
| Richards 2005, *JFQA* 40(1) (6 Asian markets, not India) | Daily aggregate foreign trades | Foreigners buy the day after local or US markets rise; price impact of foreign trading large but contemporaneous. |
| Anil & Jopaul 2026, *Int. J. Research in Management* 16(1) (low-tier journal, Zenodo) | Daily/weekly 2020–2025 | "Statistically significant but economically muted" FPI→NIFTY causality over full sample; weakens substantially post-2023 (DII-dominant); 2025-only window indistinguishable from zero. |
| Thiripalraju & Acharya 2013, *Finance India* (second-hand) | Daily 2000–2009 | Bidirectional causality; shock to returns has longer-lasting effect on flows than vice versa. |

Interpretation for the owner's thesis ("FIIs sold ₹12,988 cr → bearish"): on 8 Oct the sale and the −1.64 % fall are the *same event*, reported after the close. The literature says tomorrow's FII flow is better predicted by today's return than today's return by yesterday's flow; and when FIIs *do* lead, the effect is marginal and unsized. DIIs absorbed 83 % of the FII selling on 8 Oct (10,703 / 12,944), which vendor write-ups (NiftyTrader, no sample size) claim is the "contained-drawdown" regime — unverified.

### 2.3 Practitioner claims found (unverified — treat as hypotheses to test, not signals)

- Marketcalls (Sep 2016–Sep 2026, 2,476 sessions): NIFTY annualised ≈ 6 % after FII net-short index-futures readings vs ≈ 17 % after net-long; 8 of 15 short streaks of 20+ sessions ended higher; after flips from short to net long, NIFTY higher over the next 30 sessions "> 90 % of the time" (no episode count); streaks typically contain a 5–15 % drawdown. Author: "observational, not a statistical test".
- NiftyTrader: FII 5-day buying streaks (2014–2024) continue ~68–72 % of the time with +0.8–1.4 % over the next 5 sessions; no counts, no test; "NSE publishes provisional data typically 6:00–6:30 PM IST".
- Manwire: "> ₹3,000 cr FII selling in a session usually extends to the next session" — assertion, no data (and contradicted by our §4.2 check if it shows reversal).

---

## 3. Options-market signals — detail

### 3.1 Put–call ratio (Jena, Tiwari & Mitra 2019, *Economies* 7(1):24, open access)
- Data: NSE NIFTY index options, daily volume and OI aggregated across expiries and strikes, **1 Jun 2001–16 May 2013**; NIFTY futures volume as control. Mean PCR-OI 1.124, PCR-vol 0.904.
- In-sample frequency-domain Granger causality: **PCR-OI → return significant at 5 % only in the long-run band (ω ≈ 0.51 ≈ 12 days and longer; 10 % at 6–12 days); PCR-vol → return insignificant at all frequencies; "none of these ratios can predict in the short run."**
- Out-of-sample rolling (250-day window): PCR-OI dominates for Jun 2003–Jun 2006 and Dec 2010–Feb 2012; **nothing significant during 2008 or after 2012**; at the 2.5-day band PCR-vol is intermittently significant (incl. 2008). Authors: volume PCR is "short lived and fleeting".
- The paper never states the sign (contrarian vs confirming) — so even the documented effect is unusable as a directional rule without re-estimation.
- Caveat: pre-dates weekly expiries (NIFTY weeklies from Feb 2019) and the 2019–2024 retail-options boom; today's PCR is dominated by weekly contracts and prop/retail writing.

### 3.2 Max pain — folklore
No peer-reviewed Indian test. Broker education pages (Zerodha Varsity, Motilal Oswal, Bajaj) describe it; MarketsEasy's logged 19 expiries found a fixed morning max-pain level predicted the close *less* accurately than assuming no move, with the index drifting away from it more often than toward it. Max pain also moves 100+ points day to day (Varsity comment). Do not use.

### 3.3 OI build-up classification — folklore
Long build-up / short build-up / short covering / long unwinding are definitions, not tested rules. No NIFTY study measuring forward returns by quadrant was found. The one Indian paper cited for "OI predicts next-day close" (Badgi et al., NIFTY near-month options 2014–2020) reports a 99.2 % correlation between the highest-OI strike and the next day's close — a correlation of two price *levels*, which is mechanical, not predictive. Srivastava (NSE WP, 2003) finds OI-based predictors beat volume-based ones for stock options — old, stock-level.

### 3.4 India VIX — magnitude yes, direction no
- Thenmozhi & Chandra, NSE WP/9/2013 (later Chandra & Thenmozhi 2015, *Decision* 42:33–55): NIFTY level vs VIX correlation −0.83; regressing ΔVIX on same-day returns: adj R² 0.105 with positive returns, **0.253 with negative returns** (asymmetry); VIX is a better predictor of realised volatility than GARCH/EGARCH; relation weaker in extreme quantiles.
- Bahadur & Kothari 2016, *IRA-IJMSS* 4(1) (NIFTY daily Mar 2009–Dec 2015, 1,656 obs): VIX correlates 0.741 with the **next** 21-day annualised realised SD (0.769 with the past 21-day); forecasting power better for 21- and 10-day than 5-day horizons; VIX correlates with the share of large *up* days (r = 0.77 for ≥ 2 % up days) at least as much as with large down days — i.e. VIX forecasts *two-sided* movement size.
- No Indian paper tests lagged VIX or ΔVIX as a next-day *direction* predictor. Shaikh & Padhi 2015 (*Borsa Istanbul Rev.*): VIX is an unbiased 30-day realised-vol estimate except in turmoil.
- For a weekly-option buyer: VIX 15.31 ⇒ 1-σ daily move ≈ 15.31 / √252 ≈ 0.96 % (standard conversion; it is a scale, not a forecast). A premium that implies a larger move than VIX-consistent is the thing to avoid; VIX +10 % in a day (8 Oct) means premiums were already repriced for a bigger range.
- Variance risk premium: a 2026 SSRN backtest (Pillai) finds NIFTY VRP-harvesting strategies negative net of Indian costs with tail losses; research summaries report a persistently positive VRP Apr 2021–Jul 2025 (unreviewed). Both point the same way: on average, option buyers pay more than realised movement is worth, so a buyer needs an edge in *direction or timing*, which none of the signals above supply on their own.

---

## 4. Our own checks (reproducible; scripts in `scratchpad/scripts/`)

### 4.1 NIFTY next-day behaviour after large moves (Yahoo `^NSEI` daily closes, 8 Oct 2020–8 Oct 2026, 1,482 returns)
- Daily mean +0.047 %, SD 0.89 %; lag-1 autocorrelation **0.003** (SE ≈ 0.026) — no linear next-day predictability from yesterday's return; last 2 years −0.024.
- Unconditional P(next day up) = 53.8 %.
- After day < −1.0 %: n = 151, next-day mean +0.083 % (t = 0.80), up 51.7 %.
- After day < −1.5 %: n = 64, **+0.290 % (t = 1.88), up 64.1 %**.
- After day < −2.0 %: n = 27, **+0.807 % (t = 3.30), up 74.1 %**.
- After day > +1.0 %: n = 155, +0.210 % (t = 2.56), up 61.9 %; after > +1.5 %: n = 61, +0.14 % (t = 0.87).
- Reading: in this window large down days were followed by bounces more often than by continuation. The sample is small, overlapping with 2020–22 and the Mar 2026 low; it is evidence against a "sell-off → buy puts next morning" rule, not evidence for a "buy calls" rule (the engine's cost per trade exceeds +0.3 % of index in premium terms unless the move comes early in the day).

### 4.2 Does a big FII sell day predict the next day? (NSE provisional cash data — only 29 days obtainable headless)
Attempted a 1 Jan 2025–8 Oct 2026 test, but no key-free source of *historical* NSE provisional FII/DII data was reachable: NSE's API serves the latest day only; Moneycontrol's page embeds only the trailing ~30 sessions (its `?date=` parameter does not return older rows); Mr Chartist's CSV endpoint returned 429; Kaggle needs a login. What we could test (26 Aug–7 Oct 2026, 29 sessions matched to Yahoo closes, a down-trending window: unconditional next-day mean −0.29 %, up 37.9 %):
- corr(FII net_t, NIFTY return_t) = **+0.17** (same day); corr(FII net_t, NIFTY return_t+1) = **−0.09** (next day); OLS next-day return on FII net: −0.16 % per ₹10,000 cr, **t = −0.47, R² 0.008**.
- FII net < −₹5,000 cr (n = 8): same-day −0.70 %, next-day −0.35 %, up 25 % — not distinguishable from the window's own base rate (−0.29 %, 38 %) with n = 8.
- The twelve largest sell days in the window split 6 down / 6 up next day, e.g. 1 Oct 2026 −₹9,484 cr → +0.60 % next day; 30 Sep −₹10,148 cr → −0.88 %.
- Conclusion: **no usable next-day signal at this sample size**, consistent with the literature in §2.2. A proper 5–10-year test needs the NSE/BSE daily FII-DII history (download manually from `nseindia.com/reports/fii-dii` CSV in a browser, or any licensed vendor) joined to NIFTY closes; the script `scratchpad/scripts/fii_test.py` runs unchanged on a longer `fii_dii_daily.json`.

---

## 5. Technical indicators on NIFTY — detail

| Rule | Best test found | Result | Status |
|---|---|---|---|
| Single/dual SMA 5–200 d on NIFTY | Conference paper (Rutgers PBFEA 2005), 1 Jan 1996–31 Dec 2003, costs 0–1 % | MA rules beat buy-and-hold even after 1 % costs; shorter MAs better | Old sample, pre-F&O-era microstructure |
| MA variants on NIFTY 2004–2014 | academia.edu paper | "consistently higher than buy-and-hold"; cost treatment not visible | Unverified |
| 50/200 SMA crossover | Lakshan 2026 (Zenodo), Jan 2010–Jun 2022, 3,077 obs | CAGR 4.01 % vs 9.90 % B&H; vol 12.5 % vs 22.5 %; 11 golden + 11 death crosses; lower Sharpe; "signal always lags price" | Negative |
| 50/200 state → next-day return | emaindicator.com, 15 Feb 2022–6 Oct 2026 | NIFTY golden: +0.024 %/day (n = 779, t = 0.84, 53.5 % up); death: +0.028 % (n = 366, t = 0.56, 49.7 %) | No next-day information |
| Technical indicators, 69 Indian large caps 1999–2004 (cited in Patel 2015, authors truncated) | — | Significant gross returns, **not on a net-of-cost basis** | Negative after costs |
| RSI / MACD optimised, NIFTY-50 stocks Jan 2013–Sep 2018 | Mahajan (SSRN) and similar | Optimised versions beat standard & B&H — in-sample parameter tuning | Unreliable (snooping) |
| Supertrend | arXiv 2405.14262 (Bayesian tuning; NIFTY 50 among assets) | Default parameters: overall loss ~1.16 % across 5 assets; NIFTY 50 min balance −6.6 % | Negative untuned |
| Supertrend, Nifty-500 stocks 2012–2025, ~200k trades | Share.Market quant blog (Feb 2026) | "High win rates are an illusion; most traders lose with the tool" | Practitioner, negative |
| Supertrend (10,3), current NIFTY-50 members since 2014, 0.2 % round-trip | FlashFinance strategy library | 2,075 trades, avg +1.39 %, 34.8 % win rate; survivorship-biased | Practitioner, swing not intraday |
| ADX / DMI, EMA 9/21, Bollinger %B, VWAP bands on NIFTY intraday | none | No Indian academic test; QuantifiedStrategies RSI+ADX results are US | Unproven |
| Opening-range breakout, NIFTY spot 3-min, Jan 2019–Feb 2026, no costs | Zerodha "In the Money" part 1 | 9:15–11:15 range best by return/MaxDD; long win ≈ 60 %, short ≈ 50 %; 10:15 second | Practitioner, uncosted |
| ORB on weekly NIFTY options (premium ≈ ₹200 strike, 9:15–11:15 range on the option's own premium, 20 % SL), Jan 2022–Feb 2026, post-costs, 0.2 % slippage | Zerodha "In the Money" part 2 | **Buying**: win ≈ 48 %, max DD ≈ 45 %, 2025 "rough"; **Selling** the break-down: max DD ≈ 6 %, all years positive; calls smoother than puts either way | Practitioner, costed — closest analogue to the engine |
| Intraday momentum (first ½-hour → last ½-hour) | Gao, Han, Li & Zhou 2018 *JFE* (SPY 1993–2013, R² 1.6 %); 16-market follow-up covers MSCI developed markets only (India absent) | Not tested on NIFTY in any paper found | Untested in India |
| Golden cross etc. on US data | Ready 2002; Sullivan–Timmermann–White 1999 | BLL profits unachievable after slippage / data-snooping | Context |

Implication for the engine: the engine's five-minute stack (RSI, ADX ±DI, EMA 9/21, Supertrend, %B, VWAP) is a *description* of what has already happened on the chart. The only element with a costed NIFTY-options test in its favour is the ORB-style breakout with a hard stop, and even that shows ~48 % wins and a 45 % drawdown for the buyer. A trend-following stack entering after several confirmations is structurally late — consistent with the backtest's 37 % 30-minute hit rate.

---

## 6. "Selling pressure" measures

- **Advance–decline (Patel 2015, NSE monthly Apr 2000–Dec 2013, NSE 500)**: concurrent β 30.51 (t 16.96, adj R² 0.636); previous-month ratio β 3.40 (t 1.16, p 0.248, adj R² 0.002); 3-month and 6-month averages p 0.211 / 0.345. "Advance-decline indicator is not effective in predicting future stock return in the Indian stock market." No daily/intraday Indian test found. Intraday breadth (NSE `allIndices` advances/declines; 8 Oct NIFTY 50 3/47) is a useful *confirmation* that a move is broad, not a forecast.
- **Delivery %**: no index-level evidence; one two-company Granger study (Bajaj Auto: link; BPCL: none). Vendor FAQs themselves say high delivery does not predict direction. Published next day in bhavcopy.
- **FII vs retail positioning**: retail ("Client") 83.6 % long index futures vs FII 8.5 % long on 8 Oct — "most one-sided retail positioning in the dataset" (Marketcalls). No test of contrarian value; SEBI's FY25 study (91 % of individual F&O traders lost; FY26 87.7 %, options ≈ 92 % of losses — secondary reports) shows retail loses on *aggregate* P&L, which is not the same as retail positioning being a usable fade signal day to day.
- **Block / bulk deals**: Indian event studies show abnormal returns concentrated *before* bulk deals (+5–7 % within a week around event, NSE 2010–2019; volume and delivery rise before, fall after) and +1.32 % on BSE block-deal dates 2006–2012 — stock-specific, no index-direction content.

---

## 7. Data sources and timing (what this container can reach without keys, tested 9 Oct 2026 03:20 UTC through the proxy)

| Endpoint | Headers used | Result | Content / timing |
|---|---|---|---|
| `https://www.nseindia.com/api/fiidiiTradeReact` | Chrome UA, Accept */* | **200** | Latest day only (both FII/FPI and DII rows); ignores date params |
| `https://www.nseindia.com/api/allIndices` | same | **200** (114 KB) | All indices incl. INDIA VIX, advances/declines, timestamp "08-Oct-2026 15:30" |
| `https://www.nseindia.com/api/marketStatus` | same | **200** | Market state and last close |
| `https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=13-Oct-2026` | same | **200** | 108 strikes, timestamp 15:40; totals CE OI 3,481,892 / PE OI 2,144,730; CE vol 32.0 m / PE vol 34.0 m. Listed NIFTY expiries: 13-Oct, 19-Oct, 27-Oct, 03-Nov… (weekly expiry now Tuesday). Old `option-chain-indices` endpoint → 404 |
| `https://www.nseindia.com/api/option-chain-contract-info?symbol=NIFTY` | same | 200 | expiry list |
| `https://www.nseindia.com/` (HTML) | same | **403** | API works even though the HTML root is blocked |
| `https://www.nseindia.com/api/historical/indicesHistory?…` | with cookie jar | 200 but returns a challenge HTML page, not JSON | Not usable headless |
| `https://archives.nseindia.com/content/nsccl/fao_participant_oi_DDMMYYYY.csv` | GET | **200** (HEAD → 503) | Published 18:35–19:02 IST on T (Last-Modified) |
| `https://archives.nseindia.com/content/nsccl/fao_participant_vol_DDMMYYYY.csv` | GET | 200 | same evening |
| `https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx` | GET | **200** | Daily Trends table incl. FPI derivative trades |
| `https://www.cdslindia.com/` | GET | 200 | (FPI page not tested) |
| `https://query1/2.finance.yahoo.com/v8/finance/chart/^NSEI?range=6y&interval=1d` | Chrome UA | 429 twice, then **200** on query2 | Rate-limited per IP; daily closes retrieved (span 8 Oct 2020–8 Oct 2026) |
| Moneycontrol `markets/fii-dii-data/cash/` | GET | 200 | Embedded JSON `fiiDiiData` with NSE provisional FII/DII + NIFTY close/prev-close for the trailing ~30 sessions only; `?date=` does not return older rows (no headless history source found) |
| MDPI / ResearchGate / ScienceDirect / Springer article pages | WebFetch | 403 / login | Open-access PDFs reachable via `mdpi-res.com` mirror; NSE research PDFs reachable |

Timing relative to the trading day (IST): index/VIX/option chain — live (NSE API, ~1–3 min lag); breadth — live; NSE provisional FII/DII — ~18:00–18:30 on T (not official; sources range 16:00–21:30); participant-wise OI — 18:35–19:02 on T (observed); NSDL confirmed FPI — T+1 morning; bhavcopy/delivery — evening of T. **Nothing in the flow family is available before the next day's open, and all of it describes T, not T+1.**

---

## 8. How the credible pieces could feed a buy / no-buy / direction decision

The evidence supports *gating*, not *directional* use of these signals:

1. **Expected-move gate (VIX, evidence #1).** Compute the VIX-implied 1-σ daily range (VIX/√252 × spot; 8 Oct: ≈ 0.96 % ≈ 215 pts). A weekly option bought intraday needs a move within the remaining session that beats premium + costs; if the premium paid implies more than ~0.5–0.7 σ of the *remaining-session* range, no-buy. VIX jumps (> +8–10 % on the day) mean premiums already reflect the range — reduce size, do not treat as "bearish".
2. **Post-shock no-chase rule (evidence #2).** After a ≥ 1.5 % index day, do not initiate same-direction option buys at the next open on the strength of "FIIs sold heavily"; our 6-year sample shows next-day reversal more often than continuation. This directly contradicts the owner's inference from 8 Oct.
3. **Flows as context only (evidence #5/#6).** Use NSE provisional FII/DII and participant-wise OI to describe regime (e.g. FIIs extremely net short, retail extremely long), log them in the daily plan, but give them zero weight in the direction score for the next session. If the owner insists on a flow feature, the defensible version is multi-week positioning (FII long ratio, 5-session smoothed) feeding a *risk-budget*, backtested first on the ~10-year participant-OI history (daily CSVs are downloadable; see Marketcalls' untested hit-rates as hypotheses).
4. **PCR (evidence #3/#4).** Documented horizon is 6–12+ trading days and sign is unreported; not a same-day or next-day signal. Drop it from intraday logic or use PCR-OI only as a weekly regime flag after re-estimating sign on post-2019 data.
5. **Breadth (evidence #9).** Intraday advances/declines from `allIndices` can serve as a *confirmation* filter for an already-triggered breakout (broad move = less likely to be a single-stock artefact); it should not generate entries.
6. **Technical stack.** Keep as *state description*; stop using "ADX > 25 + EMA cross + Supertrend flip" as an entry trigger because by the time all agree the move is partly done (37 % 30-minute hit rate). The one tested intraday pattern on NIFTY options is a 9:15–11:15 (or 9:15–10:15) ORB on the option premium with a 20 % stop — and even that is ~48 % win / 45 % DD for the buyer, versus a far smoother curve for the seller on the same signal. The engine's own data is the right place to test: (a) an ORB-only entry with hard stop and time-exit, (b) no entries after 1.5 % gap days in the same direction, (c) VIX-based premium gate.
7. **Folklore to drop from any scoring**: max pain, OI build-up labels, "VIX up = short", "FII sold yesterday = short today", delivery %, block deals, golden/death cross for ≤ 1-week horizons.

---

## 9. Sources

Peer-reviewed / working papers
- Jena, S. K., Tiwari, A. K., Mitra, A. (2019). Put–Call Ratio Volume vs. Open Interest in Predicting Market Return: A Frequency Domain Rolling Causality Analysis. *Economies* 7(1):24. https://doi.org/10.3390/economies7010024 (PDF: https://mdpi-res.com/d_attachment/economies/economies-07-00024/article_deploy/economies-07-00024.pdf)
- Mukherjee, P., Tiwari, S. (2022). Trading Behaviour of Foreign Institutional Investors: Evidence from Indian Stock Markets. *Asia-Pacific Financial Markets* 29(4):605–629. https://pmc.ncbi.nlm.nih.gov/articles/PMC9145119/
- Raizada, G., Nawn, S. (2025). Trade informativeness of foreign investors in India. *Journal of Asset Management* 26(1). https://doi.org/10.1057/s41260-024-00387-8 (abstract via https://ideas.repec.org/a/pal/assmgt/v26y2025i1d10.1057_s41260-024-00387-8.html)
- Dhingra, V. S., Gandhi, S., Bulsara, H. P. (2016). Foreign institutional investments in India: An empirical analysis of dynamic interactions with stock market return and volatility. *IIMB Management Review* 28(4). https://www.sciencedirect.com/science/article/pii/S0970389616300854 (abstract via https://www.iimb.ac.in/imr/previous-issues/foreign-dec-2016.php)
- Thenmozhi, M., Chandra, A. (2013). India Volatility Index (India VIX) and Risk Management in the Indian Stock Market. NSE Working Paper WP/9/2013. https://nsearchives.nseindia.com/research/content/res_WorkingPaper9.pdf ; journal version Chandra & Thenmozhi (2015) *Decision* 42:33–55, https://doi.org/10.1007/s40622-014-0070-0
- Bahadur G. C., S., Kothari, R. (2016). The Forecasting Power of the Volatility Index: Evidence from the Indian Stock Market. *IRA-IJMSS* 4(1). https://doi.org/10.21013/jmss.v4.n1.p21
- Shaikh, I., Padhi, P. (2015). The implied volatility index: Is "investor fear gauge" or "forward-looking"? *Borsa Istanbul Review* 15(1). https://doaj.org/article/dccef504e7114fbfb1e43c2f35382863
- Patel, J. B. (2015). An Analysis of the Advance-Decline Indicator in the Indian Stock Market. *Journal of Finance Issues*, Spring 2015. https://jfi-aof.org/index.php/jfi/article/download/2291/1863/7356
- Batra, A. (2003). The Dynamics of Foreign Portfolio Inflows and Equity Returns in India. ICRIER WP 109. https://www.icrier.org/pdf/wp109.pdf
- Griffin, J. M., Nardari, F., Stulz, R. M. (2004). Are Daily Cross-Border Equity Flows Pushed or Pulled? *Review of Economics and Statistics* 86(3):641–657. https://ideas.repec.org/a/tpr/restat/v86y2004i3p641-657.html
- Richards, A. (2005). Big Fish in Small Ponds. *JFQA* 40(1); RBA RDP 2004-05. https://www.rba.gov.au/publications/rdp/2004/2004-05.html
- Anil, N., Jopaul, A. V P (2026). Record FPI Equity Outflows … Evidence from Granger Causality and Panel Regressions. *Int. J. Research in Management* 16(1). https://zenodo.org/records/18758481
- Lakshan, A. (2026). Trend-Following Signals in an Emerging Market Index: A Moving-Average Crossover Analysis of the Nifty 50 (2010–2022). https://zenodo.org/records/21308597
- Gao, L., Han, Y., Li, S. Z., Zhou, G. (2018). Market intraday momentum. *JFE* 129(2). https://www.sciencedirect.com/science/article/abs/pii/S0304405X18301351 ; global follow-up (16 MSCI developed markets, India absent): https://centaur.reading.ac.uk/95566/1/Accepted-Version.pdf
- Baltussen, Da, Lammers, Martens (2021). Hedging demand and market intraday momentum. *JFE*. (not India)
- Ready, M. (2002). Profits from Technical Trading Rules. https://papers.ssrn.com/sol3/papers.cfm?abstract_id=64168
- Supertrend parameter study: https://arxiv.org/pdf/2405.14262
- Mahajan, Y. Optimization of MACD and RSI Indicators: An Empirical Study of Indian Equity Market. SSRN 3697734.
- Pillai, S. (2026). Trading the Volatility Risk Premium on Nifty 50: Strategy Backtest with Realistic Frictions. SSRN 6876580.
- Srivastava, S. (2003). Informational Content of Trading Volume and Open Interest — Stock Option Market in India. NSE WP. https://www.ssrn.com/abstract=606121
- NSE MA study 1996–2003 (Rutgers PBFEA 2005 conference): http://www.centerforpbbefr.rutgers.edu/2005/Paper%202005/PBFEA037.doc
- Bulk/block-deal event studies: IIM Calcutta WP 863 https://studentlive.iimcal.ac.in/sites/all/files/pdfs/wp_863.pdf ; Emerald *Managerial Finance* 2022 https://emerald.com/insight/content/doi/10.1108/MF-08-2021-0374/full/pdf ; IUP 2015 block deals https://www.iupindia.in/1507/Applied%20Finance/Price_Impact_of_Block.html
- Thiripalraju & Acharya (2013), *Finance India* (second-hand via search).

Official data pages
- NSE FII/DII report page: https://www.nseindia.com/reports/fii-dii ; API: https://www.nseindia.com/api/fiidiiTradeReact
- NSE participant-wise OI: https://archives.nseindia.com/content/nsccl/fao_participant_oi_08102026.csv
- NSE all indices / VIX: https://www.nseindia.com/api/allIndices ; option chain: https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=13-Oct-2026
- NSDL FPI daily trends: https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx ; SEBI FPI statistics (daily dissemination since 1 Jun 2014): https://www.sebi.gov.in/statistics/fpi-investment/latest.html
- NSE EOD F&O file schedule (old, lists fao_participant_oi): https://archives.nseindia.com/content/press/EOD_FAO.pdf

Practitioner / press (used only for stated-rule backtests or data claims; flagged as such above)
- Zerodha "In the Money" ORB part 1: https://inthemoneybyzerodha.substack.com/p/all-about-opening-range-breakout ; part 2 (options, costed): https://inthemoneybyzerodha.substack.com/p/how-to-trade-opening-range-breakout
- Marketcalls, FII index-futures shorts (Sep 2016–Sep 2026): https://www.marketcalls.in/futures-and-options/what-do-we-actually-know-about-fii-index-futures-shorts.html
- emaindicator.com NIFTY 50/200 SMA state stats (2022–2026): https://emaindicator.com/sma-50-200-crossover/
- NiftyTrader FII/DII guide (timing, streak claims): https://www.niftytrader.in/markets/how-to-read-fii-dii-data-report-guide/
- Moneycontrol FII/DII FAQ (timing 16:00–17:30 claim; data pages): https://www.moneycontrol.com/markets/fii-dii-data/cash/
- MarketsEasy max-pain check (19 expiries): https://marketseasy.in/learn/max-pain ; Zerodha Varsity max pain/PCR: https://zerodha.com/varsity/chapter/max-pain-pcr-ratio/
- Share.Market Supertrend 200k-trade test: https://www.share.market/buzz/insights/i-backtested-200000-trades-using-the-supertrend-indicator-here-is-what-actually-works
- FlashFinance strategy library (Supertrend 10,3 with 0.2 % costs): https://flashfinance.news/strategy-library/
- SEBI F&O loss studies (secondary reports): https://www.business-standard.com/markets/capital-market-news/sebi-sees-dip-in-derivatives-turnover-91-of-retail-traders-lose-money-in-fy25-125070800660_1.html ; https://www.outlookmoney.com/invest/nearly-88-of-retail-derivatives-traders-incur-losses-even-as-participation-cools-says-sebi-study
- Leap Blog on 2026 FPI outflows (stall, not reversal): https://blog.theleapjournal.org/2026/08/foreign-equity-investment-in-india.html

Our data
- Yahoo Finance `^NSEI` daily closes (fetched 9 Oct 2026): `scratchpad/dl/nsei.json`; script `scratchpad/scripts/nifty_stats.py`.
- NSE provisional FII/DII per day via Moneycontrol embedded JSON (fetched 9 Oct 2026; only the trailing 30 sessions are served): `scratchpad/fiidata/fii_dii_daily.json`; scripts `scratchpad/scripts/scrape_fii.py` (collector) and `scratchpad/scripts/fii_test.py` (test; re-runnable on a longer file).
