/** Live option quotes from Groww (/live-data/quote with depth), cached briefly per symbol. */
import type { EngineConfig } from "../../config";
import type { OptionChainRow, OptionQuoteSource } from "../../ports";
import type { IndexId, OptionContract, Quote } from "../../types";
import type { GrowwDataClient } from "./data";
import { GrowwError, isGrowwError } from "./errors";

export interface GrowwOptionQuotesOptions {
  cacheMs?: number;
  now?: () => number;
  /**
   * Paper only (default 0 = off): after a failure that is not about the symbol itself (timeout, network,
   * 5xx, 429, auth), fail every quote at once for this long, so a slow or rate-limiting Groww costs one
   * timeout per pause instead of one per quote in the trading tick. LIVE never sets it.
   */
  pauseAfterErrorMs?: number;
}

/** Failures that say nothing about Groww as a whole (this symbol or request is wrong). */
const SYMBOL_ERRORS = new Set(["bad_request", "not_found", "duplicate"]);

export class GrowwOptionQuotes implements OptionQuoteSource {
  readonly kind = "groww" as const;
  private readonly cache = new Map<string, Quote>();
  private pausedUntil = -Infinity;
  private pauseReason = "";

  constructor(
    private readonly data: GrowwDataClient,
    private readonly cfg: EngineConfig,
    private readonly opts: GrowwOptionQuotesOptions = {},
  ) {}

  async quote(contract: OptionContract): Promise<Quote> {
    const now = (this.opts.now ?? Date.now)();
    const hit = this.cache.get(contract.tradingSymbol);
    if (hit && now - hit.t < (this.opts.cacheMs ?? 1_500)) return hit;
    if (now < this.pausedUntil) {
      throw new GrowwError(`Groww quotes paused for ${Math.ceil((this.pausedUntil - now) / 1000)} s after: ${this.pauseReason}`, "transient", 0);
    }
    try {
      const q = await this.data.quote(contract.exchange, "FNO", contract.tradingSymbol);
      this.cache.set(contract.tradingSymbol, q);
      return q;
    } catch (err) {
      const pause = this.opts.pauseAfterErrorMs ?? 0;
      if (pause > 0 && !(isGrowwError(err) && SYMBOL_ERRORS.has(err.kind))) {
        this.pausedUntil = (this.opts.now ?? Date.now)() + pause;
        this.pauseReason = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      }
      throw err;
    }
  }

  async chain(index: IndexId, expiry: string): Promise<{ underlyingLtp: number; rows: OptionChainRow[] }> {
    const spec = this.cfg.indexSpecs[index];
    return this.data.optionChain(spec.exchange, spec.underlying, expiry);
  }
}

/**
 * Why a real quote cannot price a paper fill or an exit, or null when it can: it needs a positive bid
 * and ask that do not cross (the PaperBroker rejects anything else, and a zero quote pauses exits).
 */
export function unusableQuote(q: Quote): string | null {
  if (!(q.bid > 0) || !(q.ask > 0)) return `no two-sided quote (bid ${q.bid}, ask ${q.ask})`;
  if (q.ask < q.bid) return `crossed quote (bid ${q.bid}, ask ${q.ask})`;
  return null;
}

/**
 * Paper-mode safety net: real quotes when available, otherwise the fallback (synthetic) source,
 * clearly tagged by Quote.source. A real quote without a usable two-sided price counts as a failure,
 * so paper exits never wait on an empty or one-sided Groww book. Never used in LIVE mode.
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
    let q: Quote;
    try {
      q = await this.primary.quote(contract, ctx);
    } catch (err) {
      this.onFallback?.(err);
      return this.fallback.quote(contract, ctx);
    }
    const problem = unusableQuote(q);
    if (problem === null) return q;
    this.onFallback?.(new Error(`${q.source} quote for ${contract.tradingSymbol} unusable: ${problem}`));
    return this.fallback.quote(contract, ctx);
  }

  async chain(index: IndexId, expiry: string): Promise<{ underlyingLtp: number; rows: OptionChainRow[] }> {
    if (this.primary.chain) return this.primary.chain(index, expiry);
    if (this.fallback.chain) return this.fallback.chain(index, expiry);
    return { underlyingLtp: 0, rows: [] };
  }
}
