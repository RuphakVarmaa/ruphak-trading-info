"use client";

import Link from "next/link";
import { useEngineState } from "@/hooks/useEngineState";
import PnlTiles from "@/components/Blotter/PnlTiles";
import TradeBlotter from "@/components/Blotter/TradeBlotter";
import { C } from "@/components/shared/colors";
import { Section } from "@/components/shared/ui";
import ConnectionBanner from "./ConnectionBanner";
import DeskHeader from "./DeskHeader";
import EngineControls from "./EngineControls";
import EngineStatusBar from "./EngineStatusBar";
import EventImpactFeed from "./EventImpactFeed";
import MarketStrip from "./MarketStrip";
import ScheduledEventsStrip from "./ScheduledEventsStrip";
import SignalConsole from "./SignalConsole";

const linkStyle = { fontSize: 12, fontWeight: 600, color: C.blue, textDecoration: "none" } as const;

/** The India Index Desk: today at a glance, the signals, the news, controls and health, then the book. */
export default function IndiaDesk() {
  const { status, pnl } = useEngineState();
  const dim = status === "offline" ? 0.55 : status === "stale" ? 0.85 : 1;
  return (
    <div id="desk" style={{ display: "grid", gap: 28 }}>
      <DeskHeader />
      <ConnectionBanner />
      <div style={{ display: "grid", gap: 32, opacity: dim, transition: "opacity 0.3s" }}>
        <Section
          id="today"
          title="Today"
          right={
            <Link href="/live" style={linkStyle}>
              Live P&amp;L →
            </Link>
          }
        >
          <div style={{ display: "grid", gap: 12 }}>
            <MarketStrip />
            <PnlTiles pnl={pnl} />
          </div>
        </Section>

        <Section id="signals" title="Signals" sub="What the engine sees on each index right now, and whether it would trade.">
          <SignalConsole />
        </Section>

        <div className="desk-split">
          <Section id="news" title="News moving the market" sub="Stories scored for their likely effect on NIFTY and SENSEX.">
            <EventImpactFeed />
          </Section>
          <div style={{ display: "grid", gap: 28, alignContent: "start", minWidth: 0 }}>
            <Section id="catalysts" title="Upcoming events">
              <ScheduledEventsStrip />
            </Section>
            <Section id="controls" title="Controls">
              <EngineControls />
            </Section>
            <Section id="health" title="Health">
              <EngineStatusBar />
            </Section>
          </div>
        </div>

        <TradeBlotter />
      </div>
    </div>
  );
}
