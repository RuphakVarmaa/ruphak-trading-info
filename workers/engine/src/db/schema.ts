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
