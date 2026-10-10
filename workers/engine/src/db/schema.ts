/**
 * D1 schema. Each table keeps the full engine object as JSON (so the domain types can evolve
 * without migrations) plus the indexed columns the queries need.
 */
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const articles = sqliteTable(
  "articles",
  {
    id: text("id").primaryKey(),
    publishedMs: integer("published_ms").notNull(),
    ingestedMs: integer("ingested_ms").notNull(),
    source: text("source").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    json: text("json").notNull(),
  },
  (t) => [index("articles_published").on(t.publishedMs)],
);

export const clusters = sqliteTable(
  "clusters",
  {
    id: text("id").primaryKey(),
    key: text("key"),
    status: text("status").notNull(),
    firstSeenMs: integer("first_seen_ms").notNull(),
    lastSeenMs: integer("last_seen_ms").notNull(),
    json: text("json").notNull(),
  },
  (t) => [index("clusters_last_seen").on(t.lastSeenMs), index("clusters_status").on(t.status, t.lastSeenMs), index("clusters_key").on(t.key)],
);

export const eventScores = sqliteTable(
  "event_scores",
  {
    clusterId: text("cluster_id").primaryKey(),
    clusterKey: text("cluster_key").notNull(),
    firstSeenMs: integer("first_seen_ms").notNull(),
    scoredAtMs: integer("scored_at_ms").notNull(),
    scorer: text("scorer").notNull(),
    taxonomy: text("taxonomy").notNull(),
    niftyNumeric: real("nifty_numeric").notNull(),
    sensexNumeric: real("sensex_numeric").notNull(),
    json: text("json").notNull(),
  },
  (t) => [index("event_scores_first_seen").on(t.firstSeenMs), index("event_scores_scored_at").on(t.scoredAtMs)],
);

export const pressure = sqliteTable(
  "pressure",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    indexId: text("index_id").notNull(),
    t: integer("t").notNull(),
    epi: real("epi").notNull(),
    json: text("json").notNull(),
  },
  (t) => [index("pressure_index_t").on(t.indexId, t.t)],
);

export const snapshots = sqliteTable("snapshots", {
  t: integer("t").primaryKey(),
  json: text("json").notNull(),
});

export const decisions = sqliteTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    indexId: text("index_id").notNull(),
    t: integer("t").notNull(),
    stance: text("stance").notNull(),
    hasPlan: integer("has_plan", { mode: "boolean" }).notNull(),
    json: text("json").notNull(),
  },
  (t) => [index("decisions_t").on(t.t), index("decisions_index_t").on(t.indexId, t.t)],
);

export const outcomes = sqliteTable(
  "outcomes",
  {
    decisionId: text("decision_id").primaryKey(),
    t: integer("t").notNull(),
    json: text("json").notNull(),
  },
  (t) => [index("outcomes_t").on(t.t)],
);

export const plans = sqliteTable("plans", {
  id: text("id").primaryKey(),
  t: integer("t").notNull(),
  indexId: text("index_id").notNull(),
  json: text("json").notNull(),
});

export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    refId: text("ref_id").notNull(),
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    createdMs: integer("created_ms").notNull(),
    json: text("json").notNull(),
  },
  (t) => [uniqueIndex("orders_ref").on(t.refId), index("orders_mode_status").on(t.mode, t.status), index("orders_created").on(t.createdMs)],
);

export const fills = sqliteTable(
  "fills",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    t: integer("t").notNull(),
    json: text("json").notNull(),
  },
  (t) => [index("fills_order").on(t.orderId), index("fills_t").on(t.t)],
);

export const positions = sqliteTable(
  "positions",
  {
    id: text("id").primaryKey(),
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    indexId: text("index_id").notNull(),
    exitMs: integer("exit_ms"),
    json: text("json").notNull(),
  },
  (t) => [index("positions_mode_status").on(t.mode, t.status), index("positions_exit").on(t.mode, t.exitMs)],
);

export const trades = sqliteTable(
  "trades",
  {
    positionId: text("position_id").primaryKey(),
    mode: text("mode").notNull(),
    exitMs: integer("exit_ms").notNull(),
    json: text("json").notNull(),
  },
  (t) => [index("trades_mode_exit").on(t.mode, t.exitMs)],
);

export const performance = sqliteTable(
  "performance",
  {
    mode: text("mode").notNull(),
    source: text("source").notNull(),
    indexId: text("index_id").notNull(),
    json: text("json").notNull(),
  },
  (t) => [primaryKey({ columns: [t.mode, t.source, t.indexId] })],
);

export const ledger = sqliteTable(
  "ledger",
  {
    mode: text("mode").notNull(),
    date: text("date").notNull(),
    json: text("json").notNull(),
  },
  (t) => [primaryKey({ columns: [t.mode, t.date] })],
);

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  json: text("json").notNull(),
});

export const kvState = sqliteTable("kv_state", {
  key: text("key").primaryKey(),
  json: text("json").notNull(),
  updatedMs: integer("updated_ms").notNull(),
});

export const audit = sqliteTable(
  "audit",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    json: text("json").notNull(),
  },
  (t) => [index("audit_ts").on(t.ts)],
);

export const heartbeat = sqliteTable("heartbeat", {
  id: integer("id").primaryKey(),
  json: text("json").notNull(),
});

/**
 * Private archive of settled 5-minute bars (Yahoo serves only the last ~60 days of them). Append-only:
 * rows are written with INSERT OR IGNORE and never updated or pruned (docs/DATA.md).
 */
export const bars5m = sqliteTable(
  "bars_5m",
  {
    /** Yahoo symbol, e.g. "^NSEI" or "ES=F" (MARKET_SYMBOLS). */
    symbol: text("symbol").notNull(),
    /** Bar open time, epoch ms. */
    t: integer("t").notNull(),
    o: real("o").notNull(),
    h: real("h").notNull(),
    l: real("l").notNull(),
    c: real("c").notNull(),
    v: integer("v").notNull(),
    oi: integer("oi"),
    /** Writer that archived the bar first: "yahoo:engine" (nightly job) or "yahoo:fetch-history" (back-fill). */
    source: text("source").notNull(),
    /** When the bar was first archived (epoch ms). */
    firstSeenMs: integer("first_seen_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.t] })],
);

/**
 * Live option quotes recorded by the trading DO for the 09:15 straddle-sale question (read-only: no
 * orders; reports/wp11-real-intraday.md §9, docs/DATA.md). One row per contract per snapshot, written
 * with INSERT OR IGNORE and never updated or pruned. Prices are rupees per unit; NULL means Groww did
 * not send the field (or sent zero).
 */
export const optionQuotes = sqliteTable(
  "option_quotes",
  {
    /** When the snapshot started (epoch ms); every row of one snapshot shares it. */
    snapshotMs: integer("snapshot_ms").notNull(),
    /** "open" (every tick 09:15:00-09:31:00 IST), "09:45", "10:15", "11:15", "15:00", "15:20" or "manual" (POST /ops/quotes-snapshot). */
    slot: text("slot").notNull(),
    indexId: text("index_id").notNull(),
    /** Contract expiry, YYYY-MM-DD. */
    expiry: text("expiry").notNull(),
    /** "next": the nearest weekly expiry that is not today's; "expiring": the contract expiring today. */
    expiryKind: text("expiry_kind").notNull(),
    strike: real("strike").notNull(),
    /** "CE" or "PE". */
    optionType: text("option_type").notNull(),
    tradingSymbol: text("trading_symbol").notNull(),
    /** Lot size from the instrument master, for per-lot figures. */
    lotSize: integer("lot_size").notNull(),
    bid: real("bid"),
    ask: real("ask"),
    bidQty: integer("bid_qty"),
    askQty: integer("ask_qty"),
    ltp: real("ltp"),
    /** Exchange time of the last trade (epoch ms), when Groww sends it. */
    lastTradeMs: integer("last_trade_ms"),
    volume: integer("volume"),
    oi: integer("oi"),
    /** Top five depth levels as compact JSON {"b":[[price,qty],...],"a":[[price,qty],...]}; NULL without depth. */
    depth: text("depth"),
    /** Groww's index LTP at the start of the snapshot. */
    spot: real("spot"),
    /** When this quote arrived (epoch ms); quotes of one snapshot arrive a few hundred ms apart. */
    fetchedMs: integer("fetched_ms").notNull(),
    /** Writer, e.g. "groww:live-data/quote". */
    source: text("source").notNull(),
    /** Row layout version (1). */
    schemaV: integer("schema_v").notNull(),
  },
  (t) => [primaryKey({ columns: [t.snapshotMs, t.tradingSymbol] })],
);
