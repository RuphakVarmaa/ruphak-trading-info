/**
 * Behavioural contract every Repository implementation must satisfy. Run by the in-memory
 * repository's tests and by the D1 repository's integration test.
 */
import { describe, expect, it } from "vitest";
import { accountConfig } from "../accounts";
import { DEFAULT_CONFIG } from "../config";
import type { Repository } from "../ports";
import type { ArticleCluster, DayLedger, Fill, NormalizedArticle, Order, Position, ScoredEvent, TradeRecord } from "../types";
import { accountRepository } from "./accountRepo";

const T = Date.parse("2026-10-07T05:00:00Z");

export const sample = {
  article: (id: string, t = T): NormalizedArticle => ({
    source: "google_rss",
    title: `Title ${id}`,
    url: `https://x/${id}`,
    publishedAt: new Date(t).toISOString(),
    id,
    canonicalUrl: `https://x/${id}`,
    normTitle: `title ${id}`,
    shingles: [],
    entities: [],
    publishedMs: t,
    ingestedMs: t,
  }),
  cluster: (id: string, over: Partial<ArticleCluster> = {}): ArticleCluster => ({
    id,
    articleIds: ["a"],
    representativeTitle: id,
    headlines: [id],
    urls: ["u"],
    firstSeenMs: T,
    lastSeenMs: T,
    articleCount: 1,
    sources: ["s"],
    status: "UNSCORED",
    ...over,
  }),
  event: (clusterId: string, over: Partial<ScoredEvent> = {}): ScoredEvent => ({
    clusterId,
    clusterKey: `k-${clusterId}`,
    scoredAtMs: T,
    scorer: "llm",
    version: "rubric-v1",
    taxonomy: "MACRO_POLICY",
    indiaRelevance: "DIRECT",
    isScheduledData: false,
    surprise: "NA",
    novelty: "NEW",
    pricedIn: "LOW",
    horizon: "DAYS_1_2",
    halfLifeHours: 24,
    impact: {
      NIFTY: { direction: "BEAR", magnitude: "SMALL", confidence: "LOW" },
      SENSEX: { direction: "BEAR", magnitude: "SMALL", confidence: "LOW" },
    },
    sectors: [],
    rationale: "r",
    numeric: { NIFTY: -0.1, SENSEX: -0.1 },
    firstSeenMs: T,
    articleCount: 1,
    title: "t",
    ...over,
  }),
};

export function repositoryContract(name: string, make: () => Promise<Repository>): void {
  describe(`Repository contract: ${name}`, () => {
    it("stores articles idempotently and reports known ids", async () => {
      const repo = await make();
      await repo.articles.upsertMany([sample.article("a1"), sample.article("a2")]);
      await repo.articles.upsertMany([sample.article("a1")]);
      expect([...(await repo.articles.knownIds(["a1", "a2", "a3"]))].sort()).toEqual(["a1", "a2"]);
      expect((await repo.articles.byIds(["a2"]))[0].title).toBe("Title a2");
    });

    it("upserts clusters and finds active, keyed and unscored ones", async () => {
      const repo = await make();
      await repo.clusters.upsertMany([
        sample.cluster("c1", { lastSeenMs: T, status: "UNSCORED" }),
        sample.cluster("c2", { lastSeenMs: T - 100 * 3_600_000, status: "SCORED", key: "story" }),
        sample.cluster("c3", { lastSeenMs: T + 1000, status: "RESCORE" }),
      ]);
      await repo.clusters.upsertMany([sample.cluster("c1", { lastSeenMs: T + 2000, status: "SCORED", key: "other" })]);
      expect((await repo.clusters.active(T - 3_600_000)).map((c) => c.id).sort()).toEqual(["c1", "c3"]);
      expect((await repo.clusters.byKey("story"))?.id).toBe("c2");
      expect((await repo.clusters.needingScore(10)).map((c) => c.id)).toEqual(["c3"]);
      await repo.clusters.deleteMany(["c3"]);
      expect(await repo.clusters.byIds(["c3"])).toEqual([]);
    });

    it("keeps one score per cluster", async () => {
      const repo = await make();
      await repo.events.upsertMany([sample.event("c1"), sample.event("c2", { firstSeenMs: T - 1e9 })]);
      await repo.events.upsertMany([sample.event("c1", { rationale: "rescored" })]);
      const active = await repo.events.active(T - 1000);
      expect(active).toHaveLength(1);
      expect(active[0].rationale).toBe("rescored");
      await repo.events.deleteByClusterIds(["c1"]);
      expect(await repo.events.byClusterIds(["c1", "c2"])).toHaveLength(1);
    });

    it("tracks orders by reference and open status", async () => {
      const repo = await make();
      const base = { contract: { index: "NIFTY", exchange: "NSE", tradingSymbol: "S", growwSymbol: "G", exchangeToken: "1", expiry: "2026-10-13", strike: 22600, type: "CE", lotSize: 65, tickSize: 0.05 }, side: "BUY", qty: 65, type: "LIMIT", product: "MIS", reason: "ENTRY", filledQty: 0, mode: "PAPER" } as const;
      const o1: Order = { ...base, id: "o1", refId: "R1AAAAAAA", status: "OPEN", createdMs: T, updatedMs: T };
      const o2: Order = { ...base, id: "o2", refId: "R2AAAAAAA", status: "FILLED", createdMs: T + 1, updatedMs: T + 1 };
      await repo.orders.save(o1);
      await repo.orders.save(o2);
      await repo.orders.save({ ...o1, status: "PARTIAL", filledQty: 0 });
      expect((await repo.orders.open("PAPER")).map((o) => o.id)).toEqual(["o1"]);
      expect((await repo.orders.byRefId("R2AAAAAAA"))?.id).toBe("o2");
      expect((await repo.orders.between(T, T + 10, "PAPER")).map((o) => o.id)).toEqual(["o1", "o2"]);
      expect(await repo.orders.open("LIVE")).toEqual([]);
    });

    it("separates open and closed positions by mode", async () => {
      const repo = await make();
      const p = { id: "p1", mode: "PAPER", status: "OPEN", index: "NIFTY" } as unknown as Position;
      await repo.positions.save(p);
      await repo.positions.save({ ...p, id: "p2", mode: "LIVE" });
      expect((await repo.positions.open("PAPER")).map((x) => x.id)).toEqual(["p1"]);
      await repo.positions.save({ ...p, status: "CLOSED", exitMs: T });
      expect(await repo.positions.open("PAPER")).toEqual([]);
      expect((await repo.positions.closedBetween(T - 1, T + 1, "PAPER")).map((x) => x.id)).toEqual(["p1"]);
    });

    it("returns recent trades newest first", async () => {
      const repo = await make();
      for (let i = 0; i < 3; i++) await repo.trades.append({ positionId: `p${i}`, mode: "PAPER", exitMs: T + i } as unknown as TradeRecord);
      expect((await repo.trades.recent(2, "PAPER")).map((t) => t.positionId)).toEqual(["p2", "p1"]);
    });

    it("stores ledgers, settings, state and heartbeat", async () => {
      const repo = await make();
      const l = { date: "2026-10-07", mode: "PAPER", realized: 10 } as unknown as DayLedger;
      await repo.ledger.save(l);
      await repo.ledger.save({ ...l, realized: 20 });
      expect((await repo.ledger.get("2026-10-07", "PAPER"))?.realized).toBe(20);
      expect(await repo.ledger.range("2026-10-01", "2026-10-31", "PAPER")).toHaveLength(1);
      const s0 = await repo.settings.get();
      expect(s0.mode).toBe("PAPER");
      const s1 = await repo.settings.update({ killSwitch: true, killReason: "test" }, "tester");
      expect(s1.killSwitch).toBe(true);
      expect((await repo.settings.get()).updatedBy).toBe("tester");
      await repo.state.set("k", { a: 1 });
      expect(await repo.state.get<{ a: number }>("k")).toEqual({ a: 1 });
      expect(await repo.state.get("missing")).toBeNull();
      await repo.heartbeat.write({ ts: T, phase: "OPEN", mode: "PAPER", alarmNextMs: null, lastTickMs: T, openPositions: 0, consecutiveErrors: 0, version: "v", relayHealthy: null });
      expect((await repo.heartbeat.read())?.phase).toBe("OPEN");
      await repo.audit.append({ ts: T, actor: "a", action: "x" });
      expect((await repo.audit.recent(5))[0].action).toBe("x");
    });
  });
}

/**
 * Account scoping on top of a Repository implementation: a paper account's books share the tables
 * with main's but never mix with them, and its settings and kv keys are its own.
 */
export function accountScopeContract(name: string, make: () => Promise<Repository>): void {
  const cfg10k = accountConfig(DEFAULT_CONFIG, "small10k");
  const scoped = (base: Repository) => accountRepository(base, "small10k", cfg10k, () => T);
  const contract = { index: "NIFTY", exchange: "NSE", tradingSymbol: "S", growwSymbol: "G", exchangeToken: "1", expiry: "2026-10-13", strike: 22600, type: "CE", lotSize: 65, tickSize: 0.05 } as const;
  const order = (id: string, over: Partial<Order> = {}): Order =>
    ({ contract, side: "BUY", qty: 65, type: "LIMIT", product: "MIS", reason: "ENTRY", filledQty: 65, mode: "PAPER", id, refId: `R${id}AAAAAAAA`.slice(0, 10), status: "FILLED", createdMs: T, updatedMs: T, ...over }) as Order;

  describe(`Account scope: ${name}`, () => {
    it("keeps the ₹10k account's orders, fills, positions and trades apart from main's", async () => {
      const base = await make();
      const small = scoped(base);
      await base.orders.save(order("m1"));
      await small.orders.save(order("s1"));
      await base.fills.append({ id: "fm", orderId: "m1", t: T, qty: 65, price: 50, charges: { brokerage: 20, stt: 0, exchange: 0, sebi: 0, stamp: 0, ipft: 0, gst: 0, total: 20 }, slippageTicks: 0 } as unknown as Fill);
      await small.fills.append({ id: "fs", orderId: "s1", t: T, qty: 65, price: 50, charges: { brokerage: 20, stt: 0, exchange: 0, sebi: 0, stamp: 0, ipft: 0, gst: 0, total: 20 }, slippageTicks: 0 } as unknown as Fill);
      expect((await base.orders.between(T - 1, T + 1, "PAPER")).map((o) => o.id)).toEqual(["m1"]);
      const mine = await small.orders.between(T - 1, T + 1);
      expect(mine.map((o) => [o.id, o.mode])).toEqual([["s1", "PAPER"]]);
      expect(await small.orders.get("m1")).toBeNull();
      expect((await small.orders.get("s1"))?.mode).toBe("PAPER");
      expect((await small.fills.between(T - 1, T + 1)).map((f) => f.orderId)).toEqual(["s1"]);

      const p = { id: "p", mode: "PAPER", status: "OPEN", index: "NIFTY" } as unknown as Position;
      await base.positions.save({ ...p, id: "pm" });
      await small.positions.save({ ...p, id: "ps" });
      expect((await base.positions.open("PAPER")).map((x) => x.id)).toEqual(["pm"]);
      expect((await small.positions.open("PAPER")).map((x) => [x.id, x.mode])).toEqual([["ps", "PAPER"]]);
      expect(await small.positions.get("pm")).toBeNull();

      await base.trades.append({ positionId: "pm", mode: "PAPER", exitMs: T } as unknown as TradeRecord);
      await small.trades.append({ positionId: "ps", mode: "PAPER", exitMs: T } as unknown as TradeRecord);
      expect((await base.trades.recent(5, "PAPER")).map((t) => t.positionId)).toEqual(["pm"]);
      expect((await small.trades.recent(5, "PAPER")).map((t) => [t.positionId, t.mode])).toEqual([["ps", "PAPER"]]);
    });

    it("keeps separate ledgers", async () => {
      const base = await make();
      const small = scoped(base);
      const l = { date: "2026-10-07", mode: "PAPER", realized: 10 } as unknown as DayLedger;
      await base.ledger.save(l);
      await small.ledger.save({ ...l, realized: -500 });
      expect((await base.ledger.get("2026-10-07", "PAPER"))?.realized).toBe(10);
      const own = await small.ledger.get("2026-10-07", "PAPER");
      expect(own?.realized).toBe(-500);
      expect(own?.mode).toBe("PAPER");
      expect(await small.ledger.range("2026-10-01", "2026-10-31", "PAPER")).toHaveLength(1);
    });

    it("refuses LIVE books and signal-performance writes", async () => {
      const small = scoped(await make());
      await expect(small.orders.save(order("x", { mode: "LIVE" }))).rejects.toThrow(/paper-only/);
      await expect(small.perf.upsertMany([])).rejects.toThrow(/signal performance/);
    });

    it("derives its caps from the account config and keeps its own kill switch", async () => {
      const base = await make();
      const small = scoped(base);
      const s = await small.settings.get();
      expect(s.mode).toBe("PAPER");
      expect(s.dailyLossCapInr).toBe(2_500);
      expect(s.maxPremiumPerTradeInr).toBe(5_000);
      expect(s.maxOpenPositions).toBe(1);
      await small.settings.update({ killSwitch: true, killReason: "test" }, "tester");
      expect((await small.settings.get()).killSwitch).toBe(true);
      expect((await base.settings.get()).killSwitch).toBe(false);
      await expect(small.settings.update({ mode: "LIVE" }, "tester")).rejects.toThrow(/paper-only/);
    });

    it("prefixes its own kv keys and shares the rest", async () => {
      const base = await make();
      const small = scoped(base);
      await small.state.set("decision:last:NIFTY", { t: 1 });
      expect(await base.state.get("decision:last:NIFTY")).toBeNull();
      await base.state.set("health:yahoo", { ok: true });
      expect(await small.state.get("health:yahoo")).toEqual({ ok: true });
      expect(await small.perf.all("PAPER")).toEqual(await base.perf.all("PAPER"));
    });

    it("keeps the ₹5k and ₹10k accounts apart from each other, with their own caps and kill switches", async () => {
      const base = await make();
      const tenK = scoped(base);
      const fiveK = accountRepository(base, "small5k", accountConfig(DEFAULT_CONFIG, "small5k"), () => T);
      await base.orders.save(order("m1"));
      await tenK.orders.save(order("t1"));
      await fiveK.orders.save(order("f1"));
      expect((await base.orders.between(T - 1, T + 1, "PAPER")).map((o) => o.id)).toEqual(["m1"]);
      expect((await tenK.orders.between(T - 1, T + 1)).map((o) => o.id)).toEqual(["t1"]);
      expect((await fiveK.orders.between(T - 1, T + 1)).map((o) => [o.id, o.mode])).toEqual([["f1", "PAPER"]]);
      expect(await fiveK.orders.get("t1")).toBeNull();
      expect(await tenK.orders.get("f1")).toBeNull();

      const p = { id: "p", mode: "PAPER", status: "OPEN", index: "NIFTY" } as unknown as Position;
      await tenK.positions.save({ ...p, id: "pt" });
      await fiveK.positions.save({ ...p, id: "pf" });
      expect((await tenK.positions.open("PAPER")).map((x) => x.id)).toEqual(["pt"]);
      expect((await fiveK.positions.open("PAPER")).map((x) => x.id)).toEqual(["pf"]);

      const l = { date: "2026-10-07", mode: "PAPER", realized: -1_200 } as unknown as DayLedger;
      await fiveK.ledger.save(l);
      expect(await tenK.ledger.get("2026-10-07", "PAPER")).toBeNull();
      expect((await fiveK.ledger.get("2026-10-07", "PAPER"))?.realized).toBe(-1_200);

      const s = await fiveK.settings.get();
      expect(s.dailyLossCapInr).toBe(1_500);
      expect(s.maxPremiumPerTradeInr).toBe(4_500);
      expect(s.maxOpenPositions).toBe(1);
      await fiveK.settings.update({ killSwitch: true, killReason: "₹5k only" }, "tester");
      expect((await fiveK.settings.get()).killSwitch).toBe(true);
      expect((await tenK.settings.get()).killSwitch).toBe(false);
      expect((await base.settings.get()).killSwitch).toBe(false);
      await expect(fiveK.orders.save(order("x", { mode: "LIVE" }))).rejects.toThrow(/small5k is a paper-only account/);
    });
  });
}
