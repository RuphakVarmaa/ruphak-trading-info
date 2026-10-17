// Order request schema and the relay's own hard caps. Pure functions: the order service
// supplies the day's counters, the Groww position exposure and the LTP it fetched.
import { UNDERLYING_EXCHANGE, type Product, type RelayConfig, type Underlying } from "./config.js";
import { describeIst, formatHhMm, istParts } from "./ist.js";

export interface OrderRequest {
  idempotencyKey: string;
  underlying: Underlying;
  tradingSymbol: string;
  exchange: "NSE" | "BSE";
  segment: "FNO";
  side: "BUY" | "SELL";
  qty: number;
  lotSize: number;
  orderType: "MARKET" | "LIMIT";
  /** Limit price per unit in rupees; null for MARKET. */
  price: number | null;
  product: Product;
  validity: "DAY";
  /** Engine's per-unit premium estimate, required for MARKET BUY. */
  premiumEstimate: number | null;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Groww order_reference_id rule: 8-20 characters, alphanumerics plus at most two hyphens. */
export function isValidReferenceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{8,20}$/.test(value) && (value.match(/-/g)?.length ?? 0) <= 2;
}

const SYMBOL_RE = /^[A-Z0-9][A-Z0-9-]{2,39}$/;
const MAX_PRICE = 1_000_000;

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function positiveInt(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max;
}

function positivePrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_PRICE;
}

export function parseOrderRequest(body: unknown): ParseResult<OrderRequest> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const fail = (error: string): ParseResult<OrderRequest> => ({ ok: false, error });

  if (!isValidReferenceId(b.idempotencyKey)) return fail("idempotencyKey must be 8-20 alphanumerics with at most two hyphens");
  if (!oneOf(b.underlying, ["NIFTY", "SENSEX"] as const)) return fail('underlying must be "NIFTY" or "SENSEX"');
  if (typeof b.tradingSymbol !== "string" || !SYMBOL_RE.test(b.tradingSymbol)) return fail("tradingSymbol must be an upper-case Groww trading symbol");
  if (!oneOf(b.exchange, ["NSE", "BSE"] as const)) return fail('exchange must be "NSE" or "BSE"');
  if (b.segment !== "FNO") return fail('segment must be "FNO"');
  if (!oneOf(b.side, ["BUY", "SELL"] as const)) return fail('side must be "BUY" or "SELL"');
  if (!positiveInt(b.qty, 1_000_000)) return fail("qty must be a positive integer");
  if (!positiveInt(b.lotSize, 100_000)) return fail("lotSize must be a positive integer");
  if (!oneOf(b.orderType, ["MARKET", "LIMIT"] as const)) return fail('orderType must be "MARKET" or "LIMIT"');
  let price: number | null = null;
  if (b.orderType === "LIMIT") {
    if (!positivePrice(b.price)) return fail("price must be a positive number for LIMIT orders");
    price = b.price;
  } else if (b.price !== undefined && b.price !== null && b.price !== 0) {
    return fail("price must be omitted (or 0) for MARKET orders");
  }
  if (!oneOf(b.product, ["MIS", "NRML"] as const)) return fail('product must be "MIS" or "NRML"');
  if (b.validity !== "DAY") return fail('validity must be "DAY"');
  let premiumEstimate: number | null = null;
  if (b.premiumEstimate !== undefined && b.premiumEstimate !== null) {
    if (!positivePrice(b.premiumEstimate)) return fail("premiumEstimate must be a positive number");
    premiumEstimate = b.premiumEstimate;
  }
  return {
    ok: true,
    value: {
      idempotencyKey: b.idempotencyKey,
      underlying: b.underlying,
      tradingSymbol: b.tradingSymbol,
      exchange: b.exchange,
      segment: "FNO",
      side: b.side,
      qty: b.qty,
      lotSize: b.lotSize,
      orderType: b.orderType,
      price,
      product: b.product,
      validity: "DAY",
      premiumEstimate,
    },
  };
}

// ---- caps ----------------------------------------------------------------------------

export const NOT_LIVE_REASON = "relay not live";
/** Safety margin applied to the LTP when bounding a MARKET BUY's premium. */
export const MARKET_BUY_LTP_BUFFER = 1.01;

export interface DayState {
  now: number;
  /** Orders sent to Groww today (IST), every outcome included. */
  ordersToday: number;
  /** BUY premium committed today (IST). */
  buyPremiumToday: number;
}

/** Long quantity of the symbol (same product) and quantity already pending in open SELL orders. */
export interface Exposure {
  longQty: number;
  pendingSellQty: number;
}

export interface CapResult {
  violations: string[];
  /** BUY premium this order commits (null for SELL). */
  premiumInr: number | null;
  /** SELL that only reduces an existing long. */
  isExit: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function inr(n: number): string {
  return `INR ${round2(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/** The option-symbol pattern for an underlying: the name, a 2-digit year, ..., CE/PE. */
export function symbolMatchesUnderlying(symbol: string, underlying: Underlying): boolean {
  return symbol.startsWith(underlying) && /^\d{2}[A-Z0-9]*(CE|PE)$/.test(symbol.slice(underlying.length));
}

/** Null when `now` is inside the entry (or exit) window on a trading day. */
export function windowViolation(now: number, cfg: RelayConfig, kind: "entry" | "exit"): string | null {
  const p = istParts(now);
  if (p.weekday === 0 || p.weekday === 6) return `outside trading days (Mon-Fri): ${describeIst(now)}`;
  if (cfg.holidays.has(p.date)) return `market holiday ${p.date} (MARKET_HOLIDAYS)`;
  const startMin = cfg.tradingWindow.startMin;
  const endMin = kind === "exit" ? cfg.exitWindowEndMin : cfg.tradingWindow.endMin;
  if (p.secondOfDay < startMin * 60 || p.secondOfDay >= endMin * 60) {
    return `outside the ${kind} window ${formatHhMm(startMin)}-${formatHhMm(endMin)} IST: ${describeIst(now)}`;
  }
  return null;
}

/**
 * Per-unit premium a BUY can cost: the LIMIT price, or for MARKET the larger of the engine's
 * estimate and the relay's own LTP (+1%). Null when it cannot be bounded.
 */
export function boundedUnitPremium(orderType: "MARKET" | "LIMIT", price: number | null, premiumEstimate: number | null, marketLtp: number | null): number | null {
  if (orderType === "LIMIT") return price;
  if (premiumEstimate === null) return null;
  return marketLtp === null ? premiumEstimate : Math.max(premiumEstimate, marketLtp * MARKET_BUY_LTP_BUFFER);
}

export interface CapInputs {
  /** Known in live mode for SELL orders; null in shadow mode (position checks skipped). */
  exposure: Exposure | null;
  /** Relay-fetched LTP for MARKET BUY bounding; null when not fetched. */
  marketLtp: number | null;
}

export function checkOrderCaps(req: OrderRequest, cfg: RelayConfig, day: DayState, inputs: CapInputs): CapResult {
  const v: string[] = [];
  if (!cfg.live) v.push(NOT_LIVE_REASON);

  if (!cfg.allowedUnderlyings.includes(req.underlying)) {
    v.push(`underlying ${req.underlying} is not in ALLOWED_UNDERLYINGS (${cfg.allowedUnderlyings.join(",")})`);
  }
  if (!symbolMatchesUnderlying(req.tradingSymbol, req.underlying)) {
    v.push(`tradingSymbol ${req.tradingSymbol} is not a ${req.underlying} option contract`);
  }
  if (UNDERLYING_EXCHANGE[req.underlying] !== req.exchange) {
    v.push(`${req.underlying} options trade on ${UNDERLYING_EXCHANGE[req.underlying]}, not ${req.exchange}`);
  }
  if (!cfg.productAllowlist.includes(req.product)) {
    v.push(`product ${req.product} is not in PRODUCT_ALLOWLIST (${cfg.productAllowlist.join(",")})`);
  }
  const relayLot = cfg.lotSizes[req.underlying];
  if (relayLot !== undefined && req.lotSize !== relayLot) {
    v.push(`lotSize ${req.lotSize} does not match the relay's LOT_SIZES (${req.underlying}:${relayLot})`);
  }
  if (req.qty % req.lotSize !== 0) {
    v.push(`qty ${req.qty} is not a multiple of lotSize ${req.lotSize}`);
  } else if (req.qty / req.lotSize > cfg.maxLotsPerOrder) {
    v.push(`${req.qty / req.lotSize} lots exceeds MAX_LOTS_PER_ORDER ${cfg.maxLotsPerOrder}`);
  }

  // A SELL is an exit when it fits inside the long that is not already being sold.
  let isExit = req.side === "SELL";
  if (req.side === "SELL" && inputs.exposure !== null) {
    const { longQty, pendingSellQty } = inputs.exposure;
    const sellable = Math.max(0, longQty - pendingSellQty);
    isExit = req.qty <= sellable;
    if (!isExit && !cfg.allowShort) {
      v.push(
        `SELL ${req.qty} exceeds the sellable long of ${sellable} in ${req.tradingSymbol} (long ${longQty}, pending sells ${pendingSellQty}); ALLOW_SHORT=false`,
      );
    }
  }

  if (!isExit && day.ordersToday >= cfg.maxOrdersPerDay) {
    v.push(`MAX_ORDERS_PER_DAY ${cfg.maxOrdersPerDay} reached (${day.ordersToday} orders sent today)`);
  }

  const w = windowViolation(day.now, cfg, isExit ? "exit" : "entry");
  if (w !== null) v.push(w);

  let premiumInr: number | null = null;
  if (req.side === "BUY") {
    const unit = boundedUnitPremium(req.orderType, req.price, req.premiumEstimate, inputs.marketLtp);
    if (unit === null) {
      v.push("MARKET BUY requires premiumEstimate so the premium caps can be enforced");
    } else {
      premiumInr = round2(unit * req.qty);
      if (premiumInr > cfg.maxPremiumPerOrderInr) {
        v.push(`premium ${inr(premiumInr)} exceeds MAX_PREMIUM_PER_ORDER_INR ${inr(cfg.maxPremiumPerOrderInr)}`);
      }
      if (day.buyPremiumToday + premiumInr > cfg.maxDailyPremiumInr) {
        v.push(
          `premium ${inr(premiumInr)} would take today's BUY premium to ${inr(day.buyPremiumToday + premiumInr)}, above MAX_DAILY_PREMIUM_INR ${inr(cfg.maxDailyPremiumInr)}`,
        );
      }
    }
  }

  return { violations: v, premiumInr, isExit };
}

export interface ModifiableOrder {
  side: "BUY" | "SELL";
  qty: number;
  lotSize: number | null;
  premiumInr: number | null;
  isExit: boolean;
}

export interface ModifyTarget {
  qty: number;
  orderType: "MARKET" | "LIMIT";
  price: number | null;
  premiumEstimate: number | null;
}

/** Caps for POST /v1/orders/:id/modify: a modify must not smuggle an order past the caps. */
export function checkModifyCaps(
  order: ModifiableOrder,
  next: ModifyTarget,
  cfg: RelayConfig,
  day: DayState,
  marketLtp: number | null,
): { violations: string[]; premiumInr: number | null } {
  const v: string[] = [];
  if (!cfg.live) v.push(NOT_LIVE_REASON);
  if (order.lotSize !== null) {
    if (next.qty % order.lotSize !== 0) v.push(`qty ${next.qty} is not a multiple of lotSize ${order.lotSize}`);
    else if (next.qty / order.lotSize > cfg.maxLotsPerOrder) v.push(`${next.qty / order.lotSize} lots exceeds MAX_LOTS_PER_ORDER ${cfg.maxLotsPerOrder}`);
  }
  if (order.side === "SELL" && next.qty > order.qty && !cfg.allowShort) {
    v.push(`increasing a SELL order's quantity (${order.qty} -> ${next.qty}) is not allowed; ALLOW_SHORT=false`);
  }
  const w = windowViolation(day.now, cfg, order.side === "SELL" && order.isExit ? "exit" : "entry");
  if (w !== null) v.push(w);

  let premiumInr: number | null = order.premiumInr;
  if (order.side === "BUY") {
    const unit = boundedUnitPremium(next.orderType, next.price, next.premiumEstimate, marketLtp);
    if (unit === null) {
      v.push("modifying a BUY to MARKET requires premiumEstimate so the premium caps can be enforced");
    } else {
      premiumInr = round2(unit * next.qty);
      if (premiumInr > cfg.maxPremiumPerOrderInr) {
        v.push(`premium ${inr(premiumInr)} exceeds MAX_PREMIUM_PER_ORDER_INR ${inr(cfg.maxPremiumPerOrderInr)}`);
      }
      const dayTotal = day.buyPremiumToday - (order.premiumInr ?? 0) + premiumInr;
      if (dayTotal > cfg.maxDailyPremiumInr) {
        v.push(`modified premium would take today's BUY premium to ${inr(dayTotal)}, above MAX_DAILY_PREMIUM_INR ${inr(cfg.maxDailyPremiumInr)}`);
      }
    }
  }
  return { violations: v, premiumInr };
}
