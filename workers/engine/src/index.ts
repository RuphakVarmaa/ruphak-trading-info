/**
 * Engine Worker entry: Durable Objects (trading loop, ingestion, backtests, advisor, the options agent), the cron
 * dispatcher, the event-scoring queue consumer (and its dead-letter queue), the EngineAdmin RPC entrypoint
 * for the dashboard, and a small HTTP surface (/health, Telegram webhook, token-protected ops).
 */
import { AUTO_RUN_WINDOW_MIN } from "../../../src/engine/advisor/runState";
import { istDate, istMinutes } from "../../../src/engine/clock";
import { redactFeedError } from "../../../src/engine/market/upstoxFeed";
import { timingSafeEqual } from "../../../src/engine/util/hash";
import { BAR_ARCHIVE_STATUS_KEY, recordBarArchiveFailure } from "./barArchive";
import type { ScoreMessage } from "./do/IngestDO";
import { refreshInstruments } from "./instruments";
import { NO_SOURCE_REASON, QUOTE_RECORDER_STATUS_KEY } from "./quoteRecorder";
import { ENGINE_VERSION, advisorSettings, agentEnabled, errorMessage, makeRuntime, quoteSourceSummary } from "./runtime";
import { consumeScoreBatch } from "./scoring";
import { Alerts, parseTelegramUpdate, sendTelegram } from "./telegram";

export { TradingEngineDO } from "./do/TradingEngineDO";
export { IngestDO } from "./do/IngestDO";
export { BacktestDO } from "./do/BacktestDO";
export { MarketFeedDO } from "./do/MarketFeedDO";
export { AdvisorDO } from "./do/AdvisorDO";
export { AgentDO } from "./do/AgentDO";
export { EngineAdmin } from "./admin";

const engine = (env: Env) => env.ENGINE_DO.get(env.ENGINE_DO.idFromName("engine"));
const ingest = (env: Env) => env.INGEST_DO.get(env.INGEST_DO.idFromName("ingest"));
const marketFeed = (env: Env) => env.MARKET_FEED_DO.get(env.MARKET_FEED_DO.idFromName("feed"));
const advisor = (env: Env) => env.ADVISOR_DO.get(env.ADVISOR_DO.idFromName("advisor"));
const agentDo = (env: Env) => env.AGENT_DO.get(env.AGENT_DO.idFromName("agent"));

/**
 * The daily automatic advisor brief (ADVISOR_AUTO_RUN, 09:25 IST): inside its 10-minute window the minute cron
 * pokes the AdvisorDO, which runs it at most once a trading day. Never throws.
 */
async function maybeAutoRunAdvisor(env: Env, now: number, logger: { error(msg: string, data?: unknown): void }): Promise<void> {
  const at = advisorSettings(env).autoRunAtMin;
  const min = istMinutes(now);
  if (at == null || min < at || min >= at + AUTO_RUN_WINDOW_MIN) return;
  try {
    await advisor(env).autoRun();
  } catch (err) {
    logger.error("advisor auto-run failed", { error: errorMessage(err) });
  }
}

/** Pokes the market feed (it connects inside 09:10-15:35 IST and sleeps otherwise); never throws. */
async function wakeMarketFeed(env: Env, logger: { error(msg: string, data?: unknown): void }): Promise<void> {
  try {
    await marketFeed(env).ensureRunning();
  } catch (err) {
    logger.error("market feed wake failed", { error: redactFeedError(err, [env.UPSTOX_ANALYTICS_TOKEN]) });
  }
}

/** Cron expressions in workers/engine/wrangler.jsonc (UTC; IST = UTC+5:30). */
export const CRONS = {
  INGEST_BASE: "*/10 * * * *",
  INGEST_BOOST: "1-59/2 3-10 * * MON-FRI",
  ENGINE_WAKE: "* 3-10 * * MON-FRI",
  TOKEN: "30 2 * * MON-FRI",
  INSTRUMENTS: "40 2 * * MON-FRI",
  PREMARKET: "0 3 * * MON-FRI",
  POSTMARKET: "30 10 * * MON-FRI",
  /** 16:15 IST: append the session's settled 5-minute bars to D1 bars_5m (barArchive.ts). */
  ARCHIVE: "45 10 * * MON-FRI",
  NIGHTLY: "30 14 * * *",
  PREVIEW: "*/30 * * * *",
} as const;

async function runCron(cron: string, env: Env): Promise<void> {
  const rt = makeRuntime(env, "cron");
  const now = Date.now();
  const tradingDay = rt.calendar.isTradingDay(istDate(now));
  const alerts = new Alerts(env, rt.repo.state, rt.logger);
  switch (cron) {
    case CRONS.INGEST_BASE:
      await ingest(env).runCycle("base");
      return;
    case CRONS.INGEST_BOOST:
      if (tradingDay) await ingest(env).runCycle("boost");
      return;
    case CRONS.ENGINE_WAKE:
      if (tradingDay) {
        // The feed first and independently: a trading-loop failure must not keep it from connecting at 09:10.
        await wakeMarketFeed(env, rt.logger);
        await maybeAutoRunAdvisor(env, now, rt.logger);
        await engine(env).ensureRunning();
      }
      return;
    case CRONS.TOKEN:
      if (tradingDay) await engine(env).refreshToken();
      return;
    case CRONS.INSTRUMENTS:
      try {
        await refreshInstruments(env, now, rt.logger);
      } catch (err) {
        rt.logger.error("instrument refresh failed", { error: errorMessage(err) });
        await alerts.send(`⚠ Instrument master refresh failed: ${errorMessage(err)}`, { key: "instruments", minIntervalMs: 6 * 3_600_000 });
      }
      return;
    case CRONS.PREMARKET:
      await ingest(env).runCycle("premarket");
      if (tradingDay) await engine(env).premarket();
      return;
    case CRONS.POSTMARKET:
      if (tradingDay) {
        try {
          await engine(env).endOfDay();
        } finally {
          // The options agent's nightly review is queued even when the end of day failed (the AgentDO runs it from
          // 16:20 IST; the trading DO's end of day asks too, and the second request is a no-op).
          if (agentEnabled(env)) {
            try {
              await agentDo(env).scheduleReview(istDate(now));
            } catch (err) {
              rt.logger.error("agent review not scheduled", { error: errorMessage(err) });
            }
          }
        }
      }
      return;
    case CRONS.ARCHIVE:
      // The DO job never throws; this catch covers the call itself (e.g. the DO restarting).
      if (tradingDay) {
        try {
          await engine(env).archiveBars();
        } catch (err) {
          rt.logger.error("bar archive call failed", { error: errorMessage(err) });
          await recordBarArchiveFailure(env.KV, `engine DO call failed: ${errorMessage(err)}`, now, rt.logger);
        }
      }
      return;
    case CRONS.NIGHTLY: {
      const pruned = await rt.repo.prune(now);
      rt.logger.info("nightly prune", pruned);
      return;
    }
    case CRONS.PREVIEW:
      await ingest(env).runCycle("base");
      if (tradingDay) {
        await wakeMarketFeed(env, rt.logger);
        await engine(env).ensureRunning();
      }
      return;
    default:
      rt.logger.warn("unknown cron", { cron });
  }
}

function bearer(req: Request): string {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

async function handleFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health" && req.method === "GET") {
    const rt = makeRuntime(env, "http");
    const hb = await rt.repo.heartbeat.read().catch(() => null);
    return Response.json({ ok: true, env: env.ENGINE_ENV, version: ENGINE_VERSION, at: new Date().toISOString(), heartbeat: hb ? { phase: hb.phase, lastTickMs: hb.lastTickMs, errors: hb.consecutiveErrors } : null });
  }

  if (url.pathname === "/telegram/webhook" && req.method === "POST") {
    const cmd = await parseTelegramUpdate(req, env);
    if (!cmd) return new Response("ignored", { status: 200 });
    const rt = makeRuntime(env, "telegram");
    let reply: string;
    try {
      if (cmd.command === "status") reply = await engine(env).statusText();
      else if (cmd.command === "kill") reply = (await engine(env).setKillSwitch({ engaged: true, squareOff: true, reason: cmd.args || "telegram /kill" }, "telegram", "all")).message;
      else if (cmd.command === "disarm") reply = (await engine(env).setArmed(false, "telegram")).message;
      else reply = "Commands: /status, /kill [reason] (exits everything in every account), /disarm";
    } catch (err) {
      reply = `error: ${errorMessage(err)}`;
    }
    await sendTelegram(env, cmd.chatId, reply, rt.logger);
    return new Response("ok");
  }

  // Ops endpoints (curl / local dev): require ADMIN_TOKEN as a bearer token.
  if (url.pathname.startsWith("/ops/")) {
    if (!env.ADMIN_TOKEN || !timingSafeEqual(bearer(req), env.ADMIN_TOKEN)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    if (req.method !== "POST") return Response.json({ ok: false, error: "use POST" }, { status: 405 });
    const rt = makeRuntime(env, "ops");
    try {
      switch (url.pathname) {
        case "/ops/ingest":
          return Response.json(await ingest(env).runCycle(url.searchParams.get("reason") ?? "manual"));
        case "/ops/tick":
          return Response.json(await engine(env).tickNow());
        case "/ops/token":
          return Response.json(await engine(env).refreshToken());
        case "/ops/instruments":
          return Response.json({ ok: true, rows: await refreshInstruments(env, Date.now(), rt.logger) });
        case "/ops/premarket":
          return Response.json(await engine(env).premarket());
        case "/ops/eod":
          return Response.json(await engine(env).endOfDay());
        case "/ops/archive":
          // ?full=1 compares everything the source holds (fills older holes); ?force=1 runs on a non-trading day.
          return Response.json(await engine(env).archiveBars({ full: url.searchParams.get("full") === "1", force: url.searchParams.get("force") === "1" }));
        case "/ops/archive-status":
          return Response.json((await env.KV.get(BAR_ARCHIVE_STATUS_KEY, "json")) ?? { ok: false, error: "no bar archive run recorded yet" });
        case "/ops/quotes-status":
          // The read-only option-quote recorder (docs/DATA.md): last run, rows written, errors, last error.
          return Response.json(
            (await env.KV.get(QUOTE_RECORDER_STATUS_KEY, "json")) ??
              (() => {
                const q = quoteSourceSummary(env);
                return { ok: false, configured: q.configured, source: q.source, error: q.configured ? "no quote snapshot recorded yet" : `${NO_SOURCE_REASON}: nothing is recorded` };
              })(),
          );
        case "/ops/quotes-snapshot":
          // One snapshot now, labelled "manual" (left out of the report): checks the credentials and the table.
          return Response.json((await engine(env).recordQuotesNow()) ?? { ok: false, error: "no snapshot taken" });
        case "/ops/status":
          return new Response(await engine(env).statusText());
        case "/ops/feed-status":
          // The Upstox market feed socket: connected, last message, subscriptions, reconnects, last error
          // (never the token or the authorized URL). ?wake=1 also runs one connect/maintain step now.
          return Response.json(url.searchParams.get("wake") === "1" ? await marketFeed(env).ensureRunning() : await marketFeed(env).status());
        // The options agent (a paper experiment; docs/AGENT.md).
        case "/ops/agent-status":
          // The AgentDO's mode, pause, next job, today's spend against the cap, last batch and active guidance.
          return Response.json(await agentDo(env).status());
        case "/ops/agent-review": {
          // Queues a nightly review now (?date=YYYY-MM-DD, default today). Only outside the session.
          const date = url.searchParams.get("date") || istDate(Date.now());
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ ok: false, error: "date must be YYYY-MM-DD" }, { status: 400 });
          const res = await agentDo(env).runReviewNow(date);
          return Response.json(res, { status: res.ok ? 200 : 409 });
        }
        case "/ops/agent-count-tokens":
          // The API's token count of a snapshot alone against the local estimate (the newest stored ones and the worst case).
          return Response.json(await agentDo(env).countTokens());
        case "/ops/agent-revert": {
          // The built-in guidance becomes active again. Only outside the session.
          const res = await agentDo(env).revertInstruction("ops");
          return Response.json(res, { status: res.ok ? 200 : 409 });
        }
        case "/ops/agent-pause": {
          // ?on=1 pauses the agent (only its code exits run; no candle is judged), ?on=0 resumes it. Both sides are set.
          const on = url.searchParams.get("on");
          if (on !== "1" && on !== "0") return Response.json({ ok: false, error: "on must be 1 or 0" }, { status: 400 });
          const [engineSide, agentSide] = await Promise.allSettled([engine(env).setAgentPaused(on === "1", "ops"), agentDo(env).setPaused(on === "1")]);
          const side = (r: PromiseSettledResult<{ ok: boolean; message: string }>) => (r.status === "fulfilled" ? r.value : { ok: false, message: errorMessage(r.reason) });
          const res = { engine: side(engineSide), agent: side(agentSide) };
          return Response.json({ ok: res.engine.ok && res.agent.ok, ...res }, { status: res.engine.ok && res.agent.ok ? 200 : 409 });
        }
        case "/ops/telegram-test": {
          // Confirms the TELEGRAM_* secrets reach the chat (the alerts are otherwise silent no-ops).
          const alerts = new Alerts(env, rt.repo.state, rt.logger);
          const sent = alerts.enabled ? await alerts.send("✅ Telegram works: trade and copy-trade alerts from the engine will arrive here.") : false;
          return Response.json({ ok: sent, enabled: alerts.enabled });
        }
        default:
          return Response.json({ ok: false, error: "unknown op" }, { status: 404 });
      }
    } catch (err) {
      return Response.json({ ok: false, error: errorMessage(err) }, { status: 500 });
    }
  }
  return new Response("Not found", { status: 404 });
}

export default {
  fetch: handleFetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runCron(controller.cron, env).catch((err) => {
        console.error(JSON.stringify({ level: "error", scope: "cron", msg: "cron failed", data: { cron: controller.cron, error: errorMessage(err) } }));
      }),
    );
  },
  async queue(batch: MessageBatch<ScoreMessage>, env: Env): Promise<void> {
    await consumeScoreBatch(batch, env);
  },
} satisfies ExportedHandler<Env, ScoreMessage>;
