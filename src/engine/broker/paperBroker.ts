/**
 * Paper broker: simulated fills on live (or synthetic) option quotes with the shared fill model
 * and real charges. Used for PAPER mode and, with a replay quote source, for backtests.
 * Persistence is the caller's job: this class only returns orders and fills.
 */
import type { Clock } from "../clock";
import { istDate } from "../clock";
import type { EngineConfig } from "../config";
import type { Broker, BrokerPosition, IdGenerator, OptionQuoteSource, OrderResult, Repository } from "../ports";
import type { Fill, IndexId, Order, OrderRequest, TradingMode } from "../types";
import { computeCharges } from "./charges";
import { limitFill, marketFill, quoteProblem, type FillParams } from "./fillModel";

export interface PaperBrokerOptions {
  cfg: EngineConfig;
  clock: Clock;
  repo: Repository;
  quotes: OptionQuoteSource;
  /** Latest underlying spot and VIX per index (needed by synthetic quotes). */
  marketContext: (index: IndexId) => { spot: number; vix: number } | null;
  newId: IdGenerator;
  mode?: Extract<TradingMode, "PAPER" | "BACKTEST">;
  /** Simulated order latency; defaults to cfg.broker.paperLatencyMs. */
  latencyMs?: number;
}

export class PaperBroker implements Broker {
  readonly mode: TradingMode;
  private readonly fp: FillParams;

  constructor(private readonly o: PaperBrokerOptions) {
    this.mode = o.mode ?? "PAPER";
    this.fp = {
      tickSize: 0.05,
      slippageTicksMarket: o.cfg.broker.slippageTicksMarket,
      depthLevels: o.cfg.broker.partialFillDepthLevels,
      maxQuoteAgeMs: o.cfg.gates.maxDataAgeSec * 1000,
    };
  }

  private async tryFill(order: Order): Promise<OrderResult> {
    const now = this.o.clock.now();
    const ctx = this.o.marketContext(order.contract.index);
    if (!ctx) return { order: { ...order, status: order.status === "NEW" ? "REJECTED" : order.status, error: "no market context", updatedMs: now }, fills: [] };
    const q = await this.o.quotes.quote(order.contract, { t: now, spot: ctx.spot, vix: ctx.vix });
    const fp = { ...this.fp, tickSize: order.contract.tickSize };
    const problem = quoteProblem(q, now, fp);
    if (problem) {
      // A new order without a usable quote is rejected; a resting order just waits.
      if (order.status === "NEW") return { order: { ...order, status: "REJECTED", error: problem, updatedMs: now }, fills: [] };
      return { order: { ...order, updatedMs: now }, fills: [] };
    }
    const remaining = order.qty - order.filledQty;
    const res =
      order.type === "MARKET" ? marketFill(order.side, remaining, q, fp) : limitFill(order.side, remaining, order.limitPrice ?? 0, q, fp);
    if (res.filledQty <= 0) return { order: { ...order, status: "OPEN", updatedMs: now }, fills: [] };
    const fill: Fill = {
      id: this.o.newId(),
      orderId: order.id,
      t: now,
      qty: res.filledQty,
      price: res.avgPrice,
      charges: computeCharges(order.side, res.avgPrice, res.filledQty, order.contract.exchange, istDate(now)),
      slippageTicks: res.slippageTicks,
    };
    const filledQty = order.filledQty + res.filledQty;
    const avg = ((order.avgFillPrice ?? 0) * order.filledQty + res.avgPrice * res.filledQty) / filledQty;
    return {
      order: { ...order, filledQty, avgFillPrice: Math.round(avg * 100) / 100, status: filledQty >= order.qty ? "FILLED" : "PARTIAL", updatedMs: now },
      fills: [fill],
    };
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const created = this.o.clock.now();
    const order: Order = { ...req, id: this.o.newId(), status: "NEW", filledQty: 0, createdMs: created, updatedMs: created, mode: this.mode };
    if (req.qty <= 0 || req.qty % req.contract.lotSize !== 0) {
      return { order: { ...order, status: "REJECTED", error: "quantity must be a positive multiple of the lot size" }, fills: [] };
    }
    const latency = this.o.latencyMs ?? this.o.cfg.broker.paperLatencyMs;
    if (latency > 0) await this.o.clock.sleep(latency);
    return this.tryFill(order);
  }

  async refreshOrder(order: Order): Promise<OrderResult> {
    if (order.status !== "OPEN" && order.status !== "PARTIAL") return { order, fills: [] };
    return this.tryFill(order);
  }

  async cancelOrder(order: Order): Promise<OrderResult> {
    if (order.status === "FILLED" || order.status === "REJECTED" || order.status === "CANCELLED") return { order, fills: [] };
    return { order: { ...order, status: "CANCELLED", updatedMs: this.o.clock.now() }, fills: [] };
  }

  async positions(): Promise<BrokerPosition[]> {
    const open = await this.o.repo.positions.open(this.mode);
    return open.map((p) => ({ tradingSymbol: p.contract.tradingSymbol, exchange: p.contract.exchange, qty: p.qty, avgPrice: p.avgEntry }));
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: `${this.mode.toLowerCase()} broker (${this.o.quotes.kind} quotes)` };
  }
}
