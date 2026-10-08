"use client";

import Link from "next/link";
import { useEngineState } from "@/hooks/useEngineState";
import IndexActionStrip from "@/components/Copy/ActionStrip";
import { LiveIndicesPanel } from "@/components/Market";
import PnlTiles from "@/components/Blotter/PnlTiles";
import TradeBlotter from "@/components/Blotter/TradeBlotter";
import { C } from "@/components/shared/colors";
import { Disclosure, Section } from "@/components/shared/ui";
import ConnectionBanner from "./ConnectionBanner";
import DeskHeader from "./DeskHeader";
import EngineControls from "./EngineControls";
import EngineStatusBar from "./EngineStatusBar";
import EventImpactFeed from "./EventImpactFeed";
import MarketStrip from "./MarketStrip";
import ScheduledEventsStrip from "./ScheduledEventsStrip";
import SignalConsole from "./SignalConsole";

const linkStyle = { fontSize: 13, fontWeight: 600, color: C.gold, textDecoration: "none" } as const;

/**
 * The India Index Desk, an overview: the market and today's P&L, both signals, the news and the
 * week's scheduled events. The book (orders, equity, signal record) and the engine's controls and
 * health sit in collapsed areas at the bottom.
 */
export default function IndiaDesk() {
  const { status } = useEngineState();
  const dim = status === "offline" ? 0.55 : status === "stale" ? 0.85 : 1;
  return (
    <div id="desk" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 28, minWidth: 0 }}>
      <DeskHeader />
      <IndexActionStrip compact />
      <LiveIndicesPanel />
      <ConnectionBanner />
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 40, opacity: dim, transition: "opacity 0.3s", minWidth: 0 }}>
        <Section
          id="today"
          title="Today"
          right={
            <Link href="/live" className="link-quiet" style={linkStyle}>
              Live P&amp;L →
            </Link>
          }
        >
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}>
            <MarketStrip />
            <PnlTiles />
          </div>
        </Section>

        <Section id="signals" title="Signals" sub="What the engine sees on each index right now, and whether it would trade.">
          <SignalConsole />
        </Section>

        <div className="desk-split">
          <Section id="news" title="News moving the market" sub="Stories scored for their likely effect on NIFTY and SENSEX.">
            <EventImpactFeed />
          </Section>
          <Section id="catalysts" title="Upcoming events" sub="Scheduled releases and expiries; no new entries around the big ones.">
            <ScheduledEventsStrip />
          </Section>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 14, minWidth: 0 }}>
          <Disclosure id="book" title="Orders and performance" note="Open positions, today's orders, equity and charges, and each signal's record.">
            <TradeBlotter />
          </Disclosure>
          <Disclosure id="operations" title="Operations" note="Engine controls (admin token needed), and the health of the engine and its data sources.">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 16, alignItems: "start" }}>
              <EngineControls />
              <EngineStatusBar />
            </div>
          </Disclosure>
        </div>
      </div>
    </div>
  );
}
