/**
 * MarketFeedDO: holds the one outbound WebSocket to Upstox's Market Data Feed V3 during 09:10-15:35 IST on
 * trading days (src/engine/market/upstoxFeedClient.ts does the work), so the dashboard gets index levels every
 * second and option quotes every couple of seconds without spending the REST budget.
 *
 * An alarm every ~30 s inside the window keeps the object alive and the socket healthy (reconnects use the
 * client's backoff, 1 s to 30 s); outside the window the socket is closed and the alarm sleeps until the next
 * window. The minute cron (ENGINE_WAKE) calls ensureRunning() so the feed connects at 09:10 on its own.
 * RPC: ticks(keys?) and status(); neither ever carries the token or the authorized wss URL.
 */
import { DurableObject } from "cloudflare:workers";
import { defaultCalendar } from "../../../../src/engine/calendar/calendar";
import type { FeedSnapshot } from "../../../../src/engine/market/upstoxFeed";
import { redactFeedError } from "../../../../src/engine/market/upstoxFeed";
import { UpstoxFeedClient, type FeedSocket, type FeedStatus } from "../../../../src/engine/market/upstoxFeedClient";
import { jsonLogger } from "../runtime";

const MIN_ALARM_MS = 250;

/** Opens an authorized wss:// URL from a Worker (fetch with Upgrade: websocket, then accept()). */
async function openWorkerSocket(url: string): Promise<FeedSocket> {
  const resp = await fetch(url.replace(/^wss:\/\//i, "https://"), { headers: { Upgrade: "websocket" } });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`feed upgrade refused: HTTP ${resp.status}`);
  ws.accept();
  return ws as unknown as FeedSocket;
}

export class MarketFeedDO extends DurableObject<Env> {
  private readonly client: UpstoxFeedClient;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const logger = jsonLogger("market-feed");
    this.client = new UpstoxFeedClient({
      token: env.UPSTOX_ANALYTICS_TOKEN || undefined,
      openSocket: openWorkerSocket,
      isTradingDay: (date) => defaultCalendar.isTradingDay(date),
      log: (level, msg, data) => logger[level](msg, data),
      wake: (delayMs) => {
        void this.schedule(delayMs).catch(() => {});
      },
    });
  }

  /** Sets the alarm `delayMs` from now unless one is already due sooner. */
  private async schedule(delayMs: number): Promise<void> {
    const now = Date.now();
    const at = now + Math.max(MIN_ALARM_MS, delayMs);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at || current < now - 60_000) await this.ctx.storage.setAlarm(at);
  }

  /** Connects (inside the window) and makes sure the alarm is set. Called by the minute cron. */
  async ensureRunning(): Promise<FeedStatus> {
    const delay = await this.client.tick();
    await this.schedule(delay);
    return this.client.status();
  }

  async alarm(): Promise<void> {
    let delay = 30_000;
    try {
      delay = await this.client.tick();
    } catch (err) {
      // tick() never throws; this is belt and braces so the alarm is always re-armed.
      console.error(JSON.stringify({ level: "error", scope: "market-feed", msg: "alarm failed", data: { error: redactFeedError(err, [this.env.UPSTOX_ANALYTICS_TOKEN]) } }));
    }
    try {
      await this.schedule(delay);
    } catch {
      // The storage write failed; the minute cron re-arms it.
    }
  }

  /** The latest ticks (all, or those for `keys`) with each one's receive time and the stream's liveness. */
  async ticks(keys?: string[]): Promise<FeedSnapshot> {
    const list = Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string").slice(0, 500) : undefined;
    return this.client.ticks(list);
  }

  async status(): Promise<FeedStatus> {
    return this.client.status();
  }
}
