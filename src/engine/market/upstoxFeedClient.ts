/**
 * The Upstox market-feed connection, independent of the Workers runtime (the socket opener, fetch, clock and
 * calendar are injected), so MarketFeedDO (workers/engine/src/do/MarketFeedDO.ts) is a thin shell around it:
 *
 * - inside the feed window (09:10-15:35 IST on trading days) it holds one socket: authorize (the wss URL is
 *   one-time, so every connect re-authorizes), open, subscribe the four indices in mode "full" and, for NIFTY
 *   and SENSEX, the nearest expiry's ATM +/- 15 strikes in mode "option_greeks" (bid/ask, OI, IV, greeks);
 * - it re-centres those strikes when the spot moves more than 3 strikes, and reloads the strike list
 *   (2 REST calls per index) every 30 minutes or when the expiry rolls;
 * - a failed connect or a dropped socket is retried with backoff (1 s doubling to 30 s); a socket silent for
 *   90 s is dropped and reconnected;
 * - outside the window the socket is closed.
 *
 * `tick()` is the alarm body: it never throws and returns the delay until it wants to run again. Status and
 * errors never carry the token or the authorized URL (redactFeedError).
 */
import type { IndexId } from "../api-types";
import { istDate } from "../clock";
import { UpstoxChainClient, UPSTOX_UNDERLYING_KEYS, defaultExpiry, type OptionContractsMeta, type ParsedChain } from "./upstoxChain";
import {
  FEED_INDEX_KEYS,
  TickStore,
  UPSTOX_FEED_AUTHORIZE_URL,
  feedBackoffMs,
  feedRequestFrame,
  inFeedWindow,
  needsRecentre,
  nextFeedWindowStart,
  optionFeedMode,
  redactFeedError,
  selectStrikes,
  strikeKeysFromRows,
  type FeedSnapshot,
  type StrikeKeys,
  type StrikeSelection,
} from "./upstoxFeed";

function isBlobLike(v: unknown): v is { arrayBuffer(): Promise<ArrayBuffer> } {
  return typeof v === "object" && v !== null && typeof (v as { arrayBuffer?: unknown }).arrayBuffer === "function";
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (typeof v !== "object") return typeof v;
  return (v as { constructor?: { name?: string } }).constructor?.name || "object";
}

/** The subset of a WebSocket the client uses (Workers' WebSocket after accept(), or a test fake). */
export interface FeedSocket {
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", listener: (ev: { data?: unknown; code?: number; reason?: string; message?: string }) => void): void;
}

export interface ChainSource {
  contracts(index: IndexId): Promise<OptionContractsMeta>;
  chain(index: IndexId, expiry: string): Promise<ParsedChain>;
}

export interface FeedClientOptions {
  token?: string;
  /** Opens an authorized wss:// URL and returns an accepted socket. */
  openSocket: (url: string) => Promise<FeedSocket>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  /** Holidays: the feed only runs on trading days (default: every weekday). */
  isTradingDay?: (istDate: string) => boolean;
  /** Where the option strikes' instrument keys come from (default: the REST chain client). */
  chains?: ChainSource;
  log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
  /** Called when the client wants `tick()` sooner than it last asked (e.g. a reconnect after a drop). */
  wake?: (delayMs: number) => void;
}

export const FEED_TICK_MS = 30_000;
export const FEED_SILENT_MS = 90_000;
export const STRIKES_REFRESH_MS = 30 * 60_000;
const OPTION_INDICES: readonly IndexId[] = ["NIFTY", "SENSEX"];
const MAX_SLEEP_MS = 6 * 60 * 60_000;

export interface FeedStatus {
  inWindow: boolean;
  connected: boolean;
  connectedAt: string | null;
  lastMessageAt: string | null;
  /** Instruments subscribed on the current socket. */
  subscribed: number;
  /** Instruments with a tick in the store. */
  instruments: number;
  frames: number;
  reconnects: number;
  consecutiveFailures: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  marketStatus: Record<string, string>;
  /** Per index: the subscribed expiry, centre strike and strike count. */
  options: Partial<Record<IndexId, { expiry: string; centre: number; strikes: number }>>;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** One index's subscribed option strikes (UpstoxFeedClient.optionBooks). */
export interface OptionBook {
  index: IndexId;
  expiry: string;
  lotSize: number | null;
  strikes: StrikeKeys[];
}

export class UpstoxFeedClient {
  readonly store = new TickStore();
  private socket: FeedSocket | null = null;
  private running: Promise<number> | null = null;
  private connectedAt: number | null = null;
  private lastMessageAt: number | null = null;
  private reconnects = 0;
  private failures = 0;
  private nextAttemptAt = 0;
  private lastError: string | null = null;
  private lastErrorAt: number | null = null;
  private guid = 0;
  private readonly subscribed = new Set<string>();
  private readonly strikes = new Map<IndexId, { expiry: string; list: StrikeKeys[]; spot: number; at: number; lotSize: number }>();
  private readonly selections = new Map<IndexId, StrikeSelection>();
  private readonly chains: ChainSource | null;

  constructor(private readonly o: FeedClientOptions) {
    this.chains = o.chains ?? (o.token ? new UpstoxChainClient({ token: o.token, fetch: o.fetch }) : null);
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  inWindow(now = this.now()): boolean {
    return inFeedWindow(now) && (this.o.isTradingDay ? this.o.isTradingDay(istDate(now)) : true);
  }

  private fail(err: unknown): void {
    this.lastError = redactFeedError(err, [this.o.token]);
    this.lastErrorAt = this.now();
    this.o.log?.("warn", "market feed error", { error: this.lastError });
  }

  /** The alarm body: connect, maintain or close as the window says. Never throws; returns the next delay (ms). */
  tick(): Promise<number> {
    if (!this.running) {
      this.running = this.step()
        .catch((err: unknown) => {
          this.fail(err);
          return FEED_TICK_MS;
        })
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  private async step(): Promise<number> {
    const now = this.now();
    if (!this.inWindow(now)) {
      this.close("outside the feed window");
      let next = nextFeedWindowStart(now);
      // A holiday inside the window's hours: sleep until a later day's window.
      if (next <= now) next = nextFeedWindowStart(now + 7 * 60 * 60_000);
      return Math.min(MAX_SLEEP_MS, Math.max(1_000, next - now));
    }
    if (!this.o.token) {
      this.lastError = "no market feed: set UPSTOX_ANALYTICS_TOKEN";
      return 5 * 60_000;
    }
    if (this.socket) {
      const silentSince = this.lastMessageAt ?? this.connectedAt ?? now;
      if (now - silentSince > FEED_SILENT_MS) {
        this.fail(new Error(`no feed message for ${Math.round((now - silentSince) / 1000)} s: reconnecting`));
        this.drop();
      } else {
        await this.maintainStrikes();
        return FEED_TICK_MS;
      }
    }
    if (now >= this.nextAttemptAt) await this.connect();
    if (this.socket) return FEED_TICK_MS;
    return Math.min(FEED_TICK_MS, Math.max(250, this.nextAttemptAt - this.now()));
  }

  private async authorize(): Promise<string> {
    const init: RequestInit = {
      headers: { Accept: "application/json", Authorization: `Bearer ${this.o.token}` },
      signal: AbortSignal.timeout(8_000),
    };
    const res = this.o.fetch ? await this.o.fetch(UPSTOX_FEED_AUTHORIZE_URL, init) : await fetch(UPSTOX_FEED_AUTHORIZE_URL, init);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      if (res.status === 401) throw new Error("feed authorize: Upstox rejected the token (HTTP 401): renew UPSTOX_ANALYTICS_TOKEN");
      throw new Error(`feed authorize: HTTP ${res.status}`);
    }
    const data = (body as { data?: { authorized_redirect_uri?: unknown; authorizedRedirectUri?: unknown } } | null)?.data;
    const url = data?.authorized_redirect_uri ?? data?.authorizedRedirectUri;
    if (typeof url !== "string" || !/^wss:\/\//.test(url)) throw new Error("feed authorize: no authorized_redirect_uri in the response");
    return url;
  }

  private async connect(): Promise<void> {
    try {
      const url = await this.authorize();
      const sock = await this.o.openSocket(url);
      this.socket = sock;
      this.connectedAt = this.now();
      this.lastMessageAt = null;
      this.subscribed.clear();
      this.selections.clear();
      sock.addEventListener("message", (ev) => this.onMessage(sock, ev.data));
      sock.addEventListener("close", (ev) => this.onClosed(sock, `feed socket closed (code ${ev.code ?? "?"}${ev.reason ? ` ${String(ev.reason).slice(0, 80)}` : ""})`));
      sock.addEventListener("error", (ev) => this.onClosed(sock, `feed socket error${ev.message ? `: ${ev.message}` : ""}`));
      this.o.log?.("info", "market feed connected", { reconnects: this.reconnects });
      this.subscribe("full", FEED_INDEX_KEYS);
      await this.maintainStrikes();
    } catch (err) {
      this.fail(err);
      this.failures++;
      this.nextAttemptAt = this.now() + feedBackoffMs(this.failures - 1);
    }
  }

  private subscribe(mode: Parameters<typeof feedRequestFrame>[2], keys: readonly string[], method: "sub" | "unsub" = "sub"): void {
    if (!this.socket || keys.length === 0) return;
    this.socket.send(feedRequestFrame(`rk${++this.guid}`, method, mode, keys));
    for (const k of keys) {
      if (method === "sub") this.subscribed.add(k);
      else this.subscribed.delete(k);
    }
  }

  private onMessage(sock: FeedSocket, data: unknown): void {
    if (sock !== this.socket) return;
    const now = this.now();
    this.lastMessageAt = now;
    if (typeof data === "string") return; // Upstox sends protobuf; ignore any text frame.
    if (data instanceof ArrayBuffer) return this.applyBytes(new Uint8Array(data), now);
    if (ArrayBuffer.isView(data)) return this.applyBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), now);
    // A Blob arrives when the socket's binaryType is "blob" (the Workers default at the engine's
    // compatibility date); the opener sets "arraybuffer", and this keeps any other socket working.
    if (isBlobLike(data)) {
      data.arrayBuffer().then(
        (buf) => {
          if (sock === this.socket) this.applyBytes(new Uint8Array(buf), now);
        },
        (err: unknown) => this.fail(err),
      );
      return;
    }
    // Never drop frames silently: report the type in the status.
    this.fail(new Error(`feed message of unexpected type ${typeName(data)} ignored`));
  }

  private applyBytes(bytes: Uint8Array, now: number): void {
    try {
      this.store.applyFrame(bytes, now);
      this.failures = 0;
    } catch (err) {
      this.fail(err);
    }
  }

  private onClosed(sock: FeedSocket, why: string): void {
    if (sock !== this.socket) return;
    this.socket = null;
    this.subscribed.clear();
    this.selections.clear();
    this.reconnects++;
    this.fail(new Error(why));
    const delay = feedBackoffMs(this.failures);
    this.failures++;
    this.nextAttemptAt = this.now() + delay;
    this.o.wake?.(delay);
  }

  /** Closes the socket without scheduling a reconnect. */
  close(reason: string): void {
    const sock = this.socket;
    if (!sock) return;
    this.socket = null;
    this.subscribed.clear();
    this.selections.clear();
    try {
      sock.close(1000, reason.slice(0, 100));
    } catch {
      // already closed
    }
    this.o.log?.("info", "market feed closed", { reason });
  }

  /** Drops a dead socket and reconnects on the next tick. */
  private drop(): void {
    const sock = this.socket;
    this.close("stale feed");
    if (sock) {
      this.reconnects++;
      this.nextAttemptAt = this.now();
    }
  }

  /** Loads (or refreshes) each index's strike list and keeps its subscription centred on the spot. */
  private async maintainStrikes(): Promise<void> {
    if (!this.socket || !this.chains) return;
    const now = this.now();
    const keep = new Set<string>(FEED_INDEX_KEYS);
    for (const index of OPTION_INDICES) {
      try {
        let s = this.strikes.get(index);
        const expired = s && s.expiry < istDate(now);
        if (!s || expired || now - s.at > STRIKES_REFRESH_MS) {
          const meta = await this.chains.contracts(index);
          const expiry = defaultExpiry(meta.expiries, now);
          if (!expiry) throw new Error(`Upstox lists no upcoming ${index} expiry`);
          const chain = await this.chains.chain(index, expiry);
          const list = strikeKeysFromRows(chain.rows);
          if (list.length === 0) throw new Error(`Upstox returned an empty ${index} chain`);
          if (s && s.expiry !== expiry) this.selections.delete(index);
          s = { expiry, list, spot: chain.spot, at: now, lotSize: meta.lotSize };
          this.strikes.set(index, s);
        }
        if (!this.socket) return;
        const spot = this.store.get(UPSTOX_UNDERLYING_KEYS[index])?.ltp ?? s.spot;
        const sel = this.selections.get(index) ?? null;
        const stale = sel && !sel.keys.every((k) => s!.list.some((x) => x.ce === k || x.pe === k));
        if (stale || needsRecentre(sel, spot)) {
          const next = selectStrikes(s.list, spot);
          if (next) {
            const nextKeys = new Set(next.keys);
            const removed = (sel?.keys ?? []).filter((k) => !nextKeys.has(k));
            const added = next.keys.filter((k) => !this.subscribed.has(k));
            this.subscribe("ltpc", removed, "unsub");
            this.subscribe(optionFeedMode(next.keys.length * OPTION_INDICES.length), added);
            this.selections.set(index, next);
            this.o.log?.("info", "market feed strikes", { index, expiry: s.expiry, centre: next.centre, added: added.length, removed: removed.length });
          }
        }
        for (const k of this.selections.get(index)?.keys ?? []) keep.add(k);
      } catch (err) {
        this.fail(err);
        for (const k of this.selections.get(index)?.keys ?? []) keep.add(k);
      }
    }
    this.store.retain(keep);
  }

  /**
   * Per option index, the subscribed expiry, its lot size and the subscribed strikes with their keys
   * (ascending), for the option-flow monitor's minute samples. Empty before the first subscription.
   */
  optionBooks(): OptionBook[] {
    const out: OptionBook[] = [];
    for (const index of OPTION_INDICES) {
      const sel = this.selections.get(index);
      const s = this.strikes.get(index);
      if (!sel || !s) continue;
      const keys = new Set(sel.keys);
      const strikes = s.list.filter((x) => (x.ce !== null && keys.has(x.ce)) || (x.pe !== null && keys.has(x.pe)));
      if (strikes.length > 0) out.push({ index, expiry: s.expiry, lotSize: s.lotSize > 0 ? s.lotSize : null, strikes });
    }
    return out;
  }

  /** True while a socket is open. */
  get connected(): boolean {
    return this.socket !== null;
  }

  /** The latest ticks (all, or those for `keys`) with the stream's liveness. */
  ticks(keys?: readonly string[]): FeedSnapshot {
    return { ticks: this.store.list(keys), connected: this.socket !== null, lastMessageAt: this.lastMessageAt, at: this.now() };
  }

  status(): FeedStatus {
    const options: FeedStatus["options"] = {};
    for (const index of OPTION_INDICES) {
      const sel = this.selections.get(index);
      const s = this.strikes.get(index);
      if (sel && s) options[index] = { expiry: s.expiry, centre: sel.centre, strikes: sel.keys.length };
    }
    return {
      inWindow: this.inWindow(),
      connected: this.socket !== null,
      connectedAt: this.socket ? iso(this.connectedAt) : null,
      lastMessageAt: iso(this.lastMessageAt),
      subscribed: this.subscribed.size,
      instruments: this.store.size,
      frames: this.store.frames,
      reconnects: this.reconnects,
      consecutiveFailures: this.failures,
      nextAttemptAt: this.socket || this.nextAttemptAt === 0 ? null : iso(this.nextAttemptAt),
      lastError: this.lastError,
      lastErrorAt: iso(this.lastErrorAt),
      marketStatus: { ...this.store.marketStatus },
      options,
    };
  }
}
