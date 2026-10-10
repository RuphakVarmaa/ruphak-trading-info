import { C } from "@/components/shared/colors";
import type { ActionTone } from "@/lib/copy/action";

/** Colour means one thing each: terracotta = act, orange = stale, dark = a trade to hold, grey = nothing to do. */
export const TONE_COLOR: Record<ActionTone, string> = { action: C.gold, stale: C.orange, hold: C.textStrong, idle: C.muted };
