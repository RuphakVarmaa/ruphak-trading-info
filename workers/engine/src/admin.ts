/**
 * EngineAdmin: the RPC entrypoint the dashboard Worker calls through its ENGINE service binding.
 * Reads come straight from D1 through the read model; admin actions re-check the admin token
 * here (defense in depth) and are executed by the trading Durable Object.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  BacktestParams,
  BacktestResult,
  EngineApi,
  EngineMode,
  EngineStateDTO,
  EventClusterDetail,
  EventClusterView,
  EventsQuery,
  FillView,
  KillSwitchRequest,
  OrderView,
  PnlResponse,
  PositionView,
  ScheduledEventView,
  SignalPerformanceRow,
  SignalView,
} from "../../../src/engine/api-types";
import { ReadModel } from "../../../src/engine/api/readModel";
import { timingSafeEqual } from "../../../src/engine/util/hash";
import { getBacktest, startBacktest } from "./backtestRunner";
import { makeRuntime } from "./runtime";

/**
 * Admin failures cross Workers RPC as plain Errors, so the code travels as a message prefix
 * ("CONFLICT: ...") which the dashboard maps to an HTTP status.
 */
export class AdminError extends Error {
  constructor(
    readonly code: "UNAUTHORIZED" | "ADMIN_DISABLED" | "BAD_REQUEST" | "CONFLICT",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "Error";
  }
}

function cleanActor(actor: string): string {
  return (actor || "dashboard").replace(/[^\w@.\- ]/g, "").slice(0, 64) || "dashboard";
}

export class EngineAdmin extends WorkerEntrypoint<Env> implements EngineApi {
  private model(): ReadModel {
    const rt = makeRuntime(this.env, "admin");
    return new ReadModel({ repo: rt.repo, cfg: rt.cfg, calendar: rt.calendar, now: Date.now(), liveTradingEnabled: rt.liveTradingEnabled, version: rt.version });
  }

  private engine() {
    return this.env.ENGINE_DO.get(this.env.ENGINE_DO.idFromName("engine"));
  }

  private requireAdmin(token: string): void {
    const expected = this.env.ADMIN_TOKEN;
    if (!expected) throw new AdminError("ADMIN_DISABLED", "ADMIN_TOKEN is not set on the engine Worker");
    if (typeof token !== "string" || !timingSafeEqual(token, expected)) throw new AdminError("UNAUTHORIZED", "invalid admin token");
  }

  getState(): Promise<EngineStateDTO> {
    return this.model().getState();
  }
  getSignals(): Promise<SignalView[]> {
    return this.model().getSignals();
  }
  getPositions(): Promise<PositionView[]> {
    return this.model().getPositions();
  }
  getEvents(q: EventsQuery): Promise<EventClusterView[]> {
    return this.model().getEvents(q ?? {});
  }
  getEventDetail(clusterId: string): Promise<EventClusterDetail | null> {
    return this.model().getEventDetail(String(clusterId));
  }
  getOrders(date: string): Promise<{ orders: OrderView[]; fills: FillView[] }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AdminError("BAD_REQUEST", "date must be YYYY-MM-DD");
    return this.model().getOrders(date);
  }
  getPnl(days: number): Promise<PnlResponse> {
    return this.model().getPnl(Number(days) || 30);
  }
  getPerformance(): Promise<SignalPerformanceRow[]> {
    return this.model().getPerformance();
  }
  getScheduled(hours: number): Promise<ScheduledEventView[]> {
    return this.model().getScheduled(Number(hours) || 48);
  }
  getBacktest(runId: string): Promise<BacktestResult | null> {
    return getBacktest(this.env, String(runId));
  }

  async verifyAdmin(token: string): Promise<boolean> {
    try {
      this.requireAdmin(token);
      return true;
    } catch {
      return false;
    }
  }

  async setArmed(token: string, armed: boolean, actor: string): Promise<EngineStateDTO> {
    this.requireAdmin(token);
    const res = await this.engine().setArmed(Boolean(armed), cleanActor(actor));
    if (!res.ok) throw new AdminError("CONFLICT", res.message);
    return this.getState();
  }

  async setKillSwitch(token: string, req: KillSwitchRequest, actor: string): Promise<EngineStateDTO> {
    this.requireAdmin(token);
    const res = await this.engine().setKillSwitch(
      { engaged: Boolean(req?.engaged), squareOff: Boolean(req?.squareOff), reason: String(req?.reason ?? "").slice(0, 300) },
      cleanActor(actor),
    );
    if (!res.ok) throw new AdminError("CONFLICT", res.message);
    return this.getState();
  }

  async setMode(token: string, mode: EngineMode, actor: string): Promise<EngineStateDTO> {
    this.requireAdmin(token);
    if (mode !== "PAPER" && mode !== "LIVE") throw new AdminError("BAD_REQUEST", "mode must be PAPER or LIVE");
    const res = await this.engine().setMode(mode, cleanActor(actor));
    if (!res.ok) throw new AdminError("CONFLICT", res.message);
    return this.getState();
  }

  async startBacktest(token: string, params: BacktestParams, actor: string): Promise<{ runId: string; status: "RUNNING" | "DONE" }> {
    this.requireAdmin(token);
    return startBacktest(this.env, this.ctx, params, cleanActor(actor));
  }
}
