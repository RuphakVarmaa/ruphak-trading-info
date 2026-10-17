# PLAN — proven algorithms, honest evaluation (NIFTY/SENSEX weekly-options paper engine)

Prepared Fri 9 Oct 2026 (~09:40 IST). Repo `ruphak-trading-info`, branch `claude/gifted-wright-3d8r3j`, HEAD `9a80d7b`. Tree untouched (planning only). Everything below was reproduced locally from the saved snapshot `scratchpad/why/hist.json` (each replay ≈ 30 s) plus public data fetched today; scripts and outputs are in `scratchpad/why/` and `scratchpad/dl/`.

Hard rules kept throughout: engine stays PAPER; no deploys 08:45–15:30 IST (today anything validated ships after 15:30); no loosening of checks/stops/caps without walk-forward evidence; no API keys; no invented data; ₹5k/₹10k accounts BUY only.

---

## 0. TL;DR

1. **The current strategy is statistically indistinguishable from random entry.** 51 trades, net −₹9,596, mean −₹188/trade (SE ≈ ₹305). A 3,000-draw random-entry placebo through the engine's own pricer, fill model, charges and exit rules loses **−₹402/trade (SE ₹33)**. The strategy is +₹214 better than random — 0.7 standard errors. Zero edge + theta + spread + charges = what we see.
2. **Three real defects found in code/data, all fixable as tightenings:** (a) the last 15 minutes of Yahoo's NIFTY/SENSEX bars are closing-auction artefacts (NIFTY 15:15/15:20 bars are flat on 37/46 of 59 sessions; SENSEX 15:20 bars swing ±1% with NIFTY at 0.00%) and they feed the next morning's RSI/ADX/Supertrend/Bollinger/ATR-percentile/prev-day-H-L — `clipWicks` only clips wicks, not a bad close; (b) the edge gate forecasts a signed move of 0.27% per trade while realized is −0.02% (OLS slope of realized on expected = −1.0) and VIX×1.1 overstates intraday realized σ by 2.4×, so the "edge after theta and costs" gate passes trades that have none; (c) there is no random-entry placebo and no bootstrap/deflation in the evaluation tooling.
3. **What the literature says:** intraday index predictability is real but tiny (R² 1–3%, ~5–10 bps/day) and only exploitable at ETF/futures costs; option buyers pay a variance risk premium (in India it is earned by sellers *overnight*, intraday long-option returns are ≈ 0 and insignificant: Bhat–Pandey–Rao 2024); SEBI's own FY26 study: 87.7% of individual F&O traders lose, 92% of losses come from options, 97% of individuals are predominantly option buyers, 99% of institutional profits are algorithmic. Our structure — discretionary-style 5-minute directional option buying copied by hand — is the weakest documented structure.
4. **Shortlist (evidence × fit):** (A) Zarattini–Aziz–Barbon "noise-area" intraday momentum (SPY, Sharpe 1.33 net, in-sample only) implemented *exactly as published* with ATM options; (D) a published volatility-forecast gate (HAR-RV, Corsi 2009, vs India VIX) as a tightening; (B) the 5-minute ORB (Zarattini–Aziz 2023) exactly as published, low expectation (independent replication: net ≈ 0 on indices); (E, main-only research) overnight defined-risk short premium, the only structure with positive expectancy evidence in India, but needs margin/overnight/short legs so it cannot touch the small accounts. Last-half-hour momentum (Gao 2018 / Baltussen 2021) was tested on 718 NIFTY sessions: **reversal** (t = −3.6), and NSE's closing auction since 3 Aug 2026 makes the last 15 minutes untradeable for an options copier — rejected, documented.
5. **Expectation:** most likely nothing passes the acceptance bar for the buy-only small accounts this quarter; the deliverables that will certainly pay are the evaluation harness, the data cleaning, real option prices from the exchange archives (available without keys, 3+ years), and an honest number for the owner. Real money should not be copied until a variant clears §5 on ≥ 180 out-of-sample trades.

---

## 1. Diagnosis (reproduced today)

### 1.1 Baseline and quick variants (snapshot replay, 23 Jul–8 Oct 2026, 54 sessions, no events, production limits)

| run | trades | hit | net ₹ | PF | note |
|---|---|---|---|---|---|
| baseline (`--prod-limits`) | 51 | 33% | **−9,596** | 0.79 | identical to `bt-main.json` |
| `--max-open-total 1` (one bet across both indices) | 42 | 36% | −10,983 | 0.67 | the removed trades were the net winners |
| `--index NIFTY` | 31 | 35% | −15,793 | 0.53 | NIFTY's "+₹2,004" in the joint run is noise |
| `--index SENSEX` | 27 | 26% | −14,984 | 0.50 | |
| `--kem 0.5` | 36 | 28% | −10,176 | 0.64 | honest-er gate, still negative |
| walk-forward 42/14 (3 folds, existing 12-point grid) | see §1.5 | | | | |

Every slice is negative; the between-run spread (−₹9.6k … −₹15.8k) is itself a warning about how noisy 30–50 trades are.

### 1.2 Random-entry placebo — what zero edge costs (new, `scratchpad/why/random_baseline.ts`)

Random day/time (09:25–14:30 grid)/index/side, ATM strike of the nearest weekly not expiring today, main-account sizing, the engine's `syntheticQuote`, `marketFill`, `computeCharges`, `evaluateExits`/`markPosition`, 5-minute checks with the 90 s lag.

| exits | n | mean net ₹/trade | SE | hit | PF | gross | charges | by exit (avg ₹) |
|---|---|---|---|---|---|---|---|---|
| stop −30 / target +50 / 90-min time stop (main) seed 7 | 3000 | **−402** | 33 | 35% | 0.54 | −334 | 69 | TIME_STOP 2010 (−633), STOP 250 (−3,188), TARGET 143 (+4,911), TRAIL 108 (+1,324), SQUARE_OFF 489 (+33) |
| same, seed 11 | 3000 | −386 | 33 | 35% | 0.55 | | | |
| stop −35 / target +60 (follower exits) | 3000 | −390 | 31 | 35% | 0.53 | | | |
| 45-min time stop | 3000 | −295 | 24 | 37% | 0.52 | −226 | 69 | |

Reading: theta + half-spreads + 2-tick slippage on an ATM weekly held ~90 minutes costs ≈ ₹330 before charges (NIFTY ATM ≈ ₹137 × 65, SENSEX ≈ ₹447 × 20), charges ≈ ₹69. **Any entry rule must earn > ₹400/trade of directional P&L just to break even**; the current rule earns ≈ ₹214 ± 305. Shortening the hold to 45 min cuts the drag to ₹295 — relevant for §4.

### 1.3 Root causes, ranked by evidence

1. **No directional edge at the 15–120 min horizon (strongest evidence).** Direction right 37% after 15/30 min, 51–53% at 60 min/exit; realized signed move at the planned horizon averages −0.018% vs the gate's expected +0.267%; OLS slope of realized on expected = −1.02; the |conviction| buckets show no monotone relation (0.60–0.70: 88% right, n = 16; 0.70+: 30%, n = 10). The 5-minute MOMENTUM/ORB/GAP/GLOBAL_BETA/RV combination is, on this sample, noise with a slight tendency to chase.
2. **Edge gate miscalibrated (code, `src/engine/strategy/gates.ts:105-127`, `config.ts gates.kEM=1.0, intradayVolFactor=1.1`).** Implied 1σ over the horizon averaged 0.439%; realized |move| averaged 0.182% (ratio 0.41). The gate therefore (i) assumes 2.4× too much realized movement and (ii) multiplies it by |score| with kEM = 1 although the realized β is ≈ 0. With honest inputs the gate would block essentially every trade — which is the honest conclusion, not a bug to paper over. Fix as a tightening behind a flag (WP2).
3. **Closing-auction bars pollute features (data + code, `src/engine/market/features.ts:118-188`).** Per-slot NIFTY/SENSEX 5-min return correlation is 0.93–0.99 from 09:20 to 15:10 and collapses at 15:15 (0.06), 15:20 (0.02; SENSEX σ 0.281% vs NIFTY 0.021%) and 15:25 (−0.01); excluding those three slots the correlation is 0.965 — the "0.68" is entirely a last-15-minute artefact, not an alignment bug. Cause: NSE's Closing Auction Session (from 3 Aug 2026: continuous trading in F&O stocks ends 15:15, auction to 15:35, derivatives trade to 15:40) and BSE's equivalent — Yahoo's NIFTY bars go flat at 15:15/15:20 and the whole closing move lands in the 15:25 bar (causal check: before 3 Aug, 0 of 12 NIFTY 15:15 and 15:20 bars are flat; from 3 Aug, 37 of 47 and 46 of 46 are); Yahoo's SENSEX prints swing wildly (10 Sep 15:20 +1.26% then 15:25 −0.90%). Since no entries happen after 14:30 and square-off is 15:05, the direct damage is to the **next morning**: `INDICATOR_BARS = 120` cross-session bars feed RSI/ADX/Supertrend/Bollinger; `prevDayHigh/Low`, `atrPctile20d` history, divergence spreads and `realizedVol20d` all consume the 15:15–15:25 bars; `clipWicks` (MAX_WICK_PCT 0.3) clips wicks only, so a bad *close* passes through (e.g. SENSEX 10 Sep 15:20 close 75,578 on a 74,630 open). The SENSEX daily close equals its last 5-min close (mean |dev| 0.001%), so the bars are "real" auction prints, not feed errors — they are simply not tradeable prices and must not drive indicators.
4. **Costs and holding time.** TIME_STOP is 24 of 51 exits (−₹6,383) and 23 trades never reached +5%; the random placebo says a 90-min hold of an ATM weekly costs ≈ ₹400 regardless of signal. Charges are ₹69/trade (STT on sell now 0.15%).
5. **Correlated double bets** (9 NIFTY+SENSEX same-direction pairs within 10 min, −₹5,073) and the 11:00–12:59 window (6/6 losers) are real in-sample patterns but, at n ≤ 9, not evidence. `--max-open-total 1` made things worse. Treat as hypotheses only.

### 1.4 Look-ahead / lag audit of the backtest (code read, no defect found)

- `ReplayMarketDataSource.snapshotSync` exposes a 5-min bar only when `bar.t + 5m ≤ t − lagMs` (90 s); the loop decides at 09:16:30, 09:21:30, …; `ltp` = last visible close; daily bars only for prior IST dates after `dailyFinalAfterMs`. Features use `closed` bars only. No look-ahead found.
- Fills are priced off the spot of the bar that closed 90 s earlier and the synthetic quote at `t`; no post-signal drift and no copy delay are modelled. The human copier adds 30–90 s on top of Yahoo's 90 s: **the backtest fill is ~2–3 minutes staler than reality.** The evaluation protocol (§5) adds a copy-delay penalty (fill off the *next* bar's close) — the direction-accuracy numbers (37% right at 15 min) say this penalty will usually be adverse.
- Ordering: in the backtest entries run before the position pass at the same `t`; in production `mainExitsFirst` runs main's exits right after main's entries too — consistent.
- Synthetic options: Black–Scholes on India VIX × {1.00, 1.05}, no skew, flat spread model (max(1 tick, 0.4% of mid)), 2-tick market slippage. Real weekly ATM spreads on Groww are typically 1–3 ticks on NIFTY, wider on SENSEX; real IV ≠ VIX. §4 (WP6) calibrates this against exchange EOD prices.

### 1.5 Walk-forward (existing tooling, 42/14-day folds, 12-point grid over gain × threshold × min-edge)

| fold (test window) | chosen in-sample | OOS trades | OOS net ₹ |
|---|---|---|---|
| 3–16 Sep | gain 1.2, thr −0.05, edge 0.10 | 19 | −1,989 |
| 17–30 Sep | gain 1.5, thr +0, edge 0.10 | 13 | −5,955 |
| 1–8 Oct | gain 1.5, thr +0.05, edge 0.10 | 8 | +6,382 |
| **pooled OOS** | | **40** | **−1,562** (hit 37.5%, PF 0.94, Sharpe −0.25, maxDD 2.75%) |

The pooled OOS is negative and is carried entirely by one 8-trade fold; two of three folds chose a *looser* threshold in-sample (−0.05) — exactly what rule 3 forbids shipping. Fitting on 42-day windows with 10–20 trades each cannot select anything.

---

## 2. What the literature says about our current approach

| claim | source (primary, verified today) | what it means for us |
|---|---|---|
| Intraday index predictability exists but is small: first-half-hour return predicts the last half hour, R² 1.6% in-sample, 1.7% OOS; timing strategy 6.7%/yr, Sharpe 1.08, success 54.4% vs 50.4% unconditional; costs estimated < 3.8%/yr at ETF spreads | Gao, Han, Li, Zhou, *JFE* 130 (2018) 394–414 (working-paper PDF read) | The best-documented intraday effect is worth ~5–10 bps/day. An ATM weekly option round trip costs 30–60 bps of notional (theta+spread+charges). Not an options trade. |
| The effect generalises to 60+ futures 1974–2020 (Sharpe 0.87–1.73 by asset class), driven by gamma hedging; **"we do not consider transaction costs"**; India not in the sample (Nikkei-SGX is) | Baltussen, Da, Lammers, Martens, *JFE* 142 (2021) 377–403 (PDF read) | Mechanism (dealer gamma) is plausible in India's 0DTE-heavy market, but the paper itself says frequent rebalancing may make it unexploitable after costs. |
| In 16 *developed* markets it holds in- and out-of-sample, stronger in low liquidity / high vol | Li, Sakkas, Urquhart, *J. Financial Markets* 57 (2022) 100619 | India not covered. |
| In APAC it is "not as pervasive as the US": present in China and Japan, weak in Korea, absent in Hong Kong and Singapore | Limkriangkrai, Chai, Zheng, *Pacific-Basin Finance J.* 80 (2023) 102086 (PDF read) | Must be tested per market. Our test (§3, C): NIFTY shows the *opposite* sign. |
| Index option buyers pay a variance risk premium: ATM zero-beta straddles lose ≈ 3%/week; delta-hedged long options underperform | Coval & Shumway, *JF* 56 (2001); Bakshi & Kapadia, *RFS* 16 (2003) 527–566 | Buying premium is negative-carry on average. |
| The premium is earned **overnight**: S&P delta-hedged option returns −1%/day close-to-open, **+0.3%/day open-to-close** | Muravyev & Ni, *JFE* 136 (2020) 219–238 | Intraday long-option positions are not doomed by the VRP… |
| …and the same asymmetry holds for **NIFTY options (NSE, 2017–2020)**: short-option returns positive and significant overnight, **negative and insignificant intraday**; weaker on jump days | Bhat, Pandey, Rao, *J. Futures Markets* 44 (2024) 1320–1337 | …so intraday buying has ≈ zero expected gross return in India; spread, charges, copy slippage and a non-predictive direction signal make it negative. Sellers' edge is overnight (main-only research track E). |
| Variance risk is priced in India despite retail dominance; continuous (not jump) variance forecasts variance-swap returns | Sankar, Ramachandran, Lukose, *Int. Rev. Econ. & Finance* 70 (2020) 321–334 | Supports a realized-vs-implied gate (D) and track E. |
| HAR-RV: daily/weekly/monthly realized-vol components forecast RV well out of sample; applied to NIFTY by Kumar (2010); India VIX vs realized vol studied by Banerjee & Kumar (IIMC WPS 688, 2011) | Corsi, *J. Financial Econometrics* 7 (2009) 174–196 | The published model for a "buy only when options are cheap" gate. |
| Retail: FY26 87.7% of individual F&O traders had net losses (90.9% FY25; 93% FY22–24); net losses ₹91,685 cr (₹1.12 lakh cr FY25); options = 92% of losses; 93% of individuals trade only options; 59% of index-option turnover is 0DTE, 75% ≤ 1DTE; 99% of FPI/prop profits come from algo entities; separate behaviour study: ~97% predominantly option buyers | SEBI DEPA, "Profits and Losses of Individuals in the EDS, FY25–FY26" (Aug 2026, PDF read: `scratchpad/dl/pdf/sebi_aug2026.txt`); SEBI Sept 2024 study | The population doing what our engine does loses with ~90% probability; the counterparties are algorithmic prop desks. |
| Retail 0DTE buyers in the US lost ≈ $358k/day since daily expiries began | Beckmeyer, Branger, Gayda (2023, SSRN 4404704) | Same structure, same outcome. |
| Opening-range breakout on QQQ: hit 24%, +0.13R/trade, 33%/yr at 4× leverage, commissions only, no OOS; independent replication on 5 index CFDs 2015–2026: gross reproduced on NQ (+0.131R), **net ≈ 0, four of five negative** | Zarattini & Aziz 2023 (SSRN 4416622); MQL5 replication (non-peer-reviewed) | Our ORB signal (ORB NIFTY 11% hit, −₹6,973) is consistent with "no net edge on indices". |
| "Beat the Market" noise-area momentum on SPY 2007–early 2024: base rule 6.2%/yr, Sharpe 0.61, hit 54%; with VWAP trailing stop 9.7%/yr, Sharpe 1.24, hit 43%, MDD 12%; with vol-targeted sizing 19.6%/yr, Sharpe 1.33, MDD 25%; 7,668 trades (1.8/day); +12 bps/day unconditional (t 5.34); costs $0.0035/share + $0.001 slippage; **no out-of-sample section**; an independent TradingView implementation reports "returns smaller, Sharpe very low" | Zarattini, Aziz, Barbon, SFI WP 24-97 (2024/25, SSRN 4824172) (PDF read) | The most implementable candidate, but author-published, in-sample, ETF costs. Must be tested as published. |

Bottom line: the literature gives **no example** of a profitable retail intraday *directional option-buying* system on index weeklies; it gives a small, cost-sensitive intraday momentum effect on futures/ETFs and a sellers' premium earned overnight.

---

## 3. Candidate published strategies — record and fit

Constraints for "fit": ₹5k/₹10k BUY only (one lot, premium band); main ₹5L paper may test defined-risk spreads; manual copy 30–90 s; Yahoo 5m ≈ 60 d, 15m ≈ 60 d, 1h ≈ 730 d (verified today: 1,476 15-min bars, 723 hourly sessions), daily years; NSE/BSE EOD option bhavcopies (verified, §4); no Groww keys.

### A. Noise-area intraday momentum (Zarattini–Aziz–Barbon 2024/25) — **rank 1**
- Rules (exact, from the paper): for each time-of-day HH:MM, σ_t,HH:MM = mean over the previous 14 sessions of |Close_{t−i,HH:MM}/Open_{t−i,open} − 1|. Upper = max(Open_t, Close_{t−1}) × (1 + VM·σ), Lower = min(Open_t, Close_{t−1}) × (1 − VM·σ), VM = 1. Decisions only at HH:00 and HH:30; long when price is above Upper, short when below Lower; exit at the close or on a crossover to the opposite band (base), refined stop = max(UpperBand, VWAP) for longs / min(LowerBand, VWAP) for shorts, checked only at the half-hours; size = AUM × min(4, 2%/σ_14d-daily)/Open.
- Evidence: in-sample 2007–early 2024, ETF costs; no OOS; weaker independent replication. Peer status: SFI working paper (4th, Quantpedia Awards 2025).
- Adaptation forced by our instrument: long → BUY ATM CE, short → BUY ATM PE (nearest weekly not expiring today); stops are **index-level** (band/VWAP), evaluated on closed 5-min bars at HH:00/HH:30 (IST: 09:30, 10:00, … 14:30), exit at 15:05 (our square-off) — the paper exits at the close; our data after 15:15 is auction noise, so 15:05 is the honest close; vol-target sizing maps to lots (main) and is moot for one-lot accounts; premium stop −30% kept only as a disaster stop (tightening, never loosened). Both indices allowed, but one position per index (current limits).
- Why it fits: half-hourly decisions suit manual copying; stops are on the index, so the copier's premium slippage does not change the rule; the band needs only 14 sessions of 5-min bars (we have 59, plus 723 sessions hourly for a coarse version).
- Expected effect (honest): the paper's +12 bps/day on SPY ≈ 30 NIFTY points/day ≈ ₹975/day per lot at delta 0.5 against ≈ ₹720/day of option drag at 1.8 trades/day — marginal even if the effect transfers intact. Overfit risk: low if VM = 1, 14 days, HH:00/HH:30 are frozen as published; the "VWAP stop" and "vol sizing" variants are the authors' in-sample refinements — test base first, refinements second, count all as trials.
- Test: WP3; 5-min full-fidelity on 54 sessions (underpowered), hourly approximation on 723 sessions (decisions hourly, bands from hourly closes; flagged as approximation), placebo, perturbation, copy delay.

### D. Volatility-cheapness gate: HAR-RV forecast vs India VIX (Corsi 2009; Sankar 2020; Bhat 2024) — **rank 2 (as a tightening on A and on the current engine)**
- Rule: fit HAR-RV (OLS: RV_{t+1} on RV_t, mean RV_{t−4..t}, mean RV_{t−21..t}) on daily realized variance built from 5-min bars (60 d) or, for 2 years, hourly bars / Parkinson range from daily OHLC; buy options only when forecast RV_{next session} ≥ k × VIX-implied daily variance with k = 1 (no tuning; report k ∈ {0.8, 1.0, 1.2} as perturbation). Everything else unchanged.
- Evidence: HAR is the standard RV forecaster; VRP positive on average in India → on average options are rich; the gate buys only on the days the model says they are not.
- Fit: perfect (pure filter; fewer trades). Expected effect: removes maybe half the trades; the remaining trades' theta drag is unchanged, so this cannot create edge, only reduce negative carry. Overfit risk: low (one published model, one parameter fixed at 1).

### B. 5-minute opening-range breakout (Zarattini–Aziz 2023) — **rank 3, low expectation**
- Rules (exact): direction of the first 5-min candle (09:15–09:20); enter at the open of the second candle; stop at the opposite extreme of the first candle; target 10R; otherwise exit at the close; risk 1% of equity per trade; 4× leverage cap; doji → no trade.
- Evidence: author-published, QQQ 2016–2023, commissions only, no OOS; replication net ≈ 0 on five index CFDs.
- Adaptation: BUY ATM CE/PE at the 09:21:30 decision (first bar visible), index-level stop at the first candle's extreme (typically 0.1–0.2%, i.e. 25–50 NIFTY points — with a 90 s feed lag plus 30–90 s copy delay this stop will be honoured late; that is a feature of the test, not something to loosen), target 10R on the index, exit 15:05. Expected: hit rate ≈ 20–25%, most days a small loss plus ₹400 of option drag; a few 10R days. Fit: moderate mechanically, poor economically. Cheap to test because the engine already has opening-range features (`features.openingRange`, `openingRangeMin` = 15 → the published rule needs 5).

### C. Last-half-hour intraday momentum (Gao 2018; Baltussen 2021; Li 2022) — **tested and rejected for this instrument**
- Our test (`scratchpad/why/itsm_check.py`, Yahoo hourly, 31 Oct 2023–8 Oct 2026, 718 sessions): NIFTY — Gao rule sign agreement 46.4% (t −0.47); Baltussen rule (prev close → 15:15 predicts 15:15 → close) r = **−0.133, t = −3.60: reversal**; timing strategy −0.005%/day. SENSEX — Gao r = +0.125 (t 3.37) but the timing strategy earns +0.003%/day (t 1.28) ≈ 0.75%/yr before costs. 5-min data (57 sessions): sign agreement 39–47%.
- Mechanics kill it regardless: since 3 Aug 2026 NSE's continuous session for F&O stocks ends 15:15 and the index close is auction-determined (derivatives trade to 15:40); the "last half hour" is no longer a continuous market; the expected move (≈ 0.03–0.05%) is below the option break-even (≈ 9 NIFTY points ≈ 0.04%). Not implementable for a buy-only, hand-copied options account. Could only be a futures paper study, which the engine does not do. Documented; no work package.

### E. Overnight defined-risk short premium (Bhat 2024; Muravyev–Ni 2020; Coval–Shumway 2001; Sankar 2020) — **research only, main ₹5L paper, not for small accounts**
- Rule to test as published: sell the ATM straddle (with protective wings ±2–3 strikes → iron fly, defined risk) at the close (15:00–15:05), cover at the next open (09:20); size so the max loss ≤ 2% of capital; never hold through RBI/FOMC/budget (calendar gate exists).
- Evidence: the only structure with positive-expectancy evidence *in India* (Bhat 2024) and in the US; SEBI FY26: loss incidence among sellers is far lower than among buyers, but sellers' losses are large when they occur.
- Fit: requires short legs, margin, overnight holding — none of which the engine, the small accounts (rule 6) or the current square-off design support. Deliverable is an EOD backtest on real bhavcopy prices (close → next-day open per contract, real settlement prices, margin from BSE/NSE SPAN approximations) and a go/no-go for a later engine extension. Explicitly flagged tail risk (gap-up/gap-down beyond the wings) and the fact that bhavcopy "close" is a last-30-min weighted price, not a tradeable 15:05 quote.

### Rejected at search stage
Expiry-day "pinning" and day-of-week effects on NIFTY (IIMB 2006–2010; Singh & Shaik 2020): descriptive, no net-of-cost tradeable rule. Blog/YouTube systems: skipped per instruction.

---

## 4. Data plan (all verified reachable from this environment today)

| source | what | depth | status / use |
|---|---|---|---|
| Yahoo `^NSEI ^BSESN ^NSEBANK ^INDIAVIX` 5m | 60 d | 59 sessions in snapshot | full-fidelity backtests; **archive nightly from now** (WP1: `scripts/fetch-history.ts --save` into `.cache/history/yahoo-5m-YYYYMMDD.json`; 60-day rolling window means every day not saved is lost) |
| Yahoo 15m | 60 d (1,476 bars) | fetched | no extra depth; skip |
| Yahoo 1h | 730 d (723 sessions, incl. VIX, SENSEX, BANKNIFTY) | fetched to `scratchpad/dl/y1h/` | coarse replays of A/D over 2 years; HAR-RV from hourly RV |
| Yahoo daily | 2 y in snapshot (longer available) | in snapshot | HAR-RV (Parkinson/close-to-close), VRP series |
| NSE F&O bhavcopy, new format `nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip` | every NIFTY/BANKNIFTY option: open/high/low/close/settle/OI/volume/underlying, ~35k rows, ~1 MB/day | works from 2024-01-08 (404 for 2023-07); old format `content/historical/DERIVATIVES/YYYY/MON/foDDMONYYYYbhav.csv.zip` works for 2023-07 and 2024-01 | **real EOD option prices, 3+ years, no key** (WP6) |
| BSE derivatives bhavcopy `bseindia.com/download/Bhavcopy/Derivative/bhavcopyDD-MM-YY.zip` (needs a `Referer` header) | SENSEX weekly options OHLC/OI/volume (656 rows on 7 Oct 2026) | works for 2023-07, 2024-07, 2025-01, 2026-10 | same for SENSEX |
| NSE option-chain API | — | 404 (needs cookies) | not used |
| scored news | none historical | — | EVENT stays out of all backtests |

Cleaning rules (WP1): (1) feature histories exclude bars with open time ≥ 15:15 IST on and after 3 Aug 2026 (closing auction) — and, for safety, on all days — for RSI/ADX/Supertrend/Bollinger/ATR-percentile/divergence/prev-day H-L; (2) previous close = the official daily close (equal to the last 5-min close) — unchanged; (3) the `MAX_WICK_PCT` clip stays; add a body clip for a 5-min bar whose |close/open − 1| > 0.6% while the other index moved < 0.1% in the same bar, logged, never silently; (4) `dataAgeSec`/entry window unchanged (entries end 14:30, exits 15:05).

Sample-size arithmetic (per-trade σ ≈ ₹1,800–2,200 for both the strategy and the placebo): to show a true mean of +₹300/trade at 2 SE needs n ≈ (2·2,000/300)² ≈ **180 trades**; +₹150/trade needs ≈ 710; at ≈ 1 trade/day that is 180–700 sessions. We have 54 (5-min) and 723 (hourly). Hence: full-fidelity 5-min runs are exploratory until ≥ 6 months of archived 5-min data exist; the hourly 2-year replay and the bhavcopy EOD tests carry the statistical weight now.

---

## 5. Evaluation protocol and acceptance criteria (a variant must pass ALL before it may be enabled on any paper account)

Implemented in WP0; every criterion printed by `npm run backtest -- … --protocol`.

1. **Published parameters frozen.** No parameter of a published rule is fitted on our data. Any deviation is a separate variant and counts as a trial.
2. **Out-of-sample only.** Frozen-parameter rules: the whole sample is OOS. Anything fitted: walk-forward, 42-day train / 14-day test, pooled OOS trades only.
3. **Minimum sample:** ≥ 180 OOS trades (or ≥ 120 OOS sessions with the 2-year hourly replay). Below that the verdict is "insufficient", never "pass".
4. **Costs:** charges (dated schedule), spread model, 2-tick market slippage, **plus the copy-delay penalty**: entry priced off the spot of the *next* closed 5-min bar (≈ +5 min) and +2 extra ticks each side; exits likewise except stops (which the human may also execute late — model at +5 min).
5. **Beats the random-entry placebo** with the same exits/costs/horizon: strategy mean − placebo mean ≥ 2 × SE(strategy mean) (placebo at ≥ 3,000 draws, SE ≈ ₹33).
6. **Bootstrap:** 10,000 day-block resamples of net trade P&L; 95% CI lower bound of mean net ₹/trade > 0 **and** of net ₹/session > 0.
7. **Profit factor ≥ 1.3 net; max drawdown ≤ 6% of capital (main) / ≤ the account's weekly cap (small accounts); no single index or single week contributing > 60% of net.**
8. **Robustness:** ±20% perturbation of every numeric parameter (lookback, band multiplier, time stop, stop %, target %) one at a time: net > 0 in ≥ 80% of perturbations and never < −50% of the base result.
9. **Multiple-testing control:** a trials ledger (`reports/trials.jsonl`) records every variant/seed/run; the bootstrap p-value must satisfy p < 0.05 / N_trials (Bonferroni over everything logged by anyone), and the deflated Sharpe ratio (Bailey & López de Prado) with N_trials is reported.
10. **Real-price sanity:** on sessions with bhavcopy, the synthetic entry/exit premiums of each trade must lie within that contract's actual day range in ≥ 90% of trades; the synthetic pricer's IV multiplier must be calibrated (WP6) before the run counts.
11. **No look-ahead:** WP8 sign-off on the variant's code paths (bands/VWAP/HAR from closed bars only; bhavcopy data usable only after 18:00 IST of its date).
12. **Both accounts:** small accounts are evaluated with their own premium-band selection and one-lot sizing; a pass on main does not transfer.

Baseline numbers for comparison are fixed in §1: current engine −₹188/trade (n = 51), placebo −₹402 ± 33.

---

## 6. Work packages (parallel Opus agents, max effort, one git worktree each; flags default to today's behaviour)

Common rules: branch from `9a80d7b`; `npx vitest run` green; no edits outside the listed files without a note in the PR; every new behaviour behind a config flag whose default reproduces `bt-main.json` byte-for-byte (`--history scratchpad/why/hist.json` replay must still print 51 trades / −₹9,595.92); each WP delivers code + tests + a results table (markdown) + an entry per run in `reports/trials.jsonl`. Nothing is deployed before 15:30 IST, and only by the go/no-go in §7.

| WP | owner files (exclusive) | deliverable |
|---|---|---|
| **WP0 Evaluation harness** | `src/engine/backtest/placebo.ts` (new), `src/engine/backtest/metrics.ts` (add bootstrap CI, deflated SR, block bootstrap), `src/engine/backtest/runBacktest.ts` (copy-delay option `fillDelayBars`, `extraTicks`), `scripts/backtest.ts` (flags `--placebo-random N --seed`, `--copy-delay`, `--protocol`, `--trial-ledger`), `src/engine/backtest/backtest.test.ts` | `--protocol` prints §5 verdicts; random placebo reproduces ≈ −₹400 ± 33; results table: baseline vs placebo with and without copy delay |
| **WP1 Data cleaning + archiving** | `src/engine/market/features.ts` (closing-session cutoff flag `features.indicatorCutoffIst`, body-clip with log), `src/engine/market/candles.ts`, `src/engine/market/features.test.ts`, `scripts/fetch-history.ts` (nightly Yahoo 5m archive, append-only), `.github`/cron note | before/after table on the snapshot (expect small change in trade list; report every differing trade); unit tests with the 10 Sep SENSEX bars; archive job spec |
| **WP2 Edge-gate honesty** | `src/engine/strategy/gates.ts`, `src/engine/strategy/planner.ts`, `src/engine/config.ts` (new `gates.expectedMoveModel: "legacy" \| "calibrated"`, `gates.realizedVolFactor`), tests | calibration script output (realized vs implied by horizon, β of realized on score, OOS by fold); table of trades blocked/kept under the calibrated gate; **tightening only** — default `legacy` |
| **WP3 Strategy A: noise-area momentum** | `src/engine/strategy/published/noiseArea.ts` (new), `src/engine/strategy/published/index.ts`, wiring in `src/engine/pipeline/tradingCycle.ts` behind `cfg.strategy.mode = "NOISE_AREA"` (default `"CONVICTION"`), `src/engine/strategy/exits.ts` (index-level trailing stop, additive, flag-gated), tests | results table: 5-min (54 sessions), hourly 2-year approximation, base/VWAP-stop/vol-size variants, placebo, perturbation, copy delay; trials ledger |
| **WP4 Strategy B: 5-min ORB exact** | `src/engine/strategy/published/orb5.ts` (new), `features.openingRangeMin` parameterised per strategy, tests | same table format; expected negative — report it anyway |
| **WP5 Vol-cheapness gate (HAR-RV)** | `src/engine/market/volForecast.ts` (new), gate `gates.volCheapness` in `gates.ts` (shared with WP2 — WP5 adds one function, WP2 owns the file; coordinate via a one-line hook), tests | HAR fit diagnostics (2-year hourly RV and daily Parkinson), OOS forecast R², gate pass-rate, effect on baseline and on WP3's variant |
| **WP6 Real option prices** | `scripts/fetch-bhavcopy.ts` (new; NSE new+old format, BSE with Referer; cache under `.cache/bhavcopy/`), `src/engine/backtest/realPrices.ts` (new), `src/engine/pricing/syntheticOptionPricer.ts` (calibration constants only, flag `pricing.ivSource: "vix" \| "calibrated"`), tests on fixture files | (i) Bhat-2024 replication on NIFTY & SENSEX ATM weeklies 2024–2026: open→close and close→next-open returns of calls/puts/straddles with charges; (ii) IV multiplier and spread calibration vs actual ATM premiums; (iii) real-price sanity check for every backtest trade (§5.10) |
| **WP7 Research E (main only)** | `docs/research/overnight-short-vol.md`, `scripts/research/overnight_vol.ts` (reads WP6 cache) | EOD backtest 2024–2026 of the iron-fly-overnight rule with margin and tail analysis; explicit statement that it is out of scope for small accounts and for the live engine until a separate design is approved |
| **WP8 Adversarial review (two agents, independent)** | read-only across all WPs; writes `reports/review-YYYYMMDD.md` | hunt look-ahead (bands/VWAP/HAR/bhavcopy timing), leakage through `MarketSnapshot`, lag mismatch (90 s + copy delay), closing-auction artefacts, data-snooping (ledger completeness, variant count), seed sensitivity, re-run every result table from a clean checkout; veto power |

Dependency notes: WP3/4/5 consume WP0's protocol flag — they can start immediately with the CLI they have and re-run under `--protocol` once WP0 lands (WP0 is ~half a day). WP6 is independent and the longest (bulk download ≈ 700 days × ~1 MB NSE + BSE; rate-limit politely, cache). WP2 and WP5 touch `gates.ts`: WP2 owns it, WP5 submits a function + one call site.

---

## 7. Go / no-go for shipping after 15:30 IST today

- **Ship (paper, after 15:30):** WP0 harness; WP1 cleaning **only if** the before/after table shows the differences are confined to artefact-driven decisions and all tests pass (it is a demonstrated-bug fix under rule 3); WP6 fetch script and cache (no engine behaviour change). Dormant, flag-off strategy modules may merge once reviewed by WP8, but **no variant is enabled** on any account.
- **Do not ship:** any change that increases trade count without passing §5; any change to stops/caps; anything WP8 has not signed off; anything touching the main account's live behaviour between 08:45 and 15:30.
- **Enable a variant on a paper account** (earliest: next week) only with a §5 pass on ≥ 180 OOS trades, the trials ledger attached, both reviewers' sign-off, and a written before/after including losses.

---

## 8. Expectations — honest

- Most likely outcome this week: WP3 (noise-area momentum) shows a positive gross index effect on the 2-year hourly replay that is **smaller than the option drag** and does not clear §5; WP4 (ORB) is negative; WP5 reduces trade count and losses but does not create edge; WP6 shows that intraday long-option returns on NIFTY are ≈ 0 before spread/charges (consistent with Bhat 2024) and that the synthetic pricer under-states real spreads on SENSEX. Probability that *some* buy-only variant passes §5 within the data we have: low (my estimate ≤ 20%); the small accounts are additionally handicapped by one-lot premium bands and manual copying.
- The one structure with published positive expectancy in India (E) is unavailable to the small accounts by construction and needs an engine redesign (short legs, margin, overnight risk) for main — it should be studied, not rushed.
- What to tell the owner about copying real money now: **don't.** The engine's edge is indistinguishable from random entry on 51 trades; the base rate for this activity is ~90% losers (SEBI); theta, spread, charges and copy delay make the expected value negative with high confidence until a variant clears §5. "Jane Street level" here means the discipline (fair value vs cost, placebo baselines, deflated statistics, real prices, no fitting on the test set), not a hidden signal — and that discipline currently says *no trade*.

---

## 9. Appendix

### 9.1 Commands run today (all against the snapshot)
```
npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits --history scratchpad/why/hist.json
… --max-open-total 1 --max-open-per-index 2 --max-trades-per-day 8 | --index NIFTY --prod-limits | --index SENSEX --prod-limits | --prod-limits --kem 0.5
… --prod-limits --walk-forward --train-days 42 --test-days 14
npx tsx scratchpad/why/random_baseline.ts scratchpad/why/hist.json <seed> 3000 [stop target horizonMin]
python3 -I scratchpad/why/sensex_quality.py hist.json ; edge_calib.py bt-main.json hist.json ; itsm_check.py
```
Outputs: `scratchpad/why/runs/{base,total1,nifty,sensex,kem05,wf}.json`, `wf.log`.

### 9.2 Walk-forward result (existing tooling)
3 folds (42/14 days), pooled OOS: 40 trades, net −₹1,561.96, hit 37.5%, PF 0.94, Sharpe −0.25, maxDD 2.75% (`runs/wf.json`). See §1.5.

### 9.3 Primary sources (verified today)
- Gao, Han, Li, Zhou (2018) *JFE* 130:394–414, "Market intraday momentum" (WP PDF: smallake.kr/…/SSRN-id2440866.pdf).
- Baltussen, Da, Lammers, Martens (2021) *JFE* 142:377–403, "Hedging demand and market intraday momentum" (academicweb.nd.edu/~zda/intramom.pdf).
- Li, Sakkas, Urquhart (2022) *J. Financial Markets* 57:100619.
- Limkriangkrai, Chai, Zheng (2023) *Pacific-Basin Finance J.* 80:102086, "Market intraday momentum: APAC evidence".
- Zarattini, Aziz, Barbon (2024, rev. Feb 2025) SFI WP 24-97 / SSRN 4824172, "Beat the Market: An Effective Intraday Momentum Strategy for S&P500 ETF (SPY)".
- Zarattini, Aziz (2023, rev. Sep 2025) SSRN 4416622, "Can Day Trading Really Be Profitable?"; replication: mql5.com/en/blogs/post/776235.
- Coval, Shumway (2001) *JF* 56:983–1009; Bakshi, Kapadia (2003) *RFS* 16:527–566; Broadie, Chernov, Johannes (2009) *RFS* 22:4493–4529.
- Muravyev, Ni (2020) *JFE* 136:219–238, "Why do option returns change sign from day to night?".
- Bhat, Pandey, Rao (2024) *J. Futures Markets* 44:1320–1337, "The asymmetry in day and night option returns: Evidence from an emerging market".
- Sankar, Ramachandran, Lukose (2020) *Int. Rev. Econ. Finance* 70:321–334, "Dynamics of variance risk premium: Evidence from India".
- Corsi (2009) *J. Financial Econometrics* 7:174–196; Kumar (2010) *JIEM* 3(1); Banerjee, Kumar (2011) IIMC WPS 688.
- SEBI DEPA (Aug 2026) "Profits and Losses of Individuals in the Equity Derivatives Segment FY25–FY26" (sebi.gov.in/sebi_data/attachdocs/aug-2026/1787233506209.pdf); SEBI (Sep 2024) FY22–FY24 study; SEBI (Jan 2023) FY22 study.
- Beckmeyer, Branger, Gayda (2023) SSRN 4404704.
- NSE Closing Auction Session from 3 Aug 2026 (newsonair.gov.in; secondary explainers) — affects every "last 30 minutes" rule and explains the 15:15–15:25 bar artefacts.
