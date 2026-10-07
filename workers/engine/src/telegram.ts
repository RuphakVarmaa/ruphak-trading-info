/**
 * Telegram alerts (fills, rejects, kill trips, DEGRADED, missed heartbeats, daily summary)
 * and the bot webhook for /status and /kill. Alerts are rate-limited per key so a flapping
 * condition cannot spam the chat. Without TELEGRAM_* secrets everything is a logged no-op.
 */
import type { Logger, StateStore } from "../../../src/engine/ports";
import { timingSafeEqual } from "../../../src/engine/util/hash";

export interface AlertOptions {
  /** Deduplication key; the same key is sent at most once per `minIntervalMs`. */
  key?: string;
  minIntervalMs?: number;
}

export class Alerts {
  constructor(
    private readonly env: Env,
    private readonly state: StateStore,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return Boolean(this.env.TELEGRAM_BOT_TOKEN && this.env.TELEGRAM_CHAT_ID);
  }

  async send(text: string, o: AlertOptions = {}): Promise<boolean> {
    if (o.key) {
      const k = `alert:${o.key}`;
      const last = (await this.state.get<number>(k)) ?? 0;
      if (this.now() - last < (o.minIntervalMs ?? 15 * 60_000)) return false;
      await this.state.set(k, this.now());
    }
    this.logger.info("alert", { text: text.slice(0, 500) });
    if (!this.enabled) return false;
    return sendTelegram(this.env, this.env.TELEGRAM_CHAT_ID!, text, this.logger);
  }
}

export async function sendTelegram(env: Env, chatId: string, text: string, logger: Logger): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) logger.warn("telegram send failed", { status: res.status });
    return res.ok;
  } catch (err) {
    logger.warn("telegram send failed", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export interface TelegramCommand {
  chatId: string;
  command: "status" | "kill" | "disarm" | "help" | "unknown";
  args: string;
}

/** Validates the webhook secret header and the chat allowlist, then parses the command. */
export async function parseTelegramUpdate(req: Request, env: Env): Promise<TelegramCommand | null> {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !env.TELEGRAM_CHAT_ID) return null;
  if (!timingSafeEqual(req.headers.get("x-telegram-bot-api-secret-token") ?? "", secret)) return null;
  let update: { message?: { chat?: { id?: number | string }; text?: string } };
  try {
    update = (await req.json()) as typeof update;
  } catch {
    return null;
  }
  const chatId = String(update.message?.chat?.id ?? "");
  if (chatId !== String(env.TELEGRAM_CHAT_ID)) return null;
  const text = (update.message?.text ?? "").trim();
  const m = /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(text);
  if (!m) return { chatId, command: "unknown", args: text };
  const cmd = m[1].toLowerCase();
  const command = cmd === "status" || cmd === "kill" || cmd === "disarm" || cmd === "help" ? cmd : "unknown";
  return { chatId, command, args: m[2].trim() };
}
