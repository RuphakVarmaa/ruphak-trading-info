import type { ImpactView } from "@/engine/api-types";
import { alpha, C, dirColor, dirGlyph } from "@/components/shared/colors";

const INDEX_SHORT: Record<string, string> = { NIFTY: "NIFTY", SENSEX: "SENSEX" };

/** "NIFTY ▼0.46 • 72% • t½ 6h": direction glyph + signed score, confidence, half-life. */
export default function ImpactChip({ impact, dim = false }: { impact: ImpactView; dim?: boolean }) {
  const color = dirColor(impact.direction);
  const word = impact.direction > 0 ? "bullish" : impact.direction < 0 ? "bearish" : "neutral";
  const hl = impact.halfLifeHours >= 48 ? `${Math.round(impact.halfLifeHours / 24)}d` : `${Math.round(impact.halfLifeHours)}h`;
  return (
    <span
      title={`${impact.index}: ${word}, score ${impact.score.toFixed(2)}, expected move ≈${impact.magnitudePct}%, confidence ${Math.round(impact.confidence * 100)}%, half-life ${impact.halfLifeHours}h`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 9,
        fontFamily: "monospace",
        padding: "2px 6px",
        borderRadius: 3,
        whiteSpace: "nowrap",
        border: `1px solid ${alpha(color, dim ? 0.25 : 0.45)}`,
        background: alpha(color, 0.08),
        color: C.textDim,
      }}
    >
      <span style={{ color: C.textSoft, fontWeight: 700 }}>{INDEX_SHORT[impact.index] ?? impact.index}</span>
      <span style={{ color, fontWeight: 700 }}>
        {dirGlyph(impact.direction)}
        {Math.abs(impact.score).toFixed(2)}
      </span>
      <span style={{ color: C.muted3 }}>•</span>
      <span>{Math.round(impact.confidence * 100)}%</span>
      <span style={{ color: C.muted3 }}>•</span>
      <span>t½ {hl}</span>
    </span>
  );
}
