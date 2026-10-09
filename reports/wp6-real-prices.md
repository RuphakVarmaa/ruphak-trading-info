# WP6 — Real option prices from exchange bhavcopies

Branch `worktree-agent-ad591232093a9755a`, based on `9a80d7b`. Research only: the engine stays in paper mode and its default behaviour is unchanged (proof in §5).

How to reproduce:

- `npx tsx scripts/fetch-bhavcopy.ts …`
- `npx tsx scripts/research/real_prices.ts coverage | replicate | calibrate | sanity | sanity-calibrated`
- Raw outputs go to `reports/wp6/`; every run is in `reports/trials.jsonl`.

## 1. Data and coverage

**Sources** (public, no keys; 1.1 s minimum between requests per host; retries with backoff; descriptive User-Agent; neither host publishes robots.txt rules):

- **NSE UDiFF F&O bhavcopy** (from 2024-01-01; it actually exists before the 2024-01-08 date the plan gave). File names are matched by date and the format is detected from the header.
- **NSE legacy F&O bhavcopy**, used for 2019-02-11 → 2023-12-29. The archive returns 404 from 2024-07-08.
- **BSE derivatives bhavcopy** (`bhavcopyDD-MM-YY.zip`, sent with a Referer header). BSE answers a missing file with its HTML home page and HTTP 200; the fetcher records this as "no file".
- **Already-downloaded zips.** Per the lead's note, 2026-01-16 → 2026-10-08 (176 NSE + 5 BSE days) were imported offline from `scratchpad/research/q1/dl_{nse,bse}` (`--local-nse/--local-bse --offline`). Only dates missing there were fetched.
- **Yahoo daily** `^NSEI ^BSESN ^NSEBANK ^INDIAVIX` (10 years), for index open/close and VIX.

**Cache:** `.cache/bhavcopy/` (gitignored) holds compact gzipped extracts only: NIFTY, BANKNIFTY and SENSEX index options and futures, ≈3k rows a day, about 50 KB per file. Raw zips are not kept.

| exchange | coverage | sessions | gaps |
|---|---|---|---|
| NSE | 2019-02-11 → 2026-10-08 | 1,897 | none on trading days. Weekend sessions found by probing: 2024-01-20, 2024-03-02, 2024-05-18, 2025-02-01, 2026-02-01 |
| BSE | 2023-05-15 (SENSEX weekly relaunch) → 2026-10-08 | 841 + 3 special days | 5 trading days with no file in BSE's archive: 2024-08-02, 2024-08-29, 2024-11-29, 2025-02-10, 2025-09-02. The q1 agent got the same HTML page |

**Short special sessions** were detected from NIFTY option volume (< 0.3× the quietest of the 3 sessions on each side) and excluded. They are the Muhurat sessions of 2019, 2020, 2021, 2023, 2024 and 2025, and the DR drills of 2024-03-02 and 2024-05-18.

**Checks:**

- Yahoo `^NSEI` daily close equals NSE `UndrlygPric` on all 679 days.
- A legacy CLOSE equals the next UDiFF file's `PrvsClsgPric` (unit test).
- 8 legs were dropped as bad prints: a price below 10% of its reference while the index moved < 3%. Example: SENSEX 65500 CE and PE both "opened" at ₹2.05 on 2023-09-04.

## 2. What OPEN and CLOSE mean, and the bias

**OPEN** is the contract's first trade.

- Index options have no pre-open call auction; NSE's F&O pre-open covers futures only (NSE pre-open FAQ, Nov 2025).
- So an option's open is its first continuous trade at or after 09:15:00.
- For ATM weeklies the open is the day's high on 7.4% (NIFTY) and 10.2% (SENSEX) of contract-days, against the low on 3.4% and 3.6%.
- Median open is +10.1% (NIFTY) and +12.1% (SENSEX) above the day's VWAP.

**CLOSE** is not the last trade.

- For NSE it is the last-half-hour VWAP: 15:00–15:30, and **15:10–15:40 from 3 Aug 2026**, when derivatives trading was extended to 15:40 (NSE circular as reported by Business Today, 30 May 2026). If the contract did not trade in that window, the close is the last trade.
- In the UDiFF files, ClsPric equals LastPric on only 1 of 1,366 NIFTY ATM contract-days; the median |last/close − 1| is 4.2% (p90 11.9%).
- On expiry day NSE prints the index final settlement level in `SttlmPric`; BSE prints it in "Close", and the parser converts it to intrinsic value.
- Since the closing auction began (3 Aug 2026), the official index close is an auction price. It differs from the options' own parity forward by a median 0.18–0.20% (0.08% before), and by more than 0.3% on 17–26% of days.
  - Example: 3 Aug 2026, official NIFTY close 24,774 against a parity forward of ≈24,576.

**Bias.** A "night" measured from the close to the next open starts at the closing-window midpoint (≈15:15), so it includes about 15 minutes of trading-hours decay. It also ends on a single, often extreme, first print. A "day" measured from the open to the close starts on that first print and ends 15 minutes before the bell. Net effect:

- day returns are pushed down and night returns up by the opening print;
- night returns are pushed down by the extra 15 minutes of decay;
- multi-leg results from first prints are unreliable (see WP7: 17–40% of nights give impossible iron-fly values).

## 3. Bhat–Pandey–Rao (2024) replication: ATM weekly, nearest expiry after the day

Returns are per unit of premium, for long positions. Short returns before costs are the negative of these. Δ-hedged means hedged with the index at the Black–Scholes delta at entry.

| index (sample) | leg | option | n | long gross mean | t | Δ-hedged mean | short net of charges + engine spread |
|---|---|---|---|---|---|---|---|
| NIFTY (2019-02 → 2026-10) | day (open→close) | straddle | 1,882 | **−3.06%** | −5.7 | −2.83% | +1.66% |
| | night (close→open) | straddle | 1,866 | **+0.01%** | 0.0 | −0.38% | −1.57% |
| | day | call / put | 1,882 | −2.98% / −0.22% | −2.2 / −0.2 | +2.76% / −4.43% | |
| | night | call / put | 1,866 | +3.39% / −3.24% | 3.5 / −3.4 | −5.79% / +6.22% | |
| SENSEX (2023-05 → 2026-10) | day | straddle | 822 | **−5.50%** | −6.9 | −5.27% | +4.07% |
| | night | straddle | 806 | **+1.55%** | 2.0 | +1.31% | −3.17% |
| NIFTY 2024–2026 only | day / night | straddle | 682 / 677 | −3.99% / −0.72% | −4.6 / −0.9 | | +2.65% / −0.77% |

**What the data say:**

- **The finding is the reverse of Bhat et al. (NIFTY 2017–2020).** They found overnight short returns positive and significant, and intraday short returns negative or insignificant.
  - Here sellers earn **intraday** (NIFTY +3.1% per day gross, SENSEX +5.5%).
  - **Overnight** is ≈ 0 for NIFTY and negative for sellers on SENSEX (−1.6%, t 2.0 for buyers).
- **The pattern holds in every year** from 2020 to 2026 for days, with long straddle day returns between −0.7% and −5.2%.
- **Jumps decide the night:**
  - NIFTY nights without a jump (|gap| < 0.86%) give buyers −1.65% (t −6.0); top-decile gap nights give +14.8%.
  - Days without a jump give buyers −6.85% (t −17.8); top-decile days give +30.7%.
  - This matches "weaker on jump days".
- **Weekend nights:** for NIFTY they are not worse for buyers than weekday nights (+0.25% against −0.07%). For SENSEX they are better (+5.3%, t 2.3, against +0.4% on weekday nights). Options barely decay over weekends, while the engine's trading-time clock already assumes no weekend theta.
- **Robust to the opening print:**
  - Close→next close: NIFTY −2.87% (t −3.0), SENSEX −2.60% (t −1.6).
  - Close→next-day VWAP: −8.65% and −12.64% (t −13 / −14).
  - Day VWAP→close: mean +1.47% and +4.82%, but the medians are −2.0% and −0.6% (right-skewed).
  - Decay concentrates in trading hours, in line with trading-time pricing. With end-of-day data the night/day split cannot be pinned down more finely than that.
- **For the engine (an intraday option buyer):** a long ATM straddle loses 4.5% (NIFTY) and 6.9% (SENSEX) of premium per day open→close after charges and the engine's spread model. Directional single options average −4.4% (calls) and −1.7% (puts) on NIFTY. The cross-check in `research/q1-premium-timing.md` (ATM NIFTY bought at the open and sold at the close lost ≈ ₹547 per lot) is consistent.

**Costs.** Charges are for one lot at the dated schedule; dates before Oct 2024 use the Oct 2024 schedule, which overstates STT then. The half-spread is paid each side.

| scenario | NIFTY short straddle night | NIFTY long straddle day | SENSEX short night | SENSEX long day |
|---|---|---|---|---|
| none | −1.14% | −4.04% | −2.76% | −6.53% |
| 1 tick | −1.19% | −4.08% | −2.77% | −6.54% |
| engine model max(1 tick, 0.4%) | −1.57% | −4.45% | −3.17% | −6.92% |
| 1% of premium | −2.16% | −5.04% | −3.77% | −7.51% |

## 4. Calibration of the synthetic pricer (`pricing.ivSource`, default `"vix"`)

**Method.**

- Fit window: 2024-01-02 → 2026-06-30. Out-of-sample window: Jul → 8 Oct 2026.
- ATM straddle implied vol uses the engine's own conventions: spot, r = 6.5%, trading-time `yearsToExpiry`, and holidays inferred from the archive.
- The open (09:15) and close (15:15) multipliers are computed separately.

**ATM straddle IV ÷ India VIX** (median), by sessions left after the day:

| sessions left | 1 | 2 | 3 | 4 | 5 | 6+ |
|---|---|---|---|---|---|---|
| NIFTY close / open | 0.878 / 0.852 | 0.893 / 0.877 | 0.900 / 0.890 | 0.909 / 0.906 | 0.903 / 0.901 | 0.926 / 0.924 |
| SENSEX close / open | 0.908 / 0.908 | 0.924 / 0.921 | 0.925 / 0.933 | 0.918 / 0.936 | 0.913 / 0.927 | 0.929 / 0.923 |
| **constant used** (mean of open and close) | NIFTY 0.865 · SENSEX 0.908 | 0.885 · 0.923 | 0.895 · 0.929 | 0.908 · 0.927 | 0.902 · 0.920 | 0.925 · 0.926 |

- The engine's current multipliers are 1.00 (NIFTY) and 1.05 (SENSEX).
- The IQR is about ±0.08.
- By year (close, 1–5 sessions): NIFTY 0.895 / 0.866 / 0.962 for 2024 / 2025 / 2026; SENSEX 0.937 / 0.888 / 0.953.
- The cross-check (≈0.88–0.91 NIFTY, 0.92–0.93 SENSEX) agrees.

**Smile at the close.** IV ÷ ATM IV = 1 + a z + b z², with z = ln(K/F)/(σ√t), fitted per wing:

| index | puts a, b | calls a, b | fitted IV ÷ ATM, 8 strikes OTM (put / call) |
|---|---|---|---|
| NIFTY | −0.0467, 0.0525 | −0.1172, 0.0986 | 1.14 / 0.99 |
| SENSEX | −0.0573, 0.0398 | −0.0847, 0.0920 | 1.07 / 0.98 |

**Out of sample** (Jul–Oct 2026, close, 1–6 sessions), model ATM straddle ÷ real − 1:

| | default VIX × 1.00 / 1.05 | calibrated |
|---|---|---|
| NIFTY | median +7.5% (IQR +2.6 … +15.3%) | median −3.2% (IQR −9.2 … +5.3%) |
| SENSEX | median +9.8% (IQR +5.5 … +16.0%) | median −3.3% (IQR −7.1 … +1.6%) |

The out-of-sample window includes the post-auction closes (§2).

**Spreads: not changed.** End-of-day files have no bid/ask.

- The engine's model, max(1 tick, 0.4%), means 7–14 ticks (₹0.35–0.70) on NIFTY ATM and 21–44 ticks (₹1.05–2.20) on SENSEX ATM.
- The only data-driven bound: NIFTY put–call-parity residuals of last trades across the 7 near-money strikes put the full spread at ≤ ₹1.15. The bound is loose, because asynchrony is included; closing-VWAP residuals alone are ₹0.59.
- The model is within that bound. There is no evidence for tightening or widening it.
- At ₹1–2 for SENSEX and ₹0.35–0.70 for NIFTY ATM, spreads cost 0.4% of premium per side, small next to the 3–7% daily decay.

## 5. Real-price sanity check (§5.10) on the snapshot backtest (51 trades, 23 Jul – 8 Oct 2026)

**Criterion:** at least 90% of trades with both the entry and exit premium inside the contract's real day range [low, high].

| run | trades | entry in range | exit in range | **both in range** | entry above the day's high | median entry ÷ day VWAP − 1 |
|---|---|---|---|---|---|---|
| baseline (VIX × 1.00 / 1.05) | 51 | 49% | 61% | **39%** | 51% | +40.5% |
| same trades repriced, calibrated IV | 51 | 76% | 76% | **67%** | 24% | +24.7% |
| backtest with `ivSource: "calibrated"` | 50 | 78% | 80% | **70%** | 22% | +22.8% |

**Verdict: FAIL** for both pricers. The baseline's synthetic entry is above the contract's real day high on half the trades: NIFTY 58%, SENSEX 44%, with median position 1.01 of the day's range. The bias has three sources:

1. **IV.** Weekly options trade at about 0.87–0.93× VIX, not 1.00–1.05×. That is roughly 10% of premium.
2. **Carry.** The engine prices off spot with r = 6.5% and no dividend, while the options' parity forward is ≈ spot. Calls come out too dear, puts too cheap.
3. **Timing.** Momentum entries come near intraday highs.

**What changes with calibration.** Calibration roughly halves the overpricing, but the run still fails §5.10. The calibrated backtest has 50 trades, net −₹13,992.30, PF 0.67, against −₹9,595.92 at default. It is cheaper premium but the same signals, and it is worse. That is consistent with the replication: intraday option buying loses.

Repricing check: the reconstruction reproduces all 51 recorded entries within ₹0.10.

**Default behaviour is unchanged.** `npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits --history …/why/hist.json` prints 51 trades and net −₹9,595.92, and the trade list is byte-identical to `bt-main.json`. The programmatic replay also gives 51 trades and −9,595.92.

## 6. Left open

- The carry: the engine's no-dividend forward. It is a pricer convention, not a calibration constant, so it is left unchanged and flagged for WP2 and the reviewers.
- The 15:40 derivatives close from 3 Aug 2026, which the engine's clock (15:30) ignores.
- Intraday bid/ask snapshots are needed to calibrate spreads and to test WP7 properly.
- `reports/trials.jsonl` lists every run. The first WP7 run (no clamp) and repeated replication runs are kept; the ledger is append-only.
