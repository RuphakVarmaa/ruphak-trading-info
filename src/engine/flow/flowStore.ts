/**
 * A FlowMonitor that survives Durable Object evictions: every kept snapshot is also written to storage (one
 * key per minute per index, the compact form), and load() replays the session's stored snapshots so the
 * events, running medians and windows come back exactly as they were. A new session (IST date) clears the
 * stored snapshots first; at most `maxSnaps` are kept per index (oldest deleted).
 *
 * The storage is injected (the DO's ctx.storage, or a Map in tests). Pure apart from it.
 */
import type { IndexId, OptionFlowView } from "../api-types";
import { istDate } from "../clock";
import { FlowMonitor, MAX_SNAPS, packSnapshot, unpackSnapshot, type ChainSnapshot, type FlowMonitorOptions, type FlowViewContext, type PackedSnapshot } from "./flowMonitor";

/** The subset of DurableObjectStorage used (its KV API). */
export interface FlowStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  delete(keys: string[]): Promise<number>;
}

export const FLOW_SESSION_KEY = "flow:session";
export const FLOW_SNAP_PREFIX = "flow:snap:";
/** DurableObjectStorage.delete takes at most 128 keys a call. */
const DELETE_BATCH = 128;

export const flowSnapKey = (index: IndexId, t: number) => `${FLOW_SNAP_PREFIX}${index}:${String(Math.floor(t / 60_000)).padStart(10, "0")}`;

export class PersistentFlowMonitor {
  readonly monitor: FlowMonitor;
  private session: string | null = null;
  private readonly keys = new Map<IndexId, string[]>();
  private readonly maxSnaps: number;

  constructor(
    private readonly storage: FlowStorage,
    o: FlowMonitorOptions = {},
  ) {
    this.monitor = new FlowMonitor(o);
    this.maxSnaps = o.maxSnaps ?? MAX_SNAPS;
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) await this.storage.delete(keys.slice(i, i + DELETE_BATCH));
  }

  /** Every stored snapshot key (any session). */
  private async storedKeys(): Promise<string[]> {
    return [...(await this.storage.list<PackedSnapshot>({ prefix: FLOW_SNAP_PREFIX })).keys()];
  }

  /** Restores today's session from storage; stored snapshots from another session are deleted. */
  async load(nowMs: number): Promise<void> {
    const today = istDate(nowMs);
    const stored = (await this.storage.get<string>(FLOW_SESSION_KEY)) ?? null;
    const all = await this.storage.list<PackedSnapshot>({ prefix: FLOW_SNAP_PREFIX });
    this.monitor.reset();
    this.keys.clear();
    if (stored !== today) {
      await this.deleteKeys([...all.keys()]);
      this.session = null;
      return;
    }
    this.session = today;
    const byIndex = new Map<IndexId, { key: string; snap: ChainSnapshot }[]>();
    const bad: string[] = [];
    for (const [key, packed] of all) {
      const snap = unpackSnapshot(packed);
      if (!snap || istDate(snap.t) !== today) {
        bad.push(key);
        continue;
      }
      const list = byIndex.get(snap.index) ?? [];
      list.push({ key, snap });
      byIndex.set(snap.index, list);
    }
    if (bad.length > 0) await this.deleteKeys(bad);
    for (const [index, list] of byIndex) {
      list.sort((a, b) => a.snap.t - b.snap.t);
      this.monitor.restore(
        index,
        list.map((x) => x.snap),
      );
      this.keys.set(
        index,
        list.map((x) => x.key),
      );
    }
  }

  /** Records a snapshot (kept in memory and in storage when it is the first of its minute). */
  async record(snap: ChainSnapshot): Promise<boolean> {
    const day = istDate(snap.t);
    if (this.session !== day) {
      await this.deleteKeys(await this.storedKeys());
      this.monitor.reset();
      this.keys.clear();
      this.session = day;
      await this.storage.put(FLOW_SESSION_KEY, day);
    }
    if (!this.monitor.ingest(snap)) return false;
    const key = flowSnapKey(snap.index, snap.t);
    await this.storage.put(key, packSnapshot(snap));
    const keys = this.keys.get(snap.index) ?? [];
    keys.push(key);
    this.keys.set(snap.index, keys);
    if (keys.length > this.maxSnaps) await this.deleteKeys(keys.splice(0, keys.length - this.maxSnaps));
    return true;
  }

  view(index: IndexId, nowMs: number, ctx?: FlowViewContext): OptionFlowView {
    return this.monitor.view(index, nowMs, ctx);
  }

  /** Stored snapshot count per index (for status and tests). */
  stored(index: IndexId): number {
    return this.keys.get(index)?.length ?? 0;
  }
}
