"use client";

import type { SourceName } from "@/engine/api-types";
import { useEngineState, useNow } from "@/hooks/useEngineState";
import { C, enginePhaseColor, healthColor } from "@/components/shared/colors";
import { fmtAge, fmtCompact, fmtIstHm } from "@/components/shared/format";
import { Dot, Pill } from "@/components/shared/ui";

const SOURCE_ORDER: SourceName[] = ["yahoo", "groww", "gnews", "rss", "gdelt", "claude", "relay"];
const STATUS_WORD = { loading: "CONNECTING", live: "LIVE", stale: "STALE", offline: "OFFLINE" } as const;

function TickAge({ at }: { at: string | null }) {
  const now = useNow();
  if (!at) return <span>never</span>;
  if (now == null) return <span>—</span>;
  return <span className="tnum">{fmtAge(Math.max(0, now - Date.parse(at)))} ago</span>;
}

export default function EngineStatusBar() {
  const { state, status, fastIntervalMs, source } = useEngineState();
  const hb = state?.heartbeat;
  const statusColor = status === "live" ? C.green : status === "loading" ? C.muted : status === "stale" ? C.orange : C.red;
  const dataSource = state?.dataSource ?? source;
  return (
    <div
      style={{
        minHeight: 28,
        borderTop: `1px solid ${C.border}`,
        background: C.panelDeep,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "4px 14px",
        padding: "5px 14px",
        fontSize: 9,
        color: C.muted3,
        fontFamily: "monospace",
      }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Dot color={hb ? enginePhaseColor(hb.phase) : C.muted3} size={5} />
          ENGINE {hb?.phase ?? "—"}
        </span>
        <span>
          • tick <TickAge at={hb?.lastTickAt ?? null} /> • loop {hb ? `${hb.loopIntervalSec}s` : "—"}
          {hb && hb.consecutiveErrors > 0 && <span style={{ color: C.red }}> • ✗ {hb.consecutiveErrors} errors</span>}
        </span>
        {state && (
          <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            •
            {SOURCE_ORDER.filter((s) => state.health[s]).map((s) => {
              const h = state.health[s]!;
              return (
                <span
                  key={s}
                  title={`${s.toUpperCase()}: ${h.ok ? "ok" : "failing"}${h.lastOkAt ? ` · last ok ${fmtIstHm(h.lastOkAt)} IST` : ""}${h.detail ? ` · ${h.detail}` : ""}`}
                  style={{ display: "inline-flex", alignItems: "center", gap: 3, color: h.ok ? C.muted : C.red }}
                >
                  <Dot color={healthColor(h.ok)} size={5} />
                  {s.toUpperCase()} {h.ok ? "✓" : "✗"}
                </span>
              );
            })}
          </span>
        )}
        {state && (
          <span>
            • {state.stats.clustersScoredToday} clusters scored • {state.stats.signalsToday} decisions • LLM {fmtCompact(state.stats.llmInputTokensToday)} in /{" "}
            {fmtCompact(state.stats.llmOutputTokensToday)} out
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span>poll {Math.round(fastIntervalMs / 1000)}s</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: statusColor, fontWeight: 700 }}>
          <Dot color={statusColor} size={5} /> {STATUS_WORD[status]}
        </span>
        {dataSource === "mock" && (
          <Pill color={C.purple} title="Dashboard is using its built-in mock engine (ENGINE_MOCK=1 or no ENGINE binding). Numbers are simulated.">
            ◇ MOCK DATA
          </Pill>
        )}
        {hb?.version && <span title="Engine version">v{hb.version}</span>}
      </div>
    </div>
  );
}
