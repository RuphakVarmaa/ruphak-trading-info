/**
 * First-paint engine snapshot for the home page: every read in parallel under one
 * overall deadline. A slice that fails or misses the deadline is null; the client
 * provider fills it on its first poll.
 */
import "server-only";
import type { EngineMode } from "@/engine/api-types";
import type { EngineSnapshot } from "@/lib/engine/types";
import { istDate } from "@/lib/ist";
import { getEngineApi } from "./server";

const SNAPSHOT_TIMEOUT_MS = 2000;
export const DEFAULT_SCHEDULED_HOURS = 192;
export const DEFAULT_EVENTS_LIMIT = 60;
export const DEFAULT_PNL_DAYS = 30;

function settle<T>(p: Promise<T>, deadline: Promise<null>): Promise<T | null> {
  return Promise.race([p.catch(() => null), deadline]);
}

export async function getInitialEngineSnapshot(): Promise<EngineSnapshot | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SNAPSHOT_TIMEOUT_MS);
  });
  try {
    const engine = await settle(getEngineApi(), deadline);
    if (!engine) return null;
    const { api, source } = engine;
    const [state, signals, positions, events, orders, pnl, performance, scheduled] = await Promise.all([
      settle(api.getState(), deadline),
      settle(api.getSignals(), deadline),
      settle(api.getPositions(), deadline),
      settle(api.getEvents({ tab: "ALL", limit: DEFAULT_EVENTS_LIMIT }), deadline),
      settle(api.getOrders(istDate(Date.now())), deadline),
      settle(api.getPnl(DEFAULT_PNL_DAYS), deadline),
      settle(api.getPerformance(), deadline),
      settle(api.getScheduled(DEFAULT_SCHEDULED_HOURS), deadline),
    ]);
    return { source, fetchedAt: Date.now(), state, signals, positions, events, orders, pnl, performance, scheduled };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Engine mode for page headers (null when the engine does not answer within 1.5 s). */
export async function getEngineModeQuick(): Promise<EngineMode | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), 1500);
  });
  try {
    const engine = await settle(getEngineApi(), deadline);
    if (!engine) return null;
    const state = await settle(engine.api.getState(), deadline);
    return state?.mode ?? null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
