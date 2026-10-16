# Options agent: a paper experiment

A measured experiment on paper, not advice. This project's research found no edge for option buyers: 3,303 rule variants and 98 option-flow rules, tested on real prices. A model's confidence is not a probability until the nightly scoring shows it is calibrated. Sizing uses measured results only, and every limit is enforced in code. The most likely honest result is a Brier score near the baseline, sizing at zero and few or no trades. That is a valid outcome, not a failure to fix by loosening gates.

The agent trades NIFTY and SENSEX index options on its own paper account, `agent` ("Agent ₹5L", ₹5,00,000). It only buys: LONG buys a call, SHORT buys a put, and NEUTRAL means no trade. It never sells options and is never LIVE. Every agent position is intraday and is squared off at 15:05 IST.

## How it works

Two models judge, and code decides:

- **The reflex model** (`AGENT_MODEL`) judges each closed 5-minute candle. One call covers every finalist on both indices: one generic finalist per index, plus the ideas in that day's Advisor brief. It returns one typed decision per finalist: regime, direction, confidence, toxic flow, setup quality (0–3), risk state and a short reason.
- **The deep model** (`AGENT_ESCALATION_MODEL`, `AGENT_REVIEW_MODEL`) handles two jobs:
  - escalations, a second opinion when the reflex is unsure on a decent setup or flips to CRISIS;
  - the nightly review.
- **Code** owns every threshold, size and order (`src/engine/agent/constants.ts`). A decision fires only when its setup quality is at least 2, its confidence is above 0.80, its direction is not NEUTRAL, its regime is not CRISIS, there is no toxic flow (in the model's view or the code's own) and the risk state is SAFE. The engine's own gates still apply (data freshness, liquidity, spread, entry windows 09:25–14:30, loss caps, stops, kill switch), except its measured-edge checks. The verdict of those checks is recorded with every decision.

Where each part runs:

| Part | Where | What it does |
|---|---|---|
| The runner | `workers/engine/src/agent/agentRunner.ts`, inside the trading DO's tick, after main's exits and exit polls | Runs the agent's code exits. Executes each new batch of decisions through the code gate, the planner and the risk layer. Builds each closed bar's snapshot and hands it to the AgentDO. TE stays the only writer of orders and positions. |
| AgentDO | `workers/engine/src/do/AgentDO.ts`, with its own SQLite (`workers/engine/src/agent/sqlAgentStore.ts`) | Makes the model calls on its own alarm, never inside TE's tick. Keeps the bars, decisions, model calls and their cost, escalations, trades, risk, reviews, candidate guidance and job queue. It never places an order. |
| MarketFeedDO | `getOptionFlowAsOf(index, asOfMs)` | The option flow as it read at the candle close, built from minute samples taken at or before it. |

A candle that closes at T:

1. The runner submits the snapshots 30–90 s after T, once both indices' bars are complete. At T + 2 min it submits whatever is complete. At T + 4 min it skips the bar.
2. The AgentDO calls the reflex model on its alarm.
3. A later tick takes the decisions and executes them while they are fresh. A batch more than 4 minutes past its close is recorded as not executed.
4. The reflex judges bars closing from 09:20 to 15:05. Later bars, up to 15:30, are stored for grading only.

### The time and request budgets

- **Time.** The agent's step runs last in the tick. It gets `clamp(tick start + 27 s − now, 4 s, 12 s)`. Every remote call checks that deadline first and has its own timeout: flow 1.5 s, submitting a bar 2 s, taking decisions 1.5 s, recording an execution 2 s. A slow or silent Durable Object therefore costs the agent's step, never main's tick. The agent's exits in main's exit polls run during main's wait and can never lengthen it.
- **Quotes.** The runner has its own Upstox quote instance:
  - at most 4 requests a minute;
  - a 30 s pause after an error;
  - quotes reused for 15 s.

  It never uses main's quote budget. When its budget is spent it falls back to synthetic quotes, and the agent never enters on a synthetic quote.
- **Errors.** A failed step counts against the agent only, with an alert at the fifth in a row. It never counts toward main's DEGRADED state.

## Worker vars (`workers/engine/wrangler.jsonc`)

| Var | Production | Preview | Meaning |
|---|---|---|---|
| `ACCOUNTS` | `main,small10k,small5k,agent` | `main,small10k,small5k` | `agent` adds the agent's paper account and its runner. |
| `AGENT_MODE` | `shadow` | `off` | `off`, `shadow` or `paper`. An unknown value means `off`. |
| `AGENT_MODEL` | as set | as set | The reflex model. |
| `AGENT_ESCALATION_MODEL`, `AGENT_REVIEW_MODEL` | as set | as set | The deep model, for escalations and for the review. |
| `AGENT_DAILY_USD_CAP` | `3` | `3` | USD per IST day across every agent model call, clamped to 0–20. |
| `AGENT_ESCALATIONS_PER_DAY` | `8` | `8` | Clamped to 0–24. |

The modes:

- **off**: no candle is judged. If the account still holds a position, its code exits keep running.
- **shadow**: every candle is judged and gated. The decisions are recorded, together with what paper mode would have done. There are no orders, positions or trades.
- **paper**: orders go to the agent's own paper account only.

The agent uses the existing `ANTHROPIC_API_KEY` secret. Without it every batch fails as `NO_KEY` and nothing is entered.

## Limits (code, not the model)

| Limit | Value |
|---|---|
| Drawdown from peak equity | 15%: kill switch on, positions closed at market, and no entries until the operator re-arms. |
| Daily loss | 3% of equity |
| Weekly loss | 6% |
| Open positions | 2 in total, 1 per index |
| Lots per position | 3 |
| Risk per trade | 1% of equity |
| Trades a day | 6 |
| Model spend | `AGENT_DAILY_USD_CAP` a day. Past it no more candles are judged, so there are no new entries. Exits still run. |

**Sizing** is fractional Kelly, at most a quarter.

- The probability is a cautious (20th percentile) estimate of the chance of a 0.15% move in the called direction. It comes from graded reflex calls, never from the model's own number.
- The payoff ratio is capped at 1 until 30 agent trades have closed.
- With no graded history this sizes to zero, so a new agent takes no trades.

**Kill switches.**

- Main's kill switch engages the agent's. Resetting main does not reset the agent's.
- Telegram `/kill` covers every account. Main's switch is set first, then each other account's, each on its own. One tick then squares off everything.
- The agent's own switch is on the dashboard's kill route (`account: "agent"`).
- A plain reset is refused while the drawdown halt holds. Use **Re-arm** on the Agent page, which also restarts the peak equity at the current equity.

## The approval gate

1. After the close, the POSTMARKET cron and the end of day queue the nightly review. It runs from 16:20 IST and retries at 16:40 if the bar archive is not ready.
2. The review grades every decision on its 30-minute outcome and computes the Brier scores. The deep model then writes the review, and may propose a new guidance text.
3. A candidate text is replayed on the day's stored candles with the current text and with the candidate, on identical inputs. The result is labelled **"in-sample, not proof"**: the reviewer has seen the day's outcomes. The candidate then waits as PENDING.
4. The operator approves or rejects it on the Agent page. Nothing is ever approved automatically. Approve and revert happen only outside the session, so one session is judged by one text.
5. Only the guidance part of the instructions can change. Thresholds, sizes and limits stay in code.

## Ops routes

Each route is a POST with `Authorization: Bearer $ADMIN_TOKEN` to the engine Worker.

| Route | What it does |
|---|---|
| `/ops/agent-status` | The AgentDO's mode, pause, next job, today's spend against the cap, last batch and active guidance version. |
| `/ops/agent-review?date=YYYY-MM-DD` | Queues a review (default today). Only outside the session; it answers 409 during it. On the session's own day it waits for 16:20. |
| `/ops/agent-count-tokens` | The API's token count of one snapshot, `count(snapshot) − count("{}")`, beside the local estimate. It counts the newest stored snapshot of each index and a synthetic worst case, so it runs before the first session too. Counting makes no model call. |
| `/ops/agent-revert` | Makes the built-in guidance active again. Only outside the session. |
| `/ops/agent-pause?on=1` (and `on=0`) | Pauses or resumes the agent without a deploy. While it is paused only its code exits run (with the kill-switch and drawdown checks behind them), no candle is judged and the AgentDO accepts no bars. The pause stays until resumed. |

For example:

```
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<engine>/ops/agent-pause?on=1
```

Telegram `/status` shows the agent's lines: mode, pause, kill switch, drawdown halt, last bars, open positions, today's net P&L and anything waiting for the AgentDO. Agent alerts start with "🤖 Agent (paper experiment)". The agent sends no copy-trade tickets, and the copy tickets for the `agent` account are refused.

## Rollout

1. **Deploy at the weekend** (Sat 17 or Sun 18 Oct 2026), outside market hours, with `AGENT_MODE="shadow"`.
2. **Before Monday 19 Oct:**
   - `/ops/agent-count-tokens`: every counted snapshot is under 400 tokens and no estimate is below its count. If a snapshot counts 360 or more, tighten the estimator and the fields before Monday.
   - `/ops/agent-status`: mode `shadow`, not paused, no failing jobs.
3. **On Monday:**
   - after the first bar, `/ops/agent-count-tokens` again, now on stored snapshots;
   - `/agent` renders, and the account switcher lists "Agent";
   - Telegram `/status` shows the agent's lines;
   - if anything misbehaves during the session, `/ops/agent-pause?on=1` stops it without a deploy.
4. **Switch to paper after reviewing Monday's shadow session.** Tue 20 Oct is a market holiday, so the switch (one var and a deploy) lands before Wed 21 Oct. Monday's labels count in both modes, so shadow loses no information.

## What could be wrong

- **There may be no edge to find.** The design treats "no trades" as a result.
- **The calibrated probability is about the index's move, not the option trade.** Theta, the spread and the stop make the option trade's win rate lower than the probability.
- **Each nightly candidate is fitted to the day it was written on.** Approving often turns the agent into a curve-fit of recent sessions. The half weight for older guidance texts slows that, but only the operator's restraint and out-of-sample days stop it.
- **Paper fills flatter real trading.** The paper broker fills at quoted prices with modelled slippage.
- **Isolation in production is not replayable.** The agent shares D1 and the trading DO's CPU with main. Its quote budget, time budget and error counter are its own, and the replay tests prove main's logic is unchanged.
