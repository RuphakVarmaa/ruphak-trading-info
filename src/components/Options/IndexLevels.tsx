"use client";

/**
 * One compact line of index levels from the engine's broker feed (GET /api/engine/live-indices): NIFTY,
 * SENSEX and India VIX with today's change, the chosen index outlined. Missing levels say "no data".
 */
import type { IndexId, LiveIndexLevelsView } from "@/engine/api-types";
import { alpha, C, dirColor, dirGlyph } from "@/components/shared/colors";
import { fmtAge, fmtIstTime, fmtNum, fmtPct, fmtSigned } from "@/components/shared/format";
import { Pill, Skeleton, microLabel } from "@/components/shared/ui";

const KEYS = [
  { key: "NIFTY", label: "NIFTY 50" },
  { key: "SENSEX", label: "SENSEX" },
  { key: "INDIAVIX", label: "India VIX" },
] as const;

export interface IndexLevelsProps {
  data: LiveIndexLevelsView | null;
  /** The poll's last failure as a plain sentence. */
  error: string | null;
  /** Browser age of the last good answer. */
  ageMs: number | null;
  index: IndexId;
}

export default function IndexLevels({ data, error, ageMs, index }: IndexLevelsProps) {
  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 104px), 1fr))", gap: 10 }}>
        {KEYS.map(({ key, label }) => {
          const l = data?.levels.find((x) => x.key === key) ?? null;
          const chosen = key === index;
          return (
            <div
              key={key}
              aria-current={chosen ? "true" : undefined}
              style={{
                minWidth: 0,
                padding: "10px 12px",
                borderRadius: 12,
                background: C.panel,
                border: `1px solid ${chosen ? alpha(C.gold, 0.6) : C.border}`,
                boxShadow: chosen ? `0 0 0 1px ${alpha(C.gold, 0.25)}` : "var(--shadow-card)",
              }}
            >
              <div style={{ ...microLabel, color: chosen ? C.gold : C.muted2 }}>{label}</div>
              {l ? (
                <>
                  <div className="tnum" style={{ fontSize: "clamp(14px, 4vw, 19px)", fontWeight: 650, color: C.textStrong, lineHeight: 1.25, whiteSpace: "nowrap" }}>
                    {fmtNum(l.price, 2)}
                  </div>
                  <div className="tnum" style={{ fontSize: 12.5, fontWeight: 600, color: l.change != null ? dirColor(l.change) : C.muted2 }}>
                    {l.change != null && l.changePct != null ? (
                      <>
                        <span aria-hidden>{dirGlyph(l.change)} </span>
                        {fmtSigned(l.change)} ({fmtPct(l.changePct)})
                      </>
                    ) : (
                      "change: no data"
                    )}
                  </div>
                </>
              ) : data ? (
                <div style={{ fontSize: 14, color: C.muted2, marginTop: 4 }}>no data</div>
              ) : (
                <Skeleton width="80%" height={34} style={{ marginTop: 4 }} />
              )}
            </div>
          );
        })}
      </div>
      <div className="tnum" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 10px", fontSize: 12, color: C.muted }}>
        {data && <Pill color={data.source === "mock" ? C.purple : C.blue}>{data.source === "mock" ? "Mock data" : "Upstox"}</Pill>}
        <span>
          {data ? `Index levels as of ${fmtIstTime(data.fetchedAt)} IST` : error ? "Index levels did not load" : "Loading index levels…"}
          {ageMs != null && ` · checked ${fmtAge(ageMs)} ago`}
        </span>
        {data?.error && <span style={{ color: C.orange }}>{data.error}</span>}
        {error && <span style={{ color: C.red }}>{error}</span>}
      </div>
    </div>
  );
}
