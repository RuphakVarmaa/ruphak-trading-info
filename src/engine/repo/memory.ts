/**
 * In-memory Repository for tests, backtests and local scripts.
 * Values are deep-cloned on write and read so callers cannot mutate stored state by accident.
 */
import type { EngineConfig } from "../config";
import { DEFAULT_CONFIG } from "../config";
import type { Repository } from "../ports";
import { defaultSettings } from "../settings";
import type {
  ArticleCluster,
  AuditEntry,
  DayLedger,
  EngineSettings,
  EventPressure,
  Fill,
  Heartbeat,
  IndexId,
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
  TradingMode,
} from "../types";
import { TERMINAL_ORDER_STATUSES } from "../types";

const clone = <T>(v: T): T => (v === undefined || v === null ? v : structuredClone(v));

export class InMemoryRepository implements Repository {
  private readonly _articles = new Map<string, NormalizedArticle>();
  private readonly _clusters = new Map<string, ArticleCluster>();
  private readonly _events = new Map<string, ScoredEvent>();
  private readonly _pressure: EventPressure[] = [];
  private readonly _snapshots: SnapshotRecord[] = [];
  private readonly _decisions: PlanDecision[] = [];
  private readonly _outcomes = new Map<string, SignalOutcome>();
  private readonly _plans = new Map<string, TradePlan>();
  private readonly _orders = new Map<string, Order>();
  private readonly _fills: Fill[] = [];
  private readonly _positions = new Map<string, Position>();
  private readonly _trades: TradeRecord[] = [];
  private readonly _perf = new Map<string, SignalPerformance>();
  private readonly _ledger = new Map<string, DayLedger>();
  private _settings: EngineSettings;
  private readonly _state = new Map<string, unknown>();
  private readonly _audit: AuditEntry[] = [];
  private _heartbeat: Heartbeat | null = null;

  constructor(cfg: EngineConfig = DEFAULT_CONFIG, nowMs = 0) {
    this._settings = defaultSettings(cfg, nowMs);
  }

  articles: Repository["articles"] = {
    knownIds: async (ids) => new Set(ids.filter((id) => this._articles.has(id))),
    upsertMany: async (articles) => {
      for (const a of articles) this._articles.set(a.id, clone(a));
    },
    byIds: async (ids) => ids.map((id) => this._articles.get(id)).filter((a): a is NormalizedArticle => !!a).map(clone),
  };

  clusters: Repository["clusters"] = {
    upsertMany: async (clusters) => {
      for (const c of clusters) this._clusters.set(c.id, clone(c));
    },
    active: async (sinceMs) => [...this._clusters.values()].filter((c) => c.lastSeenMs >= sinceMs).map(clone),
    byIds: async (ids) => ids.map((id) => this._clusters.get(id)).filter((c): c is ArticleCluster => !!c).map(clone),
    byKey: async (key) => clone([...this._clusters.values()].find((c) => c.key === key) ?? null),
    needingScore: async (limit) =>
      [...this._clusters.values()]
        .filter((c) => c.status === "UNSCORED" || c.status === "RESCORE")
        .sort((a, b) => b.lastSeenMs - a.lastSeenMs)
        .slice(0, limit)
        .map(clone),
    deleteMany: async (ids) => {
      for (const id of ids) this._clusters.delete(id);
    },
  };

  events: Repository["events"] = {
    upsertMany: async (events) => {
      for (const e of events) this._events.set(e.clusterId, clone(e));
    },
    active: async (sinceMs) => [...this._events.values()].filter((e) => e.firstSeenMs >= sinceMs).map(clone),
    byClusterIds: async (ids) => ids.map((id) => this._events.get(id)).filter((e): e is ScoredEvent => !!e).map(clone),
    deleteByClusterIds: async (ids) => {
      for (const id of ids) this._events.delete(id);
    },
  };

  pressure: Repository["pressure"] = {
    append: async (p) => {
      this._pressure.push(clone(p));
    },
    latest: async (index: IndexId) => {
      for (let i = this._pressure.length - 1; i >= 0; i--) if (this._pressure[i].index === index) return clone(this._pressure[i]);
      return null;
    },
  };

  snapshots: Repository["snapshots"] = {
    append: async (s) => {
      this._snapshots.push(clone(s));
    },
    latest: async () => clone(this._snapshots[this._snapshots.length - 1] ?? null),
    between: async (fromMs, toMs) => this._snapshots.filter((s) => s.t >= fromMs && s.t <= toMs).map(clone),
  };

  decisions: Repository["decisions"] = {
    append: async (d) => {
      this._decisions.push(clone(d));
    },
    latest: async (index) => {
      for (let i = this._decisions.length - 1; i >= 0; i--) if (this._decisions[i].index === index) return clone(this._decisions[i]);
      return null;
    },
    between: async (fromMs, toMs) => this._decisions.filter((d) => d.t >= fromMs && d.t <= toMs).map(clone),
  };

  outcomes: Repository["outcomes"] = {
    upsertMany: async (rows) => {
      for (const o of rows) this._outcomes.set(o.decisionId, clone(o));
    },
    between: async (fromMs, toMs) => [...this._outcomes.values()].filter((o) => o.t >= fromMs && o.t <= toMs).map(clone),
  };

  plans: Repository["plans"] = {
    save: async (p) => {
      this._plans.set(p.id, clone(p));
    },
    get: async (id) => clone(this._plans.get(id) ?? null),
  };

  orders: Repository["orders"] = {
    save: async (o) => {
      this._orders.set(o.id, clone(o));
    },
    get: async (id) => clone(this._orders.get(id) ?? null),
    byRefId: async (refId) => clone([...this._orders.values()].find((o) => o.refId === refId) ?? null),
    open: async (mode: TradingMode) =>
      [...this._orders.values()].filter((o) => o.mode === mode && !TERMINAL_ORDER_STATUSES.includes(o.status)).map(clone),
    between: async (fromMs, toMs, mode) =>
      [...this._orders.values()]
        .filter((o) => o.createdMs >= fromMs && o.createdMs <= toMs && (!mode || o.mode === mode))
        .sort((a, b) => a.createdMs - b.createdMs)
        .map(clone),
  };

  fills: Repository["fills"] = {
    append: async (f) => {
      this._fills.push(clone(f));
    },
    forOrder: async (orderId) => this._fills.filter((f) => f.orderId === orderId).map(clone),
    between: async (fromMs, toMs) => this._fills.filter((f) => f.t >= fromMs && f.t <= toMs).map(clone),
  };

  positions: Repository["positions"] = {
    save: async (p) => {
      this._positions.set(p.id, clone(p));
    },
    get: async (id) => clone(this._positions.get(id) ?? null),
    open: async (mode) => [...this._positions.values()].filter((p) => p.status === "OPEN" && p.mode === mode).map(clone),
    closedBetween: async (fromMs, toMs, mode) =>
      [...this._positions.values()]
        .filter((p) => p.status === "CLOSED" && p.mode === mode && (p.exitMs ?? 0) >= fromMs && (p.exitMs ?? 0) <= toMs)
        .map(clone),
  };

  trades: Repository["trades"] = {
    append: async (t) => {
      this._trades.push(clone(t));
    },
    recent: async (n, mode) =>
      this._trades
        .filter((t) => t.mode === mode)
        .sort((a, b) => b.exitMs - a.exitMs)
        .slice(0, n)
        .map(clone),
    between: async (fromMs, toMs, mode) =>
      this._trades.filter((t) => t.mode === mode && t.exitMs >= fromMs && t.exitMs <= toMs).map(clone),
  };

  perf: Repository["perf"] = {
    all: async (mode) => [...this._perf.values()].filter((p) => p.mode === mode).map(clone),
    upsertMany: async (rows) => {
      for (const r of rows) this._perf.set(`${r.mode}:${r.source}:${r.index}`, clone(r));
    },
  };

  ledger: Repository["ledger"] = {
    get: async (date, mode) => clone(this._ledger.get(`${mode}:${date}`) ?? null),
    save: async (l) => {
      this._ledger.set(`${l.mode}:${l.date}`, clone(l));
    },
    range: async (fromDate, toDate, mode) =>
      [...this._ledger.values()]
        .filter((l) => l.mode === mode && l.date >= fromDate && l.date <= toDate)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(clone),
  };

  settings: Repository["settings"] = {
    get: async () => clone(this._settings),
    update: async (patch, by) => {
      this._settings = { ...this._settings, ...clone(patch), updatedBy: by, updatedMs: patch.updatedMs ?? Date.now() };
      return clone(this._settings);
    },
  };

  state: Repository["state"] = {
    get: async <T>(key: string) => clone((this._state.get(key) as T | undefined) ?? null),
    set: async <T>(key: string, value: T) => {
      this._state.set(key, clone(value));
    },
  };

  audit: Repository["audit"] = {
    append: async (e) => {
      this._audit.push(clone(e));
    },
    recent: async (n) => this._audit.slice(-n).reverse().map(clone),
  };

  heartbeat: Repository["heartbeat"] = {
    write: async (h) => {
      this._heartbeat = clone(h);
    },
    read: async () => clone(this._heartbeat),
  };
}
