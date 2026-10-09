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

_(₹10k account rows: pending — the protocol run was still in progress at this commit.)_

**The copy delay is not a one-way penalty.** For the default engine it *improved* the result by ₹77/trade. On the 48 trades both runs share, an entry one bar later is ₹1.43 cheaper per unit, worth +₹44 per trade even after the 2 extra ticks. Delayed exits at the same exit time lose ₹15.5 per trade, and the rest of the change comes from exit paths that differ. The option moving against the signal in the five minutes after it fits PLAN §1.3: signals are right only 37% of the time at 15 min, i.e. the engine chases moves that partly revert. For the −35/+60 exits the same delay *worsened* the strategy by ₹93/trade. With about 50 trades the sign of this effect is noise, and it must not be read as an argument for slower copying. For random entries, on the same draws, the delay moved the mean by +₹2.0, +₹2.5 and +₹7.5 per trade (main exits, −35/+60, 45 min). The 4 extra ticks alone cost about ₹8.5 per trade (₹13 NIFTY, ₹4 SENSEX per round trip), and these shifts are within the noise of that cost: a 5-minute shift at both ends gives a paired SE of about ₹15. So with no signal the delay is cost-neutral apart from the ticks. The modelled delay (one bar, about 3.5–5 min after the decision) is also longer than a real copier's 30–90 s.

## 3. Full `--protocol` output for the current engine

Command: `npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits --history hist.json --account small10k --protocol --wp WP0 --variant "conviction default, prod-limits (current engine)"`. It ran two replays, two placebos per account and 36 perturbation replays; all are logged as trials.

_(Pending — the protocol run was still in progress at this commit.)_

## 4. Honest conclusions

_(Pending the protocol output.)_

## 5. Trials ledger

_(Pending the protocol run, which appends its own lines.)_

## 6. Not done / caveats

- **Walk-forward is not wired into `--protocol`.** Fitted variants therefore always get FAIL on criterion 2 and 0 OOS trades on criterion 3. Frozen published rules (WP3/WP4) pass `--frozen "<source>"` and are judged on the whole sample. Pooling walk-forward OOS trades into the protocol is the next step for WP2/WP5-style fitted variants.
- **Criteria 10 and 11 print N/A** until WP6 (bhavcopy prices, IV calibration) and WP8 (look-ahead sign-off) land, so the overall verdict can never be PASS today.
- Only the ₹10k account was evaluated. The ₹5k account needs its own run (`--account small5k`).
- The placebo leaves out SIGNAL_FLIP and event exits on purpose: they depend on the signal under test, and a random side against a strong conviction would be flipped out at once. It also does not apply the scheduled-event blackout gate.
- The perturbation set covers 18 numeric parameters (exits, conviction, gates, feature lookbacks). Constants inside individual signals are not perturbed.
- `reports/` is gitignored, so `reports/wp0-harness.md` and `reports/trials.jsonl` were force-added. Each worktree keeps its own ledger. Suggest un-ignoring `reports/trials.jsonl` and adding `reports/trials.jsonl merge=union` to `.gitattributes`, so ledgers from parallel WPs merge by concatenation. N must count everyone's lines.
- The one-sided bootstrap p is resolved to 1/(B + 1) ≈ 1e-4 with 10,000 resamples. Once N_trials exceeds about 500, Bonferroni needs `--bootstrap 100000`.
