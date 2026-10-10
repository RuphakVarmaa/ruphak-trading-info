import type { CSSProperties } from "react";

/**
 * Obsolete: the colour tokens live only in :root (app/globals.css) now. Kept as an empty object so
 * pages that still spread it into a style (live, copy) compile; it no longer overrides the tokens.
 */
export const CLAUDE_THEME: CSSProperties = {};

/** Headings use a book serif (Source Serif 4, loaded in the root layout), as Claude does. */
export const SERIF = "var(--font-display)";
/** Figures: the text sans with tabular digits (set on body), so columns of numbers line up. */
export const NUM_FONT = "var(--font-num)";
