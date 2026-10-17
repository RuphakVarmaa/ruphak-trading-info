# WP9b: buy signals under the §12 bar — N2, N3, N4, the first 15-minute candle, and the morning noise area with in-the-money strikes

Fri 9 Oct 2026. Branch `worktree-agent-a5be012aef85da208`, started from `72d9d37` (head of `claude/gifted-wright-3d8r3j`). Paper research only: nothing was deployed or pushed, and every switch added here is off by default. Every option price in this report is synthetic (Black–Scholes on India VIX; see §10).

## 0. Bottom line

**No candidate passes §12, on either account, on either 5-minute sample or on two years of hourly bars, and none comes close.** The best gap over a random-entry placebo with the same structure is 1.35 SE in the protocol runs (1.74 SE in one supplementary hourly measure) against the 2 SE required before any multiple-testing correction; the best bootstrap p is about 0.3 against a Bonferroni level of 3×10⁻⁵ to 7×10⁻⁵ (706 to 1,562 logged trials when the runs were judged); no 5-minute run has more than 56 trades against the 180 required; and every candidate's synthetic prices fail the real-price check (20–63% of trades inside the real day range, bar 90%).

- **The plan's no-entry rules do what cost filters do, and no more.** N4 measurably cheapens the trades it touches (next week's contract loses ₹131 less per main trade, t ≈ 2.5, and ₹208 less per ₹10k trade). N3 cuts the cost of a zero-edge trade by about 35–40% by shortening the hold (random morning entries lose −₹249/−₹235 against −₹379/−₹391 all day; −₹223 against −₹362 on hourly bars). N2 cannot be judged with a pricer that ties implied volatility to VIX, and blocks more than half of all sessions. On the engine's own signals all three together cut the loss from −₹339 to −₹61/−₹35 a trade, but the engine's entries stay indistinguishable from random entries under the same rules (0.7 SE).
- **The first 15-minute candle (E2a) is the only candidate with a directional effect on our data.** Measured from the candle's close, the index followed it by +25 bps to 15:05 (t 2.3 on 21 days; counting the candle's own move inflates this to +62 bps and 94% "continuation"). Held to 15:05, the option made +₹452/+₹646 a trade on main, but on 32/34 trades, carried by two bearish trend days in a falling market, with p ≈ 0.3, a threshold that loses at −20%, and synthetic prices. The ₹10k account lost on it. Out at 11:15 it shows nothing.
- **The morning noise area with in-the-money strikes** is the cheapest structure tested (a random morning entry at the same moments loses only ₹50–100 a trade at calibrated IV), but the rule's side adds nothing to random entries (0.06–0.34 SE on 5-minute data, 0.55–0.76 SE over two years). This is indicative only: those prices fail the real-range check too (61% in range).

**Recommendation:** enable nothing and keep buying paused. Log the first-candle rule in shadow from the nightly archive, frozen as tested, and evaluate it once at about 180 candles (around September 2027); get real intraday option prices before trusting any rupee figure for it. Keep N4 ready for the day a signal passes.

---

## 1. What was built (all off by default)

| switch | default | what it does | where |
|---|---|---|---|
| `rules.n2.enabled` | off | **N2.** No entry when India VIX's previous close is > 10% above its close five sessions earlier, India VIX is > 8% up on the day at the decision, the previous VIX close is in the top third of its past year (percentile rank > 2/3 over 252 closes), or the index moved > 2% over five sessions (\|ln close(D−1)/close(D−6)\|). Fails closed when the history is too short. | `src/engine/strategy/rules.ts`; gate `vol_jump` in the planner |
| `rules.n3.enabled` | off | **N3.** New entries only when the decision falls in [09:30, 11:15); every position's square-off becomes 11:15 (the exit happens on the 11:15 bar, at 11:16:30 with Yahoo's 90 s lag). | `rules.ts`; gate `morning_only`; the plan's `stops.squareOffMs` |
| `rules.n4.enabled` | off | **N4.** Never buy a contract with fewer than two sessions after today to its expiry (sessions on the trading calendar, so a holiday-shifted expiry counts correctly); take the next weekly, or skip when no listed contract qualifies. Applies to main's ATM pick and the small accounts' premium band. | `optionSelect.chooseExpiryFor` |
| `selection.itmSteps` | 0 | ATM mode only: buy that many strikes in the money (calls below, puts above the ATM strike). | `optionSelect.chooseContract` |
| `strategy.mode: "FIRST_CANDLE"` | `CONVICTION` | **E2a.** The 09:15–09:30 candle (three closed 5-minute bars); a body (close ÷ 09:15 open − 1) larger than 0.24% buys the call (up) or put (down) at the first decision after the candle closes (09:31:30); one entry per index a day; held to the 15:05 square-off (or N3's 11:15) with the premium stop as a disaster stop. The trade starts at the candle's close, so the candle's own move is never counted. | `src/engine/strategy/published/firstCandle.ts` |
| `BacktestInput.perfOverlay` | true | `false` skips main's end-of-day per-source performance update, so Kelly sizing and the decay monitor never stop a rule (WP3 ran the published rules this way). | `runBacktest.ts` |
| placebo | — | Follows the variant's rules: N4 and ITM through the contract choice, N3's slots and exit, N2's blocked draws redrawn; for a published rule, its own decision times, drawn **only when the rule enters (on either side)**, and its exits for the drawn side (no premium target, trail or time stop). | `src/engine/backtest/placebo.ts` |
| perturbations | — | Each enabled rule's own parameters join the ±20% set (N2's four thresholds, N3's start and exit, the candle threshold, the noise area's lookback, band and grid). In a published mode the conviction parameters, which act on neither entries nor exits there, are replaced by the rule's; the premium stop stays. The default engine keeps exactly its 18. | `src/engine/backtest/protocol.ts` |
| CLI | — | `--n2 --n3 --n4 --itm-steps N --iv-source vix\|calibrated --strategy first-candle [--fc-body --fc-range-min] --no-perf-overlay --placebo-any-time` | `scripts/backtest.ts` |
| research runner | — | 2-year hourly runs with the protocol's verdicts, the rules on random entries, data diagnostics, the tables in this report | `scripts/research/wp9b-buy-signals.ts` |

Plain-language reasons for the two new gate ids were added to the copy desk (`src/lib/copy/action.ts`), and its gate-id test now scans `rules.ts` too.

**Definitions taken from the evidence, not tuned.** N2's thresholds are the plan's (§4). Its daily conditions use the previous close, exactly as the Q1 study behind the rule measured them (`scratchpad/research/q1/scripts/panel.py`: `vix_chg5_prev`, `vix_pctile`, `ret5_prev`). The plan says "top third of its 1-year range", but the evidence used the percentile rank of the close among the previous year's closes, and so does the switch. "8% on the day" is the engine's own intraday VIX change (`features.vixChangePct`), the measure that already marks the EVENT regime at 8%. N4's "one session or less" is Q1's DTE (trading days after today through expiry). The first candle's 0.24% and 15 minutes come from the study cited in `docs/research/notes/r4-preopen-gaps.md` §4.2. Yahoo's 09:15 open is the official open (exact on 38 of 59 NIFTY sessions, within about 0.01% on the rest; SENSEX within 0.1%), so the body is measured from the real open.

**The default is unchanged.** `npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits --history scratchpad/why/hist.json` prints **58 trades, net −₹20,158.44**, and its report JSON is byte-identical (`cmp`) to the one written before any change, both after the engine commit and on the final code.

---

## 2. How each candidate was evaluated

**Declared before any run** (nothing below was chosen after seeing a result):

| id | candidate | engine | frozen source (`--frozen`) |
|---|---|---|---|
| C1 | N2 | the engine's own signals (conviction model) | not frozen: the conviction model was tuned on recent backtests |
| C2 | N3 | same | not frozen |
| C3 | N4 | same | not frozen |
| C4 | N2 + N3 + N4 | same | not frozen |
| C5 | E2a, held to 15:05 | `FIRST_CANDLE`, overlay off | plan §6 E2(a), 0.24% |
| C6 | E2a + N3 (out at 11:15) | same | plan §6 E2(a) + §4 N3 |
| C7 | noise area + N3, 1 strike ITM, calibrated IV | `NOISE_AREA` (WP3's build, as published: 14 sessions, VM 1, HH:00/HH:30), overlay off | Zarattini, Aziz & Barbon (2024) + plan §4 N3 + plan §7 |
| C8 | same with 2 strikes ITM | same | same + the brief's "1–2 strikes" |
| H0–H7 | the hourly versions (§4) | WP3's 2-year hourly harness | the noise area + the rules |

**Protocol runs (5-minute).** `npm run backtest -- --no-events --prod-limits --account small10k --protocol --bootstrap 100000 …` for every candidate on two samples:

- the reference snapshot `scratchpad/why/hist.json`, 23 Jul – 8 Oct 2026 (54 sessions);
- the 60-day archive `scratchpad/archive/yahoo-5m-archive.json`, 23 Jul – 9 Oct 2026 (55 sessions).

**The two samples are not independent.** They hold the same Indian 5-minute bars on 54 sessions (WP1 checked: 0 differences). The archive adds 9 Oct and true 5-minute cross-asset windows, which reach only the conviction model's GAP and GLOBAL_BETA votes. So for the published rules (C5–C8) the two runs differ by one session. For C1–C4 they show how fragile the conviction model's trade list is to its cross-asset inputs, not a second test.

Each protocol run replays the variant with the engine's fills and with the copy delay (fills one closed bar later plus 2 ticks per side, at market), runs a 3,000-draw placebo matched to the variant (same draws with and without the delay), perturbs every relevant parameter by ±20% one at a time, bootstraps whole sessions 100,000 times (enough for Bonferroni up to N = 4,999 ledger lines), and applies Bonferroni and the deflated Sharpe ratio over `reports/trials.jsonl`. Main runs at production's limits (one lot, two open positions, eight entries a day); the ₹10k account follows main's signals with its premium band, one lot, −35%/+60% exits and its own caps (for the published rules, the rule's exits).

**Why the placebo is drawn only when the rule fires.** A published rule enters at specific moments (the 09:30 close of a large candle, a band break). Those moments have bigger moves than average, and a long option gains from size as well as direction. Drawing the placebo at the same moments with a random side keeps the size effect in both arms, so strategy − placebo measures the side choice. Drawing at any decision time would credit the timing to the signal. §4 shows the difference is material.

**Criteria 1–2 for C1–C4 fail by construction.** The conviction model's weights and thresholds were tuned on this period, so the protocol treats any variant of it as fitted (WP0). N2–N4 are frozen plan rules, but applying them to a fitted signal does not make the signal frozen. For these runs the informative criteria are 5–8.

---

## 3. Results on 5-minute data: the protocol, per candidate, account and sample

**The yardstick: the current defaults** (no rule; copy delay; 3,000-draw placebo with the engine's own exits):

| sample | account | trades | ₹/trade | placebo ₹/trade | gap ₹ (SE) |
|---|---|---|---|---|---|
| reference (54 sessions) | main | 50 | −339 | −379 | +40 (0.12) |
| reference | ₹10k | 17 | −266 | −301 | +35 (0.19) |
| archive (55 sessions) | main | 49 | −339 | −391 | +53 (0.15) |
| archive | ₹10k | 18 | −271 | −304 | +32 (0.21) |

**Every candidate** (₹/trade = the evaluation run, with the copy delay; placebo = matched to the candidate, same 3,000 draws with the delay; gap in units of the larger of the i.i.d. and day-block SE, 2.00 needed; 95% CI per trade from 100,000 day-block resamples; p = the larger of the per-trade and per-session bootstrap p, to be compared with Bonferroni 0.05/N, 7.1×10⁻⁵ down to 3.2×10⁻⁵ as the ledger grew from 706 to 1,562 lines during the runs):

| candidate | sample | account | trades | ₹/trade | placebo ₹/trade | gap ₹ (SE) | 95% CI ₹/trade | p | PF | ±20% > 0 | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C1 N2 | reference | main | 40 | −570 | −456 | −114 (−0.50) | −999 … −108 | 0.991 | 0.29 | 0/44 | FAIL |
| | | ₹10k | 14 | −364 | −361 | −3 (−0.02) | −629 … −136 | 0.998 | 0.15 | 0/44 | FAIL |
| | archive | main | 33 | −678 | −437 | −241 (−0.90) | −1,206 … −162 | 0.995 | 0.22 | 0/44 | FAIL |
| | | ₹10k | 16 | −264 | −350 | +86 (0.68) | −513 … −18 | 0.982 | 0.26 | 0/44 | FAIL |
| C2 N3 | reference | main | 45 | −368 | −249 | −119 (−0.35) | −1,017 … +303 | 0.861 | 0.58 | 0/40 | FAIL |
| | | ₹10k | 12 | −403 | −198 | −205 (−1.20) | −787 … −114 | 0.998 | 0.04 | 0/40 | FAIL |
| | archive | main | 45 | −244 | −235 | −9 (−0.03) | −879 … +374 | 0.780 | 0.67 | 1/40 | FAIL |
| | | ₹10k | 12 | −402 | −192 | −210 (−1.72) | −653 … −171 | 0.999 | 0.02 | 0/40 | FAIL |
| C3 N4 | reference | main | 56 | −178 | −359 | +181 (0.42) | −949 … +722 | 0.677 | 0.81 | 0/36 | FAIL |
| | | ₹10k | 15 | −340 | −265 | −75 (−0.40) | −691 … −56 | 0.990 | 0.33 | 0/36 | FAIL |
| | archive | main | 46 | −266 | −372 | +106 (0.23) | −1,075 … +744 | 0.735 | 0.72 | 1/36 | FAIL |
| | | ₹10k | 17 | −284 | −268 | −16 (−0.10) | −631 … 0 | 0.975 | 0.35 | 0/36 | FAIL |
| C4 N2+N3+N4 | reference | main | 34 | −61 | −245 | +184 (0.70) | −592 … +439 | 0.596 | 0.88 | 11/48 | FAIL |
| | | ₹10k | 21 | −172 | −187 | +15 (0.14) | −384 … +56 | 0.934 | 0.42 | 0/48 | FAIL |
| | archive | main | 33 | −35 | −233 | +198 (0.74) | −584 … +469 | 0.546 | 0.93 | 6/48 | FAIL |
| | | ₹10k | 20 | −173 | −179 | +6 (0.05) | −414 … +81 | 0.910 | 0.44 | 1/48 | FAIL |
| C5 first candle, to 15:05 | reference | main | 32 | **+452** | −819 | +1,270 (1.09) | −1,637 … +2,892 | 0.372 | 1.32 | 3/4 | FAIL |
| | | ₹10k | 9 | −551 | −510 | −40 (−0.10) | −1,216 … +279 | 0.918 | 0.32 | 1/4 | FAIL |
| | archive | main | 34 | **+646** | −850 | +1,496 (1.35) | −1,370 … +2,985 | 0.295 | 1.48 | 3/4 | FAIL |
| | | ₹10k | 9 | −551 | −526 | −24 (−0.06) | −1,216 … +276 | 0.919 | 0.32 | 1/4 | FAIL |
| C6 first candle + N3 | reference | main | 32 | −187 | −445 | +257 (0.56) | −1,040 … +754 | 0.671 | 0.78 | 1/8 | FAIL |
| | | ₹10k | 19 | −134 | −301 | +167 (0.72) | −565 … +342 | 0.730 | 0.72 | 1/8 | FAIL |
| | archive | main | 34 | +79 | −424 | +503 (1.00) | −859 … +1,114 | 0.452 | 1.10 | 6/8 | FAIL |
| | | ₹10k | 20 | −20 | −281 | +261 (1.05) | −480 … +487 | 0.547 | 0.96 | 1/8 | FAIL |
| C7 noise area + N3, 1 ITM, cal. IV | reference | main | 38 | −74 | −96 | +22 (0.06) | −855 … +674 | 0.576 | 0.90 | 3/12 | FAIL |
| | | ₹10k | 27 | −128 | −76 | −52 (−0.34) | −418 … +178 | 0.802 | 0.67 | 0/12 | FAIL |
| | archive | main | 39 | +52 | −60 | +113 (0.28) | −738 … +828 | 0.450 | 1.07 | 7/12 | FAIL |
| | | ₹10k | 28 | −69 | −61 | −8 (−0.05) | −370 … +248 | 0.676 | 0.81 | 2/12 | FAIL |
| C8 noise area + N3, 2 ITM, cal. IV | reference | main | 38 | −30 | −85 | +55 (0.13) | −900 … +804 | 0.530 | 0.96 | 5/12 | FAIL |
| | | ₹10k | 27 | −128 | −76 | −52 (−0.34) | −418 … +178 | 0.802 | 0.67 | 0/12 | FAIL |
| | archive | main | 39 | +101 | −49 | +150 (0.34) | −777 … +957 | 0.412 | 1.13 | 9/12 | FAIL |
| | | ₹10k | 28 | −69 | −61 | −8 (−0.05) | −370 … +248 | 0.676 | 0.81 | 2/12 | FAIL |

(The ₹10k rows of C7 and C8 are identical: its premium band ignores the ITM setting. The ₹10k account's C5 book stops after 9 trades, before 9 Oct, so both samples give the same trades.)

Criterion by criterion: **1–2** pass for the frozen published rules (C5–C8) and fail by construction for C1–C4 (§2); **3** is INSUFFICIENT for every run (9–56 trades against 180); **4** passes everywhere (every cost, copy delay included); **5, 6, 8, 9 fail for every run** on both accounts and both samples; **7** fails everywhere (C5 has PF 1.32/1.48 and a small drawdown, but no profit concentration test can pass when two sessions make the whole profit); **10** is printed N/A by the protocol and fails when measured (below); **11** awaits review; **12** fails (the ₹10k account fails in every run). **Overall: FAIL for every candidate, account and sample.**

**Real prices (criterion 10), measured.** WP6's tool on main's trades (engine fills) against the exchange files for those contracts and days:

| run | trades with a real row | entry in the day's real range | exit in range | **both in range** | entry above the day's real high |
|---|---|---|---|---|---|
| C1 (N2) | 41 | 32% | 44% | **20%** | 68% |
| C2 (N3) | 45 | 40% | 56% | **36%** | 60% |
| C4 (N2+N3+N4) | 34 | 32% | 35% | **26%** | 68% |
| C5 (first candle, to 15:05) | 32 | 66% | 72% | **56%** | 34% |
| C6 (first candle, to 11:15) | 32 | 66% | 69% | **63%** | 34% |
| C7 (noise area, 1 ITM, calibrated IV) | 38 | 87% | 61% | **61%** | 13% |
| C8 (noise area, 2 ITM, calibrated IV) | 38 | 87% | 63% | **61%** | 13% |

The bar is 90%. The calibrated pricer with ITM strikes gets entries mostly right (87%) but not exits; the default pricer prices most morning entries above anything that traded that day. **Every rupee figure in this report is indicative only.**

**Reading, candidate by candidate.**

- **C1, N2 on the engine's signals: worse.** N2 removes about a third of the trades (58 → 40 and 33) and the rest lose more: −₹570 and −₹678 a trade, with intervals entirely below zero on main. The matched placebo also gets worse (−₹456/−₹437 against −₹379/−₹391 for the defaults): in this sample and pricer, the days N2 blocks (the late-September and October sell-off with VIX up 13–30% over five sessions) were the ones whose big moves paid long options.
- **C2, N3 on the engine's signals: cheaper trades, no better than random.** 45 trades at −₹368 and −₹244, against morning random entries at −₹249 and −₹235 (gaps −0.35 and −0.03 SE). N3 lowers the zero-edge cost by about ₹130–155 a trade (shorter holds); the engine's morning signals add nothing to it. The ₹10k account is worse than its placebo (−₹403/−₹402 against −₹198/−₹192).
- **C3, N4 on the engine's signals: a little cheaper, no better.** 56 and 46 trades at −₹178 and −₹266 (−₹339 and −₹310 with the engine's own fills), against placebos of −₹359/−₹372 (gaps 0.42 and 0.23 SE; no perturbation positive on the reference sample). N4 acts on about one session in five, so its saving on random entries is about ₹20 a trade overall (−₹379 → −₹359), consistent with the ₹131 it saves on each trade it touches (§5). The ₹10k account: −₹340/−₹284 against −₹265/−₹268.
- **C4, N2 + N3 + N4 on the engine's signals: the smallest losses, still no signal.** 34 and 33 trades at −₹61 and −₹35 (−₹17 and +₹52 with the engine's own fills), against placebos of −₹245 and −₹233: gaps +₹184 and +₹198 (0.70 and 0.74 SE), 11 and 6 of 48 perturbations positive. Most of the improvement over the defaults (−₹339) is the cheaper zero-edge structure (the placebo moved from −₹379 to −₹245); the rest is within one SE. The ₹10k account: −₹172/−₹173 against −₹187/−₹179.
- **C5, the first candle held to 15:05: the only positive point estimate, carried by two days.** Main makes +₹452 and +₹646 a trade on 32 and 34 trades (PF 1.32/1.48), against a matched placebo of −₹819/−₹850 (random sides on the same candle days, held the same way): gaps +₹1,270 and +₹1,496, but only 1.09 and 1.35 SE, because a trade's P&L swings by ±₹4,700. The intervals are −₹1,637 … +₹2,892 and −₹1,370 … +₹2,985 (p 0.37 and 0.30). Three trades on two bearish trend days (15 Sep, 8 Oct; +₹35,017) make the whole result; the other 29 lose −₹20,567. Bearish entries average +₹1,446 and bullish −₹2,089, in a falling market. A 0.192% threshold (the −20% perturbation) turns it into −₹10,551 on 40 trades. The ₹10k account, whose band options are far out of the money, loses −₹551 a trade on 9 trades before it stops (its placebo −₹510/−₹526).
- **C6, the first candle out at 11:15: no.** −₹187 and +₹79 a trade (32/34 trades) against −₹445/−₹424 (0.56 and 1.00 SE); the ₹10k account −₹134/−₹20 against −₹301/−₹281 (0.72 and 1.05 SE). Consistent with the index: the candle's follow-through comes after 11:15 (+7 bps by 11:15, +25 bps by 15:05; §9).
- **C7 and C8, the morning noise area with ITM strikes and calibrated IV: cheap, and random.** −₹74/+₹52 (1 ITM) and −₹30/+₹101 (2 ITM) a trade on 38–39 trades, against matched placebos of −₹96/−₹60 and −₹85/−₹49: gaps 0.06–0.34 SE. This is the cheapest zero-edge structure measured in this work (random morning band-break entries in an ITM option at calibrated IV lose only about ₹50–100 a trade), which is the WP3 finding turned into rupees: the option drag can be cut, but the rule's choice of side adds nothing measurable on top. The ₹10k account cannot buy ITM inside its premium cap; with its band option it loses −₹128/−₹69 against −₹76/−₹61.

---

## 4. Two years of hourly bars (31 Oct 2023 – 8 Oct 2026)

WP3's approximation, unchanged: decisions at the hourly closes 10:15 … 14:15 (seen 90 s later), square-off at the 15:15 close, today's lot sizes and expiry weekdays applied to the 2023–2026 index paths, holidays inferred from missing bars, through the engine's planner (every gate, N2–N4 when on), paper broker, risk state and position cycle. N2 reads Yahoo's daily closes (10 years, so the 1-year percentile exists from the start). On hourly bars **N3 is a single morning decision (10:15) held to the 11:15 close**, a coarser version of the 5-minute rule. The first-candle rule cannot be expressed on hourly bars. The copy cost is +2 ticks per side at market only (a bar of delay would be an hour), so criterion 4 fails by construction.

**The harness reproduces WP3 to the rupee.** H0 (the noise area as WP3 ran it) gives 694 trades, −₹2,13,505 with the engine's fills and −₹316 per trade with +2 ticks, and 6 trades / −₹5,049 for the ₹10k account's own book: WP3's table C exactly.

**Main account** (its own book; ₹/trade with +2 ticks per side; placebo = matched, 3,000 draws; gap in units of the larger of the i.i.d. and day-block SE; 95% day-block bootstrap CI, 100,000 resamples):

| run | rule set | trades | ₹/trade | placebo ₹/trade | gap ₹ (SE) | 95% CI ₹/trade | p | PF | ±20% > 0 | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| H0 | noise area (WP3) | 694 | −316 | −362 | +46 (0.23) | −694 … +75 | 0.945 | 0.80 | 0/6 | FAIL |
| H1 | + N2 | 326 | −285 | −314 | +29 (0.13) | −722 … +169 | 0.894 | 0.78 | 0/14 | FAIL |
| H2 | + N3 | 372 | −136 | −223 | +87 (0.57) | −421 … +178 | 0.817 | 0.83 | 0/8 | FAIL |
| H3 | + N4 | 665 | −246 | −305 | +59 (0.29) | −632 … +150 | 0.891 | 0.84 | 0/6 | FAIL |
| H4 | + N2 + N3 + N4 | 182 | −92 | −282 | +190 (1.30) | −381 … +191 | 0.738 | 0.85 | 0/16 | FAIL |
| H5 | + N3, ATM, calibrated IV | 380 | −110 | −194 | +84 (0.55) | −393 … +201 | 0.772 | 0.86 | 0/8 | FAIL |
| H6 | + N3, 1 strike ITM, calibrated IV | 374 | −90 | −178 | +89 (0.55) | −394 … +243 | 0.717 | 0.89 | 0/8 | FAIL |
| H7 | + N3, 2 strikes ITM, calibrated IV | 353 | −44 | −180 | +135 (0.76) | −379 … +319 | 0.610 | 0.95 | 1/8 | FAIL |

Every main-account run fails criteria 4 (by construction here), 5, 6, 7, 8 and 9; criteria 1–3 pass (frozen rules, 182–694 trades), 10–11 are N/A.

**₹10k account.** Its own book stops after 6–36 trades in every variant: a few losses leave too little equity for one lot inside its premium cap (WP3 saw the same), so its protocol verdict is FAIL with criterion 3 INSUFFICIENT everywhere. Its per-trade economics come from main's entries priced with its premium-band contract on a fresh account each time (+2 ticks, the rule's exits):

| run | ₹10k own book: trades, ₹/trade | main's signals, fresh ₹10k account: trades | ₹/trade | placebo ₹/trade | gap ₹ (SE) | 95% CI ₹/trade |
|---|---|---|---|---|---|---|
| H0 | 6, −853 | – (WP3: 666, −326 ± 80) | | | | |
| H1 (N2) | 6, −1,007 | 324 | −345 | −316 | −29 (−0.24) | −577 … −101 |
| H2 (N3) | 13, −400 | 360 | −125 | −182 | +58 (0.66) | −282 … +59 |
| H3 (N4) | 7, −716 | 614 | −244 | −256 | +11 (0.11) | −441 … −35 |
| H4 (N2+N3+N4) | 36, −159 | 174 | −75 | −211 | +136 (1.74) | −229 … +78 |
| H5 (N3, calibrated) | 10, −502 | 369 | −89 | −142 | +54 (0.65) | −240 … +85 |
| H6 (N3, 1 ITM†) | 10, −502 | 368 | −91 | −142 | +51 (0.62) | −243 … +83 |
| H7 (N3, 2 ITM†) | 10, −502 | 351 | −75 | −142 | +67 (0.78) | −231 … +106 |

† The ₹10k account buys in its premium band, so the ITM setting does not reach it (an in-the-money NIFTY lot costs more than its ₹10,000); H5–H7 differ only through main's entries.

**Reading.**

- **No variant has a signal.** The best gap over the matched placebo is 1.3 SE on main (H4) and 1.74 SE for the ₹10k contract (H4, fresh accounts), against 2 SE required before any multiple-testing correction, and every per-trade mean is negative.
- **The noise area's apparent edge over random was mostly timing.** WP3 measured +₹192 a trade (1.3 SE) against random half-hour entries with the same exits. Against random sides *at the moments the band breaks*, it is +₹46 (0.2 SE): band breaks come with bigger moves, which a long option is paid for whichever way it faces.
- **N3 halves the loss by shortening the hold, not by finding the right hour.** Its one-hour morning trades lose −₹136 against −₹316 for the full-day rule, and its placebo improves almost as much (−₹362 → −₹223). §5 shows a one-hour hold from 10:15 costs about what a one-hour hold costs at other hours on these bars.
- **ITM strikes help, within noise.** With N3 and calibrated IV, main's loss per trade goes −₹110 (ATM) → −₹90 (1 ITM) → −₹44 (2 ITM), and the matched placebo −₹194 → −₹178 → −₹180. More delta per rupee of theta lowers the zero-edge cost a little and lets a small directional effect show, but the best case is still −₹44 a trade with an interval of −₹379 … +₹319.
- **All four rules together (H4) give the smallest losses** (−₹92 main, −₹75 per ₹10k trade) on the fewest trades (182 in two years), and still fail every statistical criterion.

---

## 5. What the rules do to trades with no signal at all

The cleanest test of a no-entry rule is on random entries: thousands of draws, the same draws priced with and without the rule wherever possible. Two years of hourly bars, 3,000 draws per account, a random side at a random hourly decision, the premium stop only, +2 ticks per side at market.

| group | main: n | ₹/trade | SE (day) | ₹10k: n | ₹/trade | SE (day) |
|---|---|---|---|---|---|---|
| all draws, held to the 15:15 close | 2,793 | −608 | 65 | 2,707 | −458 | 41 |
| N2 allows the draw | 1,265 | −626 | 77 | 1,254 | −485 | 47 |
| N2 blocks the draw | 1,528 | −593 | 102 | 1,453 | −436 | 64 |
| draws where N4 changes the contract: nearest weekly (1 session left) | 512 | −693 | 131 | 442 | −547 | 103 |
| the same draws with N4's contract (next weekly) | 512 | −562 | 132 | 442 | −339 | 65 |
| **N4 minus nearest, paired** | 512 | **+131** | **53** | 442 | **+208** | **49** |
| 1-hour hold from 10:15 (N3's morning hour on hourly bars) | 576 | −292 | 90 | 556 | −223 | 51 |
| 1-hour hold from 11:15 | 620 | −347 | 71 | 593 | −250 | 39 |
| 1-hour hold from 12:15 | 545 | −268 | 62 | 529 | −206 | 38 |
| 1-hour hold from 13:15 | 606 | −299 | 71 | 592 | −218 | 42 |
| 1-hour hold from 14:15 | 446 | −189 | 95 | 437 | −185 | 57 |

- **N4 does what it says.** On the draws where it acts (the day before an expiry), next week's contract loses ₹131 less per main trade (paired SE ₹53, t ≈ 2.5) and ₹208 less per ₹10k trade (SE ₹49, t ≈ 4.2). That matches the plan's real-price evidence (10.6% of premium lost with one session left against 4.6% with 2–5) and is the one rule with a clear, measurable saving. It acts on about one session in five per index (18% of these draws), so its effect on a whole strategy is about a fifth of that.
- **N2 saves nothing under the engine's pricer.** It blocks 55% of draws over two years, and blocked draws lost no more than allowed ones (−₹593 vs −₹626 main; −₹436 vs −₹485 ₹10k). The evidence for N2 is on *real* prices: after a VIX jump the real straddle lost about twice as much (−₹2,269 vs −₹1,104), because real implied volatility and realised movement part company on those days. A pricer that sets implied volatility to a fixed multiple of VIX cannot reproduce that, so this test can neither confirm nor reject N2; it does show that N2 removes more than half of all trading days.
- **N3's premise cannot be seen on hourly bars.** A one-hour hold from 10:15 cost −₹292, against −₹189 to −₹347 at other hours (SEs ₹60–95). The plan's evidence is about 09:15–10:15 (30% of the day's movement in 16% of the time), which hourly decisions cannot reach; the 5-minute runs (C2, C4, C6) can, and are in §3.

---

## 6. Direction before the option: index-level moves

The signed index move from each main-account trade's entry to its exit (the spot the option was priced at; 5-minute runs: the copy-delay evaluation run), before any option effect. Day-clustered SEs.

| run | trades | mean move | SE | t | right |
|---|---|---|---|---|---|
| C1 N2 (reference / archive) | 40 / 33 | −1.8 / −3.8 bps | 3.2 / 3.6 | −0.6 / −1.1 | 38% / 52% |
| C2 N3 | 45 / 45 | −1.9 / +0.1 bps | 4.5 / 4.2 | −0.4 / 0.0 | 47% / 58% |
| C3 N4 | 56 / 46 | +0.9 / +0.6 bps | 5.4 / 5.9 | 0.2 / 0.1 | 36% / 52% |
| C4 N2+N3+N4 | 34 / 33 | +2.6 / +4.6 bps | 3.5 / 3.2 | 0.7 / 1.5 | 62% / 64% |
| C5 first candle (premium stops cut 13 trades short) | 32 / 34 | +14.6 / +18.1 bps | 13.0 / 12.7 | 1.1 / 1.4 | 53% / 56% |
| C6 first candle + N3 | 32 / 34 | +3.8 / +6.7 bps | 5.4 / 5.8 | 0.7 / 1.1 | 50% / 53% |
| C7 = C8 noise area morning (same entries and exits) | 38 / 39 | +3.5 / +4.8 bps | 4.8 / 4.8 | 0.7 / 1.0 | 53% / 54% |
| H0 noise area, 2 years (WP3: +5.1 bps) | 694 | +5.1 bps | 2.4 | 2.2 | 52% |
| H1 + N2 | 326 | +5.4 bps | 2.7 | 2.0 | 55% |
| H2 + N3 (one hour from 10:15) | 372 | +1.7 bps | 1.8 | 1.0 | 55% |
| H3 + N4 | 665 | +5.0 bps | 2.4 | 2.1 | 53% |
| H4 + N2 + N3 + N4 | 182 | +2.1 bps | 1.8 | 1.1 | 57% |
| H5/H6/H7 + N3, calibrated (ATM / 1 ITM / 2 ITM) | 380 / 374 / 353 | +1.4 / +1.5 / +1.7 bps | 1.8 | 0.8–0.9 | 54–55% |

- The engine's own entries, with any of the rules, move the index by a few basis points either way: the rules change *which* trades are taken, not whether their direction is right.
- The noise area's small momentum effect (+5 bps a trade over two years, as WP3 found) survives N2 and N4 but not N3: held for one morning hour it is +1.7 bps, about ₹150 a lot at delta 0.6, against the ₹180–195 a matched random trade costs (H5–H7).
- The first candle is the only rule whose trades move the index by more than ~5 bps; held to 15:05 without stops the move is +25 bps (§9). At delta 0.5 that is worth about ₹1,900 a lot (NIFTY near 23,600 × 65, SENSEX near 75,300 × 20), against roughly ₹800 of option drag for a 5½-hour hold (the C5 placebos), which is why it is the only candidate with a positive option-level estimate.

---

## 7. What passed, what did not, and why

**Nothing passed.** Every candidate fails criteria 5, 6, 8 and 9 on both accounts and both 5-minute samples, and the hourly versions fail 5–9 on two years; the 5-minute runs are also INSUFFICIENT on criterion 3, and every candidate fails the real-price check (criterion 10, measured above). In order of weight:

1. **No candidate chooses its side better than chance, by a margin the data can detect.** The largest gaps over a placebo with the same structure are 1.35 SE (C5 on the archive), 1.74 SE (H4, main's signals on fresh ₹10k accounts) and 1.30 SE (H4, main); everything else is below 1.1 SE or negative. The index-level moves (§6) agree: the engine's entries and the noise area's morning breaks move the index by a few basis points either way; only the first candle shows more.
2. **N2–N4 are cost filters, and costs are no longer the bottleneck once the structure is cheap.** N3 + ITM + calibrated IV brings a zero-edge trade to ₹50–100 (the C7/C8 placebos); N4 saves ₹131–208 on each trade it touches; N3 cuts a zero-edge trade's cost by about 35–40% by shortening its hold. A filter on a coin flip yields a cheaper coin flip. Whatever is left (−₹35 a trade for C4, −₹44 for H7) is the remaining cost, not an edge.
3. **N2 cannot be judged with this pricer.** Its evidence is about real option prices after volatility jumps; a pricer that sets implied volatility to a fixed multiple of VIX shows no such effect (§5), and in this sample N2 removed the days that paid (C1).
4. **The one directional candidate rests on too little data.** The first-candle rule's mean has a day-block SE of about ₹1,100 on 32–34 trades. Its gap over the placebo (+₹1,270–1,496, 1.1–1.35 SE) would need about three times the trades to reach 2 SE and about ten times to reach the Bonferroni level this ledger now sets (z ≈ 4.0); showing the mean itself above zero (+₹450–650, about 0.5 SE) would need about 16 and 60 times the trades. Its index-level effect is plausibly part regime (bearish candles in a falling market), and two sessions carry its option P&L.
5. **The ₹10k account cannot express any of these ideas.** Its premium band buys options far out of the money, its own book stops after a handful of losses, and it cannot afford an in-the-money lot. It lost money per trade in every run here, 5-minute and hourly.

---

## 8. Does anything deserve a forward paper test?

**Not on a paper account.** §12 allows a rule onto a paper account only after it passes, and none did. Switching any of these on would also restart buying, which the owner has paused (`EDGE_GATE=calibrated`).

**One candidate is worth measuring forward, in shadow: the first 15-minute candle (C5).** It is the only one with a directional effect on our data at index level (+25 bps from the candle's close, t 2.3) and a positive option-level point estimate, it is fully specified by the plan (nothing to fit), and measuring it costs nothing:

- **Pre-register it as tested:** 09:15–09:30 candle, |body| > 0.24%, entry at the 09:30 close (measured from there), exit at 15:05, both indices, plus the 11:15 exit as a secondary readout. No parameter changes; any change is a new trial.
- **Measure at index level from the nightly archive** (`npm run fetch-history -- --save`, already running): `scripts/research/wp9b-buy-signals.ts --only diag` computes every candle's move from its close. Compare it each time with the session drift and with random sides on the same days, and evaluate once, at 180 index-candles (about September 2027), at the Bonferroni level the ledger sets then.
- **For the option leg, record real prices, not synthetic ones:** if the owner wants option-level evidence, log the real bid and ask of the candle-side ATM weekly at 09:31:30 and at 15:05 (a shadow record, no order), so the rule can be priced honestly when the sample is large enough.

**N4 is the one rule worth keeping ready for when a signal passes.** It cheapens the trades it touches by ₹130–210 under the model, matches the real-price evidence it came from, and needs no signal; it is not worth a forward test of its own.

**No for N2, N3 and the morning noise area with ITM strikes.** N2 cannot be judged with this pricer and blocks more than half of all sessions; N3's saving is a shorter hold, which any exit rule can buy; the morning noise-area entries are indistinguishable from random ones at the same moments.

---

## 9. The data the first-candle rule still needs

**What we have.** 60 sessions of 5-minute bars (16 Jul – 9 Oct 2026, the archive; the reference snapshot is a subset). The rule fired on 21 of them: 36 index-candles (19 NIFTY, 17 SENSEX; 25 bearish, 11 bullish), 34 inside the protocol's window. Measured the honest way, from the candle's close:

| leg (index level, signed by the candle's direction) | candles | days | mean | SE (day-clustered) | t | right |
|---|---|---|---|---|---|---|
| 09:30 close → 11:15 | 36 | 21 | +7.0 bps | 5.6 | 1.2 | 56% |
| 09:30 close → 15:05 | 36 | 21 | **+24.9 bps** | 10.8 | 2.3 | 64% |
| NIFTY only, 09:30 → 15:05 | 19 | 19 | +25.6 bps | 10.5 | 2.4 | 68% |
| *09:15 open → 15:05 (counts the candle's own move)* | 36 | 21 | *+62.1 bps* | 12.1 | 5.2 | *94%* |

The last row is the folklore number's mechanism made visible: counting the candle turns a 64% coin into a 94% one. The honest +25 bps is also partly the regime: the average session drifted −10 bps from 09:30 to 15:05 (SE 5), bearish candles continued +31–34 bps and bullish ones +8 bps (5–6 days per index). Relative to the drift, both sides show roughly +20 bps, on very few bullish days.

**What a decision needs, and how long it takes to get it.**

1. **Sample size.** The protocol needs ≥ 180 trades out of sample. The rule fires on about 30% of index-sessions here, so 180 trades take about 300 sessions of 5-minute (or 15-minute) bars for both indices: roughly 14 months. The nightly archive (`npm run fetch-history -- --save`, WP1) holds 60 sessions and adds about 21 a month, so it reaches 300 around **September 2027** if it runs every night.
2. **Power at the bar this ledger now sets.** With 1,562 logged trials, Bonferroni needs a one-sided p below 3.2×10⁻⁵ (z ≈ 4.0). The day-level SD of the 09:30→15:05 leg on candle days is about 50 bps, so confirming a true +25 bps at that level needs about (4.0 × 50 / 25)² ≈ 64 candle-days at index level, and a more realistic +10 bps (effects shrink out of sample) about 400 candle-days, i.e. roughly 1,150 sessions (four to five years) at the 35% of days on which it fired here. At option level the noise per trade is larger again (§3, point 4 of §7).
3. **History outside this regime.** The 2017–2026 NIFTY 15-minute study cited in the plan counted the candle's own move. To measure from the candle's close over those years we need the 15- or 5-minute bars themselves. Yahoo serves only 60 days of intraday bars; candidates are the broker's historical-candle API (Groww's needs the API keys the repo does not have; Zerodha's Kite historical data is a paid add-on) or a data vendor. Any of these would allow a frozen-parameter test on 2017–2026 at index level within days, with ~2,000 sessions.
4. **Real option prices at 09:31 and at the exit.** End-of-day bhavcopies give each contract's day OHLC and a closing VWAP, not a 09:31 quote, and synthetic intraday prices fail WP6's range check (see §3 for this rule's trades). Real intraday option candles for the traded strikes (the same broker APIs, or exchange tick data) are needed before any rupee figure for this rule can be trusted.
5. **The 15:05 square-off and the closing auction.** Since 3 Aug 2026 the last 15 minutes are an auction; the rule's held-to-close variant exits at 15:05, which is fine, but any history before August 2026 has a different close.

---

## 10. Caveats

- **Synthetic option prices, and they fail the real-price check.** Every rupee figure is Black–Scholes on India VIX (× 1.00 NIFTY / 1.05 SENSEX), or on WP6's calibrated multipliers and smile for C7, C8 and H5–H7. WP6 found synthetic intraday prices fail the real-range check (39% of entries and exits inside the contract's real day range with the default pricer, 67–70% calibrated, against a 90% bar). §3 runs the same check on this work's trades. In-the-money options are priced off the calibrated *put* wing for calls (and the call wing for puts), by parity; that wing was fitted on out-of-the-money strikes. **The ITM result is therefore indicative only**: it says the delta-per-theta argument holds inside the model, not that it holds at real prices.
- **One regime, one short sample.** The 5-minute samples are 54–55 sessions of a falling market (NIFTY −8% from mid-July; the average session moved −10 bps from 09:30 to 15:05) with record FPI selling, and they overlap on 54 sessions (§2). The hourly sample is longer (704 sessions) but coarser.
- **The hourly approximation** applies today's lot sizes and expiry weekdays to 2023–2026, infers holidays from missing bars, decides once an hour (so N3 is a single 10:15 decision and the first candle cannot be tested), squares off at the 15:15 close, and can only charge +2 ticks for copying. The bundled event calendar covers only 2026, so earlier sessions have no scheduled-event blackout.
- **N2 in production** reads the daily bars the live engine keeps (about six months). Its percentile needs at least 120 closes, which is borderline; with fewer it fails closed and stops all buying. Irrelevant while it is off; worth fixing before it is ever switched on (WP5 noted the same for the HAR gate).
- **The published rules ran with the per-source performance overlay off**, as WP3 ran them. With it on, Kelly sizing and the decay monitor stop a losing rule after about 20 trades per index, which would cut these samples short.
- **The placebo is matched more strictly than before** (drawn only when the published rule enters). For the noise area this turns WP3's +₹192 hourly gap into +₹46 (§4); both readings fail.
- **Look-ahead.** N2 reads only daily bars dated before the decision's session (the replay hides today's), plus the engine's own intraday VIX change; the first candle reads only closed bars (tests: no entry before the candle closes, the entry level is the candle's close, the option is priced at that bar's spot); N3 and N4 use only the clock and the calendar. Criterion 11 still needs an independent review (WP8).
- **The trials ledger is shared with the hourly runs**, and N grew from 385 to the figure in §11 during this work; each protocol's Bonferroni level used the N at the time it ran, so later runs faced a stricter bar.

---

## 11. Trials ledger

`reports/trials.jsonl` went from **385 to 1,562 lines**; this work added **1,177** (`"wp": "WP9b"`): 964 perturbation, 106 placebo, 55 strategy and 52 copy-delay lines. Every 5-minute protocol run logged its two replays, two placebos and every perturbation for both accounts (C1 192 lines, C2 176, C3 160, C4 208, C5 32, C6 48, C7 64, C8 64); the reference runs 8; the hourly runs H0–H7 219 (strategy, +2 ticks, two placebos, perturbations and the fresh-account measure, per account); the random-entry diagnostic 6. Nothing was re-run and nothing was tuned: every parameter is the plan's or the paper's, and every variant was declared before the first run (§2). The data diagnostics (§6, §9; index levels only, no option prices) are not ledger lines.

**The bar at the end:** Bonferroni 0.05/1,562 = 3.2×10⁻⁵, which needs at least ⌈1,562/0.05⌉ = 31,240 bootstrap resamples to be decidable; every run here used 100,000. Each protocol run was judged at the N of its time (706 to 1,562), so later runs met a stricter bar; no run comes within four orders of magnitude of either.

---

## 12. Reproduce

`S` is the session scratchpad (`/tmp/claude-0/-home-user-ruphak-trading-info/ce69818a-a157-5190-9186-5f96c704f981/scratchpad`); `node_modules` is a hard-link copy of the main checkout's (`cp -al`).

```
H=$S/why/hist.json; A=$S/archive/yahoo-5m-archive.json; Y=$S/dl/y1h; D=$S/research/q1/data
# default (must print 58 trades, -20,158.44)
npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits --history $H
# one protocol run per candidate and sample (C1 shown; C2 --n3, C3 --n4, C4 --n2 --n3 --n4,
# C5 --strategy first-candle --no-perf-overlay --frozen "<source>", C6 adds --n3,
# C7 --strategy noise-area --n3 --itm-steps 1 --iv-source calibrated --no-perf-overlay --frozen "<source>", C8 --itm-steps 2;
# the archive runs use --history $A --to 2026-10-09); the exact command lines are in $S/wp9b/run-jobs.sh and jobs-5m.txt
npm run backtest -- --from 2026-07-23 --to 2026-10-08 --history $H --no-events --prod-limits --account small10k \
  --protocol --bootstrap 100000 --wp WP9b --variant C1-N2-conviction --n2
# the reference (current defaults, copy delay + placebo): $S/wp9b/run-ref.sh
# hourly (H0..H7), the rules on random entries, diagnostics and the tables
npx tsx scripts/research/wp9b-buy-signals.ts --only hourly --hourly $Y --daily $D --variants H0,H1,H2,H3,H4,H5,H6,H7
npx tsx scripts/research/wp9b-buy-signals.ts --only filters --hourly $Y --daily $D
npx tsx scripts/research/wp9b-buy-signals.ts --only diag --history $H --archive $A --runs <dir with protocol-*.json and hourly-*.json> --hourly $Y
npx tsx scripts/research/wp9b-buy-signals.ts --only summary --runs <same dir>
# real-price range check of a run's trades (WP6's tool; bhavcopy cache built offline from the local zips)
npx tsx scripts/fetch-bhavcopy.ts --from 2026-07-01 --to 2026-10-09 --offline --local-nse $S/research/q1/dl_nse --local-bse $S/research/q1/dl_bse --dir $S/wp9b/bhavcopy
npx tsx scripts/research/real_prices.ts sanity --dir $S/wp9b/bhavcopy --from 2026-07-01 --to 2026-10-09 --bt <{strategy:{trades}} json> --label <name> --out <dir>
```
