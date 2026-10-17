/**
 * Groww instrument master (instrument.csv): parsing, streaming download and contract resolution.
 * Option symbols are always RESOLVED from this file, never formatted by hand: weekly and monthly
 * contracts use different symbol formats (NIFTY26O1322600CE vs NIFTY26OCT22600CE) and holiday weeks
 * move expiries (NIFTY 2026-10-19 is a Monday because 2026-10-20 is a holiday).
 */
import type { EngineConfig } from "../config";
import type { InstrumentProvider } from "../ports";
import type { Exchange, IndexId, OptionContract, OptionType } from "../types";

export const INSTRUMENT_CSV_URL = "https://growwapi-assets.groww.in/instruments/instrument.csv";

export interface InstrumentRow {
  exchange: string;
  exchangeToken: string;
  tradingSymbol: string;
  growwSymbol: string;
  name: string;
  instrumentType: string;
  segment: string;
  underlyingSymbol: string;
  /** YYYY-MM-DD, "" when not applicable. */
  expiryDate: string;
  strikePrice: number;
  lotSize: number;
  tickSize: number;
  freezeQuantity: number;
  buyAllowed: boolean;
  sellAllowed: boolean;
}

/** Exchange on which each index's options are listed (unknown underlyings: any exchange). */
const UNDERLYING_EXCHANGE: Record<string, string> = {
  NIFTY: "NSE",
  BANKNIFTY: "NSE",
  FINNIFTY: "NSE",
  MIDCPNIFTY: "NSE",
  NIFTYNXT50: "NSE",
  SENSEX: "BSE",
  BANKEX: "BSE",
  SENSEX50: "BSE",
};

const DEFAULT_UNDERLYINGS = ["NIFTY", "SENSEX"];

// ---------------------------------------------------------------------------
// CSV primitives
// ---------------------------------------------------------------------------

function countQuotes(s: string): number {
  let n = 0;
  for (let i = s.indexOf('"'); i !== -1; i = s.indexOf('"', i + 1)) n++;
  return n;
}

/** Splits one CSV record into fields (RFC 4180: quoted fields, "" escapes, commas inside quotes). */
export function splitCsvRecord(record: string): string[] {
  if (record.indexOf('"') === -1) return record.split(",");
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < record.length; i++) {
    const ch = record[i];
    if (inQuotes) {
      if (ch === '"') {
        if (record[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/** Joins physical lines into logical records when a quoted field contains a newline. */
class RecordAssembler {
  private pending: string | null = null;

  push(line: string): string | null {
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    const text = this.pending === null ? clean : `${this.pending}\n${clean}`;
    if (countQuotes(text) % 2 === 1) {
      this.pending = text;
      return null;
    }
    this.pending = null;
    return text;
  }

  flush(): string | null {
    const p = this.pending;
    this.pending = null;
    return p;
  }
}

type ColumnIndex = Map<string, number>;

function headerIndex(record: string): ColumnIndex {
  const cols = splitCsvRecord(record.replace(/^﻿/, ""));
  return new Map(cols.map((c, i) => [c.trim().toLowerCase(), i] as const));
}

function toNumber(s: string): number {
  if (s === "") return 0;
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
}

function toBool(s: string): boolean {
  const v = s.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "y" || v === "t";
}

function toIsoDate(s: string): string {
  const v = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(v);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return v;
}

function rowFromRecord(record: string, col: ColumnIndex): InstrumentRow {
  const f = splitCsvRecord(record);
  const g = (name: string): string => {
    const i = col.get(name);
    return i === undefined ? "" : (f[i] ?? "").trim();
  };
  return {
    exchange: g("exchange"),
    exchangeToken: g("exchange_token"),
    tradingSymbol: g("trading_symbol"),
    growwSymbol: g("groww_symbol"),
    name: g("name"),
    instrumentType: g("instrument_type"),
    segment: g("segment"),
    underlyingSymbol: g("underlying_symbol"),
    expiryDate: toIsoDate(g("expiry_date")),
    strikePrice: toNumber(g("strike_price")),
    lotSize: toNumber(g("lot_size")),
    tickSize: toNumber(g("tick_size")),
    freezeQuantity: toNumber(g("freeze_quantity")),
    buyAllowed: toBool(g("buy_allowed")),
    sellAllowed: toBool(g("sell_allowed")),
  };
}

/** Parses the whole CSV text (header-driven; column order does not matter). */
export function parseInstrumentCsv(text: string): InstrumentRow[] {
  const out: InstrumentRow[] = [];
  const asm = new RecordAssembler();
  let header: ColumnIndex | null = null;
  const handle = (record: string | null) => {
    if (record === null || record.trim() === "") return;
    if (!header) header = headerIndex(record);
    else out.push(rowFromRecord(record, header));
  };
  for (const line of text.split("\n")) handle(asm.push(line));
  handle(asm.flush());
  return out;
}

/** FNO CE/PE row of one of the underlyings, on the exchange that lists it (NSE NIFTY, BSE SENSEX). */
export function isIndexOptionRow(r: InstrumentRow, underlyings: string[] = DEFAULT_UNDERLYINGS): boolean {
  if (r.segment.toUpperCase() !== "FNO") return false;
  const type = r.instrumentType.toUpperCase();
  if (type !== "CE" && type !== "PE") return false;
  const und = r.underlyingSymbol.toUpperCase();
  if (!underlyings.some((u) => u.toUpperCase() === und)) return false;
  const exch = UNDERLYING_EXCHANGE[und];
  return exch === undefined || r.exchange.toUpperCase() === exch;
}

/**
 * Downloads instrument.csv and keeps only index-option rows. The ~20 MB file is streamed and parsed
 * line by line (TextDecoderStream); it is never held in memory as a whole.
 */
export async function fetchIndexOptionInstruments(
  opts: { fetchImpl?: typeof fetch; underlyings?: string[]; url?: string } = {},
): Promise<InstrumentRow[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const underlyings = opts.underlyings ?? DEFAULT_UNDERLYINGS;
  const url = opts.url ?? INSTRUMENT_CSV_URL;
  const res = await fetchImpl(url, { headers: { Accept: "text/csv,*/*" } });
  if (!res.ok) {
    let excerpt = "";
    try {
      excerpt = (await res.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new Error(`Instrument master download failed: HTTP ${res.status}${excerpt ? `: ${excerpt}` : ""}`);
  }
  if (!res.body) throw new Error("Instrument master download failed: empty response body");

  const out: InstrumentRow[] = [];
  const asm = new RecordAssembler();
  let header: ColumnIndex | null = null;
  const upper = underlyings.map((u) => u.toUpperCase());
  const handle = (record: string | null) => {
    if (record === null || record.trim() === "") return;
    if (!header) {
      header = headerIndex(record);
      return;
    }
    // Cheap pre-filter before splitting: option rows mention FNO and one of the underlyings.
    if (record.indexOf("FNO") === -1 || !upper.some((u) => record.includes(u))) return;
    const row = rowFromRecord(record, header);
    if (isIndexOptionRow(row, underlyings)) out.push(row);
  };

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    let start = 0;
    for (let nl = buf.indexOf("\n", start); nl !== -1; nl = buf.indexOf("\n", start)) {
      handle(asm.push(buf.slice(start, nl)));
      start = nl + 1;
    }
    buf = buf.slice(start);
  }
  if (buf.length > 0) handle(asm.push(buf));
  handle(asm.flush());
  return out;
}

// ---------------------------------------------------------------------------
// Strikes
// ---------------------------------------------------------------------------

/** ATM strike: spot rounded to the nearest multiple of `step` (halves round up). */
export function atmStrike(spot: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(spot)) return spot;
  return Math.round(spot / step) * step;
}

/** Listed strike closest to spot (ties go to the higher strike); null for an empty list. */
export function nearestListedStrike(strikes: number[], spot: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const k of strikes) {
    if (!Number.isFinite(k)) continue;
    const d = Math.abs(k - spot);
    if (d < bestDist || (d === bestDist && best !== null && k > best)) {
      best = k;
      bestDist = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// InstrumentMaster
// ---------------------------------------------------------------------------

interface StrikeEntry {
  strike: number;
  CE?: InstrumentRow;
  PE?: InstrumentRow;
}

const strikeKey = (strike: number): number => Math.round(strike * 100);

export class InstrumentMaster implements InstrumentProvider {
  readonly size: number;
  private readonly book = new Map<IndexId, Map<string, Map<number, StrikeEntry>>>();

  constructor(
    rows: InstrumentRow[],
    private readonly cfg: EngineConfig,
  ) {
    let count = 0;
    for (const r of rows) {
      const index = this.indexOf(r);
      if (!index || !r.expiryDate || !(r.strikePrice > 0)) continue;
      const type = r.instrumentType.toUpperCase();
      if (type !== "CE" && type !== "PE") continue;
      let byExpiry = this.book.get(index);
      if (!byExpiry) this.book.set(index, (byExpiry = new Map()));
      let byStrike = byExpiry.get(r.expiryDate);
      if (!byStrike) byExpiry.set(r.expiryDate, (byStrike = new Map()));
      const key = strikeKey(r.strikePrice);
      let entry = byStrike.get(key);
      if (!entry) byStrike.set(key, (entry = { strike: r.strikePrice }));
      const existing = entry[type];
      if (!existing) {
        entry[type] = r;
        count++;
      } else if (!(existing.buyAllowed && existing.sellAllowed) && r.buyAllowed && r.sellAllowed) {
        // Duplicate listing: prefer the one that is open for trading.
        entry[type] = r;
      }
    }
    this.size = count;
  }

  /** Which configured index a row belongs to (by underlying symbol and exchange), or null. */
  indexOf(r: InstrumentRow): IndexId | null {
    if (r.segment.toUpperCase() !== "FNO") return null;
    for (const index of Object.keys(this.cfg.indexSpecs) as IndexId[]) {
      const spec = this.cfg.indexSpecs[index];
      if (r.underlyingSymbol.toUpperCase() === spec.underlying.toUpperCase() && r.exchange.toUpperCase() === spec.exchange) {
        return index;
      }
    }
    return null;
  }

  async expiries(index: IndexId): Promise<string[]> {
    return [...(this.book.get(index)?.keys() ?? [])].sort();
  }

  async strikes(index: IndexId, expiry: string): Promise<number[]> {
    const byStrike = this.book.get(index)?.get(expiry);
    if (!byStrike) return [];
    return [...byStrike.values()].map((e) => e.strike).sort((a, b) => a - b);
  }

  async resolve(index: IndexId, expiry: string, strike: number, type: OptionType): Promise<OptionContract | null> {
    const row = this.book.get(index)?.get(expiry)?.get(strikeKey(strike))?.[type];
    return row ? this.toContract(row, index) : null;
  }

  toContract(row: InstrumentRow, index: IndexId): OptionContract {
    const spec = this.cfg.indexSpecs[index];
    const contract: OptionContract = {
      index,
      exchange: (row.exchange.toUpperCase() === "BSE" ? "BSE" : row.exchange.toUpperCase() === "NSE" ? "NSE" : spec.exchange) as Exchange,
      tradingSymbol: row.tradingSymbol,
      growwSymbol: row.growwSymbol,
      exchangeToken: row.exchangeToken,
      expiry: row.expiryDate,
      strike: row.strikePrice,
      type: row.instrumentType.toUpperCase() === "PE" ? "PE" : "CE",
      lotSize: row.lotSize > 0 ? row.lotSize : spec.lotSize,
      tickSize: row.tickSize > 0 ? row.tickSize : spec.tickSize,
    };
    if (row.freezeQuantity > 0) contract.freezeQty = row.freezeQuantity;
    return contract;
  }
}
