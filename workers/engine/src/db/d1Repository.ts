/**
 * Repository on Cloudflare D1 via Drizzle. Objects are stored as JSON with indexed columns.
 * Writes that touch many rows are chunked into D1 batches.
 */
import { and, asc, desc, eq, gte, inArray, lte, notInArray, or, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { EngineConfig } from "../../../../src/engine/config";
import type { Repository } from "../../../../src/engine/ports";
import { defaultSettings } from "../../../../src/engine/settings";
import type {
  ArticleCluster,
  AuditEntry,
  DayLedger,
  EngineSettings,
  EventPressure,
  Fill,
  Heartbeat,
  NormalizedArticle,
  Order,
  PlanDecision,
  Position,
  ScoredEvent,
  SignalOutcome,
  SignalPerformance,
  SnapshotRecord,
  TradePlan,
  TradeRecord,
} from "../../../../src/engine/types";
import { TERMINAL_ORDER_STATUSES } from "../../../../src/engine/types";
import * as s from "./schema";

const parse = <T>(json: string): T => JSON.parse(json) as T;
const json = (v: unknown): string => JSON.stringify(v);

/** D1 caps bound parameters per statement; keep IN lists and batches small. */
const IN_CHUNK = 90;
const BATCH_CHUNK = 50;

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export class D1Repository implements Repository {
  readonly db: DrizzleD1Database<typeof s>;

  constructor(
    d1: D1Database,
    private readonly cfg: EngineConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.db = drizzle(d1, { schema: s });
  }

  // drizzle's batch() needs a non-empty tuple; run statements in chunks.
  private async batch(statements: unknown[]): Promise<void> {
    for (const part of chunks(statements, BATCH_CHUNK)) {
      if (part.length === 0) continue;
      await this.db.batch(part as unknown as Parameters<DrizzleD1Database<typeof s>["batch"]>[0]);
    }
  }

  articles: Repository["articles"] = {
    knownIds: async (ids) => {
      const found = new Set<string>();
      for (const part of chunks([...new Set(ids)], IN_CHUNK)) {
        const rows = await this.db.select({ id: s.articles.id }).from(s.articles).where(inArray(s.articles.id, part));
        for (const r of rows) found.add(r.id);
      }
      return found;
    },
    upsertMany: async (articles: NormalizedArticle[]) => {
      await this.batch(
        articles.map((a) =>
          this.db
            .insert(s.articles)
            .values({ id: a.id, publishedMs: a.publishedMs, ingestedMs: a.ingestedMs, source: a.source, title: a.title.slice(0, 500), url: a.url, json: json(a) })
            .onConflictDoNothing(),
        ),
      );
    },
    byIds: async (ids) => {
      const out: NormalizedArticle[] = [];
      for (const part of chunks(ids, IN_CHUNK)) {
        const rows = await this.db.select({ json: s.articles.json }).from(s.articles).where(inArray(s.articles.id, part));
        out.push(...rows.map((r) => parse<NormalizedArticle>(r.json)));
      }
      return out;
    },
  };

  clusters: Repository["clusters"] = {
    upsertMany: async (clusters: ArticleCluster[]) => {
      await this.batch(
        clusters.map((c) => {
          const row = { id: c.id, key: c.key ?? null, status: c.status, firstSeenMs: c.firstSeenMs, lastSeenMs: c.lastSeenMs, json: json(c) };
          return this.db.insert(s.clusters).values(row).onConflictDoUpdate({ target: s.clusters.id, set: row });
        }),
      );
    },
    active: async (sinceMs) => {
      const rows = await this.db.select({ json: s.clusters.json }).from(s.clusters).where(gte(s.clusters.lastSeenMs, sinceMs));
      return rows.map((r) => parse<ArticleCluster>(r.json));
    },
    byIds: async (ids) => {
      const out: ArticleCluster[] = [];
      for (const part of chunks(ids, IN_CHUNK)) {
        const rows = await this.db.select({ json: s.clusters.json }).from(s.clusters).where(inArray(s.clusters.id, part));
        out.push(...rows.map((r) => parse<ArticleCluster>(r.json)));
      }
      return out;
    },
    byKey: async (key) => {
      const rows = await this.db.select({ json: s.clusters.json }).from(s.clusters).where(eq(s.clusters.key, key)).orderBy(asc(s.clusters.firstSeenMs)).limit(1);
      return rows[0] ? parse<ArticleCluster>(rows[0].json) : null;
    },
    needingScore: async (limit) => {
      const rows = await this.db
        .select({ json: s.clusters.json })
        .from(s.clusters)
        .where(or(eq(s.clusters.status, "UNSCORED"), eq(s.clusters.status, "RESCORE")))
        .orderBy(desc(s.clusters.lastSeenMs))
        .limit(limit);
      return rows.map((r) => parse<ArticleCluster>(r.json));
    },
    deleteMany: async (ids) => {
      for (const part of chunks(ids, IN_CHUNK)) await this.db.delete(s.clusters).where(inArray(s.clusters.id, part));
    },
  };

  events: Repository["events"] = {
    upsertMany: async (events: ScoredEvent[]) => {
      await this.batch(
        events.map((e) => {
          const row = {
            clusterId: e.clusterId,
            clusterKey: e.clusterKey,
            firstSeenMs: e.firstSeenMs,
            scoredAtMs: e.scoredAtMs,
            scorer: e.scorer,
            taxonomy: e.taxonomy,
            niftyNumeric: e.numeric.NIFTY,
            sensexNumeric: e.numeric.SENSEX,
            json: json(e),
          };
          return this.db.insert(s.eventScores).values(row).onConflictDoUpdate({ target: s.eventScores.clusterId, set: row });
        }),
      );
    },
    active: async (sinceMs) => {
      const rows = await this.db.select({ json: s.eventScores.json }).from(s.eventScores).where(gte(s.eventScores.firstSeenMs, sinceMs));
      return rows.map((r) => parse<ScoredEvent>(r.json));
    },
    byClusterIds: async (ids) => {
      const out: ScoredEvent[] = [];
      for (const part of chunks(ids, IN_CHUNK)) {
        const rows = await this.db.select({ json: s.eventScores.json }).from(s.eventScores).where(inArray(s.eventScores.clusterId, part));
        out.push(...rows.map((r) => parse<ScoredEvent>(r.json)));
      }
      return out;
    },
    deleteByClusterIds: async (ids) => {
      for (const part of chunks(ids, IN_CHUNK)) await this.db.delete(s.eventScores).where(inArray(s.eventScores.clusterId, part));
    },
  };

  pressure: Repository["pressure"] = {
    append: async (p: EventPressure) => {
      await this.db.insert(s.pressure).values({ indexId: p.index, t: p.t, epi: p.epi, json: json(p) });
    },
    latest: async (index) => {
      const rows = await this.db.select({ json: s.pressure.json }).from(s.pressure).where(eq(s.pressure.indexId, index)).orderBy(desc(s.pressure.t)).limit(1);
      return rows[0] ? parse<EventPressure>(rows[0].json) : null;
    },
  };

  snapshots: Repository["snapshots"] = {
    append: async (rec: SnapshotRecord) => {
      await this.db.insert(s.snapshots).values({ t: rec.t, json: json(rec) }).onConflictDoUpdate({ target: s.snapshots.t, set: { json: json(rec) } });
    },
    latest: async () => {
      const rows = await this.db.select({ json: s.snapshots.json }).from(s.snapshots).orderBy(desc(s.snapshots.t)).limit(1);
      return rows[0] ? parse<SnapshotRecord>(rows[0].json) : null;
    },
    between: async (fromMs, toMs) => {
      const rows = await this.db.select({ json: s.snapshots.json }).from(s.snapshots).where(and(gte(s.snapshots.t, fromMs), lte(s.snapshots.t, toMs))).orderBy(asc(s.snapshots.t));
      return rows.map((r) => parse<SnapshotRecord>(r.json));
    },
  };

  decisions: Repository["decisions"] = {
    append: async (d: PlanDecision) => {
      await this.db
        .insert(s.decisions)
        .values({ id: d.id, indexId: d.index, t: d.t, stance: d.conviction.stance, hasPlan: d.plan !== null, json: json(d) })
        .onConflictDoNothing();
    },
    latest: async (index) => {
      const rows = await this.db.select({ json: s.decisions.json }).from(s.decisions).where(eq(s.decisions.indexId, index)).orderBy(desc(s.decisions.t)).limit(1);
      return rows[0] ? parse<PlanDecision>(rows[0].json) : null;
    },
    between: async (fromMs, toMs) => {
      const rows = await this.db.select({ json: s.decisions.json }).from(s.decisions).where(and(gte(s.decisions.t, fromMs), lte(s.decisions.t, toMs))).orderBy(asc(s.decisions.t));
      return rows.map((r) => parse<PlanDecision>(r.json));
    },
  };

  outcomes: Repository["outcomes"] = {
    upsertMany: async (rows: SignalOutcome[]) => {
      await this.batch(
        rows.map((o) =>
          this.db.insert(s.outcomes).values({ decisionId: o.decisionId, t: o.t, json: json(o) }).onConflictDoUpdate({ target: s.outcomes.decisionId, set: { json: json(o) } }),
        ),
      );
    },
    between: async (fromMs, toMs) => {
      const rows = await this.db.select({ json: s.outcomes.json }).from(s.outcomes).where(and(gte(s.outcomes.t, fromMs), lte(s.outcomes.t, toMs)));
      return rows.map((r) => parse<SignalOutcome>(r.json));
    },
  };

  plans: Repository["plans"] = {
    save: async (p: TradePlan) => {
      await this.db.insert(s.plans).values({ id: p.id, t: p.t, indexId: p.index, json: json(p) }).onConflictDoUpdate({ target: s.plans.id, set: { json: json(p) } });
    },
    get: async (id) => {
      const rows = await this.db.select({ json: s.plans.json }).from(s.plans).where(eq(s.plans.id, id)).limit(1);
      return rows[0] ? parse<TradePlan>(rows[0].json) : null;
    },
  };

  orders: Repository["orders"] = {
    save: async (o: Order) => {
      const row = { id: o.id, refId: o.refId, mode: o.mode, status: o.status, createdMs: o.createdMs, json: json(o) };
      await this.db.insert(s.orders).values(row).onConflictDoUpdate({ target: s.orders.id, set: row });
    },
    get: async (id) => {
      const rows = await this.db.select({ json: s.orders.json }).from(s.orders).where(eq(s.orders.id, id)).limit(1);
      return rows[0] ? parse<Order>(rows[0].json) : null;
    },
    byRefId: async (refId) => {
      const rows = await this.db.select({ json: s.orders.json }).from(s.orders).where(eq(s.orders.refId, refId)).limit(1);
      return rows[0] ? parse<Order>(rows[0].json) : null;
    },
    open: async (mode) => {
      const rows = await this.db
        .select({ json: s.orders.json })
        .from(s.orders)
        .where(and(eq(s.orders.mode, mode), notInArray(s.orders.status, [...TERMINAL_ORDER_STATUSES])));
      return rows.map((r) => parse<Order>(r.json));
    },
    between: async (fromMs, toMs, mode) => {
      const cond = mode
        ? and(gte(s.orders.createdMs, fromMs), lte(s.orders.createdMs, toMs), eq(s.orders.mode, mode))
        : and(gte(s.orders.createdMs, fromMs), lte(s.orders.createdMs, toMs));
      const rows = await this.db.select({ json: s.orders.json }).from(s.orders).where(cond).orderBy(asc(s.orders.createdMs));
      return rows.map((r) => parse<Order>(r.json));
    },
  };

  fills: Repository["fills"] = {
    append: async (f: Fill) => {
      await this.db.insert(s.fills).values({ id: f.id, orderId: f.orderId, t: f.t, json: json(f) }).onConflictDoNothing();
    },
    forOrder: async (orderId) => {
      const rows = await this.db.select({ json: s.fills.json }).from(s.fills).where(eq(s.fills.orderId, orderId)).orderBy(asc(s.fills.t));
      return rows.map((r) => parse<Fill>(r.json));
    },
    between: async (fromMs, toMs) => {
      const rows = await this.db.select({ json: s.fills.json }).from(s.fills).where(and(gte(s.fills.t, fromMs), lte(s.fills.t, toMs))).orderBy(asc(s.fills.t));
      return rows.map((r) => parse<Fill>(r.json));
    },
  };

  positions: Repository["positions"] = {
    save: async (p: Position) => {
      const row = { id: p.id, mode: p.mode, status: p.status, indexId: p.index, exitMs: p.exitMs ?? null, json: json(p) };
      await this.db.insert(s.positions).values(row).onConflictDoUpdate({ target: s.positions.id, set: row });
    },
    get: async (id) => {
      const rows = await this.db.select({ json: s.positions.json }).from(s.positions).where(eq(s.positions.id, id)).limit(1);
      return rows[0] ? parse<Position>(rows[0].json) : null;
    },
    open: async (mode) => {
      const rows = await this.db.select({ json: s.positions.json }).from(s.positions).where(and(eq(s.positions.mode, mode), eq(s.positions.status, "OPEN")));
      return rows.map((r) => parse<Position>(r.json));
    },
    closedBetween: async (fromMs, toMs, mode) => {
      const rows = await this.db
        .select({ json: s.positions.json })
        .from(s.positions)
        .where(and(eq(s.positions.mode, mode), eq(s.positions.status, "CLOSED"), gte(s.positions.exitMs, fromMs), lte(s.positions.exitMs, toMs)));
      return rows.map((r) => parse<Position>(r.json));
    },
  };

  trades: Repository["trades"] = {
    append: async (t: TradeRecord) => {
      await this.db.insert(s.trades).values({ positionId: t.positionId, mode: t.mode, exitMs: t.exitMs, json: json(t) }).onConflictDoNothing();
    },
    recent: async (n, mode) => {
      const rows = await this.db.select({ json: s.trades.json }).from(s.trades).where(eq(s.trades.mode, mode)).orderBy(desc(s.trades.exitMs)).limit(n);
      return rows.map((r) => parse<TradeRecord>(r.json));
    },
    between: async (fromMs, toMs, mode) => {
      const rows = await this.db
        .select({ json: s.trades.json })
        .from(s.trades)
        .where(and(eq(s.trades.mode, mode), gte(s.trades.exitMs, fromMs), lte(s.trades.exitMs, toMs)))
        .orderBy(asc(s.trades.exitMs));
      return rows.map((r) => parse<TradeRecord>(r.json));
    },
  };

  perf: Repository["perf"] = {
    all: async (mode) => {
      const rows = await this.db.select({ json: s.performance.json }).from(s.performance).where(eq(s.performance.mode, mode));
      return rows.map((r) => parse<SignalPerformance>(r.json));
    },
    upsertMany: async (rows: SignalPerformance[]) => {
      await this.batch(
        rows.map((p) =>
          this.db
            .insert(s.performance)
            .values({ mode: p.mode, source: p.source, indexId: p.index, json: json(p) })
            .onConflictDoUpdate({ target: [s.performance.mode, s.performance.source, s.performance.indexId], set: { json: json(p) } }),
        ),
      );
    },
  };

  ledger: Repository["ledger"] = {
    get: async (date, mode) => {
      const rows = await this.db.select({ json: s.ledger.json }).from(s.ledger).where(and(eq(s.ledger.mode, mode), eq(s.ledger.date, date))).limit(1);
      return rows[0] ? parse<DayLedger>(rows[0].json) : null;
    },
    save: async (l: DayLedger) => {
      await this.db
        .insert(s.ledger)
        .values({ mode: l.mode, date: l.date, json: json(l) })
        .onConflictDoUpdate({ target: [s.ledger.mode, s.ledger.date], set: { json: json(l) } });
    },
    range: async (fromDate, toDate, mode) => {
      const rows = await this.db
        .select({ json: s.ledger.json })
        .from(s.ledger)
        .where(and(eq(s.ledger.mode, mode), gte(s.ledger.date, fromDate), lte(s.ledger.date, toDate)))
        .orderBy(asc(s.ledger.date));
      return rows.map((r) => parse<DayLedger>(r.json));
    },
  };

  settings: Repository["settings"] = {
    get: async () => {
      const rows = await this.db.select({ json: s.settings.json }).from(s.settings).where(eq(s.settings.id, 1)).limit(1);
      if (rows[0]) return parse<EngineSettings>(rows[0].json);
      const d = defaultSettings(this.cfg, this.now());
      await this.db.insert(s.settings).values({ id: 1, json: json(d) }).onConflictDoNothing();
      return d;
    },
    update: async (patch, by) => {
      const cur = await this.settings.get();
      const next: EngineSettings = { ...cur, ...patch, updatedBy: by, updatedMs: this.now() };
      await this.db.insert(s.settings).values({ id: 1, json: json(next) }).onConflictDoUpdate({ target: s.settings.id, set: { json: json(next) } });
      return next;
    },
  };

  state: Repository["state"] = {
    get: async <T>(key: string) => {
      const rows = await this.db.select({ json: s.kvState.json }).from(s.kvState).where(eq(s.kvState.key, key)).limit(1);
      return rows[0] ? parse<T>(rows[0].json) : null;
    },
    set: async <T>(key: string, value: T) => {
      const row = { key, json: json(value), updatedMs: this.now() };
      await this.db.insert(s.kvState).values(row).onConflictDoUpdate({ target: s.kvState.key, set: row });
    },
  };

  audit: Repository["audit"] = {
    append: async (e: AuditEntry) => {
      await this.db.insert(s.audit).values({ ts: e.ts, actor: e.actor, action: e.action, json: json(e) });
    },
    recent: async (n) => {
      const rows = await this.db.select({ json: s.audit.json }).from(s.audit).orderBy(desc(s.audit.ts)).limit(n);
      return rows.map((r) => parse<AuditEntry>(r.json));
    },
  };

  heartbeat: Repository["heartbeat"] = {
    write: async (h: Heartbeat) => {
      await this.db.insert(s.heartbeat).values({ id: 1, json: json(h) }).onConflictDoUpdate({ target: s.heartbeat.id, set: { json: json(h) } });
    },
    read: async () => {
      const rows = await this.db.select({ json: s.heartbeat.json }).from(s.heartbeat).where(eq(s.heartbeat.id, 1)).limit(1);
      return rows[0] ? parse<Heartbeat>(rows[0].json) : null;
    },
  };

  /** Deletes old rows to keep D1 small. Returns rows deleted per table. */
  async prune(nowMs: number): Promise<Record<string, number>> {
    const day = 86_400_000;
    const out: Record<string, number> = {};
    const run = async (name: string, q: Promise<D1Result | { meta?: { changes?: number } }>) => {
      const r = (await q) as { meta?: { changes?: number } };
      out[name] = r.meta?.changes ?? 0;
    };
    await run("snapshots", this.db.delete(s.snapshots).where(lte(s.snapshots.t, nowMs - 90 * day)).run());
    await run("pressure", this.db.delete(s.pressure).where(lte(s.pressure.t, nowMs - 30 * day)).run());
    await run("articles", this.db.delete(s.articles).where(lte(s.articles.publishedMs, nowMs - 120 * day)).run());
    await run("clusters", this.db.delete(s.clusters).where(lte(s.clusters.lastSeenMs, nowMs - 120 * day)).run());
    await run("decisions", this.db.delete(s.decisions).where(and(lte(s.decisions.t, nowMs - 180 * day), eq(s.decisions.hasPlan, false))).run());
    await run("audit", this.db.delete(s.audit).where(lte(s.audit.ts, nowMs - 365 * day)).run());
    return out;
  }

  /** Row counts for health checks. */
  async counts(): Promise<Record<string, number>> {
    const tables = { clusters: s.clusters, event_scores: s.eventScores, orders: s.orders, positions: s.positions, trades: s.trades } as const;
    const out: Record<string, number> = {};
    for (const [name, table] of Object.entries(tables)) {
      const rows = await this.db.select({ n: sql<number>`count(*)` }).from(table);
      out[name] = Number(rows[0]?.n ?? 0);
    }
    return out;
  }
}
