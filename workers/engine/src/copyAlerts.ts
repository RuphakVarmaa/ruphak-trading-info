/**
 * Copy-trade alerts: the engine's entries, trailing-stop activations and exits as Telegram texts a
 * person can act on by hand (see src/engine/copy/copyTicket.ts). Best-effort: when a ticket cannot
 * be built the short one-line alert is sent instead, and nothing here ever fails a tick.
 */
import type { AccountView } from "../../../src/engine/api-types";
import { HOUR_MS } from "../../../src/engine/clock";
import type { EngineConfig } from "../../../src/engine/config";
import { copyEntryText, copyExitText, copyLink, copyTicketView, copyTrailText } from "../../../src/engine/copy/copyTicket";
import type { Logger, Repository } from "../../../src/engine/ports";
import { trailPrice } from "../../../src/engine/strategy/exits";
import type { TradePlan, TradingMode } from "../../../src/engine/types";
import { errorMessage } from "./runtime";
import type { Alerts } from "./telegram";

export interface CopyAlertContext {
  /** The account's (scoped) repository. */
  repo: Repository;
  cfg: EngineConfig;
  account: AccountView;
  alerts: Alerts;
  logger: Logger;
  /** Base URL of the dashboard, for links to the copy page (no links when unset). */
  dashboardUrl?: string;
  /** Positions whose trailing-stop message was already sent by this instance. */
  trailSent: Set<string>;
}

async function ticketFor(ctx: CopyAlertContext, positionId: string, plan?: TradePlan | null) {
  const position = await ctx.repo.positions.get(positionId);
  if (!position) return null;
  const p = plan === undefined ? await ctx.repo.plans.get(position.planId) : plan;
  return copyTicketView({ position, plan: p, account: ctx.account, timeStopMinPnlPct: ctx.cfg.exits.timeStopMinPnlPct });
}

/** After an entry: the full ticket once the position exists, else `fallback`. */
export async function sendEntryAlert(ctx: CopyAlertContext, positionId: string | null, plan: TradePlan | null, fallback: string): Promise<void> {
  let text = fallback;
  try {
    const t = positionId ? await ticketFor(ctx, positionId, plan) : null;
    if (t) text = copyEntryText(t, copyLink(ctx.dashboardUrl, t));
  } catch (err) {
    ctx.logger.warn("copy entry alert failed; sending the short form", { account: ctx.account.id, error: errorMessage(err) });
  }
  await ctx.alerts.send(text);
}

/** After an exit: SELL with the paper result once the position is closed, else `fallback`. */
export async function sendExitAlert(ctx: CopyAlertContext, positionId: string, fallback: string): Promise<void> {
  let text = fallback;
  try {
    const t = await ticketFor(ctx, positionId, null);
    const exit = t ? copyExitText(t, copyLink(ctx.dashboardUrl, t)) : null;
    if (exit) text = exit;
  } catch (err) {
    ctx.logger.warn("copy exit alert failed; sending the short form", { account: ctx.account.id, error: errorMessage(err) });
  }
  await ctx.alerts.send(text);
}

/** Once per position: tells the copier the trailing stop is on and where it now sells. */
export async function sendTrailAlerts(ctx: CopyAlertContext, mode: TradingMode): Promise<void> {
  try {
    for (const position of await ctx.repo.positions.open(mode)) {
      if (ctx.trailSent.has(position.id) || trailPrice(position) === null) continue;
      ctx.trailSent.add(position.id);
      const t = copyTicketView({ position, plan: null, account: ctx.account, timeStopMinPnlPct: ctx.cfg.exits.timeStopMinPnlPct });
      const text = copyTrailText(t, copyLink(ctx.dashboardUrl, t));
      // The key survives restarts of this instance, so the message still goes out only once.
      if (text) await ctx.alerts.send(text, { key: `trail:${position.id}`, minIntervalMs: 24 * HOUR_MS });
    }
  } catch (err) {
    ctx.logger.warn("trail alert failed", { account: ctx.account.id, error: errorMessage(err) });
  }
}
