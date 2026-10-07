// Secrets are set with `wrangler secret put <NAME>` (and `.dev.vars` locally), so
// `wrangler types` cannot see them. They are optional: paper mode runs without Groww,
// relay or Telegram credentials, and scoring falls back to the lexicon scorer without
// an Anthropic key.
interface Env {
  GROWW_API_KEY?: string;
  GROWW_TOTP_SECRET?: string;
  ANTHROPIC_API_KEY?: string;
  GNEWS_API_KEY?: string;
  RELAY_URL?: string;
  RELAY_HMAC_SECRET?: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_TOKEN?: string;
}
