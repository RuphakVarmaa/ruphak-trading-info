/**
 * Engine Worker entry (Phase 1 skeleton). Later phases replace the bodies with the
 * trading loop, ingestion, scoring consumer and admin RPC.
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export class TradingEngineDO extends DurableObject<Env> {
  async ping(): Promise<string> {
    return "engine-do-ok";
  }
}

export class IngestDO extends DurableObject<Env> {
  async ping(): Promise<string> {
    return "ingest-do-ok";
  }
}

export class EngineAdmin extends WorkerEntrypoint<Env> {
  async health(): Promise<{ ok: boolean; env: string }> {
    return { ok: true, env: this.env.ENGINE_ENV };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, env: env.ENGINE_ENV, at: new Date().toISOString() });
    }
    return new Response("Not found", { status: 404 });
  },
  async scheduled(controller: ScheduledController): Promise<void> {
    console.log("cron", controller.cron);
  },
  async queue(batch: MessageBatch<unknown>): Promise<void> {
    batch.ackAll();
  },
} satisfies ExportedHandler<Env>;
