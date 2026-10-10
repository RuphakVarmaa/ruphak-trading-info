"use client";

import type { ReactNode } from "react";
import type { SourceName } from "@/engine/api-types";
import { useEngineState, useNow } from "@/hooks/useEngineState";
import { C, enginePhaseColor, healthColor } from "@/components/shared/colors";
import { fmtAge, fmtCompact, fmtIstHm } from "@/components/shared/format";
import { Dot, Panel, PanelHeader, Pill } from "@/components/shared/ui";

const SOURCE_ORDER: SourceName[] = ["yahoo", "groww", "gnews", "rss", "gdelt", "claude", "relay"];
/** Display names; "claude" is the health key of whichever model scores the news. */
const SOURCE_LABEL: Partial<Record<SourceName, string>> = { yahoo: "Yahoo prices", groww: "Groww", gnews: "GNews", rss: "News feeds", gdelt: "GDELT", claude: "News scorer (LLM)", relay: "Order relay" };
const sourceLabel = (s: SourceName) => SOURCE_LABEL[s] ?? s.toUpperCase();
const STATUS_WORD = { loading: "connecting", live: "live", stale: "stale", offline: "offline" } as const;
/** Extra news sources: losing one leaves the publisher feeds and Bing News running. */
const OPTIONAL_SOURCES: ReadonlySet<SourceName> = new Set<SourceName>(["gdelt", "gnews"]);

function Row({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 18px", borderTop: `1px solid ${C.borderSoft}`, fontSize: 13 }}>
      <span style={{ color: C.muted, display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>{k}</span>
      <span className="tnum" style={{ color: C.textSoft, textAlign: "right", minWidth: 0, overflowWrap: "anywhere" }}>
        {children}
      </span>
    </div>
  );
}

function Ago({ at }: { at: string | null }) {
  const now = useNow();
  if (!at) return <>never</>;
  if (now == null) return <>—</>;
  return <>{fmtAge(Math.max(0, now - Date.parse(at)))} ago</>;
}

/** The engine loop, each data source, today's scoring volume and this page's own connection. */
export default function EngineStatusBar() {
  const { state, status, fastIntervalMs, source } = useEngineState();
  const hb = state?.heartbeat;
  const statusColor = status === "live" ? C.green : status === "loading" ? C.muted : status === "stale" ? C.orange : C.red;
  const dataSource = state?.dataSource ?? source;
  return (
    <Panel>
      <PanelHeader title="Data and engine health" right={dataSource === "mock" ? <Pill color={C.purple}>◇ mock data</Pill> : hb?.version ? <span style={{ fontSize: 12, color: C.muted3 }}>v{hb.version}</span> : undefined} />
      <Row
        k={
          <>
            <Dot color={hb ? enginePhaseColor(hb.phase) : C.muted3} size={7} /> Engine
          </>
        }
      >
        {hb ? (
          <>
            {hb.phase.toLowerCase()} · tick <Ago at={hb.lastTickAt} /> · every {hb.loopIntervalSec}s
            {hb.consecutiveErrors > 0 && <span style={{ color: C.red }}> · {hb.consecutiveErrors} errors</span>}
          </>
        ) : (
          "—"
        )}
      </Row>
      {state &&
        SOURCE_ORDER.filter((s) => state.health[s]).map((s) => {
          const h = state.health[s]!;
          // GDELT and GNews only add coverage on top of the publisher feeds and Bing News, and GDELT
          // rate-limits Cloudflare's shared addresses (HTTP 429) often: a warning, not a failure.
          const optional = OPTIONAL_SOURCES.has(s);
          const rateLimited = !h.ok && /\b429\b/.test(h.detail ?? "");
          const color = h.ok ? C.textSoft : optional ? C.orange : C.red;
          return (
            <Row
              key={s}
              k={
                <>
                  <Dot color={h.ok ? healthColor(true) : optional ? C.orange : healthColor(false)} size={7} /> {sourceLabel(s)}
                </>
              }
            >
              <span title={h.detail} style={{ color }}>
                {h.ok ? "ok" : rateLimited ? "rate-limited" : "failing"}
                {!h.ok && optional ? " · optional, other feeds cover it" : ""}
                {h.lastOkAt ? ` · last ok ${fmtIstHm(h.lastOkAt)}` : ""}
              </span>
            </Row>
          );
        })}
      {state && (
        <Row k="Today">
          {state.stats.clustersScoredToday} stories scored · {state.stats.signalsToday} decisions · LLM {fmtCompact(state.stats.llmInputTokensToday)} in / {fmtCompact(state.stats.llmOutputTokensToday)} out
        </Row>
      )}
      <Row
        k={
          <>
            <Dot color={statusColor} size={7} /> This page
          </>
        }
      >
        {STATUS_WORD[status]} · refreshes every {Math.round(fastIntervalMs / 1000)}s
      </Row>
    </Panel>
  );
}
