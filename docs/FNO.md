# Indian index options: the facts the engine depends on

Checked on 7 October 2026. Each row names where the code encodes it, so a rule change has one place to edit.

| Fact | Where it lives |
|---|---|
| **Weekly expiries.** NIFTY 50 (NSE) expires every Tuesday and SENSEX (BSE) every Thursday. Since November 2024 each exchange has one weekly index expiry. BANK NIFTY, FINNIFTY and MIDCPNIFTY are monthly only. When the expiry day is a holiday, the contract expires on the previous trading day. | `src/engine/config.ts` `indexSpecs` (weekday 2 and 4); `src/engine/calendar/calendar.ts` `expiryOnOrAfter` |
| **Lot sizes** from the January 2026 series: NIFTY 65, SENSEX 20 (BANK NIFTY 30). The exchanges review them twice a year to keep a contract's notional value inside SEBI's band. | `indexSpecs` lot sizes; at runtime the Groww instrument master (`instrument.csv`) is authoritative |
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

- Expiry days: [share.market](https://www.share.market/buzz/insights/weekly-expiry-days-in-indian-fo-markets/), [strota.in](https://strota.in/india-expiry-schedule), [algotest.in](https://algotest.in/blog/sensex-expiry-day/)
- Lot sizes: [algotest.in](https://algotest.in/blog/nifty-lot-size/) (updated 5 Oct 2026), [HDFC Sky](https://hdfcsky.com/news/nse-revises-market-lot-sizes-for-major-index-derivatives-effective-january-2026)
- Holidays: [Groww](https://groww.in/p/nse-holidays), [Angel One](https://www.angelone.in/nse-holidays)
- STT: [ClearTax](https://cleartax.in/s/securities-transaction-tax-stt), [HDFC Bank](https://www.hdfc.bank.in/blogs/union-budget/stt-hike-on-f-o-trading)
- Algo framework: [Zerodha, "In the money"](https://inthemoneybyzerodha.substack.com/p/sebi-algo-trading-changes-april-2026), [Sahi](https://www.sahi.com/blogs/sebi-algo-trading-rules-2026-what-every-retail-trader-must-know-before-april)
