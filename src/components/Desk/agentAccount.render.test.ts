import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MockEngineApi } from "@/lib/engine/mock";
import type { EngineSnapshot } from "@/lib/engine/types";
import { AgentTradesNote } from "@/components/Engine/TodaysTrades";
import { emptyPositionsText } from "@/components/Live/LiveBook";
import { EngineProvider } from "@/hooks/useEngineState";
import EngineDesk from "./IndiaDesk";

/** The mock engine's first paint for an account, as the home page's server snapshot builds it. */
async function snapshot(account?: string): Promise<EngineSnapshot> {
  const api = new MockEngineApi("sim");
  api.configure({ adminToken: null, fail: false });
  const state = await api.getState(account);
  const date = state.market.nowIst.slice(0, 10);
  const [signals, positions, events, orders, pnl, performance, scheduled, plan] = await Promise.all([
    api.getSignals(account),
    api.getPositions(account),
    api.getEvents({ tab: "ALL", limit: 60 }),
    api.getOrders(date, account),
    api.getPnl(30, account),
    api.getPerformance(account),
    api.getScheduled(192),
    api.getTodayPlan(),
  ]);
  return { source: "mock", fetchedAt: Date.now(), state, signals, positions, events, orders, pnl, performance, scheduled, plan };
}

/** The provider's props without children (the page goes in as createElement's child argument). */
type ProviderProps = Parameters<typeof EngineProvider>[0];
const page = async (account?: string) =>
  renderToStaticMarkup(createElement(EngineProvider, { initial: await snapshot(account), account } as ProviderProps, createElement(EngineDesk, { account })));
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("the Paper Engine page on the options agent's account (dashboard review L6)", () => {
  it("shows the agent's own account: no ₹10k card, no setups, no 'engine's own paper book', and says what the account is", async () => {
    const markup = await page("agent");
    expect(text(markup)).toContain("The options agent's paper account: a model judges each candle and code decides every order; see /agent");
    expect(markup).toContain('href="/agent"');
    expect(markup).not.toContain("trade now");
    expect(markup).not.toContain('aria-label="Trade setups"');
    expect(text(markup)).not.toContain("This follows the engine's own paper book");
    expect(text(markup)).not.toContain("new buys stay paused by the measured-edge check");
    // Main's plan and signals stay available, labelled as main's: its measured-edge pause is not the agent's state.
    expect(text(markup)).toContain("Why the main engine says this");
    expect(text(markup)).toContain("main's measured-edge pause does not apply to the agent");
  });

  it("keeps main's page as it was", async () => {
    const markup = await page();
    expect(text(markup)).toContain("This follows the engine's own paper book");
    expect(text(markup)).toContain("new buys stay paused by the measured-edge check");
    expect(markup).toContain('aria-label="Trade setups"');
    expect(text(markup)).toContain("Why the engine says this");
    expect(text(markup)).not.toContain("The options agent's paper account");
  });
});

describe("where the agent's trades are (dashboard review L5)", () => {
  it("points to this page's tables, Live P&L and the nightly review, never to a trade list on /agent that does not exist", () => {
    const markup = renderToStaticMarkup(createElement(AgentTradesNote, { label: "Agent ₹5L" }));
    const t = text(markup);
    expect(t).toContain("Its orders and fills are in this page's tables");
    expect(t).toContain("each day's trades are listed in the nightly review on the Agent page");
    expect(markup).toContain('href="/live?account=agent"');
    expect(markup).toContain('href="/agent#review"');
    expect(t).not.toContain("Each trade and the decision behind it is on the Agent page");
  });
});

describe("the Live page's empty positions line for the agent (dashboard review M6)", () => {
  it("never claims an edge: an entry needs every code check and sizing above zero", () => {
    const line = emptyPositionsText("2026-10-16T11:42:05+05:30", "OPEN", true);
    expect(line).toBe("No open positions right now. The agent enters only when a model's call passes every code check and sizing from graded calls is above zero.");
    expect(line).not.toMatch(/edge/i);
    expect(emptyPositionsText("2026-10-16T11:42:05+05:30", "OPEN", false)).toMatch(/news or at least two signals agree/);
  });
});
