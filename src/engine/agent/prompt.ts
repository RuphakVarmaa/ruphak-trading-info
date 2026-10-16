/** The reflex model's instructions and user message (SPEC §4.2–4.3). Only the guidance part ever changes. */
import type { BriefContext, Finalist, ReflexInput } from "./types";
import { notImplemented } from "./notImplemented";

/** The guidance the agent starts with; the nightly review may propose a replacement, which the operator approves. */
export const BUILTIN_GUIDANCE = [
  "- Prefer NEUTRAL when the 5-, 15- and 60-minute returns disagree, when ADX is below 20, or when the close is",
  "  inside the opening range.",
  "- A move is more likely to continue when r5 and r15, the VWAP side, Supertrend and the sign of di agree, and",
  "  the option flow agrees (call short covering or put short build-up for LONG; the reverse for SHORT).",
  "- Be wary late in a strong move: RSI above 75 or below 25, or vz beyond ±2.5, often reverts.",
  "- Expensive options (ivx above +3) need a bigger move to pay for themselves.",
  "- Lower your confidence when the option block is missing, when oa is above 120, or when pv is X.",
].join("\n");

/** `${REFLEX_CORE_VERSION}/${the first 8 hex digits of the guidance's FNV-1a hash}`. */
export function instructionVersion(guidance: string): string {
  return notImplemented(guidance);
}

/** The fixed core with the guidance in place of its marker. */
export function reflexSystem(guidance: string): string {
  return notImplemented(guidance);
}

/** The user message: the bar, the snapshots, the finalists and the brief's context, as JSON. */
export function reflexUser(input: ReflexInput, finalists: Finalist[], brief: BriefContext | null): string {
  return notImplemented(input, finalists, brief);
}
