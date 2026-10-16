"use client";

import Link from "next/link";
import PnlTiles from "@/components/Blotter/PnlTiles";
import { C, pnlColor } from "@/components/shared/colors";
import { fmtInr, fmtIstDate, fmtPct } from "@/components/shared/format";
import { Section, Skeleton, StatTile } from "@/components/shared/ui";
import { useEngineState } from "@/hooks/useEngineState";
import { accountHref, capitalOf, pnlFigures } from "./engineView";
import { linkStyle } from "./OpenNow";

const glyph = (n: number) => (n > 0 ? "▲ " : n < 0 ? "▼ " : "");

const ALL_TIME_NOTE =
  "Equity now (today's starting equity plus today's net) minus the account's starting capital, as the engine reports it. The engine keeps one ledger per mode (paper or live). If the capital setting was changed after trading began, this figure is off by that change.";

/** P&L since the account started: equity now minus its capital. "No data" when the engine does not report the capital. */
function AllTimeTile({ account }: { account?: string }) {
  const { state, pnl, positions } = useEngineState();
  const accountId = account ?? state?.account?.id ?? "main";
  const f = pnlFigures(pnl, positions, capitalOf(state, accountId));
  if (!pnl || !f) return <Skeleton height={96} style={{ borderRadius: 14 }} />;
  const mode = pnl.mode === "LIVE" ? "live" : "paper";
  const since = `Since ${fmtIstDate(`${f.window.from}T12:00:00+05:30`)}: ${fmtInr(f.window.net, { sign: true })}`;
  return (
    <StatTile
      label="All-time P&L"
      title={ALL_TIME_NOTE}
      value={f.allTime == null ? "no data" : `${glyph(f.allTime)}${fmtInr(f.allTime, { sign: true })}`}
      color={f.allTime == null ? C.muted : pnlColor(f.allTime)}
      sub={
        <>
          {f.allTime != null && f.allTimePct != null && f.capital != null
            ? `${fmtPct(f.allTimePct)} on ${fmtInr(f.capital)} starting capital (${mode} mode)`
            : "no data: the engine did not report the starting capital"}
          <br />
          <span className="tnum">{since}</span>
        </>
      }
    />
  );
}

/** Today's P&L (the Desk's tiles) and one all-time tile; the full book is on Live P&L. */
export default function PnlSection({ account }: { account?: string }) {
  return (
    <Section
      id="pnl"
      title="P&L"
      sub="Today after charges, and since the account started."
      right={
        <Link href={accountHref("/live", account)} className="link-quiet" style={linkStyle}>
          Full book on Live P&amp;L →
        </Link>
      }
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 12, minWidth: 0 }}>
        <div style={{ flex: "4 1 620px", minWidth: 0 }}>
          <PnlTiles />
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <AllTimeTile account={account} />
        </div>
      </div>
    </Section>
  );
}
