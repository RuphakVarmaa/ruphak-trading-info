// Everything Groww-specific lives here: endpoints, headers, request/response field names,
// error codes, and the TOTP access-token lifecycle. Sources: Groww cURL docs
// (https://groww.in/trade-api/docs/curl, fetched 2026-10-07) and the community `growwapi`
// Node SDK 1.1.3. Field mapping is defensive because the docs and the SDK disagree in places.
import type { Clock } from "./clock.js";
import { nextIstTime, istTimeOnDay, parseIstTimestamp } from "./ist.js";
import type { StoredToken } from "./ledger.js";
import { errorFields, type Logger } from "./log.js";
import { totp } from "./totp.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Segment = "FNO" | "CASH";

// ---- errors ------------------------------------------------------------------------------

export type GrowwErrorKind =
  | "token" // no access token could be obtained; nothing was sent
  | "auth" // 401 even after one token refresh
  | "forbidden" // 403 / GA005: IP not whitelisted, subscription, permissions
  | "bad_request" // 400/422 / GA001 / GA006: Groww refused the request
  | "not_found" // 404 / GA004
  | "duplicate_ref" // GA007: an order with this order_reference_id already exists
  | "rate_limited" // 429
  | "server" // 5xx / GA000 / GA003: may or may not have been processed
  | "timeout"
  | "network"
  | "invalid_response"; // 2xx without a usable body

const AMBIGUOUS_KINDS: ReadonlySet<GrowwErrorKind> = new Set(["server", "timeout", "network", "invalid_response"]);

export class GrowwError extends Error {
  constructor(
    readonly kind: GrowwErrorKind,
    message: string,
    readonly httpStatus?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "GrowwError";
  }

  /** True when Groww may have processed the request (never resend an order blindly). */
  get ambiguous(): boolean {
    return AMBIGUOUS_KINDS.has(this.kind);
  }
}

export function isGrowwError(e: unknown): e is GrowwError {
  return e instanceof GrowwError;
}

/** Documented error codes: GA000 internal, GA001 bad request, GA003 unable to serve, GA004 not found, GA005 not authorised, GA006 cannot process, GA007 duplicate order reference id. */
export function errorKindFor(httpStatus: number, code?: string): GrowwErrorKind {
  if (httpStatus === 401) return "auth";
  switch (code) {
    case "GA007":
      return "duplicate_ref";
    case "GA004":
      return "not_found";
    case "GA005":
      return "forbidden";
    case "GA001":
    case "GA006":
      return "bad_request";
    case "GA000":
    case "GA003":
      return "server";
  }
  if (httpStatus === 403) return "forbidden";
  if (httpStatus === 404) return "not_found";
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus >= 500) return "server";
  return "bad_request"; // 4xx, or a 2xx carrying status FAILURE
}

// ---- normalized shapes -------------------------------------------------------------------

export interface OrderState {
  growwOrderId: string | null;
  orderReferenceId: string | null;
  orderStatus: string | null;
  filledQty: number | null;
  avgFillPrice: number | null;
  remark: string | null;
  raw: unknown;
}

export interface OrderListItem extends OrderState {
  tradingSymbol: string | null;
  exchange: string | null;
  segment: string | null;
  transactionType: string | null;
  product: string | null;
  orderType: string | null;
  quantity: number | null;
  price: number | null;
  remainingQty: number | null;
}

export interface TradeFill {
  tradeId: string | null;
  price: number | null;
  qty: number | null;
  time: string | null;
}

export interface PositionRow {
  tradingSymbol: string;
  exchange: string | null;
  segment: string | null;
  product: string | null;
  /** Net quantity, signed: long positive, short negative. */
  qty: number;
  avgPrice: number | null;
  raw: unknown;
}

export interface CreateOrderInput {
  tradingSymbol: string;
  quantity: number;
  /** Ignored (sent as 0) for MARKET orders. */
  price: number | null;
  validity: "DAY";
  exchange: "NSE" | "BSE";
  segment: Segment;
  product: string;
  orderType: "MARKET" | "LIMIT";
  transactionType: "BUY" | "SELL";
  orderReferenceId: string;
}

export interface OrderAck {
  growwOrderId: string;
  orderStatus: string | null;
  orderReferenceId: string | null;
  remark: string | null;
  raw: unknown;
}

export interface ModifyOrderInput {
  growwOrderId: string;
  segment: Segment;
  quantity: number;
  /** Only sent for LIMIT orders. */
  price: number | null;
  /** Groww requires order_type on every modify. */
  orderType: "MARKET" | "LIMIT";
}

export interface OrderUpdateAck {
  growwOrderId: string | null;
  orderStatus: string | null;
  raw: unknown;
}

export interface TokenStatus {
  validUntil: number | null;
  mintedAt: number | null;
  lastError: string | null;
}

/** The surface the rest of the relay uses; tests substitute an in-memory fake. */
export interface GrowwApi {
  ensureToken(): Promise<TokenStatus>;
  tokenStatus(): TokenStatus;
  createOrder(input: CreateOrderInput): Promise<OrderAck>;
  getOrderStatus(growwOrderId: string, segment: Segment): Promise<OrderState>;
  /** null when Groww has no order with this reference id. */
  getOrderStatusByRef(ref: string, segment: Segment): Promise<OrderState | null>;
  getOrderDetail(growwOrderId: string, segment: Segment): Promise<OrderListItem>;
  getTrades(growwOrderId: string, segment: Segment): Promise<TradeFill[]>;
  cancelOrder(growwOrderId: string, segment: Segment): Promise<OrderUpdateAck>;
  modifyOrder(input: ModifyOrderInput): Promise<OrderUpdateAck>;
  listOrders(segment: Segment, page: number, pageSize: number): Promise<OrderListItem[]>;
  getPositions(segment: Segment): Promise<PositionRow[]>;
  getMargins(): Promise<unknown>;
  /** LTP keyed by "<EXCHANGE>_<TRADING_SYMBOL>". */
  getLtp(segment: Segment, exchangeSymbols: string[]): Promise<Record<string, number>>;
  /** Raw GET for the read-only data proxy; returns Groww's status and JSON as-is. */
  proxyGet(pathWithQuery: string): Promise<{ status: number; body: unknown }>;
}

/** Statuses after which an order can no longer fill (documented enum). */
const TERMINAL_STATUSES = new Set(["REJECTED", "FAILED", "EXECUTED", "DELIVERY_AWAITED", "CANCELLED", "COMPLETED"]);

/**
 * True unless the status is known to be terminal. Unknown or missing statuses count as open
 * (docs examples also return "OPEN", which is not in the enum), so a pending SELL is never
 * overlooked and panic tries to cancel everything that might still fill.
 */
export function isOpenOrderStatus(status: string | null | undefined): boolean {
  if (status === null || status === undefined || status.trim() === "") return true;
  return !TERMINAL_STATUSES.has(status.trim().toUpperCase());
}

// ---- defensive field mapping -------------------------------------------------------------

type Rec = Record<string, unknown>;

function asRecord(v: unknown): Rec | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}

function pick(obj: Rec, keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function asStr(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * Code and message of a failed response. Documented shape: {status:"FAILURE", error:{code,
 * message}}. Groww's gateway answers bad credentials with {errorCode, errorMessage:{message}}.
 */
export function failureInfo(json: unknown, text: string, httpStatus: number): { code?: string; message: string } {
  const env = asRecord(json);
  const err = asRecord(env?.error);
  const gateway = asRecord(env?.errorMessage);
  const code = asStr(err?.code) ?? undefined;
  const message =
    asStr(err?.message) ?? asStr(gateway?.message) ?? asStr(env?.errorMessage) ?? asStr(env?.message) ?? (text.slice(0, 200) || `HTTP ${httpStatus}`);
  return { code, message };
}

export function normalizeOrderState(payload: unknown): OrderState {
  const p = asRecord(payload) ?? {};
  return {
    growwOrderId: asStr(pick(p, ["groww_order_id", "growwOrderId"])),
    orderReferenceId: asStr(pick(p, ["order_reference_id", "orderReferenceId"])),
    orderStatus: asStr(pick(p, ["order_status", "orderStatus"])),
    filledQty: asNum(pick(p, ["filled_quantity", "filledQuantity", "filled_qty", "traded_quantity"])),
    avgFillPrice: asNum(pick(p, ["average_fill_price", "averageFillPrice", "avg_fill_price", "average_price", "avg_price"])),
    remark: asStr(pick(p, ["remark", "remarks"])),
    raw: payload,
  };
}

export function normalizeOrderListItem(payload: unknown): OrderListItem {
  const p = asRecord(payload) ?? {};
  return {
    ...normalizeOrderState(payload),
    tradingSymbol: asStr(pick(p, ["trading_symbol", "tradingSymbol"])),
    exchange: asStr(pick(p, ["exchange"])),
    segment: asStr(pick(p, ["segment"])),
    transactionType: asStr(pick(p, ["transaction_type", "transactionType"])),
    product: asStr(pick(p, ["product"])),
    orderType: asStr(pick(p, ["order_type", "orderType"])),
    quantity: asNum(pick(p, ["quantity", "qty"])),
    price: asNum(pick(p, ["price"])),
    remainingQty: asNum(pick(p, ["remaining_quantity", "remainingQuantity", "pending_quantity"])),
  };
}

/**
 * Extracts a list from a payload. An unknown shape is an error, never an empty list: panic
 * must not mistake "could not read positions" for "no positions".
 */
function arrayField(payload: unknown, keys: string[], what: string): unknown[] {
  if (payload === null || payload === undefined) return [];
  if (Array.isArray(payload)) return payload;
  const p = asRecord(payload);
  if (p) {
    for (const k of keys) {
      const v = p[k];
      if (Array.isArray(v)) return v;
      if (v === null) return [];
    }
  }
  throw new GrowwError("invalid_response", `unexpected ${what} payload shape`);
}

export function normalizeOrderList(payload: unknown): OrderListItem[] {
  return arrayField(payload, ["order_list", "orderList", "orders"], "order list").map(normalizeOrderListItem);
}

export function normalizeTrades(payload: unknown): TradeFill[] {
  return arrayField(payload, ["trade_list", "tradeList", "trades"], "trade list").map((t) => {
    const p = asRecord(t) ?? {};
    return {
      tradeId: asStr(pick(p, ["groww_trade_id", "growwTradeId", "exchange_trade_id", "exchangeTradeId", "trade_id"])),
      price: asNum(pick(p, ["price", "trade_price", "tradePrice"])),
      qty: asNum(pick(p, ["quantity", "qty", "trade_quantity"])),
      time: asStr(pick(p, ["trade_date_time", "tradeDateTime", "created_at", "createdAt", "exchange_time"])),
    };
  });
}

export function normalizePositions(payload: unknown): PositionRow[] {
  const rows: PositionRow[] = [];
  for (const item of arrayField(payload, ["positions"], "positions")) {
    const p = asRecord(item) ?? {};
    const tradingSymbol = asStr(pick(p, ["trading_symbol", "tradingSymbol"]));
    if (!tradingSymbol) continue;
    // `quantity` is the documented net quantity (credit - debit + net carry-forward).
    let qty = asNum(pick(p, ["quantity", "net_quantity", "netQuantity"]));
    if (qty === null) {
      qty =
        (asNum(pick(p, ["credit_quantity", "creditQuantity"])) ?? 0) -
        (asNum(pick(p, ["debit_quantity", "debitQuantity"])) ?? 0) +
        (asNum(pick(p, ["net_carry_forward_quantity", "netCarryForwardQuantity"])) ?? 0);
    }
    rows.push({
      tradingSymbol,
      exchange: asStr(pick(p, ["exchange"])),
      segment: asStr(pick(p, ["segment"])),
      product: asStr(pick(p, ["product"])),
      qty,
      avgPrice: asNum(pick(p, ["net_price", "netPrice", "average_price", "avg_price"])),
      raw: item,
    });
  }
  return rows;
}

// ---- access token lifecycle --------------------------------------------------------------

/** Implemented by the SQLite ledger. */
export interface TokenStore {
  loadToken(): StoredToken | null;
  saveToken(t: StoredToken): void;
  clearToken(): void;
  recordMint(ok: boolean, detail: Record<string, unknown>): void;
  countMintsSince(ms: number): number;
}

export interface TokenManagerOptions {
  apiKey: string | null;
  totpSecret: string | null;
  baseUrl: string;
  fetch: FetchLike;
  clock: Clock;
  store: TokenStore;
  logger: Logger;
  timeoutMs: number;
  /** Token-endpoint calls allowed per rolling 24 h; Groww's hard limit is 150. */
  mintBudgetPer24h?: number;
}

const EXPIRY_MARGIN_MS = 60_000;
const AUTH_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const TOKEN_DEATH_MIN = 6 * 60; // Groww access tokens expire daily at 06:00 IST
const SCHEDULED_REFRESH_MIN = 6 * 60 + 5; // re-mint at 06:05 IST

export class GrowwTokenManager {
  private current: StoredToken | null = null;
  private inflight: Promise<StoredToken> | null = null;
  private lastAuthRefreshAt = Number.NEGATIVE_INFINITY;
  private failures = 0;
  private nextMintAt = 0;
  private lastError: string | null = null;
  private readonly budget: number;

  constructor(private readonly o: TokenManagerOptions) {
    this.budget = o.mintBudgetPer24h ?? 100;
  }

  get hasCredentials(): boolean {
    return this.o.apiKey !== null && this.o.totpSecret !== null;
  }

  status(): TokenStatus {
    const cur = this.cached();
    return { validUntil: cur?.expiresAt ?? null, mintedAt: cur?.mintedAt ?? null, lastError: this.lastError };
  }

  /** A valid access token: the cached one (memory, then SQLite) or a freshly minted one. */
  async getToken(): Promise<string> {
    const cur = this.cached();
    if (cur && cur.expiresAt - EXPIRY_MARGIN_MS > this.o.clock.now()) return cur.token;
    return (await this.refresh("expired")).token;
  }

  /** Single-flight mint: concurrent callers share one token-endpoint call. */
  refresh(reason: string): Promise<StoredToken> {
    if (!this.inflight) {
      this.inflight = this.mint(reason).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /**
   * Called after Groww answered 401 to `badToken`. Re-mints at most once per 5 minutes and
   * returns the token to retry with, or null when no retry should happen.
   */
  async onUnauthorized(badToken: string): Promise<string | null> {
    const now = this.o.clock.now();
    const cur = this.current;
    if (cur && cur.token !== badToken && cur.expiresAt - EXPIRY_MARGIN_MS > now) return cur.token;
    if (this.inflight) {
      try {
        return (await this.inflight).token;
      } catch {
        return null;
      }
    }
    if (now - this.lastAuthRefreshAt < AUTH_REFRESH_MIN_INTERVAL_MS) {
      this.o.logger.warn("groww answered 401 but the token was re-minted less than 5 minutes ago; not minting again");
      return null;
    }
    this.lastAuthRefreshAt = now;
    this.current = null;
    this.o.store.clearToken();
    try {
      return (await this.refresh("unauthorized")).token;
    } catch {
      return null;
    }
  }

  /** Re-mints once per day after 06:05 IST (tokens die at 06:00). Call every minute. */
  async maybeScheduledRefresh(): Promise<boolean> {
    if (!this.hasCredentials) return false;
    const now = this.o.clock.now();
    if (now < istTimeOnDay(now, SCHEDULED_REFRESH_MIN)) return false;
    const cur = this.cached();
    if (cur && cur.mintedAt >= istTimeOnDay(now, TOKEN_DEATH_MIN) && cur.expiresAt - EXPIRY_MARGIN_MS > now) return false;
    await this.refresh("scheduled");
    return true;
  }

  private cached(): StoredToken | null {
    if (!this.current) this.current = this.o.store.loadToken();
    return this.current;
  }

  private async mint(reason: string): Promise<StoredToken> {
    const { apiKey, totpSecret } = this.o;
    if (apiKey === null || totpSecret === null) {
      throw new GrowwError("token", "Groww credentials are not configured (GROWW_API_KEY, GROWW_TOTP_SECRET)");
    }
    const now = this.o.clock.now();
    if (now < this.nextMintAt) {
      throw new GrowwError(
        "token",
        `token minting paused until ${new Date(this.nextMintAt).toISOString()} after a failure: ${this.lastError ?? "unknown"}`,
      );
    }
    const used = this.o.store.countMintsSince(now - DAY_MS);
    if (used >= this.budget) {
      throw new GrowwError("token", `token mint budget exhausted (${used} token-endpoint calls in 24 h; Groww allows 150)`);
    }
    try {
      const code = totp(totpSecret, now);
      let res = await this.post(apiKey, { key_type: "totp", totp: code }, reason);
      if (res.status === 400) {
        // The community SDK sends only {totp}; fall back once if the documented form is refused.
        this.o.logger.warn("groww token endpoint refused {key_type,totp}; retrying with {totp}", { reason });
        res = await this.post(apiKey, { totp: code }, reason);
      }
      const t = this.parseTokenResponse(res, now);
      this.o.store.saveToken(t);
      this.current = t;
      this.failures = 0;
      this.nextMintAt = 0;
      this.lastError = null;
      this.o.logger.info("groww access token minted", { reason, validUntil: new Date(t.expiresAt).toISOString() });
      return t;
    } catch (e) {
      this.failures += 1;
      this.nextMintAt = this.o.clock.now() + Math.min(15 * 60_000, 30_000 * 2 ** (this.failures - 1));
      this.lastError = e instanceof Error ? e.message : String(e);
      this.o.logger.error("groww token mint failed", { reason, failures: this.failures, err: errorFields(e) });
      if (isGrowwError(e) && e.kind === "token") throw e;
      const inner = isGrowwError(e) ? e : null;
      throw new GrowwError("token", `token mint failed: ${this.lastError}`, inner?.httpStatus, inner?.code);
    }
  }

  private async post(apiKey: string, body: Record<string, string>, reason: string): Promise<{ status: number; json: unknown; text: string }> {
    let res: Response;
    try {
      res = await this.o.fetch(`${this.o.baseUrl}/token/api/access`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-API-VERSION": "1.0",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch (e) {
      this.o.store.recordMint(false, { reason, error: "transport" });
      throw transportError(e, "token endpoint");
    }
    const text = await res.text().catch(() => "");
    this.o.store.recordMint(res.ok, { reason, httpStatus: res.status, form: "key_type" in body ? "key_type" : "totp_only" });
    return { status: res.status, json: safeJson(text), text };
  }

  private parseTokenResponse(res: { status: number; json: unknown; text: string }, now: number): StoredToken {
    const env = asRecord(res.json);
    if (res.status < 200 || res.status >= 300 || env?.status === "FAILURE") {
      const { code, message } = failureInfo(res.json, res.text, res.status);
      throw new GrowwError(errorKindFor(res.status, code), `token endpoint HTTP ${res.status}: ${code ? `${code} ` : ""}${message}`, res.status, code);
    }
    if (!env) throw new GrowwError("invalid_response", "token endpoint returned a non-JSON body", res.status);
    // The docs and SDK read {token, expiry} at the top level; accept them under payload too.
    const src: Rec = { ...env, ...(asRecord(env.payload) ?? {}) };
    const token = asStr(src.token);
    if (!token) throw new GrowwError("invalid_response", "token endpoint response has no token", res.status);
    if (src.isActive === false || src.is_active === false) {
      throw new GrowwError("forbidden", "token endpoint returned an inactive token (is the API key approved/active?)", res.status);
    }
    const deadline = nextIstTime(now, TOKEN_DEATH_MIN);
    const parsed = parseIstTimestamp(src.expiry);
    let expiresAt = deadline;
    if (parsed !== null && parsed > now + 5 * 60_000) expiresAt = Math.min(parsed, deadline);
    else if (parsed !== null) this.o.logger.warn("ignoring a token expiry that is already (nearly) past", { expiry: String(src.expiry) });
    return { token, expiresAt, mintedAt: now };
  }
}

function safeJson(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function transportError(e: unknown, what: string): GrowwError {
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError" || name === "AbortError") return new GrowwError("timeout", `${what} timed out`);
  const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
  return new GrowwError("network", `${what} unreachable (${e instanceof Error ? e.message : String(e)}${cause})`);
}

// ---- REST client -------------------------------------------------------------------------

export interface GrowwClientOptions {
  baseUrl: string;
  fetch: FetchLike;
  tokens: GrowwTokenManager;
  timeoutMs: number;
  logger: Logger;
}

function query(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

export class GrowwClient implements GrowwApi {
  constructor(private readonly o: GrowwClientOptions) {}

  async ensureToken(): Promise<TokenStatus> {
    await this.o.tokens.getToken();
    return this.o.tokens.status();
  }

  tokenStatus(): TokenStatus {
    return this.o.tokens.status();
  }

  async createOrder(input: CreateOrderInput): Promise<OrderAck> {
    const body: Rec = {
      trading_symbol: input.tradingSymbol,
      quantity: input.quantity,
      price: input.orderType === "MARKET" ? 0 : input.price,
      validity: input.validity,
      exchange: input.exchange,
      segment: input.segment,
      product: input.product,
      order_type: input.orderType,
      transaction_type: input.transactionType,
      order_reference_id: input.orderReferenceId,
    };
    const state = normalizeOrderState(await this.call("POST", "/order/create", body));
    if (!state.growwOrderId) throw new GrowwError("invalid_response", "order create succeeded without groww_order_id");
    return {
      growwOrderId: state.growwOrderId,
      orderStatus: state.orderStatus,
      orderReferenceId: state.orderReferenceId,
      remark: state.remark,
      raw: state.raw,
    };
  }

  async getOrderStatus(growwOrderId: string, segment: Segment): Promise<OrderState> {
    return normalizeOrderState(await this.call("GET", `/order/status/${encodeURIComponent(growwOrderId)}?${query({ segment })}`));
  }

  async getOrderStatusByRef(ref: string, segment: Segment): Promise<OrderState | null> {
    try {
      const state = normalizeOrderState(await this.call("GET", `/order/status/reference/${encodeURIComponent(ref)}?${query({ segment })}`));
      return state.growwOrderId || state.orderStatus ? state : null;
    } catch (e) {
      if (isGrowwError(e) && e.kind === "not_found") return null;
      throw e;
    }
  }

  async getOrderDetail(growwOrderId: string, segment: Segment): Promise<OrderListItem> {
    return normalizeOrderListItem(await this.call("GET", `/order/detail/${encodeURIComponent(growwOrderId)}?${query({ segment })}`));
  }

  async getTrades(growwOrderId: string, segment: Segment): Promise<TradeFill[]> {
    const pageSize = 50; // documented maximum
    const out: TradeFill[] = [];
    for (let page = 0; page < 20; page++) {
      const payload = await this.call("GET", `/order/trades/${encodeURIComponent(growwOrderId)}?${query({ segment, page, page_size: pageSize })}`);
      const trades = normalizeTrades(payload);
      out.push(...trades);
      if (trades.length < pageSize) break;
    }
    return out;
  }

  async cancelOrder(growwOrderId: string, segment: Segment): Promise<OrderUpdateAck> {
    const s = normalizeOrderState(await this.call("POST", "/order/cancel", { segment, groww_order_id: growwOrderId }));
    return { growwOrderId: s.growwOrderId, orderStatus: s.orderStatus, raw: s.raw };
  }

  async modifyOrder(input: ModifyOrderInput): Promise<OrderUpdateAck> {
    const body: Rec = {
      segment: input.segment,
      groww_order_id: input.growwOrderId,
      order_type: input.orderType,
      quantity: input.quantity,
    };
    if (input.orderType === "LIMIT" && input.price !== null) body.price = input.price;
    const s = normalizeOrderState(await this.call("POST", "/order/modify", body));
    return { growwOrderId: s.growwOrderId, orderStatus: s.orderStatus, raw: s.raw };
  }

  async listOrders(segment: Segment, page: number, pageSize: number): Promise<OrderListItem[]> {
    return normalizeOrderList(await this.call("GET", `/order/list?${query({ segment, page, page_size: pageSize })}`));
  }

  async getPositions(segment: Segment): Promise<PositionRow[]> {
    return normalizePositions(await this.call("GET", `/positions/user?${query({ segment })}`));
  }

  async getMargins(): Promise<unknown> {
    return this.call("GET", "/margins/detail/user");
  }

  async getLtp(segment: Segment, exchangeSymbols: string[]): Promise<Record<string, number>> {
    const symbols = exchangeSymbols.map((s) => encodeURIComponent(s)).join(","); // docs show literal commas
    const payload = asRecord(await this.call("GET", `/live-data/ltp?segment=${encodeURIComponent(segment)}&exchange_symbols=${symbols}`)) ?? {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(payload)) {
      const n = asNum(v) ?? asNum(asRecord(v)?.ltp);
      if (n !== null) out[k] = n;
    }
    return out;
  }

  async proxyGet(pathWithQuery: string): Promise<{ status: number; body: unknown }> {
    const res = await this.send("GET", pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`);
    return { status: res.status, body: res.json ?? (res.text === "" ? null : { raw: res.text }) };
  }

  /** Sends with the current token; on 401 refreshes the token (rate-limited) and retries once. */
  private async send(method: "GET" | "POST", pathWithQuery: string, body?: unknown): Promise<{ status: number; json: unknown; text: string }> {
    let token = await this.o.tokens.getToken();
    let res = await this.fetchOnce(method, pathWithQuery, token, body);
    if (res.status === 401) {
      const fresh = await this.o.tokens.onUnauthorized(token);
      if (fresh !== null) {
        token = fresh;
        res = await this.fetchOnce(method, pathWithQuery, token, body);
      }
    }
    return res;
  }

  private async fetchOnce(
    method: "GET" | "POST",
    pathWithQuery: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown; text: string }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "X-API-VERSION": "1.0",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.o.fetch(`${this.o.baseUrl}${pathWithQuery}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch (e) {
      throw transportError(e, `groww ${method} ${pathWithQuery.split("?")[0]}`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw transportError(e, `groww ${method} ${pathWithQuery.split("?")[0]} (reading body)`);
    }
    return { status: res.status, json: safeJson(text), text };
  }

  /** Returns `payload` of a SUCCESS envelope; throws GrowwError otherwise. */
  private async call(method: "GET" | "POST", pathWithQuery: string, body?: unknown): Promise<unknown> {
    const res = await this.send(method, pathWithQuery, body);
    const env = asRecord(res.json);
    const path = pathWithQuery.split("?")[0];
    if (res.status >= 200 && res.status < 300 && env?.status !== "FAILURE") {
      if (!env) throw new GrowwError("invalid_response", `groww ${method} ${path}: unparseable response`, res.status);
      return "payload" in env ? env.payload : env;
    }
    const { code, message } = failureInfo(res.json, res.text, res.status);
    const kind = errorKindFor(res.status, code);
    if (kind === "auth" || kind === "forbidden") this.o.logger.warn("groww refused the request", { method, path, httpStatus: res.status, code, message });
    throw new GrowwError(kind, `groww ${method} ${path}: ${code ? `${code} ` : ""}${message}`, res.status, code);
  }
}
