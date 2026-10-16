/**
 * EngineAdmin: the RPC entrypoint the dashboard Worker calls through its ENGINE service binding.
 * Reads come straight from D1 through the read model; admin actions re-check the admin token
 * here (defense in depth) and are executed by the trading Durable Object.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  AdvisorView,
  AgentView,
  BacktestParams,
  BacktestResult,
  CopyTicketView,
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
  IndexId,
  LiveIndexLevelsView,
  OptionChainView,
  OptionFlowView,
  TodayPlanView,
} from "../../../src/engine/api-types";
import { optionFlowWithFallback } from "../../../src/engine/flow/flowFallback";
import { parseAccountId, type AccountId } from "../../../src/engine/accounts";
import { emptyAgentView, withAccountSettings } from "../../../src/engine/agent/view";
import { ReadModel } from "../../../src/engine/api/readModel";
import { istDate } from "../../../src/engine/clock";
import { liveIndicesWithFeed, optionChainWithFeed } from "../../../src/engine/market/liveFeedViews";
import type { FeedSnapshot } from "../../../src/engine/market/upstoxFeed";
import { UpstoxLive } from "../../../src/engine/market/upstoxLive";
import { timingSafeEqual } from "../../../src/engine/util/hash";
import { getBacktest, startBacktest } from "./backtestRunner";
import { accountRuntime, accountViews, agentEnabled, agentSettings, enabledAccounts, makeRuntime } from "./runtime";

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

// Per isolate: the Upstox caches, in-flight requests and request budget (src/engine/market/upstoxLive.ts).
let live: { token: string | undefined; market: UpstoxLive } | null = null;
function liveMarket(env: Env): UpstoxLive {
  const token = env.UPSTOX_ANALYTICS_TOKEN || undefined;
  if (!live || live.token !== token) live = { token, market: new UpstoxLive({ token }) };
  return live.market;
}

function cleanActor(actor: string): string {
  return (actor || "dashboard").replace(/[^\w@.\- ]/g, "").slice(0, 64) || "dashboard";
}

export class EngineAdmin extends WorkerEntrypoint<Env> implements EngineApi {
  /** An enabled account id ("main" when omitted); anything else is a bad request. */
  private account(raw: unknown): AccountId {
    if (raw === undefined || raw === null || raw === "") return "main";
    const id = parseAccountId(String(raw));
    if (!id || !enabledAccounts(this.env).includes(id)) throw new AdminError("BAD_REQUEST", `unknown account '${String(raw).slice(0, 40)}'`);
    return id;
  }

  private model(account?: unknown): ReadModel {
    const rt = makeRuntime(this.env, "admin");
    const id = this.account(account);
    const a = accountRuntime(rt, id);
    const views = accountViews(rt, enabledAccounts(this.env));
    return new ReadModel({
      repo: a.repo,
      cfg: a.cfg,
      calendar: rt.calendar,
      now: Date.now(),
      liveTradingEnabled: rt.liveTradingEnabled,
      version: rt.version,
      account: views.find((v) => v.id === id),
      accounts: views,
    });
  }

  private engine() {
    return this.env.ENGINE_DO.get(this.env.ENGINE_DO.idFromName("engine"));
  }

  /** The market feed's latest ticks; null when the DO does not answer within 1.5 s (the views then use REST). */
  private async feedTicks(keys?: string[]): Promise<FeedSnapshot | null> {
    const stub = this.env.MARKET_FEED_DO.get(this.env.MARKET_FEED_DO.idFromName("feed"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        stub.ticks(keys) as Promise<FeedSnapshot>,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 1_500);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private requireAdmin(token: string): void {
    const expected = this.env.ADMIN_TOKEN;
    if (!expected) throw new AdminError("ADMIN_DISABLED", "ADMIN_TOKEN is not set on the engine Worker");
    if (typeof token !== "string" || !timingSafeEqual(token, expected)) throw new AdminError("UNAUTHORIZED", "invalid admin token");
  }

  getState(account?: string): Promise<EngineStateDTO> {
    return this.model(account).getState();
  }
  getSignals(account?: string): Promise<SignalView[]> {
    return this.model(account).getSignals();
  }
  getPositions(account?: string): Promise<PositionView[]> {
    return this.model(account).getPositions();
  }
  getEvents(q: EventsQuery): Promise<EventClusterView[]> {
    return this.model().getEvents(q ?? {});
  }
  getEventDetail(clusterId: string): Promise<EventClusterDetail | null> {
    return this.model().getEventDetail(String(clusterId));
  }
  getOrders(date: string, account?: string): Promise<{ orders: OrderView[]; fills: FillView[] }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AdminError("BAD_REQUEST", "date must be YYYY-MM-DD");
    return this.model(account).getOrders(date);
  }
  getPnl(days: number, account?: string): Promise<PnlResponse> {
    return this.model(account).getPnl(Number(days) || 30);
  }
  getPerformance(account?: string): Promise<SignalPerformanceRow[]> {
    return this.model(account).getPerformance();
  }
  getScheduled(hours: number): Promise<ScheduledEventView[]> {
    return this.model().getScheduled(Number(hours) || 48);
  }
  getTodayPlan(): Promise<TodayPlanView> {
    return this.model().getTodayPlan();
  }
  getOptionChain(index: IndexId, expiry?: string): Promise<OptionChainView> {
    if (index !== "NIFTY" && index !== "SENSEX") throw new AdminError("BAD_REQUEST", "index must be NIFTY or SENSEX");
    if (expiry != null && expiry !== "" && (typeof expiry !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expiry))) throw new AdminError("BAD_REQUEST", "expiry must be YYYY-MM-DD");
    return optionChainWithFeed(liveMarket(this.env), (keys) => this.feedTicks(keys), index, expiry || undefined);
  }
  getLiveIndices(): Promise<LiveIndexLevelsView> {
    return liveIndicesWithFeed(liveMarket(this.env), (keys) => this.feedTicks(keys));
  }
  /**
   * The market feed's minute-sampled option flow; when it has no minutes (or does not answer in 1.5 s), what
   * one REST chain shows, flagged source "rest" (src/engine/flow/flowFallback.ts).
   */
  getOptionFlow(index: IndexId): Promise<OptionFlowView> {
    if (index !== "NIFTY" && index !== "SENSEX") throw new AdminError("BAD_REQUEST", "index must be NIFTY or SENSEX");
    return optionFlowWithFallback(
      index,
      () => this.feedFlow(index),
      () => liveMarket(this.env).getOptionChain(index),
      Date.now(),
    );
  }

  /** The feed DO's option flow; null when it does not answer within 1.5 s. */
  private async feedFlow(index: IndexId): Promise<OptionFlowView | null> {
    const stub = this.env.MARKET_FEED_DO.get(this.env.MARKET_FEED_DO.idFromName("feed"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        stub.getOptionFlow(index) as Promise<OptionFlowView>,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 1_500);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  getBacktest(runId: string): Promise<BacktestResult | null> {
    return getBacktest(this.env, String(runId));
  }
  getCopyTickets(date: string, account?: string): Promise<CopyTicketView[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AdminError("BAD_REQUEST", "date must be YYYY-MM-DD");
    // A model's paper experiment is not something to copy into a real account: the agent has no copy tickets.
    if (account != null && parseAccountId(String(account)) === "agent") throw new AdminError("BAD_REQUEST", "the agent account has no copy tickets: it is a paper experiment run by a model");
    return this.model(account).getCopyTickets(date);
  }

  /** The advisor's Durable Object (AdvisorDO): one instance holds the brief, its history and the run state. */
  private advisor() {
    return this.env.ADVISOR_DO.get(this.env.ADVISOR_DO.idFromName("advisor"));
  }
  /** Public (no admin token): it only reads the stored brief. */
  getAdvisor(): Promise<AdvisorView> {
    return this.advisor().view() as Promise<AdvisorView>;
  }
  /** Public (no admin token): the advisor's rate limit is the guard. The reason is trimmed to 100 characters. */
  runAdvisor(reason: string): Promise<AdvisorView> {
    return this.advisor().run(String(reason ?? "").trim().slice(0, 100)) as Promise<AdvisorView>;
  }

  /** The options agent's Durable Object (AgentDO): decisions, cost, the nightly review and the candidate guidance. */
  private agentDo() {
    return this.env.AGENT_DO.get(this.env.AGENT_DO.idFromName("agent"));
  }

  /**
   * The options agent (a paper experiment) for an IST date, default today. Public like the other reads. When ACCOUNTS
   * does not list the agent, the empty view says so. The kill switches (the agent's and main's) are read live here.
   */
  async getAgent(date?: string): Promise<AgentView> {
    const now = Date.now();
    const d = date === undefined || date === null || date === "" ? istDate(now) : String(date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new AdminError("BAD_REQUEST", "date must be YYYY-MM-DD");
    const settings = agentSettings(this.env);
    if (!agentEnabled(this.env)) return emptyAgentView(now, settings, false, null);
    const rt = makeRuntime(this.env, "admin");
    const [account] = accountViews(rt, ["agent"]);
    const [view, agent, main] = await Promise.all([this.agentDo().view(d, account) as Promise<AgentView>, accountRuntime(rt, "agent").repo.settings.get(), rt.repo.settings.get()]);
    return withAccountSettings(view, agent, main);
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

  async setKillSwitch(token: string, req: KillSwitchRequest, actor: string, account?: string): Promise<EngineStateDTO> {
    this.requireAdmin(token);
    const target = account === "all" ? "all" : this.account(account);
    const res = await this.engine().setKillSwitch(
      { engaged: Boolean(req?.engaged), squareOff: Boolean(req?.squareOff), reason: String(req?.reason ?? "").slice(0, 300) },
      cleanActor(actor),
      target,
    );
    if (!res.ok) throw new AdminError("CONFLICT", res.message);
    return this.getState(target === "all" ? undefined : target);
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

  /** Approves or rejects the nightly review's candidate guidance (the approval gate; approval only outside the session). */
  async setAgentCandidate(token: string, candidateId: string, decision: "approve" | "reject", actor: string): Promise<AgentView> {
    this.requireAdmin(token);
    const id = String(candidateId ?? "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new AdminError("BAD_REQUEST", "candidate id must be 1 to 64 letters, digits, _ or -");
    if (decision !== "approve" && decision !== "reject") throw new AdminError("BAD_REQUEST", "decision must be approve or reject");
    if (!agentEnabled(this.env)) throw new AdminError("CONFLICT", "the agent account is not enabled (ACCOUNTS)");
    const res = await this.agentDo().decideCandidate(id, decision, cleanActor(actor));
    if (!res.ok) throw new AdminError("CONFLICT", res.message);
    return this.getAgent();
  }

  /** Clears the agent's drawdown halt and kill switch (the trading DO runs it); its peak equity restarts at the current equity. */
  async rearmAgent(token: string, actor: string): Promise<AgentView> {
    this.requireAdmin(token);
    if (!agentEnabled(this.env)) throw new AdminError("CONFLICT", "the agent account is not enabled (ACCOUNTS)");
    const res = await this.engine().rearmAgent(cleanActor(actor));
    if (!res.ok) throw new AdminError("CONFLICT", res.message);
    return this.getAgent();
  }
}
