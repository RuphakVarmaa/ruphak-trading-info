# Ruphak Trading Info: Event-Driven India Index Desk

Ruphak Trading Info reads global and Indian news, turns each story into a structured, time-decaying view on **NIFTY 50** and **SENSEX**, combines it with market signals, and generates **BUY CE / BUY PE** trades on weekly index options. It paper-trades by default. Live orders go through Groww, only after several explicit switches are turned on.

The original metals and geopolitics terminal is still on the page, below the new India Index Desk.

> **Read this first.** This is a research and trading tool, not investment advice. The authors are not SEBI-registered advisers. Buying options can lose the entire premium, and most intraday option buyers lose money after costs. Nothing here has a proven edge yet. Run it in paper mode, measure it, and decide for yourself. Live trading is off unless you deliberately enable it, and every live order is your responsibility.

## What "Jane Street style" means here

A retail desk cannot copy a market maker's co-location, latency or balance sheet. What it **can** copy is their process:

- **Structured judgement, not vibes.** Every story cluster is scored once by a language model against a fixed, versioned rubric. By default that is GLM-5.3 on Cloudflare Workers AI; Claude is a configuration switch away. The rubric asks for direction, magnitude bucket, confidence, horizon, half-life, affected sectors, novelty and how much is already priced in. Scores are enums, so they never carry false precision.
- **Several weak, different signals instead of one strong opinion.** Event pressure, intraday momentum, the opening gap against global cues, NIFTY/SENSEX/BANKNIFTY relative value and a global-beta residual are combined with shrinkage weights. A volatility regime filter decides how much agreement is needed.
- **Risk before return.** Every trade must pass the theta gate: the expected move over the holding period has to beat the option's implied move plus time decay plus round-trip costs. Positions are sized by fractional Kelly under hard caps, with daily and weekly loss limits, a kill switch and a forced 15:05 IST square-off.
- **One code path.** Backtest, paper and live run the same `runTradingCycle` and `runPositionCycle` with different injected data sources and brokers.
- **Measure every signal and turn off the ones that stop working.** Each signal source has its own measured edge, and decayed sources are disabled automatically.

## How it works

```
 Publisher RSS   ┐                                   ┌─ Yahoo 5m/daily (indices, VIX, crude, ES, DXY, USDINR, yields, Asia)
 Bing News RSS   ├─ IngestDO ─ normalize ─ dedupe ─ cluster ─┐   └─ Groww LTP (decision-time spot), option quotes with depth
 GNews, GDELT    ┘                                 │         │
                                                   ▼         ▼
                          Queue: events-to-score ─ GLM-5.3 on Workers AI or Claude (structured output, rubric) ─ lexicon fallback
                                                   │
                                   Event Pressure Index per index (decaying, coverage-saturated)
                                                   │
 TradingEngineDO (every 30 s in market hours) ─ features ─ regime ─ 6 signal components ─ conviction
                                                   │
                     gates (session, data age, events, liquidity, theta/edge, risk) ─ ATM weekly CE/PE ─ sizing
                                                   │
             PaperBroker (simulated fills on real quotes)  or  GrowwBroker ─ HMAC ─ static-IP relay ─ Groww
                                                   │
                        D1 (orders, fills, positions, ledger, performance) ─ EngineAdmin RPC ─ dashboard
```

### From news to a number

1. **Ingest** runs every 10 minutes around the clock, plus every 2 minutes on market days. It reads publisher RSS feeds (Economic Times, Business Standard, Mint, BusinessLine, NDTV Profit) and Bing News RSS searches. It also reads GNews when a key is set, and GDELT at most one request per 5.5 s because GDELT rate-limits per IP. The 2-minute cycles poll only the markets feeds and the first two searches. Google News RSS is still supported but switched off in the Worker, because it answers Cloudflare Workers with HTTP 503. Only market-relevant headlines are kept.
2. **Clustering** groups articles about the same story. It uses canonical URLs, normalized and stemmed titles, shingle Jaccard and entity overlap, and the model's story key for anything still left over. Pressure is computed per story, never per article: 50 articles about one RBI decision count as about 1.3 times 10 articles, not 5 times.
3. **Scoring.** The model scores up to 10 clusters per request and must return JSON that matches the score schema. The default is Z.ai GLM-5.3 (`@cf/zai-org/glm-5.3`) through the Worker's Workers AI binding, so no API key is needed inside Cloudflare. Answers are validated, and a bad answer gets one corrective retry. `LLM_PROVIDER=anthropic` switches to Claude with the `ANTHROPIC_API_KEY` secret. A daily token budget caps cost. Over budget, or when the model is unavailable, a keyword lexicon scores instead. Its scores are always low confidence and are tagged `fallback`.
4. **Event Pressure Index (EPI).** For each index, EPI = tanh(Σ numeric × coverage × 2^(−age/half-life)) over live stories. Here numeric = (0.7 × direction × magnitude × confidence + 0.3 × sector-weighted view) × novelty × priced-in × India relevance.

### From numbers to a trade

| Step | Default |
|---|---|
| Indicators (5-min bars) | RSI(14), ADX(14) with +DI/−DI, EMA 9/21, Supertrend(10, 3), Bollinger(20, 2) %B, VWAP and its σ bands, the 09:15–09:30 opening range (break size in ATRs, bars outside, failed breaks), daily EMA20/50 trend, previous-day high/low/close. Computed on the last ~120 closed bars, so they exist at the open. |
| Regime | EVENT if a high-impact scheduled event is within −15/+30 min, a fresh event's pressure is ≥ 0.5, or VIX is up ≥ 8%. HIGH_VOL if VIX ≥ 18 or realized/implied vol ≥ 1.5. TREND if the 60-min move is ≥ 0.35% with efficiency ≥ 0.6, or ADX ≥ 25 with the DI direction, 60-min return and VWAP side agreeing. Otherwise RANGE. |
| Signals and prior weights | EVENT 0.30 (news), ORB 0.15 (opening-range breakout ≥ 0.1 ATR with VWAP confirmation, fading out by 14:00; a failed break votes the other way), MOMENTUM 0.15 (15/60-min return z-scores and VWAP side), MEAN_REVERSION 0.15 (fade ≥ 1.5σ from VWAP when RSI ≤ 30/≥ 70 or %B outside the bands, only while ADX < 20), GAP 0.10, GLOBAL_BETA 0.05 (fades out by 11:45), RELATIVE_VALUE 0.05. TREND (EMA, Supertrend, DI agreement scaled by ADX) is computed and shown but has weight 0; see [Backtest](#backtest-julyoctober-2026). VOL_REGIME only modifies thresholds and size. |
| Conviction | tanh(1.5 × weighted mean of the signals that have a view). A signal with nothing to say abstains instead of voting 0, so it does not dilute the others. A score needs at least 0.30 of active weight: news on its own, or two signals, never one technical signal. Weights shrink from the priors toward each source's measured edge (30 pseudo-trades). In the EVENT regime only EVENT, GAP and TREND vote. |
| Thresholds | TREND 0.35, EVENT 0.45, HIGH_VOL 0.50, RANGE 0.55. Counter-trend trades need 0.60. |
| Theta gate | Edge = Δ × expected move − θ over the horizon − round-trip charges. Trade only if edge / premium ≥ 0.10 and the expected move ≥ 0.35 × the implied move. |
| Contract | ATM strike. Nearest weekly expiry unless it is today's: NIFTY on Tuesday, SENSEX on Thursday, holiday-shifted. Symbols always come from Groww's instrument master. |
| Entry window | 09:25 to 14:30 IST. No entries in the last 90 min of expiry day or 15 min before a high-impact event. |
| Sizing | 0.75% of capital at risk per trade, then 0.25 × Kelly after 20 trades, capped at 1%. Max 4% of capital in premium per trade, one position per index, 4 trades a day, no opposite NIFTY/SENSEX positions. |
| Exits, in priority order | Kill switch or loss cap, 15:05 square-off, stop −30%, target +50%, trailing stop (activates at +30%, gives back 50%), time stop, signal flip, and event invalidation when the story that drove the entry is re-scored neutral. Exits pause rather than fire on a nonsense price (a synthetic quote with no spot or VIX). |
| Risk | Daily loss cap 3%, weekly 6%, halt after 2 consecutive losses, 30-min cooldown after a stop-out. |
| Costs | Groww schedule from 1 Apr 2026: ₹20 per order, STT 0.15% on sells, NSE 0.03503% or BSE 0.0325%, SEBI fee, stamp duty 0.003% on buys, IPFT and 18% GST. One NIFTY lot at ₹150 costs about ₹28 to buy and ₹42 to sell. |

Every decision is stored with all its gate results and indicator readings, so the dashboard can always explain why it did or did not trade. The Indian F&O rules this depends on (expiry days, lot sizes, holidays, charges, SEBI's algo framework) are in [docs/FNO.md](docs/FNO.md).

## Safety: paper by default, four keys for live

A live order needs **all** of the following:

1. `LIVE_TRADING="true"` on the engine Worker. This is a deploy-time variable and defaults to `"false"`.
2. Engine mode **LIVE**, set from the dashboard by typing `LIVE` to confirm.
3. **ARM** from the dashboard. Arming lasts until 15:30 IST that day and requires a healthy relay.
4. `RELAY_LIVE=true` on the order relay.

If any key is missing, orders go to the **PaperBroker**, which simulates fills on real quotes with depth walking, slippage and real charges. Further protections:

- The **kill switch** works from the dashboard or Telegram `/kill`. It also trips on the daily loss cap and on two reconciliation mismatches in a row. It cancels and market-exits everything, and for live positions it also asks the relay to cancel all orders and square off.
- Caps are enforced twice, in the engine and again in the relay, which refuses shorts, oversized lots, non-MIS products and orders outside its trading window.
- Orders are idempotent. Groww's `order_reference_id` is the engine's ref id, and an ambiguous outcome is looked up by reference, never resent.
- If 5 ticks fail in a row, the engine goes DEGRADED and only manages exits.
- The dashboard's read routes are public by default: anyone with the URL can see positions and P&L. Admin routes need the admin token. Put the dashboard behind **Cloudflare Access** (Zero Trust, a self-hosted application on its hostname) if it should be private.

## Repository layout

```
src/engine/            pure TypeScript engine: runs in Workers, Node scripts and tests
  types.ts config.ts clock.ts calendar/ settings.ts ports.ts api-types.ts
  events/              lexicon, geo, normalize, cluster, taxonomy, LLM rubric/schema/digest/scorer, pressure, sources
  market/              Yahoo client, candles, indicators, cross-asset moves, features, live and replay data sources
  pricing/             Black-Scholes, trading-time to expiry, synthetic option quotes
  instruments/         Groww instrument.csv parser and resolver, synthetic rows for expired contracts
  strategy/            regime, signals, conviction, gates, option selection, sizing, exits, planner
  broker/              charges, fill model, PaperBroker, groww/ (TOTP, HTTP, data, relay client, live broker)
  risk/ evaluation/    loss limits, per-signal performance and decay, outcome grading, scorer evaluation
  pipeline/            ingest, scoring, trading, position and end-of-day cycles
  backtest/            day-by-day replay, metrics, walk-forward, Yahoo history loader
  api/readModel.ts     repository state -> dashboard DTOs
workers/engine/        engine Worker: TradingEngineDO, IngestDO, BacktestDO, crons, queue consumer, EngineAdmin RPC, D1 repository
migrations/            D1 schema (drizzle-kit)
relay/                 static-IP order relay (Node 22 + Hono), see relay/README.md
scripts/               backtest, fetch-history, bootstrap-events, score-batch, trigger-cron
src/app, src/components, src/lib, src/hooks   Next.js dashboard (India Index Desk, blotter, /backtest, /events)
docs/RESEARCH.md       survey of public algo-trading projects, the Groww wire contract, charges and pitfalls
```

## Local development

Requirements: Node 22 and npm. No Cloudflare account is needed locally.

```bash
npm install
cp .env.example .env.local        # ENGINE_MOCK=1: the desk runs on built-in simulated data
npm run dev                       # http://localhost:3000
```

To run the real engine locally (Wrangler simulates D1, KV, Queues and Durable Objects):

```bash
cp .dev.vars.example workers/engine/.dev.vars   # ADMIN_TOKEN=dev; every other key is optional
npm run db:migrate:local
npm run dev:engine                               # http://localhost:8787

curl -X POST -H "Authorization: Bearer dev" localhost:8787/ops/ingest   # fetch, cluster, queue for scoring
curl -X POST -H "Authorization: Bearer dev" localhost:8787/ops/tick     # one trading-loop tick
curl -X POST -H "Authorization: Bearer dev" localhost:8787/ops/status
npm run cron:local -- "* 3-10 * * MON-FRI"                              # fire a cron by expression
```

Then set `ENGINE_MOCK=0` in `.env.local` and restart `npm run dev`. The dashboard then reads the local engine through its `ENGINE` service binding. Other ops endpoints are `/ops/token`, `/ops/instruments`, `/ops/premarket` and `/ops/eod`.

Without keys the engine still runs end to end. It paper-trades on synthetic option quotes priced from India VIX, and `npm run dev:engine` scores news with the lexicon fallback. The Workers AI binding only runs remotely, so to score with GLM-5.3 locally, log in with `npx wrangler login` and use `npm run dev:engine:ai`, which bills your Cloudflare account.

Checks (CI runs the same ones):

```bash
npm run typecheck && npm run lint && npm test && npm run build
cd relay && npm ci && npm run typecheck && npm test
```

## Deploying on Cloudflare

Both Workers fit the Workers Paid plan's included usage. See [Costs](#costs). Workers Paid is required: the engine uses Queues, a 60-second CPU limit and Workers AI.

**One command for paper trading.** With Wrangler logged in, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set, run:

```bash
export ENGINE_ADMIN_TOKEN="$(openssl rand -hex 24)"   # keep a copy: the dashboard's Admin button asks for it
npm run deploy:paper                                   # add -- --dry-run to see the steps first
```

It creates the resources and fills in their IDs, migrates D1, deploys the engine, sets its secrets from `ENGINE_`-prefixed variables, deploys the dashboard, and checks that the dashboard reads the engine. Optional variables: `ENGINE_GNEWS_API_KEY`, `ENGINE_TELEGRAM_BOT_TOKEN`, `ENGINE_TELEGRAM_CHAT_ID`, `ENGINE_GROWW_API_KEY`, `ENGINE_GROWW_TOTP_SECRET`. The API token needs these account permissions: Workers Scripts Edit, Workers KV Storage Edit, D1 Edit, Queues Edit, Workers AI Edit and Account Settings Read. It also needs the user permissions User Details Read and Memberships Read. The steps below do the same thing by hand.

1. Create the resources. From a machine where Wrangler is logged in (`npx wrangler login`), run:

   ```bash
   npm run cf:setup              # add -- --preview for the preview environment
   ```

   It creates the D1 database, the KV namespaces and the queues, reusing any that exist. It then writes their IDs into `workers/engine/wrangler.jsonc` and the dashboard's `wrangler.jsonc`. Commit both files; the IDs are not secrets. R2 is not required. To keep dated copies of instrument masters and backtest results, add the optional `R2` binding described in `workers/engine/wrangler.jsonc`. The script also accepts `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead of a login.

2. Set the engine secrets. Only `ADMIN_TOKEN` is required for paper trading.

   ```bash
   for s in ADMIN_TOKEN GNEWS_API_KEY GROWW_API_KEY GROWW_TOTP_SECRET TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID TELEGRAM_WEBHOOK_SECRET; do
     npx wrangler secret put $s --config workers/engine/wrangler.jsonc
   done
   npx wrangler secret put ADMIN_TOKEN    # dashboard Worker, same value
   ```

3. Migrate and deploy. The engine goes first, because the dashboard's service binding points at it.

   ```bash
   npm run db:migrate:remote
   npm run deploy:engine
   npm run deploy:dashboard
   ```

4. To deploy from CI, create an API token at dash.cloudflare.com/profile/api-tokens. Start from the "Edit Cloudflare Workers" template and add D1 Edit, Queues Edit and Workers AI Edit. Add it to the GitHub repository as the Actions secret `CLOUDFLARE_API_TOKEN`, with your account ID as `CLOUDFLARE_ACCOUNT_ID`. Pushes to `main` then migrate D1 and deploy both Workers after the checks pass.

`npm run deploy:engine:preview` deploys a separate preview environment with its own resources and a single 30-minute cron.

### Cron schedule (UTC; IST = UTC + 5:30)

| IST | Cron | Job |
|---|---|---|
| every 10 min, 24×7 | `*/10 * * * *` | News ingest |
| every 2 min, 08:31–16:29 on trading days | `1-59/2 3-10 * * MON-FRI` | Extra ingest during market hours |
| every minute, 08:30–16:29 on trading days | `* 3-10 * * MON-FRI` | Re-arms a missing alarm and alerts on a stale heartbeat |
| 08:00 | `30 2 * * MON-FRI` | Groww token (tokens expire at 06:00) |
| 08:10 | `40 2 * * MON-FRI` | Instrument master: Groww `instrument.csv` to KV (and the optional R2 archive) |
| 08:30 | `0 3 * * MON-FRI` | Pre-market ingest, market snapshot, relay health |
| 16:00 | `30 10 * * MON-FRI` | End of day: grade decisions, update signal performance, Telegram summary |
| 20:00 | `30 14 * * *` | Prune old D1 rows |

## Going live with Groww (only after the go/no-go below)

1. Subscribe to the **Groww Trade API** (₹499 + GST a month). Create an API key of type **TOTP** and keep its TOTP secret. The relay's research found that the docs may also require a daily approval for TOTP keys. If so, approve it before 08:00. The 08:00 job alerts on failure.
2. Set `GROWW_API_KEY` and `GROWW_TOTP_SECRET` on the engine. The engine then uses Groww's LTP for decision-time spot and real option quotes with depth. Paper fills use these real quotes.
3. Deploy the **order relay** on a machine with a static IP (a Mumbai VPS, about ₹300–800 a month). Whitelist that IP on Groww, and put the relay behind a Cloudflare Tunnel with an Access service token. Follow [`relay/README.md`](relay/README.md) step by step. Set `RELAY_URL`, `RELAY_HMAC_SECRET` (at least 32 characters), `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` on the engine.
4. Run the relay with `RELAY_LIVE=false` (shadow mode) for at least a week while paper trading. Then follow its verification checklist.
5. Redeploy the engine with `LIVE_TRADING="true"`. In the dashboard switch the mode to LIVE, ARM it, and start at 1 lot with caps at their minimum.

### Telegram

Create a bot with @BotFather and set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Alerts cover entries, exits, kill trips, DEGRADED state, stale heartbeats, token and instrument failures, LLM budget exhaustion and the daily summary.

The `/status`, `/kill [reason]` and `/disarm` commands need a public URL for the engine. Either set `workers_dev: true` or add a route in `workers/engine/wrangler.jsonc`, set `TELEGRAM_WEBHOOK_SECRET`, then register the webhook:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<engine-host>/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Only the configured chat id is obeyed.

## Research workflow

```bash
npm run backtest -- --from 2026-08-10 --to 2026-10-07              # Yahoo keeps ~60 days of 5-minute bars
npm run backtest -- --from 2026-08-10 --to 2026-10-07 --placebo    # + no-events and shuffled-event-time baselines
npm run backtest -- --from 2026-01-01 --to 2026-10-07 --walk-forward   # out-of-sample folds (slow)

npm run fetch-history -- --from 2024-01-01 --to 2026-10-07          # Groww 5-minute index history (needs Groww keys)
npm run bootstrap-events -- --from 2026-07-01 --to 2026-10-07       # GDELT crawl -> clusters (resumable, hours)
npm run score-batch -- --dry-run                                     # request count and token estimate
npm run score-batch -- --provider workers-ai                        # GLM-5.3 on Workers AI (needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN)
npm run score-batch -- --submit && npm run score-batch -- --collect --wait   # or the Claude Batches API (50% price)
npm run score-batch -- --lexicon                                     # free baseline
npm run eval:scorer                                                  # live scorer vs the labelled seed set (costs credits; LLM_PROVIDER picks the model)
```

Reports are written to `reports/` and caches to `.cache/`; both are gitignored. The dashboard's **/backtest** page runs the same engine in a Durable Object, a few days per alarm, on Yahoo history.

### Backtest, July–October 2026

All runs: both indices, no scored news (the event layer is off), synthetic option prices, decisions every 5 minutes on closed bars with a 90 s data lag, Groww charges. Yahoo keeps about 60 days of 5-minute bars, so the window is 23 July – 7 October 2026 (53 sessions).

| Run | Trades | Hit rate | Per trade (% of premium) | Net | Profit factor | Max drawdown |
|---|---|---|---|---|---|---|
| Old strategy (before the ensemble), 1 Sep – 7 Oct | 1 | 0% | — | −₹2,456 | — | — |
| Ensemble with TREND voting, 24 Aug – 7 Oct (31 sessions) | 65 | 25% | −9.5% | −₹50,666 | 0.22 | 10.5% |
| Shipped defaults, full window (53 sessions) | 45 | 31% | −3.9% | −₹14,943 | 0.65 | 3.1% |
| Walk-forward, out of sample only (4 folds, 20 Aug – 7 Oct) | 54 | 33% | −5.4% | −₹25,149 | 0.39 | 5.1% |

What this says:

- **No edge has been demonstrated.** The best in-sample settings are about break-even after theta, spread and charges; out of sample they lose. Forward paper trading decides what happens next, and the go/no-go below is unchanged.
- **Trend following lost money in this period.** Entering after a trend shows up on 5-minute bars (EMA 9/21, Supertrend, ADX) gave 32 trades with a 19% hit rate (t ≈ −2.7). Entries were followed by reversals: NIFTY and SENSEX mostly mean-reverted intraday. TREND therefore has weight 0; it is still computed, shown and used by the regime classifier, and the walk-forward kept it off in 3 of 4 folds.
- **Breakouts were mixed.** ORB lost in the full window (2 wins in 17 trades) but the walk-forward kept it in every fold. MOMENTUM was closer to flat (43% hit rate, −2% per trade). Mean reversion rarely fires under its strict conditions.
- **Exits matter.** Signal-flip exits cut many trades that would have recovered within the hour. They remain on, because removing them made results worse.
- The walk-forward chose gain 1.5 in every fold and split between minimum edge 0.10 and 0.15. The shipped defaults are those majority choices.

Reproduce with `npm run backtest -- --from 2026-07-23 --to 2026-10-07 --no-events` (and `--walk-forward --train-days 28 --test-days 14`; the walk-forward grid is in `src/engine/backtest/walkForward.ts`).

### The ₹10,000 account

A second paper book, `small10k` (`src/engine/accounts.ts`), follows the main account's signals at the same moments.

- **What it trades:** one lot (65) of the NIFTY option nearest the money whose premium is ₹40–70, so ₹2,600–4,550 a lot.
- **Its own limits:**
  - risk 15% of equity per trade, sized from current equity and free cash;
  - one position at a time, 3 entries a day;
  - stop −35%, target +60%;
  - daily loss cap 25%, weekly loss cap 40%;
  - a check that one more stop-out cannot break the daily cap.
- **Paper only.** Its book sits in the same tables under the stored mode `PAPER@small10k`; it does not grade decisions or update signal performance (main does).
- **Why single options, not spreads:** a NIFTY debit spread costs only about ₹3,000 of premium, but the sold leg carries about ₹30–34k of exposure margin. A real ₹10k account could not place one.

Backtest, NIFTY only, no news, 23 Jul – 8 Oct 2026 (54 sessions), main at default settings:

| Run | Trades | Hit rate | Net | Max drawdown |
|---|---|---|---|---|
| ₹40–70 band, stop −35% / target +60% | 18 | 33% | −₹4,620 | ₹5,272 (49%) |
| ₹60–100 band, same exits | 6 | 17% | −₹2,501 | ₹3,318 (31%) |
| ₹40–70 band, walk-forward on exits, out of sample only (4 folds) | 25 | 44% | +₹349 | 36% |
| ₹60–100 band, walk-forward on exits, out of sample only | 13 | 15% | −₹2,934 | 58% |

- **No edge.** The out-of-sample walk-forward for ₹40–70 lost in three of four folds (−₹865, −₹1,334, −₹1,393). The fourth fold (1–8 Oct, a strong down-trend week) made +₹3,941 and pulled the total to break-even.
- **No stable exit settings.** The chosen stop and target changed in every fold (stop −30% to −50%, target 50% or 80%), so the account keeps −35% / +60%. The time-stop floor of 10% was chosen in every fold and is the default already.
- **Small accounts swing hard.** One stop costs ₹1,000–1,600 (10–16% of the account); drawdowns of 35–50% happened inside two months.

Reproduce with `npm run backtest -- --from 2026-07-23 --to 2026-10-08 --index NIFTY --no-events --account small10k` (add `--band 60-100`, `--stop`, `--target`, or `--walk-forward --train-days 28 --test-days 14`). In the dashboard, pick "₹10k" in the backtest form's Account field. Enable it on the engine with `ACCOUNTS="main,small10k"`, then use `/live?account=small10k`.

**Paper to live go/no-go:**

- Out-of-sample Sharpe ≥ 0.8 with at least 60 out-of-sample trades.
- Profit factor ≥ 1.3 after costs.
- The shuffled-events placebo is close to zero.
- The scorer evaluation passes.
- **At least 6 weeks of forward paper trading** that agrees with the backtest.

## Limitations

- **Backtest option prices are synthetic.** They use Black-Scholes on India VIX with a modelled spread. Real Groww option candles are not wired into the replay yet, and every report says so.
- Backtests decide on closed 5-minute bars with a 90 s data lag, and they check exits at the same cadence. Stops can therefore fill beyond −30%.
- **Hindsight leakage.** A model scoring 2026 headlines may know what happened next, so backtested event edge is optimistic. Forward paper trading is the real test.
- The labelled scorer set (`src/engine/evaluation/eval/headlines.json`) is a 39-story seed set labelled by economic logic, not by observed returns. Grow it to 200–300 stories with next-day returns before trusting it.
- Yahoo data is unofficial and delayed by about 1–2 minutes (CME futures by about 10 minutes). GDELT often rate-limits shared cloud IPs, so it is best-effort only.
- Groww details that are still unverified are listed in `relay/README.md` (Groww assumptions) and in `docs/RESEARCH.md`. They include IP restrictions on read endpoints, the MIS square-off time and fee, and the token expiry format.
- The 2026 NSE/BSE holiday list is in `src/engine/calendar/holidays.json`. Check it against exchange circulars every year; the dashboard can add overrides.

## Costs

| Item | Estimate |
|---|---|
| Cloudflare (Workers Paid, Durable Objects, D1, KV, Queues) | about $5 a month, mostly within included usage |
| News scoring, GLM-5.3 on Workers AI | $1.40 per million input tokens and $4.40 per million output tokens, billed to the Cloudflare account. The default daily caps limit spend to about $8.60 a day; reasoning tokens count as output. |
| News scoring with Claude (optional) | Roughly $200–280 a month on Opus 5.5 at about 200 calls a day; set `LLM_PROVIDER=anthropic`. |
| Groww Trade API | ₹499 + GST a month (live data and live trading) |
| Relay VPS | ₹300–800 a month (live only) |
| Yahoo, publisher RSS, Bing News, Google News, GDELT, Telegram | free |

## Configuration reference

Engine Worker variables (`workers/engine/wrangler.jsonc`):

| Variable | Default | Meaning |
|---|---|---|
| `LIVE_TRADING` | `"false"` | First key for live orders |
| `GROWW_DATA_VIA_RELAY` | `"false"` | Route Groww data calls through the relay if Cloudflare egress is blocked |
| `LLM_PROVIDER` | `workers-ai` | News scorer: `workers-ai` (AI binding) or `anthropic` (needs the `ANTHROPIC_API_KEY` secret) |
| `LLM_MODEL`, `LLM_EFFORT` | `@cf/zai-org/glm-5.3`, `low` | Scorer model and reasoning effort (low, medium or high; GLM maps them to low, high and max) |
| `LLM_DAILY_INPUT_TOKEN_BUDGET`, `LLM_DAILY_OUTPUT_TOKEN_BUDGET` | 3,000,000 / 1,000,000 | Daily cap. The lexicon scores once the cap is reached. |
| `CAPITAL_INR` | 500000 | Capital used for sizing and loss caps |
| `INDICES` | `NIFTY` | Indices to trade, comma-separated (`NIFTY,SENSEX` trades both; they share the daily limits). Unset or invalid means both. |
| `MAX_TRADES_PER_DAY` | `8` | Most entries per day across the indices (1 to 12). The stored daily order cap (`maxOrdersPerDay`, 2 orders per trade plus reserve) must be raised with it. The loss-streak halt and daily loss cap still apply. Unset or invalid means 4. |
| `MAX_OPEN_PER_INDEX` | `2` | Most positions open at once on one index (1 to 3). They share the 4-entries-a-day and loss limits. Unset or invalid means 1. |
| `ACCOUNTS` | `main` | Paper accounts to run, comma-separated; main is always on. `main,small10k` adds the ₹10,000 account above, which follows main's signals with its own pinned settings (the variables above do not apply to it). Telegram `/kill` stops every account. |

Secrets: see `.dev.vars.example`. Every strategy parameter lives in `src/engine/config.ts`, and backtests and live trading read the same values.
