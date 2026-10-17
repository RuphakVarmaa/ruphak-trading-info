# Research: what we can reuse from public algo-trading projects

Compiled 2026-10-07 for the NIFTY/SENSEX event-driven options engine (Groww Trade API, Cloudflare Workers).
Facts were read from the linked sources on that date. Anything we could not open first-hand is marked
**not verified**. Licence rule: we copy code only from MIT, Apache-2.0, BSD or ISC sources, with attribution.
AGPL, GPL, unlicensed and commercial sources are used for ideas only.

## 1. Summary: what we adopt

1. **Our own thin `fetch` client for Groww, no SDK.** The Node SDK `growwapi` (Apache-2.0) imports `fs`, `os`, `path` and `crypto`, so it cannot run in Workers. OpenAlgo is AGPL-3.0. Section 2 has the confirmed wire contract.
2. **Order enums are plain strings on the wire**, e.g. `"NSE"`, `"FNO"`, `"MIS"`, `"LIMIT"`, `"BUY"`, `"DAY"`. Python SDK constants such as `GrowwAPI.SEGMENT_FNO` are aliases whose value is `"FNO"`. Stop orders are `"SL"` and `"SL_M"`.
3. **Idempotent orders through `order_reference_id`.** It must be 8–20 alphanumeric characters with at most two hyphens. Re-sending the same id returns `GA007 Duplicate order reference id`. Derive the id from our order-intent id, then reconcile with `GET /order/status/reference/{ref}?segment=FNO`.
4. **Instrument master: stream and filter the CSV in the Worker.** The file is over 10 MB. Read `trading_symbol`, `lot_size`, `tick_size`, `freeze_quantity` and `expiry_date` from it. Never build symbols by hand, because weekly and monthly formats differ.
5. **Backtests use Groww's backtesting endpoints first.** `/historical/expiries`, `/historical/contracts` and `/historical/candles` cover expired option contracts back to 2020. The Black-Scholes synthetic price is a fallback only, and every fill records its price source (`real` or `synthetic`).
6. **TOTP in about 30 lines of WebCrypto**: HMAC-SHA1, 6 digits, 30 s period, base32 secret. These match the Node SDK's `otpauth` call and pyotp's defaults. Test against the RFC 6238 vectors.
7. **Our own options math.** Write Black-Scholes price and greeks, plus implied volatility via Newton with a bisection fallback. The small MIT npm packages have weak numerics. `@fullstackcraftllc/floe` needs a commercial licence for business use.
8. **Our own charges calculator**, using Groww's published F&O option rates and the fixed fees in section 6.
9. **Keep our decaying Event Pressure Index (EPI)** and add Vibe-Trading's guard-rails: sum then clip, a minimum-score floor, timestamps from when we first saw the item, and deduplication across sources.
10. **Evaluate the LLM signal TradingAgents-style.** Log every decision and score it once its horizon has passed. Score only news published after the model's training cutoff (see Glasserman & Lin and Look-Ahead-Bench).
11. **Conservative paper fills**, an idea from OpenAlgo's sandbox. Buy at the offer and sell at the bid from `/live-data/quote`. A LIMIT order fills only when LTP crosses the limit. Hold off when a quote looks stale.
12. **One Durable Object alarm that runs a stored schedule**, as in the Cloudflare docs and the Agents SDK. Handlers must be idempotent because alarms run at least once.
13. **Our own holiday and special-session JSON, plus the live expiry list from Groww.** A community calendar missed the ad-hoc holiday on 15 Jan 2026.

## 2. Groww Trade API: confirmed wire contract

Source keys: **G** = official cURL docs, **P** = Python SDK docs, **O** = OpenAlgo `broker/groww` (AGPL), **N** = `NithinSGowda/growwapi` (Apache-2.0).

| Topic | What the sources confirm | vs. our assumption |
|---|---|---|
| Base and headers | Base `https://api.groww.in/v1`. Headers `Authorization: Bearer <token>`, `Accept: application/json`, `X-API-VERSION: 1.0` (G). N and O's order calls omit the version header. O sends `x-api-version: 1.0` on the socket-token call. | Matches. Keep sending the header. |
| Token (TOTP flow) | `POST /token/api/access` with `Authorization: Bearer <API key>`, `Content-Type: application/json` and body `{"key_type":"totp","totp":"123456"}` (G). The key is called the "TOTP token" in P. N sends only `{totp}`. | Matches. Keep `key_type`. |
| Token (approval flow) | Body `{"key_type":"approval","checksum":sha256hex(secret+timestamp),"timestamp":"<epoch s>"}`. Needs daily approval in the app. O uses this flow. | Not used. |
| Token response | **Not wrapped** in `status`/`payload`. Top level is `{"token","tokenRefId","sessionName","expiry","isActive"}` (G; O and N read top-level `token`). Access tokens expire daily at 06:00 (G). | **Different envelope from other endpoints.** |
| Other responses | Success: `{"status":"SUCCESS","payload":{...}}`. Failure (HTTP 4xx/5xx): `{"status":"FAILURE","error":{"code","message","metadata"}}`. Codes: GA000 internal, GA001 bad request, GA003 unable to serve, GA004 not found, GA005 not authorised, GA006 cannot process, GA007 duplicate order reference id (G). | Add error mapping. |
| Rate limits | Auth 5/s and 30/min, plus 150 token calls per 24 h. Orders 10/s and 250/min. Live data 10/s and 300/min. Non-trading 20/s and 500/min. Limits apply per category (G, P). | Add a limiter per category. |
| Enums | exchange `NSE`/`BSE`; segment `CASH`/`FNO`; product `CNC`/`MIS`/`NRML`; order_type `LIMIT`/`MARKET`/`SL`/`SL_M`; transaction `BUY`/`SELL`; validity `DAY` (G annexure, P constants, N TypeScript enums). O uses `STOP_LOSS_LIMIT`/`STOP_LOSS_MARKET` and `IOC`, which do not appear in the official docs. | Matches. Do not copy O's stop names. |
| Order status | `NEW`, `ACKED`, `TRIGGER_PENDING`, `APPROVED`, `REJECTED`, `FAILED`, `EXECUTED`, `DELIVERY_AWAITED`, `CANCELLED`, `CANCELLATION_REQUESTED`, `MODIFICATION_REQUESTED`, `COMPLETED`. The doc's create and status examples also return `OPEN`, which is not in the enum. | Treat unknown statuses as non-terminal. |
| Create order | `POST /order/create`. Fields: trading_symbol, quantity, price, trigger_price, validity, exchange, segment, product, order_type, transaction_type, order_reference_id. Payload returns groww_order_id, order_status, order_reference_id, remark. O sends `price` only for LIMIT/SL and `trigger_price` only for SL/SL_M. | Matches. Omit price fields an order type does not use. |
| Status and detail | `GET /order/status/{id}`, `/order/status/reference/{ref}`, `/order/detail/{id}`, `/order/trades/{id}`, `/order/list`. A `segment` query parameter is required. Paging: `page`, `page_size` (up to 100 for lists, 50 for trades). Detail returns filled_quantity, remaining_quantity, average_fill_price, exchange_time and created_at. Modify: `POST /order/modify` with `{groww_order_id, segment, quantity, price, trigger_price, order_type}`. Cancel: `POST /order/cancel` with `{groww_order_id, segment}`. | Matches. |
| LTP, OHLC, quote | `GET /live-data/ltp?segment=CASH&exchange_symbols=NSE_NIFTY,BSE_SENSEX` returns `payload: {"NSE_NIFTY": 25641.7}` in rupees. Up to 50 symbols per call, one `segment` per call. Options need a separate `segment=FNO` call with `NSE_<trading_symbol>`. `/live-data/quote?exchange&segment&trading_symbol` adds `bid_price`, `offer_price`, `depth` and `open_interest`. | Matches. Split calls by segment. |
| Option chain | `GET /option-chain/exchange/{NSE or BSE}/underlying/{NIFTY or SENSEX}?expiry_date=YYYY-MM-DD` returns `underlying_ltp` and `strikes["23400"].CE/PE = {trading_symbol, ltp, open_interest, volume, greeks{delta,gamma,theta,vega,rho,iv}}`. `iv` is in percent (e.g. 25.34). Per-contract greeks: `/live-data/greeks/exchange/{ex}/underlying/{u}/trading_symbol/{sym}/expiry/{date}`. Added 2025-11-24. | Matches. |
| Historical candles | `GET /historical/candles?exchange&segment&groww_symbol&start_time&end_time&candle_interval`. Interval values like `5minute`. Times as `yyyy-MM-dd HH:mm:ss` or epoch seconds. Each candle is `[ts,o,h,l,c,v,oi]`; ts looks like `"2025-09-24T10:30:00"` with no offset; oi is null for cash. Max span per call: 30 days for 1–5 min, 90 days for 10–30 min, 180 days for 1 h and above. Data from 2020. Old `/historical/candle/range` (epoch-second candles) is deprecated, but O still calls it. | Matches. **Parse naive timestamps as IST (+05:30).** In Workers, `Date.parse` treats them as UTC. |
| Expiries and contracts | `/historical/expiries?exchange&underlying_symbol&year&month` returns `{"expiries":["2024-01-25",...]}`. `/historical/contracts?exchange&underlying_symbol&expiry_date` returns `{"contracts":["NSE-NIFTY-02Jan25-28500-PE",...]}`, including expired contracts. | Use these as the backtest calendar. |
| Symbols | groww_symbol examples: `NSE-NIFTY`, `BSE-SENSEX`, `NSE-NIFTY-30Sep25-24650-CE`, `BSE-SENSEX-25Sep25-FUT`. trading_symbol (orders and LTP): weekly `NIFTY25N1823400CE` and `NIFTY25O1425100CE` (YY + month code + DD + strike), monthly `NIFTY25OCT24000CE`. SENSEX option formats: **not verified**. | Look symbols up; never build them. |
| Instruments CSV | `https://growwapi-assets.groww.in/instruments/instrument.csv`. Columns: exchange, exchange_token, trading_symbol, groww_symbol, name, instrument_type (EQ, IDX, FUT, CE, PE), segment, series, isin, underlying_symbol, underlying_exchange_token, expiry_date, strike_price, lot_size, tick_size, freeze_quantity, is_reserved, buy_allowed, sell_allowed. Over 10 MB (our fetch hit a 10 MB cap). O does not scale strikes and defaults tick size to 0.05. Exact expiry_date format: **not verified**; parse defensively. | Matches. Stream it. |
| Margin, positions, user | `GET /margins/detail/user` (includes `option_buy_balance_available`). `POST /margins/detail/orders?segment=` takes an array body. `GET /positions/user` and `/positions/trading-symbol?trading_symbol&segment` return `quantity`, `net_price` and `realised_pnl`. `GET /user/detail` returns `active_segments`, `nse_enabled` and `bse_enabled`. | Use for pre-trade checks. |
| Smart orders (OCO) | `POST /order-advance/create` with `{reference_id, smart_order_type:"OCO", segment:"FNO", trading_symbol, quantity, net_position_quantity, transaction_type:"SELL", target:{trigger_price,order_type:"LIMIT",price}, stop_loss:{trigger_price,order_type:"SL_M",price:null}, product_type:"NRML", exchange, duration:"DAY"}`. **F&O OCO supports NRML only.** `reference_id` follows the same 8–20 character rule. | Optional broker-side exit if the Worker dies. Needs NRML entries. |
| Live feed | NATS over `wss://socket-api.groww.in`. Credentials: `POST /v1/api/apex/v1/socket/token/create/` with `{"socketKey": <nkey public key>}` returns `{token, subscriptionId}`. The server nonce is signed with an Ed25519 nkey. Subjects: `/ld/indices/{nse or bse}/price.{token}`, `/ld/fo/{ex}/price.{token}`, `.../book.{token}`. Protobuf payloads (O, N). | Later. Workers support Ed25519 in WebCrypto; we have not tried it. |
| Static IP and SEBI | Groww lets you register a primary and a secondary static IP at groww.in/trade-api/api-keys. NSE/SEBI rules: orders only from a whitelisted IP; IP changes at most once a week; algos above 10 orders/s per exchange must be registered; API sessions must end before the next trading day; daily 2FA; market orders are converted to MPP (market price protection). | Matches our relay plan. Use LIMIT orders. |

Fixed costs (groww.in pricing): API access is ₹499/month. Auto square-off of an MIS position costs ₹50 per position. The square-off time is 15:10–15:15 according to third parties (**not verified**); OpenAlgo's sandbox uses 15:15.

## 3. Indian broker and data projects

- **OpenAlgo** ([marketcalls/openalgo](https://github.com/marketcalls/openalgo), AGPL-3.0, ~2.8k★). Ideas only.
  - Its Groww module uses the approval auth flow with `SHA256(secret + epochSeconds)`. It does not use TOTP.
  - Master-contract mapping: NSE+FNO becomes `NFO`, BSE+FNO becomes `BFO`, index rows become `NSE_INDEX`/`BSE_INDEX`. OpenAlgo's own option symbol is base + DDMMMYY + strike + CE/PE, e.g. `NIFTY28OCT2525100CE`.
  - History is fetched in chunks (1 m: 3 days, 5–10 m: 7 days).
  - Platform behaviours worth copying as ideas:
    - Analyzer mode: separate sandbox database and capital.
    - Action Center: a manual-approval order queue, useful for the first live weeks.
    - Sandbox fill rules: MARKET buys at the ask and sells at the bid. LIMIT orders fill at the limit price when LTP crosses it. Fills are deferred while LTP sits outside the day's [low, high], zero LTP is skipped, and quotes are polled every 5 s.
    - MIS square-off at 15:15.
- **growwapi for Node** ([NithinSGowda/growwapi](https://github.com/NithinSGowda/growwapi), Apache-2.0, v1.1.3, last published 2025-07-30). Skip as a dependency: its file cache uses Node built-ins, and its runtime deps include lodash, nats, protobufjs and even jest. It still confirms the TOTP parameters, enums, endpoint paths and socket-token path. Small snippets may be ported with attribution and a NOTICE.
- **growwapi for Python** (Groww, MIT according to [PyPI](https://pypi.org/project/growwapi/), v1.5.0, 2025-12-06). There is no public repo, and we did not browse the source (**not verified**). We used the docs instead.
- **NSE data libraries**: [jugaad-data](https://github.com/jugaad-py/jugaad-data) (informal public-domain "YOLO" licence), [nsepython](https://github.com/aeron7/nsepython) (licence **not verified**) and [OpenChart](https://github.com/marketcalls/openchart) (MIT, uses NSE's charting API). All of them scrape nseindia.com, so they suit one-off research downloads, not Workers. The NSE holiday endpoint they use is `https://www.nseindia.com/api/holiday-master?type=trading`, keyed by `CM`/`FO` with a `tradingDate` field. It reportedly needs browser-like headers (**not verified**).
- **Indian options backtesters** (both MIT and small). Treat their numbers as priors, not validated results.
  - [shivam61/nifty-options-backtester](https://github.com/shivam61/nifty-options-backtester):
    - VIX regimes: LOW below 15, HIGH 15–18, CRASH at 22 and above, hard cap 25.
    - Labels each price `[LIVE]` or `[BS*]` (synthetic).
    - Uses walk-forward validation.
  - [aaryansinha16/AI-trader](https://github.com/aaryansinha16/AI-trader):
    - Fills: enter at the ask plus half the spread, exit at the bid; flat ₹40 commission.
    - Reports live P&L about 5–10% below backtest.
    - Stops new entries at 12:30–12:45 and times out holds after 30–40 min.
    - Entry gates: score, then direction, then micro-momentum, then premium confirmation.
    - Notes that expiry-day gamma is under-represented in training data.

## 4. LLM and event-driven trading projects

- **Vibe-Trading** ([HKUDS](https://github.com/HKUDS/Vibe-Trading), MIT), file `agent/src/skills/event-driven/SKILL.md`.
  - The LLM returns one number in [-1, 1]: ±1 extreme, ±0.5 moderate, 0 neutral.
  - Event CSV schema: `date,event_type,score,source,summary`.
  - `signal = clip(Σ score·exp(-λ·days), -1, 1)` with λ = 0.1 per day (half-life about 6.9 days), a 30-day lookback, and scores with |score| < 0.2 dropped.
  - Final signal: `0.6·tech + 0.4·event`.
  - Pitfalls it lists: use the date the news was knowable, duplicates across sources, prompt drift, sparse events, and λ set too high.
  - For us: λ = ln2 / half_life per event, bound the EPI with clip or tanh, and replay by `first_seen_at`.
- **TradingAgents** ([TauricResearch](https://github.com/TauricResearch/TradingAgents), Apache-2.0, v0.6.0).
  - Pipeline: analysts, then a bull/bear debate, then a trader, then a risk/portfolio-manager team.
  - Takes a point-in-time data snapshot before the agents run, and withholds non-point-in-time data in historical runs.
  - Decisions are logged and "settled" once the holding period ends.
  - Uses a quick model tier and a deep model tier to control cost.
- **FinGPT** ([AI4Finance](https://github.com/AI4Finance-Foundation/FinGPT), MIT). Sentiment F1 is 0.88 on FPB and 0.90 on FiQA, but only 0.64 on tweets (TFNS), so short text is noisy. Its Forecaster is trained only on weekly Dow-30 data.
- **FinRL** ([AI4Finance](https://github.com/AI4Finance-Foundation/FinRL), MIT). Strict time-ordered train, test and trade splits. A turbulence index serves as a market-stress feature.
- **LLM-trader-test** ([kojott](https://github.com/kojott/LLM-trader-test), no licence seen, so ideas only). Its JSON decision has `signal, side, quantity, leverage, confidence, profit_target, stop_loss, risk_usd, invalidation_condition, justification`. Every prompt/response and every decision is persisted to CSV.
- **Research papers**:
  - [Lopez-Lira & Tang](https://arxiv.org/abs/2304.07619): headline scores predict next-day returns. After the training cutoff, GPT-4 hit about 90% on the *initial reaction*, which is not tradable. The tradable drift is mostly in small caps and negative news.
  - [Glasserman & Lin](https://arxiv.org/abs/2309.17322): in-sample results carry both look-ahead bias and a "distraction" effect, and anonymised headlines did better.
  - [Look-Ahead-Bench](https://arxiv.org/abs/2601.13770): standard LLMs lose alpha outside their training window.
- **GDELT**.
  - [gdeltdoc](https://github.com/alex9smith/gdelt-doc-api) (MIT) documents the DOC 2.0 API:
    - Modes: `mode=ArtList|TimelineVol|TimelineTone`.
    - At most 250 records per call (`maxrecords`).
    - Filters: `sourcecountry:` (FIPS code, India is `IN`), `sourcelang:`, `theme:`, `domain:`, `near`, `repeat`.
    - **Only about the last 3 months** of articles are served.
  - Raw GDELT 2.0 files are published every 15 minutes (`data.gdeltproject.org/gdeltv2/lastupdate.txt`). Zipped sizes: export about 80 KB, mentions about 125 KB, GKG about 6.5 MB.
  - Third parties report a limit of 1 request per 5 s (**not verified**).
  - We found no public GDELT-to-trading project with checkable results. algogd and a bearblog write-up would not load (**not verified**).

## 5. TypeScript libraries for the Worker

"Likely" in the Workers column means pure JS with no Node built-ins according to package metadata. None of these were tested in workerd.

| Package (version, published) | Licence | Runtime deps | Workers | Decision | Why |
|---|---|---|---|---|---|
| `trading-signals` 8.3.0 (2026-08-11) | MIT | none | Likely (ESM) | Test oracle | Maintained, with a streaming `update`/`replace` API. We need about 5 indicators (EMA, ATR, rolling z-score, realised vol), so we write them and cross-check in vitest. |
| `indicatorts` 2.2.2 | MIT | none | Likely | Skip | npm marks it deprecated ("no longer supported"). |
| `technicalindicators` 3.1.0 (2020-03) | MIT | `@types/node` | Unclear | Skip | Stale; 5.1 MB unpacked. |
| `grademark` 0.3.0 (2024-10) | MIT | mathjs 5, moment, dayjs, typy, … | Untested | Skip | Heavy and old deps. Our replay loop is simpler. |
| `black-scholes` 1.1.0, `implied-volatility` 1.0.0 | MIT | none / black-scholes | Likely (CJS) | Skip | Normal CDF from a 100-term series, no guard as T→0, IV bisection only to the cent. |
| `@fullstackcraftllc/floe` | MIT for individuals/non-commercial, otherwise commercial | none | Unknown | Ideas only | Business use needs a paid licence. |
| `otpauth` 9.5.2 (2026-09-03) | MIT | `@noble/hashes` 2.4.0 | Yes (browser build) | Optional | Our WebCrypto TOTP needs no deps. Keep this as a fallback. |
| `papaparse` 5.7.0 (2026-08-24) | MIT | none | Likely (string input) | Optional | Cannot read a Web `ReadableStream`. The 10+ MB CSV needs filter-then-parse streaming. |
| `d3-dsv` 3.0.1 | ISC | rw, commander, iconv-lite (for its CLI) | Likely | Skip | No streaming; extra deps. |
| `simple-statistics` 7.12.1 | ISC | none | Likely (ESM) | Adopt in eval/research code | Regression (beta), correlation, quantiles, for IC and calibration reports. |
| `fflate` 0.8.3 | MIT | none | Yes (browser ESM) | Only for GDELT raw backfill | GDELT 2.0 files are `.zip`. |
| `growwapi` (Node) 1.1.3 | Apache-2.0 | 11, incl. lodash, nats, protobufjs, jest | No (fs/os/path/crypto) | Skip as a dependency | Port snippets with attribution only if needed. |
| `agents` (Cloudflare Agents SDK) | MIT | — | Yes | Ideas | Runs many schedules off one alarm plus a SQLite table. |
| `nats.ws`, `ts-nkeys` | licence **not verified** | — | Not tried | Later | Only needed for the Groww live feed. |

## 6. Charges, lot sizes, expiries, holidays, volatility conventions

Groww equity F&O option charges ([pricing page](https://groww.in/pricing/futures-and-options)):

| Charge | Rate |
|---|---|
| Brokerage | ₹20 per executed order |
| STT | 0.15% of premium on the sell side. Exercised options also 0.15%. Effective 2026-04-01 (NSE/FATAX/73524). |
| Exchange transaction | NSE 0.03503% of premium, BSE 0.0325% of premium, both sides |
| SEBI turnover fee | 0.0001%, both sides |
| IPFT | 0.0005%, both sides |
| Stamp duty | 0.003%, buy side |
| GST | 18% on brokerage + exchange + SEBI + IPFT (+ API and auto-square-off charges) |

Worked example, 1 lot bought and sold at a premium of 150:

- **NIFTY** (65 units): buy ₹27.99 + sell ₹42.32 = ₹70.32. That is about 1.08 points per unit, or 0.72% of premium.
- **SENSEX** (20 units, premium 300): ₹61.07. That is about 3.05 points per unit, or 1.02% of premium.

SENSEX's small lot lets the per-order brokerage dominate, so its cost gate must be stricter. Contract notes round some charges. Treat the calculator as accurate to about ₹1.

- **Lot sizes**: NIFTY 65 and BANKNIFTY 30 for contracts expiring January 2026 onward (NSE circular FAOP70616, via [Fyers](https://fyers.in/notice-board/revision-in-index-derivatives-contracts-lot-size/)). SENSEX is 20 according to a secondary source with no BSE notice cited. Lot sizes are revised periodically, so read `lot_size` from the CSV daily and alert on any change.
- **Expiries**: NIFTY weekly expires on Tuesday (NSE) and SENSEX weekly on Thursday (BSE), since 2025-09-01. Monthly contracts expire on the last Tuesday or Thursday. If expiry falls on a holiday, it moves to the previous trading day ([share.market](https://www.share.market/buzz/insights/weekly-expiry-days-in-indian-fo-markets/)). Take live expiries from the CSV and backtest expiries from `/historical/expiries`.
- **2026 NSE/BSE trading holidays** ([Zerodha](https://zerodha.com/marketintel/holiday-calendar/)): 15 Jan (Thu, ad-hoc, Maharashtra civic polls), 26 Jan, 3 Mar (Tue), 26 Mar (Thu), 31 Mar (Tue), 3 Apr, 14 Apr (Tue), 1 May, 28 May (Thu), 26 Jun, 14 Sep, 2 Oct, 20 Oct (Tue), 10 Nov (Tue), 24 Nov (Tue), 25 Dec. Muhurat session on Sunday 8 Nov.
  - **Upcoming NIFTY expiry shifts**: 20 Oct moves to Monday 19 Oct; 10 Nov moves to Monday 9 Nov; 24 Nov (also the monthly expiry) moves to Monday 23 Nov.
  - The XBOM calendar in [exchange_calendars](https://github.com/gerrymanoim/exchange_calendars) (Apache-2.0) has the other 2026 dates but **misses 15 Jan 2026**.
  - OpenAlgo's holiday model (ideas only) uses `holiday_type` of TRADING_HOLIDAY, SETTLEMENT_HOLIDAY or SPECIAL_SESSION, plus `open_exchanges` with session start and end. We should copy that shape.
- **Volatility conventions**:
  - India VIX follows the CBOE method, with T counted in minutes over minutes-in-a-year (a 365-day basis) (NSE page, search summary). Groww's chain `iv` is in percent.
  - Gate identities we derived (standard maths; not from a repo):
    - Expected absolute move: E|ΔS| ≈ 0.798·S·σ·√T, which is about the ATM straddle price.
    - Breakeven move for a long option held Δt days: `x* = (−|Δ| + √(Δ² + 2Γ(|Θ|·Δt + C/q)))/Γ`, where C is the round-trip cost in ₹ and q is units.
    - Add `vega·ΔIV` when an IV crush is expected after the news.
    - Convert calendar-time IV to trading-time variance before comparing it with intraday realised-vol forecasts.
  - Groww historical candles carry no IV, greeks or bid/ask. Archive option-chain snapshots (say every 5 min) in D1 or R2 during paper and live runs to build our own IV history.

## 7. Cloudflare Workers and Durable Objects

- **Alarms** ([docs](https://developers.cloudflare.com/durable-objects/api/alarms/)): one alarm per object. Execution is at least once. Retries use exponential backoff from 2 s, up to 6 retries, and `alarmInfo.retryCount`/`isRetry` are available. Calling `setAlarm` inside `alarm()` replaces the pending alarm. The recommended pattern stores a schedule, processes due items, and re-arms for the earliest next one. When setting an alarm in the constructor, check first for an existing one.
- **Implications for us**:
  - Persist each order intent before calling the broker.
  - On a retry, query the status by reference before sending again.
  - Re-arm every N seconds only from 09:15 to 15:30 IST on trading days.
  - Mint the token once after 06:00 IST, around 08:45, and cache it in DO storage.
- **Limits** ([docs](https://developers.cloudflare.com/workers/platform/limits/), paid plan):
  - Memory: 128 MB per isolate.
  - CPU: 30 s default, configurable to 5 min.
  - Wall time: 15 min for an alarm handler and for a queue consumer.
  - Cron CPU: 30 s for intervals under 1 h, 15 min for intervals of 1 h or more.
  - Subrequests: 10,000 per request.
  - A 10+ MB CSV fits only if we stream it and drop rows before building objects.
- **Web Crypto** ([docs](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)): HMAC (for TOTP) and Ed25519 (for NATS nkeys later) are supported, and `digest` supports SHA-1. The docs table does not list which hashes HMAC pairs with, so we confirm HMAC-SHA1 with RFC 6238 tests.
- **Cloudflare Agents SDK** ([docs](https://developers.cloudflare.com/agents/api-reference/schedule-tasks/), MIT): `this.schedule(delaySeconds | Date | cron, callback, payload)` stores tasks in SQLite behind a single alarm, with an `idempotent` option. Use it as a reference pattern; it is not needed as a dependency.
- **No public trading bot built on Durable Objects** turned up in GitHub topic searches or web searches. The closest alarm-driven example is [aarondfrancis/do-auction](https://github.com/aarondfrancis/do-auction), which we did not review.
- **Egress**: Worker egress IPs are not static (general knowledge, **not verified** here). So the static-IP order relay stays in the design.

## 8. Pitfalls others reported, and how our design addresses them

| Pitfall (reported by) | Our design or action |
|---|---|
| LLM look-ahead and "distraction" bias in backtests (Glasserman & Lin; Look-Ahead-Bench) | Judge the LLM only on news after the model's training cutoff. Log model id and prompt version. A/B test anonymised against raw text. The forward paper period is the real test. |
| Publisher time used instead of the time the news was knowable (Vibe-Trading) | Store `first_seen_at` at ingestion. Backtests replay at `first_seen_at` plus scoring latency. |
| Initial reaction is not tradable (Lopez-Lira & Tang) | Gate on the residual: predicted move minus the realised index move since `first_seen_at`. Skip if most of it has already happened. |
| Duplicate stories across sources (Vibe-Trading) | Cluster before scoring. Each story contributes once to the EPI; updates revise its score instead of adding another. |
| Prompt or score drift, and non-determinism (Vibe-Trading, TradingAgents) | Versioned rubric, temperature 0, structured outputs validated with zod. Re-score a frozen golden set nightly and alert on drift. |
| Uncalibrated LLM magnitudes (general; FinGPT's short-text weakness) | Map magnitude and confidence to realised basis points with binned or isotonic calibration on settled outcomes. Report IC, hit rate and Brier score. |
| Overfitting (FinRL, AI-trader) | Keep parameters few. Walk forward by month and freeze parameters before each out-of-sample window. |
| Live results 5–10% below backtest (AI-trader) | Fill at offer/bid with tick slippage and the section 6 costs. Compare paper against backtest every week. |
| Synthetic and real prices mixed together (shivam61) | Tag the price source on each fill. Calibrate the ratio of weekly ATM IV to VIX, by days to expiry, from real Groww candles. |
| Expiry-day gamma and theta (AI-trader) | Separate parameters and an entry cutoff on NIFTY Tuesdays and SENSEX Thursdays. The theta gate uses minutes to expiry. |
| Exercise STT of 0.15% on ITM options held to expiry (Budget 2026) | Always square off before the close on expiry day. |
| MIS auto square-off fee of ₹50 (Groww) | Hard exit by 15:05 IST, or use NRML with our own exit plus an OCO (OCO requires NRML). |
| Stale or zero quotes (OpenAlgo sandbox) | Reject an LTP outside the day's [low, high] or older than N seconds. Skip zero LTP. |
| Token expiry and rate limits (Groww: 06:00 expiry, 150 token calls/day; Fyers note) | One token per day, cached. A limiter per category. Back off on GA003, 429 and 5xx. |
| Ad-hoc holidays and special sessions (15 Jan 2026 missing from exchange_calendars; Muhurat) | Own JSON with manual overrides. Live check: if index LTP/OHLC has not changed by 09:20, treat the market as closed. No trading in special sessions. |
| GDELT DOC API serves only ~3 months | Persist every ingested item in D1 from day one. Backfill from GDELT 2.0 raw files if needed. |
| Static IP, OPS and MPP rules (SEBI/NSE) | Relay from whitelisted IPs. Stay at or below 10 orders/s. Use marketable LIMIT orders, not MARKET. |
| Lot-size or expiry changes (NSE circulars) | Refresh the CSV daily, check it against config, and alert on any difference. |

## 9. Sources

Groww:

- [Groww cURL docs](https://groww.in/trade-api/docs/curl)
- [Orders](https://groww.in/trade-api/docs/curl/orders)
- [Annexures](https://groww.in/trade-api/docs/curl/annexures)
- [Live data](https://groww.in/trade-api/docs/curl/live-data)
- [Historical data](https://groww.in/trade-api/docs/curl/historical-data)
- [Backtesting](https://groww.in/trade-api/docs/curl/backtesting)
- [Instruments](https://groww.in/trade-api/docs/curl/instruments)
- [Smart orders](https://groww.in/trade-api/docs/curl/smart-orders)
- [Margin](https://groww.in/trade-api/docs/curl/margin)
- [Portfolio](https://groww.in/trade-api/docs/curl/portfolio)
- [User](https://groww.in/trade-api/docs/curl/user)
- [Changelog](https://groww.in/trade-api/docs/curl/changelog)
- [Python SDK](https://groww.in/trade-api/docs/python-sdk)
- [Python SDK annexures](https://groww.in/trade-api/docs/python-sdk/annexures)
- [Python SDK backtesting](https://groww.in/trade-api/docs/python-sdk/backtesting)
- [F&O pricing](https://groww.in/pricing/futures-and-options)
- [Static IP blog](https://groww.in/blog/static-ip-api-trading-setup)

OpenAlgo:

- [auth_api.py](https://github.com/marketcalls/openalgo/blob/main/broker/groww/api/auth_api.py)
- [order_api.py](https://github.com/marketcalls/openalgo/blob/main/broker/groww/api/order_api.py)
- [data.py](https://github.com/marketcalls/openalgo/blob/main/broker/groww/api/data.py)
- [transform_data.py](https://github.com/marketcalls/openalgo/blob/main/broker/groww/mapping/transform_data.py)
- [master_contract_db.py](https://github.com/marketcalls/openalgo/blob/main/broker/groww/database/master_contract_db.py)
- [nats_websocket.py](https://github.com/marketcalls/openalgo/blob/main/broker/groww/streaming/nats_websocket.py)
- [groww_nats.py](https://github.com/marketcalls/openalgo/blob/main/broker/groww/streaming/groww_nats.py)
- [sandbox execution_engine.py](https://github.com/marketcalls/openalgo/blob/main/sandbox/execution_engine.py)
- [squareoff_manager.py](https://github.com/marketcalls/openalgo/blob/main/sandbox/squareoff_manager.py)
- [Symbol format](https://docs.openalgo.in/symbol-format)
- [Groww setup](https://docs.openalgo.in/connect-brokers/brokers/groww)
- [Holidays API](https://docs.openalgo.in/api-documentation/v1/utilities-api/holidays)

growwapi (Node):

- [auth.ts](https://github.com/NithinSGowda/growwapi/blob/master/src/resources/auth.ts)
- [http.ts](https://github.com/NithinSGowda/growwapi/blob/master/src/utils/http.ts)
- [enums](https://github.com/NithinSGowda/growwapi/tree/master/src/types/enums)
- [fileCache.ts](https://github.com/NithinSGowda/growwapi/blob/master/src/utils/fileCache.ts)
- [npm](https://www.npmjs.com/package/growwapi)

LLM and event-driven:

- [Vibe-Trading event-driven skill](https://github.com/HKUDS/Vibe-Trading/blob/main/agent/src/skills/event-driven/SKILL.md)
- [TradingAgents](https://github.com/TauricResearch/TradingAgents)
- [FinGPT](https://github.com/AI4Finance-Foundation/FinGPT)
- [FinRL](https://github.com/AI4Finance-Foundation/FinRL)
- [LLM-trader-test](https://github.com/kojott/LLM-trader-test)
- [Lopez-Lira & Tang](https://arxiv.org/abs/2304.07619)
- [Glasserman & Lin](https://arxiv.org/abs/2309.17322)
- [Look-Ahead-Bench](https://arxiv.org/abs/2601.13770)
- [gdeltdoc](https://github.com/alex9smith/gdelt-doc-api)
- [GDELT lastupdate](http://data.gdeltproject.org/gdeltv2/lastupdate.txt)

npm packages:

- [trading-signals](https://www.npmjs.com/package/trading-signals)
- [indicatorts](https://www.npmjs.com/package/indicatorts)
- [technicalindicators](https://www.npmjs.com/package/technicalindicators)
- [grademark](https://www.npmjs.com/package/grademark)
- [black-scholes](https://github.com/MattL922/black-scholes)
- [implied-volatility](https://github.com/MattL922/implied-volatility)
- [floe](https://github.com/FullStackCraft/floe)
- [otpauth](https://www.npmjs.com/package/otpauth)
- [papaparse](https://www.npmjs.com/package/papaparse)
- [d3-dsv](https://www.npmjs.com/package/d3-dsv)
- [simple-statistics](https://www.npmjs.com/package/simple-statistics)
- [fflate](https://www.npmjs.com/package/fflate)
- [Cloudflare agents](https://github.com/cloudflare/agents)

Regulation and market structure:

- [Kotak Neo: NSE retail algo rules](https://www.kotakneo.com/investing-guide/articles/retail-algo-trading-rules-nse-circular)
- [Fyers: SEBI rules from 1 Apr 2026](https://support.fyers.in/portal/en/kb/articles/what-are-the-new-sebi-rules-for-retail-algo-trading-from-april-01-2026)
- [ICICI Direct: STT 2026](https://www.icicidirect.com/ilearn/futures-and-options/articles/stt-changes-in-budget-2026-what-f-o-traders-should-know)
- [Sahi: lot sizes 2026](https://www.sahi.com/blogs/nifty-lot-size-2026-bank-nifty-sensex)
- [India VIX (NSE)](https://www.nseindia.com/static/products-services/indices-indiavix-index) (not opened; methodology from search summary)
