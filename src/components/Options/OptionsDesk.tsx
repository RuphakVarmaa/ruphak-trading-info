"use client";

/**
 * /options: the options section, for one index at a time (NIFTY or SENSEX, one toggle for every block):
 * 1. index levels, 2. the build-up now (live OI and volume flow), 3. the next 30 days (what each expiry's
 * option prices imply), 4. the live option chain (collapsed), plus the 1-minute index charts (collapsed).
 * The trade card and the engine's advice live on the Paper Engine page.
 */
import Link from "next/link";
import { useState } from "react";
import type { IndexId, LiveIndexLevelsView, OptionChainView } from "@/engine/api-types";
import { C } from "@/components/shared/colors";
import { Disclosure, PageHeader, Section, Segmented } from "@/components/shared/ui";
import { plainError, useSharedPoll, type PollState } from "@/components/Copy/sharedPoll";
import { useClientNow } from "@/hooks/useEngineState";
import { REFRESH_CLOSED_MS, REFRESH_IMPORTANT_MS } from "@/lib/refresh";
import { LiveIndicesPanel } from "@/components/Market";
import FlowPanel from "@/components/Flow/FlowPanel";
import OutlookPanel from "@/components/Outlook/OutlookPanel";
import { isMarketHours, optionsHref } from "./chainView";
import IndexLevels from "./IndexLevels";
import OptionChainPanel from "./OptionChainPanel";

const INDEX_OPTIONS = [
  { value: "NIFTY", label: "NIFTY" },
  { value: "SENSEX", label: "SENSEX" },
] as const;

const CHAIN_ID = "chain";

/** Keeps the address bar in step with the page (no navigation), keeping any #anchor. */
function syncUrl(index: IndexId, expiry: string | null, hash?: string) {
  try {
    window.history.replaceState(null, "", optionsHref(index, expiry, hash ?? window.location.hash));
  } catch {
    // Not fatal: the page works without it.
  }
}

/** The engine's stamp on the last good answer minus the browser time it arrived (ms); null without both. */
function stampGap(poll: PollState<{ fetchedAt: string }>): number | null {
  const ms = poll.data ? Date.parse(poll.data.fetchedAt) : NaN;
  return Number.isFinite(ms) && poll.at != null ? ms - poll.at : null;
}

/** An ISO time moved by `ms` (unchanged when it does not parse). */
function shiftIso(iso: string, ms: number): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + ms).toISOString() : iso;
}

export default function OptionsDesk({ initialIndex, initialExpiry }: { initialIndex: IndexId; initialExpiry: string | null }) {
  const [index, setIndex] = useState<IndexId>(initialIndex);
  const [expiry, setExpiry] = useState<string | null>(initialExpiry);
  const now = useClientNow();

  // The engine's clock decides the session (the mock runs its own): its offset from this browser, to the minute.
  // A real engine stamps the index levels on that clock. The mock stamps its levels with the wall clock (the
  // 1-minute charts' feed, /api/market/live, drops broker levels older than 30 s by it) and its option chain
  // with the simulated time, so with the mock the offset comes from the chain. Same URL as the chain panel's:
  // an open chain shares the poll, a collapsed one costs one read per 10 minutes.
  const [clockOffset, setClockOffset] = useState(0);
  // Index prices are what you act on: every second while the market is open, every 10 minutes once it has closed.
  const levelsMs = now == null || isMarketHours(now + clockOffset) ? REFRESH_IMPORTANT_MS : REFRESH_CLOSED_MS;
  const levelsPoll = useSharedPoll<LiveIndexLevelsView>("/api/engine/live-indices", levelsMs);
  const mock = levelsPoll.data?.source === "mock";
  const mockClock = useSharedPoll<OptionChainView>(mock ? `/api/engine/chain?index=${index}${expiry ? `&expiry=${expiry}` : ""}` : null, REFRESH_CLOSED_MS);
  const gap = stampGap(mock ? mockClock : levelsPoll);
  // Derived state, adjusted during render (the poll intervals depend on it, and the polls on the intervals).
  const offset = gap == null ? clockOffset : Math.round(gap / 60_000) * 60_000;
  if (offset !== clockOffset) setClockOffset(offset);
  // With the mock, the levels' time is shown on its simulated clock too, like every other block on the page.
  const levels = levelsPoll.data && mock && gap != null ? { ...levelsPoll.data, fetchedAt: shiftIso(levelsPoll.data.fetchedAt, gap) } : levelsPoll.data;
  const level = levels?.levels.find((l) => l.key === index) ?? null;

  const switchIndex = (i: IndexId) => {
    if (i === index) return;
    setIndex(i);
    setExpiry(null);
    syncUrl(i, null);
  };

  const pickExpiry = (e: string) => {
    setExpiry(e);
    syncUrl(index, e);
  };

  /** From an outlook card: show that expiry in the chain, opening the chain if it is collapsed. */
  const openChain = (e: string) => {
    setExpiry(e);
    syncUrl(index, e, CHAIN_ID);
    const el = document.getElementById(CHAIN_ID);
    if (el instanceof HTMLDetailsElement) el.open = true;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <main style={{ width: "100%", maxWidth: 1240, margin: "0 auto", padding: "20px 16px 56px", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 32, boxSizing: "border-box", minWidth: 0 }}>
      <PageHeader
        eyebrow="Options · read-only market data"
        title="Options: build-up now and the month ahead"
        sub={`Where ${index} option open interest and volume are moving today, and what option prices imply for each expiry in the next 30 days. Market data, not advice.`}
        right={<Segmented label="Index" value={index} options={INDEX_OPTIONS} onChange={switchIndex} />}
      >
        <IndexLevels data={levels} error={plainError(levelsPoll.error, "the index levels")} ageMs={now != null && levelsPoll.at != null ? now - levelsPoll.at : null} index={index} />
        <div style={{ fontSize: 13.5, color: C.muted }}>
          <Link href="/" className="link-quiet" style={{ color: C.gold, fontWeight: 600, textDecoration: "none" }}>
            Trade card and advice: Paper Engine →
          </Link>
        </div>
      </PageHeader>

      <Section
        id="buildup"
        title="Build-up now"
        sub="Live OI and volume flow: where open interest is added or removed, long or short build-up, volume spikes, the PCR shift, the support and resistance walls, premium decay and the entry-window reading."
      >
        <FlowPanel id="flow" index={index} clockOffsetMs={clockOffset} />
      </Section>

      <Section id="outlook" title="Next 30 days" sub={`What today's option prices imply for each listed ${index} expiry over the next month: the priced move, implied volatility, positioning and the scheduled events before each expiry.`}>
        <OutlookPanel index={index} clockOffsetMs={clockOffset} onOpenChain={openChain} />
      </Section>

      <Disclosure id={CHAIN_ID} title="Option chain" note={`${index} · every strike's OI, prices, IV and greeks, live`} defaultOpen={initialExpiry != null}>
        <OptionChainPanel index={index} expiry={expiry} onExpiryChange={pickExpiry} level={level} clockOffsetMs={clockOffset} />
      </Disclosure>

      <Disclosure id="index-charts" title="1-minute index charts" note="NIFTY 50 and SENSEX with India VIX: 1-minute bars from Yahoo Finance, prices from the broker feed while it is live">
        <LiveIndicesPanel />
      </Disclosure>
    </main>
  );
}
