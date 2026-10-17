# WP3 + WP4 — published intraday rules on NIFTY/SENSEX weekly options (paper research)

Fri 9 Oct 2026. Branch `worktree-agent-a94a46a212e0a4d4c` (from `9a80d7b`). The engine stays PAPER; nothing
was deployed or pushed and nothing is enabled: the default `strategy.mode` is `"CONVICTION"` and production
never reaches the new code. Option prices are synthetic (Black–Scholes on India VIX, the repo's pricer) in
every number below.

## 0. Verdict

**Neither published rule makes money on our instrument, for any account, and neither passes §5. Do not enable either
on any paper account.** The code stays dormant behind `strategy.mode` (default `CONVICTION`).

* **Noise area (WP3).** On 2 years of hourly data (704 sessions, ~700 trades for main) the signals do carry a
  small *index-level* edge of the paper's sign, under half its size: +5.1 bps per trade for the base model and +4.1 bps for the
  VWAP variant (52 % / 43 % of trades right — the paper reports 43 % for its VWAP variant), day-clustered
  t ≈ 2.2. At one lot and delta ≈ 0.5 that is ≈ ₹400 of directional P&L per trade, against ≈ ₹650–700 of option
  drag (theta over a 2½–3½-hour hold, half-spreads, charges). Net for main: **−₹308/trade (base)** and
  **−₹240/trade (VWAP)**, 95 % day-bootstrap CIs −₹684…+₹89 and −₹537…+₹69, profit factor 0.81. With the small
  accounts' premium-band contracts: **−₹326 and −₹275 per trade, CIs entirely below zero**. On the 54-session
  5-minute snapshot (46 tradable sessions; underpowered, SE ≈ ₹300–400/trade): base −₹546/trade (60 trades),
  VWAP −₹260/trade (72). The vol-target refinement is moot for us (main's settings cap every order at 1 lot):
  identical trades on the snapshot.
* **5-minute ORB (WP4).** Snapshot only (hourly bars cannot see the first 5-minute candle): **−₹226/trade as
  published (09:20 entry, 103 trades)** and **−₹237/trade with the engine's 09:25 window (94 trades)**; hit 24–26 %;
  the 10R target was never reached (0 of 197 trades); index-level edge +2.6 / +3.5 bps, t < 1. Consistent with the
  independent replication cited in PLAN §2 (net ≈ 0 or negative on indices) — options make it worse.
* **Small accounts.** In their own books the ₹10k and ₹5k accounts lose 38–58 % of their equity, mostly within their first
  2–15 trades, under every variant, and then can no longer afford one lot inside their premium caps, so the engine
  stops trading them. Per trade (main's signals, fresh account each time) they lose ₹200–500.
* **Placebo, robustness, delay, pricer bias.** No variant beats its strategy-matched placebo by the required 2 SE (5-minute: −0.7 … +0.6 SE; 2-year hourly: −0.9 … +1.6 SE; hourly noise-area trades for main are ₹23–192 per trade better than random entries with the same exits or holding time). Every ±20 % perturbation is net negative for
  main (table E). A copy delay of one bar (+5 min, +2 ticks each side) did *not* hurt on the snapshot (noise base
  −₹546 → −₹366/trade, VWAP −₹260 → −₹69; < 1 SE — the short pullback after a half-hour breakout seen in this
  sample, PLAN §1.3, not an edge). Correcting the pricer's ~10 % overpricing (IV × 0.9) improves main by
  ₹80–160/trade and changes no sign.
* **Engine as-is.** With the engine's own Kelly/decay overlay on, the strategy would have been stopped after 20
  trades per index (40 in all; 184 later entry signals vetoed by "negative Kelly edge" in the base run): the engine's
  existing risk machinery already refuses these rules on this sample.

---

## 1. What was built

### 1.1 WP3 — noise-area intraday momentum (Zarattini, Aziz & Barbon 2024, rev. 2025; SSRN 4824172)

Implemented exactly as published (rules checked against the paper's §3 text, `scratchpad/dl/pdf/spy_momentum.txt`):

* σ(HH:MM) = mean over the previous **14** sessions of |Close(HH:MM) / Open(session) − 1|;
* Upper = max(Open, previous close) × (1 + VM·σ), Lower = min(Open, previous close) × (1 − VM·σ), **VM = 1**;
* decisions — entries **and** stops — only at **HH:00 / HH:30**: long above Upper, short below Lower;
* **base model** (paper Table 1): hold until the close, or exit on a crossover to the opposite band and reverse;
* **refinement 1** (Table 2): trailing stop max(Upper, VWAP) for longs / min(Lower, VWAP) for shorts, at the half-hours only;
* **refinement 2** (Table 3): size × min(4, 2 % / σ of the last 14 daily returns).

Adaptations forced by our instrument and data (all fixed before the first run, none fitted):

| paper (SPY) | here | why |
|---|---|---|
| long / short SPY | long = buy the ATM call, short = buy the ATM put, nearest weekly not expiring today (existing selection); small accounts: their premium-band strike, one lot | buy-only option books |
| price at HH:00/HH:30 | close of the 5-minute bar ending HH:00/HH:30, seen 90 s later (Yahoo lag) | point in time |
| Open, Close(t−1) | 09:15 bar open; previous official close (Yahoo daily close, else last 5-minute close) | as published |
| σ from 14 days | needs ≥ 13 of the 14 sessions to have that bar, else no decision at that time | Yahoo gaps (17 Jul, 21 Sep) |
| exit at the 16:00 close | 15:05 square-off | after 15:15 Yahoo's bars are closing-auction prints (PLAN §1.3) |
| VWAP | the engine's `vwap()`: Yahoo's index bars carry **no volume**, so it is the running mean of typical prices (a time-weighted stand-in) | data |
| immediate reversal at the crossover | engine replays: the reversal entry is taken on the **next 5-minute bar** (the engine books entries before exits within a tick, so the decision's entry is carried one bar); the hourly harness reverses on the same bar | engine tick order |
| entries at any half-hour | entries only inside the engine's window 09:25–14:30 → decisions 09:30 … 14:00 (the 14:30 bar is seen at 14:31:30) | never change the window |
| 100 % / vol-targeted notional | main: the engine's sizing — main's settings cap every order at **1 lot** (`maxLotsPerOrder = 1`) and premium at 4 % → the vol-target multiplier changes nothing (table A shows identical trades); small accounts: one lot | risk caps never loosened |
| stops on SPY | index-level stops; the premium stop (−30 % main, −35 % small accounts) stays as a **disaster stop** | tightening only |

### 1.2 WP4 — 5-minute opening-range breakout (Zarattini & Aziz 2023; SSRN 4416622)

No copy of this paper was in the scratchpad; the rule is the one in PLAN §3 B: side of the first 5-minute candle
(09:15–09:20), doji (close = open to the paisa) → no trade; stop at the first candle's other extreme; target 10R
(R = entry − stop); otherwise exit at the close (our 15:05); one trade per index per day. Stop and target are
index levels, "touched" when a later closed 5-minute bar's low/high reaches them (seen 90 s after the bar —
a hand copier's stop is honoured late, as the plan intended); the option is sold at the then-current quote.
Risk 1 % / 4× leverage is moot at one lot. Two named variants, as asked:

* **ORB-published** — entry at 09:21:30 on the first candle's close (≈ the second candle's open); this run opens
  the entry window at 09:20 **for that run only**;
* **ORB-window** — the engine's window (09:25): entry at 09:26:30 on the 09:25 close, R measured from there; the
  day is skipped when the stop already traded between 09:20 and 09:25 (the published trade would be closed).

The engine's default window (09:25–14:30) is unchanged.

### 1.3 Engine wiring (flag-gated; default behaviour unchanged)

* `src/engine/config.ts` — delimited `strategy` block: `mode` (`CONVICTION` default | `NOISE_AREA` | `ORB5`) and
  the published parameters; validation refuses a published mode with more than one position per index, and
  ORB-published without the window opened at the range end.
* `src/engine/strategy/published/{noiseArea,orb5,index}.ts` — the rules as pure, point-in-time functions (only
  bars closed and published by the tick; wicks clipped as the features clip them); the per-index signal becomes a
  conviction of +1 / −1 / 0, so the planner, **every gate**, sizing and the follower accounts run unchanged; the
  signal itself rides on the conviction (`conviction.published`, an optional field added by declaration merging
  from `published/index.ts`, no edit to `types.ts`) to every account's position cycle.
* `src/engine/strategy/exits.ts` — `publishedIndexExit`, flag-gated (returns `undefined` in CONVICTION mode):
  the crossover (`SIGNAL_FLIP`), the band/VWAP trailing stop (`TRAIL`), the ORB stop and target (`STOP`,
  `TARGET`). Kill switch, loss caps, square-off and the premium stop are evaluated first, always. A published
  position has no premium target, premium trail, time stop or conviction flip.
* `src/engine/pipeline/tradingCycle.ts` — the published signal replaces the conviction model only in those modes;
  **no entries on a LIVE book** in those modes.
* `scripts/backtest.ts` — `--strategy noise-area|orb5`, `--noise-stop opposite-band|band-vwap`,
  `--noise-sizing engine|vol-target`, `--noise-lookback`, `--noise-band-mult`, `--noise-every`,
  `--orb-entry engine-window|published`, `--orb-target-r`, `--orb-range-min`.
* `scripts/research/published-strategies.ts` — the runner behind every table here (§5).
* Tests: `src/engine/strategy/published/published.test.ts` (rules, look-ahead, exits priority, config) and
  `replay.test.ts` (through the production cycles: entry/exit timing, one position per index, followers one lot,
  LIVE guard, CONVICTION untouched).

Engine checks that stay in force in these modes (none loosened): entry window, expiry-day cutoff (no entry < 90 min
before an expiring contract's close), data freshness, scheduled-event blackout, kill switch, daily and weekly loss
caps, consecutive-loss stop, 30-minute cooldown after a premium stop-out, positions per index (1) and in total
(main 2, small accounts 1), trades per day (main 8, ₹10k 3, ₹5k 2), no opposite positions across NIFTY/SENSEX,
prospective loss cap (small accounts), sizing caps (1 lot per order, 4 % premium), the quote/spread checks and the
edge gates (inert here: a published signal has |score| = 1).

## 2. Default behaviour is unchanged

```
npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits --history scratchpad/why/hist.json
→ 51 trades, net −₹9,595.92 (gross −₹6,137.25, charges ₹3,458.67, PF 0.79)
```
The saved report JSON is **byte-identical** to the one produced before any change (`cmp` on both files), after
every commit on this branch. `npx vitest run`: 58 files, 682 tests pass (28 new); `npx tsc --noEmit -p .` and
`-p workers/engine` clean; eslint clean on every touched file.

## 3. Results

How to read the tables: "₹/trade ± SE" is the mean net P&L per trade (after charges) and its standard error; the
95 % CI resamples whole sessions (10,000 day-block bootstrap draws) so that same-day NIFTY/SENSEX trades are not
counted as independent. "Overlay off" runs disable only the engine's end-of-day per-source performance update
(research harness, not engine code): with it on, Kelly sizing and the decay monitor stop the strategy once 20
trades per index have lost (table B shows that, too).

### A. 5-minute engine replay, published rule (overlay off)

| run | trades | net | ₹/trade ± SE | 95% CI ₹/trade (day bootstrap) | ₹/session | hit | PF | max DD | exits |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NA-base · main | 60 | −₹32,763 | −₹546 ± 395 | −₹1,455 … ₹622 | −₹712 | 25% | 0.6 | ₹61,562 | SQUARE_OFF 40 (₹20,915), STOP 20 (−₹53,679) |
| NA-base · small10k | 10 | −₹5,412 | −₹541 ± 358 | −₹1,157 … ₹248 | −₹118 | 20% | 0.3 | ₹7,777 | SQUARE_OFF 6 (₹407), STOP 4 (−₹5,820) |
| NA-base · small5k | 7 | −₹2,596 | −₹371 ± 468 | −₹1,123 … ₹694 | −₹56 | 29% | 0.47 | ₹4,894 | SQUARE_OFF 4 (₹1,121), STOP 3 (−₹3,718) |
| NA-vwap · main | 72 | −₹18,705 | −₹260 ± 302 | −₹960 … ₹638 | −₹407 | 17% | 0.71 | ₹45,784 | TRAIL 55 (−₹46,117), SQUARE_OFF 13 (₹39,556), STOP 4 (−₹12,146) |
| NA-vwap · small10k | 15 | −₹5,446 | −₹363 ± 209 | −₹734 … ₹33 | −₹118 | 7% | 0.29 | ₹7,104 | TRAIL 11 (−₹5,256), SQUARE_OFF 3 (₹824), STOP 1 (−₹1,015) |
| NA-vwap · small5k | 3 | −₹1,883 | −₹628 ± 321 | −₹1,197 … −₹85 | −₹41 | 0% | 0 | ₹1,883 | TRAIL 2 (−₹686), STOP 1 (−₹1,197) |
| NA-base-voltarget · main | 60 | −₹32,763 | −₹546 ± 395 | −₹1,455 … ₹622 | −₹712 | 25% | 0.6 | ₹61,562 | SQUARE_OFF 40 (₹20,915), STOP 20 (−₹53,679) |
| NA-base-voltarget · small10k | 10 | −₹5,412 | −₹541 ± 358 | −₹1,157 … ₹248 | −₹118 | 20% | 0.3 | ₹7,777 | SQUARE_OFF 6 (₹407), STOP 4 (−₹5,820) |
| NA-base-voltarget · small5k | 7 | −₹2,596 | −₹371 ± 468 | −₹1,123 … ₹694 | −₹56 | 29% | 0.47 | ₹4,894 | SQUARE_OFF 4 (₹1,121), STOP 3 (−₹3,718) |
| ORB-window · main | 94 | −₹22,265 | −₹237 ± 319 | −₹1,021 … ₹699 | −₹412 | 26% | 0.79 | ₹49,134 | STOP 57 (−₹92,972), SQUARE_OFF 37 (₹70,703) |
| ORB-window · small10k | 5 | −₹5,101 | −₹1,020 ± 172 | −₹1,339 … −₹655 | −₹94 | 0% | 0 | ₹5,101 | STOP 4 (−₹4,611), SQUARE_OFF 1 (−₹491) |
| ORB-window · small5k | 2 | −₹2,630 | −₹1,315 ± 198 | −₹1,513 … −₹1,118 | −₹49 | 0% | 0 | ₹2,630 | STOP 2 (−₹2,631) |
| ORB-published · main | 103 | −₹23,310 | −₹226 ± 317 | −₹1,002 … ₹702 | −₹432 | 24% | 0.81 | ₹49,165 | STOP 66 (−₹1,03,239), SQUARE_OFF 37 (₹79,935) |
| ORB-published · small10k | 4 | −₹5,026 | −₹1,256 ± 141 | −₹1,494 … −₹868 | −₹93 | 0% | 0 | ₹5,026 | STOP 4 (−₹5,026) |
| ORB-published · small5k | 3 | −₹2,320 | −₹773 ± 427 | −₹1,294 … ₹73 | −₹43 | 33% | 0.03 | ₹2,320 | STOP 3 (−₹2,319) |

### B. 5-minute engine replay, engine as-is (Kelly/decay overlay on)

| run | trades | net | ₹/trade ± SE | 95% CI ₹/trade (day bootstrap) | ₹/session | hit | PF | max DD | exits |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NA-base · main | 40 | −₹30,592 | −₹765 ± 320 | −₹1,489 … ₹62 | −₹665 | 25% | 0.39 | ₹40,252 | SQUARE_OFF 28 (−₹3,063), STOP 12 (−₹27,530) |
| NA-base · small10k | 10 | −₹5,412 | −₹541 ± 358 | −₹1,157 … ₹248 | −₹118 | 20% | 0.3 | ₹7,777 | SQUARE_OFF 6 (₹407), STOP 4 (−₹5,820) |
| NA-base · small5k | 7 | −₹2,596 | −₹371 ± 468 | −₹1,123 … ₹694 | −₹56 | 29% | 0.47 | ₹4,894 | SQUARE_OFF 4 (₹1,121), STOP 3 (−₹3,718) |
| NA-vwap · main | 40 | −₹19,751 | −₹494 ± 219 | −₹880 … −₹40 | −₹429 | 10% | 0.37 | ₹24,891 | TRAIL 33 (−₹29,383), SQUARE_OFF 7 (₹9,632) |
| NA-vwap · small10k | 15 | −₹5,446 | −₹363 ± 209 | −₹734 … ₹33 | −₹118 | 7% | 0.29 | ₹7,104 | TRAIL 11 (−₹5,256), SQUARE_OFF 3 (₹824), STOP 1 (−₹1,015) |
| NA-vwap · small5k | 3 | −₹1,883 | −₹628 ± 321 | −₹1,197 … −₹85 | −₹41 | 0% | 0 | ₹1,883 | TRAIL 2 (−₹686), STOP 1 (−₹1,197) |
| ORB-window · main | 40 | −₹32,342 | −₹809 ± 320 | −₹1,566 … ₹147 | −₹599 | 18% | 0.37 | ₹32,342 | STOP 23 (−₹38,366), SQUARE_OFF 17 (₹6,021) |
| ORB-window · small10k | 5 | −₹5,101 | −₹1,020 ± 172 | −₹1,339 … −₹655 | −₹94 | 0% | 0 | ₹5,101 | STOP 4 (−₹4,611), SQUARE_OFF 1 (−₹491) |
| ORB-window · small5k | 2 | −₹2,630 | −₹1,315 ± 198 | −₹1,513 … −₹1,118 | −₹49 | 0% | 0 | ₹2,630 | STOP 2 (−₹2,631) |
| ORB-published · main | 40 | −₹31,634 | −₹791 ± 318 | −₹1,569 … ₹154 | −₹586 | 23% | 0.38 | ₹31,634 | STOP 23 (−₹38,144), SQUARE_OFF 17 (₹6,511) |
| ORB-published · small10k | 4 | −₹5,026 | −₹1,256 ± 141 | −₹1,494 … −₹868 | −₹93 | 0% | 0 | ₹5,026 | STOP 4 (−₹5,026) |
| ORB-published · small5k | 3 | −₹2,320 | −₹773 ± 427 | −₹1,294 … ₹73 | −₹43 | 33% | 0.03 | ₹2,320 | STOP 3 (−₹2,319) |

### C. 2-year hourly approximation (main; small accounts below)

| run | trades | net | ₹/trade ± SE | 95% CI ₹/trade (day bootstrap) | ₹/session | hit | PF | max DD | exits |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H NA-base · main | 694 | −₹2,13,505 | −₹308 ± 150 | −₹684 … ₹89 | −₹303 | 38% | 0.81 | ₹3,22,333 | SQUARE_OFF 549 (₹3,64,937), STOP 145 (−₹5,78,437) |
| H NA-base · main · +2 ticks each side | 694 | −₹2,19,419 | −₹316 ± 150 | −₹693 … ₹81 | −₹312 | 38% | 0.8 | ₹3,26,894 | SQUARE_OFF 549 (₹3,60,293), STOP 145 (−₹5,79,709) |
| H NA-base · small10k | 6 | −₹5,049 | −₹842 ± 420 | −₹1,624 … ₹63 | −₹7 | 17% | 0.15 | ₹5,049 | SQUARE_OFF 5 (−₹3,286), STOP 1 (−₹1,764) |
| H NA-base · small5k | 3 | −₹2,158 | −₹719 ± 1122 | −₹1,916 … ₹1,523 | −₹3 | 33% | 0.41 | ₹2,158 | SQUARE_OFF 2 (−₹393), STOP 1 (−₹1,764) |
| H NA-vwap · main | 720 | −₹1,72,666 | −₹240 ± 113 | −₹537 … ₹69 | −₹245 | 31% | 0.81 | ₹2,34,665 | SQUARE_OFF 346 (₹5,32,215), TRAIL 311 (−₹4,61,543), STOP 63 (−₹2,43,331) |
| H NA-vwap · main · +2 ticks each side | 720 | −₹1,78,810 | −₹248 ± 113 | −₹546 … ₹61 | −₹254 | 31% | 0.8 | ₹2,39,593 | SQUARE_OFF 346 (₹5,29,283), TRAIL 311 (−₹4,64,199), STOP 63 (−₹2,43,889) |
| H NA-vwap · small10k | 11 | −₹5,773 | −₹525 ± 291 | −₹1,098 … ₹136 | −₹8 | 18% | 0.26 | ₹5,773 | TRAIL 5 (−₹2,745), SQUARE_OFF 4 (−₹645), STOP 2 (−₹2,384) |
| H NA-vwap · small5k | 6 | −₹2,301 | −₹384 ± 390 | −₹911 … ₹494 | −₹3 | 17% | 0.4 | ₹2,344 | TRAIL 4 (−₹2,809), SQUARE_OFF 2 (₹508) |
| H NA-base-voltarget · main | 699 | −₹2,35,827 | −₹337 ± 150 | −₹717 … ₹59 | −₹335 | 38% | 0.79 | ₹3,44,655 | SQUARE_OFF 552 (₹3,58,513), STOP 147 (−₹5,94,333) |
| H NA-base-voltarget · main · +2 ticks each side | 699 | −₹2,41,797 | −₹346 ± 150 | −₹725 … ₹50 | −₹343 | 38% | 0.79 | ₹3,49,273 | SQUARE_OFF 552 (₹3,53,839), STOP 147 (−₹5,95,631) |
| H NA-base-voltarget · small10k | 6 | −₹5,049 | −₹842 ± 420 | −₹1,624 … ₹63 | −₹7 | 17% | 0.15 | ₹5,049 | SQUARE_OFF 5 (−₹3,286), STOP 1 (−₹1,764) |
| H NA-base-voltarget · small5k | 3 | −₹2,158 | −₹719 ± 1122 | −₹1,916 … ₹1,523 | −₹3 | 33% | 0.41 | ₹2,158 | SQUARE_OFF 2 (−₹393), STOP 1 (−₹1,764) |

### D. Placebo comparison (strategy mean − placebo mean, in units of the strategy's SE)

| run | strategy ₹/trade ± SE (n) | placebo: same exits | placebo: matched hold | diff vs same-exits (×SE) | diff vs matched-hold (×SE) | §5.5 (≥ 2 SE) |
| --- | --- | --- | --- | --- | --- | --- |
| NA-base · main | −₹546 ± 395 (60) | −₹566 ± 37 | −₹483 ± 36 | ₹20 (0.1) | −₹63 (-0.2) | fail |
| NA-base · small10k (main's signals, fresh account) | −₹495 ± 236 (60) | −₹428 ± 21 | −₹463 ± 21 | −₹67 (-0.3) | −₹32 (-0.1) | fail |
| NA-base · small5k (main's signals, fresh account) | −₹474 ± 221 (60) | −₹399 ± 21 | −₹384 ± 20 | −₹75 (-0.3) | −₹90 (-0.4) | fail |
| NA-vwap · main | −₹260 ± 302 (72) | −₹237 ± 24 | −₹314 ± 29 | −₹23 (-0.1) | ₹54 (0.2) | fail |
| NA-vwap · small10k (main's signals, fresh account) | −₹245 ± 181 (72) | −₹178 ± 14 | −₹303 ± 17 | −₹67 (-0.4) | ₹58 (0.3) | fail |
| NA-vwap · small5k (main's signals, fresh account) | −₹249 ± 171 (72) | −₹170 ± 14 | −₹124 ± 10 | −₹79 (-0.5) | −₹125 (-0.7) | fail |
| ORB-window · main | −₹237 ± 319 (94) | −₹290 ± 48 | −₹424 ± 31 | ₹53 (0.2) | ₹187 (0.6) | fail |
| ORB-window · small10k (main's signals, fresh account) | −₹235 ± 196 (94) | −₹233 ± 30 | −₹311 ± 18 | −₹2 (-0.0) | ₹76 (0.4) | fail |
| ORB-window · small5k (main's signals, fresh account) | −₹240 ± 184 (94) | −₹240 ± 29 | −₹359 ± 19 | ₹0 (0.0) | ₹119 (0.6) | fail |
| ORB-published · main | −₹226 ± 317 (103) | −₹270 ± 43 | −₹379 ± 29 | ₹44 (0.1) | ₹153 (0.5) | fail |
| ORB-published · small10k (main's signals, fresh account) | −₹204 ± 195 (103) | −₹198 ± 27 | −₹245 ± 16 | −₹6 (-0.0) | ₹41 (0.2) | fail |
| ORB-published · small5k (main's signals, fresh account) | −₹212 ± 184 (103) | −₹208 ± 25 | −₹292 ± 18 | −₹4 (-0.0) | ₹80 (0.4) | fail |
| H NA-base · main | −₹308 ± 150 (694) | −₹500 ± 53 | −₹388 ± 53 | ₹192 (1.3) | ₹80 (0.5) | fail |
| H NA-base · small10k (main's signals, fresh account) | −₹326 ± 80 (666) | −₹451 ± 29 | −₹437 ± 27 | ₹125 (1.6) | ₹111 (1.4) | fail |
| H NA-base · small5k (main's signals, fresh account) | −₹327 ± 75 (691) | −₹394 ± 29 | −₹419 ± 30 | ₹67 (0.9) | ₹92 (1.2) | fail |
| H NA-vwap · main | −₹240 ± 113 (720) | −₹263 ± 38 | −₹343 ± 46 | ₹23 (0.2) | ₹103 (0.9) | fail |
| H NA-vwap · small10k (main's signals, fresh account) | −₹275 ± 61 (691) | −₹268 ± 20 | −₹301 ± 21 | −₹7 (-0.1) | ₹26 (0.4) | fail |
| H NA-vwap · small5k (main's signals, fresh account) | −₹274 ± 57 (717) | −₹223 ± 20 | −₹274 ± 24 | −₹51 (-0.9) | ₹0 (0.0) | fail |

### E. ±20% perturbations, one at a time (robustness only)

| run | main trades | main net | main ₹/trade ± SE | ₹10k net (n) | ₹5k net (n) |
| --- | --- | --- | --- | --- | --- |
| **NA-base** (as published) | 60 | −₹32,763 | −₹546 ± 395 | −₹5,412 (10) | −₹2,596 (7) |
| NA-base bandMult=0.8 | 66 | −₹31,470 | −₹477 ± 372 | −₹5,343 (9) | −₹2,175 (6) |
| NA-base bandMult=1.2 | 52 | −₹26,477 | −₹509 ± 450 | −₹5,420 (10) | −₹2,037 (6) |
| NA-base decisionEveryMin=25 | 61 | −₹35,408 | −₹580 ± 377 | −₹5,140 (8) | −₹1,799 (5) |
| NA-base decisionEveryMin=35 | 64 | −₹33,254 | −₹520 ± 379 | −₹4,963 (10) | −₹2,415 (7) |
| NA-base lookbackSessions=11 | 65 | −₹43,303 | −₹666 ± 372 | −₹4,840 (8) | −₹2,726 (6) |
| NA-base lookbackSessions=17 | 59 | −₹38,686 | −₹656 ± 393 | −₹5,274 (5) | −₹1,854 (2) |
| **NA-vwap** (as published) | 72 | −₹18,705 | −₹260 ± 302 | −₹5,446 (15) | −₹1,883 (3) |
| NA-vwap bandMult=0.8 | 75 | −₹9,636 | −₹128 ± 294 | −₹4,883 (17) | −₹2,038 (4) |
| NA-vwap bandMult=1.2 | 60 | −₹12,015 | −₹200 ± 355 | −₹5,858 (15) | −₹1,820 (3) |
| NA-vwap decisionEveryMin=25 | 70 | −₹29,024 | −₹415 ± 281 | −₹4,906 (13) | −₹2,206 (3) |
| NA-vwap decisionEveryMin=35 | 69 | −₹17,634 | −₹256 ± 331 | −₹5,709 (15) | −₹2,115 (3) |
| NA-vwap lookbackSessions=11 | 72 | −₹17,396 | −₹242 ± 300 | −₹4,841 (13) | −₹1,811 (3) |
| NA-vwap lookbackSessions=17 | 66 | −₹17,842 | −₹270 ± 320 | −₹5,050 (11) | −₹1,905 (3) |
| **ORB-window** (as published) | 94 | −₹22,265 | −₹237 ± 319 | −₹5,101 (5) | −₹2,630 (2) |
| ORB-window targetR=12 | 94 | −₹22,265 | −₹237 ± 319 | −₹5,101 (5) | −₹2,630 (2) |
| ORB-window targetR=8 | 94 | −₹18,704 | −₹199 ± 321 | −₹5,101 (5) | −₹2,630 (2) |
| **ORB-published** (as published) | 103 | −₹23,310 | −₹226 ± 317 | −₹5,026 (4) | −₹2,320 (3) |
| ORB-published targetR=12 | 103 | −₹23,310 | −₹226 ± 317 | −₹5,026 (4) | −₹2,320 (3) |
| ORB-published targetR=8 | 103 | −₹23,473 | −₹228 ± 317 | −₹5,026 (4) | −₹2,320 (3) |
| **H NA-base** (as published) | 694 | −₹2,13,505 | −₹308 ± 150 | −₹5,049 (6) | −₹2,158 (3) |
| H NA-base bandMult=0.8 | 827 | −₹3,54,425 | −₹429 ± 134 | −₹5,049 (6) | −₹2,158 (3) |
| H NA-base bandMult=1.2 | 592 | −₹1,51,701 | −₹256 ± 167 | −₹5,454 (5) | −₹2,053 (2) |
| H NA-base lookbackSessions=11 | 702 | −₹2,38,043 | −₹339 ± 149 | −₹5,454 (5) | −₹2,158 (3) |
| H NA-base lookbackSessions=17 | 682 | −₹2,12,487 | −₹312 ± 154 | −₹5,014 (5) | −₹1,929 (4) |
| **H NA-vwap** (as published) | 720 | −₹1,72,666 | −₹240 ± 113 | −₹5,773 (11) | −₹2,301 (6) |
| H NA-vwap bandMult=0.8 | 854 | −₹1,94,969 | −₹228 ± 106 | −₹4,933 (8) | −₹1,810 (5) |
| H NA-vwap bandMult=1.2 | 617 | −₹1,66,871 | −₹270 ± 122 | −₹5,773 (10) | −₹2,381 (4) |
| H NA-vwap lookbackSessions=11 | 733 | −₹2,17,722 | −₹297 ± 111 | −₹4,847 (9) | −₹2,372 (6) |
| H NA-vwap lookbackSessions=17 | 708 | −₹1,59,474 | −₹225 ± 115 | −₹5,793 (51) | −₹1,919 (4) |

### F. Copy delay: same trades, entry and exit priced one 5-minute bar later, +2 ticks against us each side

| run | trades | engine net | re-priced without delay (check) | with delay | ₹/trade with delay ± SE | change ₹/trade |
| --- | --- | --- | --- | --- | --- | --- |
| NA-base · main | 60 | −₹32,763 | −₹32,763 | −₹21,953 | −₹366 ± 403 | ₹180 |
| NA-base · small10k | 10 | −₹5,412 | −₹5,412 | −₹6,188 | −₹619 ± 356 | −₹78 |
| NA-base · small5k | 7 | −₹2,596 | −₹2,596 | −₹3,116 | −₹445 ± 459 | −₹74 |
| NA-vwap · main | 72 | −₹18,705 | −₹18,705 | −₹4,980 | −₹69 ± 306 | ₹191 |
| NA-vwap · small10k | 15 | −₹5,446 | −₹5,446 | −₹4,810 | −₹321 ± 205 | ₹42 |
| NA-vwap · small5k | 3 | −₹1,883 | −₹1,883 | −₹1,195 | −₹398 ± 433 | ₹229 |
| NA-base-voltarget · main | 60 | −₹32,763 | −₹32,763 | −₹21,953 | −₹366 ± 403 | ₹180 |
| NA-base-voltarget · small10k | 10 | −₹5,412 | −₹5,412 | −₹6,188 | −₹619 ± 356 | −₹78 |
| NA-base-voltarget · small5k | 7 | −₹2,596 | −₹2,596 | −₹3,116 | −₹445 ± 459 | −₹74 |
| ORB-window · main | 94 | −₹22,265 | −₹22,265 | −₹24,566 | −₹261 ± 317 | −₹24 |
| ORB-window · small10k | 5 | −₹5,101 | −₹5,101 | −₹4,217 | −₹843 ± 145 | ₹177 |
| ORB-window · small5k | 2 | −₹2,630 | −₹2,630 | −₹2,282 | −₹1,141 ± 205 | ₹174 |
| ORB-published · main | 103 | −₹23,310 | −₹23,310 | −₹14,945 | −₹145 ± 313 | ₹81 |
| ORB-published · small10k | 4 | −₹5,026 | −₹5,026 | −₹5,050 | −₹1,263 ± 306 | −₹6 |
| ORB-published · small5k | 3 | −₹2,320 | −₹2,320 | −₹3,272 | −₹1,091 ± 461 | −₹317 |

### G. Pricer bias: implied vol × 0.9 (the synthetic pricer overprices weeklies by ~10–12%)

| run | trades | net (IV × 1.0) | net (IV × 0.9) | ₹/trade (IV × 1.0) | ₹/trade (IV × 0.9) |
| --- | --- | --- | --- | --- | --- |
| NA-base · main | 60 → 61 | −₹32,763 | −₹23,439 | −₹546 | −₹384 |
| NA-base · small10k | 10 → 11 | −₹5,412 | −₹5,741 | −₹541 | −₹522 |
| NA-base · small5k | 7 → 8 | −₹2,596 | −₹1,989 | −₹371 | −₹249 |
| NA-vwap · main | 72 → 72 | −₹18,705 | −₹13,197 | −₹260 | −₹183 |
| NA-vwap · small10k | 15 → 16 | −₹5,446 | −₹5,050 | −₹363 | −₹316 |
| NA-vwap · small5k | 3 → 3 | −₹1,883 | −₹1,935 | −₹628 | −₹645 |
| ORB-window · main | 94 → 94 | −₹22,265 | −₹12,487 | −₹237 | −₹133 |
| ORB-window · small10k | 5 → 4 | −₹5,101 | −₹4,808 | −₹1,020 | −₹1,202 |
| ORB-window · small5k | 2 → 2 | −₹2,630 | −₹2,108 | −₹1,315 | −₹1,054 |
| ORB-published · main | 103 → 103 | −₹23,310 | −₹14,389 | −₹226 | −₹140 |
| ORB-published · small10k | 4 → 12 | −₹5,026 | −₹5,343 | −₹1,256 | −₹445 |
| ORB-published · small5k | 3 → 2 | −₹2,320 | −₹2,065 | −₹773 | −₹1,032 |

### H. Harness validation (5-minute snapshot, engine order): trades identical to the engine replay

| run | engine trades | harness trades | identical (entry, index, side, exit, P&L) |
| --- | --- | --- | --- |
| NA-base · main | 60 | 60 | 60 |
| NA-base · small10k | 10 | 10 | 10 |
| NA-base · small5k | 7 | 7 | 7 |
| ORB-window · main | 94 | 94 | 94 |
| ORB-window · small10k | 5 | 5 | 5 |
| ORB-window · small5k | 2 | 2 | 2 |

## 4. Reading the results

### 4.1 Is there an edge before the option? (index level, main's trades)

The signed index return from each trade's entry to its exit (the same spots the option fills were priced from),
before any option effect:

| run | trades | signed index move per trade | t (per trade) | t (day-clustered) | trades right |
|---|---|---|---|---|---|
| hourly · noise area base | 694 | +5.1 bps | 2.86 | 2.17 (389 days) | 52 % |
| hourly · noise area VWAP | 720 | +4.1 bps | 2.90 | 2.17 (388 days) | 43 % |
| 5-min · noise area base | 60 | +1.9 bps | 0.42 | 0.30 (34 days) | 47 % |
| 5-min · noise area VWAP | 72 | +1.3 bps | 0.35 | 0.26 (34 days) | 38 % |
| 5-min · ORB, engine window | 94 | +3.5 bps | 0.94 | 0.67 (51 days) | 33 % |
| 5-min · ORB, as published | 103 | +2.6 bps | 0.72 | 0.51 (54 days) | 33 % |

Same-day NIFTY and SENSEX trades move together, so the day-clustered t is the honest one. The noise-area signals
show a small momentum effect over two years (≈ 5 bps per trade, about 5 bps per session at ~1 trade per session — under half the +12 bps a day the paper reports for SPY),
suggestive but not significant once the ~40 configurations tried here are counted. Converted to one lot at
delta ≈ 0.5 it is worth ≈ ₹400 per trade (NIFTY ≈ 24,000 × 5 bps × 0.5 × 65; SENSEX ≈ 78,000 × 5 bps × 0.5 × 20);
the hourly gross option P&L is −₹241 per trade and charges ₹66, so the option drag is ≈ ₹650–700 per trade
(theta over a 2½–3½-hour hold, half-spreads paid twice, the late premium stops). That is the plan's prior
(§3 A: "+12 bps/day ≈ ₹975/day per lot against ≈ ₹720/day of drag — marginal even if the effect transfers
intact"), and the effect we measure is smaller than the paper's.

### 4.2 Against the §5 acceptance criteria

| § | criterion | noise area (base, VWAP) | ORB (published, window) |
|---|---|---|---|
| 1 | published parameters frozen | yes (14, VM 1, HH:00/HH:30) | yes (5-min range, 10R) |
| 2 | out of sample | whole sample (nothing fitted) | whole sample |
| 3 | ≥ 180 OOS trades | 5-min: no (60/72, "insufficient"); hourly: yes (694/720) | no (103/94) — insufficient |
| 4 | costs incl. copy delay | yes on 5-min (table F); hourly: +2 ticks only | yes (table F) |
| 5 | beats placebo by ≥ 2 SE | **fail** (−0.9 … +1.6 SE) | **fail** (−0.0 … +0.6 SE) |
| 6 | bootstrap 95 % CI lower bound > 0 | **fail** (every CI reaches below zero; small accounts' hourly CIs entirely below zero) | **fail** |
| 7 | PF ≥ 1.3, drawdown, concentration | **fail** (PF 0.6–0.81) | **fail** (PF 0.79–0.81) |
| 8 | ±20 % perturbations net > 0 in ≥ 80 % | **fail** (0 % positive) | **fail** (0 % positive) |
| 9 | multiple testing | **fail** (best p(mean ≤ 0) ≈ 0.6) | **fail** |
| 10 | real-price sanity | not run (WP6 data) | not run |
| 11 | no look-ahead | point-in-time by construction and by test; WP8 to sign off | same |
| 12 | both account types | **fail** (small accounts worse; ruined in their own books) | **fail** |

### 4.3 What this means for the owner

* Do not enable either rule on any account, real or paper. On our instrument the best case is "a few basis points
  of index momentum, bought with options that cost more than it pays".
* The ₹10k and ₹5k accounts are the most exposed: one lot of a ₹40–70 (NIFTY) or ₹130–220 (SENSEX) option loses
  ₹200–500 per trade on these signals, and a handful of losses leaves too little equity to buy the next lot.
* If intraday momentum is ever pursued again, it needs an instrument without theta and with a tighter spread
  (index futures, a main-account-only decision) — outside this engine's buy-only design — or real option prices
  showing the drag is much smaller than the synthetic pricer says (WP6), which the IV × 0.9 sensitivity does not
  suggest.

## 5. Reproduce

```
cp -al <main checkout>/node_modules node_modules
H=scratchpad/why/hist.json  Y=scratchpad/dl/y1h
npx tsx scripts/research/published-strategies.ts --history $H --hourly $Y --only engine,delay,placebo,validate
npx tsx scripts/research/published-strategies.ts --history $H --only overlay,bias
npx tsx scripts/research/published-strategies.ts --history $H --only perturb --perturb-set noise   # and --perturb-set orb
npx tsx scripts/research/published-strategies.ts --history $H --hourly $Y --only hourly,hourly-placebo
npx tsx scripts/research/published-strategies.ts --history $H --hourly $Y --only hourly-perturb
npx tsx scripts/research/published-strategies.ts --history $H --hourly $Y --only signals
npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits --strategy noise-area --history $H   # single runs
```
Every run appended a line to `reports/trials.jsonl` (183 lines from this work package). The hourly lines
written before 15:25 IST log `decisionEveryMin: 30` from the config although the hourly harness decides at hourly
closes (10:15 … 14:15); later lines log the effective 60 / :15 grid.

## 6. Caveats and what is not done

* **Synthetic option prices, biased high.** Every rupee figure uses the repo's Black–Scholes-on-VIX pricer (no
  skew, flat 0.4 % spread model). WP6 found it overprices weekly options by ~10–12 % against real prices. For a
  bought ATM option that inflates the costs that scale with the premium — theta over the hold, the half-spreads,
  the premium-proportional charges — by about that much, while the delta P&L of an ATM option (≈ 0.5 × the index
  move) is nearly unchanged; for the small accounts it also pushes the premium band further out of the money than
  real quotes would. So the synthetic numbers are somewhat too pessimistic on cost. Table G measures it: removing
  ~10 % of implied vol (IV × 0.9) improves main by ₹80–160 per trade and turns no variant positive. The real-price
  sanity check of §5.10 (bhavcopy ranges) was not run here (WP6 owns the data).
* **5-minute snapshot is underpowered.** 54 sessions (noise area: 46 tradable, it needs 13 of 14 prior sessions);
  SE ≈ ₹300–400 per trade; every 5-minute CI spans zero. It is the full-fidelity check of the mechanics, not
  evidence either way.
* **Hourly approximation, exactly what is modelled.** Yahoo 1-hour bars, 718 complete sessions 31 Oct 2023 – 8 Oct
  2026 (8 incomplete sessions dropped), the first 14 only build σ → 704 sessions traded. σ(HH:15) from hourly
  closes; decisions at the closes of 10:15, 11:15, 12:15, 13:15, 14:15 (5 a day instead of 10 half-hours; seen 90 s
  later); the same checkpoints for every exit, including the premium stop (so stops fill late and worse than
  −30 %: 145 base-model stop-outs averaged −₹3,989); square-off at the 15:15 close (10 minutes after our 15:05,
  no earlier price exists in an hourly bar); VWAP = running mean of hourly typical prices; exits before entries, so
  reversals are same-bar as in the paper. Entries go through the engine's own planner (all gates, the contract
  choice, sizing), paper broker (ask in, bid out), risk state and position cycle; India VIX hourly closes feed the
  pricer; charges by date. **Counterfactual contract specs:** today's lot sizes (65 / 20) and weekly expiry weekdays
  (NIFTY Tuesday, SENSEX Thursday) are applied to the 2023–2026 index paths (the exchanges used other weekdays and
  lot sizes then); holidays are inferred from weekdays without bars; the bundled event calendar only covers 2026,
  so earlier sessions have no scheduled-event blackout. The harness reproduces the engine replay trade for trade on
  the 5-minute snapshot (table H). No Kelly/decay overlay.
* **Deviations from the papers that the brief requires.** The premium stop stays as a disaster stop: it closed 20 of
  60 base-model trades on the snapshot (−₹53,679) and 145 of 694 on the hourly data; the paper holds those to the
  close or the opposite band. Exits are at 15:05, not the close. All engine gates stay (loss streaks and daily caps
  cut some days short; one position per index; no opposite NIFTY/SENSEX positions). In the engine replays a
  reversal is entered on the next 5-minute bar (entries are booked before exits within a tick); the hourly harness
  reverses on the same bar. Vol-target sizing is moot under the 1-lot-per-order setting.
* **Copy delay** is modelled by re-pricing the same trades (entry and exit one 5-minute bar later, 2 extra ticks
  against us each side, charges recomputed); path effects (a different premium-stop path, a missed fill) are not
  modelled. It cannot be modelled on hourly bars (one bar = one hour); there only the +2 ticks are applied.
* **Placebos** are strategy-matched and local (WP0's `--placebo-random/--protocol/--copy-delay` harness was not
  available in this worktree): "same exits" = random side and decision time on the strategy's own days, exits by the
  strategy's rule from the next bar; "matched hold" = random time 09:26:30–14:26:30 and side, holding time drawn
  from the strategy's own trades, premium stop and square-off; 3,000 draws, one lot, fresh account each draw. The
  planner's −₹402 ± 33 reference uses the conviction engine's exits and is not directly comparable.
* **Multiple testing.** `reports/trials.jsonl` holds 183 lines from this work package (≈ 40 distinct rule
  configurations × 3 accounts, plus placebos and re-pricings). With N ≥ 40 configurations Bonferroni needs
  p < 0.00125; the best one-sided bootstrap p(mean ≤ 0) of any main variant is 0.61 (copy-delayed noise VWAP on the
  snapshot). No deflated Sharpe was computed (WP0 owns it).
* **The ORB paper** (SSRN 4416622) was not in the scratchpad; the rule follows PLAN §3 B, which matches the
  published rule as summarised there. ORB cannot be tested on hourly bars.
* **Independent corroboration** (from another work package, relayed by the coordinator): on 2 years of hourly NIFTY
  data a large first hour (> 0.24 %) showed no follow-through into the rest of the day (48.9 % of 319 days). That is
  consistent with what we see: whatever intraday momentum exists is a few basis points per trade (52 % of noise-area
  trades right), far below what a bought weekly option needs.
* **Not done:** a real-price (bhavcopy) re-run; walk-forward is not applicable (nothing was fitted); `reports/` is in
  `.gitignore`, so this report and the trials ledger were force-added to the commit.
