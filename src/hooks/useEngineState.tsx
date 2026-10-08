"use client";

/**
 * EngineProvider polls the /api/engine/* route handlers in three tiers:
 *   FAST  state, signals, positions        5 s while the market is OPEN/PRE_OPEN, else 30 s
 *   SLOW  events, orders, pnl, performance 60 s
 *   CAL   scheduled                        5 min
 * Each tier uses Promise.allSettled, pauses while the tab is hidden, refetches when it
 * becomes visible, and backs off (doubling, capped) while every request in it fails.
 * Last good data is never dropped. useNow() ticks once a second for countdown leaves only.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { EngineMode, EngineStateDTO, SessionPhase } from "@/engine/api-types";
import type { EngineSlices, EngineSnapshot, SliceKey } from "@/lib/engine/types";
import { storeAdminToken, useStoredAdminToken, verifyAdminToken } from "./adminToken";
import { EnvelopeError, errorText, fetchEnvelope } from "./engineFetch";

export type ConnectionStatus = "loading" | "live" | "stale" | "offline";
export type TierName = "fast" | "slow" | "cal";

export const SCHEDULED_HOURS = 192;
export const EVENTS_LIMIT = 60;
export const PNL_DAYS = 30;

const FAST_ACTIVE_MS = 5_000;
const FAST_IDLE_MS = 30_000;
const BASE_MS: Record<Exclude<TierName, "fast">, number> = { slow: 60_000, cal: 300_000 };
const CAP_MS: Record<TierName, number> = { fast: 60_000, slow: 180_000, cal: 600_000 };
/** Client clocks within this distance of the engine clock are trusted as-is. */
const CLOCK_DEADBAND_MS = 30_000;

const TIERS: TierName[] = ["fast", "slow", "cal"];
const TIER_SLICES: Record<TierName, { key: SliceKey; url: string }[]> = {
  fast: [
    { key: "state", url: "/api/engine/state" },
    { key: "signals", url: "/api/engine/signals" },
    { key: "positions", url: "/api/engine/positions" },
  ],
  slow: [
    { key: "events", url: `/api/engine/events?tab=ALL&limit=${EVENTS_LIMIT}` },
    { key: "orders", url: "/api/engine/orders" },
    { key: "pnl", url: `/api/engine/pnl?days=${PNL_DAYS}` },
    { key: "performance", url: "/api/engine/performance" },
  ],
  cal: [{ key: "scheduled", url: `/api/engine/scheduled?hours=${SCHEDULED_HOURS}` }],
};

/** Slices that belong to one paper account; events and scheduled events are shared. */
const ACCOUNT_SLICES: ReadonlySet<SliceKey> = new Set<SliceKey>(["state", "signals", "positions", "orders", "pnl", "performance"]);

/** The slice URL for `account` (main keeps the plain URL, so its cache keys do not change). */
export function sliceUrl(spec: { key: SliceKey; url: string }, account?: string): string {
  if (!account || account === "main" || !ACCOUNT_SLICES.has(spec.key)) return spec.url;
  return `${spec.url}${spec.url.includes("?") ? "&" : "?"}account=${encodeURIComponent(account)}`;
}

export interface TierMeta {
  lastOkAt: number | null;
  lastAttemptAt: number | null;
  failures: number;
  intervalMs: number;
  nextAt: number | null;
  lastError: string | null;
}

export interface AdminState {
  /** Token stored in this tab (null until read after hydration). */
  token: string | null;
  verified: boolean;
  verifying: boolean;
  error: string | null;
}

export type ActionResult = { ok: true } | { ok: false; code: string; error: string };

export interface EngineActions {
  arm(): Promise<ActionResult>;
  disarm(): Promise<ActionResult>;
  kill(squareOff: boolean, reason: string): Promise<ActionResult>;
  resetKill(): Promise<ActionResult>;
  setMode(mode: EngineMode): Promise<ActionResult>;
  refresh(tier?: TierName): void;
  /** Verifies a token with the server and remembers it for this tab on success. */
  setAdminToken(token: string): Promise<ActionResult>;
  clearAdminToken(): void;
}

export interface EngineContextValue extends EngineSlices {
  source: "engine" | "mock" | null;
  status: ConnectionStatus;
  tiers: Record<TierName, TierMeta>;
  fastIntervalMs: number;
  admin: AdminState;
  /** Name of the admin action in flight, if any. */
  pending: string | null;
  actions: EngineActions;
}

const EngineContext = createContext<EngineContextValue | null>(null);
const ClockOffsetContext = createContext(0);

function fastInterval(phase: SessionPhase | null): number {
  return phase == null || phase === "OPEN" || phase === "PRE_OPEN" ? FAST_ACTIVE_MS : FAST_IDLE_MS;
}

function clockOffsetFrom(engineNowIso: string, localMs: number): number {
  const off = Date.parse(engineNowIso) - localMs;
  return Number.isFinite(off) && Math.abs(off) >= CLOCK_DEADBAND_MS ? Math.round(off) : 0;
}

function emptyMeta(intervalMs: number): TierMeta {
  return { lastOkAt: null, lastAttemptAt: null, failures: 0, intervalMs, nextAt: null, lastError: null };
}

function initialMeta(initial: EngineSnapshot | null): Record<TierName, TierMeta> {
  const phase = initial?.state?.market.phase ?? null;
  const meta: Record<TierName, TierMeta> = {
    fast: emptyMeta(fastInterval(phase)),
    slow: emptyMeta(BASE_MS.slow),
    cal: emptyMeta(BASE_MS.cal),
  };
  if (initial) {
    for (const tier of TIERS) {
      if (TIER_SLICES[tier].some((s) => initial[s.key] != null)) meta[tier].lastOkAt = initial.fetchedAt;
    }
  }
  return meta;
}

function computeStatus(fast: TierMeta, now: number): ConnectionStatus {
  if (fast.failures >= 3) return "offline";
  if (fast.lastOkAt == null) return fast.failures > 0 ? "stale" : "loading";
  return now - fast.lastOkAt > 3 * fast.intervalMs ? "stale" : "live";
}

const cloneMeta = (m: Record<TierName, TierMeta>): Record<TierName, TierMeta> => ({
  fast: { ...m.fast },
  slow: { ...m.slow },
  cal: { ...m.cal },
});

/**
 * `account`: a paper account other than main (e.g. small10k); omitted means main. Give the provider
 * `key={account}` so switching accounts starts a fresh poller.
 */
export function EngineProvider({ initial, account, children }: { initial: EngineSnapshot | null; account?: string; children: ReactNode }) {
  const [slices, setSlices] = useState<EngineSlices>(() => ({
    state: initial?.state ?? null,
    signals: initial?.signals ?? null,
    positions: initial?.positions ?? null,
    events: initial?.events ?? null,
    orders: initial?.orders ?? null,
    pnl: initial?.pnl ?? null,
    performance: initial?.performance ?? null,
    scheduled: initial?.scheduled ?? null,
  }));
  const [source, setSource] = useState<"engine" | "mock" | null>(initial?.source ?? null);
  const [tiers, setTiers] = useState<Record<TierName, TierMeta>>(() => initialMeta(initial));
  const [status, setStatus] = useState<ConnectionStatus>(initial?.state ? "live" : "loading");
  const [clockOffsetMs, setClockOffsetMs] = useState<number>(() =>
    initial?.state ? clockOffsetFrom(initial.state.market.nowIst, initial.fetchedAt) : 0,
  );
  const [pending, setPending] = useState<string | null>(null);

  const token = useStoredAdminToken();
  const [verifiedToken, setVerifiedToken] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ token: string; error: string | null } | null>(null);

  const metaRef = useRef<Record<TierName, TierMeta>>(initialMeta(initial));
  const phaseRef = useRef<SessionPhase | null>(initial?.state?.market.phase ?? null);
  const offsetRef = useRef(clockOffsetMs);
  const runTierRef = useRef<(tier: TierName, bust?: boolean) => Promise<void>>(async () => {});

  // ---------------------------------------------------------------------------
  // Polling scheduler
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    const timers: Record<TierName, ReturnType<typeof setTimeout> | null> = { fast: null, slow: null, cal: null };
    const inflight: Record<TierName, boolean> = { fast: false, slow: false, cal: false };

    const baseInterval = (tier: TierName) => (tier === "fast" ? fastInterval(phaseRef.current) : BASE_MS[tier]);

    const publish = () => {
      setTiers(cloneMeta(metaRef.current));
      setStatus(computeStatus(metaRef.current.fast, Date.now()));
    };

    const schedule = (tier: TierName, delay: number) => {
      if (timers[tier]) clearTimeout(timers[tier]);
      metaRef.current[tier].nextAt = Date.now() + delay;
      timers[tier] = setTimeout(() => void runTier(tier), delay);
    };

    /** `bust` skips shared caches (s-maxage) right after an admin action or a manual retry. */
    const runTier = async (tier: TierName, bust = false): Promise<void> => {
      if (disposed || inflight[tier]) return;
      if (document.visibilityState === "hidden") return; // resumed by the visibility handler
      if (timers[tier]) clearTimeout(timers[tier]);
      inflight[tier] = true;
      const specs = TIER_SLICES[tier];
      const startedAt = Date.now();
      const urlFor = (url: string) => (bust ? `${url}${url.includes("?") ? "&" : "?"}_=${startedAt}` : url);
      const results = await Promise.allSettled(specs.map((s) => fetchEnvelope<unknown>(urlFor(sliceUrl(s, account)))));
      const endedAt = Date.now();
      inflight[tier] = false;
      if (disposed) return;

      const updates: Partial<Record<SliceKey, unknown>> = {};
      let okCount = 0;
      let lastError: string | null = null;
      let src: "engine" | "mock" | null = null;
      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          updates[specs[i].key] = r.value.data;
          src = r.value.source ?? src;
          okCount++;
        } else {
          lastError = errorText(r.reason);
        }
      });
      if (okCount > 0) setSlices((prev) => ({ ...prev, ...(updates as Partial<EngineSlices>) }));
      if (src) setSource(src);
      const state = updates.state as EngineStateDTO | undefined;
      if (state) {
        phaseRef.current = state.market.phase;
        const off = clockOffsetFrom(state.market.nowIst, (startedAt + endedAt) / 2);
        if (Math.abs(off - offsetRef.current) >= 2000) {
          offsetRef.current = off;
          setClockOffsetMs(off);
        }
      }

      const meta = metaRef.current[tier];
      meta.lastAttemptAt = endedAt;
      const base = baseInterval(tier);
      meta.intervalMs = base;
      let delay = base;
      if (okCount > 0) {
        meta.lastOkAt = endedAt;
        meta.failures = 0;
        meta.lastError = okCount < specs.length ? lastError : null;
      } else {
        meta.failures += 1;
        meta.lastError = lastError;
        delay = Math.min(base * 2 ** meta.failures, Math.max(CAP_MS[tier], base));
      }
      schedule(tier, delay);
      publish();
    };
    runTierRef.current = runTier;

    // First run: tiers the server snapshot already filled wait one interval.
    for (const tier of TIERS) {
      const hasAll = TIER_SLICES[tier].every((s) => initial?.[s.key] != null);
      if (hasAll) schedule(tier, baseInterval(tier));
      else void runTier(tier);
    }

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        for (const tier of TIERS) {
          if (timers[tier]) clearTimeout(timers[tier]);
          timers[tier] = null;
        }
        return;
      }
      const now = Date.now();
      for (const tier of TIERS) {
        const meta = metaRef.current[tier];
        const due = meta.lastAttemptAt == null || tier === "fast" || now - meta.lastAttemptAt >= baseInterval(tier);
        if (due) void runTier(tier);
        else schedule(tier, baseInterval(tier) - (now - (meta.lastAttemptAt ?? now)));
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    const statusTimer = setInterval(() => {
      // Skip while hidden or while a FAST fetch is in flight (e.g. right after the tab returns).
      if (document.visibilityState === "visible" && !inflight.fast) setStatus(computeStatus(metaRef.current.fast, Date.now()));
    }, 2000);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(statusTimer);
      for (const tier of TIERS) if (timers[tier]) clearTimeout(timers[tier]);
    };
    // The scheduler is set up once; `initial` is only the first-paint snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Admin token verification
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void verifyAdminToken(token).then((res) => {
      if (cancelled) return;
      setVerifiedToken(res.ok ? token : null);
      setChecked({ token, error: res.ok ? null : res.error });
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const admin: AdminState = useMemo(
    () => ({
      token,
      verified: token != null && verifiedToken === token,
      verifying: token != null && checked?.token !== token,
      error: token != null && checked?.token === token ? checked.error : null,
    }),
    [token, verifiedToken, checked],
  );

  const refresh = useCallback((tier?: TierName) => {
    for (const t of tier ? [tier] : TIERS) void runTierRef.current(t, true);
  }, []);

  const post = useCallback(
    async (name: string, path: string, body: unknown, after: TierName[]): Promise<ActionResult> => {
      if (!token) return { ok: false, code: "UNAUTHORIZED", error: "Enter the admin token first." };
      setPending(name);
      try {
        const res = await fetchEnvelope<EngineStateDTO>(path, {
          method: "POST",
          headers: { "content-type": "application/json", "x-admin-token": token },
          body: JSON.stringify(body),
        });
        setSlices((prev) => ({ ...prev, state: res.data }));
        for (const t of after) refresh(t);
        return { ok: true };
      } catch (err) {
        if (err instanceof EnvelopeError) {
          if (err.status === 401) {
            setVerifiedToken(null);
            setChecked({ token, error: "Token rejected by the server." });
          }
          return { ok: false, code: err.code, error: err.message };
        }
        return { ok: false, code: "ENGINE_UNREACHABLE", error: errorText(err) };
      } finally {
        setPending(null);
      }
    },
    [token, refresh],
  );

  const actions: EngineActions = useMemo(
    () => ({
      arm: () => post("arm", "/api/engine/admin/arm", { armed: true }, ["fast"]),
      disarm: () => post("disarm", "/api/engine/admin/arm", { armed: false }, ["fast"]),
      kill: (squareOff: boolean, reason: string) =>
        post("kill", "/api/engine/admin/kill", { engaged: true, squareOff, reason, ...(account ? { account } : {}) }, ["fast", "slow"]),
      resetKill: () => post("reset", "/api/engine/admin/kill", { engaged: false, squareOff: false, reason: "Reset from dashboard", ...(account ? { account } : {}) }, ["fast"]),
      setMode: (mode: EngineMode) => post("mode", "/api/engine/admin/mode", { mode }, ["fast", "slow"]),
      refresh,
      setAdminToken: async (value: string) => {
        const candidate = value.trim();
        if (!candidate) return { ok: false, code: "BAD_REQUEST", error: "Token is empty." };
        const res = await verifyAdminToken(candidate);
        if (!res.ok) return res;
        setVerifiedToken(candidate);
        setChecked({ token: candidate, error: null });
        storeAdminToken(candidate);
        return { ok: true };
      },
      clearAdminToken: () => {
        storeAdminToken(null);
        setVerifiedToken(null);
        setChecked(null);
      },
    }),
    [post, refresh, account],
  );

  const value: EngineContextValue = useMemo(
    () => ({
      ...slices,
      source,
      status,
      tiers,
      fastIntervalMs: tiers.fast.intervalMs,
      admin,
      pending,
      actions,
    }),
    [slices, source, status, tiers, admin, pending, actions],
  );

  return (
    <ClockOffsetContext.Provider value={clockOffsetMs}>
      <EngineContext.Provider value={value}>{children}</EngineContext.Provider>
    </ClockOffsetContext.Provider>
  );
}

export function useEngineState(): EngineContextValue {
  const ctx = useContext(EngineContext);
  if (!ctx) throw new Error("useEngineState must be used inside <EngineProvider>");
  return ctx;
}

export function useOptionalEngineState(): EngineContextValue | null {
  return useContext(EngineContext);
}

// ---------------------------------------------------------------------------
// useNow: one shared 1 s ticker, null during SSR and hydration
// ---------------------------------------------------------------------------

let clockNow = 0;
let clockTimer: ReturnType<typeof setTimeout> | null = null;
const clockListeners = new Set<() => void>();

function clockTick() {
  clockNow = Date.now();
  clockListeners.forEach((l) => l());
  clockTimer = setTimeout(clockTick, 1000 - (Date.now() % 1000) + 5);
}

function subscribeClock(cb: () => void): () => void {
  clockListeners.add(cb);
  if (!clockTimer) {
    clockNow = Date.now();
    clockTimer = setTimeout(clockTick, 1000 - (Date.now() % 1000) + 5);
  }
  return () => {
    clockListeners.delete(cb);
    if (clockListeners.size === 0 && clockTimer) {
      clearTimeout(clockTimer);
      clockTimer = null;
    }
  };
}

function getClock(): number | null {
  if (clockNow === 0) clockNow = Date.now();
  return clockNow;
}

const getServerClock = (): number | null => null;

/**
 * Current time in epoch ms on the engine's clock (client clock plus any large offset
 * reported by the engine), refreshed every second. Null on the server and during
 * hydration, so time-relative text never causes a hydration mismatch.
 */
export function useNow(): number | null {
  const offset = useContext(ClockOffsetContext);
  const t = useSyncExternalStore(subscribeClock, getClock, getServerClock);
  return t == null ? null : t + offset;
}

/** Like useNow() but on the browser clock (for ages of client-side events such as polls). */
export function useClientNow(): number | null {
  return useSyncExternalStore(subscribeClock, getClock, getServerClock);
}

/** The engine-clock offset (ms) applied by useNow(); 0 unless the engine clock differs by ≥ 30 s. */
export function useClockOffset(): number {
  return useContext(ClockOffsetContext);
}
