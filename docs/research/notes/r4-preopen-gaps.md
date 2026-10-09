# R4 — Can NIFTY's open (gap up / gap down) be known before 09:15 IST, how reliably, and how should an option BUYER use it?

Researched Fri 9 Oct 2026, 08:45–09:25 IST, from the repo container (all URLs below were fetched through the configured HTTPS proxy; what worked and what did not is recorded in §5). Every number carries its source and time. "Evidence" = exchange data, peer-reviewed/working papers, or a backtest with a stated method and sample; "folklore" = broker/blog claims with no method.

---

## 0. Bottom line (read this first)

1. **Yes, the *direction and rough size* of the opening gap is knowable before 09:15.** GIFT Nifty (NSE IX, GIFT City) trades from 06:30 IST, and the NSE pre-open call auction (09:00–09:10) publishes an *indicative* NIFTY open that is, mechanically, the same equilibrium calculation that sets the 09:15 open. The pre-open indicative value is the closer of the two; GIFT Nifty is the earlier.
2. **What is NOT knowable is what happens after 09:15.** Of the two measurable things — "where will it open" and "which way will it go after opening" — only the first is well predicted. The best public backtests on NIFTY daily data show that after a ≥1% gap-up the day's open-to-close return is *negative* on average and 29% of such gaps fill the same day; after a ≥1% gap-down, 53% of days close *above* the open and only 17% fill. The first 15-minute candle's breakouts "sustain" ~52% of the time (coin-flip). So the opening gap is largely *already priced* by 09:15; buying an option in the gap's direction at 09:25 is buying *after* the information is in the price.
3. **For the owner's example (Thu 8 Oct):** FII provisional cash selling was **₹12,943.58 cr** (NSE provisional, not ₹12,988 cr); DIIs bought ₹10,703.11 cr. NIFTY fell 1.64% — but it *opened* at 22,599.05 vs. prev close 22,603.05, i.e. essentially flat (−4 points), and fell *during the day*. The FII number is published after the close, so it could not have been used at the open; and puts were profitable on 8 Oct because of an intraday trend, not because of a predictable gap. This is the trap: the FII figure *explains* the day after the fact, it does not *predict* the next morning (the FII daily series is covered by the flow-signal agent; the depository (NSDL) confirmed figure for 8 Oct was a much smaller −₹6,206 cr, so the two "FII" series do not even agree).
4. **Today (Fri 9 Oct, pre-market):** GIFT Nifty Oct futures 22,365–22,370 at 08:52–08:58 IST (NSE IX live API), vs NSE NIFTY Oct futures close 22,293.20 and spot close 22,231.80 → implied open roughly **+75 to +110 points (+0.3% to +0.5%)**, i.e. a modest gap-up after a −1.64% day. US: S&P −0.47%, Nasdaq −1.25%, Dow +0.10% (8 Oct close); ES/NQ futures +0.2%/+0.3% at ~08:52 IST; Nikkei −0.8% (05:30 IST print), Hang Seng +1.0% (07:00 IST), Korea and Taiwan closed (holiday); Brent ≈ $103.4–103.8 (−0.8%); USDINR 96.78; US 10y 5.23%; India VIX 15.31 (+10.3% on 8 Oct). Live pre-open/open comparison for today is in §6.3.

---

## 1. GIFT Nifty (NSE International Exchange, GIFT City)

### 1.1 What it is, history
- SGX Nifty (Singapore) was the offshore NIFTY futures used for decades as the pre-open gauge. Under the NSE–SGX "Connect" arrangement, all SGX Nifty trading migrated to **NSE IX (NSE International Exchange, GIFT City) on 3 July 2023** and the product was renamed **GIFT Nifty**. NSE IX press coverage: cumulative volume >76 million contracts and turnover >US$3.5 trillion since 3 July 2023 (as of 25 Sep 2026). Sources: Business Today / ANI / Motilal Oswal reports on the 25 Sep 2026 record (links in §8).
- Liquidity (NSE IX press release coverage, 26–28 Sep 2026): record single-day turnover **US$23.67 bn on 25 Sep 2026** (previous record US$23.48 bn on 20 Feb 2026), record volume **512,023 contracts**, open interest **US$21.87 bn / 471,287 contracts**. For comparison, NSE's own NIFTY Oct futures had OI 19.1 million units (= ~29 bn ₹-crore notional... see NSE F&O bhavcopy 8 Oct) — GIFT is deep enough that its price is a real price, not a thin indication.
- Academic evidence that the offshore contract leads: Sundararajan & Balasubramanian, *International Journal of Emerging Markets* 20(5), 2023 (DOI 10.1108/IJOEM-07-2022-1097), 5-minute data, VECM + Hasbrouck/Lien-Shrestha/Gonzalo-Granger information shares: **SGX Nifty futures ranked first in price discovery, NSE Nifty futures second, spot last**; bidirectional causality between SGX and NSE futures. (Full text paywalled; abstract via IDEAS/RePEc.) A 2025 paper on GIFT Nifty specifically (JRFM 18(9):527, "Information Transmission Performance of the GIFT Nifty Futures: Evidence from High-Frequency Data") exists but MDPI blocked our fetch (403), so its findings are not summarised here.

### 1.2 Trading sessions (IST) and contract terms
- Official NSE IX circulars retrieved from the container (`https://www.nseix.com/api/content/circulars/<ref>.pdf`):
  - **NSEIFSC/TRADE/2422 (18 Dec 2025)**: for the 1 Jan 2026 holiday session, "Normal Market Open 06:30 hrs / Close 15:40 hrs" for Index Futures (T+1 session only). This confirms the first session is **06:30–15:40 IST**.
  - **NSEIFSC/TRADE/1734 (2024, NIFTYNXT50/MIDCPNIFTY launch)**: "Trade timing: 6.15 am to 3.55 pm (T session); 4.25 pm to 02.45 am (T+1 session)"; lot size US$1 × index; tick US$0.5. These are the sister products; GIFT Nifty 50's second session is **16:35–02:45 IST** in every broker description (Angel One, ICICI Direct, Kotak Neo, Zerodha Kite forum) and the T+1 session end of **02:45 IST** matches the circular. The consolidated contract-specification circular NSEIFSC/TRADE/2129 (8 May 2025, referenced in TRADE/2199) returned 404 from both nseix.com hosts, so the exact Nifty-50 session boundaries could not be read from the primary document — treat 06:30–15:40 and 16:35–02:45 as "broker-confirmed, exchange-consistent".
  - **NSEIFSC/TRADE/2199 (2025)**: monthly futures/options expiry moved from last Thursday to **last Tuesday** of the expiry month (matching NSE's NIFTY Tuesday expiry). Live API today shows expiries 27-Oct-2026 and 23-Nov-2026 (both Tuesdays).
  - Contract: USD-denominated, cash-settled, quoted in index points; multiplier US$2 per point per most broker pages (ICICI's "50 units" and MNCL's "25 units" are inconsistent — do not rely on those). Regulated by IFSCA.
- Practical consequence: by 08:45 IST GIFT Nifty has been trading for 2¼ hours *today* and has already absorbed the full US session and the Asian open. Its 02:45 IST "close" is what the NSE IX API reports as `CLOSE`; `DAYCHANGE` on the API is vs. that 02:45 close, **not** vs. NIFTY spot — press reports ("GIFT Nifty up 80") usually mean vs. NSE NIFTY *futures* close, and some sites compute vs. spot close. Three different "changes" circulate for the same price.

### 1.3 How well does it predict the 09:15 open? (evidence vs. folklore)
- **No peer-reviewed study of "GIFT/SGX level at 08:xx vs. NSE opening print" was found** (searched extended; only lead-lag/price-discovery papers exist). Broker pages claim "~85% accuracy" (MCX Trends vendor page) or "correct in the majority of sessions" (Belong) with no sample or definition — **folklore**.
- What *is* solid: (a) the price-discovery literature above (the offshore contract leads); (b) arbitrage — NSE NIFTY futures open at 09:15 and arbitrageurs keep NSE futures within a few points of GIFT, so the *futures* open is pinned; the *spot index* open is the sum of 50 stocks' call-auction prices and can deviate by the basis and by stock-specific auction noise.
- **The basis / fair-value adjustment is the main source of "error" and it is mechanical:** GIFT Oct futures trade at a premium to spot = NSE futures basis (cost of carry) ± a USD-funding differential. On 8 Oct: NSE NIFTY Oct fut close 22,293.20 vs spot 22,231.80 → **basis +61.4 pts** (NSE F&O bhavcopy 20261008). NSE IX bhavcopy (G_T_Bhavcopy_FO_081026.CSV) shows GIFT Oct closed its 15:40 session at 22,255 — i.e. GIFT was ~38 pts *below* NSE futures at the close (10-minute timing mismatch, spot was falling into the close). So:
  - *Implied open (method A, basis-adjusted)* = GIFT_now − (NSE fut close − spot close) = 22,368 − 61 ≈ **22,307 (+75)**
  - *Implied open (method B, change-on-change)* = spot close + (GIFT_now − GIFT 15:40 close) = 22,231.8 + (22,368 − 22,255) ≈ **22,345 (+113)**
  - *Naïve "GIFT minus spot close"* = 22,368 − 22,231.8 = **+136** — this is what many sites print, and it over-states the gap by the basis.
  - Rule: never read "GIFT − spot close" as the gap; use NSE's own futures close (bhavcopy or the quote page) as the reference and expect a ±40-point band between methods.
- Belong's blog (no data, but sensible) lists why the open deviates: domestic news after 08:45, DII absorption of gap-downs, expiry-day short covering, thin overnight GIFT volume, INR moves that do not carry to spot, and "small implied gaps (<0.2%) get reversed by domestic cues at the open".
- Where the signal is weakest: the GIFT *level* at 07:30 can differ from the level at 09:10 by tens of points on a volatile morning (today: Nov contract last traded 07:31 at 22,423; Oct contract moved 22,326.5–22,392 between 06:30 and 08:58 — a 65-point range *before* NSE opened). Read it at **09:05–09:12**, not at 07:30.

---

## 2. NSE pre-open session (call auction) — the better 09:15 predictor

- **Timeline (NSE equity pre-open page, retrieved 9 Oct 2026, reflecting the 7 Sep 2026 revision):**
  - 09:00–09:05: order entry/modify/cancel for *limit and market* orders.
  - 09:05–09:10: **limit orders only**; market orders rejected; **system-driven random closure in the last 2 minutes (09:08–09:10)**.
  - 09:10–09:12: order matching, **opening (equilibrium) price determination**, trade confirmation.
  - 09:12–09:15: buffer; 09:15 continuous trading.
  - Market orders get priority over limit orders in matching. (Before 7 Sep 2026 the random close was between the 7th and 8th minute and matching began 09:08 — older blogs still say this.)
- **Equilibrium price rule** (NSE page): price at which maximum volume is executable; tie → minimum order imbalance; tie → price closest to previous close. Unmatched limit orders carry into continuous trading at their limit; unmatched market orders carry at the discovered price.
- **Data disseminated during 09:00–09:10 (NSE page, "Data Dissemination" table):** indicative equilibrium price per stock, indicative tradable quantity, cumulative buy/sell quantity, imbalance quantity, and **"Indicative open price of all the indices including NIFTY50"**. The indicative NIFTY is simply the index computed from each constituent's indicative equilibrium price. Because the order book keeps changing until the random close, the number moves — but the final value *is* the opening value by construction. There is no published "accuracy" statistic because, in the 09:10–09:15 window, the indicative open and the actual open are the same calculation; the only slippage is (i) the random-close snapshot you happened to read vs. the final book, and (ii) stocks with no pre-open trades (open at previous close until first trade).
- **F&O segment also has a pre-open since 8 Dec 2025** (NSE circular NSE/FAOP/71092, 3 Nov 2025; FAQ PDF retrieved): applies to **current-month index futures and stock futures** (next-month in the last 5 days before expiry), 09:00–09:08 order entry (random close 7th–8th minute), independent of the cash-segment random close; indicative equilibrium price and % change vs previous close are disseminated, and "Indicative Equilibrium Price, Indicative Equilibrium Quantity shall be disseminated on website". So from 09:00 there is an onshore NIFTY-futures indicative open too — the cleanest cross-check against GIFT.
- **Academic note:** Acharya & Gaikwad (2014, *Cogent Economics & Finance*, DOI 10.1080/23322039.2014.944668) found the 2010 introduction of the pre-open call auction did **not** significantly improve price discovery at the open for the large liquid Nifty stocks (the information was already there). Relevance here: the auction tells you the open; it does not make the open more "right".
- **Where published:** NSE website → Market Data → Pre-Open Market (cash) `https://www.nseindia.com/market-data/pre-open-market-cm-and-emerge-market`; JSON behind it: `https://www.nseindia.com/api/market-data-pre-open?key=NIFTY` (also `BANKNIFTY`, `FO`, `ALL`). Behaviour observed today: before 09:00 `key=NIFTY` returns `{"data":[],"msg":"No Data Found"}`, while `key=FO` / `key=ALL` still return the *previous session's* final pre-open book (timestamp "08-Oct-2026 09:08:13", 213 and 2,225 rows, each with IEP, final price/quantity, ATO quantities and the price ladder). Live results for today are in §6.3.

---

## 3. Global cues — what the evidence says about predictive power

| Cue | Available by (IST) | What it predicts | Evidence quality |
|---|---|---|---|
| **US cash close** (S&P/Nasdaq/Dow) | ~01:30 (02:30 in winter) | The *overnight gap*, not the day. Kumar & Mukhopadhyay (2002, GARCH, 1999–2001) and a later US–India linkage study: previous-day NASDAQ daytime returns significantly affect NIFTY's next *overnight* return; one-way causality US → India. "Dynamic effects of US and Asian markets on Indian stock market" (daily S&P 500/CNX Nifty, Mar 2005–Nov 2010): India responds to the prior US return, US does not respond to India; an index is most affected by markets that close just before it. | Academic (older samples); consistent across studies |
| **US index futures (ES/NQ)** overnight → 09:15 | continuous | Marginal update on top of the cash close; by 08:45 IST GIFT already embeds this | Mechanism, not a separate study |
| **Asia (Nikkei 05:30, Kospi 05:30, HSI 06:50 continuous, ASX 05:30, Shanghai 07:00)** | before 09:00 | De Gooijer, Diks & Gatarek (CeNDEF WP 09-13, 2009; CEJEME 2012) forecast close-to-open returns of major indices from foreign overnight price *patterns*: best model is non-parametric and "the nonlinear effect is mainly due to the European and Asian markets"; North-American inputs add little beyond the last available price. A global-indices study found **Hang Seng the most influential on Nifty** (overlapping hours). | Academic; but none of these papers isolates NIFTY's open vs. GIFT |
| **Overnight → intraday reversal** | n/a | Della Corte & Kosowski (CICF paper "Market Closure and Short-Term Reversal"): ~25–39% of the *overnight* return reverses intraday, vs ~2% of intraday returns; robust in international indices and index futures. Boyarchenko et al. (NY Fed SR 917, "The Overnight Drift"): sell-offs generate robust positive overnight reversals; rallies much smaller reversals. | Academic (US/global, not NIFTY-specific) — but it is the strongest reason to distrust "gap-and-go" |
| **Crude, USDINR, US 10y** | continuous | Drivers of *regime* (today: Brent ~$103, INR 96.8, 10y 5.23% is the reason VIX is 15). No study shows they add to GIFT for the *open* — GIFT already prices them. | Context only |
| **ADRs (INFY, WIT, HDB, IBN, RDY)** | ~01:30 | IHS Markit fair-value case study: the INFY ADR explained most of a −4.64% Infosys overnight move on stock-specific news; otherwise ADR moves are "overnight sentiment", arbitrage is costly. Useful for *single-stock* gaps (IT results), weak for the index. | Vendor case study / forum |
| **FII/DII provisional cash figures** | ~18:00–19:00 previous day | Published after the close; the 8 Oct figure (−₹12,944 cr) was known Thursday evening. Whether it predicts Friday's open is the flow-agent's question; NSDL's depository-confirmed number for the same day was −₹6,206 cr, so even the sign/size is series-dependent. | Not a pre-open predictor by construction |

Take-away: **GIFT Nifty at 09:05–09:12 and the NSE indicative open at 09:08–09:12 subsume all of the above for the question "where does it open".** Global cues matter for *conviction about the day's regime* (risk-on/off, VIX), not as an extra forecast of the open.

---

## 4. Gap behaviour in NIFTY — what the data says (and what it means for a buyer)

Caveat: no NSE or peer-reviewed gap study for NIFTY was found. The best public work is intradaylab.com (method and sample stated, daily/15-min OHLC, Jan 2016–Mar 2026, 2,532 sessions; and 15-min data Jul 2017–Mar 2026, 2,148 sessions). Our own data agent is measuring the same statistics on the repo's Yahoo data — prefer those numbers when they arrive; use these as the external cross-check.

### 4.1 Large gaps (≥1%) — daily data, 2016–Mar 2026
| | Gap-up ≥1% (n=85) | Gap-down ≥1% (n=76) |
|---|---|---|
| Same-day fill (low/high touches prev close) | **29.4%** (1–1.5%: 30%; 1.5–2%: 31%; >2%: 25%) | **17.1%** (−1 to −1.5%: ~27%; −1.5 to −2%: 6%; −2 to −3%: 0%; <−3%: ~25%) |
| Day closes in gap direction (open→close) | 44.7% bullish close; **avg open-to-close −0.25%** | 52.6% close *above* open; avg open-to-close **+0.09%** |
| Next day | closes higher 60% (avg +0.10%) | closes lower 52.6% (avg −0.04%) |
| Sample concentration | 31 of 85 in 2020 | 36 of 76 in 2020+2022; 26% cluster within 4 days of another gap |

Reading: a big gap-up tends to **fade intraday** (negative open-to-close) but not all the way (only 29% fill); a big gap-down tends to **stop falling** (slight positive drift, 53% green from the open) but rarely fills. Neither "gap-and-go" nor "gap-fade" is a reliable mechanical rule; the directional edge from the gap alone is roughly 45/55.

### 4.2 All gaps — 15-minute data, Jul 2017–Mar 2026
- 1,353 gap days vs 795 flat-open days. Gap-up filled same day **51.7%**; gap-down filled **42.9%** (so most small gaps *do* get filled — the fill rate falls steeply with size).
- First 15-min candle (09:15–09:30): bearish 54.7% of days; a **bullish** first candle continued (day closes up) **62%** of the time; a **bearish** first candle reversed (closed green) **64%** of the time. Overall first-candle/day-direction agreement 63%. Continuation rises with candle size: <0.10% → 53%, 0.10–0.24% → 63%, >0.24% → **73%**.
- Opening-range breakouts: price breaks the first-candle high on 71% of days and the low on 76%; *both* on 48%; breakout "success" **53% / 51% — coin flip**; price returns to the breakout level on 99.9% of sessions (so stops at the range edge get hit).
- Zerodha TradingQnA user (0.8% threshold, own formula): 44% gap-up fill, 24% gap-down fill — same shape.

### 4.3 Opening volatility and option premiums
- No study measures NIFTY option IV in 09:15–09:30 specifically. Mechanism (standard, and consistent with vendor straddle charts): IV opens elevated after a gap because overnight uncertainty and the auction are being priced, then settles over 09:20–10:00 as the range forms; ATM options have the most vega so they lose the most when IV settles. India VIX itself jumped 13.89 → 15.31 (+10.3%) on 8 Oct (NSE allIndices), i.e. premiums today are ~10% richer than Wednesday's for the same move.
- Combined with §4.1–4.2: a buyer who enters at 09:25 in the gap direction is (a) paying the opening-IV premium, (b) betting on continuation that happens ~45–55% of the time after large gaps, and (c) facing a 99.9% probability that price revisits the opening range edge. This is the statistical shape behind the repo backtest's losses with late entries.

### 4.4 Evidence-supported rules for a retail option *buyer*
1. **Do not trade the gap itself.** The gap is known by 09:10 and is in the 09:15 price. There is no "buy puts because GIFT says gap-down" edge; the put is already repriced.
2. **Trade the reaction, not the gap, and only when the first 15-minute candle is large (>0.24%) and in the gap's direction** — the one bucket with ~73% continuation. Small first candles (<0.10%) are 53% — skip.
3. **After a ≥1% gap-down, the base rate favours stabilisation, not collapse** (53% close above open; 17% fill). Buying puts into a big gap-down is the lowest-expectancy of the four gap/direction combinations in the data. After a ≥1% gap-up, fading (buying puts after the first candle rolls over) has the better base rate (55% bearish close, −0.25% avg) but still only ~55%.
4. **Let IV settle:** enter after 09:30–09:45 unless the first candle is decisive; never pay the 09:15–09:20 premium for a thesis built on a gap you could have read at 09:05.
5. **Size for the fill statistics:** 43–52% of gaps fill the same day; a long option in the gap direction needs the stop at the first-candle extreme, which is revisited 99.9% of the time — so use *time* stops and premium stops, not level stops at the range edge.
6. **Use the pre-open to decide "no trade"**: implied gap <0.2% and no domestic event → skip the open; implied gap >1% → expect fade/stabilise, wait for 09:30.

---

## 5. Free, key-less, programmatic data sources — tested from this container (9 Oct 2026, 08:48–09:05 IST)

All tests: `curl -sS -A "Mozilla/5.0 ..." -H "Accept: */*"` through `$HTTPS_PROXY` with the proxy CA bundle; no cookies, no API keys. Proxy status showed `recentRelayFailures: []` throughout. "Terms" column is what the site's robots.txt / terms say — **NSE's Terms of Use prohibit "systematic or automated collection of data … scraping, data mining, data extraction, harvesting"** and NSE blocks scripted access intermittently; robots.txt (`Allow: /`, only `/market-data-test` disallowed) is permissive. NSE IX has no robots.txt and its JSON is undocumented. Treat the NSE/NSE IX JSON as *personal, low-frequency, read-only* use (one request per 30–60 s), and prefer the official bhavcopy CSVs for history.

| # | What | URL (GET unless noted) | Format / fields | Update cadence | Result from container | Terms / notes |
|---|---|---|---|---|---|---|
| 1 | **GIFT Nifty live (official NSE IX)** | `https://www.nseix.com/api/market-rate?type=derivative` | JSON `{"data":[{SYMBOL,EXPIRYDATE,LASTPRICE,DAYCHANGE,PERCHANGE,CONTRACTSTRADED,TIMESTMP,TOKEN_NMBR}]}` — both NIFTY futures expiries | Real time during 06:30–15:40 & 16:35–02:45; `TIMESTMP` is the last trade | **200 OK**, 598 B, e.g. `27-Oct-2026 LASTPRICE 22369.00 DAYCHANGE 5.50 TIMESTMP 09-Oct-2026 08:52:33` | Undocumented SPA endpoint (found in nseix.com `main.chunk.js`); no robots.txt; `DAYCHANGE` is vs. GIFT's own 02:45 close |
| 2 | GIFT Nifty depth/OHLC | `https://www.nseix.com/api/streamer-market-watch/` | JSON `MBP_data_Market_Watch[].token_data[]` with OPEN/HIGH/LOW/CLOSE (prev session close), BID/ASK, VOLUME, VALUE, ATP, LTT | Real time | **200 OK**, 925 B (Oct fut: open 22,389, high 22,392, low 22,326.5, close 22,363.5, bid 22,367/ask 22,369.5 at 08:52:33) | As above |
| 3 | GIFT Nifty server time | `https://www.nseix.com/api/streamer-latest-timestamp` | `[["09-Oct-2026 08:52:33"]]` | Real time | 200 OK | — |
| 4 | **GIFT Nifty historical daily bhavcopy** | `https://www.nseix.com/api/content/daily_report/G_T_Bhavcopy_FO_DDMMYY.CSV` (e.g. `..._081026.CSV`) | CSV: CONTRACT_D, PREVIOUS_S, OPEN, HIGH, LOW, CLOSE_PRIC, SETTLEMENT, NET_CHANGE, OI, TRADED_QUA, TRD_NO_CON, TRADED_VAL; rows like `FUTIDXNIFTY27-OCT-2026` | End of T session (15:40) daily; T+1 session in separate report | **200 OK**, 41.7 KB for 8 Oct and 7 Oct | Official exchange report; loop over dates to build history (2023-07-03 onward) |
| 5 | **NSE NIFTY 50 / India VIX live + prev OHLC** | `https://www.nseindia.com/api/allIndices` | JSON `timestamp`, `data[]{index,last,open,high,low,previousClose,variation,percentChange}` | ~every few seconds in market hours; shows prev-day values before 09:15 (indicative during pre-open — see §6.3) | **200 OK** without cookies, 114 KB | NSE ToS prohibit scraping; worked without the usual cookie dance from this proxy, may not elsewhere |
| 6 | **NSE pre-open indicative (cash)** | `https://www.nseindia.com/api/market-data-pre-open?key=NIFTY` (`BANKNIFTY`, `FO`, `ALL`) | JSON: `advances/declines/unchanged`, `timestamp`, `data[]{metadata{symbol,lastPrice,pChange,previousClose,iep,finalQuantity}, detail.preOpenMarket{preopen[price ladder],IEP,ato,totalBuy/SellQuantity,lastUpdateTime}}` | 09:00–09:12 live; after that holds the final book until next 09:00 | `key=NIFTY` → `{"data":[],"msg":"No Data Found"}` before 09:00; `key=FO`/`ALL` → **200 OK** with yesterday's final book (timestamp 08-Oct 09:08:13) | NSE ToS as above. Human page: `/market-data/pre-open-market-cm-and-emerge-market` |
| 7 | **FII/DII provisional (cash)** | `https://www.nseindia.com/api/fiidiiTradeReact` | JSON `[{category:"DII"/"FII/FPI", date, buyValue, sellValue, netValue}]` (₹ cr) — latest day only | Published after close (typically 18:00–19:30 IST) | **200 OK**, 220 B: FII/FPI 08-Oct-2026 buy 15,725.45 sell 28,669.03 net −12,943.58; DII buy 22,987.97 sell 12,284.86 net +10,703.11 | Human page `/reports/fii-dii`. History: Moneycontrol `https://www.moneycontrol.com/markets/fii-dii-data/` (200 OK, HTML, same figures) — robots.txt allows that path |
| 8 | FII derivatives stats (daily xls) | `https://archives.nseindia.com/content/fo/fii_stats_DD-Mon-YYYY.xls` | XLS: index futures/options buy/sell contracts & ₹ cr, EOD OI | After close | **200 OK**, 9.2 KB for 08-Oct-2026 (needs `xlrd`, installed from PyPI) — e.g. NIFTY futures FII bought 9,688 / sold 17,475 contracts; EOD OI 289,875 | Official archive |
| 9 | FPI depository-confirmed daily | `https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx` ; `https://www.cdslindia.com/eservices/publications/fiidaily` | HTML tables (T-1 trades) | Next day ~evening | **200 OK** both; 08-Oct-2026 equity stock-exchange net **−₹6,206.30 cr** (gross buy 13,318.24 / sell 19,524.54), USD/INR 96.6230 | Official; lags one day; different basis from the provisional NSE figure |
| 10 | NSE F&O bhavcopy (basis) | `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip` | UDiFF CSV, 35,832 rows; `TckrSymb=NIFTY, FinInstrmTp=IDF` gives futures close/settle/OI | After close | **200 OK**, 1.1 MB; NIFTY 27-Oct-2026 close 22,293.20, OI 19,137,105; underlying 22,231.80 | Official |
| 11 | Global quotes (Asia, FX, crude, yields, ES/NQ) | `POST https://scanner.tradingview.com/global/scan` body `{"symbols":{"tickers":["TVC:NI225","HSI:HSI","ASX:XJO","KRX:KOSPI","FX_IDC:USDINR","TVC:UKOIL","TVC:US10Y","CME_MINI:ES1!","CME_MINI:NQ1!","NSE:NIFTY","NSE:INDIAVIX"]},"columns":["close","change","update_mode","time"]}` | JSON rows `[symbol,[close,change%,update_mode,epoch,...]]`; indices streaming, NSE 15-min delayed, CME 10-min delayed | Continuous | **200 OK**, 1.4 KB | Undocumented TradingView endpoint (their ToS restrict automated use); fine for a personal dashboard at low rate |
| 12 | Yahoo Finance quote HTML | `https://finance.yahoo.com/quote/ES%3DF/` etc. | HTML with `data-field="regularMarketPrice"` | Continuous | **200 for futures/commodities** (ES=F 7,832.5 +0.21%; NQ=F 31,047 +0.25%; CL=F 90.72 −0.84%; ^TNX 5.231) but **index pages (^N225, ^HSI, ^NSEI) did not expose the fields**; chart/spark JSON APIs → **429 Too Many Requests** from this egress | Yahoo robots.txt disallows AI crawlers; unreliable here |
| — | Blocked / not usable from container | `in.investing.com` (403), `quote.cnbc.com` quote API (403), `stooq.com` (connection reset), Google Finance quote HTML (no data in static HTML), `nseindia.com/api/quote-derivative?symbol=NIFTY` (404 even with cookies), `nseix.com/api/contents/page?url=…` (500), MDPI, ScienceDirect, Tandfonline, HDFC Sky, Business Standard non-AMP, Moneycontrol redirect only (all 403 for WebFetch; BS AMP pages fetch fine with curl) | | | | |

Minimal pre-market script sketch (the data agent can harden it): poll #1 + #2 every 60 s from 08:30; at 09:00 start polling #6 (`key=NIFTY`) and #5 every 30 s; at 09:16 read #5 `open`; after 18:30 fetch #7, #8, #10 and NSE IX #4 for the day.

---

## 6. Verification of the owner's example and today's pre-market picture

### 6.1 Thu 8 Oct 2026 — FII/DII
| Series | FII/FPI | DII | Source / time |
|---|---|---|---|
| **NSE provisional, cash (all exchanges)** | buy ₹15,725.45 cr, sell ₹28,669.03 cr, **net −₹12,943.58 cr** | buy ₹22,987.97 cr, sell ₹12,284.86 cr, **net +₹10,703.11 cr** | `nseindia.com/api/fiidiiTradeReact`, fetched 9 Oct 08:49 IST; identical on 5paisa, Trendlyne, Moneycontrol (each shows −12,943.6 / +10,703.1) |
| NSDL/CDSL depository-confirmed (equity, stock exchange route) | gross buy ₹13,318.24 cr, sell ₹19,524.54 cr, **net −₹6,206.30 cr** (−US$642.3 m at 96.623) | n/a | fpi.nsdl.co.in "Daily Trends in FPI Investments on 08-Oct-2026", fetched 9 Oct 08:50 IST |
| FII index derivatives (NSE) | NIFTY futures: bought 9,688 / sold 17,475 contracts (₹1,409 cr / ₹2,542 cr); all index futures net sell ≈ ₹1,304 cr; EOD NIFTY futures OI 289,875 contracts | — | `archives.nseindia.com/content/fo/fii_stats_08-Oct-2026.xls` |
| Context | 10th straight day of FII cash selling (niftytrader); Oct MTD FII −₹36,210 cr vs DII +₹35,612 cr (5paisa) | | |

**The owner's "₹12,988 crore" does not match any published series; the NSE provisional figure is ₹12,943.58 cr** (a search for "12,988 crore" found nothing). The point stands — heavy FII selling — but note that the figure became public only after the close, and the day's damage was intraday: NIFTY open 22,599.05 (−4 pts vs 22,603.05 close), high 22,599.05 (= open), low 22,179.90, close 22,231.80 (−1.64%); India VIX 13.89 → 15.31 (NSE allIndices, 08-Oct 15:30 stamp). The day's high was the opening print — a pure "sell the open" trend day, which no pre-open indicator would have shown as a gap.

### 6.2 Fri 9 Oct 2026 — pre-market inputs (all with timestamps)
| Input | Value | Time (IST) | Source |
|---|---|---|---|
| GIFT Nifty Oct-26 fut | 22,369 → 22,365 → 22,370 (range since 06:30: 22,326.5–22,392; prev 02:45 close 22,363.5; T-session close 8 Oct 22,255) | 08:52–08:58 | NSE IX API #1/#2/#4 |
| GIFT Nifty Nov-26 fut | 22,423 (last trade 07:31:45; +38.5) | 07:31 | NSE IX API #1 |
| Press readings of GIFT | 22,374 (+80) at 08:04; 22,370 (+79) blog updated 08:44; 22,423 "+0.17%" at 07:44 (Upstox, Nov contract) | | Business Standard live blog (AMP, curl); Upstox |
| NSE NIFTY Oct fut close (8 Oct) | 22,293.20 (basis +61.4 vs spot) | 15:30 8 Oct | NSE F&O bhavcopy |
| **Implied NIFTY open** | **≈22,307 (+75, +0.34%) basis-adjusted; ≈22,345 (+113, +0.5%) change-on-change; naïve +136** | 08:58 | computed, §1.3 |
| US close 8 Oct | S&P 500 7,765.36 (−0.47%); Nasdaq Comp 27,193.34 (−1.25%); Nasdaq-100 30,725.81 (−1.39%); Dow 51,231.64 (+0.10%); driver: FT report that OpenAI annualised revenue ~$20 bn below estimates → chips −3–4% | 01:30 | CNBC/Yahoo (via search summaries, Upstox quoting them); TradingView IXIC 27,193.34 −1.25% |
| US futures | ES 7,832.5–7,833.75 (+0.21–0.22%); NQ 31,047–31,056 (+0.25–0.28%) | 08:52 (Yahoo), 03:30 stamp (TradingView, delayed) | Yahoo quote HTML; TradingView scanner |
| US 10y | 5.231% (−0.4 bp); 30y hit 5.61% Thursday | 04:30 | TradingView; Yahoo live blog |
| Nikkei 225 | 68,512.08 (−0.77%, −530) at 05:30 print; BS: −0.6% (08:04); Reuters/Business Recorder: "more than 1%" later in session | 05:30–08:45 | TradingView; BS; Business Recorder |
| Hang Seng | 24,029.11 (+1.02%, +243) | 07:00 | TradingView (BS/Upstox also +1.09%) |
| Kospi / Taiwan | **closed (Hangul Day; Taiwan National Day observed)** — the "Kospi −2.6%" in Upstox/BS this morning is Thursday's close (KOSPI 6,625.93, −2.62%, stamp 8 Oct) | — | TradingView stamp; Reuters via Business Recorder; KRX/TWSE holiday calendars |
| Shanghai Comp | 3,757.95 (−1.42%) | 07:00 | TradingView (15-min delayed) |
| MSCI Asia ex-Japan | −0.16%, on track for >1% weekly fall | morning | Reuters via Business Recorder |
| Brent | $103.35 (−0.8%) at 07:33; Dec futures $103.847 (−0.82%) per BS; Trump said no strike on Iran before 3 Nov midterms | 07:33–08:44 | Upstox; BS |
| WTI | 90.72 (−0.84%) | 08:52 | Yahoo |
| USDINR | 96.78 (prev: opened 96.71 Thu, RBI intervention suspected) | 03:30 stamp | TradingView; BS 8 Oct |
| India VIX | 15.31 (close 8 Oct, +10.3%) | 15:30 8 Oct | NSE allIndices |
| NIFTY technical context | 22,231.80 is the lowest close since 7 Apr 2025; 9th straight weekly loss at stake; support 22,180–22,200, then 22,000; resistance 22,700 | — | 5paisa, BS (search summaries) |

Reading: a **+0.3–0.5% gap-up is indicated after a −1.64% day**, with US tech weak but futures firmer, oil/yields slightly easier, Hong Kong up and Japan down. Per §4.1 the base rate after a large *down* day's rebound-gap is unremarkable; the decisive input will be the first 15-minute candle, not the gap.

### 6.3 Live check: pre-open indicative vs. actual open (recorded this morning)
(filled in from the 30-second poller; see `scratchpad/poll/log.txt`)

PENDING_LIVE_SECTION

---

## 7. Pre-market checklist (IST) for the engine / the owner

| Time | Check | Where (from §5) | How decisive for the *open* | How decisive for the *day* |
|---|---|---|---|---|
| 18:30–19:30 (prev day) | FII/DII provisional; FII index-futures net; NSE F&O bhavcopy → NIFTY futures close & basis | #7, #8, #10 | none (already in prices) | weak; regime/context only (flow agent) |
| 01:30–02:30 | US cash close (S&P/Nasdaq/Dow), 10y, Brent/WTI, INFY/WIT/HDB ADRs | news; TradingView #11 | medium (sets GIFT's overnight move) | weak (overnight→intraday reversal literature) |
| 02:45 | GIFT Nifty T+1 session close (= API `CLOSE`) | #2 | — | — |
| 06:30 | GIFT Nifty reopens; read Oct contract LTP, compare with NSE futures close → implied gap (basis-adjusted) | #1/#2 vs #10 | **high for direction, ±40 pt for size** | weak |
| 05:30–08:30 | Nikkei, Kospi, ASX, HSI (06:50), Shanghai (07:00); ES/NQ | #11 | low incremental (GIFT already has it) | low; HSI co-movement matters during the day |
| 08:45 | Domestic overnight news (RBI, results, policy), USDINR open (09:00) | news | medium if a domestic shock | medium |
| **09:00–09:05** | NSE pre-open starts; indicative NIFTY from `key=NIFTY`; F&O-segment NIFTY-futures indicative price | #6, #5 | **high and rising** (market orders allowed only to 09:05) | — |
| **09:08–09:10** | Random close; final indicative NIFTY ≈ open; cross-check vs GIFT (should agree within basis) | #6, #1 | **≈ deterministic** | — |
| 09:15 | Open; India VIX open; first-candle begins | #5 | — | — |
| **09:30** | First 15-min candle: size (>0.24%?) and direction relative to gap | engine's own 1-min data | — | **the only input with ~63–73% day-direction agreement** |
| 09:30–09:45 | IV settling; decide entry only if candle decisive; otherwise wait | engine | — | — |

Decisiveness summary: **open** — pre-open indicative (very high) > GIFT at 09:05–09:12 (high) > GIFT at 06:30–08:00 (medium) > US close (medium) > Asia/crude/INR (low, already embedded) > FII/DII (none for the open). **Day direction** — first 15-min candle size+direction (moderate) > gap size base rates (weak, ~45–55%) > everything pre-open (weak).

---

## 8. Sources

Exchange / regulator / primary data
- NSE, Equity market pre-open session (timeline, equilibrium rule, data dissemination incl. indicative NIFTY): https://www.nseindia.com/static/products-services/equity-market-pre-open (fetched 9 Oct 2026)
- NSE, Member FAQs on Pre-open Session in Equity Derivatives (F&O) Segment, v1.0 Nov 2025 (circular NSE/FAOP/71092 dated 3 Nov 2025): https://nsearchives.nseindia.com/web/mediaattachment/2025-12/FAQs_for_PreOpen_Session_in_Equity_Derivatives_FO_Segment_20251202123640.pdf
- NSE live JSON: https://www.nseindia.com/api/allIndices ; https://www.nseindia.com/api/market-data-pre-open?key=NIFTY ; https://www.nseindia.com/api/fiidiiTradeReact
- NSE F&O bhavcopy 8 Oct 2026: https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_20261008_F_0000.csv.zip ; FII derivatives stats: https://archives.nseindia.com/content/fo/fii_stats_08-Oct-2026.xls
- NSE Terms of Use (automated collection prohibited): https://www.nseindia.com/static/nse-terms-of-use
- NSE IX live JSON: https://www.nseix.com/api/market-rate?type=derivative ; https://www.nseix.com/api/streamer-market-watch/ ; https://www.nseix.com/api/streamer-latest-timestamp ; daily bhavcopy https://www.nseix.com/api/content/daily_report/G_T_Bhavcopy_FO_081026.CSV
- NSE IX circulars: NSEIFSC/TRADE/2422 (trading hours 1 Jan 2026) https://www.nseix.com/api/content/circulars/NSEIFSC_TRADE_2422.pdf ; NSEIFSC/TRADE/1734 (NIFTYNXT50/MIDCPNIFTY specs & session times) https://www.nseix.com/api/content/circulars/NSEIFSC_TRADE_1734.pdf ; NSEIFSC/TRADE/2199 (expiry day → last Tuesday) https://www.nseix.com/api/content/circulars/NSEIFSC_TRADE_2199.pdf ; NSEIFSC/TRADE/2129 (consolidated contract specs, 8 May 2025) — 404 from both hosts
- NSDL FPI daily: https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx ; CDSL: https://www.cdslindia.com/eservices/publications/fiidaily
- GIFT Nifty records (NSE IX press via): https://www.businesstoday.in/markets/stocks/story/gift-nifty-hits-record-23-67-billion-single-day-turnover-open-interest-crosses-21-87-billion-558187-2026-09-28 ; https://aninews.in/news/business/gift-nifty-hits-record-usd-2367-bn-turnover-open-interest-crosses-usd-21-bn20260926130855/ ; https://www.motilaloswal.com/news/stocks/129747

Academic / working papers
- Sundararajan & Balasubramanian (2023), "Intraday price discovery and volatility transmission between the dual-listed stock index futures and spot markets – new evidence from India", Int. J. Emerging Markets 20(5): https://ideas.repec.org/a/eme/ijoemp/ijoem-07-2022-1097.html
- "Information Transmission Performance of the GIFT Nifty Futures: Evidence from High-Frequency Data", JRFM 18(9):527 (2025): https://doi.org/10.3390/jrfm18090527 (not readable from container)
- Acharya & Gaikwad (2014), "Pre-open call auction and price discovery: Evidence from India", Cogent Economics & Finance: https://www.tandfonline.com/doi/full/10.1080/23322039.2014.944668
- De Gooijer, Diks & Gatarek (2009/2012), "Information Flows Around the Globe: Predicting Opening Gaps from Overnight Foreign Stock Price Patterns": https://ideas.repec.org/p/ams/ndfwpp/09-13.html
- Della Corte & Kosowski, "Market Closure and Short-Term Reversal": https://www.cicfconf.org/sites/default/files/paper_357.pdf
- Boyarchenko, Larsen & Whelan, "The Overnight Drift", NY Fed Staff Report 917: https://www.newyorkfed.org/medialibrary/media/research/staff_reports/sr917.pdf
- "Dynamic Effects of US and Asian Markets on Indian Stock Market": https://www.researchgate.net/publication/346595090_Dynamic_Effects_of_US_and_Asian_Markets_on_Indian_Stock_Market ; US–India linkages (cites Kumar & Mukhopadhyay 2002): https://www.srcc.edu/system/files/2.pdf
- Statistical modelling of opening gaps (Shanghai, method reference): https://link.springer.com/article/10.1007/s10614-024-10817-9
- IHS Markit, Fair Value Infosys case study (ADR in overnight fair value): https://cdn.ihsmarkit.com/www/pdf/0521/Fair-Value-Infosys-Case-Study.pdf

Backtests with stated method (not peer-reviewed)
- intradaylab, NIFTY gap-up history (2016–Mar 2026, 85 events): https://intradaylab.com/blog/nifty-gap-up-history-analysis
- intradaylab, NIFTY gap-down history (76 events): https://intradaylab.com/blog/nifty-gap-down-history-analysis
- intradaylab, first 15-minute candle study (Jul 2017–Mar 2026, 2,148 sessions): https://intradaylab.com/blog/nifty-first-15-minute-candle-analysis
- Zerodha TradingQnA, gap-filling statistics (user backtest, 0.8% threshold): https://tradingqna.com/t/gap-filling-statistics/151053

Press / broker (today's figures, rule changes)
- Business Standard live blog 9 Oct 2026 (AMP, updated 08:44 IST): https://www.business-standard.com/amp/markets/news/stock-market-live-october-9-nse-bse-sensex-today-nifty50-gift-nifty-crude-oil-prices-it-stocks-today-126100900099_1.html
- Upstox pre-market 9 Oct 2026 (updated 07:55 IST): https://upstox.com/news/market-news/stocks/gift-nifty-futures-indicate-a-positive-opening-on-october-9-key-things-to-know-before-stock-market-opens/article-201557
- CNBC US close 8 Oct 2026: https://www.cnbc.com/2026/10/07/stock-market-today-live-updates-.html ; Yahoo Finance live blog: https://finance.yahoo.com/markets/live/stock-market-today-thursday-october-8-dow-sp-500-nasdaq-080537884.html
- Reuters Asia (via Business Recorder) 9 Oct 2026: https://brecorder.com/news/40443404/tech-stocks-struggle-on-ai-spending-worries-elevated-yields
- 5paisa FII/DII table: https://www.5paisa.com/share-market-today/fii-dii-data ; Trendlyne: https://trendlyne.com/macro-data/fii-dii/latest/ ; Moneycontrol: https://www.moneycontrol.com/markets/fii-dii-data/
- NSE pre-open rule change 7 Sep 2026: https://www.5paisa.com/blog/nse-pre-open-session-rules ; https://www.indmoney.com/blog/stocks/nse-pre-open-session-rules-changes ; https://www.kotakneo.com/news/trading/nse-pre-open-session-new-order-rules-7-september/
- F&O pre-open from 8 Dec 2025: https://www.business-standard.com/markets/capital-market-news/nse-to-commence-pre-opening-session-in-f-o-segment-from-december-08-125110400728_1.html
- GIFT Nifty explainers (no data; used for mechanism/caveats only): https://getbelong.com/blog/gift-nifty-as-an-early-indicator/ ; https://getbelong.com/blog/gift-nifty-basis/ ; https://www.mnclgroup.com/how-gift-nifty-predicts-nifty-50-opening ; https://www.angelone.in/indices/gift-nifty ; https://www.icicidirect.com/equity/index/gift-nifty ; Kite forum (instrument `NSEIX:GIFT NIFTY`, token 291849): https://kite.trade/forum/discussion/comment/49836
- KRX / TWSE holiday 9 Oct 2026: https://www.calendarlabs.com/krx-market-holidays-2026/ ; https://www.biyapay.com/en/blogdetail/2792-us-and-taiwan-stock-market-holidays-summary-with-2
