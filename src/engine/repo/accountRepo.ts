/**
 * Repository view for one paper account. Main gets the base repository unchanged. Other accounts
 * keep their own books (orders, positions, trades, ledger) in the same tables under a stored mode
 * such as "PAPER@small10k", and read them back as "PAPER". Market data, news, signal history and
 * signal performance are shared with main (the account follows main's signals). Settings live in
 * kv: caps are always derived from the account config; only the kill switch is persisted.
 */
import { accountStateKey, bookAccount, bookMode, unbookMode, type AccountId } from "../accounts";
import { HOUR_MS } from "../clock";
import type { EngineConfig } from "../config";
import type { Repository } from "../ports";
import { defaultSettings } from "../settings";
import type { EngineSettings, IndexId, PlanDecision, TradingMode } from "../types";

/** kv keys owned by one account; every other key (health, LLM usage, ingest cursors) is shared. */
const ACCOUNT_KEY_PREFIXES = ["decision:", "alert:"];

type Persisted = Pick<EngineSettings, "killSwitch" | "killReason" | "updatedMs" | "updatedBy">;

export function accountRepository(base: Repository, account: AccountId, cfg: EngineConfig, now: () => number): Repository {
  if (account === "main") return base;

  const stored = (mode: TradingMode) => bookMode(account, mode) as TradingMode;
  const mine = (m: string) => bookAccount(m) === account;
  const toBook = <T extends { mode: TradingMode }>(o: T): T => ({ ...o, mode: stored(o.mode) });
  const fromBook = <T extends { mode: TradingMode }>(o: T): T => ({ ...o, mode: unbookMode(o.mode) });
  const paperOnly = (mode: TradingMode, what: string) => {
    if (mode === "LIVE") throw new Error(`${account} is a paper-only account: refusing to save a LIVE ${what}`);
  };
  const stateKey = (key: string) => (ACCOUNT_KEY_PREFIXES.some((p) => key.startsWith(p)) ? accountStateKey(account, key) : key);
  const settingsKey = accountStateKey(account, "settings");
  const latestKey = (index: IndexId) => accountStateKey(account, `decision:latest:${index}`);

  const readSettings = async (): Promise<EngineSettings> => {
    const p = await base.state.get<Persisted>(settingsKey);
    const s = defaultSettings(cfg, p?.updatedMs ?? now());
    return { ...s, ...(p ?? {}), mode: "PAPER", armedUntil: null };
  };

  return {
    articles: base.articles,
    clusters: base.clusters,
    events: base.events,
    pressure: base.pressure,
    snapshots: base.snapshots,
    plans: base.plans,
    heartbeat: base.heartbeat,
    // The account's decisions are main's signals plus its own contract and gates. Only the latest per
    // index is kept (in kv), so main's decision grading and signal performance never count it twice.
    decisions: {
      append: async (d) => base.state.set(latestKey(d.index), d),
      latest: async (index) => base.state.get<PlanDecision>(latestKey(index)),
      between: (fromMs, toMs) => base.decisions.between(fromMs, toMs),
    },
    outcomes: {
      upsertMany: async () => {
        throw new Error(`${account} does not grade decisions; main does`);
      },
      between: (fromMs, toMs) => base.outcomes.between(fromMs, toMs),
    },
    orders: {
      save: async (o) => {
        paperOnly(o.mode, "order");
        await base.orders.save(toBook(o));
      },
      get: async (id) => {
        const o = await base.orders.get(id);
        return o && mine(o.mode) ? fromBook(o) : null;
      },
      byRefId: async (refId) => {
        const o = await base.orders.byRefId(refId);
        return o && mine(o.mode) ? fromBook(o) : null;
      },
      open: async (mode) => (await base.orders.open(stored(mode))).map(fromBook),
      between: async (fromMs, toMs, mode) => {
        const modes: TradingMode[] = mode ? [mode] : ["PAPER", "LIVE"];
        const out = await Promise.all(modes.map((m) => base.orders.between(fromMs, toMs, stored(m))));
        return out.flat().map(fromBook);
      },
    },
    fills: {
      append: (f) => base.fills.append(f),
      forOrder: (orderId) => base.fills.forOrder(orderId),
      between: async (fromMs, toMs) => {
        // Fills carry no mode: keep the ones whose order is in this account's book (orders rest up to a day).
        const ids = new Set((await base.orders.between(fromMs - 24 * HOUR_MS, toMs, stored("PAPER"))).map((o) => o.id));
        return (await base.fills.between(fromMs, toMs)).filter((f) => ids.has(f.orderId));
      },
    },
    positions: {
      save: async (p) => {
        paperOnly(p.mode, "position");
        await base.positions.save(toBook(p));
      },
      get: async (id) => {
        const p = await base.positions.get(id);
        return p && mine(p.mode) ? fromBook(p) : null;
      },
      open: async (mode) => (await base.positions.open(stored(mode))).map(fromBook),
      closedBetween: async (fromMs, toMs, mode) => (await base.positions.closedBetween(fromMs, toMs, stored(mode))).map(fromBook),
    },
    trades: {
      append: async (t) => {
        paperOnly(t.mode, "trade");
        await base.trades.append(toBook(t));
      },
      recent: async (n, mode) => (await base.trades.recent(n, stored(mode))).map(fromBook),
      between: async (fromMs, toMs, mode) => (await base.trades.between(fromMs, toMs, stored(mode))).map(fromBook),
    },
    // Signals are main's, so their track record is main's too (it shrinks weights and sets Kelly sizing).
    perf: {
      all: (mode) => base.perf.all(mode),
      upsertMany: async () => {
        throw new Error(`${account} does not write signal performance; main does`);
      },
    },
    ledger: {
      get: async (date, mode) => {
        const l = await base.ledger.get(date, stored(mode));
        return l ? fromBook(l) : null;
      },
      save: (l) => base.ledger.save(toBook(l)),
      range: async (fromDate, toDate, mode) => (await base.ledger.range(fromDate, toDate, stored(mode))).map(fromBook),
    },
    settings: {
      get: readSettings,
      update: async (patch, by) => {
        if (patch.mode === "LIVE" || (patch.armedUntil !== undefined && patch.armedUntil !== null)) throw new Error(`${account} is a paper-only account`);
        const cur = await readSettings();
        const next: Persisted = {
          killSwitch: patch.killSwitch ?? cur.killSwitch,
          killReason: patch.killReason !== undefined ? patch.killReason : cur.killReason,
          updatedMs: now(),
          updatedBy: by,
        };
        await base.state.set(settingsKey, next);
        return readSettings();
      },
    },
    state: {
      get: (key) => base.state.get(stateKey(key)),
      set: (key, value) => base.state.set(stateKey(key), value),
    },
    audit: {
      append: (e) => base.audit.append({ ...e, actor: `${e.actor}@${account}` }),
      recent: (n) => base.audit.recent(n),
    },
  };
}
