/** Latest spot and VIX per index, written by the trading cycle and read by quote consumers. */
import type { IndexId } from "../types";

export interface IndexContext {
  spot: number;
  vix: number;
  t: number;
}

export class MarketContextStore {
  private readonly m = new Map<IndexId, IndexContext>();
  set(index: IndexId, ctx: IndexContext): void {
    this.m.set(index, ctx);
  }
  get(index: IndexId): IndexContext | null {
    return this.m.get(index) ?? null;
  }
  /** Updates spot only (e.g. from a fresh broker LTP between full cycles). */
  updateSpot(index: IndexId, spot: number, t: number): void {
    const cur = this.m.get(index);
    if (cur) this.m.set(index, { ...cur, spot, t });
  }
}
