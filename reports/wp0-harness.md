# WP0: evaluation harness: results

Fri 9 Oct 2026. Branch `worktree-agent-ae538a6ef51e7b89d`, started from `9a80d7b`. Engine stays PAPER; nothing was deployed or pushed.
Data: the planner's snapshot `scratchpad/why/hist.json` (Yahoo 5-minute bars 16 Jul – 8 Oct 2026, sha256 `f3cae89b2a0c6ac8…`), range 2026-07-23 .. 2026-10-08, 54 sessions, no events, `--prod-limits`. Every run below is in `reports/trials.jsonl`.

## What WP0 adds

| piece | where | what it does |
|---|---|---|
| random-entry placebo | `src/engine/backtest/placebo.ts` | Random session, slot, index and side. It buys what the engine would buy: ATM of the nearest weekly not expiring today, or a small account's premium band. It sizes with the account's own rules and is managed by the engine's mechanical exits (stop, target, trail, time stop, square-off), checked every 5 min on closed bars with the 90 s lag. Prices come from the engine's synthetic quotes, fill model and charges. Seeded, with draws made in a fixed order. With `sizing: "uncapped"`, a 90-min horizon and 09:25–14:30 slots it reproduces the planner's script draw for draw. |
| copy-delay model | `runBacktest.ts` (`fillDelayBars`, `extraTicks`) | Fills (entries and every exit, stops included) are priced off the index and VIX closes published N bars later, moved `extraTicks` against the trader, at market. Decisions, marks and exit triggers keep the engine's own view. With neither input set, the deps are exactly the engine's. |
| statistics | `metrics.ts` | Day-block bootstrap (percentile CI, one-sided p), day-clustered SE, probabilistic and deflated Sharpe ratio (Bailey & López de Prado 2012/2014; reproduces the paper's DSR = 0.9004 example), Bonferroni, trade-by-trade drawdown, index and week concentration |
| trials ledger | `trials.ts` | Append-only JSON-lines helper (pure; the I/O is injected so it still builds for the Worker). N counts every non-empty line; the Sharpe variance uses the strategy lines only. |
| protocol | `protocol.ts` (new; no other WP owns it) | Runs the variant with and without the copy delay, the placebo with and without it (same draws), and 18 numeric parameters ×0.8 and ×1.2 one at a time. It then gives each §5 criterion a verdict of PASS, FAIL, INSUFFICIENT or N/A, with its numbers. |
| CLI | `scripts/backtest.ts` (one delimited block + 3 one-line hooks) | `--placebo-random N --seed S` (`--placebo-horizon`, `--placebo-sizing engine\|uncapped`, `--placebo-window`), `--copy-delay` (`--fill-delay-bars`, `--extra-ticks`), `--protocol` (`--frozen "<source>"`, `--perturb a,b\|all`, `--no-perturb`, `--bootstrap N`), `--trial-ledger [path]` (`--wp`, `--variant`). `--protocol` always logs its runs. |

Tests: 31 new (`evaluation.test.ts`, `placebo.test.ts`, the copy-delay block in `backtest.test.ts`); the full suite is 685 passed, 1 skipped.

## Default behaviour is unchanged (proof)

`npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits --history hist.json` prints **51 trades, net −₹9,595.92** (PF 0.79, maxDD 3.73%). Its JSON report is **byte-identical** (`cmp`) to the report written by the same command before any WP0 change, and the console output is identical apart from the timing and the `--out` path.

## 1. Random-entry placebo: reproduced exactly, then corrected

3,000 draws each, main account (₹5L), snapshot above.

| placebo variant | seed | sizing | time stop | slots | ₹/trade | SE iid | SE day | hit | PF | gross | charges |
|---|---|---|---|---|---|---|---|---|---|---|---|
| planner's script, stop −30/target +50 (PLAN §1.2) | 7 | uncapped: 2,581 × 1 lot, **419 × 2 lots** | 90 fixed | 62 (to 14:30) | **−402.39** | 33.4 | 47.3 | 34.8% | 0.54 | −333.5 | 68.9 |
| same | 11 | uncapped | 90 fixed | 62 | −385.75 | 32.7 | 57.5 | 34.6% | 0.55 | −316.8 | 69.0 |
| same, stop −35 / target +60 | 7 | uncapped | 90 fixed | 62 | −389.67 | 31.2 | 50.2 | 34.7% | 0.53 | −322.1 | 67.6 |
| same, 45-min time stop | 7 | uncapped | 45 fixed | 62 | −295.18 | 24.4 | 31.4 | 36.9% | 0.52 | −226.1 | 69.1 |
| port, engine sizing and entry window | 7 | engine: 1 lot | 90 fixed | 61 (to 14:25) | −363.82 | 29.6 | 41.7 | 34.0% | 0.54 | −296.6 | 67.2 |
| same | 11 | engine | 90 fixed | 61 | −332.57 | 29.4 | 51.6 | 33.9% | 0.56 | −265.2 | 67.4 |
| **port, as the engine (main exits)** | 7 | engine | regime at entry | 61 | **−378.40** | 29.4 | 41.9 | 34.0% | 0.53 | −311.2 | 67.2 |
| … with copy delay | 7 | engine | regime | 61 | −376.36 | 29.9 | 42.7 | 33.6% | 0.53 | −309.2 | 67.2 |
| follower exits −35/+60 (main sizing) | 7 | engine | regime | 61 | −395.40 | 29.9 | 47.2 | 34.1% | 0.51 | −328.3 | 67.1 |
| … with copy delay | 7 | engine | regime | 61 | −392.92 | 30.2 | 48.5 | 33.7% | 0.52 | −325.8 | 67.1 |
| 45-min time stop | 7 | engine | 45 fixed | 61 | −258.76 | 21.6 | 28.2 | 37.1% | 0.53 | −191.4 | 67.4 |
| … with copy delay | 7 | engine | 45 fixed | 61 | −251.29 | 22.0 | 30.8 | 35.0% | 0.55 | −183.9 | 67.4 |

How to read this table:

- **The port is exact.** In reference mode it reproduces every row of PLAN §1.2 draw for draw: mean, sd 1,831, hit rate, PF, and the exit breakdown (TIME_STOP 2,010 at −₹633, STOP 250 at −₹3,188, …). `npm run backtest -- … --placebo-random 3000 --seed 7 --placebo-sizing uncapped --placebo-horizon 90 --placebo-window 09:25-14:30` prints −₹402.39.
- **The planner's −₹402 overstates the matched zero-edge cost.** Every engine trade on main is exactly one lot, because the settings cap `maxLotsPerOrder` is 1; all 51 baseline trades are 65 NIFTY or 20 SENSEX. The script sized 14% of its draws at 2 lots (mean −₹872 per 2-lot draw). The script also used one slot (14:30 bar, decided 14:31:30) that the engine's 14:30 entry gate rejects. With the engine's sizing and window the placebo is −₹333 to −₹364 at a fixed 90 minutes. With the time stop of the regime the engine actually saw at each draw, it is **−₹378**. That last figure is the right comparator for the current strategy.
- **The i.i.d. SE (₹30–33) understates the uncertainty.** Draws on the same day share that day's market. The day-clustered SE is ₹42–58, and seeds 7 and 11 differ by ₹31 (engine mode). Read the placebo as about −₹370 ± ₹50 per trade.
- A 45-minute time stop cuts the zero-edge drag from about ₹378 to about ₹259 per trade (−32%), in line with PLAN §1.2.

## 2. Strategy vs placebo, with and without the copy delay

Copy delay = §5.4: fills priced off the next closed 5-minute bar (about +5 min) plus 2 ticks per side, at market. Placebo = the same exits, costs and copy model on the same 3,000 draws (seed 7).

| run (main, 54 sessions) | trades | ₹/trade | SE (iid) | hit | PF | net ₹ | placebo ₹/trade | strategy − placebo | in SEs (needs ≥ 2) |
|---|---|---|---|---|---|---|---|---|---|
| default engine, engine fills | 51 | −188.16 | 305 | 33.3% | 0.79 | −9,595.92 | −378.40 | +190 | 0.62 |
| default engine, copy delay | 53 | −111.60 | 328 | 41.5% | 0.87 | −5,914.73 | −376.36 | +265 | 0.81 |
| stop −35 / target +60, engine fills | 51 | −216.31 | 325 | 35.3% | 0.78 | −11,031.71 | −395.40 | +179 | 0.55 |
| stop −35 / target +60, copy delay | 46 | −308.93 | 327 | 39.1% | 0.69 | −14,210.94 | −392.92 | +84 | 0.26 |

₹10k account (follows main's signals; own premium band, one lot, −35/+60 exits, ₹10,000 capital; from the protocol run):

| run (₹10k, 54 sessions) | trades | ₹/trade | SE (iid) | hit | PF | net ₹ | placebo ₹/trade (own band, 1 lot) | strategy − placebo | in SEs (needs ≥ 2) |
|---|---|---|---|---|---|---|---|---|---|
| engine fills | 19 | −258 | 179 | 31.6% | 0.43 | −4,899 | −299 | +41 | 0.23 |
| copy delay | 21 | −222 | 176 | 33.3% | 0.46 | −4,666 | −300 | +78 | 0.44 |

**The copy delay is not a one-way penalty.** For the default engine it *improved* the result by ₹77/trade. On the 48 trades both runs share, an entry one bar later is ₹1.43 cheaper per unit, worth +₹44 per trade even after the 2 extra ticks. Delayed exits at the same exit time lose ₹15.5 per trade, and the rest of the change comes from exit paths that differ. The option moving against the signal in the five minutes after it fits PLAN §1.3: signals are right only 37% of the time at 15 min, i.e. the engine chases moves that partly revert. For the −35/+60 exits the same delay *worsened* the strategy by ₹93/trade. With about 50 trades the sign of this effect is noise, and it must not be read as an argument for slower copying. For random entries, on the same draws, the delay moved the mean by +₹2.0, +₹2.5 and +₹7.5 per trade (main exits, −35/+60, 45 min). The 4 extra ticks alone cost about ₹8.5 per trade (₹13 NIFTY, ₹4 SENSEX per round trip), and these shifts are within the noise of that cost: a 5-minute shift at both ends gives a paired SE of about ₹15. So with no signal the delay is cost-neutral apart from the ticks. The modelled delay (one bar, about 3.5–5 min after the decision) is also longer than a real copier's 30–90 s.

## 3. Full `--protocol` output for the current engine

Command: `npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits --history hist.json --account small10k --protocol --wp WP0 --variant "conviction default, prod-limits (current engine)"`. It ran two replays, two placebos per account and 36 perturbation replays; all are logged as trials.

Runtime 1,791 s. Saved `reports/protocol-2026-07-23-2026-10-08.json` (not committed: it holds all trades).

Note on criterion 4: this run printed the copy-delay effect as "costs the strategy −₹77/trade". A negative cost is an improvement of ₹77/trade (−₹188 → −₹112). The line now reads "changes the strategy by +₹77/trade"; the numbers are unchanged.

```text
=== Acceptance protocol (PLAN §5): Main account, 2026-07-23 .. 2026-10-08 (54 sessions) ===
Evaluation run (copy delay: fills priced off the next closed 5-minute bar, 2 extra tick(s) per side, at market): 53 trades, net −₹5,915, −₹112/trade.

                        trades  ₹/trade  SE iid  SE day    hit    PF      net
strategy, engine fills      51    −₹188    ₹305          33.3%  0.79  −₹9,596
strategy, copy delay        53    −₹112    ₹328    ₹442  41.5%  0.87  −₹5,915
placebo, engine fills     3000    −₹378     ₹29     ₹42  34.0%  0.53         
placebo, copy delay       3000    −₹376     ₹30     ₹43  33.6%  0.53         

 1  FAIL          Published parameters frozen: not declared a frozen published rule (--frozen <source>): its parameters are treated as fitted on this data
                  The default CONVICTION engine is not a published rule; its weights, thresholds and gates were tuned on recent backtests.
 2  FAIL          Out-of-sample only: in-sample run of a fitted rule: only pooled walk-forward out-of-sample trades (42-day train / 14-day test) count
                  --protocol evaluates one replay; walk-forward OOS trades are not wired into it yet (see --walk-forward).
 3  INSUFFICIENT  Minimum sample: 0 out-of-sample trades (53 in-sample) vs ≥ 180 required
                  54 sessions in this replay; the 2-year hourly replay alternative needs ≥ 120 OOS sessions (not applicable to 5-minute replays).
 4  PASS          Costs (charges, spread, slippage, copy delay): evaluated with every cost; copy delay: fills priced off the next closed 5-minute bar, 2 extra tick(s) per side, at market
                  Charges ₹68/trade (dated schedule from 2026-04-01: STT 0.15% on sells, brokerage ₹20/order); synthetic spread max(1 tick, 0.4% of premium); market orders pay 2 ticks beyond visible depth.
                  Copy delay costs the strategy −₹77/trade (−₹188 → −₹112; 51 → 53 trades, the trade list can change) and the placebo −₹2/trade on the same 3000 draws (−₹378 → −₹376).
 5  FAIL          Beats the random-entry placebo: strategy − placebo = +₹265/trade vs 2 × SE = ₹885 required
                  Strategy −₹112/trade, SE ₹328 i.i.d. / ₹442 day-block (n = 53); SE used: the larger.
                  Placebo −₹376/trade, SE ₹30 i.i.d. / ₹43 day-clustered (3000 draws, seed 7, engine sizing, horizon: the regime's horizon at entry (signal tape)).
                  Placebo hit 33.6%, PF 0.53, gross −₹309 + charges ₹67; exits TIME_STOP 1993 (−₹589), SQUARE_OFF 527 (−₹36), STOP 253 (−₹2,534), TARGET 131 (₹4,445), TRAIL 96 (₹1,285).
 6  FAIL          Day-block bootstrap: 95% CI lower bounds −₹884/trade and −₹883/session (both must be > 0)
                  Per trade: −₹112 [−₹884, ₹849], p(mean ≤ 0) = 0.612.
                  Per session: −₹110 [−₹883, ₹797], p = 0.612 (54 sessions, sessions without trades count as ₹0).
                  10,000 resamples of whole sessions, seed 7.
 7  FAIL          Profit factor, drawdown, concentration: PF 0.87 (≥ 1.3) fails; max drawdown 3.29% (≤ 6%) ok; concentration fails
                  Drawdown ₹16,459 trade by trade (exit order) on ₹5,00,000 capital; limit 6% (main).
                  Concentration: not meaningful with net −₹5,915 ≤ 0 (by index: SENSEX −₹9,576, NIFTY ₹3,662).
 8  FAIL          Robustness (±20% one at a time): 4/36 perturbations net > 0 (need ≥ 80%); worst min-active ×0.8 −₹38,376 (-549% vs base −₹5,915, floor -50%)
                  stop              ×0.8    54 trades  net   −₹17,286  (-192% vs base)
                  stop              ×1.2    48 trades  net   −₹22,624  (-283% vs base)
                  target            ×0.8    48 trades  net   −₹17,409  (-194% vs base)
                  target            ×1.2    48 trades  net    −₹9,405  (-59% vs base)
                  time-stop         ×0.8    49 trades  net   −₹15,325  (-159% vs base)
                  time-stop         ×1.2    53 trades  net   −₹14,743  (-149% vs base)
                  trail-activate    ×0.8    55 trades  net    −₹9,069  (-53% vs base)
                  trail-activate    ×1.2    53 trades  net    −₹5,915  (0% vs base)
                  trail-giveback    ×0.8    53 trades  net    −₹5,101  (14% vs base)
                  trail-giveback    ×1.2    53 trades  net    −₹5,915  (0% vs base)
                  time-floor        ×0.8    55 trades  net   −₹10,608  (-79% vs base)
                  time-floor        ×1.2    57 trades  net    −₹2,642  (55% vs base)
                  flip-fraction     ×0.8    54 trades  net    −₹5,204  (12% vs base)
                  flip-fraction     ×1.2    53 trades  net    −₹5,915  (0% vs base)
                  gain              ×0.8    44 trades  net   −₹20,267  (-243% vs base)
                  gain              ×1.2    53 trades  net    −₹8,640  (-46% vs base)
                  thresholds        ×0.8    52 trades  net   −₹12,727  (-115% vs base)
                  thresholds        ×1.2    51 trades  net    −₹6,960  (-18% vs base)
                  min-active        ×0.8    78 trades  net   −₹38,376  (-549% vs base)
                  min-active        ×1.2    31 trades  net   −₹14,689  (-148% vs base)
                  min-edge          ×0.8    55 trades  net     ₹1,117  (119% vs base)
                  min-edge          ×1.2    52 trades  net   −₹10,593  (-79% vs base)
                  min-evi           ×0.8    53 trades  net    −₹5,915  (0% vs base)
                  min-evi           ×1.2    53 trades  net    −₹5,876  (1% vs base)
                  kem               ×0.8    51 trades  net   −₹11,866  (-101% vs base)
                  kem               ×1.2    55 trades  net     ₹1,117  (119% vs base)
                  vol-factor        ×0.8    51 trades  net   −₹11,866  (-101% vs base)
                  vol-factor        ×1.2    55 trades  net     ₹1,117  (119% vs base)
                  rv-bars           ×0.8    54 trades  net    −₹8,329  (-41% vs base)
                  rv-bars           ×1.2    54 trades  net    −₹8,703  (-47% vs base)
                  divergence-bars   ×0.8    51 trades  net    −₹1,583  (73% vs base)
                  divergence-bars   ×1.2    54 trades  net     ₹1,085  (118% vs base)
                  opening-range     ×0.8    53 trades  net    −₹5,915  (0% vs base)
                  opening-range     ×1.2    51 trades  net   −₹10,086  (-71% vs base)
                  session-lookback  ×0.8    54 trades  net    −₹2,916  (51% vs base)
                  session-lookback  ×1.2    53 trades  net    −₹6,235  (-5% vs base)
 9  FAIL          Multiple-testing control: bootstrap p = 0.612 vs Bonferroni 0.05/116 = 4.3e-4; deflated Sharpe ratio 0.054
                  N_trials = 116 lines in reports/trials.jsonl (copy-delay 5, placebo 23, strategy 15, walk-forward 1, perturbation 72); p is the larger of the per-trade and per-session bootstrap p-values.
                  DSR (Bailey & López de Prado 2014) on net P&L per session: SR -0.034/session (-0.54 annualized), T 54, skew 2.22, kurtosis 13.03; SR₀ 0.196 from N 116 and V[SR] 5.75e-3 (variance of 92 logged strategy trials); PSR(0) 0.406. DSR ≥ 0.95 would be significant at 5%.
10  N/A           Real-price sanity: needs WP6: bhavcopy prices for each contract and a calibrated IV multiplier; every premium here is synthetic (Black–Scholes on India VIX)
11  N/A           No look-ahead: needs WP8's sign-off on this variant's code paths (point-in-time replay audited in PLAN §1.4, not a sign-off)
12  FAIL          Both accounts: ₹10k account: FAIL
                  Each small account is judged on its own trades, placebo and caps (report below).

Overall: FAIL (do not enable on any paper account)

=== Acceptance protocol (PLAN §5): ₹10k account, 2026-07-23 .. 2026-10-08 (54 sessions) ===
Evaluation run (copy delay: fills priced off the next closed 5-minute bar, 2 extra tick(s) per side, at market): 21 trades, net −₹4,666, −₹222/trade.

                        trades  ₹/trade  SE iid  SE day    hit    PF      net
strategy, engine fills      19    −₹258    ₹179          31.6%  0.43  −₹4,899
strategy, copy delay        21    −₹222    ₹176    ₹175  33.3%  0.46  −₹4,666
placebo, engine fills     3000    −₹299     ₹17     ₹29  30.0%  0.42         
placebo, copy delay       3000    −₹300     ₹17     ₹30  28.8%  0.43         

 1  FAIL          Published parameters frozen: not declared a frozen published rule (--frozen <source>): its parameters are treated as fitted on this data
                  The default CONVICTION engine is not a published rule; its weights, thresholds and gates were tuned on recent backtests.
 2  FAIL          Out-of-sample only: in-sample run of a fitted rule: only pooled walk-forward out-of-sample trades (42-day train / 14-day test) count
                  --protocol evaluates one replay; walk-forward OOS trades are not wired into it yet (see --walk-forward).
 3  INSUFFICIENT  Minimum sample: 0 out-of-sample trades (21 in-sample) vs ≥ 180 required
                  54 sessions in this replay; the 2-year hourly replay alternative needs ≥ 120 OOS sessions (not applicable to 5-minute replays).
 4  PASS          Costs (charges, spread, slippage, copy delay): evaluated with every cost; copy delay: fills priced off the next closed 5-minute bar, 2 extra tick(s) per side, at market
                  Charges ₹55/trade (dated schedule from 2026-04-01: STT 0.15% on sells, brokerage ₹20/order); synthetic spread max(1 tick, 0.4% of premium); market orders pay 2 ticks beyond visible depth.
                  Copy delay costs the strategy −₹36/trade (−₹258 → −₹222; 19 → 21 trades, the trade list can change) and the placebo ₹0/trade on the same 3000 draws (−₹299 → −₹300).
 5  FAIL          Beats the random-entry placebo: strategy − placebo = +₹78/trade vs 2 × SE = ₹352 required
                  Strategy −₹222/trade, SE ₹176 i.i.d. / ₹175 day-block (n = 21); SE used: the larger.
                  Placebo −₹300/trade, SE ₹17 i.i.d. / ₹30 day-clustered (3000 draws, seed 7, engine sizing, horizon: the regime's horizon at entry (signal tape)).
                  Placebo hit 28.8%, PF 0.43, gross −₹244 + charges ₹56; exits TIME_STOP 1904 (−₹439), SQUARE_OFF 483 (−₹215), STOP 284 (−₹1,557), TARGET 139 (₹2,615), TRAIL 190 (₹624).
 6  FAIL          Day-block bootstrap: 95% CI lower bounds −₹538/trade and −₹220/session (both must be > 0)
                  Per trade: −₹222 [−₹538, ₹150], p(mean ≤ 0) = 0.889.
                  Per session: −₹86 [−₹220, ₹52], p = 0.889 (54 sessions, sessions without trades count as ₹0).
                  10,000 resamples of whole sessions, seed 7.
 7  FAIL          Profit factor, drawdown, concentration: PF 0.46 (≥ 1.3) fails; max drawdown 57.52% (≤ 40%) fails; concentration fails
                  Drawdown ₹5,752 trade by trade (exit order) on ₹10,000 capital; limit 40% (the account's weekly loss cap).
                  Concentration: not meaningful with net −₹4,666 ≤ 0 (by index: NIFTY −₹4,657, SENSEX −₹9).
 8  FAIL          Robustness (±20% one at a time): 0/36 perturbations net > 0 (need ≥ 80%); worst flip-fraction ×0.8 −₹5,847 (-25% vs base −₹4,666, floor -50%)
                  stop              ×0.8    20 trades  net    −₹5,758  (-23% vs base)
                  stop              ×1.2    15 trades  net    −₹4,690  (-1% vs base)
                  target            ×0.8    21 trades  net    −₹4,615  (1% vs base)
                  target            ×1.2    21 trades  net    −₹4,725  (-1% vs base)
                  time-stop         ×0.8    24 trades  net    −₹4,576  (2% vs base)
                  time-stop         ×1.2    20 trades  net    −₹4,932  (-6% vs base)
                  trail-activate    ×0.8    22 trades  net    −₹5,532  (-19% vs base)
                  trail-activate    ×1.2    21 trades  net    −₹4,666  (0% vs base)
                  trail-giveback    ×0.8    22 trades  net    −₹2,712  (42% vs base)
                  trail-giveback    ×1.2    17 trades  net    −₹5,584  (-20% vs base)
                  time-floor        ×0.8    21 trades  net    −₹4,755  (-2% vs base)
                  time-floor        ×1.2    22 trades  net    −₹5,332  (-14% vs base)
                  flip-fraction     ×0.8    20 trades  net    −₹5,847  (-25% vs base)
                  flip-fraction     ×1.2    21 trades  net    −₹4,666  (0% vs base)
                  gain              ×0.8    17 trades  net    −₹5,215  (-12% vs base)
                  gain              ×1.2    13 trades  net    −₹4,868  (-4% vs base)
                  thresholds        ×0.8    13 trades  net    −₹5,170  (-11% vs base)
                  thresholds        ×1.2    17 trades  net    −₹5,215  (-12% vs base)
                  min-active        ×0.8    24 trades  net    −₹5,171  (-11% vs base)
                  min-active        ×1.2    15 trades  net    −₹4,588  (2% vs base)
                  min-edge          ×0.8    22 trades  net    −₹4,716  (-1% vs base)
                  min-edge          ×1.2    20 trades  net    −₹4,661  (0% vs base)
                  min-evi           ×0.8    21 trades  net    −₹4,666  (0% vs base)
                  min-evi           ×1.2    20 trades  net    −₹4,661  (0% vs base)
                  kem               ×0.8    21 trades  net    −₹5,794  (-24% vs base)
                  kem               ×1.2    22 trades  net    −₹4,716  (-1% vs base)
                  vol-factor        ×0.8    21 trades  net    −₹5,794  (-24% vs base)
                  vol-factor        ×1.2    22 trades  net    −₹4,716  (-1% vs base)
                  rv-bars           ×0.8    21 trades  net    −₹5,360  (-15% vs base)
                  rv-bars           ×1.2    21 trades  net    −₹4,666  (0% vs base)
                  divergence-bars   ×0.8    21 trades  net    −₹4,666  (0% vs base)
                  divergence-bars   ×1.2    21 trades  net    −₹4,666  (0% vs base)
                  opening-range     ×0.8    21 trades  net    −₹4,666  (0% vs base)
                  opening-range     ×1.2    20 trades  net    −₹5,802  (-24% vs base)
                  session-lookback  ×0.8    21 trades  net    −₹4,807  (-3% vs base)
                  session-lookback  ×1.2    21 trades  net    −₹4,666  (0% vs base)
 9  FAIL          Multiple-testing control: bootstrap p = 0.889 vs Bonferroni 0.05/116 = 4.3e-4; deflated Sharpe ratio 0.006
                  N_trials = 116 lines in reports/trials.jsonl (copy-delay 5, placebo 23, strategy 15, walk-forward 1, perturbation 72); p is the larger of the per-trade and per-session bootstrap p-values.
                  DSR (Bailey & López de Prado 2014) on net P&L per session: SR -0.169/session (-2.69 annualized), T 54, skew 0.44, kurtosis 10.90; SR₀ 0.196 from N 116 and V[SR] 5.75e-3 (variance of 92 logged strategy trials); PSR(0) 0.125. DSR ≥ 0.95 would be significant at 5%.
10  N/A           Real-price sanity: needs WP6: bhavcopy prices for each contract and a calibrated IV multiplier; every premium here is synthetic (Black–Scholes on India VIX)
11  N/A           No look-ahead: needs WP8's sign-off on this variant's code paths (point-in-time replay audited in PLAN §1.4, not a sign-off)
12  N/A           Both accounts: this is ₹10k account's own evaluation (its premium-band strikes, one-lot sizing, exits and caps); main is reported separately

Overall: FAIL (do not enable on any paper account)
```

## 4. Honest conclusions

1. **The current engine fails §5 on both accounts. Verdict: FAIL, enable nothing.** On main it is +₹190/trade better than a random entry with the same exits and costs (0.62 SE). Under the copy delay the gap is +₹265 against the ₹885 required (2 × the day-block SE of ₹442). The 95% bootstrap CI is [−₹884, +₹849] per trade, p = 0.61 against a Bonferroni level of 0.05/116 = 4.3e-4, and the deflated Sharpe ratio is 0.05. On the ₹10k account the gap is +₹78/trade against ₹352 required, and the account's trade-by-trade drawdown is 57.5% of capital, above its 40% weekly cap. With 51 or 21 trades the engine cannot be told apart from random entry.
2. **The zero-edge cost of this trade structure is about ₹375/trade on main and about ₹300/trade on the ₹10k account.** Main buys one lot of an ATM weekly and holds about 94 min; the ₹10k account buys one lot in its premium band with −35/+60 exits. Any entry rule must earn more than that in directional P&L to break even. A 45-minute time stop lowers the drag to about ₹255/trade on main. Whatever WP3/WP4 propose has to clear that bar too.
3. **The planner's numbers hold in direction but were slightly off.** −₹402 overstated the matched placebo by ₹24–70/trade (2-lot draws the engine never makes), and its SE of ₹33 understated the uncertainty (day-clustered SE ₹42–58). The PLAN §0/§1.2 conclusion stands: the engine is statistically indistinguishable from random entry.
4. **Robustness fails as well.** On main 4 of 36 one-at-a-time ±20% perturbations end positive, and 3 of those (min-edge ×0.8, kEM ×1.2, intraday-vol-factor ×1.2) all loosen the edge gate and produce the same 55 trades (+₹1,117). The fourth is divergence-bars ×1.2 (+₹1,085). On the ₹10k account 0 of 36 are positive. A loosened gate that turns a noisy −₹5.9k into +₹1.1k on 55 trades is the kind of fit rule 3 forbids shipping.
5. **The copy-delay penalty is not monotone.** It improved the default engine (+₹77/trade) and the ₹10k account (+₹36), worsened the −35/+60 variant (−₹93), and left random entries unchanged within noise. Its sign follows the strategy's short-horizon autocorrelation, and at n ≈ 50 that is noise. The protocol therefore always prints both runs. Suggestion for WP8: also report an `--extra-ticks 2` run with no bar delay as the pure-cost check.
6. **The harness is ready for WP2–WP5.** Frozen published rules use `--protocol --frozen "<source>"`; every run they make is counted in N.

## 5. Trials ledger

`reports/trials.jsonl` has **116 lines**. Every line counts toward Bonferroni N (α/N = 4.3e-4).

| author | lines | what |
|---|---|---|
| PLAN, backfilled by WP0 | 11 | 6 replays (baseline ×2, max-open-total 1, NIFTY, SENSEX, kEM 0.5) from the saved reports; the 42/14 walk-forward as one trial of the procedure (it ran 36 training and 3 test replays internally); 4 placebo runs, recomputed exactly with the port |
| WP0, runs without the CLI ledger flag | 11 | 3 baseline replays (the pre-change re-run and 2 default-behaviour proofs, after the change and on the final code) and 8 placebo runs (the planner's script re-run ×2, 6 port checks); identical re-runs are logged and marked |
| WP0, CLI variant runs | 14 | 7 runs, each a strategy line plus a placebo line: smoke test (copy delay), main exits, −35/+60, 45 min, reference mode via the CLI, −35/+60 with copy delay, 45 min with copy delay |
| WP0, protocol | 80 | per account (main, ₹10k): engine-fills replay, copy-delay replay, 2 placebos, 36 perturbations |

By kind: perturbation 72, placebo 23, strategy 15, copy-delay 5, walk-forward 1. The DSR's V[SR] = 5.75e-3 is the variance of the per-session Sharpe ratios of the 92 strategy-type lines (placebos excluded). Logging identical re-runs and the placebos makes N conservative.

Not in the ledger: the planner's non-engine analyses (`itsm_check.py`, `edge_calib.py`, `sensex_quality.py`). They are not runs of the engine; the last-half-hour momentum test (PLAN §3 C) is a rejected hypothesis on other data.

## 6. Not done / caveats

- **Walk-forward is not wired into `--protocol`.** Fitted variants therefore always get FAIL on criterion 2 and 0 OOS trades on criterion 3. Frozen published rules (WP3/WP4) pass `--frozen "<source>"` and are judged on the whole sample. Pooling walk-forward OOS trades into the protocol is the next step for WP2/WP5-style fitted variants.
- **Criteria 10 and 11 print N/A** until WP6 (bhavcopy prices, IV calibration) and WP8 (look-ahead sign-off) land, so the overall verdict can never be PASS today.
- Only the ₹10k account was evaluated. The ₹5k account needs its own run (`--account small5k`).
- The placebo leaves out SIGNAL_FLIP and event exits on purpose: they depend on the signal under test, and a random side against a strong conviction would be flipped out at once. It also does not apply the scheduled-event blackout gate.
- The perturbation set covers 18 numeric parameters (exits, conviction, gates, feature lookbacks). Constants inside individual signals are not perturbed.
- `reports/` is gitignored, so `reports/wp0-harness.md` and `reports/trials.jsonl` were force-added. Each worktree keeps its own ledger. Suggest un-ignoring `reports/trials.jsonl` and adding `reports/trials.jsonl merge=union` to `.gitattributes`, so ledgers from parallel WPs merge by concatenation. N must count everyone's lines.
- The one-sided bootstrap p is resolved to 1/(B + 1) ≈ 1e-4 with 10,000 resamples. Once N_trials exceeds about 500, Bonferroni needs `--bootstrap 100000`.
