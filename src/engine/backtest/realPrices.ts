/**
 * Real end-of-day option and futures prices from the exchanges' F&O bhavcopies (research only;
 * nothing in the live engine reads them).
 *
 * Sources (public archives, no keys):
 *   NSE "UDiFF" bhavcopy  nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip   (from 2024-01-08)
 *   NSE legacy bhavcopy   nsearchives.nseindia.com/content/historical/DERIVATIVES/YYYY/MON/foDDMONYYYYbhav.csv.zip (until 2024-07-05)
 *   BSE derivatives       www.bseindia.com/download/Bhavcopy/Derivative/bhavcopyDD-MM-YY.zip                       (SENSEX weeklies)
 *
 * What the price fields mean (see docs/research/overnight-short-vol.md for the sources):
 *   open   first trade of the day. Index OPTIONS have no pre-open call auction (NSE's F&O pre-open covers
 *          futures only), so an option's open is its first continuous-session trade at or after 09:15.
 *   close  NSE: the exchange's closing price: volume-weighted average of the trades in the last 30 minutes,
 *          or the last traded price when the contract did not trade in that window, or a theoretical
 *          price when it did not trade at all (then `contracts` is 0). It is NOT the last trade
 *          (`last` holds that, UDiFF only). BSE: the published "Close"; on a contract's expiry day BSE
 *          prints the final settlement level of the index there instead of a premium, which the BSE
 *          parser converts to the intrinsic value (flag "S").
 *   vwap   the day's volume-weighted average premium, derived from turnover (both exchanges report
 *          option turnover on strike + premium).
 * Rows are filtered to index options and futures of NIFTY and BANKNIFTY (NSE) and SENSEX (BSE).
 *
 * Pure and web-standard (no node: imports) so it type-checks in the Workers build too; the Node
 * script scripts/fetch-bhavcopy.ts does the downloading and the file I/O.
 */
import { splitCsvRecord } from "../instruments/instrumentMaster";

export type BhavExchange = "NSE" | "BSE";
export type BhavFormat = "nse-udiff" | "nse-legacy" | "bse";
export type BhavKind = "OPT" | "FUT";
export type BhavOptionType = "CE" | "PE";

export interface BhavRow {
  /** Trade date, YYYY-MM-DD. */
  date: string;
  exchange: BhavExchange;
  /** Underlying: NIFTY, BANKNIFTY or SENSEX. */
  symbol: string;
  kind: BhavKind;
  /** YYYY-MM-DD. */
  expiry: string;
  /** 0 for futures. */
  strike: number;
  /** null for futures. */
  type: BhavOptionType | null;
  /** First trade of the day; null when the contract did not trade. */
  open: number | null;
  high: number | null;
  low: number | null;
  /** Exchange closing price (see the module comment); may be stale or theoretical when contracts is 0. */
  close: number | null;
  /** Last traded price (NSE UDiFF only). */
  last: number | null;
  /** Settlement price as published (NSE); BSE expiry-day options: the final settlement index level. */
  settle: number | null;
  /** Previous day's closing price (NSE UDiFF only). */
  prevClose: number | null;
  /** Underlying index close (NSE UDiFF only). */
  underlying: number | null;
  /** Contracts (lots) traded. */
  contracts: number;
  /** Open interest as published (units). */
  oi: number | null;
  /** Lot size: published (NSE UDiFF) or derived from turnover / contracts. */
  lot: number | null;
  /** Volume-weighted average premium (options) or price (futures) for the day; null when not derivable. */
  vwap: number | null;
  /** "S" = BSE expiry-day option whose close was replaced by the intrinsic value at final settlement. */
  flags: string;
}

/** Underlyings kept per exchange. */
export const BHAV_SYMBOLS: Record<BhavExchange, readonly string[]> = { NSE: ["NIFTY", "BANKNIFTY"], BSE: ["SENSEX"] };

/** First date of NSE's UDiFF F&O bhavcopy, and the last date of the legacy file. */
export const NSE_UDIFF_FROM = "2024-01-08";
export const NSE_LEGACY_UNTIL = "2024-07-05";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function dateParts(date: string): { y: string; m: number; d: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date ${date}`);
  return { y: m[1], m: Number(m[2]), d: m[3] };
}

/** Download URL, format and request headers of an exchange's bhavcopy for a date. */
export function bhavcopyUrl(exchange: BhavExchange, date: string): { url: string; format: BhavFormat; headers: Record<string, string> } {
  const { y, m, d } = dateParts(date);
  if (exchange === "BSE") {
    return {
      url: `https://www.bseindia.com/download/Bhavcopy/Derivative/bhavcopy${d}-${String(m).padStart(2, "0")}-${y.slice(2)}.zip`,
      format: "bse",
      headers: { Referer: "https://www.bseindia.com/" },
    };
  }
  if (date >= NSE_UDIFF_FROM) {
    return {
      url: `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${y}${String(m).padStart(2, "0")}${d}_F_0000.csv.zip`,
      format: "nse-udiff",
      headers: {},
    };
  }
  const mon = MONTHS[m - 1];
  return {
    url: `https://nsearchives.nseindia.com/content/historical/DERIVATIVES/${y}/${mon}/fo${d}${mon}${y}bhav.csv.zip`,
    format: "nse-legacy",
    headers: {},
  };
}

/** Relative path of a day's compact extract inside the cache directory. */
export function cachePath(exchange: BhavExchange, date: string): string {
  const { y, m, d } = dateParts(date);
  return `${exchange.toLowerCase()}/${y}/${y}${String(m).padStart(2, "0")}${d}.csv.gz`;
}

// ---------------------------------------------------------------------------
// Decompression (web-standard streams: Node >= 22 and Workers)
// ---------------------------------------------------------------------------

async function decompress(bytes: Uint8Array, format: "gzip" | "deflate-raw"): Promise<Uint8Array> {
  const body = new Response(new Uint8Array(bytes)).body;
  if (!body) return new Uint8Array(0);
  const out = body.pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return decompress(bytes, "gzip");
}

/** Entries of a ZIP archive (stored or deflated; no ZIP64, no encryption). Directories are skipped. */
export async function unzip(bytes: Uint8Array): Promise<{ name: string; data: Uint8Array }[]> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory record)");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const out: { name: string; data: Uint8Array }[] = [];
  for (let k = 0; k < count; k++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error(`corrupt zip local header for ${name}`);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + compressedSize);
    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await decompress(raw, "deflate-raw");
    else throw new Error(`unsupported zip compression method ${method} for ${name}`);
    if (data.length !== size) throw new Error(`zip entry ${name}: expected ${size} bytes, got ${data.length}`);
    out.push({ name, data });
  }
  return out;
}

/** Text of the first CSV inside a bhavcopy zip (BOM stripped). */
export async function bhavcopyCsvFromZip(bytes: Uint8Array): Promise<string> {
  const entries = await unzip(bytes);
  const csv = entries.find((e) => e.name.toLowerCase().endsWith(".csv")) ?? entries[0];
  if (!csv) throw new Error("empty zip archive");
  return new TextDecoder().decode(csv.data).replace(/^﻿/, "");
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim() !== "");
}

/** Number or null for blanks, "-" and non-numbers. */
function num(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (s === "" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const MON_INDEX: Record<string, number> = Object.fromEntries(MONTHS.map((m, i) => [m, i + 1]));

/** "11-Jan-2024", "05-JAN-2024", "08 Oct 2026" or "2024-01-11" -> "2024-01-11". */
export function parseExchangeDate(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{4})$/.exec(s);
  if (!m) return null;
  const month = MON_INDEX[m[2].toUpperCase()];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

function headerIndex(header: string[], names: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of names) {
    const i = header.indexOf(n);
    if (i < 0) throw new Error(`bhavcopy column "${n}" missing (header: ${header.slice(0, 12).join(",")}...)`);
    out[n] = i;
  }
  return out;
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** A derived VWAP is accepted only when it lies inside the day's range (allowing for rounding). */
function vwapWithinRange(v: number, low: number | null, high: number | null): number | null {
  if (!Number.isFinite(v) || low === null || high === null) return null;
  const tol = 0.05 + 0.002 * Math.max(Math.abs(low), Math.abs(high));
  return v >= low - tol && v <= high + tol ? round4(Math.min(Math.max(v, low), high)) : null;
}

/** Fills missing lot sizes with the most common lot of the same symbol and expiry (else of the symbol). */
function fillLots(rows: BhavRow[]): void {
  const mode = (vals: number[]): number | null => {
    const counts = new Map<number, number>();
    for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best: number | null = null;
    let bestN = 0;
    for (const [v, n] of counts) if (n > bestN) [best, bestN] = [v, n];
    return best;
  };
  const byExpiry = new Map<string, number[]>();
  const bySymbol = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, v: number) => {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  };
  for (const r of rows) {
    if (r.lot === null) continue;
    push(byExpiry, `${r.symbol}|${r.expiry}`, r.lot);
    push(bySymbol, r.symbol, r.lot);
  }
  for (const r of rows) {
    if (r.lot !== null) continue;
    r.lot = mode(byExpiry.get(`${r.symbol}|${r.expiry}`) ?? []) ?? mode(bySymbol.get(r.symbol) ?? []);
  }
}

/** NSE UDiFF F&O bhavcopy (from 2024-01-08): index options (IDO) and futures (IDF) of `symbols`. */
export function parseNseUdiff(text: string, symbols: readonly string[] = BHAV_SYMBOLS.NSE): BhavRow[] {
  const ls = lines(text.replace(/^﻿/, ""));
  if (ls.length === 0) return [];
  const header = splitCsvRecord(ls[0]).map((h) => h.trim());
  const c = headerIndex(header, [
    "TradDt", "FinInstrmTp", "TckrSymb", "XpryDt", "StrkPric", "OptnTp", "OpnPric", "HghPric", "LwPric", "ClsPric",
    "LastPric", "PrvsClsgPric", "UndrlygPric", "SttlmPric", "OpnIntrst", "TtlTradgVol", "TtlTrfVal", "NewBrdLotQty",
  ]);
  const want = new Set(symbols);
  const out: BhavRow[] = [];
  for (let i = 1; i < ls.length; i++) {
    const f = splitCsvRecord(ls[i]);
    const tp = f[c.FinInstrmTp]?.trim();
    if (tp !== "IDO" && tp !== "IDF") continue;
    const symbol = f[c.TckrSymb]?.trim() ?? "";
    if (!want.has(symbol)) continue;
    const date = parseExchangeDate(f[c.TradDt] ?? "");
    const expiry = parseExchangeDate(f[c.XpryDt] ?? "");
    if (!date || !expiry) continue;
    const kind: BhavKind = tp === "IDO" ? "OPT" : "FUT";
    const optType = f[c.OptnTp]?.trim();
    const type: BhavOptionType | null = kind === "OPT" ? (optType === "CE" || optType === "PE" ? optType : null) : null;
    if (kind === "OPT" && type === null) continue;
    const strike = kind === "OPT" ? num(f[c.StrkPric]) ?? 0 : 0;
    const contracts = num(f[c.TtlTradgVol]) ?? 0;
    const traded = contracts > 0;
    const low = traded ? num(f[c.LwPric]) : null;
    const high = traded ? num(f[c.HghPric]) : null;
    const lot = num(f[c.NewBrdLotQty]);
    const turnover = num(f[c.TtlTrfVal]);
    const perUnit = traded && lot && turnover ? turnover / (contracts * lot) : NaN;
    const last = num(f[c.LastPric]);
    out.push({
      date,
      exchange: "NSE",
      symbol,
      kind,
      expiry,
      strike,
      type,
      open: traded ? num(f[c.OpnPric]) : null,
      high,
      low,
      close: num(f[c.ClsPric]),
      last: last !== null && last > 0 ? last : null,
      settle: num(f[c.SttlmPric]),
      prevClose: num(f[c.PrvsClsgPric]),
      underlying: num(f[c.UndrlygPric]),
      contracts,
      oi: num(f[c.OpnIntrst]),
      lot: lot && lot > 0 ? lot : null,
      vwap: vwapWithinRange(kind === "OPT" ? perUnit - strike : perUnit, low, high),
      flags: "",
    });
  }
  fillLots(out);
  return out;
}

/** NSE legacy F&O bhavcopy (until 2024-07-05): OPTIDX and FUTIDX rows of `symbols`. Lot sizes are derived. */
export function parseNseLegacy(text: string, symbols: readonly string[] = BHAV_SYMBOLS.NSE): BhavRow[] {
  const ls = lines(text.replace(/^﻿/, ""));
  if (ls.length === 0) return [];
  const header = splitCsvRecord(ls[0]).map((h) => h.trim());
  const c = headerIndex(header, [
    "INSTRUMENT", "SYMBOL", "EXPIRY_DT", "STRIKE_PR", "OPTION_TYP", "OPEN", "HIGH", "LOW", "CLOSE", "SETTLE_PR",
    "CONTRACTS", "VAL_INLAKH", "OPEN_INT", "TIMESTAMP",
  ]);
  const want = new Set(symbols);
  const out: BhavRow[] = [];
  const valueByRow: number[] = [];
  for (let i = 1; i < ls.length; i++) {
    const f = splitCsvRecord(ls[i]);
    const inst = f[c.INSTRUMENT]?.trim();
    if (inst !== "OPTIDX" && inst !== "FUTIDX") continue;
    const symbol = f[c.SYMBOL]?.trim() ?? "";
    if (!want.has(symbol)) continue;
    const date = parseExchangeDate(f[c.TIMESTAMP] ?? "");
    const expiry = parseExchangeDate(f[c.EXPIRY_DT] ?? "");
    if (!date || !expiry) continue;
    const kind: BhavKind = inst === "OPTIDX" ? "OPT" : "FUT";
    const optType = f[c.OPTION_TYP]?.trim();
    const type: BhavOptionType | null = kind === "OPT" ? (optType === "CE" || optType === "PE" ? optType : null) : null;
    if (kind === "OPT" && type === null) continue;
    const contracts = num(f[c.CONTRACTS]) ?? 0;
    const traded = contracts > 0;
    const close = num(f[c.CLOSE]);
    const strike = kind === "OPT" ? num(f[c.STRIKE_PR]) ?? 0 : 0;
    const value = (num(f[c.VAL_INLAKH]) ?? 0) * 100_000;
    // Options: turnover is on strike + premium, so value / contracts / (strike + close) is the lot size
    // to within the premium's intraday range; futures take the lot of their expiry's options (fillLots).
    let lot: number | null = null;
    if (traded && kind === "OPT" && value > 0 && close !== null) {
      const est = value / (contracts * (strike + close));
      const r = Math.round(est);
      if (r > 0 && Math.abs(est - r) / r < 0.02) lot = r;
    }
    out.push({
      date,
      exchange: "NSE",
      symbol,
      kind,
      expiry,
      strike,
      type,
      open: traded ? num(f[c.OPEN]) : null,
      high: traded ? num(f[c.HIGH]) : null,
      low: traded ? num(f[c.LOW]) : null,
      close,
      last: null,
      settle: num(f[c.SETTLE_PR]),
      prevClose: null,
      underlying: null,
      contracts,
      oi: num(f[c.OPEN_INT]),
      lot,
      vwap: null,
      flags: "",
    });
    valueByRow.push(value);
  }
  fillLots(out);
  out.forEach((r, i) => {
    if (r.contracts > 0 && r.lot && valueByRow[i] > 0) {
      const perUnit = valueByRow[i] / (r.contracts * r.lot);
      r.vwap = vwapWithinRange(r.kind === "OPT" ? perUnit - r.strike : perUnit, r.low, r.high);
    }
  });
  return out;
}

/** BSE derivatives bhavcopy for `date` (the file has no trade-date column): IO and IF rows of `symbols`. */
export function parseBse(text: string, date: string, symbols: readonly string[] = BHAV_SYMBOLS.BSE): BhavRow[] {
  const ls = lines(text.replace(/^﻿/, ""));
  if (ls.length === 0) return [];
  const header = splitCsvRecord(ls[0]).map((h) => h.trim());
  const c = headerIndex(header, [
    "Contract Type", "Symbol", "Expiry", "Strike", "Option Type", "Open", "High", "Low", "Close", "Wt. Avg. Price",
    "Contracts Traded", "Turnover(Rs Lakhs)", "Open Interest",
  ]);
  const out: BhavRow[] = [];
  for (let i = 1; i < ls.length; i++) {
    const f = splitCsvRecord(ls[i]);
    const ct = f[c["Contract Type"]]?.trim();
    if (ct !== "IO" && ct !== "IF") continue;
    const expiry = parseExchangeDate(f[c.Expiry] ?? "");
    if (!expiry) continue;
    const code = f[c.Symbol]?.trim() ?? "";
    // The contract code is underlying + 2-digit expiry year + ...; matching the year as well keeps
    // e.g. SENSEX50 contracts out of SENSEX.
    const symbol = symbols.find((s) => code.startsWith(s + expiry.slice(2, 4)));
    if (!symbol) continue;
    const kind: BhavKind = ct === "IO" ? "OPT" : "FUT";
    const ot = f[c["Option Type"]]?.trim().toUpperCase();
    const type: BhavOptionType | null = kind === "OPT" ? (ot === "CALL" || ot === "CE" ? "CE" : ot === "PUT" || ot === "PE" ? "PE" : null) : null;
    if (kind === "OPT" && type === null) continue;
    const strike = kind === "OPT" ? num(f[c.Strike]) ?? 0 : 0;
    const contracts = num(f[c["Contracts Traded"]]) ?? 0;
    const traded = contracts > 0;
    const low = traded ? num(f[c.Low]) : null;
    const high = traded ? num(f[c.High]) : null;
    const wavg = num(f[c["Wt. Avg. Price"]]);
    const turnover = (num(f[c["Turnover(Rs Lakhs)"]]) ?? 0) * 100_000;
    let lot: number | null = null;
    if (traded && wavg && wavg > 0 && turnover > 0) {
      const est = turnover / (contracts * wavg);
      const r = Math.round(est);
      if (r > 0 && Math.abs(est - r) / r < 0.02) lot = r;
    }
    let close = num(f[c.Close]);
    let settle: number | null = null;
    let flags = "";
    // On expiry day BSE prints the final settlement level of the index as the option's "Close".
    if (kind === "OPT" && expiry === date && close !== null && close > strike * 0.5) {
      settle = close;
      close = round4(type === "CE" ? Math.max(settle - strike, 0) : Math.max(strike - settle, 0));
      flags = "S";
    }
    out.push({
      date,
      exchange: "BSE",
      symbol,
      kind,
      expiry,
      strike,
      type,
      open: traded ? num(f[c.Open]) : null,
      high,
      low,
      close,
      last: null,
      settle,
      prevClose: null,
      underlying: null,
      contracts,
      oi: num(f[c["Open Interest"]]),
      lot,
      vwap: wavg !== null && traded ? vwapWithinRange(kind === "OPT" ? wavg - strike : wavg, low, high) : null,
      flags,
    });
  }
  fillLots(out);
  return out;
}

/** Format of a bhavcopy CSV from its header (NSE publishes both layouts for early 2024). */
export function detectBhavFormat(exchange: BhavExchange, text: string): BhavFormat {
  if (exchange === "BSE") return "bse";
  const head = text.replace(/^﻿/, "").slice(0, 200);
  if (head.startsWith("TradDt")) return "nse-udiff";
  if (head.startsWith("INSTRUMENT")) return "nse-legacy";
  throw new Error(`unrecognised NSE bhavcopy header: ${head.slice(0, 60)}`);
}

/** Parses a bhavcopy CSV of the given format. */
export function parseBhavcopy(format: BhavFormat, text: string, date: string): BhavRow[] {
  if (format === "nse-udiff") return parseNseUdiff(text);
  if (format === "nse-legacy") return parseNseLegacy(text);
  return parseBse(text, date);
}

// ---------------------------------------------------------------------------
// Compact cache format (one gzipped CSV per exchange and date)
// ---------------------------------------------------------------------------

export const COMPACT_HEADER = "date,exch,sym,kind,expiry,strike,type,open,high,low,close,last,settle,prev,undl,contracts,oi,lot,vwap,flags";

function fmt(x: number | null): string {
  return x === null ? "" : String(round4(x));
}

export function toCompactCsv(rows: BhavRow[]): string {
  const out = [COMPACT_HEADER];
  for (const r of rows) {
    out.push(
      [
        r.date, r.exchange, r.symbol, r.kind, r.expiry, fmt(r.strike), r.type ?? "", fmt(r.open), fmt(r.high), fmt(r.low),
        fmt(r.close), fmt(r.last), fmt(r.settle), fmt(r.prevClose), fmt(r.underlying), fmt(r.contracts), fmt(r.oi),
        fmt(r.lot), fmt(r.vwap), r.flags,
      ].join(","),
    );
  }
  return out.join("\n") + "\n";
}

export function parseCompactCsv(text: string): BhavRow[] {
  const ls = lines(text);
  if (ls.length === 0) return [];
  if (ls[0] !== COMPACT_HEADER) throw new Error("not a compact bhavcopy extract (unexpected header)");
  const out: BhavRow[] = [];
  for (let i = 1; i < ls.length; i++) {
    const f = ls[i].split(",");
    const type = f[6] === "CE" || f[6] === "PE" ? f[6] : null;
    out.push({
      date: f[0],
      exchange: f[1] === "BSE" ? "BSE" : "NSE",
      symbol: f[2],
      kind: f[3] === "FUT" ? "FUT" : "OPT",
      expiry: f[4],
      strike: num(f[5]) ?? 0,
      type,
      open: num(f[7]),
      high: num(f[8]),
      low: num(f[9]),
      close: num(f[10]),
      last: num(f[11]),
      settle: num(f[12]),
      prevClose: num(f[13]),
      underlying: num(f[14]),
      contracts: num(f[15]) ?? 0,
      oi: num(f[16]),
      lot: num(f[17]),
      vwap: num(f[18]),
      flags: f[19] ?? "",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-memory book and loader
// ---------------------------------------------------------------------------

const optKey = (symbol: string, date: string, expiry: string, strike: number, type: BhavOptionType) =>
  `${symbol}|${date}|${expiry}|${round4(strike)}|${type}`;

/** All loaded rows, indexed for lookups by symbol, date, expiry, strike and type. */
export class RealPriceBook {
  private readonly days = new Map<string, BhavRow[]>();
  private readonly options = new Map<string, BhavRow>();
  private readonly datesBySymbol = new Map<string, string[]>();

  add(rows: BhavRow[]): void {
    const touched = new Set<string>();
    for (const r of rows) {
      const k = `${r.symbol}|${r.date}`;
      let day = this.days.get(k);
      if (!day) {
        day = [];
        this.days.set(k, day);
        touched.add(r.symbol);
      }
      day.push(r);
      if (r.kind === "OPT" && r.type) this.options.set(optKey(r.symbol, r.date, r.expiry, r.strike, r.type), r);
    }
    for (const s of touched) this.datesBySymbol.delete(s);
  }

  /** Dates with rows for `symbol`, ascending. */
  dates(symbol: string): string[] {
    let d = this.datesBySymbol.get(symbol);
    if (!d) {
      d = [...this.days.keys()].filter((k) => k.startsWith(symbol + "|")).map((k) => k.slice(symbol.length + 1)).sort();
      this.datesBySymbol.set(symbol, d);
    }
    return d;
  }

  rows(symbol: string, date: string): BhavRow[] {
    return this.days.get(`${symbol}|${date}`) ?? [];
  }

  option(symbol: string, date: string, expiry: string, strike: number, type: BhavOptionType): BhavRow | undefined {
    return this.options.get(optKey(symbol, date, expiry, strike, type));
  }

  /** Futures rows of a day, nearest expiry first. */
  futures(symbol: string, date: string): BhavRow[] {
    return this.rows(symbol, date)
      .filter((r) => r.kind === "FUT")
      .sort((a, b) => a.expiry.localeCompare(b.expiry));
  }

  /** Option expiries listed on `date` on or after it, ascending. */
  expiries(symbol: string, date: string): string[] {
    const s = new Set<string>();
    for (const r of this.rows(symbol, date)) if (r.kind === "OPT" && r.expiry >= date) s.add(r.expiry);
    return [...s].sort();
  }

  /** Strikes listed for an expiry on a date, ascending. */
  strikes(symbol: string, date: string, expiry: string): number[] {
    const s = new Set<number>();
    for (const r of this.rows(symbol, date)) if (r.kind === "OPT" && r.expiry === expiry) s.add(r.strike);
    return [...s].sort((a, b) => a - b);
  }

  /** The next date with rows for `symbol` after `date`. */
  nextDate(symbol: string, date: string): string | undefined {
    const ds = this.dates(symbol);
    let lo = 0;
    let hi = ds.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ds[mid] <= date) lo = mid + 1;
      else hi = mid;
    }
    return ds[lo];
  }

  /** Sessions strictly after `date` up to and including `expiry` (0 on the expiry day itself). */
  sessionsToExpiry(symbol: string, date: string, expiry: string): number {
    if (expiry <= date) return 0;
    const ds = this.dates(symbol);
    let n = 0;
    for (const d of ds) if (d > date && d <= expiry) n++;
    // Expiries beyond the loaded dates count the missing weekdays (approximation for the last week).
    const last = ds.at(-1);
    if (last && expiry > last) {
      for (let d = nextDay(last); d <= expiry; d = nextDay(d)) if (isWeekday(d)) n++;
    }
    return n;
  }
}

function nextDay(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`) + 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function isWeekday(date: string): boolean {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return wd >= 1 && wd <= 5;
}

// ---------------------------------------------------------------------------
// Research helpers
// ---------------------------------------------------------------------------

const MONTH_CODES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "O", "N", "D"];

/** Parsed engine/Groww option trading symbol (weekly NIFTY26O1322600CE or monthly NIFTY26OCT22600CE). */
export interface ParsedOptionSymbol {
  underlying: string;
  /** Weekly symbols carry the expiry date; monthly ones only the year and month. */
  expiry: string | null;
  year: number;
  month: number;
  strike: number;
  type: BhavOptionType;
}

export function parseOptionSymbol(sym: string): ParsedOptionSymbol | null {
  const monthly = /^([A-Z]+?)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d+(?:\.\d+)?)(CE|PE)$/.exec(sym);
  if (monthly) {
    return {
      underlying: monthly[1],
      expiry: null,
      year: 2000 + Number(monthly[2]),
      month: MONTHS.indexOf(monthly[3]) + 1,
      strike: Number(monthly[4]),
      type: monthly[5] as BhavOptionType,
    };
  }
  const weekly = /^([A-Z]+?)(\d{2})([1-9OND])(\d{2})(\d+(?:\.\d+)?)(CE|PE)$/.exec(sym);
  if (!weekly) return null;
  const year = 2000 + Number(weekly[2]);
  const month = MONTH_CODES.indexOf(weekly[3]) + 1;
  return {
    underlying: weekly[1],
    expiry: `${year}-${String(month).padStart(2, "0")}-${weekly[4]}`,
    year,
    month,
    strike: Number(weekly[5]),
    type: weekly[6] as BhavOptionType,
  };
}

/**
 * The bhavcopy row of an engine trading symbol on `date`. Monthly symbols resolve to the last
 * expiry of their month listed that day.
 */
export function resolveOptionRow(book: RealPriceBook, sym: string, date: string): BhavRow | undefined {
  const p = parseOptionSymbol(sym);
  if (!p) return undefined;
  let expiry = p.expiry;
  if (!expiry) {
    const prefix = `${p.year}-${String(p.month).padStart(2, "0")}`;
    expiry = book.expiries(p.underlying, date).filter((e) => e.startsWith(prefix)).at(-1) ?? null;
  }
  return expiry ? book.option(p.underlying, date, expiry, p.strike, p.type) : undefined;
}

/**
 * The value a holder receives at the close: on the contract's expiry day the intrinsic value at the
 * final settlement level of the index (both exchanges print that level in the settle field: NSE's
 * SttlmPric, BSE's Close), otherwise the closing price. Null when there is no price.
 */
export function settledClose(r: BhavRow): number | null {
  if (r.kind === "OPT" && r.type && r.expiry === r.date && r.settle !== null && r.settle > 0.5 * r.strike) {
    return round4(r.type === "CE" ? Math.max(r.settle - r.strike, 0) : Math.max(r.strike - r.settle, 0));
  }
  return r.close;
}

/** Listed strike nearest `level` (ties to the lower strike); null for an empty list. */
export function nearestStrike(strikes: number[], level: number): number | null {
  let best: number | null = null;
  for (const k of strikes) if (best === null || Math.abs(k - level) < Math.abs(best - level)) best = k;
  return best;
}

export type PriceField = "open" | "close" | "vwap";

/**
 * Forward implied by put-call parity from same-strike call and put prices of one expiry:
 * F = K + (C - P) * e^{rT} at the strikes where |C - P| is smallest (median over that strike and its
 * listed neighbours). Only contracts that traded that day are used. Null when no strike qualifies.
 */
export function parityForward(
  book: RealPriceBook,
  symbol: string,
  date: string,
  expiry: string,
  field: PriceField,
  o: { r: number; tYears: number },
): { forward: number; strike: number } | null {
  const pairs: { k: number; diff: number }[] = [];
  for (const k of book.strikes(symbol, date, expiry)) {
    const c = book.option(symbol, date, expiry, k, "CE");
    const p = book.option(symbol, date, expiry, k, "PE");
    if (!c || !p || c.contracts <= 0 || p.contracts <= 0) continue;
    const cv = c[field];
    const pv = p[field];
    if (cv === null || pv === null || !(cv > 0) || !(pv > 0)) continue;
    pairs.push({ k, diff: cv - pv });
  }
  if (pairs.length === 0) return null;
  let best = 0;
  for (let i = 1; i < pairs.length; i++) if (Math.abs(pairs[i].diff) < Math.abs(pairs[best].diff)) best = i;
  const growth = Math.exp(o.r * o.tYears);
  const est = pairs.slice(Math.max(0, best - 1), best + 2).map((q) => q.k + q.diff * growth).sort((a, b) => a - b);
  return { forward: est[Math.floor(est.length / 2)], strike: pairs[best].k };
}

export interface RangeCheck {
  /** null when the contract has no traded range that day. */
  inRange: boolean | null;
  /** (price - low) / (high - low): below 0 under the low, above 1 over the high. */
  position: number | null;
  /** price / VWAP - 1. */
  vsVwap: number | null;
  low: number | null;
  high: number | null;
}

/** Whether `price` lies inside the contract's traded day range (half a tick of tolerance). */
export function dayRangeCheck(row: BhavRow | undefined, price: number, tick = 0.05): RangeCheck {
  if (!row || row.contracts <= 0 || row.low === null || row.high === null) {
    return { inRange: null, position: null, vsVwap: null, low: row?.low ?? null, high: row?.high ?? null };
  }
  const { low, high } = row;
  const inRange = price >= low - tick / 2 && price <= high + tick / 2;
  const position = high > low ? (price - low) / (high - low) : price === low ? 0.5 : price > low ? 1.5 : -0.5;
  return { inRange, position, vsVwap: row.vwap ? price / row.vwap - 1 : null, low, high };
}

/** Option contracts traded on a date for a symbol (a proxy for session length). */
export function sessionContracts(book: RealPriceBook, symbol: string, date: string): number {
  let n = 0;
  for (const r of book.rows(symbol, date)) if (r.kind === "OPT") n += r.contracts;
  return n;
}

/**
 * Sessions whose option volume is below `ratio` times the quietest of the `window` sessions on
 * either side: short special sessions (Muhurat trading, disaster-recovery drills) whose open and
 * close are not comparable with regular days. Use NIFTY: its volume has a mild weekly cycle, while
 * SENSEX volume is concentrated on expiry days and gives false positives.
 */
export function shortSessions(book: RealPriceBook, symbol: string, ratio = 0.3, window = 3): string[] {
  const dates = book.dates(symbol);
  const vols = dates.map((d) => sessionContracts(book, symbol, d));
  const out: string[] = [];
  dates.forEach((d, i) => {
    const around = [...vols.slice(Math.max(0, i - window), i), ...vols.slice(i + 1, i + 1 + window)];
    if (around.length === 0) return;
    if (vols[i] < ratio * Math.min(...around)) out.push(d);
  });
  return out;
}

/** Weekdays in [from, to] without a session in `tradingDates` (exchange holidays, for a TradingCalendar). */
export function inferHolidays(tradingDates: Iterable<string>, from: string, to: string): string[] {
  const open = new Set(tradingDates);
  const out: string[] = [];
  for (let d = from; d <= to; d = nextDay(d)) if (isWeekday(d) && !open.has(d)) out.push(d);
  return out;
}

/** Reads cache files by relative path (bytes or null when absent). */
export interface BhavcopyReader {
  read(path: string): Promise<Uint8Array | null>;
}

/**
 * Loads the compact extracts for every calendar date in [from, to] (inclusive) that exists in the
 * cache, for the given exchanges, into a RealPriceBook. `filter` keeps only the rows it accepts
 * (e.g. near expiries of two underlyings, to bound memory over many years).
 */
export async function loadRealPriceBook(
  reader: BhavcopyReader,
  o: { from: string; to: string; exchanges?: BhavExchange[]; filter?: (r: BhavRow) => boolean },
): Promise<{ book: RealPriceBook; loaded: Record<BhavExchange, string[]> }> {
  const book = new RealPriceBook();
  const loaded: Record<BhavExchange, string[]> = { NSE: [], BSE: [] };
  for (const exchange of o.exchanges ?? (["NSE", "BSE"] as BhavExchange[])) {
    for (let d = o.from; d <= o.to; d = nextDay(d)) {
      const bytes = await reader.read(cachePath(exchange, d));
      if (!bytes) continue;
      const rows = parseCompactCsv(new TextDecoder().decode(await gunzip(bytes)));
      book.add(o.filter ? rows.filter(o.filter) : rows);
      loaded[exchange].push(d);
    }
  }
  return { book, loaded };
}
