/**
 * Instrument master for the Worker: the 08:10 IST job streams Groww's public instrument.csv,
 * keeps NIFTY/SENSEX options for the next few expiries and stores a compact copy in KV
 * (plus a dated copy in R2). The trading DO loads it from KV and keeps it in memory.
 * In PAPER mode only, a missing master falls back to synthetic contracts around spot.
 */
import type { TradingCalendar } from "../../../src/engine/calendar/calendar";
import { istDate } from "../../../src/engine/clock";
import type { EngineConfig } from "../../../src/engine/config";
import { InstrumentMaster, fetchIndexOptionInstruments, type InstrumentRow } from "../../../src/engine/instruments/instrumentMaster";
import { syntheticInstrumentRows } from "../../../src/engine/instruments/syntheticInstruments";
import type { MarketContextStore } from "../../../src/engine/pipeline/marketContext";
import type { InstrumentProvider, Logger } from "../../../src/engine/ports";
import type { IndexId, OptionContract, OptionType } from "../../../src/engine/types";

export const INSTRUMENTS_KV_KEY = "instruments:latest";
const KEEP_EXPIRIES = 6;

/** Compact row: [exchange, exchangeToken, tradingSymbol, growwSymbol, type, underlying, expiry, strike, lotSize, tickSize, freezeQty]. */
type CompactRow = [string, string, string, string, string, string, string, number, number, number, number];

export interface StoredInstruments {
  v: 1;
  fetchedMs: number;
  rows: CompactRow[];
}

export function compactRows(rows: InstrumentRow[], todayIst: string, keepExpiries = KEEP_EXPIRIES): CompactRow[] {
  const byUnderlying = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.expiryDate || r.expiryDate < todayIst) continue;
    const set = byUnderlying.get(r.underlyingSymbol) ?? new Set<string>();
    set.add(r.expiryDate);
    byUnderlying.set(r.underlyingSymbol, set);
  }
  const keep = new Map<string, Set<string>>();
  for (const [u, set] of byUnderlying) keep.set(u, new Set([...set].sort().slice(0, keepExpiries)));
  return rows
    .filter((r) => keep.get(r.underlyingSymbol)?.has(r.expiryDate))
    .map((r) => [r.exchange, r.exchangeToken, r.tradingSymbol, r.growwSymbol, r.instrumentType, r.underlyingSymbol, r.expiryDate, r.strikePrice, r.lotSize, r.tickSize, r.freezeQuantity]);
}

export function expandRows(rows: CompactRow[]): InstrumentRow[] {
  return rows.map(([exchange, exchangeToken, tradingSymbol, growwSymbol, instrumentType, underlyingSymbol, expiryDate, strikePrice, lotSize, tickSize, freezeQuantity]) => ({
    exchange,
    exchangeToken,
    tradingSymbol,
    growwSymbol,
    name: "",
    instrumentType,
    segment: "FNO",
    underlyingSymbol,
    expiryDate,
    strikePrice,
    lotSize,
    tickSize,
    freezeQuantity,
    buyAllowed: true,
    sellAllowed: true,
  }));
}

/** Downloads instrument.csv and stores the compact copy. Returns the number of rows kept. */
export async function refreshInstruments(env: Env, nowMs: number, logger: Logger): Promise<number> {
  const rows = await fetchIndexOptionInstruments({ underlyings: ["NIFTY", "SENSEX"] });
  const compact = compactRows(rows, istDate(nowMs));
  if (compact.length === 0) throw new Error("instrument.csv had no NIFTY/SENSEX option rows for upcoming expiries");
  const body: StoredInstruments = { v: 1, fetchedMs: nowMs, rows: compact };
  const json = JSON.stringify(body);
  await env.KV.put(INSTRUMENTS_KV_KEY, json);
  await env.R2.put(`instruments/${istDate(nowMs)}.json`, json, { httpMetadata: { contentType: "application/json" } });
  logger.info("instruments refreshed", { parsed: rows.length, kept: compact.length, bytes: json.length });
  return compact.length;
}

export interface CachedInstrumentsOptions {
  env: Env;
  cfg: EngineConfig;
  calendar: TradingCalendar;
  marketContext: MarketContextStore;
  logger: Logger;
  /** Allow synthetic contracts when the real master is missing (PAPER only). */
  allowSynthetic: () => boolean;
  now?: () => number;
}

/** KV-backed InstrumentProvider with an in-memory copy refreshed every few hours. */
export class CachedInstruments implements InstrumentProvider {
  private master: InstrumentMaster | null = null;
  private loadedMs = -Infinity;
  private fetchedMs: number | null = null;

  constructor(private readonly o: CachedInstrumentsOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Epoch ms of the instrument file in use (null = none loaded). */
  get sourceFetchedMs(): number | null {
    return this.fetchedMs;
  }

  private async real(): Promise<InstrumentMaster | null> {
    const age = this.now() - this.loadedMs;
    if (this.master && age < 3 * 3_600_000) return this.master;
    if (!this.master && age < 5 * 60_000) return null; // retry a missing file every 5 minutes
    this.loadedMs = this.now();
    try {
      const stored = await this.o.env.KV.get<StoredInstruments>(INSTRUMENTS_KV_KEY, "json");
      if (stored && stored.v === 1 && stored.rows.length > 0) {
        this.master = new InstrumentMaster(expandRows(stored.rows), this.o.cfg);
        this.fetchedMs = stored.fetchedMs;
      }
    } catch (err) {
      this.o.logger.warn("instrument master load failed", { error: err instanceof Error ? err.message : String(err) });
    }
    return this.master;
  }

  /** Synthetic master for PAPER when the real file is unavailable (contracts built around spot). */
  private synthetic(index: IndexId): InstrumentMaster | null {
    if (!this.o.allowSynthetic()) return null;
    const ctx = this.o.marketContext.get(index);
    if (!ctx) return null;
    const today = istDate(this.now());
    const first = this.o.calendar.expiryOnOrAfter(index, today);
    const expiries = [first, this.o.calendar.followingExpiry(index, first)];
    return new InstrumentMaster(syntheticInstrumentRows(index, expiries, ctx.spot, 30, this.o.cfg), this.o.cfg);
  }

  private async pick(index: IndexId): Promise<InstrumentMaster | null> {
    const m = await this.real();
    if (m && (await m.expiries(index)).some((e) => e >= istDate(this.now()))) return m;
    return this.synthetic(index);
  }

  async expiries(index: IndexId): Promise<string[]> {
    return (await this.pick(index))?.expiries(index) ?? [];
  }

  async strikes(index: IndexId, expiry: string): Promise<number[]> {
    return (await this.pick(index))?.strikes(index, expiry) ?? [];
  }

  async resolve(index: IndexId, expiry: string, strike: number, type: OptionType): Promise<OptionContract | null> {
    return (await this.pick(index))?.resolve(index, expiry, strike, type) ?? null;
  }
}
