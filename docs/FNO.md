# Indian index options: the facts the engine depends on

Checked on 7 October 2026; expiry days and lot sizes checked again on 8 October 2026. Each row names where the code encodes it, so a rule change has one place to edit.

| Fact | Where it lives |
|---|---|
| **Weekly expiries.** NIFTY 50 (NSE) expires every Tuesday and SENSEX (BSE) every Thursday. Since November 2024 each exchange has one weekly index expiry. BANK NIFTY, FINNIFTY and MIDCPNIFTY are monthly only. When the expiry day is a holiday, the contract expires on the previous trading day: the engine's calendar gives NIFTY Monday 19 Oct 2026 (Dussehra on the 20th) and SENSEX Wednesday 14 Jan 2026 (15 Jan holiday), matching the exchanges' announcements, and NIFTY Monday 9 Nov and 23 Nov from the holiday list. | `src/engine/config.ts` `indexSpecs` (weekday 2 and 4); `src/engine/calendar/calendar.ts` `expiryOnOrAfter` |
| **Lot sizes** from the January 2026 series: NIFTY 65 (NSE/FAOP/70616 of 3 Oct 2025; 75 before), SENSEX 20 (since November 2024), BANK NIFTY 30. The exchanges review them twice a year to keep a contract's notional value inside SEBI's band. **Announced:** BSE notice 20260930-58 raises SENSEX to **25 for contracts expiring from January 2027** (effective 30 October 2026); nearer SENSEX expiries keep 20. | `indexSpecs` lot sizes (the fallback); at runtime the Groww instrument master (`instrument.csv`) is authoritative, and sizing always uses the contract's own lot. Before the January 2027 weeklies become the nearest SENSEX expiry (about 31 Dec 2026): set the fallback to 25 and re-derive the ₹5k account's SENSEX band in `src/engine/accounts.ts` (₹130–222 is sized for 20 units; at 25 units one lot plus charges stays within ₹4,500 only up to ₹177.70). |
| **Session**: pre-open 09:00–09:15 IST, continuous trading 09:15–15:30 IST. | `src/engine/clock.ts` `SESSION` |
| **2026 trading holidays** include 2 Oct (Gandhi Jayanti), 20 Oct (Dussehra, so the NIFTY weekly moves to Monday 19 Oct) and 10 Nov (Diwali Balipratipada). Muhurat trading is on Sunday 8 Nov. | `src/engine/calendar/holidays.json` (NSE circular list) |
| **Charges per order**: STT 0.15% of premium on the sell side from 1 April 2026 (Budget 2026; 0.10% before), NSE transaction charge 0.03503% and BSE 0.0325% of premium, SEBI fee ₹10 per crore, stamp duty 0.003% on buys, GST 18% on brokerage and fees, ₹20 brokerage per order. | `src/engine/config.ts` `CHARGE_SCHEDULES` (dated, so old backtests keep old rates) |
| **SEBI retail algo framework** (mandatory from 1 April 2026): fewer than 10 orders per second counts as ordinary API use with no strategy registration. API access needs a static IP and two-factor authentication, market orders need market protection, and option premiums are collected upfront. | Live trading only: orders go through the static-IP relay (`relay/`), which sends limit orders with a protection band |
| **Same-day expiry (0DTE)**: gamma and theta are extreme on expiry day, and an at-the-money option can lose most of its value in an hour. | The engine never buys the contract expiring today (`src/engine/strategy/optionSelect.ts`). It stops new entries 90 minutes before the close on an index's own expiry day. |

## What that means for a trading day

- On **Thursday** (SENSEX expiry), the engine trades SENSEX on next week's contract and makes no new SENSEX entries after 14:00.
- On **Monday** the NIFTY contract is one day from expiry (Tuesday). On the Monday of a Tuesday-holiday week, NIFTY itself expires that day, so the engine uses the following week's contract.
- Only option **buying** (ATM CE or PE) is allowed: the loss is capped at the premium and there is no margin call. Writing options needs margin and has unbounded risk, so it is out of scope.

## Sources

- Expiry days: [share.market](https://www.share.market/buzz/insights/weekly-expiry-days-in-indian-fo-markets/), [strota.in](https://strota.in/india-expiry-schedule), [algotest.in](https://algotest.in/blog/sensex-expiry-day/); the 19 Oct 2026 NIFTY shift: [Dhan](https://dhan.co/blog/news/upcoming-fno-expiry-october-2026/) (29 Sep 2026)
- Lot sizes: [NSE circular NSE/FAOP/70616](https://nsearchives.nseindia.com/content/circulars/FAOP70616.pdf) (NIFTY 75 to 65), [algotest.in, NIFTY](https://algotest.in/blog/nifty-lot-size/) (65, updated 5 Oct 2026), [algotest.in, SENSEX](https://algotest.in/blog/sensex-lot-size/) (20, checked 28 Sep 2026; BSE notice 20241021-13), [HDFC Sky](https://hdfcsky.com/news/nse-revises-market-lot-sizes-for-major-index-derivatives-effective-january-2026)
- SENSEX 25 from the January 2027 expiries: [Zerodha bulletin, 7 Oct 2026](https://zerodha.com/marketintel/bulletin/460276/revision-in-market-lot-of-derivative-contracts-on-indices-from-october-30-2026), citing [BSE notice 20260930-58](https://www.bseindia.com/downloads/UploadDocs/Notices/20260930-58/20260930-58.pdf) (the BSE site refused automated reads; confirm against the notice)
- Holidays: [Groww](https://groww.in/p/nse-holidays), [Angel One](https://www.angelone.in/nse-holidays)
- STT: [ClearTax](https://cleartax.in/s/securities-transaction-tax-stt), [HDFC Bank](https://www.hdfc.bank.in/blogs/union-budget/stt-hike-on-f-o-trading)
- Algo framework: [Zerodha, "In the money"](https://inthemoneybyzerodha.substack.com/p/sebi-algo-trading-changes-april-2026), [Sahi](https://www.sahi.com/blogs/sebi-algo-trading-rules-2026-what-every-retail-trader-must-know-before-april)
