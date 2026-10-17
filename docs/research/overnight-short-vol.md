# Overnight defined-risk short premium (research track E, WP7)

Status: **research only.** This applies to the ₹5L main paper account only. It is **out of scope for the ₹5k/₹10k buy-only accounts** (short legs, margin and overnight risk are excluded by rule) and **for the live engine**, which has no short legs, no margin model and squares off at 15:05. Nothing here changes engine behaviour. A separate, approved design would be needed before any engine work.

Script: `npx tsx scripts/research/overnight_vol.ts`. It reads the bhavcopy cache from `scripts/fetch-bhavcopy.ts`. Results are in `reports/wp7/` and each variant is logged in `reports/trials.jsonl`.

## Rule tested (nothing fitted)

- At the close, sell the ATM straddle of the nearest weekly that does not expire that day.
- Buy wings ±2 (or ±3) strikes away, which makes it an iron fly.
- Buy everything back at the next session's open.
- ATM is the strike nearest the options' own put–call-parity forward at the close. Since 3 Aug 2026 the official index close comes from an auction and sits 0.2–0.8% away from where options trade on 17–26% of days, so it is not used.
- Size: the most lots that keep the expiry max loss (width − credit) ≤ 2% of ₹5L, and the estimated margin ≤ capital.
- Data: NIFTY Feb 2019 – 8 Oct 2026 (1,866 nights); SENSEX May 2023 – 8 Oct 2026 (797 nights).
- Short sessions (Muhurat and DR drills) are excluded.
- No event filter: the repo's event calendar does not cover 2019–2025.

**Margin estimate** (an approximation, not SPAN):

- width × qty (the defined risk);
- plus extreme-loss margin of 2% of the short legs' notional (NSE Clearing);
- plus another 2% on short index options on expiry day (SEBI, from 20 Nov 2024).

The median margin was ₹4.5L for 7 lots (NIFTY ±2). Margin, not the 2% risk cap, is what limits size.

## What "close" and "open" are — the decisive caveat

- **Entry, "close":**
  - NSE: the exchange's closing price. That is the VWAP of the last 30 minutes (15:00–15:30; 15:10–15:40 from 3 Aug 2026), or the last trade if the contract did not trade in that window.
  - BSE: its published close.
  - It is an average, not a 15:05 quote.
- **Exit, "open":** the first trade of each contract.
  - Index options have no pre-open auction; NSE's F&O pre-open covers futures only.
  - So each leg's open is its own first print at or after 09:15:00, in a thin, fast book.
  - The four legs' first prints are not simultaneous.
- **The consequence is measurable.** An iron fly's buy-back value must lie between 0 and the wing width. Yet the sum of the four legs' opening prints falls outside that range on:
  - **321 of 1,866 NIFTY nights (17%)**;
  - **322 of 797 SENSEX nights (40%)**.
- The P&L sign depends on how that artefact is treated:

| NIFTY ±2, engine spread model, 2019–2026 | net ₹ (7.6 years) |
|---|---|
| raw opening prints (impossible debits up to ₹490 on a 100-point fly) | −₹17.3 lakh |
| debit clamped to the no-arbitrage range [0, width] | +₹11.3 lakh (t 4.2) |

On the clamped run, the "gap beyond the wing" nights look profitable. That is impossible for a short fly and is a direct sign of the artefact: the clamp turns impossible negative debits into the maximum profit.

**Conclusion on method:** end-of-day files cannot evaluate close→open for a multi-leg structure. They can neither confirm nor reject rule E. An honest test needs synchronous intraday quotes (bid/ask snapshots at 15:05 and 09:20), for example from the broker's historical option candles or a recorded paper feed.

## Results anyway (read with the caveat above)

Capital ₹5L. Engine spread model = max(1 tick, 0.4% of premium), half paid on each leg each way. Charges are computed per order at the dated schedule.

t is for the mean per-unit P&L after spreads.

| index, wings, exit | nights | net ₹ total | mean ₹/night | t | hit | worst night | max DD |
|---|---|---|---|---|---|---|---|
| NIFTY ±2, next open (clamped) | 1,866 | +11.3 lakh | +607 | 4.2 (gross/unit) | 45% | −₹13,733 | ₹3.9 lakh |
| NIFTY ±3, next open (clamped) | 1,861 | −0.2 lakh | −11 | 1.1 (gross/unit) | 44% | −₹17,095 | ₹4.1 lakh |
| SENSEX ±2, next open (clamped) | 797 | +5.1 lakh | +637 | 5.0 (gross/unit) | 40% | −₹10,822 | ₹1.4 lakh |
| SENSEX ±3, next open (clamped) | 798 | −0.9 lakh | −117 | 1.4 (gross/unit) | 39% | −₹12,112 | ₹3.5 lakh |
| NIFTY ±2, next-day VWAP | 1,733 | +41.9 lakh | +2,415 | 24.8 (gross/unit) | 70% | −₹16,316 | ₹0.6 lakh |
| SENSEX ±2, next-day VWAP | 751 | +15.0 lakh | +1,995 | 15.6 (gross/unit) | 64% | −₹10,306 | ₹0.6 lakh |

### Reading the table

- **Years: 2024–2026 were flat to negative** even with the clamp:
  - NIFTY ±2: −₹1.2 lakh in 2024, +₹0.4 lakh in 2025, −₹1.0 lakh in 2026;
  - SENSEX ±2: −₹0.9 lakh in 2026.
  - The positive total comes from 2020–2023.
- **Gaps:** nights with a small gap (90% of nights, |gap| < 0.86%) earned ≈ ₹0 on NIFTY. The total is carried by the top-decile gap nights, which is exactly where the opening-print artefact is largest.
- **Weekends:** weekend/holiday nights earn more per night than weekday nights:
  - NIFTY +₹1,474 against +₹335;
  - SENSEX +₹1,446 against +₹383.
  - This fits the pattern of options barely decaying over weekends while VIX counts calendar time.
- **Wings:** ±3 is worse than ±2 net of spreads. The wider wings cost more spread, and the net is ≈ 0.
- **VWAP exit:** the next-day-VWAP exit is not the rule.
  - It holds through the morning, so it earns morning time decay plus intraday risk.
  - It assumes executing four legs at their day VWAPs.
  - It agrees with the replication in `reports/wp6-real-prices.md`: ATM straddles lose 8–13% from the close to the next day's VWAP, and most of that is trading-hours decay. That is a statement about intraday selling, not about overnight premium.
- **Unhedged straddle:** an unhedged short ATM straddle from close to next open, gross per unit of premium, has:
  - NIFTY: mean +0.2% (t 0.5), worst −439%;
  - SENSEX: mean −1.3% (t −2.0), worst −284%.
  - Uncapped tails are why only defined-risk structures were considered.

### Tails

- Defined risk caps the loss per night at about the 2% budget plus costs.
- The worst clamped NIFTY nights were −₹12k to −₹14k, all in March–November 2020.
- Without wings, single nights cost 2.8–4.4× the premium.
- On election-result and COVID-gap days (2020-04-03, 2024-06-04) the index gapped 3.5–4.5%, beyond any ±2/±3 wing.

## Go / no-go

**No-go for implementation. Keep it as a research question.**

1. End-of-day data cannot measure the rule. The exit prices are asynchronous first prints, and the sign of the result depends on how impossible prints are handled.
2. Even on the favourable treatment, 2024–2026 (the period that matters) is flat to negative after realistic spreads.
3. The structure needs short legs, about ₹4–5L of margin for 7 lots, overnight risk, and a gate for RBI/FOMC/budget nights. None of this exists in the engine.

**Next step if the owner wants to pursue it:** record synchronous 15:05 and 09:20 bid/ask snapshots for the ATM ±3 strikes for three or more months, in paper mode only. Then re-run this script on those quotes and judge it against the §5 protocol (at least 180 nights, placebo, bootstrap, deflated Sharpe).
