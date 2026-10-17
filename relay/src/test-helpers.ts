// Test-only helpers (excluded from the build): fake clock, in-memory Groww, request signer.
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "./app.js";
import { sha256Hex, signRequest, type AppEnv } from "./auth.js";
import type { Clock, Sleep } from "./clock.js";
import { loadConfig, type RelayConfig } from "./config.js";
import {
  GrowwError,
  type CreateOrderInput,
  type GrowwApi,
  type ModifyOrderInput,
  type OrderAck,
  type OrderListItem,
  type OrderState,
  type OrderUpdateAck,
  type PositionRow,
  type Segment,
  type TokenStatus,
  type TradeFill,
} from "./groww.js";
import { Ledger } from "./ledger.js";

export const TEST_SECRET = "unit-test-secret-0123456789abcdef";

/** Tue 2026-10-06 10:40:00 IST, inside the default trading window. */
export const TUESDAY_1040_IST = Date.parse("2026-10-06T05:10:00Z");

/** Epoch ms for an IST wall-clock time, e.g. ist("2026-10-06T15:20:00"). */
export function ist(local: string): number {
  return Date.parse(`${local}+05:30`);
}

export class FakeClock implements Clock {
  constructor(public t: number = TUESDAY_1040_IST) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  /** A sleep that advances this clock instantly. */
  sleep: Sleep = async (ms) => {
    this.t += Math.max(0, ms);
  };
}

export function testConfig(env: Record<string, string> = {}): RelayConfig {
  return loadConfig({
    RELAY_HMAC_SECRET: TEST_SECRET,
    RELAY_LIVE: "true",
    GROWW_API_KEY: "test-api-key",
    GROWW_TOTP_SECRET: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    ...env,
  }).config;
}

interface FakeOrder {
  id: string;
  ref: string;
  input: CreateOrderInput;
  status: string;
  filled: number;
  avg: number | null;
  /** When false the remaining quantity is omitted from list results (unknown). */
  reportQty: boolean;
}

type CreateBehavior = "ok" | "reject" | "timeout-no-create" | "timeout-after-create" | "server-error-after-create";

/** In-memory stand-in for Groww with failure injection and a call log. */
export class FakeGroww implements GrowwApi {
  orders = new Map<string, FakeOrder>();
  byRef = new Map<string, string>();
  positions: PositionRow[] = [];
  ltp: Record<string, number> = {};
  margins: unknown = { clear_cash: 500_000, fno_margin_details: { option_buy_balance_available: 400_000 } };
  marginsFail = false;
  tokenOk = true;
  tokenError = "Groww credentials are not configured (GROWW_API_KEY, GROWW_TOTP_SECRET)";
  createBehavior: CreateBehavior = "ok";
  failCancelFor = new Set<string>();
  calls: { method: string; args: unknown[] }[] = [];
  private seq = 0;

  constructor(private readonly clock: Clock) {}

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  created(): CreateOrderInput[] {
    return this.calls.filter((c) => c.method === "createOrder").map((c) => c.args[0] as CreateOrderInput);
  }

  /** Adds an order directly at the "broker" (e.g. placed outside the relay). */
  seedOrder(input: Partial<CreateOrderInput> & { tradingSymbol: string; transactionType: "BUY" | "SELL"; quantity: number }, status = "OPEN", opts: { reportQty?: boolean; ref?: string } = {}): string {
    const id = `GMKSEED${++this.seq}`;
    const ref = opts.ref ?? `SEED-${this.seq}-ABCDEF`;
    this.orders.set(id, {
      id,
      ref,
      input: {
        exchange: "NSE",
        segment: "FNO",
        product: "MIS",
        orderType: "LIMIT",
        price: 100,
        validity: "DAY",
        orderReferenceId: ref,
        ...input,
      },
      status,
      filled: 0,
      avg: null,
      reportQty: opts.reportQty ?? true,
    });
    this.byRef.set(ref, id);
    return id;
  }

  private state(o: FakeOrder): OrderState {
    return { growwOrderId: o.id, orderReferenceId: o.ref, orderStatus: o.status, filledQty: o.filled, avgFillPrice: null, remark: "ok", raw: { groww_order_id: o.id } };
  }

  private listItem(o: FakeOrder): OrderListItem {
    return {
      ...this.state(o),
      avgFillPrice: o.avg,
      tradingSymbol: o.input.tradingSymbol,
      exchange: o.input.exchange,
      segment: o.input.segment,
      transactionType: o.input.transactionType,
      product: o.input.product,
      orderType: o.input.orderType,
      quantity: o.reportQty ? o.input.quantity : null,
      price: o.input.price,
      remainingQty: o.reportQty ? o.input.quantity - o.filled : null,
    };
  }

  async ensureToken(): Promise<TokenStatus> {
    this.calls.push({ method: "ensureToken", args: [] });
    if (!this.tokenOk) throw new GrowwError("token", this.tokenError);
    return this.tokenStatus();
  }

  tokenStatus(): TokenStatus {
    return this.tokenOk
      ? { validUntil: this.clock.now() + 3_600_000, mintedAt: this.clock.now(), lastError: null }
      : { validUntil: null, mintedAt: null, lastError: this.tokenError };
  }

  async createOrder(input: CreateOrderInput): Promise<OrderAck> {
    this.calls.push({ method: "createOrder", args: [input] });
    if (this.byRef.has(input.orderReferenceId)) throw new GrowwError("duplicate_ref", "groww POST /order/create: GA007 Duplicate order reference id", 400, "GA007");
    if (this.createBehavior === "reject") throw new GrowwError("bad_request", "groww POST /order/create: GA001 Insufficient margin", 400, "GA001");
    if (this.createBehavior === "timeout-no-create") throw new GrowwError("timeout", "groww POST /order/create timed out");
    const id = `GMK${++this.seq}`;
    const o: FakeOrder = { id, ref: input.orderReferenceId, input, status: "OPEN", filled: 0, avg: null, reportQty: true };
    this.orders.set(id, o);
    this.byRef.set(input.orderReferenceId, id);
    if (this.createBehavior === "timeout-after-create") throw new GrowwError("timeout", "groww POST /order/create timed out");
    if (this.createBehavior === "server-error-after-create") throw new GrowwError("server", "groww POST /order/create: GA000 Internal error occurred", 500, "GA000");
    return { growwOrderId: id, orderStatus: "OPEN", orderReferenceId: input.orderReferenceId, remark: "Order placed successfully", raw: { groww_order_id: id } };
  }

  async getOrderStatus(growwOrderId: string): Promise<OrderState> {
    this.calls.push({ method: "getOrderStatus", args: [growwOrderId] });
    const o = this.orders.get(growwOrderId);
    if (!o) throw new GrowwError("not_found", "GA004 Requested entity does not exist", 404, "GA004");
    return this.state(o);
  }

  async getOrderStatusByRef(ref: string): Promise<OrderState | null> {
    this.calls.push({ method: "getOrderStatusByRef", args: [ref] });
    const id = this.byRef.get(ref);
    const o = id ? this.orders.get(id) : undefined;
    return o ? this.state(o) : null;
  }

  async getOrderDetail(growwOrderId: string): Promise<OrderListItem> {
    this.calls.push({ method: "getOrderDetail", args: [growwOrderId] });
    const o = this.orders.get(growwOrderId);
    if (!o) throw new GrowwError("not_found", "GA004 Requested entity does not exist", 404, "GA004");
    return this.listItem(o);
  }

  async getTrades(growwOrderId: string): Promise<TradeFill[]> {
    this.calls.push({ method: "getTrades", args: [growwOrderId] });
    const o = this.orders.get(growwOrderId);
    if (!o || o.filled === 0) return [];
    return [{ tradeId: `T-${o.id}`, price: o.avg, qty: o.filled, time: "2026-10-06T10:40:01" }];
  }

  async cancelOrder(growwOrderId: string): Promise<OrderUpdateAck> {
    this.calls.push({ method: "cancelOrder", args: [growwOrderId] });
    const o = this.orders.get(growwOrderId);
    if (!o) throw new GrowwError("not_found", "GA004 Requested entity does not exist", 404, "GA004");
    if (this.failCancelFor.has(growwOrderId)) throw new GrowwError("bad_request", "GA006 Cannot process this request", 400, "GA006");
    o.status = "CANCELLED";
    return { growwOrderId, orderStatus: "CANCELLED", raw: {} };
  }

  async modifyOrder(input: ModifyOrderInput): Promise<OrderUpdateAck> {
    this.calls.push({ method: "modifyOrder", args: [input] });
    const o = this.orders.get(input.growwOrderId);
    if (!o) throw new GrowwError("not_found", "GA004 Requested entity does not exist", 404, "GA004");
    o.input = { ...o.input, quantity: input.quantity, price: input.price, orderType: input.orderType };
    return { growwOrderId: o.id, orderStatus: "OPEN", raw: {} };
  }

  async listOrders(_segment: Segment, page: number, pageSize: number): Promise<OrderListItem[]> {
    this.calls.push({ method: "listOrders", args: [page, pageSize] });
    return [...this.orders.values()].slice(page * pageSize, (page + 1) * pageSize).map((o) => this.listItem(o));
  }

  async getPositions(): Promise<PositionRow[]> {
    this.calls.push({ method: "getPositions", args: [] });
    return this.positions;
  }

  async getMargins(): Promise<unknown> {
    this.calls.push({ method: "getMargins", args: [] });
    if (this.marginsFail) throw new GrowwError("network", "groww GET /margins/detail/user unreachable");
    return this.margins;
  }

  async getLtp(_segment: Segment, exchangeSymbols: string[]): Promise<Record<string, number>> {
    this.calls.push({ method: "getLtp", args: [exchangeSymbols] });
    const out: Record<string, number> = {};
    for (const s of exchangeSymbols) if (this.ltp[s] !== undefined) out[s] = this.ltp[s];
    return out;
  }

  async proxyGet(pathWithQuery: string): Promise<{ status: number; body: unknown }> {
    this.calls.push({ method: "proxyGet", args: [pathWithQuery] });
    return { status: 200, body: { status: "SUCCESS", payload: { echoed: pathWithQuery } } };
  }
}

export function position(tradingSymbol: string, qty: number, extra: Partial<PositionRow> = {}): PositionRow {
  return {
    tradingSymbol,
    exchange: tradingSymbol.startsWith("SENSEX") ? "BSE" : "NSE",
    segment: "FNO",
    product: "MIS",
    qty,
    avgPrice: 100,
    raw: { trading_symbol: tradingSymbol, quantity: qty },
    ...extra,
  };
}

export interface Harness {
  app: Hono<AppEnv>;
  clock: FakeClock;
  /** Every sleep the app requested (ms), e.g. order spacing and lookup back-off. */
  sleeps: number[];
  groww: FakeGroww;
  ledger: Ledger;
  config: RelayConfig;
  /** Signs and sends a request the way the engine does. */
  call(method: string, path: string, body?: unknown, opts?: SignOptions): Promise<Response>;
}

export interface SignOptions {
  ts?: number;
  nonce?: string;
  secret?: string;
  headers?: Record<string, string>;
  /** Sign this path instead of the one requested (to test tampering). */
  signPath?: string;
  /** Sign this body instead of the one sent. */
  signBody?: string;
}

export function signedInit(method: string, path: string, rawBody: string, now: number, opts: SignOptions = {}): RequestInit {
  const ts = String(opts.ts ?? now);
  const nonce = opts.nonce ?? randomBytes(16).toString("hex");
  const sig = signRequest(opts.secret ?? TEST_SECRET, {
    ts,
    nonce,
    method,
    pathWithQuery: opts.signPath ?? path,
    bodySha256: sha256Hex(opts.signBody ?? rawBody),
  });
  const headers: Record<string, string> = { "X-Relay-Ts": ts, "X-Relay-Nonce": nonce, "X-Relay-Sig": sig, ...opts.headers };
  if (rawBody !== "") headers["Content-Type"] = "application/json";
  return { method, headers, body: method === "GET" || method === "HEAD" ? undefined : rawBody };
}

export function harness(env: Record<string, string> = {}, deps: Partial<AppDeps> = {}): Harness {
  const clock = new FakeClock();
  const config = testConfig(env);
  const ledger = new Ledger(":memory:", clock);
  const groww = new FakeGroww(clock);
  const sleeps: number[] = [];
  const app = createApp({
    config,
    groww,
    ledger,
    clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      await clock.sleep(ms);
    },
    fetch: async () => {
      throw new Error("network disabled in tests");
    },
    ...deps,
  });
  return {
    app,
    clock,
    sleeps,
    groww,
    ledger,
    config,
    call: (method, path, body, opts) => {
      const raw = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
      return Promise.resolve(app.request(path, signedInit(method, path, raw, clock.now(), opts)));
    },
  };
}

let keySeq = 0;
/** A fresh valid idempotency key (8-20 alphanumerics, <= 2 hyphens). */
export function newKey(prefix = "RT"): string {
  keySeq += 1;
  return `${prefix}${String(Date.now() % 1e6).padStart(6, "0")}N${keySeq}`;
}

export function buyOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: newKey(),
    underlying: "NIFTY",
    tradingSymbol: "NIFTY26O1325000CE",
    exchange: "NSE",
    segment: "FNO",
    side: "BUY",
    qty: 65,
    lotSize: 65,
    orderType: "LIMIT",
    price: 100,
    product: "MIS",
    validity: "DAY",
    ...overrides,
  };
}

export function sellOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return buyOrder({ side: "SELL", price: 120, ...overrides });
}

export async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}
