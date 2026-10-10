import { describe, expect, it } from "vitest";
import { GrowwDataClient } from "../../../src/engine/broker/groww";
import { UPSTOX_QUOTE_SOURCE, UpstoxQuotes } from "../../../src/engine/market/upstoxQuotes";
import { parseQuoteSourceChoice, quoteSourceSummary, recorderQuoteSource } from "./runtime";

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
