/**
 * /learn sections 1–4: the honest answer, how an option is priced, when premium is rich, and the
 * no-trade rules. Every figure is from docs/research/options-trading-plan.md, its notes and reports/.
 */
import { C } from "@/components/shared/colors";
import { Bars, Callout, Card, CardTitle, Fact, GuideSection, P, Points, Src, Tag } from "./parts";
import s from "./learn.module.css";

export function HonestAnswer() {
  return (
    <GuideSection
      id="answer"
      n={1}
      title="The honest answer first"
      lead="Most people who buy NIFTY and SENSEX options lose money, and nothing this project tested gives a buyer an edge. That is the starting point for everything below."
    >
      <div className={s.cols2}>
        <Fact value="87.7%" label="of individual F&O traders lost money in FY26, ₹91,685 crore in total" src="SEBI study, Aug 2026 (plan §1)" color={C.red} />
        <Fact value="−114%" label="median return on capital for a trader who only bought options in FY26 (−187% in FY25)" src="SEBI, Aug 2026 (plan §2)" color={C.red} />
        <Fact value="92%" label="of those losses came from options; 97% of individuals mostly buy them" src="SEBI, Aug 2026 (plan §1)" />
        <Fact value="3,303" label="strategy variants this project tested on real prices. None passes the bar for real money." src="plan §15, reports/trials.jsonl" />
      </div>
      <Card>
        <CardTitle>Who is on the other side</CardTitle>
        <P>
          99% of the profit went to firms that trade by algorithm, mostly market makers and net option sellers. They earn the bid–ask spread a retail buyer pays, and the time
          decay the buyer loses. <Src>R1</Src>
        </P>
      </Card>
      <Card>
        <CardTitle>What our own tests found</CardTitle>
        <Points
          items={[
            <>
              On real exchange prices (2024–2026) an at-the-money NIFTY weekly bought at the open and sold at the close lost <b>₹547 a lot</b> on average; 37% of trades made
              money. Held to expiry it lost <b>₹1,153</b>, and half expired worthless. <Src>Q1</Src>
            </>,
            <>
              With perfect hindsight on direction, the same option made +₹3,027. <b>Direction is everything, and nothing we tested predicts it.</b> <Src>plan §1</Src>
            </>,
            <>
              On real 1-minute option prices, 2021–2026: the first-candle rule lost ₹679 a NIFTY lot a trade over 363 trades; noise-area momentum lost ₹355; the opening-range
              breakout lost ₹477. None picked its side better than a random side at the same minute. <Src>WP11</Src>
            </>,
          ]}
        />
      </Card>
      <Callout color={C.red} title="Buying is paused">
        Since 9 Oct 2026 every paper account runs with the measured-edge check on, which stops the engine buying. The research&apos;s answer for real money is: no real money
        into options until a rule passes on data it was not fitted to. <Src>plan §13, §15</Src>
      </Callout>
    </GuideSection>
  );
}

export function HowPriced() {
  return (
    <GuideSection
      id="pricing"
      n={2}
      title="How an option's price works"
      lead="A premium has two parts. One part is what the option is worth if it expired now; the rest is what you pay for the chance the index moves. That second part melts every minute."
    >
      <div className={s.cols2}>
        <Card>
          <CardTitle>Intrinsic value and time value</CardTitle>
          <P>
            Intrinsic value is how far the option is already in the money. Example: with NIFTY at 22,300, a 22,250 call has ₹50 of intrinsic value; anything you pay above
            that is time value. An out-of-the-money option is all time value. At expiry the time value is zero.
          </P>
        </Card>
        <Card>
          <CardTitle>Lot sizes</CardTitle>
          <P>
            You buy whole lots: <b>NIFTY 65 units</b>, <b>SENSEX 20 units</b>. A ₹50 NIFTY premium costs ₹3,250 a lot. SENSEX&apos;s lot rises to 25 for January 2027
            expiries. <Src>engine config, plan §7</Src>
          </P>
        </Card>
      </div>
      <Bars
        caption="Theta: share of the premium an at-the-money option lost in a single session, by how close expiry was"
        max={20}
        bars={[
          { label: "2–5 sessions left (NIFTY)", value: 4.6, text: "4.6%" },
          { label: "2–5 sessions left (SENSEX)", value: 7.0, text: "7.0%" },
          { label: "1 session left", value: 10.6, text: "10.6%", color: C.orange },
          { label: "Expiry day", value: 19, text: "19%", color: C.red },
        ]}
        src="Q1, real NSE and BSE prices, bought at the open and sold at the close, 2024–2026"
      />
      <P>
        Decay speeds up at the end. Thirty minutes before expiry an at-the-money premium is typically a fifth or less of the previous day&apos;s close <Src>R1, SEBI</Src>. A flat
        session costs a NIFTY lot about ₹416 with 2 days left, ₹250 with 6 and ₹221 with 8 <Src>R2, model</Src>. That is why the plan never buys a contract with one session or
        less left.
      </P>
      <div className={s.cols2}>
        <Card>
          <CardTitle>Implied volatility, and the crush after events</CardTitle>
          <P>
            IV is the size of move the price assumes. NIFTY&apos;s implied volatility was above the volatility that followed on 74.9% of days (Aug 2022–Mar 2026) <Src>R2</Src>:
            buyers usually pay for more movement than happens. Before scheduled events IV is bid up, then collapses: India VIX fell on Budget day in 15 of 15 Budgets (−9.3% on
            average), and a straddle bought the evening before each of the last 3 Budgets lost 41–80%. <Src>R2, Q1</Src>
          </P>
        </Card>
        <Card>
          <CardTitle>Delta</CardTitle>
          <P>
            Delta is how much the premium moves for a 1-point index move, and roughly the chance the option ends in the money: about 0.5 at the money; about 0.3 for a strike 200
            points out with 6 days left; about 0.1 for the same strike with 1 day left. <Src>R2</Src> The plan&apos;s choice, if buying at all: at the money or one strike in the
            money (delta 0.5–0.7). <Src>plan §7</Src>
          </P>
        </Card>
      </div>
      <Card style={{ padding: 0 }}>
        <div style={{ padding: "14px 18px 4px" }}>
          <CardTitle>In, at or out of the money</CardTitle>
        </div>
        <div className={s.cols3} style={{ padding: "4px 18px 16px" }}>
          {[
            { k: "In the money (ITM)", c: C.green, t: "More intrinsic value, less decay per rupee. On real prices, 1-strike-ITM weeklies lost the least sold at the close: −₹486 a NIFTY lot, 40% profitable.", src: "Q1" },
            { k: "At the money (ATM)", c: C.blue, t: "The most time value in rupees and the most sensitive to the index. −₹547 a lot on average for a same-day trade.", src: "Q1" },
            { k: "Out of the money (OTM)", c: C.red, t: "Cheap, but the highest decay per rupee, the widest spreads and the worst returns. 62% of options two strikes out expired worthless when held.", src: "Q1, R1" },
          ].map((x) => (
            <div key={x.k} style={{ borderTop: `3px solid ${x.c}`, paddingTop: 10, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 650, color: C.textStrong, marginBottom: 4 }}>{x.k}</div>
              <div style={{ fontSize: 13.5, lineHeight: 1.55, color: C.textSoft }}>
                {x.t} <Src>{x.src}</Src>
              </div>
            </div>
          ))}
        </div>
      </Card>
      <div className={s.cols2}>
        <Fact value="₹56–71" label="charges on every option round trip tested here (brokerage, GST, STT of 0.15% of premium on the sale, exchange fees, stamp), before the spread" src="plan §13, R1" />
        <Fact value="≈ 9 / 31 pts" label="the break-even index move the plan sets for one NIFTY / SENSEX trade, before charges" src="plan §6, E3" />
      </div>
      <Card>
        <CardTitle>The bid–ask spread</CardTitle>
        <P>
          You buy at the ask and sell at the bid; the gap goes to the market maker on every trade. Real weekly at-the-money spreads are typically 1–3 ticks on NIFTY and wider on
          SENSEX <Src>strategy plan</Src>; far-out-of-the-money strikes have the widest. Costs were 35% of losing traders&apos; gross losses in FY26. <Src>R1</Src> Always use
          limit orders.
        </P>
      </Card>
    </GuideSection>
  );
}

export function PremiumTiming() {
  return (
    <GuideSection
      id="timing"
      n={3}
      title="When premium is richest, and when it is cheapest"
      lead="The same option costs very different amounts at different minutes of the day. The day's first prints are the most expensive of all."
    >
      <Bars
        caption="How far the at-the-money straddle's price sits above the day's average price, by time of day (median)"
        max={16}
        bars={[
          { label: "First trade, NIFTY", value: 7.4, text: "+7.4%", color: C.red },
          { label: "First trade, SENSEX", value: 15.0, text: "+15.0%", color: C.red },
          { label: "09:15 close (NIFTY / SENSEX)", value: 5.3, text: "+5.3% / +9.2%", color: C.orange },
          { label: "09:30 (both)", value: 4.3, text: "+4.3% / +6.2%" },
          { label: "11:15 (both)", value: 2.0, text: "+2.0% / +3.0%" },
          { label: "15:00 (both)", value: -1.5, text: "−1.5% / −1.6%" },
        ]}
        src="WP11, real 1-minute prices to Dec 2024 (NIFTY / SENSEX)"
      />
      <div className={s.cols3}>
        <Fact value="2.7×" label="An hour's hold bought at 09:15 cost ₹2,176 a NIFTY lot, against ₹818 bought at 09:30 (SENSEX ₹2,352 vs ₹827)" src="WP11, 2021–2026" color={C.red} />
        <Fact value="₹109–276" label="what an hour costs a straddle buyer at any time after 09:30" src="WP11" />
        <Fact value="15%" label="of the premium lost in the 14:00–15:00 hour on expiry day, the worst hour of all" src="WP11" color={C.red} />
      </div>
      <div className={s.cols2}>
        <Card>
          <CardTitle>The morning moves most</CardTitle>
          <P>
            The first hour holds 30% of the day&apos;s movement in 16% of the time (719 sessions). From 11:15 to 14:15 the index moves only about 0.7× what the decay costs.
            India VIX made its daily high in the first hour on 61% of sessions. <Src>Q1</Src>
          </P>
        </Card>
        <Card>
          <CardTitle>Expiry days</CardTitle>
          <P>
            59% of index-option turnover is on expiry day <Src>R1, SEBI</Src>. Selling on expiry afternoon did not pass either: the worst NIFTY expiry lost ₹13,725 a lot
            (7 Aug 2025). <Src>WP13</Src>
          </P>
        </Card>
        <Card>
          <CardTitle>Event days</CardTitle>
          <P>
            Premium is rich before scheduled events (Budget, RBI, election results, US data) and falls on the day. The exceptions are violent: the 4 Jun 2024 election result moved
            a straddle +126%, and cost a seller ₹22,500 a lot; the 8 Apr 2026 RBI day cost ₹19,000. <Src>Q1, WP13</Src>
          </P>
        </Card>
        <Card>
          <CardTitle>Not Monday mornings</CardTitle>
          <P>
            India VIX reads about 3.8% higher on Monday mornings only because it counts the weekend as time passing. Monday straddles did no worse than other days (−₹1,108 vs
            −₹1,104). <Src>Q1</Src>
          </P>
        </Card>
      </div>
    </GuideSection>
  );
}

const RULES: { n: string; title: string; why: string; src: string }[] = [
  { n: "N1", title: "No new position the session before a scheduled event, and none in the 30 minutes either side of it.", why: "Premium is bid up before and falls on the day (VIX fell on 15 of 15 Budget days).", src: "R2, Q1" },
  {
    n: "N2",
    title: "No entry after a volatility jump or a big run.",
    why: "India VIX up more than 10% over 5 sessions or 8% in a day, VIX in the top third of its year, or the index more than 2% from 5 sessions ago. A straddle bought after a VIX jump lost ₹2,269, against ₹1,104 on an average day.",
    src: "Q1",
  },
  { n: "N3", title: "Morning only: enter after 09:30, be out by 11:15.", why: "The only window where the index moved more than the decay it cost. The engine's six 11:00–13:00 entries all lost.", src: "Q1, R4" },
  { n: "N4", title: "Never buy a contract with one session or less left.", why: "It lost 10.6% of premium in a session (19% on expiry day) vs 4.6–7.0% with 2–5 left. On Mondays use next week's NIFTY; on Wednesdays next week's SENSEX.", src: "Q1" },
  { n: "N5", title: "No overnight or weekend holds.", why: "The overnight gap is 55% of NIFTY's daily variance, and no stop can fill while the market is shut.", src: "Q1, WP15" },
  { n: "N6", title: "No far out-of-the-money strikes because they are cheap.", why: "Worst returns per rupee; two-thirds expire worthless if held.", src: "R1, R2" },
  { n: "N7", title: "No new entry on an index's own expiry day after 14:00, and never the contract expiring that day.", why: "Expiry-day gamma and settlement games.", src: "R1" },
  { n: "N8", title: "No buying puts the morning after a big fall “because FIIs sold”.", why: "FII flows are published after the close; correlation with the next day's move: 0.00 over 1,877 days. After NIFTY falls of 1.5% or more, the next day was up 64% of the time.", src: "R3, Q2" },
  { n: "N9", title: "Don't trade the gap itself.", why: "The gap is known by 09:10 and already in the price. Gap-up days closed above their open 48% of the time (1,639 days).", src: "R4, Q2" },
];

const WINDOWS: { from: string; to: string; label: string; color: string; why: string }[] = [
  { from: "09:15", to: "09:30", label: "Avoid · opening minutes", color: C.orange, why: "The day's richest premium." },
  { from: "09:30", to: "11:15", label: "Entry window · morning", color: C.green, why: "Only part of the day the index out-moved the decay." },
  { from: "11:15", to: "14:15", label: "Avoid · midday", color: C.orange, why: "Index moves about 0.7× the decay." },
  { from: "14:15", to: "15:05", label: "Avoid · afternoon", color: C.orange, why: "No new entries; expiry-day 14:00–15:00 costs 15%." },
  { from: "15:05", to: "15:30", label: "Square-off", color: C.muted, why: "Everything closed: no overnight holds." },
];

export function NoTrade() {
  return (
    <GuideSection
      id="no-trade"
      n={4}
      title="When not to enter"
      lead="These nine rules remove the most expensive trades. They cut losses; they do not create a profit. The Desk's Today's plan checks N1, N2, N4, N7 and N9 for each session."
    >
      <div className={s.timeline}>
        {WINDOWS.map((w) => (
          <div key={w.from} style={{ border: `1px solid color-mix(in srgb, ${w.color} 35%, transparent)`, background: `color-mix(in srgb, ${w.color} 7%, transparent)`, borderRadius: 10, padding: "10px 12px", minWidth: 0 }}>
            <div className="tnum" style={{ fontSize: 13, fontWeight: 700, color: C.textStrong, fontFamily: "var(--font-num)" }}>
              {w.from}–{w.to}
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: w.color, textTransform: "uppercase", letterSpacing: "0.04em", marginTop: 3 }}>{w.label}</div>
            <div style={{ fontSize: 12, color: C.textSoft, marginTop: 4, lineHeight: 1.45 }}>{w.why}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12.5, color: C.muted2, marginTop: -6 }}>
        Session windows, as the Desk&apos;s Today&apos;s plan shows them (IST). <Src>plan §4 N3, §5, §11</Src>
      </div>
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, boxShadow: "var(--shadow-card)", overflow: "hidden" }}>
        {RULES.map((r, i) => (
          <div key={r.n} style={{ display: "grid", gridTemplateColumns: "44px minmax(0, 1fr)", gap: 12, padding: "13px 18px", borderTop: i === 0 ? "none" : `1px solid ${C.borderSoft}` }}>
            <div style={{ paddingTop: 1 }}>
              <Tag color={C.red}>{r.n}</Tag>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14.5, fontWeight: 650, color: C.textStrong, lineHeight: 1.45 }}>{r.title}</div>
              <div style={{ fontSize: 13.5, color: C.textSoft, lineHeight: 1.55, marginTop: 3 }}>
                {r.why} <Src>{r.src}</Src>
              </div>
            </div>
          </div>
        ))}
      </div>
    </GuideSection>
  );
}
