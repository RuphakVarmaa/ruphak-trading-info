/**
 * Dashboard palette and semantic colour helpers. Colour is never the only channel:
 * every helper here has a glyph/word companion (see glyph helpers) used next to it.
 */
import type {
  EngineMode,
  EnginePhase,
  EventTaxonomy,
  ImpactLevel,
  Regime,
  SessionPhase,
  Severity,
  SourceStatus,
  Stance,
} from "@/engine/api-types";
import type { IntelItem } from "@/utils/api";

/**
 * Each colour is a CSS variable with today's dark value as the fallback, so every page looks the
 * same unless a wrapper sets the variables (see theme.ts, used by the Live P&L page).
 */
const token = (name: string, dark: string) => `var(--c-${name}, ${dark})`;

export const C = {
  bg: token("bg", "#0a0a0a"),
  panel: token("panel", "#111"),
  panelAlt: token("panelAlt", "#0f0f0f"),
  panelDeep: token("panelDeep", "#0d0d0d"),
  border: token("border", "#222"),
  borderStrong: token("borderStrong", "#2a2a2a"),
  borderSoft: token("borderSoft", "#1a1a1a"),
  thead: token("thead", "#151515"),
  navActive: token("navActive", "#1c1c1c"),
  track: token("track", "#1f1f1f"),
  gold: token("gold", "#ffb300"),
  green: token("green", "#4caf50"),
  red: token("red", "#f44336"),
  orange: token("orange", "#ff9800"),
  blue: token("blue", "#2196f3"),
  purple: token("purple", "#ab7df8"),
  text: token("text", "#ededed"),
  textStrong: token("textStrong", "#eee"),
  textSoft: token("textSoft", "#ccc"),
  textDim: token("textDim", "#aaa"),
  muted: token("muted", "#888"),
  muted2: token("muted2", "#666"),
  muted3: token("muted3", "#555"),
} as const;

// --- moved from IntelFeed -------------------------------------------------------

export function getSeverityColor(severity: IntelItem["severity"] | Severity): string {
  if (severity === "FLASH") return C.red;
  if (severity === "ALERT") return C.orange;
  return C.blue;
}

export function getCategoryColor(category: IntelItem["category"]): string {
  if (category === "MINING") return C.gold;
  if (category === "ENERGY") return "#e87940";
  if (category === "MILITARY") return C.red;
  if (category === "MARITIME") return C.blue;
  return C.muted;
}

// --- direction, stance, P&L ----------------------------------------------------------

export function dirColor(d: number): string {
  return d > 0 ? C.green : d < 0 ? C.red : C.muted;
}

export function dirGlyph(d: number): string {
  return d > 0 ? "▲" : d < 0 ? "▼" : "▬";
}

export function stanceColor(s: Stance): string {
  return s === "BULLISH" ? C.green : s === "BEARISH" ? C.red : C.muted;
}

export function stanceGlyph(s: Stance): string {
  return s === "BULLISH" ? "▲" : s === "BEARISH" ? "▼" : "▬";
}

export function pnlColor(n: number): string {
  return n > 0 ? C.green : n < 0 ? C.red : C.textDim;
}

// --- engine / market state ------------------------------------------------------------

export function regimeColor(r: Regime): string {
  switch (r) {
    case "TREND_UP":
      return C.green;
    case "TREND_DOWN":
      return C.red;
    case "HIGH_VOL":
      return C.orange;
    case "EVENT":
      return C.purple;
    default:
      return C.blue;
  }
}

export function regimeGlyph(r: Regime): string {
  switch (r) {
    case "TREND_UP":
      return "↗";
    case "TREND_DOWN":
      return "↘";
    case "HIGH_VOL":
      return "≋";
    case "EVENT":
      return "⚡";
    default:
      return "↔";
  }
}

export function modeColor(m: EngineMode | "BACKTEST"): string {
  return m === "LIVE" ? C.red : m === "PAPER" ? C.blue : C.purple;
}

export function phaseColor(p: SessionPhase): string {
  return p === "OPEN" ? C.green : p === "PRE_OPEN" ? C.orange : p === "HOLIDAY" ? C.purple : C.muted;
}

export function enginePhaseColor(p: EnginePhase): string {
  if (p === "OPEN") return C.green;
  if (p === "PREMARKET" || p === "CLOSING") return C.orange;
  if (p === "DEGRADED" || p === "KILLED") return C.red;
  return C.muted;
}

export function healthColor(ok: boolean): string {
  return ok ? C.green : C.red;
}

export function impactColor(level: ImpactLevel): string {
  return level === "HIGH" ? C.red : level === "MED" ? C.orange : "#3a3a3a";
}

export function sourceStatusColor(s: SourceStatus): string {
  return s === "ACTIVE" ? C.green : s === "PROBATION" ? C.orange : C.red;
}

export function sourceStatusGlyph(s: SourceStatus): string {
  return s === "ACTIVE" ? "●" : s === "PROBATION" ? "◐" : "○";
}

export function taxonomyColor(t: EventTaxonomy): string {
  switch (t) {
    case "MACRO_POLICY":
    case "US_MARKET_FED":
      return C.blue;
    case "GEOPOLITICAL":
    case "DOMESTIC_POLITICS_REGULATION":
      return C.red;
    case "CHINA":
      return "#e57373";
    case "COMMODITY_SHOCK":
      return "#e87940";
    case "WEATHER_DISASTER":
      return "#4db6ac";
    case "FII_FLOWS":
      return C.purple;
    case "CORPORATE_EARNINGS":
      return C.gold;
    default:
      return C.muted;
  }
}

/** Age dot: fresh (<60 s) green, delayed (<180 s) amber, stale red. */
export function ageColor(ageMs: number | null, stale = false): string {
  if (ageMs == null) return C.muted3;
  if (stale || ageMs > 180_000) return C.red;
  if (ageMs > 60_000) return C.orange;
  return C.green;
}

/** A colour with alpha, e.g. alpha('#f44336', 0.12). A CSS variable (a theme colour) is mixed with transparent instead. */
export function alpha(hex: string, a: number): string {
  if (!hex.startsWith("#")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`;
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
