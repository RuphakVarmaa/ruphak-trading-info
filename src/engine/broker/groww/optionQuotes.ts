/** Live option quotes from Groww (/live-data/quote with depth), cached briefly per symbol. */
import type { EngineConfig } from "../../config";
import type { OptionChainRow, OptionQuoteSource } from "../../ports";
import type { IndexId, OptionContract, Quote } from "../../types";
import type { GrowwDataClient } from "./data";

export class GrowwOptionQuotes implements OptionQuoteSource {
  readonly kind = "groww" as const;
  private readonly cache = new Map<string, Quote>();

  constructor(
    private readonly data: GrowwDataClient,
    private readonly cfg: EngineConfig,
    private readonly opts: { cacheMs?: number; now?: () => number } = {},
  ) {}

  async quote(contract: OptionContract): Promise<Quote> {
    const now = (this.opts.now ?? Date.now)();
    const hit = this.cache.get(contract.tradingSymbol);
    if (hit && now - hit.t < (this.opts.cacheMs ?? 1_500)) return hit;
    const q = await this.data.quote(contract.exchange, "FNO", contract.tradingSymbol);
    this.cache.set(contract.tradingSymbol, q);
    return q;
  }

  async chain(index: IndexId, expiry: string): Promise<{ underlyingLtp: number; rows: OptionChainRow[] }> {
    const spec = this.cfg.indexSpecs[index];
    return this.data.optionChain(spec.exchange, spec.underlying, expiry);
  }
}

/**
 * Paper-mode safety net: real quotes when available, otherwise the fallback (synthetic) source,
 * clearly tagged by Quote.source. Never used in LIVE mode.
 */
export class FallbackOptionQuotes implements OptionQuoteSource {
  readonly kind: "groww" | "synthetic";
  constructor(
    private readonly primary: OptionQuoteSource,
    private readonly fallback: OptionQuoteSource,
    private readonly onFallback?: (err: unknown) => void,
  ) {
    this.kind = primary.kind === "groww" ? "groww" : "synthetic";
  }

  async quote(contract: OptionContract, ctx: { t: number; spot: number; vix: number }): Promise<Quote> {
    try {
      return await this.primary.quote(contract, ctx);
    } catch (err) {
      this.onFallback?.(err);
      return this.fallback.quote(contract, ctx);
    }
  }

  async chain(index: IndexId, expiry: string): Promise<{ underlyingLtp: number; rows: OptionChainRow[] }> {
    if (this.primary.chain) return this.primary.chain(index, expiry);
    if (this.fallback.chain) return this.fallback.chain(index, expiry);
    return { underlyingLtp: 0, rows: [] };
  }
}
