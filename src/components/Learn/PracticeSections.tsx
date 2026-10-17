/**
 * /learn sections 5–8: how the site's "What to do now" advice works, reading an option chain, risk and
 * sizing, and what the data does support. Engine values are from src/engine/config.ts,
 * src/engine/accounts.ts, src/engine/strategy/gates.ts and src/lib/copy/action.ts.
 */
import Link from "next/link";
import { C } from "@/components/shared/colors";
import { Callout, Card, CardTitle, DefTable, Fact, GuideSection, linkStyle, P, Points, Src, Tag } from "./parts";
import s from "./learn.module.css";

const ACTIONS: { word: string; color: string; solid?: boolean; what: string }[] = [
  { word: "ENTER NOW", color: C.green, solid: true, what: "The engine opened a paper trade in the last 10 minutes, the index has not passed the skip level, and the live price is fresh. The exact order and levels are shown." },
  { word: "ENTER", color: C.green, what: "Nothing is open, but the engine's live reading says it would buy now: every check passes except the measured-edge check that pauses its book. Same order and levels; the engine books nothing." },
  { word: "WAIT", color: C.muted, what: "No entry. It shows the main reason, and what would have to change for one." },
  { word: "PAUSED", color: C.orange, what: "There is a trade, but the live price (or the engine's data) is stale. Never enter on old data." },
  { word: "MANAGE", color: C.blue, what: "A trade is open but older than 10 minutes, or the index already ran past the skip level: don't chase it." },
  { word: "EXIT NOW", color: C.red, solid: true, what: "The engine closed the trade in the last 10 minutes, or 15:05 square-off has come." },
];

const CHECKS: [string, string][] = [
  ["Conviction", "The engine's combined signal must be beyond its threshold for the market's regime."],
  ["Entry window", "No new entry before 09:25 or after 14:30, and none in the last 90 minutes of an expiry day."],
  ["Data freshness", "Market data no older than 300 seconds."],
  ["Scheduled events", "No entry 15 minutes before a scheduled event or within 5 minutes after it."],
  ["Spread", "The option's bid–ask spread at most 1.5% of its price."],
  ["Open interest", "At least 50,000 contracts open in the strike, so it can be exited."],
  ["Edge vs time decay", "The expected move, after theta and charges, worth at least 10% of the premium."],
  ["Measured-edge pause", "The same check with the move actually measured: the index moved only 0.54× what implied volatility charged (WP2). This check is what pauses buying."],
];

const EXITS: { k: string; main: string; small: string; what: string }[] = [
  { k: "Stop", main: "−30%", small: "−35%", what: "Sell if the premium falls this far below the entry." },
  { k: "Target", main: "+50%", small: "+60%", what: "Sell when the premium rises this far." },
  { k: "Trailing stop", main: "from +30%", small: "from +30%", what: "Once the premium is 30% up, give back at most half of the best gain." },
  { k: "Time stop", main: "60–180 min", small: "60–180 min", what: "If the trade is still below +10% after its time (by market regime), close it." },
  { k: "Square-off", main: "15:05", small: "15:05", what: "Everything is closed. Nothing is held overnight." },
];

export function AdviceExplained() {
  return (
    <GuideSection
      id="advice"
      n={5}
      title={<>How &ldquo;What to do now&rdquo; works</>}
      lead="The Copy page turns the paper engine's decisions into one word per index. It only ever says what the engine would do; it is a measuring tool, and the engine has no proven edge."
    >
      <div className={s.cols2}>
        {ACTIONS.map((a) => (
          <Card key={a.word}>
            <div style={{ marginBottom: 8 }}>
              <Tag color={a.color} solid={a.solid}>
                {a.word}
              </Tag>
            </div>
            <P style={{ fontSize: 14 }}>{a.what}</P>
          </Card>
        ))}
      </div>
      <Callout title="Too late to copy: the skip level">
        Every trade carries a skip level: half of the expected move past the entry, in the trade&apos;s direction. If the index is already beyond it, half the move has
        happened. Skip the trade; don&apos;t chase it. A trade is only shown as ENTER NOW for its first 10 minutes. <Src>engine copy tickets</Src>
      </Callout>
      <Card style={{ padding: 0 }}>
        <div style={{ padding: "14px 18px 6px" }}>
          <CardTitle>The checks every entry must pass</CardTitle>
        </div>
        <div>
          {CHECKS.map(([k, v]) => (
            <div key={k} className={s.checkRow}>
              <div style={{ fontWeight: 650, color: C.textStrong }}>{k}</div>
              <div style={{ color: C.textSoft }}>{v}</div>
            </div>
          ))}
        </div>
      </Card>
      <Card style={{ padding: 0 }}>
        <div style={{ padding: "14px 18px 6px" }}>
          <CardTitle>The exits it manages by</CardTitle>
        </div>
        <div>
          {EXITS.map((e) => (
            <div key={e.k} className={s.exitRow}>
              <div style={{ fontWeight: 650, color: C.textStrong }}>{e.k}</div>
              <div className="tnum" style={{ fontFamily: "var(--font-num)", color: C.textStrong }}>
                <span style={{ color: C.muted2, fontSize: 12 }}>Main</span> {e.main} <span style={{ color: C.muted3 }}>·</span>{" "}
                <span style={{ color: C.muted2, fontSize: 12 }}>₹10k</span> {e.small}
              </div>
              <div style={{ color: C.textSoft }}>{e.what}</div>
            </div>
          ))}
        </div>
      </Card>
      <P>
        See it live: <Link href="/copy" style={linkStyle}>Copy trade</Link> for the order and levels, <Link href="/options" style={linkStyle}>Option chain</Link> for the
        strikes, and the <Link href="/" style={linkStyle}>Desk</Link> for Today&apos;s plan.
      </P>
    </GuideSection>
  );
}

export function ReadingChain() {
  return (
    <GuideSection
      id="chain"
      n={6}
      title="Reading an option chain"
      lead="A chain lists every strike's call and put with its price, volume and open interest. It tells you what is being traded and what it costs, not where the index goes next."
    >
      <DefTable
        head={["Column", "What it tells you", "What it does not predict"]}
        rows={[
          [
            "Open interest (OI)",
            "How many contracts are open at a strike. High OI means you can get in and out; the engine wants at least 50,000.",
            "Where the index stops. OI “build-up” labels showed nothing in tests. (R3)",
          ],
          [
            "Change in OI",
            "Positions opened or closed today at that strike.",
            "Who is right. Every contract has a buyer and a seller.",
          ],
          [
            "PCR (put–call ratio)",
            "Put OI divided by call OI: how the market is hedged.",
            "Intraday direction. Published evidence is only for 12-day-plus horizons (2001–2013), and the sign was not reported. (R3)",
          ],
          [
            "Max pain",
            "The strike where option buyers would lose most at expiry.",
            "Anything: one 19-expiry check did worse than predicting no change. (R3)",
          ],
          [
            "IV and IV skew",
            "Implied volatility per strike. Puts below the market usually carry more IV, because hedgers buy them.",
            "A trade. Put spreads were priced at about their average payout: 16.9% of the width taken in, 16.3% paid out. (WP16)",
          ],
          [
            "Volume",
            "Contracts traded today. 59% of index-option turnover is on expiry day; beyond 7 days only 3%.",
            "Direction. Thin far-dated strikes need limit orders. (R1, R2)",
          ],
          [
            "Bid / ask",
            "The best price to sell at and to buy at. The gap is a cost you pay on every trade.",
            "Value. A wide spread (over 1.5%) and the engine skips the strike.",
          ],
        ]}
      />
      <Callout color={C.blue} title="Positioning didn't predict NIFTY">
        WP14 tested FII positioning from NSE&apos;s participant-wise open interest, 3,655 daily files from 2012 to 2026. All 12 index picks failed out of sample. Buying the
        matching option lost ₹532–880 a lot a trade, where a random side lost ₹549–652. Read OI and flows as context, never as a signal. <Src>WP14</Src>
      </Callout>
    </GuideSection>
  );
}

export function RiskSizing() {
  return (
    <GuideSection
      id="risk"
      n={7}
      title="Risk and sizing"
      lead="With a small account a single option lot is already a large bet. Caps on loss per trade, per day and per week are what keep one bad week from ending the account."
    >
      <div className={s.cols3}>
        <Fact value="1 lot" label="the most a ₹10,000 account can buy: one lot costs about ₹2,600–4,550 (NIFTY ₹40–70 × 65, SENSEX ₹130–210 × 20)" src="engine ₹10k account" />
        <Fact value="≈ 9–16%" label="of ₹10,000 lost when one lot hits its −35% stop (₹910–1,590), before charges" src="engine ₹10k account" color={C.red} />
        <Fact value="72%" label="of the small-account band options expired worthless; 7% returned 5× or more. A lottery ticket." src="Q1, real prices 2024–2026" color={C.red} />
      </div>
      <div className={s.cols2}>
        <Card>
          <CardTitle>The paper accounts&apos; caps</CardTitle>
          <Points
            items={[
              <>Main: 0.75% of capital at risk a trade, daily loss cap 3%, weekly 6%, stop after 2 losses in a day, at most 4 trades a day.</>,
              <>₹10k: one lot, one position at a time across NIFTY and SENSEX, daily loss cap 25%, weekly 40%, at most 3 trades a day.</>,
              <>
                If copying with real money anyway, the plan&apos;s limit: ≤ ₹1,500 a day, one lot, stop after one loss. <Src>plan §13</Src>
              </>,
            ]}
          />
        </Card>
        <Card>
          <CardTitle>Habits that cost the most</CardTitle>
          <Points
            items={[
              <>
                <b>Never average down.</b> The engine never adds to a position: one per index. Holding a losing trade past the close made it worse by ₹739 a NIFTY lot.{" "}
                <Src>Q1</Src>
              </>,
              <>
                <b>No overnight holds.</b> On 12–26% of nights the call&apos;s next-morning price was already more than 30% below entry, so the stop was gapped through. Worst
                nights: −₹11,000 to −₹14,000 a lot. <Src>WP15, N5</Src>
              </>,
              <>
                <b>Don&apos;t overtrade.</b> Traders active more than 100 days a year are 42% of traders and 87% of the losses. <Src>R1</Src>
              </>,
            ]}
          />
        </Card>
      </div>
    </GuideSection>
  );
}

export function IndexHolding() {
  return (
    <GuideSection
      id="index"
      n={8}
      title="What the data does support"
      lead="Profit from NIFTY has come from holding the index for years, not from timing it with options. This describes the data; it is not a recommendation."
    >
      <div className={s.cols3}>
        <Fact value="8.8% a year" label="NIFTY price index, 4,495 (17 Sep 2007) to 22,232 (8 Oct 2026), dividends excluded; 8.5% a year since 2011" src="plan §13" color={C.green} />
        <Fact value="1.4%" label="of all five-year holds in that history ended lower; the worst lost 11%" src="plan §13" />
        <Fact value="4.0% vs 9.9%" label="a year: the 50/200-day moving-average crossover against buy-and-hold (2010–2022)" src="plan §8" />
      </div>
      <Card>
        <CardTitle color={C.red}>The price of that return: deep falls that can last years</CardTitle>
        <div className={s.cols3} style={{ marginTop: 8 }}>
          {[
            ["−59.9%", "Jan to Oct 2008"],
            ["−38.4%", "early 2020"],
            ["−51.8% · −24.6%", "calendar 2008 · 2011"],
            ["−14.9%", "2026 so far (to 8 Oct)"],
          ].map(([v, l]) => (
            <div key={l} style={{ minWidth: 0 }}>
              <div className="tnum" style={{ fontFamily: "var(--font-num)", fontSize: 20, fontWeight: 600, color: C.red }}>
                {v}
              </div>
              <div style={{ fontSize: 13, color: C.textSoft }}>{l}</div>
            </div>
          ))}
        </div>
        <P style={{ marginTop: 12 }}>
          It is the market&apos;s return, not an edge. Anyone who must sell in a fall, or uses borrowed money, can lose. The usual route is a NIFTY 50 index fund or ETF, held
          for years: a small annual fee, against ₹56–71 of charges on every option round trip. <Src>plan §13</Src>
        </P>
      </Card>
      <Callout color={C.muted} title="Not investment advice">
        This page is education drawn from this project&apos;s own research. It is not SEBI-registered investment advice, and Ruphak Trading Info is not a SEBI-registered
        investment adviser or research analyst. Whether anything here suits you depends on your horizon and situation.
      </Callout>
    </GuideSection>
  );
}
