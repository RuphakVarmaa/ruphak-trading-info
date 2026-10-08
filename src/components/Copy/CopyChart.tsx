"use client";

/**
 * The index chart on /copy: the live 1-minute chart for today's session, 5-minute candles otherwise.
 */
import type { CopyTicketView, IndexId, SessionPhase } from "@/engine/api-types";
import { C } from "@/components/shared/colors";
import { fmtDateKey, fmtIstHm } from "@/components/shared/format";
import { EmptyState, Skeleton } from "@/components/shared/ui";
import { usePolled } from "@/hooks/usePolled";
import { indexPrice } from "@/lib/copy/prices";
import type { IntradayFeed } from "@/lib/market/intraday";
import type { LiveIndex } from "@/lib/market/liveIndices";
import { useLiveIndices, type LiveIndicesState } from "@/hooks/useLiveIndices";
import { LiveIndexCard, LiveIndexChart, type ChartMarks } from "@/components/Market";
import CandleChart from "./CandleChart";

export interface CopyChartProps {
  index: IndexId;
  /** IST date of the session to show; null shows the latest session (holidays and weekends). */
  date: string | null;
  /** The trade to mark (entry, exit and, while open, the skip level). */
  ticket: CopyTicketView | null;
  /** Refresh every 20 s from pre-open to the close, every 5 min otherwise. */
  active: boolean;
  /** The market phase now, for the "no candles yet" sentence. */
  phase?: SessionPhase;
  /** Today's IST date, to label an earlier session as the previous one. */
  today?: string | null;
}

/**
 * Today's session comes from the continuous 1-minute feed (/api/market/live, refreshed every 1.5 s in
 * market hours) with its freshness badge; an older session, or the feed being down, falls back to the
 * 5-minute candles.
 */
export default function CopyChart(props: CopyChartProps) {
  const live = useLiveIndices();
  const idx = live.data?.indices.find((i) => i.index === props.index) ?? null;
  const wantsLatest = props.date == null || props.date === props.today;
  if (wantsLatest && idx && idx.bars.length > 0 && (props.date == null || idx.session === props.date || props.date === props.today)) {
    return <LiveChart index={idx} ticket={props.ticket} live={live} />;
  }
  if (wantsLatest && live.freshness === "loading" && !live.error) return <Skeleton height={260} />;
  return <IntradayCandles {...props} />;
}

function LiveChart({ index, ticket, live }: { index: LiveIndex; ticket: CopyTicketView | null; live: LiveIndicesState }) {
  const t = ticket && ticket.index === index.index && ticket.entry.at.slice(0, 10) === index.session ? ticket : null;
  const exitMs = t?.exit ? Date.parse(t.exit.at) : null;
  const exitBar = exitMs != null ? [...index.bars].reverse().find((b) => b.t <= exitMs) : undefined;
  const marks: ChartMarks = t
    ? {
        entry: { t: Date.parse(t.entry.at), price: t.entry.spot, side: "BUY" },
        ...(exitMs != null && exitBar ? { exit: { t: exitMs, price: exitBar.c } } : {}),
        ...(t.status === "OPEN" && t.entry.skipBeyondSpot != null ? { skipBeyond: t.entry.skipBeyondSpot } : {}),
      }
    : {};
  return (
    <LiveIndexCard index={index} freshness={live.freshness} ageMs={live.ageMs} source={live.data?.source ?? "Yahoo Finance"}>
      <LiveIndexChart index={index} height={240} marks={marks} />
    </LiveIndexCard>
  );
}

/** The index's 5-minute candles for the session, with VWAP, the opening range and the trade's marks. */
function IntradayCandles({ index, date, ticket, active, phase, today }: CopyChartProps) {
  const feed = usePolled<IntradayFeed>(`/api/market/intraday?index=${index}${date ? `&date=${date}` : ""}`, active ? 20_000 : 300_000);
  const t = ticket && ticket.index === index ? ticket : null;
  const marks = t ? { entry: { at: t.entry.at, spot: t.entry.spot, side: t.side }, exit: t.exit ? { at: t.exit.at } : null, skipBeyond: t.status === "OPEN" ? t.entry.skipBeyondSpot : null } : {};
  if (feed.data) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <CandleChart feed={feed.data} marks={marks} />
        <span className="tnum" style={{ fontSize: 12, color: C.muted2 }}>
          {index} 5-minute candles for {fmtDateKey(feed.data.session)}
          {today && feed.data.session !== today ? " (previous session: today's candles start at 09:15 IST)" : ""} from Yahoo Finance (about 1–2 min delayed) · last {indexPrice(feed.data.last)} at {fmtIstHm(feed.data.asOf)} IST · blue line VWAP, shaded band the 09:15–09:30 opening range
        </span>
      </div>
    );
  }
  if (feed.error) {
    const noneYet = feed.error.startsWith("NOT_FOUND");
    return (
      <EmptyState style={{ padding: "28px 16px" }}>
        {!noneYet
          ? `The ${index} chart is unavailable right now. It retries on its own.`
          : phase === "OPEN"
            ? `No ${index} candles for this session yet: the data source has not published today's first bars. The chart retries on its own.`
            : `No ${index} candles yet for this session: that is normal before the open. The market opens at 09:15 IST and the chart fills in from then.`}
      </EmptyState>
    );
  }
  return <Skeleton height={280} />;
}
