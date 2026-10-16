/** The per-index snapshot the reflex model reads (SPEC §3): built in code, under SNAPSHOT_TOKEN_LIMIT estimated tokens. */
import type { IndexSnapshot } from "./types";
import { notImplemented } from "./notImplemented";

/** JSON with a fixed key order. */
export function encodeSnapshot(s: IndexSnapshot): string {
  return notImplemented(s);
}

/** A conservative token estimate: Math.ceil(text.length / CHARS_PER_TOKEN_BOUND). */
export function estimateTokens(text: string): number {
  return notImplemented(text);
}

/** A synthetic snapshot with every field present at its widest value: the token budget's worst case. */
export function worstCaseSnapshot(): IndexSnapshot {
  return notImplemented();
}
