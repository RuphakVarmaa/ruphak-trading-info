// Local SQLite ledger (node:sqlite, no native dependencies): every order decision, replay
// nonces, the cached Groww access token, and an append-only event log.
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Clock } from "./clock.js";

export type OrderDecision = "REJECTED" | "PENDING" | "ACCEPTED" | "BROKER_REJECTED" | "UNKNOWN";
export type OrderSource = "API" | "PANIC";

export interface StoredToken {
  token: string;
  expiresAt: number;
  mintedAt: number;
}

export interface NewOrder {
  idempotencyKey: string;
  source: OrderSource;
  istDate: string;
  underlying: string | null;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  side: "BUY" | "SELL";
  qty: number;
  lotSize: number | null;
  orderType: string;
  price: number | null;
  product: string;
  validity: string;
  premiumInr: number | null;
  isExit: boolean;
  /** true when the request went (or may have gone) to Groww; the idempotency key is then consumed. */
  sent: boolean;
  status: OrderDecision;
  reason: string | null;
  violations: string[];
  growwOrderId: string | null;
  orderStatus: string | null;
  request: unknown;
  response: unknown;
}

export interface OrderRow extends NewOrder {
  id: number;
  createdAt: number;
  updatedAt: number;
}

export type OrderPatch = Partial<
  Pick<NewOrder, "status" | "reason" | "growwOrderId" | "orderStatus" | "response" | "qty" | "price" | "orderType" | "premiumInr" | "sent">
>;

export interface LedgerEvent {
  id: number;
  ts: number;
  type: string;
  detail: unknown;
}

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ist_date TEXT NOT NULL,
  underlying TEXT,
  trading_symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  segment TEXT NOT NULL,
  side TEXT NOT NULL,
  qty INTEGER NOT NULL,
  lot_size INTEGER,
  order_type TEXT NOT NULL,
  price REAL,
  product TEXT NOT NULL,
  validity TEXT NOT NULL,
  premium_inr REAL,
  is_exit INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  violations_json TEXT,
  groww_order_id TEXT,
  order_status TEXT,
  request_json TEXT NOT NULL,
  response_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_sent_key ON orders(idempotency_key) WHERE sent = 1;
CREATE INDEX IF NOT EXISTS orders_day ON orders(ist_date, sent);
CREATE INDEX IF NOT EXISTS orders_groww_id ON orders(groww_order_id);
CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nonces_seen ON nonces(seen_at);
CREATE TABLE IF NOT EXISTS token (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  minted_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS events_type_ts ON events(type, ts);
`;

type Row = Record<string, unknown>;

function toJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: String(value) });
  }
}

function fromJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function rowToOrder(r: Row): OrderRow {
  const violations = fromJson(r.violations_json);
  return {
    id: num(r.id),
    idempotencyKey: String(r.idempotency_key),
    source: String(r.source) as OrderSource,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    istDate: String(r.ist_date),
    underlying: strOrNull(r.underlying),
    tradingSymbol: String(r.trading_symbol),
    exchange: String(r.exchange),
    segment: String(r.segment),
    side: String(r.side) as "BUY" | "SELL",
    qty: num(r.qty),
    lotSize: numOrNull(r.lot_size),
    orderType: String(r.order_type),
    price: numOrNull(r.price),
    product: String(r.product),
    validity: String(r.validity),
    premiumInr: numOrNull(r.premium_inr),
    isExit: num(r.is_exit) === 1,
    sent: num(r.sent) === 1,
    status: String(r.status) as OrderDecision,
    reason: strOrNull(r.reason),
    violations: Array.isArray(violations) ? violations.map(String) : [],
    growwOrderId: strOrNull(r.groww_order_id),
    orderStatus: strOrNull(r.order_status),
    request: fromJson(r.request_json),
    response: fromJson(r.response_json),
  };
}

export class Ledger {
  private readonly db: DatabaseSync;
  private lastNoncePrune = 0;

  constructor(
    readonly path: string,
    private readonly clock: Clock,
  ) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") {
      try {
        chmodSync(path, 0o600); // the token table holds a live access token
      } catch {
        // best effort (e.g. filesystems without POSIX permissions)
      }
    }
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    const version = num((this.db.prepare("PRAGMA user_version").get() as Row | undefined)?.user_version);
    if (version > SCHEMA_VERSION) {
      throw new Error(`ledger schema version ${version} is newer than this relay (${SCHEMA_VERSION})`);
    }
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  // ---- replay protection -------------------------------------------------------------

  /** Records `nonce`; returns false when it was already seen within `ttlMs`. */
  claimNonce(nonce: string, nowMs: number, ttlMs: number): boolean {
    if (nowMs - this.lastNoncePrune > 30_000) {
      this.db.prepare("DELETE FROM nonces WHERE seen_at < ?").run(nowMs - ttlMs);
      this.lastNoncePrune = nowMs;
    }
    const res = this.db
      .prepare(
        "INSERT INTO nonces (nonce, seen_at) VALUES (?, ?) ON CONFLICT(nonce) DO UPDATE SET seen_at = excluded.seen_at WHERE nonces.seen_at < ?",
      )
      .run(nonce, nowMs, nowMs - ttlMs);
    return num(res.changes) === 1;
  }

  // ---- Groww access token (TokenStore) -----------------------------------------------

  loadToken(): StoredToken | null {
    const r = this.db.prepare("SELECT token, expires_at, minted_at FROM token WHERE id = 1").get() as Row | undefined;
    if (!r) return null;
    return { token: String(r.token), expiresAt: num(r.expires_at), mintedAt: num(r.minted_at) };
  }

  saveToken(t: StoredToken): void {
    this.db
      .prepare(
        "INSERT INTO token (id, token, expires_at, minted_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at, minted_at = excluded.minted_at",
      )
      .run(t.token, t.expiresAt, t.mintedAt);
  }

  clearToken(): void {
    this.db.prepare("DELETE FROM token WHERE id = 1").run();
  }

  recordMint(ok: boolean, detail: Record<string, unknown>): void {
    this.event("token_mint", { ok, ...detail });
  }

  countMintsSince(ms: number): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'token_mint' AND ts >= ?").get(ms) as Row | undefined;
    return num(r?.n);
  }

  // ---- orders ------------------------------------------------------------------------

  insertOrder(o: NewOrder): number {
    const now = this.clock.now();
    const res = this.db
      .prepare(
        `INSERT INTO orders (idempotency_key, source, created_at, updated_at, ist_date, underlying, trading_symbol, exchange, segment, side, qty, lot_size, order_type, price, product, validity, premium_inr, is_exit, sent, status, reason, violations_json, groww_order_id, order_status, request_json, response_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.idempotencyKey,
        o.source,
        now,
        now,
        o.istDate,
        o.underlying,
        o.tradingSymbol,
        o.exchange,
        o.segment,
        o.side,
        o.qty,
        o.lotSize,
        o.orderType,
        o.price,
        o.product,
        o.validity,
        o.premiumInr,
        o.isExit ? 1 : 0,
        o.sent ? 1 : 0,
        o.status,
        o.reason,
        toJson(o.violations),
        o.growwOrderId,
        o.orderStatus,
        toJson(o.request) ?? "null",
        toJson(o.response),
      );
    return num(res.lastInsertRowid);
  }

  updateOrder(id: number, patch: OrderPatch): void {
    const cols: string[] = [];
    const vals: (string | number | null)[] = [];
    const set = (col: string, v: string | number | null) => {
      cols.push(`${col} = ?`);
      vals.push(v);
    };
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.reason !== undefined) set("reason", patch.reason);
    if (patch.growwOrderId !== undefined) set("groww_order_id", patch.growwOrderId);
    if (patch.orderStatus !== undefined) set("order_status", patch.orderStatus);
    if (patch.response !== undefined) set("response_json", toJson(patch.response));
    if (patch.qty !== undefined) set("qty", patch.qty);
    if (patch.price !== undefined) set("price", patch.price);
    if (patch.orderType !== undefined) set("order_type", patch.orderType);
    if (patch.premiumInr !== undefined) set("premium_inr", patch.premiumInr);
    if (patch.sent !== undefined) set("sent", patch.sent ? 1 : 0);
    set("updated_at", this.clock.now());
    this.db.prepare(`UPDATE orders SET ${cols.join(", ")} WHERE id = ?`).run(...vals, id);
  }

  getOrder(id: number): OrderRow | null {
    const r = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToOrder(r) : null;
  }

  /** The order that consumed `idempotencyKey` (sent to Groww), if any. */
  findSentOrder(idempotencyKey: string): OrderRow | null {
    const r = this.db.prepare("SELECT * FROM orders WHERE idempotency_key = ? AND sent = 1").get(idempotencyKey) as Row | undefined;
    return r ? rowToOrder(r) : null;
  }

  findOrderByGrowwId(growwOrderId: string): OrderRow | null {
    const r = this.db
      .prepare("SELECT * FROM orders WHERE groww_order_id = ? AND sent = 1 ORDER BY id DESC LIMIT 1")
      .get(growwOrderId) as Row | undefined;
    return r ? rowToOrder(r) : null;
  }

  /** Orders sent to Groww on an IST date (every outcome counts, conservatively). */
  countSentOrders(istDate: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE ist_date = ? AND sent = 1").get(istDate) as Row | undefined;
    return num(r?.n);
  }

  /** Cumulative BUY premium committed on an IST date (everything sent except broker rejections). */
  buyPremium(istDate: string): number {
    const r = this.db
      .prepare(
        "SELECT COALESCE(SUM(premium_inr), 0) AS p FROM orders WHERE ist_date = ? AND sent = 1 AND side = 'BUY' AND status != 'BROKER_REJECTED'",
      )
      .get(istDate) as Row | undefined;
    return num(r?.p);
  }

  listOrders(istDate?: string): OrderRow[] {
    const rows = (
      istDate === undefined
        ? this.db.prepare("SELECT * FROM orders ORDER BY id").all()
        : this.db.prepare("SELECT * FROM orders WHERE ist_date = ? ORDER BY id").all(istDate)
    ) as Row[];
    return rows.map(rowToOrder);
  }

  /** Crash recovery: a PENDING row means the process died mid-send; its outcome is unknown. */
  markPendingUnknown(): number {
    const res = this.db
      .prepare("UPDATE orders SET status = 'UNKNOWN', reason = 'relay restarted while the order was in flight', updated_at = ? WHERE status = 'PENDING'")
      .run(this.clock.now());
    return num(res.changes);
  }

  // ---- events ------------------------------------------------------------------------

  event(type: string, detail?: unknown): void {
    this.db.prepare("INSERT INTO events (ts, type, detail_json) VALUES (?, ?, ?)").run(this.clock.now(), type, toJson(detail));
  }

  events(type?: string, limit = 100): LedgerEvent[] {
    const rows = (
      type === undefined
        ? this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit)
        : this.db.prepare("SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT ?").all(type, limit)
    ) as Row[];
    return rows.map((r) => ({ id: num(r.id), ts: num(r.ts), type: String(r.type), detail: fromJson(r.detail_json) }));
  }
}
