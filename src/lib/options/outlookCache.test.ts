import { describe, expect, it } from "vitest";
import type { IndexId, OptionChainView, ScheduledEventView } from "@/engine/api-types";
import { defaultCalendar } from "@/engine/calendar/calendar";
import { MockEngineApi } from "@/lib/engine/mock";
import { buildMockChain } from "@/lib/engine/mockChain";
import { inSession, OutlookCache, TTL_CLOSED_MS, TTL_OPEN_MS, type OutlookEngine } from "./outlookCache";

const ist = (s: string) => Date.parse(`${s}+05:30`);
const EXPIRIES = ["2026-10-19", "2026-10-27", "2026-11-03", "2026-11-09"];
const MIN = 60_000;

const FOMC: ScheduledEventView = {
  id: "fomc",
  title: "FOMC rate decision",
  kind: "FOMC",
  at: "2026-10-28T23:30:00+05:30",
  impact: "HIGH",
  approx: false,
  blackoutStart: null,
  blackoutEnd: null,
  indices: ["NIFTY", "SENSEX"],
};

/** A fake engine on the mock chain whose clock is the test's wall clock; it records each chain read. */
function setup(start = "2026-10-15T11:42:00") {
  const clock = { now: ist(start) };
  const calls: (string | undefined)[] = [];
  const hours: number[] = [];
  const failing = new Set<string>();
  /** Expiries the engine silently swaps for the nearest one (as the mock does for an unlisted expiry). */
  const swapped = new Set<string>();
  let noList = false;
  let hang = false;
  const engine: OutlookEngine = {
    async getOptionChain(index: IndexId, expiry?: string): Promise<OptionChainView> {
      calls.push(expiry);
      if (hang) return new Promise(() => {});
      if (noList && expiry === undefined) throw new Error("Engine unreachable");
      if (expiry && failing.has(expiry)) throw new Error("Upstox rate limit (HTTP 429): retrying shortly");
      const asked = expiry && swapped.has(expiry) ? undefined : expiry;
      return buildMockChain({ index, spot: 25012.4, prevSpot: 24990, nowMs: clock.now, expiries: EXPIRIES, expiry: asked });
    },
    async getScheduled(h: number) {
      hours.push(h);
      return [FOMC];
    },
  };
  const cache = new OutlookCache({ calendar: defaultCalendar, now: () => clock.now });
  return { clock, calls, hours, failing, swapped, engine, cache, setNoList: (v: boolean) => (noList = v), setHang: (v: boolean) => (hang = v) };
}

describe("OutlookCache", () => {
  it("reads at most two chains per request (the default one included) until every expiry is in", async () => {
    const t = setup();
    const first = await t.cache.get("NIFTY", t.engine);
    expect(t.calls).toEqual([undefined, "2026-10-27"]);
    expect(t.hours).toEqual([720]);
    expect(first.expiries.map((e) => e.expiry)).toEqual(EXPIRIES);
    expect(first.pending).toBe(2);
    expect(first.expiries.map((e) => e.movePct != null)).toEqual([true, true, false, false]);
    expect(first.expiries[1].events.map((e) => e.id)).toEqual([]);
    expect(first.expiries[2].events.map((e) => e.id)).toEqual(["fomc"]);

    const second = await t.cache.get("NIFTY", t.engine);
    expect(t.calls.slice(2)).toEqual(["2026-11-03", "2026-11-09"]);
    expect(second.pending).toBe(0);
    expect(second.expiries.every((e) => e.movePct != null && !e.stale)).toBe(true);
    expect(second.source).toBe("mock");

    // Within the 5-minute market-hours lifetime: nothing is read again.
    t.clock.now += 4 * MIN;
    await t.cache.get("NIFTY", t.engine);
    expect(t.calls).toHaveLength(4);
    expect(t.hours).toEqual([720]);
  });

  it("after the lifetime, refreshes the list with the default chain and the stalest other expiry", async () => {
    const t = setup();
    await t.cache.get("NIFTY", t.engine);
    await t.cache.get("NIFTY", t.engine);
    t.clock.now += TTL_OPEN_MS;
    await t.cache.get("NIFTY", t.engine);
    expect(t.calls.slice(4)).toEqual([undefined, "2026-10-27"]);
    expect(t.hours).toEqual([720, 720]);
    await t.cache.get("NIFTY", t.engine);
    expect(t.calls.slice(6)).toEqual(["2026-11-03", "2026-11-09"]);
  });

  it("keeps the last good chain when a refresh fails, and waits a minute before retrying it", async () => {
    const t = setup();
    await t.cache.get("NIFTY", t.engine);
    const good = await t.cache.get("NIFTY", t.engine);
    t.failing.add("2026-11-03");
    t.clock.now += TTL_OPEN_MS;
    await t.cache.get("NIFTY", t.engine); // default + 27 Oct (the stalest by expiry order)
    const view = await t.cache.get("NIFTY", t.engine); // 3 Nov fails, 9 Nov refreshes
    expect(t.calls.slice(6)).toEqual(["2026-11-03", "2026-11-09"]);
    const row = view.expiries[2];
    expect(row.stale).toBe(true);
    expect(row.error).toMatch(/rate limit/);
    expect(row.movePct).toBe(good.expiries[2].movePct);
    expect(row.fetchedAt).toBe(good.expiries[2].fetchedAt);

    await t.cache.get("NIFTY", t.engine);
    expect(t.calls).toHaveLength(8);
    t.clock.now += MIN;
    t.failing.clear();
    const healed = await t.cache.get("NIFTY", t.engine);
    expect(t.calls.slice(8)).toEqual(["2026-11-03"]);
    expect(healed.expiries[2].stale).toBe(false);
    expect(healed.expiries[2].error).toBeNull();
  });

  it("refuses a chain for another expiry than the one asked (the mock's silent fallback)", async () => {
    const t = setup();
    t.swapped.add("2026-10-27");
    const view = await t.cache.get("NIFTY", t.engine);
    const row = view.expiries[1];
    expect(row.movePct).toBeNull();
    expect(row.error).toBe("The engine answered with the 2026-10-19 chain instead of 2026-10-27.");
    expect(view.pending).toBe(2);
  });

  it("says so when there is no expiry list, and still reads the events", async () => {
    const t = setup();
    t.setNoList(true);
    const view = await t.cache.get("NIFTY", t.engine);
    expect(view.expiries).toEqual([]);
    expect(view.error).toBe("The engine did not list any NIFTY expiries: Engine unreachable");
    expect(view.events?.map((e) => e.id)).toEqual(["fomc"]);
  });

  it("gives up on a chain that does not answer", async () => {
    const t = setup();
    const cache = new OutlookCache({ calendar: defaultCalendar, now: () => t.clock.now, timeoutMs: 20 });
    t.setHang(true);
    const view = await cache.get("NIFTY", t.engine);
    expect(view.error).toMatch(/did not answer within/);
  });

  it("shares one load between concurrent requests for the same index", async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.cache.get("NIFTY", t.engine), t.cache.get("NIFTY", t.engine)]);
    expect(a).toBe(b);
    expect(t.calls).toHaveLength(2);
  });

  it("keeps chains for 30 minutes outside market hours", async () => {
    const t = setup("2026-10-15T18:00:00");
    expect(inSession(t.clock.now, defaultCalendar)).toBe(false);
    expect(inSession(ist("2026-10-15T11:00:00"), defaultCalendar)).toBe(true);
    expect(inSession(ist("2026-10-20T11:00:00"), defaultCalendar)).toBe(false); // Dussehra
    await t.cache.get("NIFTY", t.engine);
    await t.cache.get("NIFTY", t.engine);
    t.clock.now += TTL_OPEN_MS * 2;
    await t.cache.get("NIFTY", t.engine);
    expect(t.calls).toHaveLength(4);
    t.clock.now += TTL_CLOSED_MS;
    await t.cache.get("NIFTY", t.engine);
    expect(t.calls).toHaveLength(6);
  });

  it("works end to end on the mock engine", async () => {
    const cache = new OutlookCache({ calendar: defaultCalendar });
    const api = new MockEngineApi("sim");
    let view = await cache.get("SENSEX", api);
    for (let i = 0; i < 4 && view.pending > 0; i++) view = await cache.get("SENSEX", api);
    expect(view.pending).toBe(0);
    expect(view.source).toBe("mock");
    expect(view.index).toBe("SENSEX");
    expect(view.expiries.length).toBeGreaterThan(0);
    for (const e of view.expiries) {
      expect(e.movePct).toBeGreaterThan(0);
      expect(e.range!.low).toBeLessThan(e.range!.high);
      expect(e.support.length).toBe(3);
      expect(e.resistance.length).toBe(3);
    }
    const sorted = [...view.expiries.map((e) => e.expiry)].sort();
    expect(view.expiries.map((e) => e.expiry)).toEqual(sorted);
  });
});
