"use client";

/**
 * /copy, trade first and phone first: what to do now for each index (large type, the exact order and a
 * copy button), then the current trade with every value one tap from the clipboard, one "what to do now"
 * line, the price chart, the reasoning behind a Details disclosure, and the day's other trades.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { CopyTicketView, IndexId, SignalView } from "@/engine/api-types";
import AccountSwitcher from "@/components/Live/AccountSwitcher";
import { C, pnlColor } from "@/components/shared/colors";
import { fmtDateKey } from "@/components/shared/format";
import { SERIF } from "@/components/shared/theme";
import { EmptyState, Panel, Segmented, Skeleton } from "@/components/shared/ui";
import { EXIT_WORDS, hm, hms, nowLine, type IndexAction } from "@/lib/copy/action";
import { wholeRupees } from "@/lib/copy/prices";
import { istParts } from "@/lib/ist";
import IndexActionStrip from "./ActionStrip";
import { titleBadge } from "./alerts";
import CopyChart from "./CopyChart";
import { plainError } from "./sharedPoll";
import { GateList, MarketChips, SetupPanel } from "./TicketParts";
import TradeCard from "./TradeCard";
import { INDICES, useIndexActions, type CopyData } from "./useIndexActions";

const PAGE_TITLE = "Copy trades — Ruphak India Index Desk";

/**
 * The trade to show: an exit to act on first, then an entry (or a paused one), then the trade picked
 * from the list, then an open one, then the latest of the day.
 */
export function pickCurrent(actions: Record<IndexId, IndexAction> | null, tickets: CopyTicketView[] | null, picked: string | null): CopyTicketView | null {
  const list = tickets ?? [];
  const byKind = (...kinds: IndexAction["kind"][]) => INDICES.map((i) => actions?.[i]).find((a) => a && kinds.includes(a.kind) && a.ticket)?.ticket ?? null;
  const live = (t: CopyTicketView | null) => (t ? (list.find((x) => x.id === t.id) ?? t) : null);
  return live(byKind("EXIT_NOW")) ?? live(byKind("ENTER_NOW", "PAUSED")) ?? list.find((t) => t.id === picked) ?? live(byKind("MANAGE")) ?? list.find((t) => t.status === "OPEN") ?? list[0] ?? null;
}

function H3({ children }: { children: ReactNode }) {
  return <h3 style={{ margin: "18px 0 8px", fontSize: 14, fontWeight: 700, color: C.textStrong }}>{children}</h3>;
}

function signalMarket(s: SignalView): CopyTicketView["market"] {
  return { spot: s.spot ?? s.indicators?.spot ?? 0, changePct: null, vix: null, indicators: s.indicators };
}

function RawIds({ t }: { t: CopyTicketView }) {
  const rows: [string, string][] = [
    ["Position id", t.id],
    ["Plan id", t.planId],
    ["Account", `${t.account.id} (${t.account.label}, ${wholeRupees(t.account.capitalRupees)})`],
    ["Mode", t.mode],
    ["Contract", t.contract.label],
    ["Exchange symbol", t.contract.tradingSymbol],
    ["Groww symbol", t.contract.growwSymbol || "not given (synthetic contract)"],
    ["Entry price source", t.entry.priceSource === "model" ? "model (Black-Scholes on India VIX)" : "broker quote"],
    ["Index at entry", `${t.entry.spot}`],
    ["Skip beyond (raw)", t.entry.skipBeyondSpot == null ? "none" : `${t.entry.skipBeyondSpot}`],
  ];
  return (
    <dl className="tnum" style={{ display: "grid", gridTemplateColumns: "minmax(110px, auto) minmax(0, 1fr)", gap: "4px 12px", margin: 0, fontSize: 12.5 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt style={{ color: C.muted }}>{k}</dt>
          <dd style={{ margin: 0, color: C.textSoft, overflowWrap: "anywhere", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function TicketRow({ t, selected, onPick }: { t: CopyTicketView; selected: boolean; onPick: () => void }) {
  const pnl = t.exit?.pnl ?? t.live?.pnl ?? 0;
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      style={{
        display: "grid",
        gridTemplateColumns: "52px minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 10,
        width: "100%",
        minHeight: 52,
        textAlign: "left",
        padding: "10px 14px",
        border: "none",
        borderTop: `1px solid ${C.borderSoft}`,
        background: selected ? C.navActive : "transparent",
        cursor: "pointer",
        color: C.textSoft,
        fontSize: 13.5,
      }}
    >
      <span className="tnum" style={{ color: C.muted }}>
        {hm(t.entry.at)}
      </span>
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        <b style={{ color: C.textStrong }}>{t.headline}</b>
        <span style={{ color: C.muted2 }}> · {t.status === "OPEN" ? "open" : t.exit ? EXIT_WORDS[t.exit.reason] : "closed"}</span>
      </span>
      <span className="tnum" style={{ fontWeight: 700, color: pnlColor(pnl) }}>
        {wholeRupees(pnl, true)}
      </span>
    </button>
  );
}

function emptyText(d: CopyData): string {
  if (d.phase === "HOLIDAY" || (d.nowMs != null && istParts(d.nowMs).weekday >= 6)) return "No trades today: the market is closed.";
  const mins = d.nowMs != null ? istParts(d.nowMs).minutesOfDay : 0;
  if (mins > 14 * 60 + 30) return "No trades today: new entries stop at 14:30 IST.";
  if (mins >= 9 * 60 + 25 && d.phase === "OPEN") return "No trade yet today: entries can come until 14:30 IST. The status above says what the engine is waiting for.";
  return "No trade yet: the first entry can come at 09:25 IST.";
}

/** The day's paper trades laid out for copying by hand. `account`: the paper account (default main). */
export default function CopyDesk({ initialId, account }: { initialId: string | null; account?: string }) {
  const d = useIndexActions(account);
  const [picked, setPicked] = useState<string | null>(initialId);
  const [watch, setWatch] = useState<IndexId>("NIFTY");
  const list = d.tickets.data;
  const current = pickCurrent(d.actions, list, picked);
  const currentAction = current && d.actions?.[current.index]?.ticket?.id === current.id ? d.actions[current.index] : null;
  const chartIndex = current?.index ?? watch;
  const active = d.phase === "OPEN" || d.phase === "PRE_OPEN";
  const weekend = d.nowMs != null && istParts(d.nowMs).weekday >= 6;
  const chartDate = current ? current.entry.at.slice(0, 10) : d.phase === "HOLIDAY" || weekend ? null : d.date;
  // Before 09:15 on a trading day today's session has no candles yet: don't ask for them.
  const beforeOpen = !current && chartDate != null && chartDate === d.date && d.nowMs != null && istParts(d.nowMs).minutesOfDay < 9 * 60 + 15;
  const signalFor = (index: IndexId) => d.signals?.find((s) => s.index === index) ?? null;

  const badge = titleBadge(d.actions);
  useEffect(() => {
    document.title = badge ? `${badge} — Copy trades` : PAGE_TITLE;
    return () => {
      document.title = PAGE_TITLE;
    };
  }, [badge]);

  const pick = (id: string) => {
    setPicked(id);
    const sp = new URLSearchParams(window.location.search);
    sp.set("id", id);
    window.history.replaceState(null, "", `${window.location.pathname}?${sp.toString()}`);
    document.getElementById("trade")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const loadError = plainError(d.tickets.error);

  return (
    <main style={{ width: "100%", maxWidth: 1240, margin: "0 auto", padding: "16px 16px 56px", display: "grid", gap: 18, boxSizing: "border-box", minWidth: 0 }}>
      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "8px 16px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 12px", minWidth: 0 }}>
          <h1 style={{ margin: 0, fontFamily: SERIF, fontSize: 26, fontWeight: 500, letterSpacing: "-0.01em", color: C.textStrong }}>Copy trades</h1>
          <span style={{ fontSize: 13, color: C.muted }}>{d.date ? `${fmtDateKey(d.date)} · ` : ""}paper trades to repeat by hand</span>
        </div>
        <AccountSwitcher basePath="/copy" />
      </header>

      <IndexActionStrip account={d.account.id} />

      <section id="trade" aria-label="The trade" style={{ scrollMarginTop: 84, minWidth: 0 }}>
        {current ? (
          <Panel style={{ padding: 16 }}>
            <TradeCard t={current} a={currentAction} ticketsAgeMs={d.ticketsAgeMs} />
          </Panel>
        ) : list == null && !d.tickets.error ? (
          <Skeleton height={240} style={{ borderRadius: 14 }} />
        ) : (
          <Panel>
            <EmptyState style={{ padding: "28px 16px", fontSize: 15, color: list == null ? C.orange : C.muted }}>
              {list == null ? `${loadError ?? "Can't load today's trades."} Today's trades will show here once it answers; it retries every few seconds.` : emptyText(d)}
            </EmptyState>
          </Panel>
        )}
      </section>

      <p style={{ margin: 0, fontSize: 16, lineHeight: 1.5, fontWeight: 600, color: C.textStrong }}>
        <span style={{ color: C.gold }}>What to do now → </span>
        {current ? nowLine(currentAction, current) : "Nothing to copy yet. The statuses above say what the engine is waiting for, and this page chimes when that changes (turn alerts on)."}
      </p>

      <section aria-label="Price action" style={{ display: "grid", gap: 10, minWidth: 0 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 22, fontWeight: 500, color: C.textStrong }}>Price action · {chartIndex} 5-minute</h2>
          {!current && (
            <Segmented<IndexId>
              label="Index"
              value={watch}
              onChange={setWatch}
              options={[
                { value: "NIFTY", label: "NIFTY" },
                { value: "SENSEX", label: "SENSEX" },
              ]}
            />
          )}
        </div>
        <Panel style={{ padding: 12 }}>
          <CopyChart index={chartIndex} date={chartDate} ticket={current} active={active} phase={d.phase} beforeOpen={beforeOpen} />
        </Panel>
      </section>

      <details style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: "4px 16px", minWidth: 0 }}>
        <summary style={{ cursor: "pointer", minHeight: 48, display: "flex", alignItems: "center", fontSize: 15, fontWeight: 700, color: C.textStrong }}>
          Details: why, every check, indicator readings and raw IDs
        </summary>
        <div style={{ paddingBottom: 16 }}>
          {current?.setup && (
            <>
              <H3>Why the engine took {current.headline}</H3>
              <SetupPanel t={current} />
            </>
          )}
          {current && (
            <>
              <H3>{current.index} when the engine bought</H3>
              <MarketChips index={current.index} market={current.market} />
            </>
          )}
          {INDICES.map((index) => {
            const s = signalFor(index);
            if (!s) return null;
            return (
              <div key={index}>
                <H3>
                  Every check on the engine&apos;s latest {index} reading ({hms(s.computedAt)} IST)
                </H3>
                <p style={{ margin: "0 0 8px", fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>{s.rationale}</p>
                <GateList gates={s.gates} />
                {s.indicators && (
                  <div style={{ marginTop: 10 }}>
                    <MarketChips index={index} market={signalMarket(s)} />
                  </div>
                )}
              </div>
            );
          })}
          {current && current.steps.length > 0 && (
            <>
              <H3>The engine&apos;s own copy steps</H3>
              <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6, fontSize: 12.5, color: C.textSoft, lineHeight: 1.5 }}>
                {current.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </>
          )}
          {current && (
            <>
              <H3>Raw IDs</H3>
              <RawIds t={current} />
            </>
          )}
        </div>
      </details>

      {list && list.length > 0 && (
        <section aria-label="Today's trades" style={{ display: "grid", gap: 10, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 22, fontWeight: 500, color: C.textStrong }}>Today&apos;s trades ({list.length})</h2>
          <Panel style={{ padding: 0 }}>
            {list.map((t) => (
              <TicketRow key={t.id} t={t} selected={t.id === current?.id} onPick={() => pick(t.id)} />
            ))}
          </Panel>
        </section>
      )}

      <p style={{ margin: 0, fontSize: 12, color: C.muted2, lineHeight: 1.6 }}>
        These are paper trades. Over the sessions backtested so far the strategy lost money on both accounts, so copying them with real money is likely to lose money too. Without a broker feed the
        engine&apos;s option prices are model prices, and the index data is about a minute late: check the real price, size from your own capital, and always use a stop-loss.
      </p>
    </main>
  );
}
