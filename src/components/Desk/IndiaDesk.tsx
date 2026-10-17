"use client";

import Link from "next/link";
import { useEngineState } from "@/hooks/useEngineState";
import IndexActionStrip from "@/components/Copy/ActionStrip";
import SetupBoard from "@/components/Setups/SetupBoard";
import RecoCard from "@/components/Reco/RecoCard";
import TradeBlotter from "@/components/Blotter/TradeBlotter";
import OpenNow, { linkStyle } from "@/components/Engine/OpenNow";
import PnlSection from "@/components/Engine/PnlSection";
import SafetyStrip, { MarketStatus } from "@/components/Engine/SafetyStrip";
import TodaysTrades from "@/components/Engine/TodaysTrades";
import { isAgentAccount } from "@/components/Engine/engineView";
import { C } from "@/components/shared/colors";
import { fmtIstDay } from "@/components/shared/format";
import { Disclosure, PageHeader } from "@/components/shared/ui";
import ConnectionBanner from "./ConnectionBanner";
import EngineControls from "./EngineControls";
import EngineStatusBar from "./EngineStatusBar";
import SignalConsole from "./SignalConsole";
import TodayPlan from "./TodayPlan";

/** The page's opening line for the options agent's paper account, which follows none of main's buying rules. */
export function AgentDeskIntro() {
  return (
    <>
      The options agent&apos;s paper account: a model judges each candle and code decides every order; see{" "}
      <Link href="/agent" className="link-quiet" style={linkStyle}>
        /agent
      </Link>
      .
    </>
  );
}

/**
 * The Paper Engine page ("/"): is it running and safe, what to do now, the ₹10k card, the trade
 * setups, what is open, the P&L and today's trades. The reasoning (today's plan and each signal) and
 * the book, controls and health sit in two collapsed areas. Market data and news live on the Options
 * and Geo Intel pages. `account`: the paper account from `?account=` (undefined: main). The options
 * agent's account shows its own book only: the ₹10k card and the setups are main's, so they are left out.
 */
export default function EngineDesk({ account }: { account?: string }) {
  const { state, status } = useEngineState();
  const dim = status === "offline" ? 0.55 : status === "stale" ? 0.85 : 1;
  const follower = state?.account && state.account.id !== "main" ? state.account : null;
  const agent = isAgentAccount(account, state) || state?.account?.kind === "agent";
  return (
    <div id="desk" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 32, minWidth: 0 }}>
      <PageHeader
        eyebrow={state ? `${fmtIstDay(state.market.nowIst)}${follower ? ` · ${follower.label}` : ""}` : "Paper trading"}
        title="Paper trading engine"
        sub={
          agent ? (
            <AgentDeskIntro />
          ) : (
            "A simulated book on live NIFTY and SENSEX option prices: new buys stay paused by the measured-edge check unless a practice quota is on, and ENTER or WAIT is the engine's reading, not a promise."
          )
        }
        right={<MarketStatus />}
      >
        <SafetyStrip account={account} />
        <ConnectionBanner />
      </PageHeader>

      <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
        <IndexActionStrip compact account={account} />
        {!agent && (
          <p style={{ margin: 0, fontSize: 12.5, color: C.muted2, lineHeight: 1.5 }}>
            This follows the engine&apos;s own paper book. The ₹10k card below is a separate, graded recommendation from chart setups and option flow, so the two can disagree.
          </p>
        )}
      </div>

      {!agent && <RecoCard />}
      {!agent && <SetupBoard />}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 32, opacity: dim, transition: "opacity 0.3s", minWidth: 0 }}>
        <OpenNow account={account} />
        <PnlSection account={account} />
        <TodaysTrades account={account} />
      </div>

      <p style={{ margin: 0, fontSize: 14, color: C.muted, lineHeight: 1.6 }}>
        Market and news: index levels and the option build-up are on{" "}
        <Link href="/options" className="link-quiet" style={linkStyle}>
          Options
        </Link>
        ; world events and scheduled releases on{" "}
        <Link href="/geo" className="link-quiet" style={linkStyle}>
          Geo Intel
        </Link>
        .
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 14, minWidth: 0 }}>
        <Disclosure
          id="why"
          title={agent ? "Why the main engine says this" : "Why the engine says this"}
          note={
            agent
              ? "Main's no-trade rules and signals, not the agent's: the agent's model reads today's plan as context, but main's measured-edge pause does not apply to the agent."
              : "Today's no-trade rules and windows, and each index's signal, checks and the news behind it."
          }
        >
          <TodayPlan />
          <SignalConsole />
        </Disclosure>
        <Disclosure id="operations" title="Book, controls and health" note="Positions, today's orders, equity and charges, each signal's record; engine controls (admin token needed) and data health.">
          <TradeBlotter />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 16, alignItems: "start" }}>
            <EngineControls />
            <EngineStatusBar />
          </div>
        </Disclosure>
      </div>
    </div>
  );
}
