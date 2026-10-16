/**
 * MarketFeedDO: holds the one outbound WebSocket to Upstox's Market Data Feed V3 during 09:10-15:35 IST on
 * trading days (src/engine/market/upstoxFeedClient.ts does the work), so the dashboard gets index levels every
 * second and option quotes every couple of seconds without spending the REST budget.
 *
 * An alarm every ~30 s inside the window keeps the object alive and the socket healthy (reconnects use the
 * client's backoff, 1 s to 30 s); outside the window the socket is closed and the alarm sleeps until the next
 * window. The minute cron (ENGINE_WAKE) calls ensureRunning() so the feed connects at 09:10 on its own.
 *
 * Option flow: during the session (09:15-15:30) the alarm also wakes just after each minute and samples the
 * tick store (NIFTY and SENSEX, ATM ± 15 strikes of the nearest expiry: LTP, volume, OI, bid/ask, IV, delta)
 * into the flow monitor (src/engine/flow/flowMonitor.ts). Every kept sample is written to this object's
 * storage, so an eviction loses nothing: the constructor replays the session's samples. The next session
 * clears them.
 *
 * RPC: ticks(keys?), status(), getOptionFlow(index) and getOptionFlowAsOf(index, asOfMs) (the options agent's causal
 * read); none ever carries the token or the authorized wss URL.
 */
import { DurableObject } from "cloudflare:workers";
import { flowViewAsOf } from "../../../../src/engine/agent/flowAsOf";
import type { IndexId, OptionFlowView } from "../../../../src/engine/api-types";
import { defaultCalendar } from "../../../../src/engine/calendar/calendar";
import { istDate } from "../../../../src/engine/clock";
import { chainSnapshotFromTicks, inFlowSession } from "../../../../src/engine/flow/feedSnapshot";
import { FLOW_STATS } from "../../../../src/engine/flow/flowStats";
import { PersistentFlowMonitor, type FlowStorage } from "../../../../src/engine/flow/flowStore";
import type { FeedSnapshot } from "../../../../src/engine/market/upstoxFeed";
import { freshTicks, redactFeedError } from "../../../../src/engine/market/upstoxFeed";
import { UpstoxFeedClient, type FeedSocket, type FeedStatus } from "../../../../src/engine/market/upstoxFeedClient";
import { jsonLogger } from "../runtime";

const MIN_ALARM_MS = 250;
/** The flow sample is taken this long after each minute starts. */
const FLOW_SAMPLE_OFFSET_MS = 1_500;
/** A stream silent for longer than this is not sampled. */
const FLOW_FRESH_MS = 60_000;

/** Opens an authorized wss:// URL from a Worker (fetch with Upgrade: websocket, then accept()). */
async function openWorkerSocket(url: string): Promise<FeedSocket> {
  const resp = await fetch(url.replace(/^wss:\/\//i, "https://"), { headers: { Upgrade: "websocket" } });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`feed upgrade refused: HTTP ${resp.status}`);
  // At this Worker's compatibility date (2026-09-30) binary messages arrive as Blob unless this is set
  // (2024-era dates gave ArrayBuffer); the protobuf frames must arrive as ArrayBuffer, in order.
  ws.binaryType = "arraybuffer";
  ws.accept();
  return ws as unknown as FeedSocket;
}

export class MarketFeedDO extends DurableObject<Env> {
  private readonly client: UpstoxFeedClient;
  private readonly flow: PersistentFlowMonitor;
  /** The epoch minute last sampled into the flow monitor. */
  private flowMinute = 0;
  private readonly logger = jsonLogger("market-feed");

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const logger = this.logger;
    this.client = new UpstoxFeedClient({
      token: env.UPSTOX_ANALYTICS_TOKEN || undefined,
      openSocket: openWorkerSocket,
      isTradingDay: (date) => defaultCalendar.isTradingDay(date),
      log: (level, msg, data) => logger[level](msg, data),
      wake: (delayMs) => {
        void this.schedule(delayMs).catch(() => {});
      },
    });
    const storage = ctx.storage;
    const flowStorage: FlowStorage = {
      get: (key) => storage.get(key),
      put: (key, value) => storage.put(key, value),
      list: (o) => storage.list(o),
      delete: (keys) => storage.delete(keys),
    };
    this.flow = new PersistentFlowMonitor(flowStorage, { stats: FLOW_STATS });
    void ctx.blockConcurrencyWhile(async () => {
      try {
        await this.flow.load(Date.now());
      } catch (err) {
        logger.warn("option flow restore failed", { error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      }
    });
  }

  /** Sets the alarm `delayMs` from now unless one is already due sooner. */
  private async schedule(delayMs: number): Promise<void> {
    const now = Date.now();
    const at = now + Math.max(MIN_ALARM_MS, delayMs);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at || current < now - 60_000) await this.ctx.storage.setAlarm(at);
  }

  /** During the session with a live socket, wake just after the next minute starts (for the flow sample). */
  private withFlowCadence(delay: number, now: number): number {
    if (!inFlowSession(now) || !this.client.connected) return delay;
    return Math.min(delay, 60_000 - (now % 60_000) + FLOW_SAMPLE_OFFSET_MS);
  }

  /** One flow sample per minute from the tick store (inside the session, with a live stream). Never throws. */
  private async sampleFlow(now: number): Promise<void> {
    try {
      if (!inFlowSession(now) || !this.client.inWindow(now) || !this.client.connected) return;
      const minute = Math.floor(now / 60_000);
      if (minute === this.flowMinute) return;
      const fresh = freshTicks(this.client.ticks(), now, FLOW_FRESH_MS);
      if (fresh.size === 0) return;
      this.flowMinute = minute;
      for (const book of this.client.optionBooks()) {
        const snap = chainSnapshotFromTicks(book, (k) => fresh.get(k), now);
        if (snap) await this.flow.record(snap);
      }
    } catch (err) {
      this.logger.warn("option flow sample failed", { error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
  }

  /** Connects (inside the window) and makes sure the alarm is set. Called by the minute cron. */
  async ensureRunning(): Promise<FeedStatus> {
    const delay = await this.client.tick();
    const now = Date.now();
    await this.sampleFlow(now);
    await this.schedule(this.withFlowCadence(delay, now));
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
    const now = Date.now();
    await this.sampleFlow(now);
    try {
      await this.schedule(this.withFlowCadence(delay, now));
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

  /** The option flow for an index from this session's minute samples (empty, with a note, before the first). */
  async getOptionFlow(index: IndexId): Promise<OptionFlowView> {
    if (index !== "NIFTY" && index !== "SENSEX") throw new Error("index must be NIFTY or SENSEX");
    const now = Date.now();
    const snaps = this.flow.monitor.snapshots(index);
    const expiry = snaps[snaps.length - 1]?.expiry ?? null;
    const dte = expiry ? defaultCalendar.tradingDaysBetween(istDate(now), expiry) : null;
    return this.flow.view(index, now, { source: "feed", dte });
  }

  /**
   * The option flow as it read at `asOfMs`, from this session's minute samples taken at or before it (the options
   * agent's snapshot at a candle close; src/engine/agent/flowAsOf.ts). Null before the first sample.
   */
  async getOptionFlowAsOf(index: IndexId, asOfMs: number): Promise<OptionFlowView | null> {
    if (index !== "NIFTY" && index !== "SENSEX") throw new Error("index must be NIFTY or SENSEX");
    const at = Number(asOfMs);
    if (!Number.isFinite(at)) throw new Error("asOfMs must be a time in milliseconds");
    const snaps = this.flow.monitor.snapshots(index);
    const expiry = snaps[snaps.length - 1]?.expiry ?? null;
    const dte = expiry ? defaultCalendar.tradingDaysBetween(istDate(at), expiry) : null;
    return flowViewAsOf(snaps, index, at, { stats: FLOW_STATS, dte });
  }
}
