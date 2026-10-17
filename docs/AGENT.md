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
| The runner | `workers/engine/src/agent/agentRunner.ts`, inside the trading DO's tick: after main's exits and exit polls, and inside main's 10 s waits between exit polls | Runs the agent's code exits. Executes each new batch of decisions through the code gate, the planner and the risk layer. Builds each closed bar's snapshot and hands it to the AgentDO. TE stays the only writer of orders and positions. The runner never reads main's market data source (its request budget and cached prices are main's): the features of main's own tick are the agent's only market input, and an entry on an index without them is not taken. |
| AgentDO | `workers/engine/src/do/AgentDO.ts`, with its own SQLite (`workers/engine/src/agent/sqlAgentStore.ts`) | Makes the model calls on its own alarm, never inside TE's tick. Keeps the bars, decisions, model calls and their cost, escalations, trades, risk, reviews, candidate guidance and job queue. It never places an order. |
| MarketFeedDO | `getOptionFlowAsOf(index, asOfMs)` | The option flow as it read at the candle close, built from minute samples taken at or before it. It is kept incrementally (`FlowAsOfCache` in `src/engine/agent/flowAsOf.ts`), so a read late in the session costs about one view, not a replay of the day's samples. |

A candle that closes at T:

1. The runner submits the snapshots 30–90 s after T, once both indices' bars are complete. At T + 2 min it submits whatever is complete. At T + 4 min it skips the bar.
2. The AgentDO calls the reflex model on its alarm.
3. A later tick takes the decisions and executes them while they are fresh. A batch more than 4 minutes past its close is recorded as not executed.
4. The reflex judges bars closing from 09:20 to 15:05. Later bars, up to 15:25, are stored for grading only. The 15:30 close comes only from the 16:15 bar archive (TE does no work after 15:30).

Each snapshot carries the agent's book as of the candle close, open P&L included. The runner stamps each book it records after reading its positions, so a fill made after a candle's close never reaches that candle's book.

### The time and request budgets

- **Time.** The agent's step runs last in the tick. It gets `clamp(tick start + 27 s − now, 4 s, 12 s)`, and never runs past 1.5 s before main's next alarm: with less than 1 s left the step is skipped. Every call to another Durable Object checks that deadline first and has its own timeout: submitting a bar 2 s, taking decisions 1.5 s, recording an execution 2 s. The bar's submission is reserved first, and the option-flow read gets what is left, up to 1.5 s; a flow that does not come in time only drops that index's option block, never the bar. Just before the bar is sent, the runner checks again that the agent is not paused or off and that the bar is still under 4 minutes old. A slow or silent Durable Object therefore costs the agent's step, never main's tick or main's next alarm. The agent waits at most 1 s for each Telegram alert; the alert is still sent, and the alerts go out in order.
- **Main's exit-poll waits.** While main is positioned, its tick waits 10 s twice between exit polls. In each wait the agent does all of its step but the decisions: the kill coupling, the code exits, the drawdown check and its halt, the risk row, the book, and the latest closed bar while it is unsent and fresh. Each part starts, and each call to another Durable Object is sent, only before the wait ends. A part that has started can run past the wait's end with its D1 reads and writes, its quotes and its Telegram alerts, and a drawdown halt that starts in a wait always finishes, also after the wait ends. Main does not wait for any of it: the wait ends on time, or later by at most one piece of the agent's code that runs without a pause (a few ms). When main's own work leaves the step too little time (from about 26 s of a 30 s tick), or the step is skipped, a bar is still submitted in its window and a drawdown halt waits at most one wait. Only the decisions wait for a step with time for them. When main holds nothing there are no waits, and only the step does this work.
- **Quotes.** The runner has its own Upstox quote instance:
  - at most 4 requests a minute;
  - a 30 s pause after an error;
  - quotes reused for 15 s.

  It never uses main's quote budget. When its budget is spent it falls back to synthetic quotes, and the agent never enters on a synthetic quote.
- **Errors.** A failed step counts against the agent only, with an alert at the fifth in a row. It never counts toward main's DEGRADED state, and neither does an alert that fails. An agent whose pinned config fails validation stays off with an alert; main and the other accounts start as usual.

## Worker vars (`workers/engine/wrangler.jsonc`)

| Var | Production | Preview | Meaning |
|---|---|---|---|
| `ACCOUNTS` | `main,small10k,small5k,agent` | `main,small10k,small5k` | `agent` adds the agent's paper account and its runner. Without it the `/ops/agent-*` routes answer 409. |
| `AGENT_MODE` | `shadow` | `off` | `off`, `shadow` or `paper`. An unknown value means `off`. |
| `AGENT_MODEL` | as set | as set | The reflex model. |
| `AGENT_ESCALATION_MODEL`, `AGENT_REVIEW_MODEL` | as set | as set | The deep model, for escalations and for the review. |
| `AGENT_DAILY_USD_CAP` | `3` | `3` | USD per IST day across every agent model call, clamped to 0–20. |
| `AGENT_ESCALATIONS_PER_DAY` | `8` | `8` | Clamped to 0–24. |

Only a model with a row in the price table (`src/engine/agent/cost.ts`) is accepted. Any other id falls back to the default, and the Worker logs the var it ignored, so the daily cap always prices what is really called.

The modes:

- **off**: no candle is judged. The nightly review still grades the day, but with no decision in force and no trade it is SKIPPED and makes no model call. If the account still holds a position, its code exits keep running.
- **shadow**: every candle is judged and gated. The decisions are recorded, together with what paper mode would have done. There are no orders, positions or trades.
- **paper**: orders go to the agent's own paper account only.

The agent uses the existing `ANTHROPIC_API_KEY` secret. Without it every batch fails as `NO_KEY` and nothing is entered.

## Limits (code, not the model)

| Limit | Value |
|---|---|
| Drawdown from peak equity | 15%: kill switch on, positions closed at market, and no entries until the operator re-arms. The halt acts first and is recorded last: if a write fails part way, the next step or exit-poll wait does all of it again. While it holds, every step and wait checks that the kill switch is still on. |
| Daily loss | 3% of equity |
| Weekly loss | 6% |
| Open positions | 2 in total, 1 per index |
| Lots per position | 3 |
| Risk per trade | 1% of equity |
| Trades a day | 6 |
| Model spend | `AGENT_DAILY_USD_CAP` a day. Past it no more candles are judged, so there are no new entries. Exits still run. |

**Model spend.**

- Every call is booked at its worst case before it goes out, then at its real cost. Each attempt that may have been billed (one that timed out, was cut off, or whose answer stream broke) is charged separately at its worst case. An attempt the API refused with an error status bills nothing and is not charged.
- The nightly review's `max_tokens` is 16K. Its worst case is priced as it is billed: the cached system block at the 1-hour cache-write rate, the day's text at the plain input rate.
- Escalations leave two reserves: the rest of the day's reflex calls, and that worst case for tonight's review (about $1.13 with the default review model). The review reserve is released once that day's review has run. With the $3 cap, the reflex reserve at 09:20 (about $0.57) and one escalation's worst case (about $0.58), escalations can start while the day's spend is at most about $0.72. A day with 8 typical escalations (about $0.08 each) stays under that and keeps its review.
- The review and the candidate's replay leave the day's reflex reserve too, so a review forced before the open never spends the session's reflex money.

**Sizing** is fractional Kelly, at most a quarter.

- The probability is a cautious (20th percentile) estimate of the chance of a 0.15% move in the called direction. It comes from graded calls, never from the model's own number. A reflex call is sized on graded reflex calls, and an escalation on graded escalation calls; with none of its kind, a call takes no trade.
- The payoff ratio is capped at 1 until 30 agent trades have closed.
- With no graded history this sizes to zero, so a new agent takes no trades.
- A size above zero means only that confident past calls moved enough to pay often enough to clear break-even, measured on the graded calls shown with it. It is in-sample, not proof of an edge.

**Kill switches.**

- Main's kill switch engages the agent's at once (the agent's own step and its work in main's exit-poll waits also check main's switch, as a backstop). Resetting main does not reset the agent's.
- Telegram `/kill` covers every account. Main goes first: its switch is set, then each follower's, each on its own. One tick then squares off main and the followers, and the relay panic goes out for any LIVE position. The agent gives way from the moment the kill comes in, before main's switch is written: TE stops waiting for an agent step in progress, no agent step starts, the agent's work in a wait stops before its next part, and the waits run only the agent's code exits. A step already running carries on: it read main's switch before the kill, and it reads the kill switches again before each order. Only after the panic is the agent's switch set and its own exits run, and the agent is held until they are done. A kill of main alone that squares off keeps the same order. A kill without a square-off does not hold the agent.
- The agent's own switch is on the dashboard's kill route (`account: "agent"`).
- A plain reset is refused while the drawdown halt holds. Use **Re-arm** on the Agent page. After a halt it also restarts the peak equity at the current equity; when only the kill switch was on, the drawdown is still measured from the old peak. The Agent page shows the result at once, also in the evening.

## The approval gate

1. After the close, the POSTMARKET cron and the end of day queue the nightly review. It runs from 16:20 IST and retries at 16:40 if the bar archive is not ready. The end of day waits at most 5 s for the AgentDO to queue it, so main's daily summary is never held up; the cron asks again.
2. The review grades every decision on its 30-minute outcome and computes the Brier scores. The deep model then writes the review, and may propose a new guidance text. It judges the day by the guidance text the session's batches actually ran with. On a day with no decision in force and no trade, the review only grades and scores the day: it is SKIPPED with no model call and no candidate.
3. A candidate text is replayed on the day's stored candles with the current text and with the candidate, on identical inputs. The Brier scores compare only the calls that every run (the candidate, the current text replayed, and the live run) labelled HIT or MISS, and each run's own count is shown beside them, so a text cannot look better by answering NEUTRAL more often. The result is labelled **"in-sample, not proof"**: the reviewer has seen the day's outcomes. The candidate then waits as PENDING.
4. The operator approves or rejects it on the Agent page. Nothing is ever approved automatically. Approve and revert are refused during the session, and from the close until that day's review and replay finish (about 16:20–16:45 IST), so the review and the replay judge the text the session ran with: approve before 09:15 IST or after the replay. A candidate with nothing replayed cannot be approved. Reject is always allowed.
5. Only the guidance part of the instructions can change. Thresholds, sizes and limits stay in code.

## Ops routes

Each route is a POST with `Authorization: Bearer $ADMIN_TOKEN` to the engine Worker. Every `/ops/agent-*` route answers 409 ("the agent account is not enabled (ACCOUNTS)") when `ACCOUNTS` does not list `agent`, without calling either Durable Object.

| Route | What it does |
|---|---|
| `/ops/agent-status` | The AgentDO's mode, pause, next job, today's spend against the cap, last batch and active guidance version. |
| `/ops/agent-review?date=YYYY-MM-DD` | Queues a review (default today). Only outside the session; it answers 409 during it. On the session's own day it waits for 16:20. |
| `/ops/agent-count-tokens` | The API's token count of one snapshot, `count(snapshot) − count("{}")`, beside the local estimate. It counts the newest stored snapshot of each index and a synthetic worst case, so it runs before the first session too. Counting makes no model call. |
| `/ops/agent-revert` | Makes the built-in guidance active again. Not during the session, nor from the close until that day's review and replay finish. |
| `/ops/agent-pause?on=1` (and `on=0`) | Pauses or resumes the agent without a deploy. While it is paused only its code exits run (with the kill-switch and drawdown checks behind them), no candle is judged and the AgentDO accepts no bars. A batch already running places no further entry once the pause is set. Its risk still reaches the AgentDO once a minute. The pause stays until resumed. |

For example:

```
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<engine>/ops/agent-pause?on=1
```

Telegram `/status` (and `/ops/status`) shows the agent's lines: mode, pause, kill switch, drawdown halt, last bars, open positions, today's net P&L and anything waiting for the AgentDO. A last line comes from the AgentDO itself: its mode, pause, next job, today's spend against the cap and its last batch. TE waits at most 3 s for that line, and `/status` never fails because of it.

Agent alerts start with "🤖 Agent (paper experiment)". An entry names the model's call and the option bought, for example "on the model's Up call (bought a call)". An exit on the model's call names the contract and the reason in plain words, for example "the model asked to cut risk (filled)". The agent sends no copy-trade tickets, and the copy tickets for the `agent` account are refused. The Paper Engine page for it (`/?account=agent`) does not ask for them: its "What to do now" strip and "Today's trades" show a note that links to `/agent`.

## Rollout

1. **Deploy at the weekend** (Sat 17 or Sun 18 Oct 2026), outside market hours, with `AGENT_MODE="shadow"`.
2. **Call `/ops/status` before any other agent call.** TE then makes the first call to the AgentDO, and Cloudflare places a new Durable Object near its first caller, so the AgentDO lands near TE, which calls it several times a tick. Only after this call `/ops/agent-*` or open `/agent`. The reply shows the agent's lines and the AgentDO's line (the check that Telegram `/status` shows the agent works at the weekend, so it is done here).
3. **`/ops/agent-count-tokens`:** every counted snapshot is under 400 tokens and no estimate is below its count. If a snapshot counts 360 or more, tighten the estimator and the fields before Monday.
4. **`/ops/agent-status`:** mode `shadow`, `paused` false, `lastBatch` null or not `FAILED`, and `spentUsd` under `capUsd`.
5. **On Monday 19 Oct:**
   - after the first bar, `/ops/agent-count-tokens` again, now on stored snapshots;
   - `/agent` renders, and the account switcher lists "Agent";
   - if anything misbehaves during the session, `/ops/agent-pause?on=1` stops it without a deploy.
6. **Switch to paper after reviewing Monday's shadow session.** Tue 20 Oct is a market holiday, so the switch (one var and a deploy) lands before Wed 21 Oct. Monday's labels count in both modes, so shadow loses no information.

## What could be wrong

- **There may be no edge to find.** The design treats "no trades" as a result.
- **The calibrated probability is about the index's move, not the option trade.** Theta, the spread and the stop make the option trade's win rate lower than the probability.
- **Each nightly candidate is fitted to the day it was written on.** Approving often turns the agent into a curve-fit of recent sessions. The half weight for older guidance texts slows that, but only the operator's restraint and out-of-sample days stop it.
- **Paper fills flatter real trading.** The paper broker fills at quoted prices with modelled slippage.
- **Isolation in production is not replayable.** The agent shares D1 and the trading DO's CPU with main. Its quote budget, time budget and error counter are its own, it never reads main's market data source, and the replay tests prove main's logic is unchanged: `src/engine/agent/isolation.replay.test.ts`, and the end-to-end smoke test `workers/engine/src/agent/agentE2e.smoke.test.ts`, which runs the real runner against an in-process AgentBrain in shadow and paper mode and through the drawdown halt.
