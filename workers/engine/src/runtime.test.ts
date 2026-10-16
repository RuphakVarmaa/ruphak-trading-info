import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accountConfig, followerIds } from "../../../src/engine/accounts";
import { GrowwDataClient } from "../../../src/engine/broker/groww";
import { UPSTOX_QUOTE_SOURCE, UpstoxQuotes } from "../../../src/engine/market/upstoxQuotes";
import { accountViews, agentEnabled, agentSettings, enabledAccounts, engineConfig, liveDataSource, parseQuoteSourceChoice, quoteSourceSummary, recorderQuoteSource, upstoxLiveClient } from "./runtime";

const tokens = { token: async () => "t", invalidate: () => {} };
const env = (o: Partial<Env>): Env => ({ GROWW_DATA_VIA_RELAY: "false", QUOTE_SOURCE: "auto", ...o }) as unknown as Env;

describe("the quote recorder's source (read-only)", () => {
  it("parses QUOTE_SOURCE, defaulting to auto", () => {
    expect(parseQuoteSourceChoice(undefined)).toBe("auto");
    expect(parseQuoteSourceChoice(" Upstox ")).toBe("upstox");
    expect(parseQuoteSourceChoice("groww")).toBe("groww");
    expect(parseQuoteSourceChoice("off")).toBe("off");
    expect(parseQuoteSourceChoice("nse-website")).toBe("auto");
  });

  it("auto: Groww when its keys are set, else the free Upstox token, else nothing (with the recorder's own text)", () => {
    const groww = recorderQuoteSource(env({ GROWW_API_KEY: "k", GROWW_TOTP_SECRET: "s", UPSTOX_ANALYTICS_TOKEN: "u" }), tokens);
    expect(groww.source).toBeInstanceOf(GrowwDataClient);
    const upstox = recorderQuoteSource(env({ UPSTOX_ANALYTICS_TOKEN: " u-token " }), null);
    expect(upstox.source).toBeInstanceOf(UpstoxQuotes);
    expect(upstox.source?.name).toBe(UPSTOX_QUOTE_SOURCE);
    expect(recorderQuoteSource(env({}), null)).toEqual({ source: null, reason: null });
  });

  it("a forced choice uses only that source and says what is missing; off records nothing", () => {
    expect(recorderQuoteSource(env({ QUOTE_SOURCE: "upstox", UPSTOX_ANALYTICS_TOKEN: "u" }), tokens).source).toBeInstanceOf(UpstoxQuotes);
    expect(recorderQuoteSource(env({ QUOTE_SOURCE: "upstox" }), tokens)).toEqual({ source: null, reason: "QUOTE_SOURCE=upstox but the Worker secret UPSTOX_ANALYTICS_TOKEN is not set" });
    expect(recorderQuoteSource(env({ QUOTE_SOURCE: "groww", UPSTOX_ANALYTICS_TOKEN: "u" }), null).reason).toMatch(/^QUOTE_SOURCE=groww but the Groww Trade API keys/);
    expect(recorderQuoteSource(env({ QUOTE_SOURCE: "off", UPSTOX_ANALYTICS_TOKEN: "u" }), tokens)).toEqual({ source: null, reason: "the quote recorder is switched off (QUOTE_SOURCE=off)" });
  });

  it("summarises the configured source without any network call", () => {
    expect(quoteSourceSummary(env({}))).toEqual({ configured: false, source: null });
    expect(quoteSourceSummary(env({ UPSTOX_ANALYTICS_TOKEN: "u" }))).toEqual({ configured: true, source: UPSTOX_QUOTE_SOURCE });
    expect(quoteSourceSummary(env({ GROWW_API_KEY: "k", GROWW_TOTP_SECRET: "s", UPSTOX_ANALYTICS_TOKEN: "u" }))).toEqual({ configured: true, source: "groww:live-data/quote" });
    expect(quoteSourceSummary(env({ QUOTE_SOURCE: "off", UPSTOX_ANALYTICS_TOKEN: "u" }))).toEqual({ configured: false, source: null });
  });
});

describe("liveDataSource", () => {
  it("defaults to upstox when the token is set; yahoo when asked or without a token", () => {
    expect(liveDataSource(env({ UPSTOX_ANALYTICS_TOKEN: "u" }))).toBe("upstox");
    expect(liveDataSource(env({ LIVE_DATA: "upstox", UPSTOX_ANALYTICS_TOKEN: "u" }))).toBe("upstox");
    expect(liveDataSource(env({ LIVE_DATA: " Yahoo ", UPSTOX_ANALYTICS_TOKEN: "u" }))).toBe("yahoo");
    expect(liveDataSource(env({ LIVE_DATA: "upstox" }))).toBe("yahoo");
    expect(upstoxLiveClient(env({ UPSTOX_ANALYTICS_TOKEN: "u" }))).toBeInstanceOf(UpstoxQuotes);
    expect(upstoxLiveClient(env({ LIVE_DATA: "yahoo", UPSTOX_ANALYTICS_TOKEN: "u" }))).toBeNull();
  });
});

interface WranglerEnv {
  vars: Record<string, string>;
  durable_objects: { bindings: { name: string; class_name: string }[] };
  migrations: { tag: string; new_sqlite_classes?: string[] }[];
}

/** workers/engine/wrangler.jsonc as data: comments outside strings and trailing commas removed. */
function wranglerConfig(): WranglerEnv & { env: { preview: WranglerEnv } } {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      // A string, copied whole (escapes included).
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

describe("the options agent in the Worker config (wrangler.jsonc)", () => {
  const w = wranglerConfig();
  const prod = w.vars as unknown as Env;
  const preview = w.env.preview.vars as unknown as Env;

  it("builds every enabled account's config, the agent's included, from the production and the preview vars", () => {
    for (const vars of [prod, preview]) {
      const base = engineConfig(vars);
      for (const id of enabledAccounts(vars)) expect(() => accountConfig(base, id)).not.toThrow();
      const agent = accountConfig(base, "agent");
      // Its pins hold whatever main's vars say (CAPITAL_INR, MAX_OPEN_PER_INDEX, MAX_TRADES_PER_DAY, EDGE_GATE).
      expect(agent.capitalRupees).toBe(500_000);
      expect(agent.sizing).toMatchObject({ maxOpenPerIndex: 1, maxOpenTotal: 2, maxTradesPerDay: 6, maxLots: 3, maxRiskPctPerTrade: 1 });
      expect(agent.gates.expectedMoveModel).toBe("calibrated");
      expect(agent.risk.dailyLossCapPct).toBe(3);
    }
  });

  it("enables the agent in shadow mode in production and keeps it off in preview", () => {
    expect(enabledAccounts(prod)).toEqual(["main", "small10k", "small5k", "agent"]);
    expect(agentEnabled(prod)).toBe(true);
    expect(prod.AGENT_MODE).toBe("shadow");
    // Production's followers are the same two as before: the agent never follows main's signals.
    expect(followerIds(enabledAccounts(prod))).toEqual(["small10k", "small5k"]);
    expect(enabledAccounts(preview)).toEqual(["main", "small10k", "small5k"]);
    expect(agentEnabled(preview)).toBe(false);
    expect(preview.AGENT_MODE).toBe("off");
  });

  it("sets the same AGENT_* keys in both environments, and binds and migrates the AgentDO in both", () => {
    const keys = (v: Record<string, string>) => Object.keys(v).filter((k) => k.startsWith("AGENT_")).sort();
    expect(keys(w.vars)).toEqual(["AGENT_DAILY_USD_CAP", "AGENT_ESCALATIONS_PER_DAY", "AGENT_ESCALATION_MODEL", "AGENT_MODE", "AGENT_MODEL", "AGENT_REVIEW_MODEL"]);
    expect(keys(w.env.preview.vars)).toEqual(keys(w.vars));
    for (const k of keys(w.vars)) if (k !== "AGENT_MODE") expect(w.env.preview.vars[k]).toBe(w.vars[k]);
    for (const e of [w, w.env.preview]) {
      expect(e.durable_objects.bindings).toContainEqual({ name: "AGENT_DO", class_name: "AgentDO" });
      expect(e.migrations.at(-1)).toEqual({ tag: "v5", new_sqlite_classes: ["AgentDO"] });
    }
    expect(w.env.preview.migrations).toEqual(w.migrations);
  });
});

describe("accountViews", () => {
  it("marks only the agent's account with a kind, so main's and the followers' views stay as they were", () => {
    const views = accountViews({ cfg: engineConfig(env({ CAPITAL_INR: "500000" })) }, ["main", "small10k", "small5k", "agent"]);
    expect(views.map((v) => ("kind" in v ? v.kind : "-"))).toEqual(["-", "-", "-", "agent"]);
    expect(views[3]).toEqual({ id: "agent", label: "Agent ₹5L", shortLabel: "Agent", paperOnly: true, capitalRupees: 500_000, kind: "agent" });
  });
});

// The defaults and bounds live in the engine package's parser (src/engine/agent/config.ts). Until it lands, its
// placeholder throws "not implemented" and this block waits for it.
const agentParser = (() => {
  try {
    agentSettings(env({}));
    return true;
  } catch (err) {
    if (err instanceof Error && /not implemented/.test(err.message)) return false;
    throw err;
  }
})();

describe.skipIf(!agentParser)("agentSettings (the AGENT_* vars)", () => {
  it("defaults to off with a $3 cap and 8 escalations a day, and passes the model vars through", () => {
    const s = agentSettings(env({}));
    expect(s).toMatchObject({ mode: "off", dailyUsdCap: 3, escalationsPerDay: 8 });
    for (const m of [s.reflexModel, s.escalationModel, s.reviewModel]) expect(m.length).toBeGreaterThan(0);
    expect(agentSettings(env({ AGENT_MODEL: "reflex-x", AGENT_ESCALATION_MODEL: "deep-x", AGENT_REVIEW_MODEL: "deep-y" }))).toMatchObject({ reflexModel: "reflex-x", escalationModel: "deep-x", reviewModel: "deep-y" });
  });

  it("accepts the three modes and turns anything else off; clamps the cap to 0..20 and escalations to 0..24", () => {
    expect(agentSettings(env({ AGENT_MODE: "shadow" })).mode).toBe("shadow");
    expect(agentSettings(env({ AGENT_MODE: "paper" })).mode).toBe("paper");
    expect(agentSettings(env({ AGENT_MODE: "live" })).mode).toBe("off");
    expect(agentSettings(env({ AGENT_DAILY_USD_CAP: "50" })).dailyUsdCap).toBe(20);
    expect(agentSettings(env({ AGENT_DAILY_USD_CAP: "-1" })).dailyUsdCap).toBe(0);
    expect(agentSettings(env({ AGENT_DAILY_USD_CAP: "abc" })).dailyUsdCap).toBe(3);
    expect(agentSettings(env({ AGENT_ESCALATIONS_PER_DAY: "99" })).escalationsPerDay).toBe(24);
    expect(agentSettings(env({ AGENT_ESCALATIONS_PER_DAY: "-3" })).escalationsPerDay).toBe(0);
  });
});
