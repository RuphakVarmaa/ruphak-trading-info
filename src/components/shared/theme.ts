import type { CSSProperties } from "react";

/**
 * A warm, light "Claude" look: cream page, white cards, near-black text and a terracotta accent.
 * Set on a wrapper element; everything that reads the C colours (colors.ts) follows it.
 * Text colours were picked for at least 4.5:1 on the cream and white surfaces.
 */
export const CLAUDE_THEME = {
  colorScheme: "light",
  "--c-bg": "#faf9f5",
  "--c-panel": "#ffffff",
  "--c-panelAlt": "#f5f4ee",
  "--c-panelDeep": "#f0eee6",
  "--c-border": "#e5e2d8",
  "--c-borderStrong": "#d6d2c4",
  "--c-borderSoft": "#ece9df",
  "--c-thead": "#f3f1ea",
  "--c-navActive": "#efede4",
  "--c-track": "#e6e3d8",
  "--c-gold": "#c96442",
  "--c-green": "#2f7d4f",
  "--c-red": "#c2412d",
  "--c-orange": "#b5650d",
  "--c-blue": "#2f6db5",
  "--c-purple": "#7a5bc7",
  "--c-text": "#141413",
  "--c-textStrong": "#141413",
  "--c-textSoft": "#3d3d3a",
  "--c-textDim": "#4b4a46",
  "--c-muted": "#5f5e58",
  "--c-muted2": "#6f6e68",
  "--c-muted3": "#8a8981",
  // Chart slices: the light-mode steps of the reference categorical palette, plus neutrals.
  "--viz-1": "#2a78d6",
  "--viz-2": "#eb6834",
  "--viz-3": "#1baf7a",
  "--viz-neutral": "#8a8981",
  "--viz-free": "#e6e3d8",
} as CSSProperties;

/** Headings use a book serif (Source Serif 4, loaded in the root layout), as Claude does. */
export const SERIF = "var(--font-display)";
/** Figures: the text sans with tabular digits (set on body), so columns of numbers line up. */
export const NUM_FONT = "var(--font-num)";
