"use client";

/**
 * The index chart on /copy, kept behind one small component so it is a one-line swap: replace the
 * <IntradayCandles … /> line below with LiveIndexChart from @/components/Market once it lands.
 */
import type { CopyTicketView, IndexId, SessionPhase } from "@/engine/api-types";
import { C } from "@/components/shared/colors";
import { fmtDateKey, fmtIstHm } from "@/components/shared/format";
import { EmptyState, Skeleton } from "@/components/shared/ui";
import { usePolled } from "@/hooks/usePolled";
import { indexPrice } from "@/lib/copy/prices";
import type { IntradayFeed } from "@/lib/market/intraday";
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

export default function CopyChart(props: CopyChartProps) {
  return <IntradayCandles {...props} />;
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
