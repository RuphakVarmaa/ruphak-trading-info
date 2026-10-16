"use client";

import type { CopyTicketView } from "@/engine/api-types";
import { useSharedPoll, type PollState } from "@/components/Copy/sharedPoll";
import { ticketsUrl } from "@/components/Copy/useIndexActions";
import { isAgentAccount } from "./engineView";
import { useEngineState, useNow } from "@/hooks/useEngineState";
import { istDate, sessionPhaseAt } from "@/lib/ist";
import { REFRESH_CLOSED_MS, REFRESH_IMPORTANT_MS } from "@/lib/refresh";

export interface TodayTickets {
  /** The paper account the page follows ("main" by default). */
  account: string;
  /** IST date of today on the engine's clock (null during server render). */
  date: string | null;
  poll: PollState<CopyTicketView[]>;
  /** The options agent's paper account: it has no copy tickets, so nothing is polled and `poll` stays empty. */
  agent: boolean;
}

/**
 * Today's copy tickets for the page's account: the same URL, and so the same shared poll, as the
 * "What to do now" strip (useIndexActions), so reading them here costs no extra request.
 */
export function useTodayTickets(accountProp?: string): TodayTickets {
  const { state } = useEngineState();
  const now = useNow();
  const account = accountProp ?? state?.account?.id ?? "main";
  const date = now != null ? istDate(now) : (state?.market.nowIst.slice(0, 10) ?? null);
  // Holiday-aware like useIndexActions: on a weekday market holiday the clock alone says OPEN.
  const sameDay = state != null && now != null && state.market.nowIst.slice(0, 10) === istDate(now);
  const holiday = sameDay && (state.market.phase === "HOLIDAY" || state.market.isHoliday === true);
  const phase = now != null ? (holiday ? "HOLIDAY" : sessionPhaseAt(now)) : (state?.market.phase ?? "CLOSED");
  const active = phase === "OPEN" || phase === "PRE_OPEN";
  const agent = isAgentAccount(account, state);
  const poll = useSharedPoll<CopyTicketView[]>(agent ? null : ticketsUrl(date, account), active ? REFRESH_IMPORTANT_MS : REFRESH_CLOSED_MS);
  return { account, date, poll, agent };
}
