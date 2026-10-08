"use client";

/**
 * Everything the copy page knows right now, for one paper account: today's copy tickets (one shared
 * poll), the engine's signals and positions, the live index feed, the clock and the market phase,
 * turned into one decisive action per index by deriveIndexAction(). It needs only the EngineProvider
 * and the live feed, so the action strip works on any page that has them.
 */
import { useEffect, useMemo } from "react";
import type { CopyTicketView, EngineStateDTO, IndexId, PositionView, SessionPhase, SignalView } from "@/engine/api-types";
import { useClientNow, useEngineState, useNow, type ConnectionStatus } from "@/hooks/useEngineState";
import { useLiveIndices, type LiveIndicesState } from "@/hooks/useLiveIndices";
import { deriveIndexAction, type FeedInput, type IndexAction } from "@/lib/copy/action";
import { istDate, nextSessionOpen, sessionPhaseAt, toIstIso } from "@/lib/ist";
import { latchSkip, useDocumentHidden, useSkipLatch } from "./clientStores";
import { useSharedPoll, type PollState } from "./sharedPoll";

export const INDICES: readonly IndexId[] = ["NIFTY", "SENSEX"];

/** Ticket polls: every 5 s from pre-open to the close, every minute otherwise. */
const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 60_000;

export interface CopyAccount {
  id: string;
  label: string;
  /** Null when neither the engine state nor a ticket names it (e.g. before the first load). */
  capitalRupees: number | null;
}

export interface CopyData {
  account: CopyAccount;
  /** IST date of "today" on the engine's clock (null during server render). */
  date: string | null;
  /** Now on the engine's clock (null during server render and hydration). */
  nowMs: number | null;
  phase: SessionPhase;
  tickets: PollState<CopyTicketView[]>;
  /** Ms since the last good ticket response, browser clock. */
  ticketsAgeMs: number | null;
  signals: SignalView[] | null;
  live: LiveIndicesState;
  hidden: boolean;
  engineStatus: ConnectionStatus;
  /** One status per index; null until the clock is known. */
  actions: Record<IndexId, IndexAction> | null;
  /** True once the trade list and the live feed have each answered (or failed) at least once. */
  settled: boolean;
}

/** The market phase now: the clock decides, the engine's state adds today's holiday. */
function phaseAt(now: number, state: EngineStateDTO | null): SessionPhase {
  const sameDay = state != null && state.market.nowIst.slice(0, 10) === istDate(now);
  if (sameDay && (state.market.phase === "HOLIDAY" || state.market.isHoliday)) return "HOLIDAY";
  return sessionPhaseAt(now);
}

function feedFor(live: LiveIndicesState, index: IndexId, hidden: boolean): FeedInput {
  const quote = live.data?.indices.find((i) => i.index === index) ?? null;
  return {
    freshness: live.freshness,
    ageMs: live.ageMs,
    price: quote?.price ?? null,
    error: live.error != null,
    sourceStale: live.data?.stale === true,
    hidden,
  };
}

export function ticketsUrl(date: string | null, account: string): string | null {
  if (!date) return null;
  return `/api/engine/copy?date=${date}${account !== "main" ? `&account=${encodeURIComponent(account)}` : ""}`;
}

/** `accountProp`: the paper account to follow (default: the EngineProvider's, else main). */
export function useIndexActions(accountProp?: string): CopyData {
  const { state, signals: providerSignals, positions: providerPositions, status } = useEngineState();
  const now = useNow();
  const clientNow = useClientNow();
  const live = useLiveIndices();
  const hidden = useDocumentHidden();
  const latched = useSkipLatch();

  const providerAccount = state?.account?.id ?? null;
  const accountId = accountProp ?? providerAccount ?? "main";
  // Signals and positions are per account: read them directly when the provider follows another one.
  const mismatch = providerAccount != null && providerAccount !== accountId;
  const query = accountId !== "main" ? `?account=${encodeURIComponent(accountId)}` : "";
  const ownSignals = useSharedPoll<SignalView[]>(mismatch ? `/api/engine/signals${query}` : null, ACTIVE_POLL_MS);
  const ownPositions = useSharedPoll<PositionView[]>(mismatch ? `/api/engine/positions${query}` : null, ACTIVE_POLL_MS);
  const signals = mismatch ? ownSignals.data : providerSignals;
  const positions = mismatch ? ownPositions.data : providerPositions;

  const date = now != null ? istDate(now) : (state?.market.nowIst.slice(0, 10) ?? null);
  const phase: SessionPhase = now != null ? phaseAt(now, state) : (state?.market.phase ?? "CLOSED");
  const active = phase === "OPEN" || phase === "PRE_OPEN";
  const tickets = useSharedPoll<CopyTicketView[]>(ticketsUrl(date, accountId), active ? ACTIVE_POLL_MS : IDLE_POLL_MS, true);
  const ticketsAgeMs = tickets.at != null && clientNow != null ? Math.max(0, clientNow - tickets.at) : null;

  const stateAccount = state?.account?.id === accountId ? state.account : (state?.accounts?.find((a) => a.id === accountId) ?? null);
  const ticketAccount = tickets.data?.find((t) => t.account.id === accountId)?.account ?? null;
  const account: CopyAccount = {
    id: accountId,
    label: stateAccount?.label ?? ticketAccount?.label ?? (accountId === "main" ? "Main account" : `${accountId} account`),
    capitalRupees: stateAccount?.capitalRupees ?? ticketAccount?.capitalRupees ?? null,
  };

  const sameDayState = state != null && now != null && state.market.nowIst.slice(0, 10) === istDate(now);
  const nextOpenAt = now != null ? (state && Date.parse(state.market.nextOpenAt) > now ? state.market.nextOpenAt : toIstIso(nextSessionOpen(now))) : null;
  const holidayName = sameDayState ? state.market.holidayName : null;

  const actions = useMemo(() => {
    if (now == null) return null;
    const out = {} as Record<IndexId, IndexAction>;
    for (const index of INDICES) {
      out[index] = deriveIndexAction({
        index,
        account: accountId,
        signal: signals?.find((s) => s.index === index) ?? null,
        tickets: tickets.data,
        ticketsAgeMs,
        ticketsError: tickets.error != null,
        positions,
        nowMs: now,
        phase,
        nextOpenAt,
        holidayName,
        feed: feedFor(live, index, hidden),
        skipLatched: latched,
      });
    }
    return out;
  }, [now, accountId, signals, tickets.data, tickets.error, ticketsAgeMs, positions, phase, nextOpenAt, holidayName, live, hidden, latched]);

  // Once the index is seen past a trade's skip level on fresh data, that copy stays too late.
  useEffect(() => {
    if (!actions) return;
    for (const index of INDICES) {
      const a = actions[index];
      if (a.pastSkipNow && a.ticket) latchSkip(a.ticket.id);
    }
  }, [actions]);

  const settled = now != null && (tickets.data != null || tickets.error != null) && (live.freshness !== "loading" || live.error != null);

  return { account, date, nowMs: now, phase, tickets, ticketsAgeMs, signals: signals ?? null, live, hidden, engineStatus: status, actions, settled };
}
