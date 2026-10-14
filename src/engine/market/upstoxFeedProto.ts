/**
 * A small, dependency-free protobuf decoder for Upstox's Market Data Feed V3 frames
 * (MarketDataFeedV3.proto in Upstox's official SDKs). It decodes only the messages the feed sends:
 *
 *   FeedResponse { Type type = 1; map<string, Feed> feeds = 2; int64 currentTs = 3; MarketInfo marketInfo = 4; }
 *   Feed { oneof { LTPC ltpc = 1; FullFeed fullFeed = 2; FirstLevelWithGreeks firstLevelWithGreeks = 3; } RequestMode requestMode = 4; }
 *   FullFeed { oneof { MarketFullFeed marketFF = 1; IndexFullFeed indexFF = 2; } }
 *   MarketFullFeed { LTPC ltpc = 1; MarketLevel marketLevel = 2; OptionGreeks optionGreeks = 3; MarketOHLC marketOHLC = 4;
 *                    double atp = 5; int64 vtt = 6; double oi = 7; double iv = 8; double tbq = 9; double tsq = 10; ... }
 *   IndexFullFeed { LTPC ltpc = 1; MarketOHLC marketOHLC = 2; }
 *   FirstLevelWithGreeks { LTPC ltpc = 1; Quote firstDepth = 2; OptionGreeks optionGreeks = 3; int64 vtt = 4; double oi = 5; double iv = 6; }
 *   LTPC { double ltp = 1; int64 ltt = 2; int64 ltq = 3; double cp = 4; }
 *   Quote { int64 bidQ = 1; double bidP = 2; int64 askQ = 3; double askP = 4; }
 *   OptionGreeks { double delta = 1; double theta = 2; double gamma = 3; double vega = 4; double rho = 5; }
 *   OHLC { string interval = 1; double open = 2; double high = 3; double low = 4; double close = 5; int64 vol = 6; int64 ts = 7; }
 *   MarketInfo { map<string, MarketStatus> segmentStatus = 1; ... }
 *
 * int64 values (timestamps in ms, quantities) are read as JS numbers: exact below 2^53. Unknown fields are skipped.
 * Pure and web-standard (no node: imports).
 */

export class ProtoError extends Error {
  constructor(message: string) {
    super(`protobuf: ${message}`);
    this.name = "ProtoError";
  }
}

const TWO_32 = 2 ** 32;

/** A forward-only reader over one message's bytes. */
export class ProtoReader {
  pos: number;
  private readonly view: DataView;

  constructor(
    readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  /** An unsigned varint as a number (int64 values >= 2^63 are read as negatives, two's complement). */
  varint(): number {
    let lo = 0;
    let hi = 0;
    let shift = 0;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new ProtoError("truncated varint");
      const b = this.buf[this.pos++];
      if (shift < 28) lo |= (b & 0x7f) << shift;
      else if (shift === 28) {
        lo |= (b & 0x0f) << 28;
        hi |= (b & 0x7f) >> 4;
      } else hi |= (b & 0x7f) << (shift - 32);
      if ((b & 0x80) === 0) {
        // Two's complement for negative int64 (top bit set), computed on the halves to keep precision.
        if (hi & 0x80000000) return -((~hi >>> 0) * TWO_32 + (~lo >>> 0) + 1);
        return (hi >>> 0) * TWO_32 + (lo >>> 0);
      }
      shift += 7;
    }
    throw new ProtoError("varint longer than 10 bytes");
  }

  double(): number {
    if (this.pos + 8 > this.end) throw new ProtoError("truncated double");
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** The bounds of a length-delimited field; the reader moves past it. */
  sub(): ProtoReader {
    const len = this.varint();
    if (len < 0 || this.pos + len > this.end) throw new ProtoError("truncated length-delimited field");
    const r = new ProtoReader(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return r;
  }

  string(): string {
    const r = this.sub();
    return new TextDecoder().decode(this.buf.subarray(r.pos, r.end));
  }

  /** The next field's number and wire type, or null at the end. */
  tag(): { field: number; wire: number } | null {
    if (this.done) return null;
    const t = this.varint();
    return { field: Math.floor(t / 8), wire: t & 7 };
  }

  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.varint();
        return;
      case 1:
        this.pos += 8;
        break;
      case 2:
        this.sub();
        return;
      case 5:
        this.pos += 4;
        break;
      default:
        throw new ProtoError(`unsupported wire type ${wire}`);
    }
    if (this.pos > this.end) throw new ProtoError("truncated field");
  }
}

export interface FeedLtpc {
  ltp: number;
  /** Last trade time, epoch ms (0 when not sent). */
  ltt: number;
  ltq: number;
  /** Previous close. */
  cp: number;
}

export interface FeedQuote {
  bidQ: number;
  bidP: number;
  askQ: number;
  askP: number;
}

export interface FeedGreeks {
  delta: number;
  theta: number;
  gamma: number;
  vega: number;
  rho: number;
}

export interface FeedOhlc {
  /** "1d", "I1", "I30", ... */
  interval: string;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
  ts: number;
}

/** One instrument's feed, flattened across the three feed shapes (ltpc, full, option_greeks). */
export interface DecodedFeed {
  kind: "ltpc" | "marketFull" | "indexFull" | "optionGreeks" | "empty";
  ltpc: FeedLtpc | null;
  /** Best bid/ask (first depth level). */
  depth: FeedQuote | null;
  greeks: FeedGreeks | null;
  ohlc: FeedOhlc[];
  /** Volume traded today. */
  vtt: number | null;
  oi: number | null;
  iv: number | null;
  atp: number | null;
  /** RequestMode enum: 0 ltpc, 1 full_d5, 2 option_greeks, 3 full_d30. */
  requestMode: number;
}

export const FEED_TYPE = { initial_feed: 0, live_feed: 1, market_info: 2 } as const;
export const MARKET_STATUS = ["PRE_OPEN_START", "PRE_OPEN_END", "NORMAL_OPEN", "NORMAL_CLOSE", "CLOSING_START", "CLOSING_END"] as const;

export interface DecodedFeedResponse {
  /** 0 initial_feed, 1 live_feed, 2 market_info. */
  type: number;
  feeds: Record<string, DecodedFeed>;
  /** Server time, epoch ms (0 when not sent). */
  currentTs: number;
  /** Segment (e.g. "NSE_FO") -> status name; null when the frame has no market info. */
  marketStatus: Record<string, string> | null;
}

function decodeLtpc(r: ProtoReader): FeedLtpc {
  const out: FeedLtpc = { ltp: 0, ltt: 0, ltq: 0, cp: 0 };
  for (let t = r.tag(); t; t = r.tag()) {
    if (t.field === 1 && t.wire === 1) out.ltp = r.double();
    else if (t.field === 2 && t.wire === 0) out.ltt = r.varint();
    else if (t.field === 3 && t.wire === 0) out.ltq = r.varint();
    else if (t.field === 4 && t.wire === 1) out.cp = r.double();
    else r.skip(t.wire);
  }
  return out;
}

function decodeQuote(r: ProtoReader): FeedQuote {
  const out: FeedQuote = { bidQ: 0, bidP: 0, askQ: 0, askP: 0 };
  for (let t = r.tag(); t; t = r.tag()) {
    if (t.field === 1 && t.wire === 0) out.bidQ = r.varint();
    else if (t.field === 2 && t.wire === 1) out.bidP = r.double();
    else if (t.field === 3 && t.wire === 0) out.askQ = r.varint();
    else if (t.field === 4 && t.wire === 1) out.askP = r.double();
    else r.skip(t.wire);
  }
  return out;
}

function decodeGreeks(r: ProtoReader): FeedGreeks {
  const out: FeedGreeks = { delta: 0, theta: 0, gamma: 0, vega: 0, rho: 0 };
  const names = [null, "delta", "theta", "gamma", "vega", "rho"] as const;
  for (let t = r.tag(); t; t = r.tag()) {
    const name = t.wire === 1 ? names[t.field] : null;
    if (name) out[name] = r.double();
    else r.skip(t.wire);
  }
  return out;
}

function decodeOhlc(r: ProtoReader): FeedOhlc {
  const out: FeedOhlc = { interval: "", open: 0, high: 0, low: 0, close: 0, vol: 0, ts: 0 };
  for (let t = r.tag(); t; t = r.tag()) {
    if (t.field === 1 && t.wire === 2) out.interval = r.string();
    else if (t.field === 2 && t.wire === 1) out.open = r.double();
    else if (t.field === 3 && t.wire === 1) out.high = r.double();
    else if (t.field === 4 && t.wire === 1) out.low = r.double();
    else if (t.field === 5 && t.wire === 1) out.close = r.double();
    else if (t.field === 6 && t.wire === 0) out.vol = r.varint();
    else if (t.field === 7 && t.wire === 0) out.ts = r.varint();
    else r.skip(t.wire);
  }
  return out;
}

/** MarketOHLC { repeated OHLC ohlc = 1 } */
function decodeOhlcList(r: ProtoReader, into: FeedOhlc[]): void {
  for (let t = r.tag(); t; t = r.tag()) {
    if (t.field === 1 && t.wire === 2) into.push(decodeOhlc(r.sub()));
    else r.skip(t.wire);
  }
}

/** MarketLevel { repeated Quote bidAskQuote = 1 }: the first (best) level. */
function decodeFirstLevel(r: ProtoReader): FeedQuote | null {
  let first: FeedQuote | null = null;
  for (let t = r.tag(); t; t = r.tag()) {
    if (t.field === 1 && t.wire === 2) {
      const q = decodeQuote(r.sub());
      first ??= q;
    } else r.skip(t.wire);
  }
  return first;
}

function emptyFeed(): DecodedFeed {
  return { kind: "empty", ltpc: null, depth: null, greeks: null, ohlc: [], vtt: null, oi: null, iv: null, atp: null, requestMode: 0 };
}

function decodeMarketFull(r: ProtoReader, f: DecodedFeed): void {
  f.kind = "marketFull";
  for (let t = r.tag(); t; t = r.tag()) {
    if (t.field === 1 && t.wire === 2) f.ltpc = decodeLtpc(r.sub());
    else if (t.field === 2 && t.wire === 2) f.depth = decodeFirstLevel(r.sub());
    else if (t.field === 3 && t.wire === 2) f.greeks = decodeGreeks(r.sub());
    else if (t.field === 4 && t.wire === 2) decodeOhlcList(r.sub(), f.ohlc);
    else if (t.field === 5 && t.wire === 1) f.atp = r.double();
    else if (t.field === 6 && t.wire === 0) f.vtt = r.varint();
    else if (t.field === 7 && t.wire === 1) f.oi = r.double();
    else if (t.field === 8 && t.wire === 1) f.iv = r.double();
    else r.skip(t.wire);
  }
}

function decodeIndexFull(r: ProtoReader, f: DecodedFeed): void {
  f.kind = "indexFull";
  for (let t = r.tag(); t; t = r.tag()) {
    if (t.field === 1 && t.wire === 2) f.ltpc = decodeLtpc(r.sub());
    else if (t.field === 2 && t.wire === 2) decodeOhlcList(r.sub(), f.ohlc);
    else r.skip(t.wire);
  }
}

function decodeFirstLevelWithGreeks(r: ProtoReader, f: DecodedFeed): void {
  f.kind = "optionGreeks";
  for (let t = r.tag(); t; t = r.tag()) {
    if (t.field === 1 && t.wire === 2) f.ltpc = decodeLtpc(r.sub());
    else if (t.field === 2 && t.wire === 2) f.depth = decodeQuote(r.sub());
    else if (t.field === 3 && t.wire === 2) f.greeks = decodeGreeks(r.sub());
    else if (t.field === 4 && t.wire === 0) f.vtt = r.varint();
    else if (t.field === 5 && t.wire === 1) f.oi = r.double();
    else if (t.field === 6 && t.wire === 1) f.iv = r.double();
    else r.skip(t.wire);
  }
}

function decodeFeed(r: ProtoReader): DecodedFeed {
  const f = emptyFeed();
  for (let t = r.tag(); t; t = r.tag()) {
    if (t.field === 1 && t.wire === 2) {
      f.kind = "ltpc";
      f.ltpc = decodeLtpc(r.sub());
    } else if (t.field === 2 && t.wire === 2) {
      const ff = r.sub();
      for (let u = ff.tag(); u; u = ff.tag()) {
        if (u.field === 1 && u.wire === 2) decodeMarketFull(ff.sub(), f);
        else if (u.field === 2 && u.wire === 2) decodeIndexFull(ff.sub(), f);
        else ff.skip(u.wire);
      }
    } else if (t.field === 3 && t.wire === 2) decodeFirstLevelWithGreeks(r.sub(), f);
    else if (t.field === 4 && t.wire === 0) f.requestMode = r.varint();
    else r.skip(t.wire);
  }
  return f;
}

/** A map entry { key = 1; value = 2 } with a string key; `value` reads field 2. */
function decodeMapEntry<T>(r: ProtoReader, value: (r: ProtoReader, wire: number) => T, empty: T): [string, T] {
  let key = "";
  let v = empty;
  for (let t = r.tag(); t; t = r.tag()) {
    if (t.field === 1 && t.wire === 2) key = r.string();
    else if (t.field === 2) v = value(r, t.wire);
    else r.skip(t.wire);
  }
  return [key, v];
}

function decodeMarketInfo(r: ProtoReader): Record<string, string> {
  const out: Record<string, string> = {};
  for (let t = r.tag(); t; t = r.tag()) {
    if (t.field === 1 && t.wire === 2) {
      const [seg, status] = decodeMapEntry(
        r.sub(),
        (s, wire) => {
          if (wire !== 0) {
            s.skip(wire);
            return 0;
          }
          return s.varint();
        },
        0,
      );
      if (seg) out[seg] = MARKET_STATUS[status] ?? `STATUS_${status}`;
    } else r.skip(t.wire);
  }
  return out;
}

/** Decodes one binary FeedResponse frame. Throws ProtoError on malformed input. */
export function decodeFeedResponse(bytes: Uint8Array): DecodedFeedResponse {
  const r = new ProtoReader(bytes);
  const out: DecodedFeedResponse = { type: 0, feeds: {}, currentTs: 0, marketStatus: null };
  for (let t = r.tag(); t; t = r.tag()) {
    if (t.field === 1 && t.wire === 0) out.type = r.varint();
    else if (t.field === 2 && t.wire === 2) {
      const [key, feed] = decodeMapEntry(
        r.sub(),
        (s, wire) => {
          if (wire !== 2) {
            s.skip(wire);
            return emptyFeed();
          }
          return decodeFeed(s.sub());
        },
        emptyFeed(),
      );
      if (key) out.feeds[key] = feed;
    } else if (t.field === 3 && t.wire === 0) out.currentTs = r.varint();
    else if (t.field === 4 && t.wire === 2) out.marketStatus = decodeMarketInfo(r.sub());
    else r.skip(t.wire);
  }
  return out;
}
