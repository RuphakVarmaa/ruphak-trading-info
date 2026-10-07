"use client";

import { useEngineState } from "@/hooks/useEngineState";
import { C } from "@/components/shared/colors";
import ConnectionBanner from "./ConnectionBanner";
import EngineControls from "./EngineControls";
import EngineStatusBar from "./EngineStatusBar";
import EventImpactFeed from "./EventImpactFeed";
import IndexTicker from "./IndexTicker";
import ScheduledEventsStrip from "./ScheduledEventsStrip";
import SignalConsole from "./SignalConsole";

/** The INDIA INDEX DESK terminal box: controls → banner → ticker → core grid → catalysts → status bar. */
export default function IndiaDesk() {
  const { status } = useEngineState();
  const dim = status === "offline" ? 0.55 : status === "stale" ? 0.8 : 1;
  return (
    <div id="desk" style={{ padding: "0 30px 30px" }}>
      <div
        style={{
          width: "100%",
          maxWidth: 1400,
          margin: "0 auto",
          border: `1px solid ${C.borderStrong}`,
          borderRadius: 10,
          background: C.panel,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 4px 40px rgba(0,0,0,0.5)",
          overflow: "hidden",
        }}
      >
        <EngineControls />
        <ConnectionBanner />
        <div style={{ opacity: dim, transition: "opacity 0.3s" }}>
          <IndexTicker />
          <div className="desk-core" style={{ display: "flex", height: 680, overflow: "hidden" }}>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", borderRight: `1px solid ${C.border}` }}>
              <SignalConsole />
            </div>
            <div className="desk-feed" style={{ width: 380, flexShrink: 0, overflow: "hidden" }}>
              <EventImpactFeed />
            </div>
          </div>
          <ScheduledEventsStrip />
        </div>
        <EngineStatusBar />
      </div>
    </div>
  );
}
