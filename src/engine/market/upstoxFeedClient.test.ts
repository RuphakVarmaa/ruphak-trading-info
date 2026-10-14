import { describe, expect, it } from "vitest";
import type { IndexId, OptionChainRowView } from "../api-types";
import { FEED_FRAMES_B64 } from "./upstoxFeed.fixture";
import { FEED_INDEX_KEYS } from "./upstoxFeed";
import { FEED_SILENT_MS, FEED_TICK_MS, UpstoxFeedClient, type ChainSource, type FeedSocket } from "./upstoxFeedClient";

const ist = (s: string) => Date.parse(`${s}+05:30`);
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2VjcmV0c2lnbmF0dXJl";
const WSS = "wss://wsfeeder-api.upstox.com/market-data-feeder/v3/upstox-developer-api/feeds?requestId=r1&code=onetime-secret";

type Listener = (ev: { data?: unknown; code?: number; reason?: string; message?: string }) => void;

class FakeSocket implements FeedSocket {
  sent: { guid: string; method: string; data: { mode: string; instrumentKeys: string[] } }[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Listener[]>();
  send(data: Uint8Array | string): void {
    this.sent.push(JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)));
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  addEventListener(type: string, l: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  emit(type: string, ev: Parameters<Listener>[0]): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
  keys(method = "sub"): string[] {
    return this.sent.filter((s) => s.method === method).flatMap((s) => s.data.instrumentKeys);
  }
}

function rows(index: IndexId, centre: number, step: number): OptionChainRowView[] {
  return Array.from({ length: 101 }, (_, i) => {
    const strike = centre + (i - 50) * step;
    const side = (t: string) => ({ instrumentKey: `${index}|${t}${strike}` }) as OptionChainRowView["ce"];
    return { strike, ce: side("CE"), pe: side("PE") };
  });
}

function harness(start = ist("2026-10-15T09:12:00")) {
  const clock = { t: start };
  const sockets: FakeSocket[] = [];
  const authorize = { status: 200, calls: 0 };
  const openFail = { error: null as string | null };
  const chainCalls: string[] = [];
  const wakes: number[] = [];
  const chains: ChainSource = {
    contracts: async (index) => {
      chainCalls.push(`contracts:${index}`);
      return { expiries: index === "NIFTY" ? ["2026-10-20"] : ["2026-10-15", "2026-10-22"], lotSize: 65 };
    },
    chain: async (index, expiry) => {
      chainCalls.push(`chain:${index}:${expiry}`);
      return index === "NIFTY" ? { spot: 22622.7, rows: rows("NIFTY", 22600, 50) } : { spot: 72781.89, rows: rows("SENSEX", 72800, 100) };
    },
  };
  const client = new UpstoxFeedClient({
    token: TOKEN,
    now: () => clock.t,
    chains,
    isTradingDay: (d) => d !== "2026-10-20",
    wake: (ms) => wakes.push(ms),
    fetch: async (url, init) => {
      authorize.calls++;
      expect(url).toBe("https://api.upstox.com/v3/feed/market-data-feed/authorize");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      if (authorize.status !== 200) return Response.json({ status: "error", errors: [{ message: `bad token ${TOKEN}` }] }, { status: authorize.status });
      return Response.json({ status: "success", data: { authorized_redirect_uri: WSS } });
    },
    openSocket: async (url) => {
      expect(url).toBe(WSS);
      if (openFail.error) throw new Error(openFail.error);
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  return { client, clock, sockets, authorize, openFail, chainCalls, wakes };
}

function expectNoSecrets(value: unknown): void {
  const s = JSON.stringify(value);
  expect(s).not.toContain(TOKEN);
  expect(s).not.toContain("onetime-secret");
  expect(s).not.toContain("requestId");
}

describe("UpstoxFeedClient", () => {
  it("connects inside the window: indices in full mode, NIFTY and SENSEX ATM +/- 15 strikes in option_greeks", async () => {
    const h = harness();
    expect(await h.client.tick()).toBe(FEED_TICK_MS);
    expect(h.sockets).toHaveLength(1);
    const s = h.sockets[0];
    expect(s.sent[0]).toMatchObject({ method: "sub", data: { mode: "full", instrumentKeys: [...FEED_INDEX_KEYS] } });
    const opt = s.sent.filter((x) => x.data.mode === "option_greeks");
    expect(opt).toHaveLength(2);
    expect(opt[0].data.instrumentKeys).toHaveLength(62);
    expect(opt[0].data.instrumentKeys).toContain("NIFTY|CE22600");
    expect(opt[0].data.instrumentKeys).toContain("NIFTY|PE23350");
    expect(opt[0].data.instrumentKeys).not.toContain("NIFTY|CE23400");
    // SENSEX's 2026-10-15 expiry is today and still open before 15:30.
    expect(h.chainCalls).toEqual(["contracts:NIFTY", "chain:NIFTY:2026-10-20", "contracts:SENSEX", "chain:SENSEX:2026-10-15"]);
    expect(h.client.status()).toMatchObject({ connected: true, subscribed: 4 + 124, options: { NIFTY: { expiry: "2026-10-20", centre: 22600, strikes: 62 } } });

    for (const f of FEED_FRAMES_B64) s.emit("message", { data: b64(f).buffer.slice(0) });
    const snap = h.client.ticks(["NSE_INDEX|Nifty 50"]);
    expect(snap).toMatchObject({ connected: true, lastMessageAt: h.clock.t, ticks: [{ key: "NSE_INDEX|Nifty 50", ltp: 22622.7, receivedAt: h.clock.t }] });
    expect(h.client.status().marketStatus.NSE_FO).toBe("NORMAL_CLOSE");
  });

  it("lists the subscribed option strikes per index for the flow monitor", async () => {
    const h = harness();
    expect(h.client.optionBooks()).toEqual([]);
    expect(h.client.connected).toBe(false);
    await h.client.tick();
    expect(h.client.connected).toBe(true);
    const books = h.client.optionBooks();
    expect(books.map((b) => [b.index, b.expiry, b.lotSize, b.strikes.length])).toEqual([
      ["NIFTY", "2026-10-20", 65, 31],
      ["SENSEX", "2026-10-15", 65, 31],
    ]);
    expect(books[0].strikes[0]).toEqual({ strike: 21850, ce: "NIFTY|CE21850", pe: "NIFTY|PE21850" });
    expect(books[0].strikes[30].strike).toBe(23350);
  });

  it("re-centres when the spot moves more than 3 strikes, unsubscribing the strikes left behind", async () => {
    const h = harness();
    await h.client.tick();
    const s = h.sockets[0];
    const before = s.sent.length;
    // NIFTY ticks to 22760 (3.2 strikes from 22600): an ltpc live_feed frame, hand-built from the decoder's shape.
    h.client.store.apply(
      { type: 1, currentTs: 0, marketStatus: null, feeds: { "NSE_INDEX|Nifty 50": { kind: "ltpc", ltpc: { ltp: 22760, ltt: 1, ltq: 0, cp: 22721.95 }, depth: null, greeks: null, ohlc: [], vtt: null, oi: null, iv: null, atp: null, requestMode: 0 } } },
      h.clock.t,
    );
    s.emit("message", { data: "text frames are ignored" });
    h.clock.t += 30_000;
    await h.client.tick();
    const fresh = s.sent.slice(before);
    expect(fresh.map((x) => x.method)).toEqual(["unsub", "sub"]);
    expect(fresh[0].data.instrumentKeys).toEqual(["NIFTY|CE21850", "NIFTY|PE21850", "NIFTY|CE21900", "NIFTY|PE21900", "NIFTY|CE21950", "NIFTY|PE21950"]);
    expect(fresh[1].data.instrumentKeys).toEqual(["NIFTY|CE23400", "NIFTY|PE23400", "NIFTY|CE23450", "NIFTY|PE23450", "NIFTY|CE23500", "NIFTY|PE23500"]);
    expect(h.client.status().options.NIFTY?.centre).toBe(22750);
    // A move inside 3 strikes changes nothing.
    h.clock.t += 30_000;
    await h.client.tick();
    expect(s.sent.length).toBe(before + 2);
  });

  it("reconnects after a drop with backoff, re-authorizing every time", async () => {
    const h = harness();
    await h.client.tick();
    h.sockets[0].emit("close", { code: 1006, reason: `gone ${WSS}` });
    expect(h.wakes).toEqual([1000]);
    expect(h.client.status()).toMatchObject({ connected: false, reconnects: 1, consecutiveFailures: 1 });
    // Not yet due.
    h.clock.t += 500;
    expect(await h.client.tick()).toBe(500);
    expect(h.sockets).toHaveLength(1);
    // Due: the next attempt fails to open, so the delay doubles.
    h.clock.t += 500;
    h.openFail.error = `upgrade failed for ${WSS}`;
    expect(await h.client.tick()).toBe(2000);
    expect(h.authorize.calls).toBe(2);
    h.clock.t += 2000;
    h.openFail.error = null;
    expect(await h.client.tick()).toBe(FEED_TICK_MS);
    expect(h.authorize.calls).toBe(3);
    expect(h.sockets).toHaveLength(2);
    // A good frame resets the failure count.
    h.sockets[1].emit("message", { data: b64(FEED_FRAMES_B64[0]) });
    expect(h.client.status().consecutiveFailures).toBe(0);
    expectNoSecrets(h.client.status());
  });

  it("drops a socket silent for 90 s and reconnects", async () => {
    const h = harness();
    await h.client.tick();
    h.clock.t += FEED_SILENT_MS + 1000;
    await h.client.tick();
    expect(h.sockets[0].closed).not.toBeNull();
    expect(h.sockets).toHaveLength(2);
    expect(h.client.status()).toMatchObject({ connected: true, reconnects: 1 });
  });

  it("closes the socket after 15:35 and sleeps until the next window; stays off at weekends and holidays", async () => {
    const h = harness();
    await h.client.tick();
    h.clock.t = ist("2026-10-15T15:35:00");
    // Sleeps until 09:10 tomorrow, in steps of at most 6 h.
    expect(await h.client.tick()).toBe(6 * 60 * 60_000);
    h.clock.t = ist("2026-10-16T08:00:00");
    expect(await h.client.tick()).toBe(ist("2026-10-16T09:10:00") - h.clock.t);
    expect(h.sockets[0].closed).toMatchObject({ code: 1000 });
    expect(h.client.status()).toMatchObject({ connected: false, inWindow: false });
    // A late close event from the old socket does not trigger a reconnect.
    h.sockets[0].emit("close", { code: 1000 });
    expect(h.client.status().reconnects).toBe(0);

    h.clock.t = ist("2026-10-17T10:00:00"); // Saturday
    expect(await h.client.tick()).toBe(6 * 60 * 60_000);
    h.clock.t = ist("2026-10-20T10:00:00"); // a holiday in this harness
    expect(await h.client.tick()).toBe(6 * 60 * 60_000);
    h.clock.t = ist("2026-10-21T05:00:00");
    expect(await h.client.tick()).toBe(ist("2026-10-21T09:10:00") - h.clock.t);
    expect(h.sockets).toHaveLength(1);
  });

  it("never throws, and keeps the token and the wss URL out of status", async () => {
    const h = harness();
    h.authorize.status = 401;
    expect(await h.client.tick()).toBe(1000);
    const st = h.client.status();
    expect(st.lastError).toContain("HTTP 401");
    expectNoSecrets(st);
    h.authorize.status = 200;
    h.openFail.error = `fetch ${WSS} failed with Bearer ${TOKEN}`;
    h.clock.t += 1000;
    await h.client.tick();
    expectNoSecrets(h.client.status());
    expect(h.client.status().lastError).toContain("wss://wsfeeder-api.upstox.com/[redacted]");
  });

  it("reports a missing token without connecting", async () => {
    const client = new UpstoxFeedClient({ now: () => ist("2026-10-15T10:00:00"), openSocket: async () => { throw new Error("no"); } });
    expect(await client.tick()).toBe(5 * 60_000);
    expect(client.status()).toMatchObject({ connected: false, lastError: "no market feed: set UPSTOX_ANALYTICS_TOKEN" });
  });
});
