"use client";

import SiteHeader from "@/components/shared/SiteHeader";
import { useEngineState } from "@/hooks/useEngineState";
import type { EngineMode } from "@/engine/api-types";

/** The site header with the PAPER/LIVE badge taken from the live engine state, so it shows even when the server could not fetch the mode in time. */
export default function LiveHeader({ serverMode }: { serverMode: EngineMode | null }) {
  const { state } = useEngineState();
  return <SiteHeader active="live" mode={state?.mode ?? serverMode} />;
}
