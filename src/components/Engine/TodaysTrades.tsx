"use client";

import Link from "next/link";
import { plainError } from "@/components/Copy/sharedPoll";
import { C, pnlColor } from "@/components/shared/colors";
import { fmtInr } from "@/components/shared/format";
import { EmptyState, Panel, Pill, Section, Skeleton } from "@/components/shared/ui";
import { useEngineState, useNow } from "@/hooks/useEngineState";
import { accountHref, noTradesText, tradeRow, type TradeRow } from "./engineView";
import { linkStyle } from "./OpenNow";
import { useTodayTickets } from "./useTodayTickets";

function Row({ r, first }: { r: TradeRow; first: boolean }) {
  return (
    <Link
      href={r.href}
      className="nav-tab"
      aria-label={`${r.headline}: ${r.inText}, ${r.outText}${r.pnl != null ? `, ${fmtInr(r.pnl, { sign: true })} after charges` : ""}.${r.practice ? " Practice trade, not for copying. Open the trade details." : " Open the copy page."}`}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        alignItems: "center",
        gap: "4px 14px",
        padding: "12px 16px",
        borderTop: first ? "none" : `1px solid ${C.borderSoft}`,
        textDecoration: "none",
        color: C.textSoft,
      }}
    >
      <span style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 8px", minWidth: 0 }}>
          <b className="tnum" style={{ fontSize: 14.5, color: C.textStrong, overflowWrap: "anywhere" }}>
            {r.contract}
          </b>
          {r.open && <Pill color={C.green}>open</Pill>}
          {r.practice && (
            <Pill
              color={C.purple}
              title="Taken by the paper practice quota (one trade per hour window, 09:30–14:30, while the measured-edge check pauses the engine's own buying). Practice trades are for watching the system work, not for copying: the research says they lose on average."
            >
              practice
            </Pill>
          )}
        </span>
        <span className="tnum" style={{ fontSize: 13, color: C.muted, lineHeight: 1.45 }}>
          {r.inText} <span aria-hidden>→</span> {r.outText}
        </span>
      </span>
      <span style={{ display: "grid", justifyItems: "end", gap: 2 }}>
        <span className="tnum" style={{ fontSize: 15.5, fontWeight: 700, fontFamily: "var(--font-num)", color: r.pnl == null ? C.muted : pnlColor(r.pnl) }}>
          {r.pnl == null ? "no data" : fmtInr(r.pnl, { sign: true })}
        </span>
        <span style={{ fontSize: 12, color: r.practice ? C.muted : C.gold, fontWeight: 600, whiteSpace: "nowrap" }}>{r.practice ? "Details →" : "Copy steps →"}</span>
      </span>
    </Link>
  );
}

/** Today's paper trades for the account, one row each, linking to its ticket on the copy page. */
export default function TodaysTrades({ account }: { account?: string }) {
  const { account: accountId, poll } = useTodayTickets(account);
  const { state } = useEngineState();
  const now = useNow();
  const list = poll.data;
  const rows = (list ?? []).map((t) => tradeRow(t, accountId));
  const error = plainError(poll.error);
  return (
    <Section
      id="trades"
      title={`Today's trades${rows.length > 0 ? ` (${rows.length})` : ""}`}
      sub="In and out with the price and reason; P&L after charges (entry charges only while a trade is open)."
      right={
        <Link href={accountHref("/copy", accountId)} className="link-quiet" style={linkStyle}>
          All trades and copy steps →
        </Link>
      }
    >
      {list == null && !poll.error ? (
        <Skeleton height={64} style={{ borderRadius: 14 }} />
      ) : list == null ? (
        <Panel>
          <EmptyState style={{ padding: "22px 16px", color: C.orange }}>{error ?? "Can't load today's trades."} It retries every few seconds.</EmptyState>
        </Panel>
      ) : rows.length === 0 ? (
        <Panel>
          <EmptyState style={{ padding: "22px 16px" }}>{noTradesText(state?.market.phase, now)}</EmptyState>
        </Panel>
      ) : (
        <Panel style={{ padding: 0 }}>
          {rows.map((r, i) => (
            <Row key={r.id} r={r} first={i === 0} />
          ))}
          {error && <p style={{ margin: 0, padding: "8px 16px", borderTop: `1px solid ${C.borderSoft}`, fontSize: 12.5, color: C.orange }}>{error} Showing the last list received.</p>}
        </Panel>
      )}
    </Section>
  );
}
