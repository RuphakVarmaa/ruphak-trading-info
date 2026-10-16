"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import type { IndexId, ScheduledEventView, SourceName } from "@/engine/api-types";
import { useClientNow, useEngineState, useNow } from "@/hooks/useEngineState";
import { usePolled } from "@/hooks/usePolled";
import type { HeadlineFeed } from "@/lib/market/headlines";
import { chokepointNews } from "@/utils/api";
import ChokepointMonitor from "@/components/Chokepoint/ChokepointMonitor";
import ConnectionBanner from "@/components/Desk/ConnectionBanner";
import EventImpactFeed from "@/components/Desk/EventImpactFeed";
import MarketStrip from "@/components/Desk/MarketStrip";
import ScheduledEventsStrip from "@/components/Desk/ScheduledEventsStrip";
import IntelFeed from "@/components/Feed/IntelFeed";
import { alpha, C, impactColor } from "@/components/shared/colors";
import { fmtIstDay, fmtIstHm } from "@/components/shared/format";
import { Disclosure, EmptyState, PageHeader, Panel, PanelHeader, Pill, Section } from "@/components/shared/ui";
import EngineLinkCard from "./EngineLinkCard";
import {
  ageText,
  chokepointMarkers,
  drivingIds,
  engineLinkFor,
  eventMarkers,
  headlineMarkers,
  layerChipText,
  MAP_COLORS,
  moreScheduled,
  placeEvents,
  type GeoLayer,
} from "./geoView";

const GeoMap = dynamic(() => import("./GeoMap"), {
  ssr: false,
  loading: () => <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13, background: "var(--map-bg)" }}>Loading the map…</div>,
});

const INDICES: IndexId[] = ["NIFTY", "SENSEX"];

const PIPELINE: { key: SourceName; label: string }[] = [
  { key: "gdelt", label: "GDELT" },
  { key: "gnews", label: "GNews" },
  { key: "rss", label: "RSS" },
  { key: "claude", label: "Scorer" },
];

// The engine swatch is neutral: its markers take the bull/bear/flat colour of their stories.
const LAYERS: { id: GeoLayer; label: string; swatch: string; ring?: string; hollow?: boolean }[] = [
  { id: "engine", label: "Engine stories", swatch: MAP_COLORS.flat, ring: MAP_COLORS.ring },
  { id: "headline", label: "Geo headlines", swatch: MAP_COLORS.headline },
  { id: "chokepoint", label: "Chokepoints", swatch: MAP_COLORS.cpInNews, hollow: true },
];

function Swatch({ color, ring, hollow = false, size = 10 }: { color: string; ring?: string; hollow?: boolean; size?: number }) {
  return <span aria-hidden style={{ width: size, height: size, borderRadius: "50%", display: "inline-block", flexShrink: 0, background: hollow ? "transparent" : color, border: `2px ${hollow ? "dashed" : "solid"} ${ring ?? color}` }} />;
}

const MORE_ROWS = 12;

/**
 * The 30-day calendar beyond the rows the 8-day strip beside it shows. It leaves out the strip's
 * rows by id, so an event the strip's window holds but does not show still appears here.
 */
function MoreScheduled({ events, error, now }: { events: ScheduledEventView[] | null; error: string | null; now: number | null }) {
  const { scheduled } = useEngineState();
  const more = events == null || now == null ? null : moreScheduled(events, scheduled, now);
  return (
    <Panel>
      <PanelHeader title="More, to 30 days" right={more ? <span style={{ fontSize: 11, color: C.muted3, textTransform: "none" }}>{more.length} scheduled</span> : undefined} />
      {more == null ? (
        <EmptyState>{error && events == null ? "No data: the 30-day calendar did not load." : "Loading the 30-day calendar…"}</EmptyState>
      ) : more.length === 0 ? (
        <EmptyState>No data: nothing else scheduled in the engine&apos;s calendar for the next 30 days.</EmptyState>
      ) : (
        more.slice(0, MORE_ROWS).map((e) => (
          <div key={e.id} style={{ display: "grid", gridTemplateColumns: "88px minmax(0, 1fr)", gap: 10, padding: "10px 16px", borderTop: `1px solid ${C.borderSoft}`, alignItems: "baseline" }}>
            <span className="tnum" style={{ fontSize: 12, color: C.muted, fontFamily: "var(--font-num)" }}>
              {fmtIstDay(e.at)}
              {e.approx ? " ≈" : ""}
            </span>
            <span style={{ fontSize: 13, color: C.textSoft, minWidth: 0 }}>
              <b style={{ color: e.impact === "LOW" ? C.muted : impactColor(e.impact), fontSize: 11, marginRight: 6 }}>{e.impact === "HIGH" ? "HIGH" : e.impact === "MED" ? "MED" : "LOW"}</b>
              {e.title}
              <span style={{ color: C.muted3 }}> · {fmtIstHm(e.at)} IST</span>
            </span>
          </div>
        ))
      )}
      {more != null && more.length > MORE_ROWS && (
        <div style={{ padding: "10px 16px", borderTop: `1px solid ${C.borderSoft}`, fontSize: 12.5, color: C.muted3 }}>+{more.length - MORE_ROWS} more in the next 30 days</div>
      )}
    </Panel>
  );
}

/** Geo intel → engine: world news on a map, and whether it makes a trade possible now. */
export default function GeoIntelSection() {
  const { signals, events, state, source } = useEngineState();
  const now = useNow();
  const clientNow = useClientNow();
  const headlines = usePolled<HeadlineFeed>("/api/metals/headlines", 300_000);
  const month = usePolled<ScheduledEventView[]>("/api/engine/scheduled?hours=720", 30 * 60_000);
  const [visible, setVisible] = useState<ReadonlySet<GeoLayer>>(() => new Set<GeoLayer>(["engine", "headline", "chokepoint"]));
  const [selectedCp, setSelectedCp] = useState("HORMUZ");

  const items = useMemo(() => headlines.data?.items ?? [], [headlines.data]);
  const driving = useMemo(() => drivingIds(signals), [signals]);
  const { placed, unplaced } = useMemo(() => placeEvents(events ?? []), [events]);
  const headlinesLoaded = headlines.data != null;
  // Chokepoint levels need the headline feed and the browser clock (the 72-hour window). Until both are
  // in, a level would read "quiet, 0 headlines", which is made up: the map leaves them off and says "no data".
  const chokepointsReady = headlinesLoaded && clientNow != null;
  const chokepoints = useMemo(() => chokepointNews(chokepointsReady ? items : [], clientNow ?? 0), [chokepointsReady, items, clientNow]);
  const markers = useMemo(
    () => [...(chokepointsReady ? chokepointMarkers(chokepoints, clientNow) : []), ...headlineMarkers(items, clientNow), ...eventMarkers(placed, driving, now)],
    [chokepointsReady, chokepoints, items, placed, driving, now, clientNow],
  );
  const chips: Record<GeoLayer, string> = {
    engine: layerChipText("engine", markers, events != null),
    headline: layerChipText("headline", markers, headlinesLoaded),
    chokepoint: layerChipText("chokepoint", markers, chokepointsReady),
  };
  const headlinesFailed = !headlinesLoaded && headlines.error != null;
  const links = INDICES.map((i) => engineLinkFor(i, signals?.find((s) => s.index === i) ?? null, events, now));
  const newestStory = (events ?? []).reduce<string | null>((m, e) => (m == null || Date.parse(e.lastSeenAt) > Date.parse(m) ? e.lastSeenAt : m), null);

  const toggle = (id: GeoLayer) =>
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <PageHeader
        title="Geo intel → engine"
        sub="World events and market-moving news, where they happen, and whether they make a trade possible right now. Only the engine's own scored stories feed its EVENT signal; headlines and chokepoints are context."
        right={
          <>
            {source === "mock" && (
              <Pill color={C.orange} solid title="The engine is the dashboard's synthetic mock: nothing here is live">
                mock data
              </Pill>
            )}
          </>
        }
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", fontSize: 12.5, color: C.muted2 }}>
          <span>
            News pipeline:{" "}
            {PIPELINE.map((p, i) => {
              const h = state?.health?.[p.key];
              return (
                <span key={p.key} style={{ color: h == null ? C.muted3 : h.ok ? C.textDim : C.orange }}>
                  {i > 0 ? " · " : ""}
                  {p.label} {h == null ? "no data" : h.ok ? "ok" : "down"}
                </span>
              );
            })}
          </span>
          {state && <span>{state.stats.clustersScoredToday} stories scored today</span>}
          {newestStory && <span>newest story {ageText(newestStory, now) || `${fmtIstHm(newestStory)} IST`}</span>}
          {headlines.at != null && <span>headlines checked {fmtIstHm(headlines.at)} IST</span>}
        </div>
      </PageHeader>

      <ConnectionBanner />

      <Section
        id="engine-link"
        title="Does the news make a trade possible now?"
        sub="Per index, from the engine's latest decision: the news signal's pressure, its share of the conviction, the engine's verdict and the stories behind it. Stories are as of the last news-scoring run, which can differ from the decision time."
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 20 }}>
          {links.map((l) => (
            <EngineLinkCard key={l.index} link={l} />
          ))}
        </div>
      </Section>

      <Section id="map" title="Map" sub="Engine stories drive the EVENT signal; headlines and chokepoints are context only.">
        <Panel>
          <div role="group" aria-label="Map layers" style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "12px 14px", borderBottom: `1px solid ${C.border}` }}>
            {LAYERS.map((l) => {
              const on = visible.has(l.id);
              return (
                <button
                  key={l.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(l.id)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "5px 12px",
                    borderRadius: 999,
                    cursor: "pointer",
                    fontSize: 12.5,
                    fontWeight: on ? 600 : 500,
                    color: on ? C.textStrong : C.muted3,
                    background: on ? alpha(C.blue, 0.06) : C.panel,
                    border: `1px solid ${on ? C.borderStrong : C.border}`,
                  }}
                >
                  <Swatch color={l.swatch} ring={l.ring} hollow={l.hollow} />
                  {l.label}
                  <span className="tnum" style={{ fontFamily: "var(--font-num)", color: C.muted3, fontSize: 11.5 }}>
                    {chips[l.id]}
                  </span>
                </button>
              );
            })}
          </div>
          <div style={{ height: "clamp(320px, 52vw, 540px)", position: "relative", isolation: "isolate" }}>
            <GeoMap markers={markers} visible={visible} />
          </div>
          <div style={{ display: "grid", gap: 6, padding: "12px 14px", borderTop: `1px solid ${C.border}`, fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>
            {headlinesFailed && <div style={{ color: C.orange }}>Headline feed did not load: no data for the headline and chokepoint layers.</div>}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", alignItems: "center" }}>
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <Swatch color={MAP_COLORS.bull} /> bullish for NIFTY
              </span>
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <Swatch color={MAP_COLORS.bear} /> bearish for NIFTY
              </span>
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <Swatch color={MAP_COLORS.flat} /> no net direction
              </span>
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <Swatch color={MAP_COLORS.ring} hollow /> dark outline: drives a signal now
              </span>
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <Swatch color={MAP_COLORS.headline} /> headline (context)
              </span>
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <Swatch color={MAP_COLORS.cpQuiet} hollow />
                <Swatch color={MAP_COLORS.cpInNews} hollow />
                <Swatch color={MAP_COLORS.cpHeavy} hollow /> chokepoint: quiet, in the news, heavy
              </span>
            </div>
            <div>
              A story is placed only where its own title (or, failing that, its summary) names a place; central banks stand for their country and say so. {unplaced.length} of {(events ?? []).length} engine
              stories name no clear place and are listed below, not on the map.
            </div>
          </div>
        </Panel>
      </Section>

      <Section id="news" title="Stories" sub="The engine's scored stories (last 48 h), with their impact on each index. These are what move the EVENT signal.">
        <div className="desk-split">
          <EventImpactFeed />
          <Panel>
            <PanelHeader title="No clear place" right={<span style={{ fontSize: 11, color: C.muted3, textTransform: "none" }}>{unplaced.length} not on the map</span>} />
            {events == null ? (
              <EmptyState>Loading…</EmptyState>
            ) : unplaced.length === 0 ? (
              <EmptyState>Every story names a place.</EmptyState>
            ) : (
              unplaced.map((e) => (
                <div key={e.clusterId} style={{ padding: "10px 16px", borderTop: `1px solid ${C.borderSoft}` }}>
                  <Link href={`/events/${encodeURIComponent(e.clusterId)}`} style={{ color: C.textSoft, fontSize: 13, textDecoration: "none", lineHeight: 1.45 }}>
                    {e.title}
                  </Link>
                  <div style={{ fontSize: 11.5, color: C.muted3, marginTop: 2 }}>
                    {e.impacts.length > 0 && e.scorer !== "pending" ? e.impacts.map((i) => `${i.index} ${i.score > 0 ? "▲" : i.score < 0 ? "▼" : "▬"}${Math.abs(i.score).toFixed(2)}`).join(" · ") : "not scored yet"}
                    {now != null ? ` · ${ageText(e.lastSeenAt, now)}` : ""}
                  </div>
                </div>
              ))
            )}
          </Panel>
        </div>
      </Section>

      <Section id="context" title="Global context" sub="Cross-asset prices the engine reads, and the scheduled releases for the next 30 days (entries pause around high-impact ones).">
        <div style={{ display: "grid", gap: 20, minWidth: 0 }}>
          <MarketStrip />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", gap: 20, alignItems: "start" }}>
            <ScheduledEventsStrip />
            <MoreScheduled events={month.data} error={month.error} now={now} />
          </div>
        </div>
      </Section>

      <Disclosure id="headlines" title="Chokepoints and headline list" note="Bing headlines on metals, oil and shipping: context only, they do not feed the engine">
        <Panel>
          <ChokepointMonitor chokepoints={chokepoints} selected={selectedCp} onSelect={setSelectedCp} ready={chokepointsReady} />
        </Panel>
        <Panel style={{ height: 520, display: "flex", flexDirection: "column" }}>
          <IntelFeed items={items} loading={headlines.data == null && headlines.error == null} error={headlines.data == null ? headlines.error : null} stale={headlines.data?.stale ?? false} />
        </Panel>
      </Disclosure>

      <p style={{ margin: 0, fontSize: 12.5, color: C.muted, lineHeight: 1.6 }}>
        Headlines and chokepoints come from a separate Bing feed and do not feed the engine. Only engine-scored stories move the EVENT signal, which is one of several signals. Chokepoint colour is how
        often it is in the news, not vessel data. No edge has been shown for the news signal; paper trading only; not investment advice.
      </p>
    </>
  );
}
