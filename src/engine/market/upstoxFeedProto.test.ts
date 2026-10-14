import { describe, expect, it } from "vitest";
import { FEED_FRAMES_B64, FEED_OPTION_KEYS } from "./upstoxFeed.fixture";
import { ProtoError, ProtoReader, decodeFeedResponse } from "./upstoxFeedProto";

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// A tiny protobuf encoder for hand-built frames.
const varint = (n: number): number[] => {
  const out: number[] = [];
  let v = BigInt.asUintN(64, BigInt(n));
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
};
const tag = (field: number, wire: number) => varint(field * 8 + wire);
const vField = (field: number, n: number) => [...tag(field, 0), ...varint(n)];
const dField = (field: number, x: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, x, true);
  return [...tag(field, 1), ...b];
};
const lField = (field: number, bytes: number[]) => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const sField = (field: number, s: string) => lField(field, [...new TextEncoder().encode(s)]);

describe("decodeFeedResponse on real Upstox frames (14 Oct 2026, after the close)", () => {
  const [info, indices, options] = FEED_FRAMES_B64.map((f) => decodeFeedResponse(b64(f)));

  it("decodes the market_info frame's segment status", () => {
    expect(info.type).toBe(2);
    expect(info.feeds).toEqual({});
    expect(info.currentTs).toBeGreaterThan(1.79e12);
    expect(info.marketStatus).toMatchObject({ NSE_FO: "NORMAL_CLOSE", NSE_INDEX: "CLOSING_END", BSE_INDEX: "CLOSING_END", MCX_FO: "NORMAL_OPEN" });
  });

  it("decodes the index full-feed snapshot: LTP, last trade time, previous close and the day's OHLC", () => {
    expect(indices.type).toBe(0);
    expect(Object.keys(indices.feeds).sort()).toEqual(["BSE_INDEX|SENSEX", "NSE_INDEX|India VIX", "NSE_INDEX|Nifty 50", "NSE_INDEX|Nifty Bank"]);
    const nifty = indices.feeds["NSE_INDEX|Nifty 50"];
    expect(nifty.kind).toBe("indexFull");
    expect(nifty.requestMode).toBe(1);
    expect(nifty.ltpc).toEqual({ ltp: 22622.7, ltt: 1791973800000, ltq: 0, cp: 22721.95 });
    expect(nifty.ohlc.find((o) => o.interval === "1d")).toMatchObject({ open: 22715.75, high: 22757.95, low: 22558.95, close: 22622.7 });
    expect(indices.feeds["BSE_INDEX|SENSEX"].ltpc?.ltp).toBe(72781.89);
  });

  it("decodes the option_greeks snapshot: best bid/ask, OI, IV (a fraction) and greeks", () => {
    expect(Object.keys(options.feeds).sort()).toEqual([...FEED_OPTION_KEYS].sort());
    const ce = options.feeds["NSE_FO|47141"];
    expect(ce.kind).toBe("optionGreeks");
    expect(ce.requestMode).toBe(2);
    expect(ce.ltpc).toMatchObject({ ltp: 119.85, cp: 243.15, ltq: 195 });
    expect(ce.depth).toEqual({ bidQ: 520, bidP: 119.85, askQ: 845, askP: 120.8 });
    expect(ce.greeks).toMatchObject({ delta: 0.4827, theta: -12.9216, gamma: 0.0012, vega: 10.5509 });
    expect(ce.oi).toBe(3055000);
    expect(ce.vtt).toBe(109067660);
    expect(ce.iv).toBeCloseTo(0.1223, 4);
  });
});

describe("decodeFeedResponse on hand-encoded frames", () => {
  const ltpc = lField(1, [...dField(1, 101.5), ...vField(2, 1_791_973_800_123), ...vField(3, 75), ...dField(4, 99.25)]);

  it("decodes an ltpc-mode feed, the type and the server time, skipping unknown fields", () => {
    const feed = [...ltpc, ...vField(4, 0), ...sField(9, "future field")];
    const entry = [...sField(1, "NSE_FO|1"), ...lField(2, feed)];
    const frame = new Uint8Array([...vField(1, 1), ...lField(2, entry), ...vField(3, 1_791_988_000_000), ...dField(15, 1.5)]);
    const r = decodeFeedResponse(frame);
    expect(r.type).toBe(1);
    expect(r.currentTs).toBe(1_791_988_000_000);
    expect(r.feeds["NSE_FO|1"]).toMatchObject({ kind: "ltpc", ltpc: { ltp: 101.5, ltt: 1_791_973_800_123, ltq: 75, cp: 99.25 }, requestMode: 0 });
  });

  it("decodes a full market feed: the first depth level, OI, IV, volume and OHLC", () => {
    const q1 = [...vField(1, 100), ...dField(2, 10.5), ...vField(3, 200), ...dField(4, 10.7)];
    const q2 = [...vField(1, 1), ...dField(2, 10.4), ...vField(3, 1), ...dField(4, 10.8)];
    const ohlc = lField(1, [...sField(1, "1d"), ...dField(2, 9), ...dField(3, 12), ...dField(4, 8.5), ...dField(5, 10.6), ...vField(6, 5000), ...vField(7, 1_791_916_200_000)]);
    const mff = [...ltpc, ...lField(2, [...lField(1, q1), ...lField(1, q2)]), ...lField(4, ohlc), ...vField(6, 123456), ...dField(7, 9_000), ...dField(8, 0.155)];
    const feed = [...lField(2, lField(1, mff)), ...vField(4, 1)];
    const r = decodeFeedResponse(new Uint8Array(lField(2, [...sField(1, "NSE_FO|2"), ...lField(2, feed)])));
    const f = r.feeds["NSE_FO|2"];
    expect(f.kind).toBe("marketFull");
    expect(f.depth).toEqual({ bidQ: 100, bidP: 10.5, askQ: 200, askP: 10.7 });
    expect(f).toMatchObject({ vtt: 123456, oi: 9000, iv: 0.155, requestMode: 1 });
    expect(f.ohlc[0]).toMatchObject({ interval: "1d", open: 9, high: 12, low: 8.5, close: 10.6, vol: 5000 });
  });

  it("reads 64-bit and negative varints", () => {
    expect(new ProtoReader(new Uint8Array(varint(2 ** 40 + 7))).varint()).toBe(2 ** 40 + 7);
    expect(new ProtoReader(new Uint8Array(varint(-1))).varint()).toBe(-1);
    expect(new ProtoReader(new Uint8Array(varint(300))).varint()).toBe(300);
  });

  it("throws ProtoError on truncated input", () => {
    const real = b64(FEED_FRAMES_B64[1]);
    expect(() => decodeFeedResponse(real.subarray(0, real.length - 5))).toThrow(ProtoError);
    expect(() => decodeFeedResponse(new Uint8Array([0x08]))).toThrow(ProtoError);
  });
});
