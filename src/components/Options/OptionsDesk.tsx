"use client";

/**
 * /options: the options section, for one index at a time (NIFTY or SENSEX, one toggle for every block):
 * 1. index levels, 2. the build-up now (live OI and volume flow), 3. the next 30 days (what each expiry's
 * option prices imply), 4. the live option chain (collapsed), plus the 1-minute index charts (collapsed).
 * The trade card and the engine's advice live on the Paper Engine page.
 */
import Link from "next/link";
import { useState } from "react";
import type { IndexId, LiveIndexLevelsView } from "@/engine/api-types";
import { C } from "@/components/shared/colors";
import { Disclosure, PageHeader, Section, Segmented } from "@/components/shared/ui";
import { plainError, useSharedPoll } from "@/components/Copy/sharedPoll";
import { useClientNow } from "@/hooks/useEngineState";
import { REFRESH_OTHER_MS } from "@/lib/refresh";
import { LiveIndicesPanel } from "@/components/Market";
import FlowPanel from "@/components/Flow/FlowPanel";
import OutlookPanel from "@/components/Outlook/OutlookPanel";
import { chainPollMs, optionsHref } from "./chainView";
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

export default function OptionsDesk({ initialIndex, initialExpiry }: { initialIndex: IndexId; initialExpiry: string | null }) {
  const [index, setIndex] = useState<IndexId>(initialIndex);
  const [expiry, setExpiry] = useState<string | null>(initialExpiry);
  const now = useClientNow();

  // The engine's clock decides the session (the mock runs its own): its offset from this browser at the last answer.
  const [clockOffset, setClockOffset] = useState(0);
  const levelsPoll = useSharedPoll<LiveIndexLevelsView>("/api/engine/live-indices", now == null ? REFRESH_OTHER_MS : chainPollMs(now + clockOffset));
  const fetchedMs = levelsPoll.data ? Date.parse(levelsPoll.data.fetchedAt) : NaN;
  // Derived state, adjusted during render (the poll interval depends on it, and the poll on the interval).
  const offset = Number.isFinite(fetchedMs) && levelsPoll.at != null ? Math.round((fetchedMs - levelsPoll.at) / 60_000) * 60_000 : clockOffset;
  if (offset !== clockOffset) setClockOffset(offset);
  const level = levelsPoll.data?.levels.find((l) => l.key === index) ?? null;

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
        <IndexLevels data={levelsPoll.data} error={plainError(levelsPoll.error, "the index levels")} ageMs={now != null && levelsPoll.at != null ? now - levelsPoll.at : null} index={index} />
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
        <FlowPanel id="flow" index={index} onIndexChange={switchIndex} clockOffsetMs={clockOffset} />
      </Section>

      <Section id="outlook" title="Next 30 days" sub={`What today's option prices imply for each listed ${index} expiry over the next month: the priced move, implied volatility, positioning and the scheduled events before each expiry.`}>
        <OutlookPanel index={index} clockOffsetMs={clockOffset} onOpenChain={openChain} />
      </Section>

      <Disclosure id={CHAIN_ID} title="Option chain" note={`${index} · every strike's OI, prices, IV and greeks, live`} defaultOpen={initialExpiry != null}>
        <OptionChainPanel index={index} expiry={expiry} onExpiryChange={pickExpiry} level={level} clockOffsetMs={clockOffset} />
      </Disclosure>

      <Disclosure id="index-charts" title="1-minute index charts" note="NIFTY 50 and SENSEX with India VIX, from Yahoo Finance">
        <LiveIndicesPanel />
      </Disclosure>
    </main>
  );
}
