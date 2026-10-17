/**
 * Client for the static-IP order relay (relay/). Every request is signed:
 *   X-Relay-Sig = hex HMAC-SHA256(secret, ts \n nonce \n METHOD \n pathWithQuery \n sha256hex(body))
 * with X-Relay-Ts (epoch ms) and a random X-Relay-Nonce, plus the Cloudflare Access service-token
 * headers when configured. Order calls go to /v1/orders*; GET-only Groww data calls can go through
 * the relay's /v1/groww/* proxy when Cloudflare egress is blocked (GROWW_DATA_VIA_RELAY=true).
 */
import type { BrokerPosition } from "../../ports";
import { hmacSha256Hex, sha256Hex, toHex } from "../../util/hash";
import { fetchWithTimeout, type FetchLike } from "../../util/http";
import { GrowwError } from "./errors";
import { buildQuery, unwrapEnvelope, type GrowwTransport, type RequestOptions } from "./http";

export interface RelayClientOptions {
  baseUrl: string;
  hmacSecret: string;
  accessClientId?: string;
  accessClientSecret?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}

export interface RelayOrderRequest {
  idempotencyKey: string;
  underlying: "NIFTY" | "SENSEX";
  tradingSymbol: string;
  exchange: "NSE" | "BSE";
  segment: "FNO";
  side: "BUY" | "SELL";
  qty: number;
  lotSize: number;
  orderType: "MARKET" | "LIMIT";
  price: number | null;
  product: "MIS" | "NRML";
  validity: "DAY";
  premiumEstimate?: number | null;
}

export type RelayCreateResult =
  | { kind: "accepted"; growwOrderId: string | null; orderStatus: string | null; duplicate: boolean; reason?: string }
  | { kind: "rejected"; reason: string; by: "RELAY" | "BROKER" | "UNKNOWN" }
  | { kind: "unknown"; reason: string };

export interface RelayOrderStatus {
  growwOrderId: string | null;
  orderStatus: string | null;
  filledQty: number;
  avgFillPrice: number | null;
  remark: string | null;
}

export interface RelayTrade {
  tradeId: string | null;
  price: number | null;
  qty: number | null;
  time: string | null;
}

export interface RelayHealth {
  reachable: boolean;
  ok: boolean;
  live: boolean;
  growwReachable: boolean;
  publicIp: string | null;
  tokenValidUntil: string | null;
  ordersToday: number | null;
  detail: string;
}

export interface SignedHeaders {
  "x-relay-ts": string;
  "x-relay-nonce": string;
  "x-relay-sig": string;
}

/** The request-target (path + query) of a URL as sent on the wire. */
export function requestTarget(url: string): string {
  const schemeEnd = url.indexOf("://");
  const start = url.indexOf("/", schemeEnd === -1 ? 0 : schemeEnd + 3);
  if (start === -1) return "/";
  const hash = url.indexOf("#", start);
  return hash === -1 ? url.slice(start) : url.slice(start, hash);
}

export function canonicalString(ts: string, nonce: string, method: string, pathWithQuery: string, bodySha256: string): string {
  return `${ts}\n${nonce}\n${method.toUpperCase()}\n${pathWithQuery}\n${bodySha256}`;
}

export async function signRelayRequest(secret: string, method: string, url: string, body: string, nowMs: number, nonce?: string): Promise<SignedHeaders> {
  const ts = String(nowMs);
  const n = nonce ?? toHex(crypto.getRandomValues(new Uint8Array(16)));
  const sig = await hmacSha256Hex(secret, canonicalString(ts, n, method, requestTarget(url), await sha256Hex(body)));
  return { "x-relay-ts": ts, "x-relay-nonce": n, "x-relay-sig": sig };
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export class RelayClient {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(private readonly o: RelayClientOptions) {
    if (!o.baseUrl || !o.hmacSecret) throw new Error("RelayClient needs RELAY_URL and RELAY_HMAC_SECRET");
    this.base = o.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = o.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = o.now ?? (() => Date.now());
  }

  /** Signed request; returns HTTP status and parsed JSON (or null). Throws GrowwError("transient") on transport failure. */
  async call(method: "GET" | "POST", pathWithQuery: string, body?: unknown, timeoutMs?: number): Promise<{ status: number; json: unknown; text: string }> {
    const url = `${this.base}${pathWithQuery}`;
    const text = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(await signRelayRequest(this.o.hmacSecret, method, url, text, this.now())),
    };
    if (text) headers["Content-Type"] = "application/json";
    if (this.o.accessClientId && this.o.accessClientSecret) {
      headers["CF-Access-Client-Id"] = this.o.accessClientId;
      headers["CF-Access-Client-Secret"] = this.o.accessClientSecret;
    }
    let res: Response;
    try {
      res = await fetchWithTimeout(this.fetchImpl, url, { method, headers, body: text || undefined }, timeoutMs ?? this.o.timeoutMs ?? 15_000);
    } catch (err) {
      throw new GrowwError(`relay ${method} ${pathWithQuery.split("?")[0]}: ${err instanceof Error ? err.message : String(err)}`, "transient", 0);
    }
    const raw = await res.text();
    let json: unknown = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text: raw };
  }

  private fail(what: string, status: number, json: unknown, text: string): never {
    const j = rec(json);
    const msg = s(j.error) ?? s(j.reason) ?? (text.slice(0, 200) || `HTTP ${status}`);
    const kind = status === 401 || status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 422 || status === 400 ? "bad_request" : status === 429 ? "rate_limited" : "transient";
    throw new GrowwError(`relay ${what}: ${msg}${s(j.code) ? ` (${s(j.code)})` : ""}`, kind, status, s(j.code) ?? undefined);
  }

  async createOrder(req: RelayOrderRequest): Promise<RelayCreateResult> {
    let r: { status: number; json: unknown; text: string };
    try {
      r = await this.call("POST", "/v1/orders", req, 30_000);
    } catch (err) {
      return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
    }
    const j = rec(r.json);
    const status = s(j.status);
    if (r.status === 200 && (status === "ACCEPTED" || status === "DUPLICATE")) {
      const original = s(j.originalStatus);
      if (status === "DUPLICATE" && (original === "REJECTED" || original === "BROKER_REJECTED")) {
        return { kind: "rejected", reason: s(j.reason) ?? "original order was rejected", by: original === "REJECTED" ? "RELAY" : "BROKER" };
      }
      if (status === "DUPLICATE" && (original === "UNKNOWN" || original === "PENDING") && !s(j.growwOrderId)) {
        return { kind: "unknown", reason: s(j.reason) ?? "original order outcome unknown" };
      }
      return { kind: "accepted", growwOrderId: s(j.growwOrderId), orderStatus: s(j.orderStatus), duplicate: status === "DUPLICATE", reason: s(j.reason) ?? undefined };
    }
    if (status === "REJECTED") {
      const by = s(j.rejectedBy);
      return { kind: "rejected", reason: s(j.reason) ?? "rejected", by: by === "RELAY" || by === "BROKER" ? by : "UNKNOWN" };
    }
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      // Never reached Groww: bad request or relay auth failure.
      return { kind: "rejected", reason: s(j.error) ?? `relay HTTP ${r.status}`, by: "RELAY" };
    }
    return { kind: "unknown", reason: s(j.error) ?? `relay HTTP ${r.status}` };
  }

  async statusByRef(ref: string, segment: "FNO" | "CASH" = "FNO"): Promise<RelayOrderStatus | null> {
    const r = await this.call("GET", `/v1/orders/ref/${encodeURIComponent(ref)}?segment=${segment}`);
    if (r.status === 404) return null;
    if (r.status !== 200) this.fail("order status", r.status, r.json, r.text);
    const j = rec(r.json);
    return { growwOrderId: s(j.growwOrderId), orderStatus: s(j.orderStatus), filledQty: n(j.filledQty) ?? 0, avgFillPrice: n(j.avgFillPrice), remark: s(j.remark) };
  }

  async trades(growwOrderId: string, segment: "FNO" | "CASH" = "FNO"): Promise<RelayTrade[]> {
    const r = await this.call("GET", `/v1/orders/${encodeURIComponent(growwOrderId)}/trades?segment=${segment}`);
    if (r.status !== 200) this.fail("trades", r.status, r.json, r.text);
    const list = Array.isArray(rec(r.json).trades) ? (rec(r.json).trades as unknown[]) : [];
    return list.map((t) => {
      const x = rec(t);
      return { tradeId: s(x.tradeId), price: n(x.price), qty: n(x.qty), time: s(x.time) };
    });
  }

  async cancel(growwOrderId: string, segment: "FNO" | "CASH" = "FNO"): Promise<{ orderStatus: string | null }> {
    const r = await this.call("POST", `/v1/orders/${encodeURIComponent(growwOrderId)}/cancel`, { segment });
    if (r.status !== 200) this.fail("cancel", r.status, r.json, r.text);
    return { orderStatus: s(rec(r.json).orderStatus) };
  }

  async positions(segment: "FNO" | "CASH" = "FNO"): Promise<BrokerPosition[]> {
    const r = await this.call("GET", `/v1/positions?segment=${segment}`);
    if (r.status !== 200) this.fail("positions", r.status, r.json, r.text);
    const list = Array.isArray(rec(r.json).positions) ? (rec(r.json).positions as unknown[]) : [];
    const out: BrokerPosition[] = [];
    for (const p of list) {
      const x = rec(p);
      const sym = s(x.tradingSymbol);
      if (!sym) continue;
      out.push({ tradingSymbol: sym, exchange: s(x.exchange) ?? "", qty: n(x.qty) ?? 0, avgPrice: n(x.avgPrice) ?? 0 });
    }
    return out;
  }

  async health(): Promise<RelayHealth> {
    try {
      const r = await this.call("GET", "/health", undefined, 10_000);
      const j = rec(r.json);
      if (r.status !== 200) return { reachable: true, ok: false, live: false, growwReachable: false, publicIp: null, tokenValidUntil: null, ordersToday: null, detail: s(j.error) ?? `HTTP ${r.status}` };
      const ok = j.ok === true;
      const live = j.live === true;
      const growwReachable = j.growwReachable === true;
      return {
        reachable: true,
        ok,
        live,
        growwReachable,
        publicIp: s(j.publicIp),
        tokenValidUntil: s(j.tokenValidUntil),
        ordersToday: n(j.ordersToday),
        detail: `relay ${ok ? "ok" : "not ok"}${live ? ", live" : ", shadow"}${growwReachable ? ", groww reachable" : ", groww unreachable"}${s(j.tokenError) ? `: ${s(j.tokenError)}` : ""}`,
      };
    } catch (err) {
      return { reachable: false, ok: false, live: false, growwReachable: false, publicIp: null, tokenValidUntil: null, ordersToday: null, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async panic(reason: string): Promise<{ status: number; body: unknown }> {
    const r = await this.call("POST", "/v1/panic", { reason }, 60_000);
    return { status: r.status, body: r.json };
  }

  /** GrowwTransport over the relay's read-only data proxy (GET only). */
  dataTransport(): GrowwTransport {
    return {
      request: async <T>(method: "GET" | "POST", path: string, o: RequestOptions = {}): Promise<T> => {
        if (method !== "GET") throw new GrowwError("relay data proxy is GET-only", "bad_request", 0);
        const r = await this.call("GET", `/v1/groww${path}${buildQuery(o.query)}`, undefined, o.timeoutMs);
        return unwrapEnvelope<T>(r.status, r.text, `GET ${path} (via relay)`);
      },
    };
  }
}
