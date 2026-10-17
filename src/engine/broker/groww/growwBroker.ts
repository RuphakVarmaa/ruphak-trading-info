/**
 * LIVE broker: orders go to Groww through the static-IP relay (SEBI requires a whitelisted IP for
 * API orders). Order state is always read back by order_reference_id (the engine's refId), so a
 * timeout never causes a blind re-send. Fills come from the trades endpoint, de-duplicated by
 * trade id and capped by the cumulative filled quantity, with a fallback to the average-price delta.
 * Charges are the engine's own estimate (contract notes remain the source of truth).
 */
import type { Clock } from "../../clock";
import { istDate } from "../../clock";
import type { Broker, BrokerPosition, IdGenerator, Logger, OrderResult, Repository } from "../../ports";
import { TERMINAL_ORDER_STATUSES, type Fill, type Order, type OrderRequest } from "../../types";
import { computeCharges } from "../charges";
import { parseGrowwTime } from "./data";
import type { RelayClient, RelayOrderRequest, RelayOrderStatus } from "./relayClient";

/** The relay calls the live broker needs (a structural subset of RelayClient, easy to fake). */
export type OrderRelay = Pick<RelayClient, "createOrder" | "statusByRef" | "trades" | "cancel" | "positions" | "health">;
import { mapGrowwStatus } from "./status";

export interface GrowwBrokerOptions {
  relay: OrderRelay;
  repo: Repository;
  clock: Clock;
  newId: IdGenerator;
  logger: Logger;
  /** Waits between status polls right after placing (default 1 s, 1 s, 1.5 s). */
  postCreatePollsMs?: number[];
  /** An order the broker never acknowledged and cannot find by reference is given up after this. */
  unknownGiveUpMs?: number;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export function toRelayOrder(req: OrderRequest): RelayOrderRequest {
  const limit = req.type === "LIMIT";
  return {
    idempotencyKey: req.refId,
    underlying: req.contract.index,
    tradingSymbol: req.contract.tradingSymbol,
    exchange: req.contract.exchange,
    segment: "FNO",
    side: req.side,
    qty: req.qty,
    lotSize: req.contract.lotSize,
    orderType: limit ? "LIMIT" : "MARKET",
    price: limit ? (req.limitPrice ?? null) : null,
    product: req.product,
    validity: "DAY",
    premiumEstimate: req.limitPrice ?? null,
  };
}

export class GrowwBroker implements Broker {
  readonly mode = "LIVE" as const;

  constructor(private readonly o: GrowwBrokerOptions) {}

  private isTerminal(o: Order): boolean {
    return TERMINAL_ORDER_STATUSES.includes(o.status);
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const now = this.o.clock.now();
    let order: Order = { ...req, id: this.o.newId(), status: "NEW", filledQty: 0, createdMs: now, updatedMs: now, mode: "LIVE" };
    if (req.qty <= 0 || req.qty % req.contract.lotSize !== 0) {
      return { order: { ...order, status: "REJECTED", error: "quantity must be a positive multiple of the lot size" }, fills: [] };
    }
    if (req.type !== "LIMIT" && req.type !== "MARKET") {
      return { order: { ...order, status: "REJECTED", error: `order type ${req.type} is not supported` }, fills: [] };
    }
    if (req.type === "LIMIT" && !(req.limitPrice && req.limitPrice > 0)) {
      return { order: { ...order, status: "REJECTED", error: "LIMIT order without a price" }, fills: [] };
    }

    const res = await this.o.relay.createOrder(toRelayOrder(req));
    const t = this.o.clock.now();
    if (res.kind === "rejected") {
      this.o.logger.warn("live order rejected", { refId: req.refId, by: res.by, reason: res.reason });
      return { order: { ...order, status: "REJECTED", error: `${res.by}: ${res.reason}`.slice(0, 300), updatedMs: t }, fills: [] };
    }
    if (res.kind === "unknown") {
      this.o.logger.error("live order outcome unknown; will reconcile by reference", { refId: req.refId, reason: res.reason });
      order = { ...order, status: "UNKNOWN", error: res.reason.slice(0, 300), updatedMs: t };
    } else {
      order = {
        ...order,
        brokerOrderId: res.growwOrderId ?? undefined,
        brokerStatus: res.orderStatus ?? undefined,
        status: mapGrowwStatus(res.orderStatus, 0, req.qty) === "UNKNOWN" ? "OPEN" : mapGrowwStatus(res.orderStatus, 0, req.qty),
        updatedMs: t,
      };
    }

    const fills: Fill[] = [];
    for (const wait of this.o.postCreatePollsMs ?? [1_000, 1_000, 1_500]) {
      if (this.isTerminal(order)) break;
      await this.o.clock.sleep(wait);
      const r = await this.sync(order, fills);
      order = r.order;
      fills.push(...r.fills);
    }
    return { order, fills };
  }

  refreshOrder(order: Order): Promise<OrderResult> {
    if (this.isTerminal(order)) return Promise.resolve({ order, fills: [] });
    return this.sync(order, []);
  }

  async cancelOrder(order: Order): Promise<OrderResult> {
    if (this.isTerminal(order)) return { order, fills: [] };
    let current = order;
    const fills: Fill[] = [];
    if (!current.brokerOrderId) {
      const r = await this.sync(current, fills);
      current = r.order;
      fills.push(...r.fills);
      if (this.isTerminal(current) || !current.brokerOrderId) return { order: current, fills };
    }
    try {
      await this.o.relay.cancel(current.brokerOrderId!);
    } catch (err) {
      // Usually "already executed/cancelled": the status read below settles it.
      this.o.logger.warn("cancel failed", { refId: current.refId, error: err instanceof Error ? err.message : String(err) });
    }
    const r = await this.sync(current, fills);
    return { order: r.order, fills: [...fills, ...r.fills] };
  }

  async positions(): Promise<BrokerPosition[]> {
    return this.o.relay.positions("FNO");
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    const h = await this.o.relay.health();
    return { ok: h.reachable && h.ok && h.live && h.growwReachable, detail: h.detail };
  }

  /** Reads the order by reference and turns newly filled quantity into Fill records. */
  private async sync(order: Order, pending: Fill[]): Promise<OrderResult> {
    const now = this.o.clock.now();
    let st: RelayOrderStatus | null;
    try {
      st = await this.o.relay.statusByRef(order.refId);
    } catch (err) {
      return { order: { ...order, updatedMs: now, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) }, fills: [] };
    }
    if (!st) {
      if (!order.brokerOrderId && now - order.createdMs > (this.o.unknownGiveUpMs ?? 120_000)) {
        return { order: { ...order, status: "REJECTED", error: "never acknowledged and not found by reference", updatedMs: now }, fills: [] };
      }
      return { order: { ...order, updatedMs: now }, fills: [] };
    }
    // order.filledQty already includes fills returned earlier in this call; `pending` only de-dupes trade ids.
    const already = order.filledQty;
    const target = Math.min(order.qty, Math.max(already, st.filledQty));
    const fills = target > already ? await this.newFills(order, st, already, target, pending) : [];
    const filledQty = already + fills.reduce((s, f) => s + f.qty, 0);
    const value = (order.avgFillPrice ?? 0) * order.filledQty + fills.reduce((s, f) => s + f.qty * f.price, 0);
    let status = mapGrowwStatus(st.orderStatus, filledQty, order.qty);
    if (status === "UNKNOWN") status = order.status === "NEW" || order.status === "UNKNOWN" ? "OPEN" : order.status;
    const updated: Order = {
      ...order,
      brokerOrderId: st.growwOrderId ?? order.brokerOrderId,
      brokerStatus: st.orderStatus ?? order.brokerStatus,
      status,
      filledQty,
      updatedMs: now,
    };
    if (filledQty > 0) updated.avgFillPrice = round2(value / filledQty);
    if (status === "REJECTED") updated.error = (st.remark ?? "rejected by exchange").slice(0, 300);
    else if (order.status === "UNKNOWN") delete updated.error;
    return { order: updated, fills };
  }

  private async newFills(order: Order, st: RelayOrderStatus, already: number, target: number, pending: Fill[]): Promise<Fill[]> {
    const known = new Set([...(await this.o.repo.fills.forOrder(order.id)), ...pending].map((f) => f.brokerTradeId).filter(Boolean));
    const out: Fill[] = [];
    let recorded = already;
    const mk = (qty: number, price: number, t: number, tradeId: string): Fill => ({
      id: this.o.newId(),
      orderId: order.id,
      t,
      qty,
      price: round2(price),
      charges: computeCharges(order.side, price, qty, order.contract.exchange, istDate(t)),
      slippageTicks: 0,
      brokerTradeId: tradeId,
    });
    if (st.growwOrderId) {
      try {
        const trades = await this.o.relay.trades(st.growwOrderId);
        const sorted = trades
          .filter((x) => x.tradeId && !known.has(x.tradeId) && (x.qty ?? 0) > 0 && (x.price ?? 0) > 0)
          .sort((a, b) => (parseGrowwTime(a.time) ?? 0) - (parseGrowwTime(b.time) ?? 0));
        for (const x of sorted) {
          if (recorded >= target) break;
          const qty = Math.min(x.qty!, target - recorded);
          out.push(mk(qty, x.price!, parseGrowwTime(x.time) ?? this.o.clock.now(), x.tradeId!));
          recorded += qty;
        }
      } catch (err) {
        this.o.logger.warn("trades lookup failed; using average price", { refId: order.refId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (recorded < target) {
      // Remainder from the cumulative average: avg_new * filled_new - value already recorded.
      const qty = target - recorded;
      const recordedValue = (order.avgFillPrice ?? 0) * order.filledQty + out.reduce((s, f) => s + f.qty * f.price, 0);
      const px = st.avgFillPrice !== null && st.avgFillPrice > 0 ? (st.avgFillPrice * target - recordedValue) / qty : (order.limitPrice ?? 0);
      const price = px > 0 ? px : (st.avgFillPrice ?? order.limitPrice ?? 0);
      if (price > 0) out.push(mk(qty, price, this.o.clock.now(), `agg-${order.refId}-${target}`));
    }
    return out;
  }
}
