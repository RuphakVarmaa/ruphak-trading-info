# WP15: does NIFTY's (and SENSEX's) overnight drift give a retail option buyer an edge?

Sat 10 Oct 2026. Branch `worktree-agent-a1034c1e778172446`, fast-forwarded to `555c290` (head of `claude/gifted-wright-3d8r3j`). Analysis only: no paper trading, no deploys, no pushes; nothing in the engine changes.

**Data and licence.**
- **Index:** Yahoo's daily ^NSEI, ^BSESN and ^INDIAVIX bars (Q2's download of 9 Oct 2026, before the open; the last bar is 8 Oct 2026).
- **Option prices:** the Hugging Face dataset **"India Index & Options – 1-minute OHLC" by TradeMarkk** (`thetrademarkk/india-index-options-1m`, revision `0f4800e43e6f96cec0794369d78eb4d3c4211ef5`, https://huggingface.co/datasets/thetrademarkk/india-index-options-1m), licensed **CC-BY-NC-4.0**: non-commercial research use only, attributed here. WP11 §2 verified it against the exchanges' own files. This study reads WP13's extract of it.
- **Exchange files:** NSE and BSE F&O bhavcopies (the compact cache: NSE from 11 Feb 2019, BSE daily from 15 May 2023, both to 8 Oct 2026) for lots, expiries, holidays, short sessions, near-month futures and end-of-day option prices; the file names of NSE's participant-OI archive (WP14's download, 2 Jan 2012 – 9 Oct 2026) as a list of NSE sessions.
- Nothing was downloaded for this study. No raw or extracted data is committed (the repository is public); the scripts rebuild everything from the downloads.

**Status of this file:** §1 and §2 were written and committed (`8edf6a7`) before any overnight mean, conditional return or P&L was computed, and they are unchanged. §0 and §3–§12 were added after the runs; §11 lists every change made after the freeze. No definition changed.

---

## 0. Bottom line

**Verdict: nothing passes, so there is no paper-test spec.** In plain words: NIFTY and SENSEX do tend to rise between one day's official close and the next day's official open, but a retail option buyer cannot capture that after costs. Every option variant lost money out of sample, and the drift itself fails the bar at its last step, multiple testing.

**Does the overnight drift exist in NIFTY and SENSEX?** In the official index prints, yes. In prices a trader can actually hold overnight, very little of it.
- **The official prints.** Since 2011, NIFTY rose from the close to the next open on 64.7% of 3,813 nights, by +10.2 bp a night on average (CI +8.1 … +12.1). From the open to the close of the same days it lost −6.3 bp. SENSEX made +12.8 bp a night and rose on 69.1% of 3,827 nights.
- **It held out of sample.** On the last 40% (Jul 2020 – Oct 2026), NIFTY made +9.6 bp a night over 1,525 nights (CI +6.7 … +12.4) and SENSEX +9.4 bp. Both placebo gaps are above 6 SE, and the PF is 1.65 and 1.64.
- **It still fails the frozen bar**, at multiple testing only. All nights, weekday nights and nights after an up day pass every other criterion on both indices.
  - Bonferroni passes: the p-value sits at the bootstrap's floor, 1.0 × 10⁻⁵, against 0.05 / 3,067 = 1.6 × 10⁻⁵.
  - The deflated Sharpe ratio fails: 0.000–0.022 against a bar of 0.95. With the null variance 1/(T − 1) instead of this study's V[SR] it would be 0.995–1.000 (§9).
  - The bar is not loosened. By the program's rule this is a FAIL, not a result.
- **It is fading.** NIFTY by year: +18.3 bp a night in 2021, +2.6 bp in 2022, +12.6 bp in 2023, +9.6 bp in 2024, +3.6 bp in 2025 and −0.6 bp in 2026 to 8 Oct (up on 48% of nights). SENSEX: +3.1 bp in 2025, +2.1 bp in 2026.
- **It comes after up days, not after sell-offs.**
  - After an up day: +14.1 bp (NIFTY) and +16.2 bp (SENSEX).
  - After a down day: +5.8 and +9.1 bp.
  - After a fall of 1% or more: +4.8 and +7.8 bp, with CIs that include zero. "Buy the dip overnight" (the NY Fed paper) does not show up here.
- **Most of it is not in prices a trader gets.**
  - On the 1-minute nights (NIFTY from May 2021, SENSEX from Aug 2023, both to Jul 2026), the official close → open made +7.9 bp a night for NIFTY. Over the same nights, the index from the 15:25 bar's close to the 09:30 bar's close made only +4.4 bp (CI +1.3 … +7.4). SENSEX's equivalent was +2.3 bp (CI −1.6 … +6.2).
  - The near-month future, the instrument that carries the index overnight, made +1.7 bp a night (CI −1.5 … +4.7; NIFTY, Feb 2019 – Oct 2026). That is ₹129 a lot a night, less than the ₹183 a lot of STT due on its sale at the dated rates. From 1 Apr 2026 it lost −3.5 bp a night, against ₹776 of STT.

**Can a retail option buyer capture it after costs?** No.
- **All 28 option picks fail, and 27 of them lose money out of sample** (per lot, per night, last 40%):

  | what was bought | NIFTY: conservative / mid fill | SENSEX: conservative / mid fill |
  |---|---|---|
  | The call at 15:20 or 15:25, sold at 09:15–09:20, all nights | −₹567 / −₹241 | −₹739 / −₹452 |
  | The same, weekday nights or after a down day | −₹514 to −₹700 / −₹81 to −₹349 | −₹620 to −₹758 / −₹259 to −₹444 |
  | R6's synthetic long (call + short put), 15:25 → 09:30 | −₹1,019 / −₹405 | −₹1,148 / −₹510 |
  | R6's single call at the same strike and minutes (the retail version) | −₹526 / −₹240 | −₹640 / −₹321 |
  | R6's synthetic long after a weak session (C2) | −₹1,909 / −₹1,198 | −₹2,465 / −₹1,525 |

  - The one positive pick is NIFTY's call after a sell-off at the mid fill: +₹318 a night over only 48 nights (CI −₹1,360 … +₹2,228).
  - Of all 212 option variants, none has a CI above zero, either over all nights or out of sample. None has a placebo gap of 2 SE.
- **No pick beat a coin flip between the call and the put** at the same minutes. The placebo gaps run from −1.41 to −0.05 SE.
- **Why.** The drift is worth only a few rupees a lot a night to the option, and holding an option overnight costs much more.
  - Split the call into half the synthetic (call − put: the direction) and half the straddle (call + put: time decay, volatility and the size of the move). For NIFTY's ATM call from 15:20 to 09:15, over all nights, the direction added +₹44 a lot a night at mid. The straddle half cost −₹144 at mid and −₹993 at the conservative fill (net of charges).
  - R6's decomposition of the NIFTY call (15:25 → 09:30, mid, gross) also leaves almost nothing: +₹3 a night = +₹12 of direction − ₹9 of the straddle half. The index move alone, at a delta of 0.5, would have been worth about ₹210 a night. Everything else in the call's price change took −₹207 of that back: the forward's carry, the time decay, the volatility and the opening print.
  - Charges are ₹61–71 a round trip for one call. The gap between the two fills is ₹220–950 a night for one call over all nights, and ₹450–510 for the four-leg synthetic.
- **R6's kill checks:**
  - From 1 Apr 2026, when STT on option sales rose to 0.15%, every family-C variant lost money (kill check 1).
  - On the complete-bar nights (to Dec 2024), NIFTY's synthetic and single call made ₹2 and ₹38 a night at the conservative fill when sold at the first print, and −₹353 and −₹166 when sold at R6's 09:30 (kill check 2: an opening-print artefact).
  - Buying only after a weak session (C2) did worse than C1 on the same nights and worse than a random draw of nights (p 0.80–0.94).

**The tails (one lot):**
- **A bought call can lose its whole premium in one night.** The worst nights of the call picks are −₹11,189 to −₹14,353 a lot (the nights starting 6 Mar, 18 Mar and 1 Apr 2026). Before the 1-minute data begins, an ATM call bought at NSE's close on 20 Mar 2020 lost −₹22,655 a lot by the next open, and a NIFTY futures lot lost −₹65,423 (−10.0%).
- **The synthetic has no cap.** It lost −₹58,307 a lot on NIFTY on the night into 7 Apr 2025 (the April 2025 tariff sell-off; NIFTY opened 5.0% lower), and −₹48,228 on SENSEX. Its maximum drawdown at the conservative fill is ₹7.8 lakh on NIFTY, 156% of a ₹5 lakh account.
- **4 Jun 2024, the election result.**
  - NIFTY's official open was only −0.36% below the previous close.
  - Even so, an ATM call bought at 15:20 on 3 Jun had lost −₹6,764 a lot by 09:15 (conservative fill; −₹5,504 at mid), and R6's synthetic −₹23,254 by 09:30 (mid). On SENSEX the same two lost −₹10,061 and −₹29,873.
- **The worst 5% and 1% of nights.** NIFTY's all-nights call pick (conservative fill) averaged −₹6,866 a lot on its worst 5% of nights and −₹10,296 on its worst 1%; the synthetic −₹17,795 and −₹30,546.
- **Drawdowns.**
  - The call picks with 297 or more nights drew down 35–89% of a ₹5 lakh account at the conservative fill (18–44 times a ₹10,000 account).
  - On 18–52% of nights the one-lot premium was above ₹10,000, so a ₹10,000 account could not have bought the lot at all.
- **A stop cannot help overnight.** On 12–26% of nights, the call picks' exit fill was already more than 30% below the entry fill. A stop at −30% would have been gapped through, because nothing trades overnight; the loss beyond it averaged ₹1,152–2,710 a lot.

Rule N5 ("no overnight holds") stands.

| question | answer from the data |
|---|---|
| **Does the drift exist?** (official close → open, 2011–2026) | **Yes, in the official prints.**<br>• NIFTY +10.2 bp a night, up on 64.7% of nights; SENSEX +12.8 bp, 69.1%. The intraday leg lost (−6.3 and −9.1 bp).<br>• Last 40%: +9.6 and +9.4 bp, placebo gaps 6.2–6.7 SE, PF 1.64–1.65.<br>• **It fails the bar at the deflated Sharpe ratio** (0.000 against 0.95; 0.995–0.998 with the null variance). Bonferroni passes (p 1.0 × 10⁻⁵). |
| **Is it the same everywhere?** | **No.**<br>• After an up day +14.1 / +16.2 bp (NIFTY / SENSEX); after a down day +5.8 / +9.1; after a fall of 1% or more +4.8 / +7.8 (CIs include zero).<br>• Weekday nights +10.8 / +13.4 bp; weekend nights +5.4 / +8.5 bp (three calendar days, yet less than one weekday night); nights before a weekday holiday +18.1 / +18.8 bp (198 and 199 nights).<br>• Low / middle / high VIX tercile: +8.1 / +11.5 / +11.4 bp (NIFTY).<br>• 2011–2019 +10.5 bp, 2020–2026 +9.7 bp (NIFTY), but 2025 +3.6 bp and 2026 −0.6 bp. |
| **How much is tradeable?** (the 1-minute nights, to Jul 2026) | **About half for NIFTY, a third for SENSEX.**<br>• 15:25 → 09:30: +4.4 bp NIFTY (CI +1.3 … +7.4), +2.3 bp SENSEX (CI −1.6 … +6.2), against +7.9 and +6.9 bp official on the same nights.<br>• Near-month futures close → open: +1.7 bp NIFTY (CI −1.5 … +4.7), +0.9 bp SENSEX. The mean gain, ₹129 and ₹58 a lot, is below the STT on the sale alone (₹183 and ₹287 a lot at the dated rates). |
| **Can a call buyer capture it?** (B: 15:20/15:25 → 09:15/09:16/09:20, ATM or 1 ITM, ≥ 2 sessions to expiry) | **No.**<br>• Out of sample, per lot a night: −₹162 to −₹1,490 at the conservative fill, −₹81 to −₹452 at mid (one mid pick +₹318 over 48 nights).<br>• Placebo gaps −0.88 to −0.05 SE. 0 of 192 variants has a CI above zero.<br>• To Dec 2024 (complete bars), the conservative picks lost −₹157 to −₹928 a night over all nights; the mid picks −₹539 to +₹111. |
| **R6's synthetic long (C1), its single call (C1-B), and after a weak session (C2)?** | **No.**<br>• C1: −₹1,019 / −₹1,148 a night (conservative), −₹405 / −₹510 (mid). C1-B: −₹526 / −₹640 and −₹240 / −₹321.<br>• Kill check 1 (from 1 Apr 2026): all negative. Kill check 2: NIFTY's conservative C1 and C1-B gains at the first print (₹2, ₹38) are gone by 09:30 (−₹353, −₹166).<br>• C2 loses more than C1 on the same nights (−₹793 to −₹1,318) and more than a random draw (p 0.80–0.94). |
| **What do the tails look like?** (one lot) | **Large, and no stop can cut them.**<br>• Call: the whole premium, −₹11,000 to −₹14,000 a lot in a night (−₹22,655 on 20 Mar 2020 at end-of-day prints).<br>• Synthetic: −₹58,307 (into 7 Apr 2025); futures lot −₹65,423 (into 23 Mar 2020).<br>• Max drawdown at the conservative fill: 35–89% of ₹5 lakh for the call picks with ≥ 297 nights, 102–156% for C1's synthetic.<br>• On 12–26% of nights the call's exit fill was already more than 30% below its entry. |

**Verdict tables.** Each option pick is the variant with the best mean on the first 60% of its nights (per index, filter and fill), judged untouched on the last 40%. The index variants are fixed hypotheses (long, no pick). Index figures are basis points per night, official close → official open; option figures are ₹ per lot per night, net of dated charges, with night-clustered 95% CIs. The option verdict is decided at the conservative fill.

*A. Index nights* ("does the drift exist?"):

| index | nights | first 60% per night (n) | last 40% nights | last 40% per night (95% CI) | hit (Wilson 95%) | placebo (a) E's open → close (SE) | placebo (b) fair coin (SE) | PF | verdict: fails on |
|---|---|---|---|---|---|---|---|---|---|
| NIFTY | all | +10.5 bp (2,287) | 1,525 | **+9.6 bp (+6.7 … +12.4)** | 63.9% (61.4 … 66.2) | +13.9 bp (6.61) | +9.6 bp (6.68) | 1.65 | **FAIL: multiple testing only** (p 1.0 × 10⁻⁵; DSR 0.000) |
| | weekday | +10.9 bp (1,743) | 1,165 | **+10.5 bp (+7.9 … +13.2)** | 64.4% (61.6 … 67.1) | +15.1 bp (6.92) | +10.5 bp (7.74) | 1.83 | **FAIL: multiple testing only** (p 1.0 × 10⁻⁵; DSR 0.000) |
| | weekend and holiday | +9.3 bp (544) | 360 | +6.5 bp (−1.5 … +14.2) | 62.2% (57.1 … 67.1) | +10.2 bp (1.71) | +6.5 bp (1.61) | 1.30 | FAIL: placebo, CI, multiple testing |
| | after a down day | +7.9 bp (1,088) | 701 | +2.6 bp (−1.7 … +7.0) | 57.8% (54.1 … 61.4) | +8.4 bp (2.22) | +2.6 bp (1.19) | 1.13 | FAIL: placebo, CI, PF, multiple testing |
| | after an up day | +13.0 bp (1,177) | 823 | **+15.5 bp (+12.2 … +18.7)** | 69.1% (65.9 … 72.2) | +18.5 bp (6.70) | +15.5 bp (9.32) | 2.47 | **FAIL: multiple testing only** (p 1.0 × 10⁻⁵; DSR 0.022) |
| | after a sell-off ≤ −1% | +5.3 bp (285) | 156 | +3.9 bp (−9.7 … +16.9) | 59.6% (51.8 … 67.0) | −2.9 bp (−0.28) | +3.9 bp (0.57) | 1.13 | FAIL: sample, placebo, CI, PF, multiple testing |
| SENSEX | all | +15.1 bp (2,296) | 1,530 | **+9.4 bp (+6.5 … +12.3)** | 63.8% (61.4 … 66.2) | +13.8 bp (6.22) | +9.4 bp (6.40) | 1.64 | **FAIL: multiple testing only** (p 1.0 × 10⁻⁵; DSR 0.000) |
| | weekday | +15.0 bp (1,750) | 1,171 | **+11.1 bp (+8.4 … +13.7)** | 64.9% (62.1 … 67.6) | +16.5 bp (7.33) | +11.1 bp (8.12) | 1.90 | **FAIL: multiple testing only** (p 1.0 × 10⁻⁵; DSR 0.001) |
| | weekend and holiday | +15.3 bp (546) | 359 | +4.0 bp (−4.3 … +12.1) | 60.2% (55.0 … 65.1) | +5.2 bp (0.82) | +4.0 bp (0.96) | 1.18 | FAIL: placebo, CI, PF, multiple testing |
| | after a down day | +13.3 bp (1,100) | 716 | +2.6 bp (−1.9 … +7.1) | 56.8% (53.2 … 60.4) | +7.8 bp (2.02) | +2.6 bp (1.15) | 1.13 | FAIL: placebo, CI, PF, multiple testing |
| | after an up day | +16.6 bp (1,186) | 812 | **+15.5 bp (+12.2 … +18.9)** | 70.1% (66.8 … 73.1) | +19.3 bp (6.59) | +15.5 bp (9.12) | 2.50 | **FAIL: multiple testing only** (p 1.0 × 10⁻⁵; DSR 0.020) |
| | after a sell-off ≤ −1% | +12.4 bp (281) | 161 | −0.4 bp (−14.5 … +13.4) | 54.0% (46.3 … 61.6) | −7.2 bp (−0.65) | −0.4 bp (−0.05) | 0.99 | FAIL: sample, placebo, CI, PF, multiple testing |

*B and C. The option buyer* ("can a buyer capture it?"; real 1-minute prices, one lot):

| index | family | fill | pick (first 60%) | first 60% ₹/night (n) | last 40% nights | last 40% ₹/night (95% CI) | PF | placebo gap (SE) | last 40%: to Dec 2024 / from 2025 | worst night (all nights) | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| NIFTY | B all nights | conservative | call ATM 15:25 → 09:20 | −₹233 (720) | 479 | −₹567 (−₹935 … −₹188) | 0.64 | −₹113 (−0.57) | −₹250 (153) / −₹716 (326) | −₹13,010 (1 Apr 2026) | **FAIL** |
| | B weekday | conservative | call ATM 15:25 → 09:20 | −₹126 (551) | 368 | −₹700 (−₹1,066 … −₹303) | 0.52 | −₹156 (−0.88) | −₹301 (117) / −₹886 (251) | −₹13,010 (1 Apr 2026) | **FAIL** |
| | B after a down day | conservative | call ATM 15:25 → 09:20 | −₹549 (322) | 236 | −₹514 (−₹1,082 … ₹92) | 0.69 | −₹113 (−0.35) | −₹395 (70) / −₹564 (166) | −₹12,836 (6 Mar 2026) | **FAIL** |
| | B after a sell-off | conservative | call ATM 15:25 → 09:20 | −₹462 (63) | 48 | −₹162 (−₹1,805 … ₹1,694) | 0.91 | −₹72 (−0.06) | −₹582 (14) / ₹10 (34) | −₹12,836 (6 Mar 2026) | **FAIL** |
| | C1 synthetic | conservative | 15:25 → 09:30 | −₹340 (720) | 479 | −₹1,019 (−₹1,817 … −₹228) | 0.69 | −₹247 (−0.60); vs E's session −₹318 (−0.58) | −₹461 (153) / −₹1,281 (326) | −₹58,307 (4 Apr 2025) | **FAIL** |
| | C1-B call | conservative | 15:25 → 09:30 | −₹163 (720) | 479 | −₹526 (−₹899 … −₹135) | 0.67 | −₹105 (−0.52) | −₹218 (153) / −₹670 (326) | −₹12,981 (1 Apr 2026) | **FAIL** |
| | C2 weak session | conservative | bottom 33% | −₹923 (143) | 166 | −₹1,909 (−₹3,486 … −₹413) | 0.52 | −₹1,095 (−1.41); vs E's session −₹1,433 (−1.40) | −₹626 (54) / −₹2,527 (112) | −₹58,307 (4 Apr 2025) | **FAIL** |
| | B all nights | mid | call 1 ITM 15:25 → 09:16 | ₹51 (720) | 479 | −₹241 (−₹626 … ₹152) | 0.84 | −₹102 (−0.50) | −₹38 (153) / −₹336 (326) | −₹13,816 (6 Mar 2026) | FAIL |
| | B weekday | mid | call 1 ITM 15:25 → 09:16 | ₹160 (551) | 368 | −₹349 (−₹735 … ₹60) | 0.74 | −₹134 (−0.71) | −₹119 (117) / −₹456 (251) | −₹13,296 (1 Apr 2026) | FAIL |
| | B after a down day | mid | call ATM 15:25 → 09:20 | −₹241 (322) | 236 | −₹81 (−₹668 … ₹554) | 0.94 | −₹67 (−0.20) | −₹208 (70) / −₹28 (166) | −₹12,482 (6 Mar 2026) | FAIL |
| | B after a sell-off | mid | call ATM 15:25 → 09:20 | −₹9 (63) | 48 | ₹318 (−₹1,360 … ₹2,228) | 1.19 | −₹61 (−0.05) | −₹382 (14) / ₹606 (34) | −₹12,482 (6 Mar 2026) | FAIL |
| | C1 synthetic | mid | 15:25 → 09:30 | ₹106 (720) | 479 | −₹405 (−₹1,199 … ₹382) | 0.86 | −₹276 (−0.68); vs E's session −₹377 (−0.70) | −₹202 (153) / −₹500 (326) | −₹54,035 (4 Apr 2025) | FAIL |
| | C1-B call | mid | 15:25 → 09:30 | ₹64 (720) | 479 | −₹240 (−₹620 … ₹156) | 0.83 | −₹138 (−0.68) | −₹91 (153) / −₹310 (326) | −₹12,526 (1 Apr 2026) | FAIL |
| | C2 weak session | mid | bottom 33% | −₹436 (143) | 166 | −₹1,198 (−₹2,740 … ₹267) | 0.67 | −₹1,069 (−1.40); vs E's session −₹1,406 (−1.40) | −₹293 (54) / −₹1,634 (112) | −₹54,035 (4 Apr 2025) | FAIL |
| SENSEX | B all nights | conservative | call ATM 15:20 → 09:20 | −₹304 (377) | 251 | −₹739 (−₹1,384 … −₹27) | 0.65 | −₹144 (−0.46) | – (0) / −₹739 (251) | −₹14,353 (6 Mar 2026) | **FAIL** |
| | B weekday | conservative | call ATM 15:20 → 09:20 | −₹372 (290) | 189 | −₹758 (−₹1,411 … −₹6) | 0.60 | −₹74 (−0.25) | – (0) / −₹758 (189) | −₹11,189 (18 Mar 2026) | **FAIL** |
| | B after a down day | conservative | call ATM 15:25 → 09:20 | −₹550 (174) | 123 | −₹620 (−₹1,581 … ₹459) | 0.71 | −₹92 (−0.19) | – (0) / −₹620 (123) | −₹13,816 (6 Mar 2026) | **FAIL** |
| | B after a sell-off | conservative | call ATM 15:20 → 09:16 | −₹397 (35) | 26 | −₹1,490 (−₹4,353 … ₹1,663) | 0.58 | −₹556 (−0.34) | – (0) / −₹1,490 (26) | −₹13,767 (6 Mar 2026) | **FAIL** |
| | C1 synthetic | conservative | 15:25 → 09:30 | −₹574 (375) | 251 | −₹1,148 (−₹2,415 … ₹142) | 0.72 | −₹336 (−0.51); vs E's session −₹280 (−0.33) | – (0) / −₹1,148 (251) | −₹48,228 (4 Apr 2025) | **FAIL** |
| | C1-B call | conservative | 15:25 → 09:30 | −₹284 (375) | 251 | −₹640 (−₹1,285 … ₹67) | 0.69 | −₹161 (−0.50) | – (0) / −₹640 (251) | −₹13,184 (6 Mar 2026) | **FAIL** |
| | C2 weak session | conservative | bottom 20% | −₹1,487 (41) | 53 | −₹2,465 (−₹5,894 … ₹706) | 0.55 | −₹1,476 (−0.88); vs E's session −₹2,780 (−1.30) | – (0) / −₹2,465 (53) | −₹48,228 (4 Apr 2025) | **FAIL** |
| | B all nights | mid | call 1 ITM 15:20 → 09:16 | −₹18 (362) | 251 | −₹452 (−₹1,084 … ₹248) | 0.77 | −₹266 (−0.81) | – (0) / −₹452 (251) | −₹13,872 (6 Mar 2026) | FAIL |
| | B weekday | mid | call 1 ITM 15:20 → 09:16 | −₹84 (277) | 190 | −₹444 (−₹1,102 … ₹320) | 0.74 | −₹172 (−0.54) | – (0) / −₹444 (190) | −₹13,145 (1 Apr 2026) | FAIL |
| | B after a down day | mid | call ATM 15:20 → 09:15 | −₹272 (170) | 126 | −₹259 (−₹1,153 … ₹703) | 0.86 | −₹195 (−0.42) | – (0) / −₹259 (126) | −₹13,316 (6 Mar 2026) | FAIL |
| | B after a sell-off | mid | call ATM 15:20 → 09:15 | ₹57 (35) | 26 | −₹453 (−₹3,422 … ₹2,809) | 0.85 | −₹576 (−0.34) | – (0) / −₹453 (26) | −₹13,316 (6 Mar 2026) | FAIL |
| | C1 synthetic | mid | 15:25 → 09:30 | −₹245 (375) | 251 | −₹510 (−₹1,768 … ₹772) | 0.86 | −₹376 (−0.58); vs E's session −₹357 (−0.42) | – (0) / −₹510 (251) | −₹43,844 (4 Apr 2025) | FAIL |
| | C1-B call | mid | 15:25 → 09:30 | −₹128 (375) | 251 | −₹321 (−₹969 … ₹393) | 0.83 | −₹188 (−0.58) | – (0) / −₹321 (251) | −₹12,301 (6 Mar 2026) | FAIL |
| | C2 weak session | mid | bottom 20% | −₹913 (41) | 53 | −₹1,525 (−₹4,842 … ₹1,596) | 0.69 | −₹1,388 (−0.84); vs E's session −₹2,615 (−1.24) | – (0) / −₹1,525 (53) | −₹43,844 (4 Apr 2025) | FAIL |

- **Every pick fails.**
  - Three index subsets per index pass the sample, placebo, CI and PF criteria: all nights, weekday nights and nights after an up day. All 12 index variants fail multiple testing.
  - Every option pick fails the placebo, the CI, the PF, multiple testing and the complete-bar check. The family-C picks also fail R6's same-sign rule on the other index and kill check 1.
- **No pick reached the ±20% robustness step**, so no perturbation was run and none is in the ledger.
- **The mid-fill option picks fail too, so no family is "mid only".**
- **Dates are the night's first session, D.** For example, the worst night "4 Apr 2025" runs from Friday 4 Apr to Monday 7 Apr 2025.

**What it means.**
- **The overnight drift is real in the index's official prints. It is why "the index makes its money overnight".** It has been weaker since 2025 and comes mostly after up days. The bar's multiple-testing step stops it from counting as a result here. Even if it had passed, it would describe the index, not a trade.
- **What a trader can hold carries a fraction of it.**
  - The official open is the pre-open auction's value. The official close is a 30-minute average (an auction from 3 Aug 2026). Neither is a price that a buyer at 15:25 or a seller at 09:30 gets.
  - At those minutes the index makes about +4 bp a night (NIFTY) and +2 bp (SENSEX).
  - A future or a synthetic long also pays the carry built into its price, so it keeps less still: +1.7 bp a night for NIFTY's future, below its STT.
- **An option is the wrong instrument for a 2–10 bp edge.** Every night, the buyer pays the spread and the charges (₹280–1,020 a lot at the conservative fill) to capture a direction worth ₹10–50 a lot a night at mid on NIFTY, and nothing on SENSEX. A coin flip between the call and the put did as well.
- **The program's earlier hints are explained.** WP6's +3.39% of premium for the call (bhavcopy close → first trade) and WP14's "the gain sits in the overnight gap" both measured the night from an averaged close to an auction or first-trade open. The tradeable version of that night loses.
- Nothing here supports a paper test. Rule N5 and the plan's §13 stand: no overnight holds, no real money.

---

## 1. Frozen definitions (pre-registered before any overnight mean, conditional return or P&L)

### 1.0 The question and what was known before

- **The question.** Does the overnight drift exist in NIFTY and SENSEX, and can a retail option buyer capture it after costs?
- **Why now.** WP14 (§6.4) reproduced Marketcalls' "+17% a year after FII net-long readings" close to close, but found it sits entirely in the overnight gap: from the next open to the close both FII states lost (−17.7% and −14.2% a year, Sep 2016 – Sep 2026).
- **The literature** (note R6, complete and read before this freeze, and r4):
  - Cliff, Cooper & Gulen (2008): US stocks earned their return outside trading hours (R6 saw only press coverage).
  - Lou, Polk & Skouras (2019, *JFE* 134): cross-sectional strategy profits accrue entirely overnight or entirely intraday, a tug of war between clienteles. A cross-sectional result, not an index-timing rule.
  - Boyarchenko, Larsen & Whelan (NY Fed Staff Report 917): S&P 500 futures returns concentrate in an overnight window, and sell-offs are followed by positive overnight reversals. Close → open earned 4.62% a year at mid quotes and 0.38% after the bid–ask (2004–2020); "buy the dip" overnight kept 4.04% after the spread. Their 2026 update: the drift has averaged close to zero since 2021.
  - Muravyev & Ni (2020): delta-hedged S&P options lose about 1% close → open.
  - India: four write-ups (2020–2026), all gross of costs and in sample, agree that since 2011 NIFTY's return has come overnight. R6's arithmetic puts it at about 9, 7 and 4 bp a night in successive samples (2007–2020, 2015–2026, 2024–2026).
- **What the program's own data already showed.** These priors are why this is not a blind test of the sign:
  - WP6 (bhavcopy prints, NIFTY Feb 2019 – Oct 2026, 1,866 nights): the ATM straddle bought at NSE's close and sold at the next first trade returned +0.01% for the buyer; the call +3.39% and the put −3.24% of premium (t 3.5 and −3.4), gross. That night starts at a 30-minute VWAP and ends on the first print, which WP11 found rich, so it flatters the call.
  - Q1 (Jan 2024 – Oct 2026): +4.2 bp overnight, −3.9 bp open → close. Q2: NIFTY rose from open to close on 46.7% of days since 2011 (mean −0.07%).
  - WP14 §6.4: close to close positive and open to close negative in every window, state and era.
- **So the expected sign of NIFTY's unconditional overnight mean is positive.** What this study fixes before computing it: the bar it must clear out of sample, its placebos, the night subsets, the option expression, the three published variants and the tails.
- **Rule N5** ("no overnight holds") exists for gap risk. This study measures that risk (§1.7) as well as the mean.

### 1.1 Data

- **Daily index bars:** Yahoo ^NSEI and ^BSESN (official open, high, low and close), from Dec 2010 to 8 Oct 2026; a row with a missing field is no bar. India VIX: Yahoo ^INDIAVIX daily closes.
- **1-minute prices:** WP13's extract (`scripts/research/wp13_extract.py`) of the TradeMarkk dataset. For every session it holds the index bars 09:00–15:59 and, for the nearest expiry on or after the day (A) and the next one (N), every strike within max(6.5 steps, 2.6 expected moves + 1 step) of the index range of the session and the three sessions before it, bars 09:15–15:30. A strike chosen on D therefore stays in E's file. NIFTY: option files 24 May 2021 – 2 Jul 2026; SENSEX: 7 Aug 2023 – 2 Jul 2026 (SENSEX index bars from 1 Sep 2022).
- **Bars** (WP11 §1.1): `m` is the IST minute the bar starts; a bar holds the trades in [m, m + 1). A bar with zero volume is no trade.
- **Two data eras** (WP11 §2): bars to 31 Dec 2024 hold every trade; bars from 1 Jan 2025 are built from sampled prices. Closes, the last trade and the volume are still exact, but the day's first trade and most intraday extremes are missing, so the conservative fill is a true worst case only in the first era.
- **Valid 1-minute sessions** (WP11 §1.1): at least 370 index bars starting 09:15–15:29 with a 09:15 bar, a bhavcopy of the index's own exchange (NSE for NIFTY, BSE for SENSEX), and not a special session (§1.2).
- **Bhavcopies:** the listed expiries and the lot (the modal lot of a contract's rows on the day) of the index's own exchange. Sessions to expiry (DTE): NSE sessions after the day up to and including the expiry (WP10's convention, for both indices).

### 1.2 Sessions and nights

- **The calendar** is every date with a complete Yahoo bar of either index (from Dec 2010), an NSE or BSE bhavcopy, an NSE participant-OI file, or a Muhurat session.
- **Special sessions** are never the start or the end of a night:
  - weekend sessions (a Saturday or Sunday date in the calendar);
  - NSE's Diwali Muhurat sessions, about an hour each: 26 Oct 2011 and WP14's 14 dates for 2012–2025;
  - the bhavcopy's short sessions (WP6's rule: NIFTY option contracts below 0.3× the quietest of the three sessions on either side, from Feb 2019).
- **A night** runs from a regular session D to the next regular session E. A night with a special session between D and E (a Saturday Budget session, a Muhurat session) holds trading, not just a gap, and is skipped (counted).
- **Kind of night** (`nightKind`):
  - *weekday*: E is the next calendar day;
  - *weekend*: only Saturdays and Sundays lie between D and E;
  - *holiday*: a weekday without a session lies between them (R6's "pre-holiday" nights).
- **Index nights** start on or after 1 Jan 2011 (NSE's and BSE's pre-open call auction sets the official open from Oct 2010). D and E need complete Yahoo bars. A night on which E's open equals D's close exactly is a stale open and is skipped.
- **The index night return** is r = open(E) ÷ close(D) − 1, at the official open and close. **The intraday leg** of the same night is p = close(E) ÷ open(E) − 1.
- **The change of D** is close(D) ÷ close(D⁻) − 1, where D⁻ is the regular session before D. It is unknown when D⁻ has no complete bar.
- **The India VIX tercile** of a night: the VIX close of the last session before D, ranked within its trailing 250 closes (`trailingRank`): low below 1/3, high above 2/3.

### 1.3 A. Index direction: does the drift exist?

- **Variants (12):** for each index (NIFTY, SENSEX), long from close(D) to open(E) on:
  - all nights;
  - weekday nights;
  - weekend and holiday nights;
  - after a down day (change < 0);
  - after an up day (change > 0);
  - after a sell-off (change ≤ −1%).
- **These are fixed hypotheses.** No sign or subset is picked: the long side is the hypothesis, and each variant is judged on its own last 40%.
- **The cut**, per index: the last D of the first ⌈0.6 n⌉ valid nights (all nights). In sample: nights whose E is on or before the cut; out of sample: nights whose D is after it.
- **Statistics:**
  - The mean per night (per trade) and per session: every valid night of the window counts, nights outside the subset as 0.
  - A circular block bootstrap (`blockBootstrap`) with blocks of 5 sessions; 20,000 resamples (100,000 when both lower bounds are above zero); seed 7; one-sided p = (1 + #{resamples ≤ 0}) / (1 + resamples).
  - The hit rate (r > 0) with its Wilson interval, and the profit factor of r over the subset's nights.
- **Placebos:**
  - (a) *The intraday leg of the same nights* (E's open → close). The gap is the mean of r − p over the subset's nights, with the SE of the same block bootstrap of that series.
  - (b) *A fair-coin side* on the same nights. Its expectation is 0, so the gap is the mean, with its bootstrap SE.
- **Splits** (descriptive): each calendar year; the two halves of each variant's nights; D to 2019 against D from 2020; the night kind; the VIX tercile.

### 1.4 B. The retail option buyer on real 1-minute prices

- **Nights:** the calendar's nights with D from the first session with an option file (NIFTY 24 May 2021, SENSEX 7 Aug 2023) and E by 2 Jul 2026. D and E must be valid 1-minute sessions.
- **Contract:** the nearest listed expiry with at least 2 sessions to expiry at D (plan rule N4: never one expiring the next session), present in the extract on D and on E. One lot, at the lot in force on D.
- **Strike:** *ATM* is the listed strike (call and put both have bars on D) nearest the index level known at the order, the close of the index bar before the entry minute; a tie goes to the lower strike. *1 ITM* is the next listed strike below the ATM.
- **Orders:**
  - Buy the call at **15:20 or 15:25** on D, filled in its first bar within [m, m + 2].
  - Sell it at **09:15, 09:16 or 09:20** on E, filled in its first bar within [m, m + 5]. Without one it sells at the last close before m on E (a stale exit, counted); without any bar by then the night has no exit price and is skipped (counted).
  - No stop.
- **Fills** (WP11 §1.2): *conservative*, the verdict case (buy at the 1-minute bar's high, sell at its low); *mid* (the bar's close). No further spread.
- **Charges:** `computeCharges` per order at the rates in force on the day (`RESEARCH_CHARGE_SCHEDULES`, through `structurePnl`): STT on option sales 0.05% → 0.0625% (Apr 2023) → 0.1% (Oct 2024) → 0.15% (Apr 2026); dated exchange charges; ₹20 brokerage per order; SEBI fee, stamp duty on buys, IPFT, GST. NSE for NIFTY, BSE for SENSEX. The entry pays D's rates, the exit E's.
- **Night filters**, known at the order:
  - all nights;
  - weekday nights;
  - after a down day: the index at the order below the previous session's official close (Yahoo);
  - after a sell-off: at least 1% below it.
- **Both sides priced:** the mirrored put must fill at the same minutes for a night to count, because the placebo needs it. The mirrored put is at the ATM strike for an ATM call, and at the next strike above the ATM for a 1-ITM call. A night without it is skipped (counted).
- **Variants (192):** 2 indices × 4 filters × 2 entries × 3 exits × 2 strikes × 2 fills.
- **The cut**, per index: the last D of the first ⌈0.6 n⌉ trade nights of the base variant (all nights, ATM, 15:20 → 09:15, conservative). The same cut serves every option variant of that index, in families B and C.
- **The pick:** per index, filter and fill, the variant with the best in-sample mean per trade among the 12 timings and strikes (`pickBest`, ties by name), then judged untouched on the last 40%. That is 16 picks. The verdict is decided at the conservative fill; the mid pick is judged by the same criteria and reported beside. A family that passes only at mid is *mid only*: not actionable without quotes.
- **Placebo:** a fair coin between the call and the mirrored put at the same minutes (`fairCoinDays`). Its exact expectation on a night is (call + put) / 2, so the gap is the mean of (call − put) / 2: what choosing the call adds over the straddle's overnight P&L. Its SE is cluster-robust by night (`pairedGap`).
- **Statistics:** a night-clustered bootstrap (`dayBlockBootstrap`, each night a block), per trade and per session. Every slot counts, a slot being a night with both sides priced and the filter's input known; nights the filter rejects count as ₹0. 20,000 resamples (100,000 when both lower bounds are above zero), seed 7.
- **Splits** (descriptive): years; halves; the two data eras; before and from 1 Apr 2026 (the STT rise); the night kind; the VIX tercile.

### 1.5 C. R6's published variants (untuned)

These are R6's candidate cards C1 and C2 (§6 of the note), at most three variants, with R6's own parameters.

- **C1, the synthetic long** (₹5 lakh account only: the short put needs margin, which is not modelled).
  - At **15:25** on D (fills in [15:25, 15:27]), buy the call and sell the put at **K(fwd)**, the listed strike nearest the synthetic forward known at the order.
  - The forward is the median, over the three listed strikes nearest the index level, of K + C − P, each leg at its last close at or before 15:24. Both bars must have started within the 5 minutes before the order. Without one, the night has no forward and is skipped.
  - At **09:30** on E (fills in [09:30, 09:35]), sell the call and buy back the put.
  - Same contract rule (N4), lot, fills and charges as §1.4.
- **C1-B, the single long call** at K(fwd), the same minutes. This is the retail variant.
  - Its P&L is decomposed (mid fills, gross) in two ways: as ½ (call − put) plus ½ (call + put), the directional half and half the straddle; and as 0.5 × the index move × lot plus the rest (theta, vega and the opening print).
- **C2, the synthetic long after a weak session:**
  - C1 only on nights when D's session was weak. The session return is the index from 09:30 to 15:25 (the close of the 15:24 bar ÷ the close of the 09:29 bar − 1).
  - Three thresholds, fixed by R6: the return in the bottom 20% or the bottom 33% of its trailing 250 sessions (the rank as `trailingRank`: the share below plus half the ties, the session itself included), or below −0.5%.
  - A night is eligible only once 250 ranked sessions exist, for all three thresholds.
  - The threshold is picked on the first 60% (the same cut), per index and fill, and judged on the last 40%.
- **Placebos:**
  - C1 and C2: a fair coin between the long and the short synthetic (short call, long put) at the same minutes, so the gap is (long − short) / 2.
  - C1 and C2: the same synthetic held over E's session instead (bought at 09:30 and sold at 15:25 on E, `runPosition`, no stop); the gap is the night minus that session, paired by night.
  - Both gaps must be at least 2 SE.
  - C1-B: a fair coin between the call and the put at K(fwd).
- **The bar:** §1.6 criteria 1–7, plus R6's own rules:
  - 8. The same sign on the other index: the same variant's last-40% mean above zero on SENSEX for NIFTY, and on NIFTY for SENSEX, at the same fill. For C2 the other index's own pick is used, since each index picks its threshold on its own first 60%.
  - 9. Kill check 1: the net above zero on the nights from 1 Apr 2026, when STT rose.
  - 10. Kill check 2 (for the base timings): on the complete-bar nights (to Dec 2024), the same position exited at the first print (the 09:15 bar's open, the exchange's first trade in that era) against R6's 09:30. A gain at the first print (> 0) that is gone at 09:30 (≤ 0) is an opening-print artefact and kills the variant.
  - 11. C2 only: it must beat C1 on the same nights, meaning C2's mean minus the mean over every eligible night has a bootstrap CI above zero (10,000 resamples). It must also beat a random draw of the same number of nights from the same out-of-sample nights (p < 0.05, 10,000 draws).
- **Robustness** (R6's list): entry 15:20 / 15:28; exit 09:20 / 09:45; strike K(fwd) ± 1. C2 also moves its threshold to 0.8× and 1.2× its value.
- **Variants (20):** 2 indices × (C1, C1-B, and C2's three thresholds) × 2 fills. **Picks (12):** C1, C1-B and C2's pick, per index and fill.

### 1.6 The bar (plan §12)

**Index variants** ("does the drift exist?"; 12):
1. **At least 180 out-of-sample nights.**
2. **Both placebo gaps at least 2 SE** out of sample.
3. **Block-bootstrap 95% CI above zero** out of sample, per night and per session.
4. **PF ≥ 1.3** out of sample.
5. **±20% robustness:** only the sell-off subset has a parameter (thresholds −0.8% and −1.2%), run when criteria 2–4 pass. The other subsets have nothing to perturb (N/A).
6. **Multiple testing:**
   - Bonferroni: the larger of the per-trade and per-session bootstrap p-values must be below 0.05 / N, where N is the number of lines in `reports/trials.jsonl` after this study's lines are appended (2,814 before).
   - The deflated Sharpe ratio of the out-of-sample per-session returns must be at least 0.95. N comes from the ledger and V[SR] from this study's index lines; the 1/(T − 1) version is reported too.

**Option picks** ("can a buyer capture it?"; 16 in family B, 12 in family C; the verdict at the conservative fill):
1. **At least 180 out-of-sample trades.**
2. **Placebo gap at least 2 SE** out of sample (§1.4, §1.5).
3. **Night-clustered 95% CI above zero** out of sample, per trade and per session.
4. **PF ≥ 1.3** out of sample.
5. **±20% robustness**, run only for picks that pass criteria 2–4:
   - Family B, six perturbations: the entry at the two other values of 15:15 / 15:20 / 15:25; the exit at 09:30 and at the nearest other value of 09:15 / 09:16 / 09:20; the strike one step either way (ATM → 1 OTM and 1 ITM; 1 ITM → ATM and 2 ITM).
   - The sell-off picks also move the threshold to −0.8% and −1.2%.
   - Family C: R6's list (§1.5).
   - The rule (`robustness`): at least 80% of the perturbed variants with out-of-sample net above zero, and the worst no lower than base − 50% × |base|.
6. **Multiple testing** as above; V[SR] from this study's option lines.
7. **Complete-bar era:** the variant's trades with D to 31 Dec 2024, in and out of sample, must have a mean above zero with a night-clustered CI above zero (10,000 resamples).

Plus R6's criteria 8–11 for family C (§1.5).

- **Verdicts** (`overallVerdict`): *PASS* when every criterion passes; *INSUFFICIENT* when the sample size is the only failure; *FAIL* otherwise. A criterion not run because an earlier one failed counts as a failure.
- **A paper-test spec is written only for a pick that passes.**
- **The copy delay:** criterion 5's later entry (15:25 for a 15:20 pick) and later exit (09:30) are a hand copier's delay. The independent review for look-ahead bias is the cross-check script (`wp15-xcheck.py`).

### 1.7 D. Descriptive series and the tails

- **D1, the bridge.** On the nights valid in both the index family and the 1-minute sample, three measures:
  - the official close → open;
  - D's 15:29 bar close → E's 09:15 bar open;
  - the index's bar closes 15:20 and 15:25 → 09:15, 09:16 and 09:20, and 15:25 → 09:30.

  Together they show how much of the official overnight return falls in minutes a buyer can trade.
- **D2, near-month futures** (robustness only):
  - The nearest futures expiry after D that traded on D (a closing price) and on E (an open). The measure is E's open ÷ D's closing price − 1, and ₹ per lot at D's lot.
  - NIFTY from Feb 2019 (NSE); SENSEX from 15 May 2023 (BSE). NSE's last trade → open is reported from 2024, when the UDiFF files carry the last trade.
  - The sell-side STT at E's open is reported at its dated rate: 0.01% → 0.0125% (Apr 2023) → 0.02% (Oct 2024) → 0.05% (Apr 2026). These are the Finance Act dates the option schedule already encodes, and R6 [K1] for 2026. Other futures charges are not modelled.
- **D3, the ATM call at end-of-day prints:**
  - The call is bought at the exchange's closing price on D and sold at the next session's first trade. Its strike is nearest the official close, among calls that traded; the contract follows N4; dated charges apply; WP6's bad-print filter is used.
  - NIFTY from Feb 2019, SENSEX from May 2023. It gives the tails before the 1-minute data (2020).
- **D4, the overnight straddle:** the ATM call plus put, 15:20 → 09:15, both fills (the placebo's expectation × 2).
- **Tails** (required), for every option pick:
  - the 10 worst nights (₹ per lot, dated);
  - the worst 5% and 1% of nights: the value at risk (the count-th worst night) and the expected shortfall (their mean);
  - the maximum drawdown of cumulative ₹ at one lot a night, also as % of ₹5 lakh and of ₹10,000;
  - the longest losing run;
  - the share of nights whose one-lot premium exceeds ₹10,000, which the small account cannot buy.
- **What a stop cannot do overnight:**
  - For each pick: the nights on which the exit fill was already 30% (or 50%) below the entry fill. A stop at that level could not have filled there, because nothing trades overnight. The study reports their number and the mean ₹ per lot lost beyond the stop (`gapThroughStop`). For a synthetic (C1, C2) this is computed on its call leg; the synthetic itself has no premium cap, and its gap risk is the index's.
  - For the index: the nights with a gap ≤ −1%, ≤ −2% and ≤ −3%, and the mean beyond a 1% or a 2% stop.
- **Index tails:** the 10 worst nights 2011–2026 and the 5% and 1% value at risk and expected shortfall. Also a futures lot's 8 worst nights (2019–2026).
- **Named nights:** the nights into 13 Mar 2020 and 23 Mar 2020 (two COVID-crash gaps) and into 4 and 5 Jun 2024 (the election result), on every series that covers them.

### 1.8 Ledger

- One line per evaluated variant in `reports/trials.jsonl` with `wp: "WP15"`:
  - the 12 index variants and any perturbations run;
  - the 212 option variants (192 in family B, 20 in family C) and any perturbations run;
  - the descriptive lines (bridge, futures, end-of-day calls, straddles).
- Index, bridge and futures lines carry `net` and `meanPerTrade` in **index basis points, not rupees** (`params.unit` says so). Variants already logged are not appended again.

### 1.9 Tested before this freeze

- The `coverage` command reads bars, sessions and counts only. It runs data-quality checks: missing fields, stale opens, Yahoo against two other sources, and the two indices' gaps against each other as a correlation and counts of large disagreements, with no mean. No overnight mean, conditional return or P&L.
- A `--smoke` run of the whole pipeline (statistics, verdicts, tables) without the ledger, in which **every price-derived value was replaced by a deterministic synthetic number** (an FNV-1a hash of its key) and the night conditions by a fixed cycle. Its tables are marked as synthetic and say nothing about the data.

---

## 2. Data and samples (before any P&L)

Everything in this section comes from bars, sessions, file lists and counts (`wp15-overnight-drift.ts coverage`). No overnight mean, conditional return or P&L entered it. The only price comparisons are the data-quality checks of §2.1.

### 2.1 The daily index series

| index | rows from Dec 2010 | rows with a missing field (from 2011) | of them regular sessions of the calendar | stale opens (open = previous close) | open or close outside the high–low | against the bhavcopy cache's own Yahoo download (Oct 2016 –): days, > 0.5 pt apart | against NSE's official close (UDiFF, Jan 2024 –): days, > 0.5 pt apart |
|---|---|---|---|---|---|---|---|
| NIFTY | 3,917 | 27 | 19 | 2 (27 Apr 2012, 2 Nov 2017) | 0 | 2,465, 0 | 679, 0 |
| SENSEX | 3,917 | 22 | 13 | 1 (20 Jul 2026) | 0 | 2,462, 0 | – (BSE's file has no index close) |

- **Missing fields.** Most are holidays, special sessions or days without a session. The regular sessions without a complete bar are:
  - NIFTY: 31 May, 14 Jul, 24 Nov and 26 Dec 2011; 2 Jan, 21 May, 28 Aug and 26 Oct 2012; 1 Jan 2013; 1 Jan and 17 Feb 2014; 1 Jan and 15 Apr 2015; 1 Jan and 12 Aug 2016; 1 Jan 2018; 1 Jan, 13 Feb and 29 Mar 2019.
  - SENSEX: 2 Jan and 26 Oct 2012; 1 Jan 2013; 26 and 29 Dec 2014; 1 Jan 2015; 1 Jan 2016; 1 Jan, 13 Feb and 29 Mar 2019; 1 Jan 2020; 7 May 2021; 1 Jan 2024.
  - A night touching one of these is skipped. So is a night with a stale open.
- **Against the 1-minute index bars** (TradeMarkk):
  - The official open differs from the 09:15 bar's open by a median 3.5 bp for NIFTY (1,248 sessions; 99th percentile 20.5 bp, maximum 71 bp) and 4.4 bp for SENSEX (759; 34.2 bp, 93 bp).
  - The official close differs from the last 1-minute print by a median 4.5 bp and 4.2 bp. The official close is set from the constituents' closing prices, a 30-minute VWAP.
  - The official open is the pre-open auction's index value, and on gap days the index can move far in the first minute. On 2 Mar 2026 SENSEX's official open was 78,544; its 09:15 bar opened at 78,689 and closed at 80,194. On 5 Aug 2024 the open was 78,588 and the 09:15 bar opened at 79,322. NIFTY's official open on 5 Aug 2024 equals its 09:07 pre-open print (24,302.85).
  - This is why the option family trades real minutes and the bridge (§1.7, D1) measures the difference.
- **The two indices' gaps against each other.** R6 warned that Yahoo's early SENSEX opens may be bad.
  - The correlation of NIFTY's and SENSEX's close → open gaps is 0.93–0.99 in every year from 2011 to 2026.
  - The two gaps differ by more than 1 percentage point on 5 nights: those starting 20, 23 and 27 Mar 2020 (the COVID-crash opens), 2 Aug 2024 (into 5 Aug) and 27 Feb 2026 (into 2 Mar). In the last two, SENSEX's official open sits far below its 09:15 trades.
  - No year shows a stale or broken open series. The pre-2011 opens R6 suspected are outside this sample.

### 2.2 Sessions and nights

- **The calendar:** 3,929 sessions, 1 Dec 2010 – 9 Oct 2026. They come from complete Yahoo bars of either index, the NSE bhavcopy (11 Feb 2019 –), the BSE bhavcopy (15 May 2023 –), 3,658 NSE participant-OI file dates (2 Jan 2012 –) and the Muhurat days.
- **Special sessions from 2011:** 26.
  - Muhurat: 26 Oct 2011, 13 Nov 2012, 3 Nov 2013, 23 Oct 2014, 11 Nov 2015, 30 Oct 2016, 19 Oct 2017, 7 Nov 2018, 27 Oct 2019, 14 Nov 2020, 4 Nov 2021, 24 Oct 2022, 12 Nov 2023, 1 Nov 2024 and 21 Oct 2025.
  - Weekend and drill sessions: 7 Jan, 3 Mar and 8 Sep 2012; 22 Mar 2014; 28 Feb 2015; 1 Feb 2020; 20 Jan, 2 Mar and 18 May 2024; 1 Feb 2025; 1 Feb 2026.

| year | 2011 | 2012 | 2013 | 2014 | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 (to 8 Oct) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| regular sessions | 246 | 246 | 248 | 242 | 246 | 246 | 247 | 245 | 244 | 250 | 247 | 247 | 245 | 245 | 247 | 190 |
| special sessions | 1 | 4 | 1 | 2 | 2 | 1 | 1 | 1 | 1 | 2 | 1 | 1 | 1 | 4 | 2 | 1 |
| weekday holidays | 13 | 14 | 13 | 18 | 14 | 15 | 12 | 15 | 17 | 12 | 13 | 12 | 15 | 16 | 13 | 12 |

**Index nights (D from 1 Jan 2011 to 7 Oct 2026; counts only):**

| index | candidate nights | skipped | valid nights | weekday / weekend / holiday | after a down day / an up day / a sell-off ≤ −1% | change unknown | **cut after** | last 40%: all / weekday / weekend and holiday / down / up / sell-off |
|---|---|---|---|---|---|---|---|---|
| NIFTY | 3,880 | 39 no complete bar on D or E; 26 span a special session; 2 stale opens | 3,813 | 2,909 / 706 / 198 | 1,789 / 2,001 / 441 | 19 | **15 Jul 2020** | 1,525 / 1,165 / 360 / 701 / 823 / 156 |
| SENSEX | 3,880 | 26 no complete bar; 26 span a special session; 1 stale open | 3,827 | 2,922 / 706 / 199 | 1,816 / 1,999 / 442 | 12 | **1 Jul 2020** | 1,530 / 1,171 / 359 / 716 / 812 / 161 |

- The India VIX tercile is known on every valid night (VIX from 2008).

### 2.3 The exchange calendars

- **The NSE bhavcopy cache** misses one regular session, 30 Mar 2021, before the 1-minute sample starts. Futures and end-of-day nights touching it are skipped.
- **The BSE cache** misses 7 NSE sessions: 28 Jun and 25 Jul 2023; 2 Aug, 29 Aug and 29 Nov 2024; 10 Feb and 2 Sep 2025. BSE has no file NSE lacks.
  - Without the BSE file, SENSEX has no lot or expiry list that day, so it is not a valid 1-minute session.
  - The nights touching these dates are skipped for SENSEX, never merged into a two-session "night". This is why the option, futures and end-of-day nights use the full calendar rather than one exchange's file list.
- **Short sessions** by WP6's volume rule: 27 Oct 2019, 14 Nov 2020, 4 Nov 2021, 12 Nov 2023, 2 Mar 2024, 18 May 2024, 1 Nov 2024 and 21 Oct 2025.

### 2.4 The option samples (bar presence only)

| index | nights in the option range | skipped before any bar | base B nights (ATM call and put, 15:20 → 09:15) | **cut after** | first 60% / last 40% | last 40%: to Dec 2024 / from 2025 / from 1 Apr 2026 | last 40% by filter (at 15:20): all / weekday / down / sell-off | C1 nights (15:25 → 09:30) | C2 nights with a rank | DTE at entry |
|---|---|---|---|---|---|---|---|---|---|---|
| NIFTY | 1,257 | 33 contract missing on D or E; 15 not valid sessions; 10 span a special session | 1,199 | **15 May 2024** | 720 / 479 | 153 / 326 / 35 | 479 / 368 / 240 / 48 | 1,199 | 956 | 2: 254, 3: 250, 4: 250, 5: 250, 6: 193, 7: 2 |
| SENSEX | 710 | 43 contract missing; 16 not valid; 8 span a special session | 628 | **9 Apr 2025** | 377 / 251 | 0 / 251 / 32 | 251 / 189 / 126 / 26 | 626 | 451 | 2: 138, 3: 139, 4: 134, 5: 129, 6: 100, 7: 3 |

- A missing contract is the N4 contract without a file in the extract on D or on E. For SENSEX this includes the dataset's expiry gaps (no weekly file between 25 Oct and 8 Nov 2024, 26 Aug and 4 Sep 2025, 23 Oct and 6 Nov 2025, and 21 May and 9 Jul 2026; WP13's manifest).
- **NIFTY's 1-minute index starts on 24 May 2021**, so its first 250 sessions (to about May 2022) have no C2 rank. SENSEX's index starts on 1 Sep 2022, so C2 covers almost all of its option nights.
- **Every one of SENSEX's last-40% nights falls in the sampled-bar era.** NIFTY's last 40% has 153 complete-bar nights.

### 2.5 Futures and end-of-day calls (bhavcopy; counts only)

| index | futures nights (near month traded on D and E) | first / last D | skipped | from 1 Apr 2026 | ATM call close → open nights | skipped |
|---|---|---|---|---|---|---|
| NIFTY | 1,868 | 11 Feb 2019 / 7 Oct 2026 | 13 span a special session; 3 without an NSE file on D or E; 1 not traded on E | 129 | 1,864 | 13 span; 4 without a contract with ≥ 2 sessions or an index close; 3 without a file; 1 bad opening print |
| SENSEX | 815 | 15 May 2023 / 7 Oct 2026 | 15 without a BSE file on D or E; 8 span | 129 | 808 | 15 without a file; 8 span; 4 without a contract or a close; 3 the call did not trade |

### 2.6 What this fixes before any P&L

1. **Index:** the five subsets other than the sell-off reach 180 out-of-sample nights (359–1,530). **The sell-off subsets cannot** (156 NIFTY, 161 SENSEX): *INSUFFICIENT* at best.
2. **Options, family B:**
   - NIFTY: all nights (479), weekday (368) and down-day (240) can reach 180 trades out of sample. The sell-off filter (48) cannot.
   - SENSEX: all nights (251) and weekday (189) can. Down-day (126) and sell-off (26) cannot.
3. **Family C:**
   - C1 and C1-B can reach 180 (about 479 NIFTY and 250 SENSEX nights out of sample).
   - **C2 cannot.** A rank threshold of 1/3 selects about a third of the eligible nights (≈ 160 NIFTY, ≈ 84 SENSEX out of sample) and 20% fewer still: *INSUFFICIENT* at best. Its other criteria are still reported.
4. **SENSEX's last 40% lies wholly in the sampled-bar era**, where the conservative fill is not a true worst case. Its complete-bar check (criterion 7) leans on SENSEX's first 60% (Aug 2023 – Dec 2024).
5. **The index's last 40% begins in July 2020** (after the COVID crash, through the rally and the 2024–26 period); its first 60% covers 2011 – mid-2020.
6. **The post-STT-rise window is short:** 35 NIFTY and 32 SENSEX option nights from 1 Apr 2026. R6's kill check 1 rests on that small sample.

---

## 3. Does the drift exist? The index nights

### 3.1 Every index variant, by sample

Each row is long from D's official close to E's official open. "Nights" counts the subset's nights, and "per night" is the mean over them. CIs come from the circular block bootstrap (blocks of 5 sessions).

| variant | nights | per night (95% CI) | hit | PF | E's open → close | first 60% (n) | last 40% [CI] (n) | 2011–2019 / 2020–2026 | first / second half |
|---|---|---|---|---|---|---|---|---|---|
| NIFTY all | 3,813 | +10.2 bp (+8.1 … +12.1) | 64.7% | 1.68 | −6.3 bp | +10.5 bp (2,287) | +9.6 bp [+6.7 … +12.4] (1,525) | +10.5 / +9.7 bp | +10.0 / +10.3 bp |
| NIFTY weekday | 2,909 | +10.8 bp (+8.8 … +12.7) | 64.9% | 1.80 | −5.6 bp | +10.9 bp (1,743) | +10.5 bp [+7.9 … +13.2] (1,165) | +10.5 / +11.1 bp | +10.0 / +11.5 bp |
| NIFTY weekend and holiday | 904 | +8.2 bp (+2.9 … +13.1) | 64.2% | 1.41 | −8.6 bp | +9.3 bp (544) | +6.5 bp [−1.5 … +14.2] (360) | +10.6 / +4.9 bp | +10.0 / +6.3 bp |
| NIFTY after a down day | 1,789 | +5.8 bp (+2.9 … +8.8) | 60.5% | 1.32 | −7.4 bp | +7.9 bp (1,088) | +2.6 bp [−1.7 … +7.0] (701) | +6.1 / +5.4 bp | +5.7 / +5.9 bp |
| NIFTY after an up day | 2,001 | +14.1 bp (+11.5 … +16.5) | 68.5% | 2.16 | −5.2 bp | +13.0 bp (1,177) | +15.5 bp [+12.2 … +18.7] (823) | +14.7 / +13.4 bp | +14.2 / +14.0 bp |
| NIFTY after a sell-off ≤ −1% | 441 | +4.8 bp (−4.2 … +13.6) | 57.6% | 1.17 | −0.6 bp | +5.3 bp (285) | +3.9 bp [−9.7 … +16.9] (156) | +1.6 / +9.1 bp | +2.0 / +7.6 bp |
| SENSEX all | 3,827 | +12.8 bp (+10.9 … +14.7) | 69.1% | 2.05 | −9.1 bp | +15.1 bp (2,296) | +9.4 bp [+6.5 … +12.3] (1,530) | +14.8 / +10.1 bp | +14.1 / +11.5 bp |
| SENSEX weekday | 2,922 | +13.4 bp (+11.6 … +15.3) | 69.7% | 2.25 | −8.4 bp | +15.0 bp (1,750) | +11.1 bp [+8.4 … +13.7] (1,171) | +14.4 / +12.1 bp | +13.7 / +13.1 bp |
| SENSEX weekend and holiday | 905 | +10.8 bp (+5.9 … +15.6) | 67.2% | 1.64 | −11.5 bp | +15.3 bp (546) | +4.0 bp [−4.3 … +12.1] (359) | +16.1 / +3.7 bp | +15.5 / +6.1 bp |
| SENSEX after a down day | 1,816 | +9.1 bp (+6.3 … +11.9) | 65.0% | 1.61 | −10.0 bp | +13.3 bp (1,100) | +2.6 bp [−1.9 … +7.1] (716) | +11.6 / +5.8 bp | +10.7 / +7.5 bp |
| SENSEX after an up day | 1,999 | +16.2 bp (+13.8 … +18.5) | 72.8% | 2.67 | −8.1 bp | +16.6 bp (1,186) | +15.5 bp [+12.2 … +18.9] (812) | +17.8 / +14.2 bp | +17.1 / +15.3 bp |
| SENSEX after a sell-off ≤ −1% | 442 | +7.8 bp (−0.9 … +16.5) | 60.4% | 1.32 | −2.2 bp | +12.4 bp (281) | −0.4 bp [−14.5 … +13.4] (161) | +8.7 / +6.5 bp | +7.9 / +7.7 bp |

- **The drift is positive in every window of the all-nights series:** both halves, both regimes, and the first 60% and last 40% of both indices.
- **The open → close leg is negative in every subset** (−0.6 to −11.5 bp). The index's close-to-close return is a positive night plus a negative day. This is what WP14 §6.4 saw.
- **The drift follows the day's direction; it does not reverse it.**
  - After an up day it is +14.1 bp (NIFTY) and +16.2 bp (SENSEX); after a down day +5.8 and +9.1 bp. The order is the same in both halves of the sample.
  - After a fall of 1% or more it is +4.8 and +7.8 bp, with CIs that include zero.
  - Out of sample, the nights after a sell-off show nothing: +3.9 bp (156 nights) and −0.4 bp (161).
  - Boyarchenko, Larsen & Whelan's overnight reversal after US sell-offs does not appear in NIFTY or SENSEX.
- **SENSEX's first 60% is stronger than its last 40%** (+15.1 against +9.4 bp), while NIFTY's is level (+10.5 against +9.6). R6 suspected SENSEX's early Yahoo opens. §2.1 found no stale or broken open series from 2011, and the two indices' gaps correlate at 0.93–0.99 in every year.

### 3.2 By year, kind of night and India VIX

| year | 2011 | 2012 | 2013 | 2014 | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 (to 8 Oct) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| NIFTY nights | 236 | 233 | 245 | 236 | 240 | 242 | 244 | 242 | 238 | 248 | 246 | 246 | 244 | 241 | 245 | 187 |
| NIFTY per night | +4.4 bp | +7.7 | +8.8 | +10.9 | +12.5 | +10.3 | +16.4 | +9.1 | +14.6 | +19.0 | +18.3 | +2.6 | +12.6 | +9.6 | +3.6 | −0.6 |
| NIFTY up share | 54% | 57% | 56% | 68% | 67% | 68% | 75% | 71% | 71% | 71% | 72% | 60% | 68% | 65% | 59% | 48% |
| SENSEX per night | +10.8 bp | +11.5 | +12.2 | +15.0 | +17.0 | +13.5 | +16.9 | +15.9 | +20.8 | +23.7 | +20.0 | +0.7 | +8.9 | +10.5 | +3.1 | +2.1 |
| SENSEX up share | 65% | 64% | 60% | 75% | 75% | 73% | 83% | 79% | 84% | 72% | 76% | 57% | 63% | 66% | 60% | 51% |

- **The drift was largest in 2017–2021 and has faded since.** 2022 was almost flat (+2.6 and +0.7 bp). 2025 made +3.6 bp (NIFTY) and +3.1 bp (SENSEX); 2026 to 8 Oct made −0.6 bp and +2.1 bp. This matches R6's arithmetic (about 9, 7 and 4 bp a night in successive samples) and the NY Fed's 2026 update for the S&P 500 (close to zero since 2021).
- **It is a per-night effect, not a per-calendar-day one.**
  - Weekday nights: +10.8 bp NIFTY (CI +8.7 … +12.7) and +13.4 bp SENSEX.
  - Weekend nights span three calendar days and earn less than one weekday night: +5.4 bp (CI −0.7 … +10.9) and +8.5 bp (+3.3 … +13.9).
  - Nights with a weekday holiday inside (R6's pre-holiday nights) earn the most: +18.1 bp (CI +7.6 … +29.2; 198 nights) and +18.8 bp (+8.9 … +28.8; 199). That subset was a split, not a variant, and it is too small to reach 180 out-of-sample nights.
- **By the India VIX tercile** (the previous close within its trailing 250):
  - NIFTY: low +8.1 bp (CI +6.0 … +10.2), middle +11.5 bp, high +11.4 bp (+6.3 … +16.3).
  - SENSEX: low +10.0, middle +13.3, high +15.8 bp.
  - Positive in every tercile, a little larger when the VIX is not low.
- **2011–2019 against 2020–2026:** +10.5 against +9.7 bp (NIFTY), +14.8 against +10.1 bp (SENSEX).

### 3.3 The bar: why a drift this steady still fails

The all-nights, weekday and after-an-up-day subsets pass criteria 1–4 on both indices (§9 has the criteria pick by pick).

- **Their placebo gaps are large.** Against E's open → close, the gaps run from 6.2 to 7.3 SE. Against a fair coin, from 6.4 to 9.3 SE.
- **Their CIs are well above zero** per night and per session, with 100,000 resamples.
- **Their PFs run from 1.64 to 2.50.**
- **Criterion 6, multiple testing, fails.**
  - *Bonferroni passes.* The larger of the per-night and per-session p-values is 1.0 × 10⁻⁵. That is the floor of a 100,000-resample bootstrap: no resample was at or below zero. It is below 0.05 / 3,067 = 1.6 × 10⁻⁵.
  - *The deflated Sharpe ratio fails.* The frozen rule takes V[SR] from this study's 12 index lines: 6.08 × 10⁻³, a standard deviation of 0.078 a session. With N = 3,067 trials, the expected maximum Sharpe ratio under the null is SR₀ = 0.278 a session (about 4.4 a year).
  - The six strongest subsets have SR 0.164–0.225 a session, so their DSRs are 0.000–0.022 against a bar of 0.95.
  - With the null variance 1/(T − 1) instead (SR₀ ≈ 0.09 a session), they would be 0.995–1.000.
- **Why V[SR] is so large here.** The 12 index lines are subsets of one series with very different Sharpe ratios: from −0.001 (SENSEX after a sell-off) to 0.225 (NIFTY after an up day). Their spread reflects real differences between the subsets more than noise.
- **The bar is applied as frozen.** No variant passes, and nothing was re-run with another V[SR].
- **What that leaves.** The official prints show a steady overnight drift that a less conservative multiple-testing step would accept. The rest of this report asks whether anyone can trade it.

### 3.4 Verdict on the index

**The drift is in the official prints but does not pass the bar.** All 12 index variants fail. Six fail only the deflated Sharpe ratio: all nights, weekday nights and after an up day, on both indices. The other six also fail the placebo, the CI or the PF, and the two sell-off subsets also fail the sample size. The drift is concentrated after up days and has faded since 2025. Even as a description of the index it says nothing yet about a trade: §6.1 shows how much of it falls in minutes that a trader can hold.

---

## 4. Can a retail option buyer capture it? Family B on real 1-minute prices

### 4.1 The picks against the bar

The verdict table of §0 has the 16 B picks. Criterion by criterion (§1.6 numbering), at the conservative fill:

| index | filter | pick | 1. nights ≥ 180 | 2. placebo gap (SE) | 3. last 40% per night; per session (95% CI) | 4. PF | 5. robustness | 6. p; DSR | 7. to Dec 2024, all nights (CI) |
|---|---|---|---|---|---|---|---|---|---|
| NIFTY | all | call ATM 15:25 → 09:20 | 479: pass | −₹113 (−0.57): fail | −₹567 (−₹935 … −₹188); same: fail | 0.64: fail | not run | 1.0; 0.000: fail | −₹236 (−₹377 … −₹93), 873 nights: fail |
| | weekday | call ATM 15:25 → 09:20 | 368: pass | −₹156 (−0.88): fail | −₹700 (−₹1,066 … −₹303); −₹538 (−₹822 … −₹232): fail | 0.52: fail | not run | 1.0; 0.000: fail | −₹157 (−₹305 … −₹3), 668: fail |
| | after a down day | call ATM 15:25 → 09:20 | 236: pass | −₹113 (−0.35): fail | −₹514 (−₹1,082 … ₹92); −₹253 (−₹535 … ₹45): fail | 0.69: fail | not run | 0.95; 0.000: fail | −₹522 (−₹750 … −₹288), 392: fail |
| | after a sell-off | call ATM 15:25 → 09:20 | 48: fail | −₹72 (−0.06): fail | −₹162 (−₹1,805 … ₹1,694); −₹16 (−₹180 … ₹167): fail | 0.91: fail | not run | 0.59; 0.000: fail | −₹484 (−₹1,137 … ₹189), 77: fail |
| SENSEX | all | call ATM 15:20 → 09:20 | 251: pass | −₹144 (−0.46): fail | −₹739 (−₹1,384 … −₹27); same: fail | 0.65: fail | not run | 0.98; 0.000: fail | −₹254 (−₹424 … −₹83), 313: fail |
| | weekday | call ATM 15:20 → 09:20 | 189: pass | −₹74 (−0.25): fail | −₹758 (−₹1,411 … −₹6); −₹571 (−₹1,069 … −₹4): fail | 0.60: fail | not run | 0.98; 0.000: fail | −₹327 (−₹499 … −₹160), 239: fail |
| | after a down day | call ATM 15:25 → 09:20 | 123: fail | −₹92 (−0.19): fail | −₹620 (−₹1,581 … ₹459); −₹304 (−₹780 … ₹223): fail | 0.71: fail | not run | 0.88; 0.000: fail | −₹505 (−₹741 … −₹258), 138: fail |
| | after a sell-off | call ATM 15:20 → 09:16 | 26: fail | −₹556 (−0.34): fail | −₹1,490 (−₹4,353 … ₹1,663); −₹154 (−₹462 … ₹162): fail | 0.58: fail | not run | 0.84; 0.000: fail | −₹928 (−₹1,496 … −₹322), 25: fail |

- **At the mid fill, all eight B picks fail too.** They lose −₹81 to −₹452 a night out of sample; the exception is NIFTY's after-a-sell-off pick, at +₹318 over 48 nights (CI −₹1,360 … +₹2,228). Their complete-bar means run from −₹539 to +₹111, and none has a CI above zero.
- **Across all 192 B variants:**
  - None has a CI above zero, over all nights or out of sample.
  - None has a placebo gap of 2 SE, over all nights or out of sample.
  - Over all nights, only 3 have a mean above zero, all of them NIFTY's after-a-sell-off variants at mid.
  - Out of sample, 12 have a mean above zero: all 12 timings and strikes of NIFTY's after-a-sell-off filter at mid, on the same 48 nights.
- **The first 60% picked the latest exit (09:20) at the conservative fill everywhere but SENSEX after a sell-off.** The 09:15 bar's low is the worst fill of the morning. Sold at 09:15 instead, the same all-nights calls lose ₹538 (NIFTY) and ₹496 (SENSEX) a night more.

### 4.2 Why the call loses: the direction is small and the overnight costs are not

The placebo splits each call exactly into half the straddle (call + put) and half the synthetic (call − put, the direction). For the base timing, ATM 15:20 → 09:15, over all nights:

| index | fill | call ₹/night | ½ straddle: decay, volatility, the size of the move, the spread, charges | ½ (call − put): the direction (placebo gap, SE) | premium ₹ | charges ₹ (round trip) | index 15:20 → 09:15 (share up) |
|---|---|---|---|---|---|---|---|
| NIFTY | conservative | −₹928 | −₹993 | +₹64 (0.85) | ₹7,995 | ₹61 | +5.5 bp (58%) |
| | mid | −₹100 | −₹144 | +₹44 (0.50) | ₹7,899 | ₹62 | |
| SENSEX | conservative | −₹973 | −₹932 | −₹41 (−0.37) | ₹8,329 | ₹62 | +3.3 bp (55%) |
| | mid | −₹201 | −₹132 | −₹69 (−0.52) | ₹8,245 | ₹62 | |

- **The direction is worth ₹25–52 a lot a night for NIFTY at mid and nothing for SENSEX**, across the 12 all-night timings and strikes. NIFTY's gaps are +₹25 to +₹52 (0.24–0.52 SE) and SENSEX's −₹63 to −₹101 (−0.46 to −0.65 SE). The 1-minute index rose from 15:20 to 09:15 on 58% and 55% of these nights, by +5.5 and +3.3 bp on average. An ATM call keeps only part of that move.
- **Holding the option overnight costs more than that.** At mid, half the straddle loses ₹144 and ₹132 a night after charges. At the conservative fill it loses ₹993 and ₹932: the 09:15 bar's range and the 15:20 bar's are the main cost.
- **The cost falls with a later exit.** Over all nights, NIFTY's ATM call at the conservative fill loses −₹928 a night when sold at 09:15, −₹448 at 09:16 and −₹385 at 09:20. Even the best timing at the conservative fill (15:25 → 09:20, −₹366) is several times the direction's value.
- **Charges are small and almost fixed:** ₹61–71 a round trip for one call. They include the STT increases of Oct 2024 and Apr 2026; option STT is 0.15% of the sale from 1 Apr 2026.
- **The night filters do not help.**
  - After a down day the call does worse than on all nights. For NIFTY's ATM call 15:25 → 09:20 at the conservative fill, over the whole sample, it loses −₹534 a night after a down day against −₹366 on all nights. This matches the index: the drift after a down day is well under half the drift after an up day.
  - The weekday filter drops weekend nights, which the call loses most on (§4.3), but it still loses on weekdays.

### 4.3 By era, year, kind of night, VIX and the 1 Apr 2026 STT rise

₹ per lot per night over all nights of each pick (first 60% and last 40% together):

| pick | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 | weekday / weekend / pre-holiday nights | VIX low / middle / high | before / from 1 Apr 2026 (nights) |
|---|---|---|---|---|---|---|---|---|---|
| NIFTY B all nights, conservative (ATM 15:25 → 09:20) | −₹24 | −₹405 | −₹168 | −₹263 | −₹625 | −₹954 | −₹356 / −₹678 / +₹532 (919 / 216 / 64) | −₹408 / −₹320 / −₹345 | −₹352 (1,164) / −₹852 (35) |
| NIFTY B all nights, mid (1 ITM 15:25 → 09:16) | +₹307 | −₹105 | +₹75 | −₹30 | −₹186 | −₹731 | −₹44 / −₹397 / +₹738 | −₹148 / +₹14 / −₹15 | −₹45 / −₹752 |
| NIFTY B weekday, conservative | +₹103 | −₹65 | −₹240 | −₹329 | −₹969 | −₹670 | weekday only | −₹451 / −₹130 / −₹406 | −₹337 (891) / −₹960 (28) |
| NIFTY C1-B call, conservative | +₹57 | −₹368 | −₹95 | −₹192 | −₹594 | −₹872 | −₹304 / −₹591 / +₹595 | −₹303 / −₹339 / −₹288 | −₹295 / −₹742 |
| SENSEX B all nights, conservative (ATM 15:20 → 09:20) | – | – | −₹211 | −₹271 | −₹520 | −₹1,177 | −₹525 / −₹709 / +₹835 (479 / 112 / 37) | −₹507 / −₹310 / −₹557 | −₹457 (596) / −₹862 (32) |
| SENSEX B all nights, mid (1 ITM 15:20 → 09:16) | – | – | +₹101 | −₹47 | −₹136 | −₹1,013 | −₹230 / −₹487 / +₹1,097 | −₹277 / +₹66 / −₹293 | −₹145 / −₹1,096 |
| SENSEX C1-B call, conservative | – | – | −₹128 | −₹211 | −₹527 | −₹1,028 | −₹493 / −₹542 / +₹745 | −₹454 / −₹306 / −₹479 | −₹405 / −₹827 |

- **Every era loses at the conservative fill.**
  - In the complete-bar era (to Dec 2024), the conservative fill is a true worst case. There the all-nights picks lost −₹236 (NIFTY) and −₹254 (SENSEX) a night.
  - At mid they were about flat: +₹35 (NIFTY, CI −₹118 … +₹189) and −₹3 (SENSEX).
  - From Jan 2025, the bars are built from sampled prices, and the losses are larger at both fills.
- **The rupee figures grow with the lot, not only with the losses.** SEBI's package of 20 Nov 2024 enlarged the contracts: NIFTY's lot went 25 → 75 (65 from Dec 2025), and SENSEX's 10 → 20 (WP14 §8.3; NIFTY's was 50 before Apr 2024). The same percentage move in the premium therefore costs 1.5–3 times as many rupees a lot from 2025 as in 2021–2024. The verdicts hold either way: every era, and every year from 2024, loses at the conservative fill.
- **The weekend nights lose the most; the nights before a weekday holiday make money.**
  - Weekend nights: −₹678 and −₹709 a night (conservative).
  - Nights before a weekday holiday: +₹532 over 64 nights (NIFTY) and +₹835 over 37 (SENSEX). This matches the index's larger drift on those nights (+18 bp, §3.2). There are about 12 such nights a year (198 in 2011–2026), so 180 out-of-sample nights would take some 15 years to collect.
- **The VIX tercile changes little.** Every tercile loses at the conservative fill.
- **After STT rose on 1 Apr 2026, every pick but one lost more.** NIFTY's all-nights pick lost −₹852 a night against −₹352 before (conservative). The exception is SENSEX's after-a-down-day pick at mid (−₹210 against −₹269, 16 nights). The 35 and 32 nights are few, and kill check 1 rests on them (§2.6).

### 4.4 Verdict on the call buyer

**A retail call buyer could not capture the drift.** All 16 B picks fail, at both fills, in both data eras and on both indices. The direction that the drift gives the call, a few tens of rupees a lot a night on NIFTY, is a small fraction of what it costs to hold the option overnight and to trade in and out of it.

---

## 5. R6's variants: the synthetic long (C1), the single call (C1-B) and the weak-session filter (C2)

### 5.1 C1, the synthetic long

R6's card: at 15:25 buy the call and sell the put at the listed strike nearest the synthetic forward, nearest weekly with at least 2 sessions; at 09:30 close both.

- **It loses on both indices at both fills.** Out of sample, it lost −₹1,019 (NIFTY) and −₹1,148 (SENSEX) a night at the conservative fill, and −₹405 and −₹510 at mid. Over all nights it lost −₹611 and −₹804, and −₹98 and −₹351.
- **It does not beat either placebo.**
  - *The fair coin* between the long and the short synthetic: −₹247 (−0.60 SE) and −₹336 (−0.51 SE).
  - *The same synthetic over E's session* (09:30 → 15:25): −₹318 (−0.58 SE) and −₹280 (−0.33 SE).
  - Holding the synthetic overnight was no better than holding it through the next day.
- **The synthetic hardly moves with the index's overnight drift.**
  - At mid, NIFTY's synthetic (call − put) made +₹23 a night gross over all nights (the cross-check's figure; §5.2 shows half of it, ₹12).
  - The index's own 15:25 → 09:30 move was worth about ₹420 a lot a night at a delta of 1 (2 × ₹210).
- **Why the synthetic keeps so little.**
  - A synthetic (or a future) is priced off the forward. The forward includes interest less dividends to expiry and gives that carry up as calendar time passes, most of it overnight.
  - At roughly 5–6% a year and about 1.4 calendar days a night, that is about 2 bp a night, half of the index's +4.4 bp. The arithmetic is approximate and is not a frozen measure.
  - The rest of the difference is within the noise: the direction's SE is about ₹100 a night over 1,199 nights.
- **It needs margin**, which the study does not model (₹5 lakh account only), and its loss is not capped (§7).

### 5.2 C1-B, the single call, and R6's decomposition

The single long call at K(fwd), 15:25 → 09:30, is the retail version of C1. Out of sample it lost −₹526 (NIFTY) and −₹640 (SENSEX) a night at the conservative fill, and −₹240 and −₹321 at mid. Its placebo gaps are −0.52 and −0.50 SE (conservative).

R6 asked for the call's overnight theta and vega. The frozen decomposition (mid fills, gross of charges, every priced night) splits the call two ways:

| index | nights | C1-B call gross ₹/lot (mid) | ½ × synthetic (call − put): the direction | ½ × straddle (call + put): decay, volatility and the size of the move | 0.5 × the index move × lot | the rest: carry, decay, volatility, the opening print |
|---|---|---|---|---|---|---|
| NIFTY | 1,199 | ₹3 | ₹12 | −₹9 | ₹210 | −₹207 |
| SENSEX | 626 | −₹144 | −₹114 | −₹30 | ₹69 | −₹214 |

- **At mid prices, the call's overnight decay and volatility change are small:** half the straddle loses ₹9 and ₹30 a lot a night, gross. Theta and vega are not separated: that needs implied volatilities, which this study did not compute.
- **The direction is where the drift should show, and it is small:** +₹12 for NIFTY and −₹114 for SENSEX. A delta of 0.5 on the index's own move would have made ₹210 and ₹69. The call's price change gives that back (the rest: −₹207 and −₹214).
  - Half the straddle accounts for −₹9 and −₹30 of it.
  - The forward's carry accounts for roughly half (§5.1).
  - The remainder is within the noise.
- **Charges (₹61 a round trip) and the spread turn the gross into a loss.** The conservative fill costs ₹250 (NIFTY) and ₹222 (SENSEX) a night more than mid.

### 5.3 R6's kill checks

- **Kill check 1: net above zero from 1 Apr 2026, when STT rose.** Every C variant fails.
  - C1: −₹1,029 (NIFTY, 35 nights) and −₹1,293 (SENSEX, 32) a night at the conservative fill; −₹179 and −₹667 at mid.
  - C1-B: −₹742 and −₹827 at the conservative fill; −₹368 and −₹524 at mid.
  - C2: −₹6,531 (15 nights) and −₹3,714 (9) at the conservative fill.
- **Kill check 2: the first print against 09:30**, on the complete-bar nights (to Dec 2024), where the 09:15 bar's open is the exchange's first trade:

| index | fill | structure | nights (all three exits priced) | sold at the first print (09:15 open) | at the 09:15 bar | at 09:30 (R6's exit) | criterion (the variant's own trades) |
|---|---|---|---|---|---|---|---|
| NIFTY | conservative | synthetic | 870 | ₹2 | −₹1,551 | −₹353 | **killed** (₹2 → −₹353) |
| | conservative | call | 871 | ₹38 | −₹726 | −₹166 | **killed** (₹38 → −₹166) |
| | mid | synthetic | 870 | ₹133 | ₹60 | ₹60 | passes (₹133 → ₹60) |
| | mid | call | 871 | ₹109 | ₹3 | ₹43 | passes (₹109 → ₹43) |
| SENSEX | conservative | synthetic | 283 | −₹106 | −₹1,317 | −₹282 | passes (no gain at the print) |
| | conservative | call | 294 | ₹26 | −₹619 | −₹120 | **killed** (290 nights: ₹26 → −₹172) |
| | mid | synthetic | 283 | −₹18 | −₹53 | −₹12 | passes (no gain at the print) |
| | mid | call | 294 | ₹68 | −₹80 | ₹12 | **killed** (290 nights: ₹68 → −₹39) |

- **Every structure is worth more at the first print than at 09:30, except SENSEX's synthetic at mid** (−₹18 against −₹12). On NIFTY at mid, the synthetic's ₹133 at the first print halves to ₹60 by 09:30. A seller cannot count on the first print: it is one trade, and WP11 found it rich.
- **The 09:15 bar is the worst place to sell at the conservative fill** (its low): −₹1,551 for NIFTY's synthetic.
- **The table and the criterion use slightly different nights for SENSEX's call.** The table counts every night with the call's three exits priced (294). The criterion uses the variant's own trades, which also need the put at K(fwd) for the placebo (290). The 4 extra nights add almost nothing at the first print but lift the 09:30 mean at mid from −₹39 to +₹12. The verdict uses the frozen criterion. The variant fails on every other criterion as well (§11).

### 5.4 C2, the synthetic after a weak session

- **The picks.** On the first 60%, NIFTY picked the bottom 33% of the trailing 250 session returns (09:30 → 15:25) and SENSEX the bottom 20%, at both fills.
- **They lose more than C1.** Out of sample: −₹1,909 (NIFTY, 166 nights) and −₹2,465 (SENSEX, 53) a night at the conservative fill; −₹1,198 and −₹1,525 at mid. All 12 C2 variants (three thresholds, two indices, two fills) lose, over all nights and out of sample.
- **R6's criterion 11 fails on every pick.**

  | pick | C2 − C1 on the same nights (95% CI) | C2 nights / eligible | random draw of the same count: p |
  |---|---|---|---|
  | NIFTY bottom 33%, conservative | −₹890 (−₹2,088 … ₹250) | 166 / 479 | 0.94 |
  | NIFTY bottom 33%, mid | −₹793 (−₹1,966 … ₹328) | 166 / 479 | 0.92 |
  | SENSEX bottom 20%, conservative | −₹1,318 (−₹4,220 … ₹1,484) | 53 / 251 | 0.86 |
  | SENSEX bottom 20%, mid | −₹1,015 (−₹3,858 … ₹1,757) | 53 / 251 | 0.80 |

- **After a weak session the synthetic did worse, not better.** This matches the index after a down day (§3.1). The placebo gaps are −1.41 and −0.88 SE (conservative).
- **C2 cannot reach 180 out-of-sample nights** (166 and 53), as §2.6 expected.

### 5.5 Verdict on R6's variants

**None passes.** C1, C1-B and C2 fail on both indices and at both fills.
- They fail R6's own rules: the same sign on the other index, kill check 1, and (for C2) beating C1 and a random draw.
- Kill check 2 kills NIFTY's conservative C1 and C1-B, and SENSEX's C1-B at both fills.
- R6's card said the variant was worth testing only if it survived these checks. It does not.

---

## 6. Descriptive series: what part of the drift is tradeable

### 6.1 The bridge: the official prints against the minutes a buyer can trade

Index returns on the nights that are valid both as index nights and as 1-minute nights (NIFTY May 2021 – Jul 2026, SENSEX Aug 2023 – Jul 2026). Means per night (95% block-bootstrap CI).

| index | nights | official close → open | D 15:29 bar close → E 09:15 bar open | 15:20 → 09:15 | 15:20 → 09:16 | 15:20 → 09:20 | 15:25 → 09:15 | 15:25 → 09:16 | 15:25 → 09:20 | 15:25 → 09:30 |
|---|---|---|---|---|---|---|---|---|---|---|
| NIFTY | 1,232 | +7.9 bp (+4.9 … +11.0) | +10.6 bp (+7.7 … +13.4) | +6.0 bp (+3.3 … +8.7) | +6.1 bp | +5.6 bp | +4.9 bp (+2.2 … +7.6) | +5.0 bp | +4.6 bp | +4.4 bp (+1.3 … +7.4) |
| SENSEX | 684 | +6.9 bp (+2.4 … +11.2) | +7.2 bp (+2.8 … +11.4) | +3.8 bp (+0.1 … +7.4) | +4.1 bp | +3.9 bp | +2.7 bp (−0.9 … +6.2) | +3.0 bp | +2.8 bp | +2.3 bp (−1.6 … +6.2) |

- **The last 1-minute print to the first 1-minute print holds the most:** +10.6 bp (NIFTY) and +7.2 bp (SENSEX).
- **The minutes a buyer can trade hold half of that or less.**
  - From the 15:25 bar's close to the 09:15 bar's close, NIFTY made +4.9 bp and SENSEX +2.7 bp. The index therefore lost about 5.7 bp (NIFTY) and 4.5 bp (SENSEX) a night between 15:25 and 15:29, and in the first minute after 09:15.
  - Every timing that starts at 15:25 has a SENSEX CI that includes zero.
- **The share of nights up falls in the same way:** from 66.5% for 15:29 → 09:15 open to 56.4% for 15:25 → 09:30 (NIFTY).

### 6.2 Near-month futures (robustness only)

| index | nights | close → open per night (95% CI) | up | ₹ per lot per night (95% CI) | sell-side STT ₹ per lot (dated) | last trade → open (NSE, 2024–) | from 1 Apr 2026: nights, close → open, STT ₹ per lot |
|---|---|---|---|---|---|---|---|
| NIFTY | 1,868 (Feb 2019 –) | +1.7 bp (−1.5 … +4.7) | 55.7% | ₹129 (−₹156 … ₹416) | ₹183 | −0.5 bp (−4.0 … +2.9), 668 nights | 129, −3.5 bp, ₹776 |
| SENSEX | 815 (May 2023 –) | +0.9 bp (−2.3 … +4.1) | 51.4% | ₹58 (−₹383 … ₹517) | ₹287 | – | 129, −1.5 bp, ₹766 |

- **The future keeps a fifth of the official drift or less.** Two things are against it: the carry built into its price (§5.1), and the fact that its closing price (a 30-minute VWAP) and its first trade are not the index's own prints.
- **From NSE's last trade to the next open it made −0.5 bp a night** (2024–2026).
- **The STT on the sale alone is larger than its mean gain** at the dated rates: 0.01% → 0.0125% (Apr 2023) → 0.02% (Oct 2024) → 0.05% (Apr 2026). From 1 Apr 2026 the sale's STT is about ₹770 a lot a night, and the future lost −3.5 bp a night (NIFTY).
- **Brokerage, exchange charges, stamp duty, GST, the spread and the margin are not modelled.** All of them make it worse.

### 6.3 The ATM call at end-of-day prints (WP6's measure; the tails before 2021)

| index | nights | ₹ per lot per night (95% CI) | profitable | premium ₹ | worst nights (₹ per lot) |
|---|---|---|---|---|---|
| NIFTY | 1,864 (Feb 2019 –) | ₹83 (−₹49 … ₹215) | 53.3% | ₹8,263 | 20 Mar 2020 −₹22,655, 18 Mar 2020 −₹20,948, 12 Mar 2020 −₹15,565, 27 Mar 2020 −₹15,006, 11 Mar 2020 −₹14,052, 6 Mar 2026 −₹12,470 |
| SENSEX | 808 (May 2023 –) | ₹174 (−₹25 … ₹401) | 53.8% | ₹8,225 | 1 Apr 2026 −₹10,544, 5 Jun 2026 −₹9,549, 8 May 2025 −₹8,002, 6 Apr 2026 −₹7,274, 18 Mar 2026 −₹7,020, 12 Mar 2026 −₹6,651 |

- **WP6's context.** WP6 (§1.0) found the call bought at NSE's close and sold at the next first trade made +3.39% of premium gross. Here, with the N4 contract and dated charges, it makes about +1.0% of premium net on NIFTY (₹83 on ₹8,263), with a CI that includes zero.
- **Neither price is a fill.** The close is a 30-minute VWAP and the open is one trade, which WP11 found rich. On real 1-minute prices the same night loses (§4).
- **This series is the only option series that covers 2020.** Its five worst nights are March 2020's, at −₹14,052 to −₹22,655 a lot (lot 75).

### 6.4 The overnight straddle (D4: the placebo's expectation × 2)

| index | fill | nights | ATM straddle (call + put) 15:20 → 09:15, ₹ per lot per night (95% CI) | nights it made money |
|---|---|---|---|---|
| NIFTY | conservative | 1,199 | −₹1,985 (−₹2,070 … −₹1,900) | 1.5% |
| | mid | 1,199 | −₹288 (−₹379 … −₹185) | 24.9% |
| SENSEX | conservative | 628 | −₹1,864 (−₹2,004 … −₹1,722) | 3.8% |
| | mid | 628 | −₹264 (−₹411 … −₹104) | 26.4% |

- **Buying both sides overnight loses on three nights in four even at mid**, which is what a coin flip between the call and the put inherits. At the conservative fill it almost never makes money.
- **This is the overnight price of an option to its buyer.** It is the yardstick for the call picks: a call that cannot beat half of this by 2 SE has no edge from the drift.

---

## 7. Tails (one lot)

**The picks** (all nights, D from May 2021 for NIFTY and Aug 2023 for SENSEX, to Jul 2026; the dates are D):

| pick | nights | net ₹ | worst / best night | 5% VaR / ES ₹ | 1% VaR / ES ₹ | net without the best 5 / 10 | max drawdown ₹ (% of ₹5 lakh / of ₹10,000) | longest losing run | premium ₹ (share > ₹10,000) | stop −30%: gapped nights, ₹ a lot beyond the stop | stop −50%: gapped nights, ₹ beyond |
|---|---|---|---|---|---|---|---|---|---|---|---|
| NIFTY B all nights, ATM 15:25 → 09:20, conservative | 1,199 | −₹4,39,285 | −₹13,010 (1 Apr 2026) / ₹34,559 (2 Feb 2026) | −₹5,139 / −₹6,866 | −₹8,101 / −₹10,296 | −₹5,62,517 / −₹6,27,238 | ₹4,44,500 (88.9% / 4,445%) | 12 | ₹7,939 (25%) | 245 (20.4%), ₹1,363 | 95 (7.9%), ₹926 |
| NIFTY B weekday, ATM 15:25 → 09:20, conservative | 919 | −₹3,26,847 | −₹13,010 (1 Apr 2026) / ₹34,559 (2 Feb 2026) | −₹4,648 / −₹6,241 | −₹7,230 / −₹9,015 | −₹4,20,604 / −₹4,54,974 | ₹3,41,844 (68.4% / 3,418%) | 11 | ₹7,997 (25%) | 164 (17.8%), ₹1,152 | 55 (6.0%), ₹709 |
| NIFTY B after a down day, ATM 15:25 → 09:20, conservative | 558 | −₹2,98,152 | −₹12,836 (6 Mar 2026) / ₹34,559 (2 Feb 2026) | −₹5,510 / −₹7,143 | −₹8,145 / −₹10,121 | −₹4,02,866 / −₹4,45,856 | ₹3,14,185 (62.8% / 3,142%) | 10 | ₹8,471 (30%) | 138 (24.7%), ₹1,459 | 57 (10.2%), ₹912 |
| NIFTY B after a sell-off, ATM 15:25 → 09:20, conservative | 111 | −₹36,926 | −₹12,836 (6 Mar 2026) / ₹26,282 (9 May 2025) | −₹7,294 / −₹9,743 | −₹12,836 / −₹12,836 | −₹1,01,406 / −₹1,28,940 | ₹68,653 (13.7% / 687%) | 7 | ₹9,591 (34%) | 28 (25.2%), ₹2,176 | 15 (13.5%), ₹1,426 |
| NIFTY C1 synthetic, conservative | 1,199 | −₹7,32,917 | −₹58,307 (4 Apr 2025) / ₹48,594 (7 Apr 2026) | −₹11,535 / −₹17,795 | −₹20,252 / −₹30,546 | −₹9,32,299 / −₹10,47,802 | ₹7,81,296 (156.3% / 7,813%) | 11 | ₹7,298 (19%) | 277 (23.1%), ₹1,351 (call leg) | 115 (9.6%), ₹840 |
| NIFTY C1-B call, conservative | 1,199 | −₹3,69,009 | −₹12,981 (1 Apr 2026) / ₹34,082 (2 Feb 2026) | −₹5,001 / −₹6,766 | −₹7,801 / −₹9,909 | −₹4,95,534 / −₹5,55,134 | ₹3,86,183 (77.2% / 3,862%) | 15 | ₹7,298 (19%) | 277 (23.1%), ₹1,351 | 115 (9.6%), ₹840 |
| NIFTY C2 bottom 33%, conservative | 309 | −₹4,48,877 | −₹58,307 (4 Apr 2025) / ₹41,623 (9 May 2025) | −₹14,275 / −₹23,737 | −₹30,469 / −₹44,919 | −₹5,74,504 / −₹6,29,694 | ₹4,48,877 (89.8% / 4,489%) | 9 | ₹7,676 (23%) | 83 (26.9%), ₹1,576 (call leg) | 35 (11.3%), ₹1,098 |
| NIFTY B all nights, 1 ITM 15:25 → 09:16, mid | 1,199 | −₹78,815 | −₹13,816 (6 Mar 2026) / ₹34,601 (2 Feb 2026) | −₹5,287 / −₹7,064 | −₹8,103 / −₹10,675 | −₹2,02,188 / −₹2,70,480 | ₹1,42,532 (28.5% / 1,425%) | 10 | ₹9,429 (36%) | 173 (14.4%), ₹1,557 | 61 (5.1%), ₹936 |
| NIFTY B weekday, 1 ITM 15:25 → 09:16, mid | 919 | −₹40,396 | −₹13,296 (1 Apr 2026) / ₹34,601 (2 Feb 2026) | −₹4,571 / −₹6,358 | −₹7,251 / −₹9,181 | −₹1,38,028 / −₹1,76,376 | ₹1,52,218 (30.4% / 1,522%) | 10 | ₹9,492 (38%) | 110 (12.0%), ₹1,316 | 32 (3.5%), ₹630 |
| NIFTY B after a down day, ATM 15:25 → 09:20, mid | 558 | −₹96,706 | −₹12,482 (6 Mar 2026) / ₹38,353 (2 Feb 2026) | −₹5,197 / −₹6,765 | −₹7,698 / −₹9,699 | −₹2,08,506 / −₹2,54,293 | ₹1,29,707 (25.9% / 1,297%) | 9 | ₹8,373 (28%) | 119 (21.3%), ₹1,453 | 49 (8.8%), ₹866 |
| NIFTY B after a sell-off, ATM 15:25 → 09:20, mid | 111 | ₹14,671 | −₹12,482 (6 Mar 2026) / ₹27,646 (9 May 2025) | −₹7,058 / −₹9,250 | −₹12,482 / −₹12,482 | −₹53,904 / −₹86,053 | ₹46,519 (9.3% / 465%) | 6 | ₹9,471 (32%) | 24 (21.6%), ₹2,212 | 14 (12.6%), ₹1,263 |
| NIFTY C1 synthetic, mid | 1,199 | −₹1,17,530 | −₹54,035 (4 Apr 2025) / ₹49,922 (7 Apr 2026) | −₹11,183 / −₹16,826 | −₹19,334 / −₹29,028 | −₹3,20,678 / −₹4,43,022 | ₹2,81,342 (56.3% / 2,813%) | 11 | ₹7,220 (18%) | 252 (21.0%), ₹1,287 (call leg) | 102 (8.5%), ₹795 |
| NIFTY C1-B call, mid | 1,199 | −₹69,243 | −₹12,526 (1 Apr 2026) / ₹34,835 (2 Feb 2026) | −₹4,666 / −₹6,447 | −₹7,298 / −₹9,587 | −₹1,99,334 / −₹2,60,623 | ₹1,47,880 (29.6% / 1,479%) | 12 | ₹7,220 (18%) | 252 (21.0%), ₹1,287 | 102 (8.5%), ₹795 |
| NIFTY C2 bottom 33%, mid | 309 | −₹2,61,204 | −₹54,035 (4 Apr 2025) / ₹41,713 (9 May 2025) | −₹13,627 / −₹22,497 | −₹29,010 / −₹41,969 | −₹3,90,443 / −₹4,49,219 | ₹2,61,204 (52.2% / 2,612%) | 9 | ₹7,590 (22%) | 74 (23.9%), ₹1,554 (call leg) | 28 (9.1%), ₹1,197 |
| SENSEX B all nights, ATM 15:20 → 09:20, conservative | 628 | −₹2,99,799 | −₹14,353 (6 Mar 2026) / ₹36,238 (7 Apr 2026) | −₹5,277 / −₹7,957 | −₹10,691 / −₹12,068 | −₹4,28,398 / −₹4,81,130 | ₹3,01,758 (60.4% / 3,018%) | 12 | ₹8,329 (31%) | 120 (19.1%), ₹1,546 | 52 (8.3%), ₹949 |
| SENSEX B weekday, ATM 15:20 → 09:20, conservative | 479 | −₹2,51,263 | −₹11,189 (18 Mar 2026) / ₹36,238 (7 Apr 2026) | −₹4,994 / −₹6,717 | −₹8,138 / −₹9,817 | −₹3,49,638 / −₹3,78,264 | ₹2,57,942 (51.6% / 2,579%) | 11 | ₹8,392 (33%) | 82 (17.1%), ₹1,229 | 29 (6.1%), ₹658 |
| SENSEX B after a down day, ATM 15:25 → 09:20, conservative | 297 | −₹1,71,978 | −₹13,816 (6 Mar 2026) / ₹35,360 (2 Feb 2026) | −₹5,911 / −₹8,425 | −₹12,229 / −₹13,022 | −₹2,73,873 / −₹3,09,082 | ₹1,77,654 (35.5% / 1,777%) | 9 | ₹8,670 (33%) | 74 (24.9%), ₹1,525 | 34 (11.4%), ₹875 |
| SENSEX B after a sell-off, ATM 15:20 → 09:16, conservative | 61 | −₹52,634 | −₹13,767 (6 Mar 2026) / ₹20,275 (9 May 2025) | −₹10,831 / −₹12,325 | −₹13,767 / −₹13,767 | −₹1,11,303 / −₹1,24,461 | ₹68,704 (13.7% / 687%) | 8 | ₹11,793 (52%) | 16 (26.2%), ₹2,710 | 10 (16.4%), ₹1,527 |
| SENSEX C1 synthetic, conservative | 626 | −₹5,03,364 | −₹48,228 (4 Apr 2025) / ₹51,442 (7 Apr 2026) | −₹12,434 / −₹20,175 | −₹29,873 / −₹36,764 | −₹6,91,347 / −₹7,86,814 | ₹5,09,775 (102.0% / 5,098%) | 9 | ₹7,598 (24%) | 146 (23.3%), ₹1,411 (call leg) | 60 (9.6%), ₹963 |
| SENSEX C1-B call, conservative | 626 | −₹2,67,208 | −₹13,184 (6 Mar 2026) / ₹37,205 (2 Feb 2026) | −₹5,501 / −₹7,757 | −₹10,332 / −₹11,354 | −₹3,97,333 / −₹4,44,232 | ₹2,69,790 (54.0% / 2,698%) | 13 | ₹7,598 (24%) | 146 (23.3%), ₹1,411 | 60 (9.6%), ₹963 |
| SENSEX C2 bottom 20%, conservative | 94 | −₹1,91,622 | −₹48,228 (4 Apr 2025) / ₹33,693 (30 Mar 2026) | −₹21,366 / −₹36,125 | −₹48,228 / −₹48,228 | −₹2,84,369 / −₹3,23,909 | ₹2,16,450 (43.3% / 2,165%) | 7 | ₹9,733 (38%) | 30 (31.9%), ₹2,076 (call leg) | 15 (16.0%), ₹1,195 |
| SENSEX B all nights, 1 ITM 15:20 → 09:16, mid | 613 | −₹1,20,043 | −₹13,872 (6 Mar 2026) / ₹36,532 (7 Apr 2026) | −₹5,406 / −₹8,310 | −₹11,068 / −₹12,443 | −₹2,45,120 / −₹3,04,125 | ₹1,44,036 (28.8% / 1,440%) | 10 | ₹9,214 (37%) | 99 (16.2%), ₹1,648 | 34 (5.5%), ₹1,102 |
| SENSEX B weekday, 1 ITM 15:20 → 09:16, mid | 467 | −₹1,07,545 | −₹13,145 (1 Apr 2026) / ₹36,532 (7 Apr 2026) | −₹4,817 / −₹7,113 | −₹10,161 / −₹11,177 | −₹2,10,074 / −₹2,43,078 | ₹1,27,448 (25.5% / 1,274%) | 11 | ₹9,296 (40%) | 68 (14.6%), ₹1,292 | 19 (4.1%), ₹725 |
| SENSEX B after a down day, ATM 15:20 → 09:15, mid | 296 | −₹78,741 | −₹13,316 (6 Mar 2026) / ₹27,261 (2 Feb 2026) | −₹5,084 / −₹7,799 | −₹11,582 / −₹12,449 | −₹1,73,148 / −₹2,17,155 | ₹98,733 (19.7% / 987%) | 8 | ₹8,679 (32%) | 61 (20.6%), ₹1,447 | 24 (8.1%), ₹902 |
| SENSEX B after a sell-off, ATM 15:20 → 09:15, mid | 61 | −₹9,755 | −₹13,316 (6 Mar 2026) / ₹19,945 (9 May 2025) | −₹10,338 / −₹11,745 | −₹13,316 / −₹13,316 | −₹78,065 / −₹92,824 | ₹54,198 (10.8% / 542%) | 7 | ₹11,660 (52%) | 14 (23.0%), ₹2,551 | 8 (13.1%), ₹1,563 |
| SENSEX C1 synthetic, mid | 626 | −₹2,19,897 | −₹43,844 (4 Apr 2025) / ₹52,546 (7 Apr 2026) | −₹11,723 / −₹19,286 | −₹29,873 / −₹35,241 | −₹4,11,325 / −₹5,12,163 | ₹2,51,965 (50.4% / 2,520%) | 7 | ₹7,532 (23%) | 132 (21.1%), ₹1,387 (call leg) | 55 (8.8%), ₹907 |
| SENSEX C1-B call, mid | 626 | −₹1,28,404 | −₹12,301 (6 Mar 2026) / ₹37,499 (2 Feb 2026) | −₹5,275 / −₹7,406 | −₹10,117 / −₹10,943 | −₹2,61,685 / −₹3,11,169 | ₹1,37,012 (27.4% / 1,370%) | 13 | ₹7,532 (23%) | 132 (21.1%), ₹1,387 | 55 (8.8%), ₹907 |
| SENSEX C2 bottom 20%, mid | 94 | −₹1,18,282 | −₹43,844 (4 Apr 2025) / ₹35,223 (30 Mar 2026) | −₹18,534 / −₹32,811 | −₹43,844 / −₹43,844 | −₹2,15,641 / −₹2,58,359 | ₹1,58,432 (31.7% / 1,584%) | 6 | ₹9,641 (38%) | 30 (31.9%), ₹1,784 (call leg) | 13 (13.8%), ₹1,067 |

- **The ten worst nights** of the main picks (all generated tables have every pick's):
  - **NIFTY B all nights, conservative:** 1 Apr 2026 −₹13,010, 6 Mar 2026 −₹12,836, 20 Mar 2026 −₹12,790, 2 Mar 2026 −₹10,873, 18 Mar 2026 −₹10,559, 11 Mar 2026 −₹9,568, 8 May 2026 −₹9,181, 6 Apr 2026 −₹9,179, 25 Mar 2026 −₹9,012, 12 Jun 2025 −₹8,145.
  - **NIFTY C1 synthetic, conservative:** 4 Apr 2025 −₹58,307, 6 Mar 2026 −₹45,980, 2 Mar 2026 −₹33,151, 18 Mar 2026 −₹31,178, 1 Apr 2026 −₹30,469, 20 Mar 2026 −₹28,994, 3 Jun 2024 −₹23,304, 23 Feb 2022 −₹21,879, 10 Jun 2022 −₹21,517, 29 Apr 2026 −₹20,973.
  - **SENSEX B all nights, conservative:** 6 Mar 2026 −₹14,353, 27 Mar 2026 −₹12,487, 20 Mar 2026 −₹12,272, 10 Apr 2026 −₹11,414, 18 Mar 2026 −₹11,189, 2 Mar 2026 −₹10,691, 6 Apr 2026 −₹10,364, 11 Mar 2026 −₹9,576, 8 May 2026 −₹8,888, 12 Mar 2026 −₹8,138.
  - **SENSEX C1 synthetic, conservative:** 4 Apr 2025 −₹48,228, 6 Mar 2026 −₹46,701, 2 Mar 2026 −₹32,953, 10 Apr 2026 −₹32,618, 18 Mar 2026 −₹30,213, 3 Jun 2024 −₹29,873, 20 Mar 2026 −₹28,205, 27 Feb 2026 −₹21,366, 29 Apr 2026 −₹20,508, 8 May 2026 −₹19,226.
- **A bought call's loss is capped at its premium**, so its worst night is about −₹11,000 to −₹14,000 a lot, nearly all of the premium. Most of the picks' worst nights fall in March–May 2026, the sampled-bar era (§8.2).
- **The synthetic has no cap.** Its loss is roughly the index's move to 09:30 times the lot (−₹58,307 on 4 → 7 Apr 2025, NIFTY), and its best nights are nearly as large (₹48,594 on 7 Apr 2026). At the conservative fill it would have drawn down 156% (NIFTY) and 102% (SENSEX) of a ₹5 lakh account.
- **The gains are concentrated in a few nights.** Without its 5 best nights, NIFTY's all-nights pick loses another ₹1.2 lakh (conservative) and its mid pick another ₹1.2 lakh.
- **The ₹10,000 account.**
  - It cannot hold these positions: 18–52% of nights cost more than ₹10,000 a lot.
  - The drawdowns are 4.6–78 times its capital (465% to 7,813%).
  - The synthetic needs margin far beyond it.

**Named nights:**

| night (D → E) | index | official close → open | near-month future ₹ a lot (its own move) | ATM call close → open, end-of-day prints, ₹ a lot | B call ATM 15:20 → 09:15, conservative / mid, ₹ a lot | C1 synthetic / C1-B call 15:25 → 09:30 (mid), ₹ a lot |
|---|---|---|---|---|---|---|
| 12 → 13 Mar 2020 | NIFTY | −5.03% | −₹45,506 (−6.36%) | −₹15,565 | – / – (before the 1-minute data) | – / – |
| 12 → 13 Mar 2020 | SENSEX | −4.77% | – (no BSE file) | – | – / – | – / – |
| 20 → 23 Mar 2020 | NIFTY | −9.14% | −₹65,423 (−10.00%) | −₹22,655 | – / – | – / – |
| 20 → 23 Mar 2020 | SENSEX | −7.71% | – | – | – / – | – / – |
| 3 → 4 Jun 2024 (the election result) | NIFTY | −0.36% | −₹10,198 (−1.74%) | ₹1,160 | −₹6,764 / −₹5,504 | −₹23,254 / −₹5,226 |
| 3 → 4 Jun 2024 | SENSEX | −0.24% | −₹6,679 (−0.87%) | ₹2,073 | −₹10,061 / −₹9,429 | −₹29,873 / −₹8,668 |
| 4 → 5 Jun 2024 | NIFTY | +1.11% | −₹1,048 (−0.19%) | ₹1,197 | −₹219 / ₹1,180 | ₹2,495 / ₹312 |
| 4 → 5 Jun 2024 | SENSEX | +1.32% | ₹9,969 (+1.38%) | ₹444 | −₹260 / ₹706 | ₹3,989 / −₹218 |

- **On 4 Jun 2024 the official open hid the night's loss.**
  - NIFTY's official open was −0.36%, but the future's first trade was −1.74%.
  - The ATM call bought at 15:20 (NIFTY's 23,300 CE at ₹345.80, the conservative fill) opened at ₹328 on 4 Jun, then traded down to ₹77.45 within the 09:15 bar (close ₹122.60; `debug`). A 15:20 call lost 64–78% of its premium by 09:15 (both fills, both indices).
  - By 09:30 the synthetic had lost ₹23,254 a lot (NIFTY) and ₹29,873 (SENSEX).
- **The same call at end-of-day prints made money that night** (+₹1,160 and +₹2,073). Its first trade on 4 Jun came before the fall of the first minute, and it was above the call's 30-minute average close of 3 Jun. Neither is a fill (§6.3).
- **In March 2020** the index opened 5–9% below the close, a futures lot lost ₹45,000–65,000, and an ATM call bought at the close lost ₹15,565 and ₹22,655 a lot.

**The index and a futures lot:**

| index | nights | 5% VaR / ES | 1% VaR / ES | nights ≤ −1% / ≤ −2% / ≤ −3% | a stop 1% / 2% below the close, gapped through: nights, mean beyond the stop | the 10 worst nights (D → E) |
|---|---|---|---|---|---|---|
| NIFTY | 3,813 | −79.5 / −146.6 bp | −173.0 / −298.2 bp | 118 / 32 / 13 | 118 nights, 82 bp; 32 nights, 119 bp | 20 → 23 Mar 2020 −9.14%, 8 → 9 Nov 2016 −5.57%, 12 → 13 Mar 2020 −5.03%, 4 → 7 Apr 2025 −5.00%, 18 → 19 Mar 2020 −4.79%, 11 → 12 Mar 2020 −4.00%, 13 → 16 Mar 2020 −3.69%, 11 → 12 Jun 2020 −3.61%, 5 → 6 Feb 2018 −3.48%, 8 → 9 Aug 2011 −3.33% |
| SENSEX | 3,827 | −67.9 / −133.2 bp | −170.8 / −276.0 bp | 93 / 30 / 9 | 93 nights, 87 bp; 30 nights, 101 bp | 20 → 23 Mar 2020 −7.71%, 4 → 7 Apr 2025 −5.19%, 8 → 9 Nov 2016 −4.86%, 12 → 13 Mar 2020 −4.77%, 18 → 19 Mar 2020 −3.80%, 11 → 12 Mar 2020 −3.43%, 27 Feb → 2 Mar 2026 −3.38%, 11 → 12 Jun 2020 −3.28%, 23 → 24 Feb 2022 −3.17%, 2 → 5 Aug 2024 −2.96% |

| future | nights | 5% VaR / ES ₹ a lot | 1% VaR / ES ₹ a lot | the 8 worst nights (D; ₹ a lot, the future's move, the lot) |
|---|---|---|---|---|
| NIFTY | 1,868 | −₹8,936 / −₹16,304 | −₹20,768 / −₹32,560 | 20 Mar 2020 −₹65,423 (−10.00%, 75), 4 Apr 2025 −₹56,749 (−3.30%, 75), 6 Mar 2026 −₹45,546 (−2.85%, 65), 12 Mar 2020 −₹45,506 (−6.36%, 75), 11 Mar 2020 −₹38,201 (−4.87%, 75), 2 Mar 2026 −₹34,593 (−2.13%, 65), 30 Apr 2020 −₹30,926 (−4.19%, 75), 13 Mar 2020 −₹28,748 (−3.87%, 75) |
| SENSEX | 815 | −₹8,417 / −₹15,275 | −₹18,509 / −₹31,491 | 4 Apr 2025 −₹66,513 (−4.42%, 20), 2 Mar 2026 −₹33,608 (−2.09%, 20), 10 Apr 2026 −₹32,142 (−2.06%, 20), 18 Mar 2026 −₹28,792 (−1.88%, 20), 6 Mar 2026 −₹26,601 (−1.68%, 20), 1 Apr 2026 −₹23,261 (−1.58%, 20), 27 Mar 2026 −₹22,501 (−1.52%, 20), 8 May 2026 −₹18,509 (−1.19%, 20) |

**What a stop cannot do overnight:**
- **Nothing trades between 15:30 and 09:15, so a stop can only fill at the morning's prices.**
- **The call.** On 12–26% of the call picks' nights, the exit fill was already more than 30% below the entry fill. A −30% stop would have filled there, not at its level, and lost a further ₹1,152–2,710 a lot on average. On 3.5–16% of nights the fill was more than 50% below the entry.
- **The synthetic.** Its call leg gaps through as often (21–32% of nights at −30%). Its put leg has no cap.
- **The index and the future.** NIFTY opened 1% or more below the close on 118 of 3,813 nights (3.1%), 2% on 32 and 3% on 13. A stop 1% below the close filled at the open, on average 82 bp beyond the stop on those nights; a 2% stop filled 119 bp beyond. On 23 Mar 2020 the open was 9.1% below the close.
- **This is the risk rule N5 exists for**, and the study confirms it. A stop does not cap an overnight loss, and the only cap a buyer has is the premium.

---

## 8. Data caveats

### 8.1 The official open and close are not prices anyone traded at

- **The official open is the pre-open call auction's index value** (09:00–09:08), set from the constituents' equilibrium prices. On a gap day the index can be far from it a minute after 09:15: 5 Aug 2024 and 2 Mar 2026 in §2.1, and 4 Jun 2024 in §7.
- **The official close is built from the constituents' closing prices.** Each is the VWAP of its last 30 minutes, 15:00–15:30.
  - From 3 Aug 2026, continuous trading in NSE's F&O stocks ends at 15:15, and a closing auction sets the close; BSE runs the equivalent (`docs/DATA.md`).
  - The last 46 index nights (D from 3 Aug to 7 Oct 2026, 3% of the last 40%) use the new close.
  - The 1-minute option data ends on 2 Jul 2026, before the change.
- **So the index family measures the prints, not a trade.** The bridge (§6.1) and the futures (§6.2) measure what is left at tradeable prices.

### 8.2 The 1-minute data

- **Two data eras** (WP11 §2): bars to 31 Dec 2024 hold every trade; from 1 Jan 2025 they are built from sampled prices.
  - The closes are exact in both eras, so the mid fill is comparable across them. The conservative fill (the bar's high and low) is a true worst case only in the first era.
  - In the second era, the 09:15 bar's open is not necessarily the exchange's first trade. That is why kill check 2 uses the nights to Dec 2024 only.
- **The out-of-sample windows fall mostly in the second era.** 326 of NIFTY's 479 out-of-sample nights are in it, and all 251 of SENSEX's. Criterion 7 is the complete-bar check, and every pick fails it.
- **Coverage.**
  - 33 NIFTY and 43 SENSEX nights were skipped because the N4 contract had no file on D or E. For SENSEX these include the dataset's expiry gaps (§2.4).
  - 2 SENSEX nights had no forward for C1.
  - SENSEX's C2 ranks start in 2024 (§11).

### 8.3 Lots, charges and margin

- **Lots changed during the sample**, and every rupee figure is per lot in force on D.
  - NIFTY: 75 → 50 (mid-2021) → 25 (Apr 2024) → 75 (Nov–Dec 2024) → 65 (Dec 2025 – Jan 2026), WP14 §8.3.
  - SENSEX: 10 until late 2024, then 20.
  - From late 2024 a lot is 2–3 times larger, so rupee losses by year are not comparable without scaling (§4.3).
- **Charges.** The option charges are the dated schedule (`RESEARCH_CHARGE_SCHEDULES`), including the STT on option sales: 0.0625% (Apr 2023), 0.1% (Oct 2024) and 0.15% (Apr 2026). For futures, only the sale's STT is reported (0.01% → 0.0125% → 0.02% → 0.05%, §1.7); their other charges and their spread are not modelled.
- **Margin is not modelled.** The futures and C1's short put need it, so both are ₹5 lakh-account constructions only. The bought call needs only its premium.

### 8.4 The daily series

- **Yahoo's daily bars** were checked against the bhavcopy cache's own Yahoo download (2,465 days, none more than 0.5 pt apart) and NSE's official close (679 days, none). 19 NIFTY and 13 SENSEX regular sessions had no complete bar, and the nights touching them were skipped (§2.1).
- **SENSEX opens:** no stale or broken series from 2011. The five nights on which the two indices' gaps differ by more than 1 point are three COVID-crash opens of March 2020 and two gap days (5 Aug 2024 and 2 Mar 2026). On the two gap days, SENSEX's official open sat far below its first trades (§2.1). They are kept as published.
- **BSE files:** 7 BSE bhavcopies are missing (§2.3). The SENSEX option, futures and end-of-day nights touching them were skipped.
- **The calendar's special sessions** (Muhurat, Budget Saturdays, drills, short sessions) are never a night's start or end. A night spanning one was skipped (26 index nights, 8–10 option nights).

---

## 9. The bar, multiple testing and the ledger

- **The ledger.** `reports/trials.jsonl` went from 2,814 to **3,067 lines**: 253 `"wp": "WP15"` lines.
  - 12 index variants (A).
  - 212 option variants: 192 in family B, and 20 in family C (C1 and C1-B at two fills on two indices, and C2's three thresholds at two fills on two indices).
  - 29 descriptive lines: 18 bridge, 5 futures, 2 end-of-day call and 4 straddle lines.
  - **No perturbation lines.** No pick passed criteria 2–4, so the robustness step never ran.
  - The index, bridge and futures-return lines carry `net` and `meanPerTrade` in **index basis points, not rupees** (`params.unit` says so). No line repeats a name already in the ledger, and a rerun appends nothing.
- **Bonferroni:** 0.05 / 3,067 = 1.63 × 10⁻⁵.
  - Six index variants reach p = 1.0 × 10⁻⁵, the floor of 100,000 resamples: all nights, weekday nights and after an up day, on both indices. They pass this half of criterion 6.
  - The next smallest index p is 0.056 (NIFTY's weekend and holiday nights).
  - Every option pick has p ≥ 0.38.
- **The deflated Sharpe ratio.**
  - *Index:* V[SR] over this study's 12 index lines is 6.08 × 10⁻³, so SR₀ = 0.278 a session with N = 3,067.
    - The six variants that pass Bonferroni have SR 0.164–0.225 a session: DSR 0.000–0.022.
    - With V = 1/(T − 1): 0.995–1.000.
    - The other six have SR −0.001 to 0.043: DSR 0.000, and 0.000–0.035 with the null variance.
  - *Options:* V[SR] over the 212 option lines is 7.33 × 10⁻³ (SR₀ = 0.305). Every option pick's SR is −0.164 to +0.016 a session, so every DSR is 0.000, with either variance.
- **The criteria, pick by pick** (§1.6 numbering):
  - *Index (12):*
    - Criterion 1: passed by 10 variants. The two sell-off subsets have 156 and 161 nights.
    - Criteria 2 and 3: passed by the 6 strongest. The weekend and holiday subsets fail both placebos (NIFTY 1.71 and 1.61 SE).
    - Criterion 4: passed by those 6 and by NIFTY's weekend subset (1.30).
    - Criterion 5: N/A for the 10 subsets without a parameter. For the sell-offs, not run, because criteria 2–4 failed.
    - Criterion 6: failed by all 12.
  - *Family B (16):*
    - Criterion 1: passed by 10. The sell-off picks have 26–48 nights and SENSEX's after-a-down-day picks 123 and 126.
    - Criteria 2, 3, 4, 6 and 7: failed by all 16.
    - Criterion 5: not run.
  - *Family C (12):*
    - Criterion 1: passed by the 8 C1 and C1-B picks. The 4 C2 picks have 166 and 53 nights.
    - Criteria 2, 3, 4, 6 and 7: failed by all 12.
    - Criterion 5: not run.
    - Criterion 8 (the other index's sign): failed by all 12.
    - Criterion 9 (kill check 1): failed by all 12.
    - Criterion 10 (kill check 2): failed by NIFTY's C1 and C1-B at the conservative fill and SENSEX's C1-B at both fills. Passed by the other 8: NIFTY's C1 and C1-B at mid, both C2 picks of each index, and SENSEX's C1 at both fills.
    - Criterion 11 (C2 against C1 and a random draw): failed by all 4 C2 picks.
- **Verdicts.** All 40 judged variants (12 index, 28 option picks) are FAIL. None is INSUFFICIENT: every variant short of 180 nights also fails another criterion.

## 10. Paper-test spec

**None.** No pick passes §1.6, so by the pre-registered rule no paper-test spec is written for the ₹5 lakh paper account.
- **The index drift is not a candidate.**
  - It is a property of the official prints. It fails multiple testing.
  - Most of it falls in minutes a trader cannot hold (§6.1).
  - The one instrument that holds the index overnight, the future, keeps +1.7 bp a night before costs, less than its STT.
- **No option variant comes close.** None of the 212 has a CI above zero.
- **If anything is logged forward, it should be the descriptive series**, not a trade: the official close → open and the 15:25 → 09:30 index move, to see whether the drift's fade since 2025 continues.

## 11. What changed after the freeze

1. **No definition or code of the study changed.**
   - The development run (without the ledger) and the final run (`--ledger`) both used the code of the freeze commit `8edf6a7`, unchanged.
   - Their generated `tables.md` and `summary.json` are byte-identical.
   - `git diff 8edf6a7` shows no change to `scripts/research/wp15-overnight-drift.ts`, `src/engine/backtest/overnight.ts` or `src/engine/backtest/overnight.test.ts`.
2. **The cross-check script had two bugs, fixed after the freeze.** `scripts/research/wp15-xcheck.py` was committed at the freeze, before it had run on the data. Both fixes are in the cross-check only:
   - (a) It visited the 15:25 entry twice (once as a family-B entry and once as C1's), which doubled the 15:25 trade counts.
   - (b) It stopped with an error on a night whose chain had no listed strike (SENSEX).
   - After the fix it reproduces, from the raw files and with no shared code:
     - every index variant's night count, mean and hit rate, over all nights and the last 40% (largest difference 2.5 × 10⁻¹⁴ bp);
     - the cuts and the skips;
     - 200 of the 212 option variants (all 192 of family B, and C1 and C1-B at both fills): trade count, mean gross P&L and mean premium (largest differences 0 trades and ₹2.8 × 10⁻¹²).
   - It does not recompute C2, the bootstraps, the placebos or the verdicts.
   - Its first run (before the fix) already matched every index figure exactly.
   - The final run's `summary.json` is byte-identical to the development run's that it was compared with.
3. **Checks by hand with `debug`**, against the raw 1-minute bars and the bhavcopy: the contract (N4), the lot, the index level at the order, the strikes, the forward, every leg's fills and the charges.
   - **NIFTY 1 Apr 2026**, the call picks' worst night: the 15:25 → 09:20 ATM call at the conservative fill, bought at ₹321.25 and sold at ₹122.20, × 65 = −₹12,938 gross and −₹13,010 net, as in the tails.
   - **NIFTY and SENSEX 3 Jun 2024**, the election-result night (§7).
4. **An error in §2.4's prose** (the frozen text is left as it was).
   - It says "SENSEX's index starts on 1 Sep 2022, so C2 covers almost all of its option nights". That is wrong; the table beside it is right: 451 of SENSEX's 626 C1 nights have a rank (72%).
   - The ranks are built from valid 1-minute sessions, which need BSE's file (from 15 May 2023). SENSEX's first rank therefore falls 250 sessions later, in 2024.
   - It changes nothing else: C2 was INSUFFICIENT at best on SENSEX either way, and it failed on every other criterion.
5. **Kill check 2's table and criterion use slightly different nights for SENSEX's call** (§5.3). The table counts every night with the call's three exits priced (294). The criterion, which decides the verdict, uses the variant's own trades, which need the put at K(fwd) as well (290). At mid the two disagree on SENSEX's C1-B: the criterion says killed (₹68 → −₹39), and the table's 09:30 mean is +₹12. The variant fails on every other criterion.
6. **R6's recommendations arrived before the freeze.** C1, C1-B and C2, the futures STT dates, the before and after 1 Apr 2026 split, and R6's breakdowns (year, weekend, pre-holiday, VIX, 2011–2019 against 2020–2026) are all in §1 as frozen. Nothing was added after it.
7. **Not done:**
   - Theta and vega separately: that needs implied volatilities, which the study did not compute. The straddle half (§5.2) is their sum with the move's size.
   - Futures charges beyond STT, and any margin model.
   - Nothing was downloaded.
8. **The report's §0 and §3–§12 and the status line** were written after the runs. §1 and §2 are byte-for-byte the freeze commit's.
9. **Presentation:** the generated tables print counts in the `en-IN` grouping ("1,00,000 resamples") and dates as ISO. This report writes 100,000 and 1 Apr 2026, and keeps the lakh grouping for rupee amounts.

## 12. Reproduce

```bash
S=<scratchpad>; B=<the compact NSE and BSE bhavcopy cache>; Y=$S/research/q2/data/yahoo
IN="--nsei $Y/^NSEI_1d_since2007.json --bsesn $Y/^BSESN_1d_since2007.json --vix $Y/^INDIAVIX_1d_since2007.json \
    --x $S/wp11/data/x13 --dir $B --oi $S/wp14/raw/participant_oi"
# Inputs reused from earlier packages: Q2's Yahoo daily bars, WP13's 1-minute extract ($S/wp11/data/x13),
# the bhavcopy cache (WP6, with BSE from 15 May 2023) and WP14's participant-OI files (their names only).
# 1. Sessions, nights, cut dates and bar coverage (no returns; §2):
npx tsx scripts/research/wp15-overnight-drift.ts coverage $IN --out $S/wp15/out
# 2. The whole pipeline on synthetic numbers (no data-derived values; no ledger):
NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/research/wp15-overnight-drift.ts run --smoke $IN --out $S/wp15/out_smoke
# 3. Every variant, the walk-forward picks, the bar, the tails, the descriptive series and the ledger (~11 min):
NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/research/wp15-overnight-drift.ts run $IN --out $S/wp15/out [--ledger]
# 4. One night by hand (contract, lot, index levels, strikes, forward, every leg's fills and charges, raw bars):
npx tsx scripts/research/wp15-overnight-drift.ts debug $IN --index NIFTY --day 2026-04-01
npx tsx scripts/research/wp15-overnight-drift.ts debug $IN --index SENSEX --day 2024-06-03
# 5. The independent re-computation (~9 min):
python3 -I scripts/research/wp15-xcheck.py $Y/^NSEI_1d_since2007.json $Y/^BSESN_1d_since2007.json $S/wp11/data/x13 $B \
  $S/wp14/raw/participant_oi --summary $S/wp15/out/summary.json
# 6. Unit tests of the new pure helpers:
npx vitest run src/engine/backtest/overnight.test.ts
```

| file | what it holds |
|---|---|
| `scripts/research/wp15-overnight-drift.ts` | The `coverage`, `run` and `debug` commands: the calendar and nights, the index family (A), the call buyer (B) and R6's variants (C) on the 1-minute extract, the descriptive series (D1–D4), the bar, the tails, the ledger and the tables; `--smoke` replaces every price-derived value with a hashed synthetic number |
| `scripts/research/wp15-xcheck.py` | The independent re-computation of the index nights and the B, C1 and C1-B trades (§11) |
| `src/engine/backtest/overnight.ts` (+ `.test.ts`) | The new pure helpers, with tests: `calendarDays`, `nightKind`, `nightsBetween` (nights that span a special session), `passesFilter`, `needsChange`, `fairCoinDays` (the call-or-put placebo's exact expectation), `tailRisk` (VaR and ES), `gapThroughStop`, `halves` |

- **Reused code.**
  - Fills, positions and the paired placebo gap come from WP11's `intraday1m.ts` (`runPosition`, `nearestListed`, `itmStrike`, `pairedGap`). The cut, the pick, robustness and the verdicts come from WP13's `expiryCalendar.ts` (`cutDate`, `pickBest`, `robustness`, `overallVerdict`).
  - The block bootstrap, `trailingRank` and `wilson` come from WP14's `positioning.ts`.
  - The day-block bootstrap, profit factor and DSR come from `metrics.ts`. Charges and structure P&L come from WP10's `shortPremium.ts`, and the ledger from `trials.ts`.
  - The loaders come from `real_prices.ts` and `wp11-real-intraday.ts`.
- **Isolation.** Nothing in the engine imports the new code.
- **Data.** No market data is committed. The generated tables, `coverage.md`, `coverage.json` and `summary.json` stay in the scratchpad.
