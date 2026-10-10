// Order flows: place (idempotent, capped, never blindly resent), cancel, modify (re-capped),
// and panic (cancel everything, square off longs without ever creating shorts). All order
// mutations run one at a time through a queue and are spaced >= ORDER_MIN_INTERVAL_MS apart.
import { checkModifyCaps, checkOrderCaps, NOT_LIVE_REASON, parseOrderRequest, type Exposure, type OrderRequest } from "./caps.js";
import type { Clock, Sleep } from "./clock.js";
import type { RelayConfig } from "./config.js";
import { isGrowwError, isOpenOrderStatus, type GrowwApi, type OrderListItem, type OrderState, type Segment } from "./groww.js";
import { istDate } from "./ist.js";
import type { Ledger, NewOrder, OrderRow } from "./ledger.js";
import { errorFields, type Logger } from "./log.js";

export interface ServiceResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

export interface OrderServiceDeps {
  config: RelayConfig;
  groww: GrowwApi;
  ledger: Ledger;
  clock: Clock;
  sleep: Sleep;
  logger: Logger;
}

/** Waits before each by-reference lookup after an ambiguous create (timeout / 5xx). */
export const REF_LOOKUP_DELAYS_MS = [1_000, 2_000, 3_000];
/** Waits while panic lets cancellations settle before reading what is still open. */
export const PANIC_SETTLE_DELAYS_MS = [500, 1_000, 1_500, 2_000];
const LIST_PAGE_SIZE = 25;
const LIST_MAX_PAGES = 40;
const GROWW_ORDER_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

export function isValidGrowwOrderId(id: string): boolean {
  return GROWW_ORDER_ID_RE.test(id);
}

export function parseSegment(value: unknown, fallback: Segment | null = "FNO"): Segment | null {
  if (value === undefined || value === null || value === "") return fallback;
  return value === "FNO" || value === "CASH" ? value : null;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** HTTP mapping for Groww failures on non-order endpoints ({error, code}). */
export function growwErrorResult(e: unknown): ServiceResult {
  if (!isGrowwError(e)) throw e;
  const map: Record<string, [number, string]> = {
    token: [503, "GROWW_TOKEN_UNAVAILABLE"],
    auth: [502, "GROWW_AUTH_FAILED"],
    forbidden: [502, "GROWW_FORBIDDEN"],
    not_found: [404, "GROWW_NOT_FOUND"],
    bad_request: [422, "GROWW_REJECTED"],
    duplicate_ref: [422, "GROWW_REJECTED"],
    rate_limited: [503, "GROWW_RATE_LIMITED"],
    timeout: [504, "GROWW_TIMEOUT"],
    network: [502, "GROWW_UNAVAILABLE"],
    server: [502, "GROWW_UNAVAILABLE"],
    invalid_response: [502, "GROWW_UNAVAILABLE"],
  };
  const [httpStatus, code] = map[e.kind] ?? [502, "GROWW_ERROR"];
  return { httpStatus, body: { error: e.message, code, ...(e.code ? { growwCode: e.code } : {}) } };
}

function inferExchange(symbol: string): "NSE" | "BSE" {
  return symbol.startsWith("SENSEX") || symbol.startsWith("BANKEX") ? "BSE" : "NSE";
}

function inferUnderlying(symbol: string): string | null {
  return symbol.startsWith("NIFTY") ? "NIFTY" : symbol.startsWith("SENSEX") ? "SENSEX" : null;
}

/** Unfilled quantity of an open order; unknown counts as infinite so it can never enable a short. */
function pendingQty(o: OrderListItem): number {
  if (o.remainingQty !== null) return Math.max(0, o.remainingQty);
  if (o.quantity !== null) return Math.max(0, o.quantity - (o.filledQty ?? 0));
  return Number.POSITIVE_INFINITY;
}

export class OrderService {
  private tail: Promise<unknown> = Promise.resolve();
  private lastMutationAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly d: OrderServiceDeps) {}

  /** Runs `fn` after every previously queued order operation has settled. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Spaces Groww create/modify/cancel calls at least orderMinIntervalMs apart. */
  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    const wait = this.lastMutationAt + this.d.config.orderMinIntervalMs - this.d.clock.now();
    if (wait > 0) await this.d.sleep(wait);
    this.lastMutationAt = this.d.clock.now();
    try {
      return await fn();
    } finally {
      this.lastMutationAt = this.d.clock.now();
    }
  }

  // ---- place -----------------------------------------------------------------------------

  async placeOrder(body: unknown): Promise<ServiceResult> {
    const parsed = parseOrderRequest(body);
    if (!parsed.ok) return { httpStatus: 400, body: { error: parsed.error, code: "BAD_REQUEST" } };
    return this.serialize(() => this.place(parsed.value));
  }

  private rowFor(req: OrderRequest, now: number): Omit<NewOrder, "premiumInr" | "isExit" | "sent" | "status" | "reason" | "violations"> {
    return {
      idempotencyKey: req.idempotencyKey,
      source: "API",
      istDate: istDate(now),
      underlying: req.underlying,
      tradingSymbol: req.tradingSymbol,
      exchange: req.exchange,
      segment: req.segment,
      side: req.side,
      qty: req.qty,
      lotSize: req.lotSize,
      orderType: req.orderType,
      price: req.price,
      product: req.product,
      validity: req.validity,
      growwOrderId: null,
      orderStatus: null,
      request: req,
      response: null,
    };
  }

  private async place(req: OrderRequest): Promise<ServiceResult> {
    const { config, groww, ledger, clock, logger } = this.d;
    const existing = ledger.findSentOrder(req.idempotencyKey);
    if (existing) return this.duplicate(existing, req);

    const now = clock.now();
    const today = istDate(now);
    const day = { now, ordersToday: ledger.countSentOrders(today), buyPremiumToday: ledger.buyPremium(today) };

    // Static caps first; broker-backed checks (position, LTP) only in live mode and only if
    // the static caps pass, so shadow mode never calls Groww.
    let caps = checkOrderCaps(req, config, day, { exposure: null, marketLtp: null });
    const brokerProblems: string[] = [];
    if (config.live && caps.violations.length === 0) {
      let exposure: Exposure | null = null;
      let marketLtp: number | null = null;
      if (req.side === "SELL") {
        try {
          exposure = await this.sellExposure(req.tradingSymbol, req.exchange, req.product);
        } catch (e) {
          brokerProblems.push(`cannot verify the long position in ${req.tradingSymbol}: ${message(e)}`);
        }
      } else if (req.orderType === "MARKET" && req.premiumEstimate !== null) {
        try {
          marketLtp = await this.ltp(req.exchange, req.tradingSymbol);
        } catch (e) {
          brokerProblems.push(`cannot bound the MARKET BUY premium (LTP unavailable): ${message(e)}`);
        }
      }
      caps = checkOrderCaps(req, config, day, { exposure, marketLtp });
    }
    const violations = [...caps.violations, ...brokerProblems];
    const base = this.rowFor(req, now);

    if (violations.length > 0) {
      ledger.insertOrder({ ...base, premiumInr: caps.premiumInr, isExit: caps.isExit, sent: false, status: "REJECTED", reason: violations[0] ?? null, violations });
      logger.warn("order rejected by relay caps", { idempotencyKey: req.idempotencyKey, shadow: !config.live, violations });
      return { httpStatus: 422, body: { status: "REJECTED", reason: violations[0], violations, rejectedBy: "RELAY" } };
    }

    try {
      await groww.ensureToken();
    } catch (e) {
      const reason = `groww access token unavailable: ${message(e)}`;
      ledger.insertOrder({ ...base, premiumInr: caps.premiumInr, isExit: caps.isExit, sent: false, status: "REJECTED", reason, violations: [reason] });
      logger.error("order not sent: no Groww token", { idempotencyKey: req.idempotencyKey, err: errorFields(e) });
      return { httpStatus: 422, body: { status: "REJECTED", reason, violations: [reason], rejectedBy: "RELAY" } };
    }

    const id = ledger.insertOrder({ ...base, premiumInr: caps.premiumInr, isExit: caps.isExit, sent: true, status: "PENDING", reason: null, violations: [] });
    try {
      const ack = await this.mutate(() =>
        groww.createOrder({
          tradingSymbol: req.tradingSymbol,
          quantity: req.qty,
          price: req.price,
          validity: req.validity,
          exchange: req.exchange,
          segment: req.segment,
          product: req.product,
          orderType: req.orderType,
          transactionType: req.side,
          orderReferenceId: req.idempotencyKey,
        }),
      );
      ledger.updateOrder(id, { status: "ACCEPTED", growwOrderId: ack.growwOrderId, orderStatus: ack.orderStatus, reason: ack.remark, response: ack.raw });
      logger.info("order accepted by groww", {
        idempotencyKey: req.idempotencyKey,
        growwOrderId: ack.growwOrderId,
        orderStatus: ack.orderStatus,
        symbol: req.tradingSymbol,
        side: req.side,
        qty: req.qty,
      });
      const body: Record<string, unknown> = { status: "ACCEPTED", growwOrderId: ack.growwOrderId, orderStatus: ack.orderStatus };
      if (ack.remark) body.reason = ack.remark;
      return { httpStatus: 200, body };
    } catch (e) {
      return this.afterCreateError(id, req.idempotencyKey, req.segment, e);
    }
  }

  private async afterCreateError(rowId: number, ref: string, segment: Segment, e: unknown): Promise<ServiceResult> {
    const { ledger, logger } = this.d;
    const msg = message(e);
    if (isGrowwError(e) && e.kind === "token") {
      ledger.updateOrder(rowId, { status: "REJECTED", sent: false, reason: msg });
      return { httpStatus: 422, body: { status: "REJECTED", reason: msg, violations: [msg], rejectedBy: "RELAY" } };
    }
    if (isGrowwError(e) && !e.ambiguous && e.kind !== "duplicate_ref") {
      ledger.updateOrder(rowId, { status: "BROKER_REJECTED", reason: msg, response: { kind: e.kind, code: e.code ?? null, httpStatus: e.httpStatus ?? null } });
      logger.warn("order rejected by groww", { idempotencyKey: ref, err: errorFields(e) });
      const body: Record<string, unknown> = { status: "REJECTED", reason: msg, rejectedBy: "BROKER" };
      if (e.code) body.growwCode = e.code;
      return { httpStatus: 422, body };
    }

    // Timeout, 5xx, transport error, unreadable reply, or GA007 (reference already used):
    // Groww may hold the order. Look it up by order_reference_id; never resend.
    logger.warn("order outcome ambiguous; looking it up by reference", { idempotencyKey: ref, err: errorFields(e) });
    const found = await this.lookupByRef(ref, segment, REF_LOOKUP_DELAYS_MS);
    if (found) {
      const reason = `recovered by order_reference_id lookup after: ${msg}`;
      ledger.updateOrder(rowId, { status: "ACCEPTED", growwOrderId: found.growwOrderId, orderStatus: found.orderStatus, reason, response: found.raw });
      const status = isGrowwError(e) && e.kind === "duplicate_ref" ? "DUPLICATE" : "ACCEPTED";
      return { httpStatus: 200, body: { status, growwOrderId: found.growwOrderId, orderStatus: found.orderStatus, reason } };
    }
    ledger.updateOrder(rowId, { status: "UNKNOWN", reason: `outcome unknown after: ${msg}; not found by order_reference_id` });
    logger.error("order outcome unknown; not resent", { idempotencyKey: ref });
    return {
      httpStatus: 502,
      body: {
        error: `order outcome unknown (${msg}); no order found by order_reference_id ${ref} yet. It was NOT resent: reconcile with GET /v1/orders/ref/${ref}`,
        code: "ORDER_OUTCOME_UNKNOWN",
        idempotencyKey: ref,
      },
    };
  }

  private async lookupByRef(ref: string, segment: Segment, delays: number[]): Promise<OrderState | null> {
    for (const delay of delays) {
      if (delay > 0) await this.d.sleep(delay);
      try {
        const s = await this.d.groww.getOrderStatusByRef(ref, segment);
        if (s) return s;
      } catch (e) {
        this.d.logger.warn("order lookup by reference failed", { ref, err: errorFields(e) });
      }
    }
    return null;
  }

  private async duplicate(existing: OrderRow, req: OrderRequest): Promise<ServiceResult> {
    const { ledger, logger } = this.d;
    const orig = (existing.request ?? {}) as Partial<OrderRequest>;
    const mismatch =
      orig.tradingSymbol !== req.tradingSymbol || orig.side !== req.side || orig.qty !== req.qty || orig.orderType !== req.orderType || (orig.price ?? null) !== req.price;
    if (mismatch) logger.warn("idempotencyKey reused with different order parameters", { idempotencyKey: req.idempotencyKey });

    let row = existing;
    if (row.status === "UNKNOWN") {
      const found = await this.lookupByRef(req.idempotencyKey, req.segment, [0]);
      if (found) {
        ledger.updateOrder(row.id, { status: "ACCEPTED", growwOrderId: found.growwOrderId, orderStatus: found.orderStatus, response: found.raw, reason: "recovered by order_reference_id lookup" });
        row = ledger.getOrder(row.id) ?? row;
      }
    }
    ledger.event("order_duplicate", { idempotencyKey: req.idempotencyKey, orderId: row.id, originalStatus: row.status, mismatch });

    const body: Record<string, unknown> = { status: "DUPLICATE", originalStatus: row.status };
    if (row.growwOrderId) body.growwOrderId = row.growwOrderId;
    if (row.orderStatus) body.orderStatus = row.orderStatus;
    const reasons: string[] = [];
    if (row.status === "BROKER_REJECTED") reasons.push(`original order was rejected by Groww: ${row.reason ?? "unknown reason"}`);
    if (row.status === "UNKNOWN" || row.status === "PENDING") {
      body.orderStatus = row.orderStatus ?? "UNKNOWN";
      reasons.push("original outcome unknown (no Groww answer, not found by reference); it was not resent");
    }
    if (mismatch) reasons.push("idempotencyKey was reused with different order parameters");
    if (reasons.length > 0) body.reason = reasons.join("; ");
    return { httpStatus: 200, body };
  }

  // ---- broker-backed checks -----------------------------------------------------------------

  /** Every FNO order of the day, de-duplicated across pages. */
  private async listAllOrders(segment: Segment): Promise<OrderListItem[]> {
    const out: OrderListItem[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      const batch = await this.d.groww.listOrders(segment, page, LIST_PAGE_SIZE);
      let added = 0;
      for (const o of batch) {
        const key = o.growwOrderId ?? `${page}:${added}:${o.tradingSymbol ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(o);
        added++;
      }
      if (batch.length < LIST_PAGE_SIZE || added === 0) return out;
    }
    throw new Error(`order list did not end after ${LIST_MAX_PAGES} pages`);
  }

  /** Long quantity in the symbol (same product) and quantity already pending in open SELL orders. */
  private async sellExposure(tradingSymbol: string, exchange: string, product: string): Promise<Exposure> {
    const positions = await this.d.groww.getPositions("FNO");
    const rows = positions.filter((p) => p.tradingSymbol === tradingSymbol && (p.exchange === null || p.exchange === exchange));
    const sameProduct = rows.some((p) => p.product !== null) ? rows.filter((p) => p.product === product) : rows;
    const longQty = sameProduct.reduce((sum, p) => sum + p.qty, 0);
    const orders = await this.listAllOrders("FNO");
    const pendingSellQty = orders
      .filter(
        (o) =>
          o.tradingSymbol === tradingSymbol &&
          o.transactionType === "SELL" &&
          isOpenOrderStatus(o.orderStatus) &&
          (o.product === null || o.product === product),
      )
      .reduce((sum, o) => sum + pendingQty(o), 0);
    return { longQty, pendingSellQty };
  }

  private async ltp(exchange: string, tradingSymbol: string): Promise<number> {
    const key = `${exchange}_${tradingSymbol}`;
    const ltp = (await this.d.groww.getLtp("FNO", [key]))[key];
    if (ltp === undefined || !(ltp > 0)) throw new Error(`no LTP returned for ${key}`);
    return ltp;
  }

  // ---- cancel / modify ----------------------------------------------------------------------

  async cancel(growwOrderId: string, body: unknown): Promise<ServiceResult> {
    if (!isValidGrowwOrderId(growwOrderId)) return { httpStatus: 400, body: { error: "invalid groww order id", code: "BAD_REQUEST" } };
    const segment = parseSegment((body as Record<string, unknown> | null)?.segment, null);
    if (segment === null) return { httpStatus: 400, body: { error: 'segment must be "FNO" or "CASH"', code: "BAD_REQUEST" } };
    if (!this.d.config.live) return { httpStatus: 422, body: { error: NOT_LIVE_REASON, code: "RELAY_NOT_LIVE" } };
    return this.serialize(async () => {
      const { groww, ledger, logger } = this.d;
      try {
        await groww.ensureToken();
        const ack = await this.mutate(() => groww.cancelOrder(growwOrderId, segment));
        const row = ledger.findOrderByGrowwId(growwOrderId);
        if (row && ack.orderStatus) ledger.updateOrder(row.id, { orderStatus: ack.orderStatus });
        ledger.event("order_cancel", { growwOrderId, segment, orderStatus: ack.orderStatus });
        logger.info("order cancel requested", { growwOrderId, orderStatus: ack.orderStatus });
        return { httpStatus: 200, body: { orderStatus: ack.orderStatus } };
      } catch (e) {
        ledger.event("order_cancel_failed", { growwOrderId, segment, error: message(e) });
        return growwErrorResult(e);
      }
    });
  }

  async modify(growwOrderId: string, raw: unknown): Promise<ServiceResult> {
    const bad = (error: string): ServiceResult => ({ httpStatus: 400, body: { error, code: "BAD_REQUEST" } });
    if (!isValidGrowwOrderId(growwOrderId)) return bad("invalid groww order id");
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return bad("body must be a JSON object");
    const b = raw as Record<string, unknown>;
    const segment = parseSegment(b.segment, null);
    if (segment === null) return bad('segment must be "FNO" or "CASH"');
    if (b.qty !== undefined && !(typeof b.qty === "number" && Number.isInteger(b.qty) && b.qty > 0)) return bad("qty must be a positive integer");
    if (b.price !== undefined && !(typeof b.price === "number" && Number.isFinite(b.price) && b.price > 0)) return bad("price must be a positive number");
    if (b.orderType !== undefined && b.orderType !== "MARKET" && b.orderType !== "LIMIT") return bad('orderType must be "MARKET" or "LIMIT"');
    if (b.premiumEstimate !== undefined && !(typeof b.premiumEstimate === "number" && Number.isFinite(b.premiumEstimate) && b.premiumEstimate > 0)) {
      return bad("premiumEstimate must be a positive number");
    }
    if (b.qty === undefined && b.price === undefined && b.orderType === undefined) return bad("nothing to modify (qty, price or orderType)");
    if (b.orderType === "MARKET" && b.price !== undefined) return bad("price must be omitted when modifying to MARKET");
    if (!this.d.config.live) return { httpStatus: 422, body: { error: NOT_LIVE_REASON, code: "RELAY_NOT_LIVE" } };

    return this.serialize(async () => {
      const { config, groww, ledger, clock, logger } = this.d;
      const row = ledger.findOrderByGrowwId(growwOrderId);
      if (!row) return { httpStatus: 422, body: { error: "order was not placed through this relay; modify refused", code: "UNKNOWN_ORDER" } };
      if (row.segment !== segment) return bad(`segment ${segment} does not match the order's segment ${row.segment}`);
      const orderType: "MARKET" | "LIMIT" = (b.orderType as "MARKET" | "LIMIT" | undefined) ?? (row.orderType === "MARKET" ? "MARKET" : "LIMIT");
      const price = orderType === "MARKET" ? null : ((b.price as number | undefined) ?? row.price);
      if (orderType === "LIMIT" && price === null) return bad("price is required when modifying to LIMIT");
      const qty = (b.qty as number | undefined) ?? row.qty;
      const premiumEstimate = (b.premiumEstimate as number | undefined) ?? null;

      const now = clock.now();
      const today = istDate(now);
      const day = { now, ordersToday: ledger.countSentOrders(today), buyPremiumToday: ledger.buyPremium(today) };
      let marketLtp: number | null = null;
      const problems: string[] = [];
      if (row.side === "BUY" && orderType === "MARKET" && premiumEstimate !== null) {
        try {
          marketLtp = await this.ltp(row.exchange, row.tradingSymbol);
        } catch (e) {
          problems.push(`cannot bound the MARKET BUY premium (LTP unavailable): ${message(e)}`);
        }
      }
      const caps = checkModifyCaps(row, { qty, orderType, price, premiumEstimate }, config, day, marketLtp);
      const violations = [...caps.violations, ...problems];
      if (violations.length > 0) {
        ledger.event("order_modify_rejected", { growwOrderId, orderId: row.id, violations });
        logger.warn("modify rejected by relay caps", { growwOrderId, violations });
        return { httpStatus: 422, body: { error: violations[0], code: "CAP_REJECTED", violations } };
      }
      try {
        await groww.ensureToken();
        const ack = await this.mutate(() => groww.modifyOrder({ growwOrderId, segment, quantity: qty, price, orderType }));
        ledger.updateOrder(row.id, { qty, price, orderType, premiumInr: caps.premiumInr, orderStatus: ack.orderStatus ?? row.orderStatus });
        ledger.event("order_modify", { growwOrderId, orderId: row.id, qty, price, orderType, orderStatus: ack.orderStatus });
        logger.info("order modify requested", { growwOrderId, qty, price, orderType, orderStatus: ack.orderStatus });
        return { httpStatus: 200, body: { orderStatus: ack.orderStatus } };
      } catch (e) {
        if (isGrowwError(e) && e.ambiguous && row.side === "BUY" && caps.premiumInr !== null) {
          // The modify may have gone through: count the larger premium against the daily cap.
          ledger.updateOrder(row.id, { premiumInr: Math.max(row.premiumInr ?? 0, caps.premiumInr) });
        }
        ledger.event("order_modify_failed", { growwOrderId, orderId: row.id, error: message(e) });
        return growwErrorResult(e);
      }
    });
  }

  // ---- panic --------------------------------------------------------------------------------

  async panic(raw: unknown): Promise<ServiceResult> {
    const r = (raw as Record<string, unknown> | null)?.reason;
    const reason = typeof r === "string" && r.trim() !== "" ? r.trim().slice(0, 500) : "unspecified";
    if (!this.d.config.live) return { httpStatus: 422, body: { error: NOT_LIVE_REASON, code: "RELAY_NOT_LIVE" } };
    return this.serialize(() => this.runPanic(reason));
  }

  private async runPanic(reason: string): Promise<ServiceResult> {
    const { groww, ledger, clock, logger, sleep } = this.d;
    const started = clock.now();
    const errors: string[] = [];
    ledger.event("panic_start", { reason });
    logger.warn("PANIC: cancelling open FNO orders and squaring off long positions", { reason });

    try {
      await groww.ensureToken();
    } catch (e) {
      ledger.event("panic_failed", { reason, error: message(e) });
      return { httpStatus: 503, body: { error: `panic could not start: ${message(e)}`, code: "GROWW_TOKEN_UNAVAILABLE", cancelled: 0, exitOrders: [] } };
    }

    // 1. Cancel every open order. Without the order list we cannot know which SELLs are
    //    pending, so squaring off could create shorts: stop and report instead.
    let orders: OrderListItem[] | null = null;
    for (let attempt = 0; attempt < 3 && orders === null; attempt++) {
      try {
        orders = await this.listAllOrders("FNO");
      } catch (e) {
        errors.push(`list orders (attempt ${attempt + 1}): ${message(e)}`);
        await sleep(500);
      }
    }
    if (orders === null) {
      ledger.event("panic_failed", { reason, errors });
      return {
        httpStatus: 502,
        body: { error: "panic could not read the order list; nothing was cancelled or sold. Flatten manually in the Groww app.", code: "PANIC_INCOMPLETE", cancelled: 0, exitOrders: [], errors },
      };
    }
    const open = orders.filter((o) => o.growwOrderId !== null && isOpenOrderStatus(o.orderStatus));
    let cancelled = 0;
    for (const o of open) {
      try {
        await this.mutate(() => groww.cancelOrder(o.growwOrderId as string, "FNO"));
        cancelled++;
      } catch (e) {
        errors.push(`cancel ${o.growwOrderId}: ${message(e)}`);
      }
    }

    // 2. Let cancellations settle, then see what can still fill.
    let stillOpen = open;
    if (open.length > 0) {
      for (const delay of PANIC_SETTLE_DELAYS_MS) {
        await sleep(delay);
        try {
          stillOpen = (await this.listAllOrders("FNO")).filter((o) => isOpenOrderStatus(o.orderStatus));
          if (stillOpen.length === 0) break;
        } catch (e) {
          errors.push(`re-list orders: ${message(e)}`);
        }
      }
    }

    // 3. Square off longs with MARKET SELLs sized to (long - still-pending SELLs): never a short.
    let positions;
    try {
      positions = await groww.getPositions("FNO");
    } catch (e) {
      errors.push(`positions: ${message(e)}`);
      ledger.event("panic_failed", { reason, cancelled, errors });
      return {
        httpStatus: 502,
        body: { error: "panic cancelled open orders but could not read positions; square off manually", code: "PANIC_INCOMPLETE", cancelled, exitOrders: [], errors },
      };
    }

    const exitOrders: Record<string, unknown>[] = [];
    const shortsLeft: Record<string, unknown>[] = [];
    let seq = 0;
    for (const p of positions) {
      const product = p.product ?? "MIS";
      const exchange: "NSE" | "BSE" = p.exchange === "NSE" || p.exchange === "BSE" ? p.exchange : inferExchange(p.tradingSymbol);
      if (p.qty < 0) {
        shortsLeft.push({ tradingSymbol: p.tradingSymbol, exchange, product, qty: p.qty });
        continue;
      }
      if (p.qty === 0) continue;
      const pending = stillOpen
        .filter(
          (o) =>
            o.tradingSymbol === p.tradingSymbol &&
            o.transactionType === "SELL" &&
            (o.product === null || p.product === null || o.product === p.product),
        )
        .reduce((sum, o) => sum + pendingQty(o), 0);
      const qty = p.qty - pending;
      if (!(qty > 0)) {
        const why = Number.isFinite(pending)
          ? `open SELL orders (${pending}) still cover the long of ${p.qty}`
          : "an open SELL order has an unknown remaining quantity; not sold to avoid creating a short";
        exitOrders.push({ tradingSymbol: p.tradingSymbol, exchange, product, qty: 0, status: "SKIPPED", reason: why });
        continue;
      }
      const ref = `PANIC-${started.toString(36).toUpperCase()}-${seq++}`;
      const id = ledger.insertOrder({
        idempotencyKey: ref,
        source: "PANIC",
        istDate: istDate(started),
        underlying: inferUnderlying(p.tradingSymbol),
        tradingSymbol: p.tradingSymbol,
        exchange,
        segment: "FNO",
        side: "SELL",
        qty,
        lotSize: null,
        orderType: "MARKET",
        price: null,
        product,
        validity: "DAY",
        premiumInr: null,
        isExit: true,
        sent: true,
        status: "PENDING",
        reason: `panic: ${reason}`,
        violations: [],
        growwOrderId: null,
        orderStatus: null,
        request: { panic: true, reason, position: p.raw },
        response: null,
      });
      const item: Record<string, unknown> = { tradingSymbol: p.tradingSymbol, exchange, product, qty, idempotencyKey: ref };
      try {
        const ack = await this.mutate(() =>
          groww.createOrder({
            tradingSymbol: p.tradingSymbol,
            quantity: qty,
            price: null,
            validity: "DAY",
            exchange,
            segment: "FNO",
            product,
            orderType: "MARKET",
            transactionType: "SELL",
            orderReferenceId: ref,
          }),
        );
        ledger.updateOrder(id, { status: "ACCEPTED", growwOrderId: ack.growwOrderId, orderStatus: ack.orderStatus, response: ack.raw });
        exitOrders.push({ ...item, status: "ACCEPTED", growwOrderId: ack.growwOrderId, orderStatus: ack.orderStatus });
      } catch (e) {
        const msg = message(e);
        if (isGrowwError(e) && !e.ambiguous && e.kind !== "duplicate_ref") {
          ledger.updateOrder(id, { status: e.kind === "token" ? "REJECTED" : "BROKER_REJECTED", sent: e.kind !== "token", reason: msg });
          exitOrders.push({ ...item, status: "REJECTED", reason: msg });
          errors.push(`exit ${p.tradingSymbol}: ${msg}`);
          continue;
        }
        const found = await this.lookupByRef(ref, "FNO", [1_000]);
        if (found) {
          ledger.updateOrder(id, { status: "ACCEPTED", growwOrderId: found.growwOrderId, orderStatus: found.orderStatus, response: found.raw });
          exitOrders.push({ ...item, status: "ACCEPTED", growwOrderId: found.growwOrderId, orderStatus: found.orderStatus, reason: `recovered by reference after: ${msg}` });
        } else {
          ledger.updateOrder(id, { status: "UNKNOWN", reason: `outcome unknown after: ${msg}` });
          exitOrders.push({ ...item, status: "UNKNOWN", reason: `outcome unknown after: ${msg}; not resent` });
          errors.push(`exit ${p.tradingSymbol}: outcome unknown`);
        }
      }
    }

    const result: Record<string, unknown> = { cancelled, exitOrders };
    if (stillOpen.length > 0) result.openOrdersRemaining = stillOpen.map((o) => ({ growwOrderId: o.growwOrderId, tradingSymbol: o.tradingSymbol, orderStatus: o.orderStatus }));
    if (shortsLeft.length > 0) result.shortsLeft = shortsLeft;
    if (errors.length > 0) result.errors = errors;
    ledger.event("panic_done", { reason, ...result, ms: clock.now() - started });
    logger.warn("PANIC finished", { reason, cancelled, exits: exitOrders.length, errors: errors.length });
    return { httpStatus: 200, body: result };
  }
}
