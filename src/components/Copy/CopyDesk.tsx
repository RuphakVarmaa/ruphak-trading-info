"use client";

import { useEffect, useRef, useState } from "react";
import type { CopyTicketView, IndexId, SignalView } from "@/engine/api-types";
import AccountSwitcher from "@/components/Live/AccountSwitcher";
import { alpha, C, pnlColor } from "@/components/shared/colors";
import { fmtAge, fmtInr, fmtIstDay, fmtIstHm } from "@/components/shared/format";
import { Btn, EmptyState, PageHeader, Panel, PanelHeader, Section, Skeleton } from "@/components/shared/ui";
import { useClientNow, useEngineState } from "@/hooks/useEngineState";
import type { IntradayFeed } from "@/lib/market/intraday";
import CandleChart from "./CandleChart";
import TicketCard, { MarketChips, SetupPanel } from "./TicketCard";
import { usePolled } from "@/hooks/usePolled";

const PAGE_TITLE = "Copy trades — Ruphak India Index Desk";


/** The chart's empty state: "no candles yet" is normal before the open; anything else is a feed problem. */
function candleNote(error: string): string {
  if (error.startsWith("NOT_FOUND")) return "No 5-minute candles for this day yet. The chart fills in once the market opens at 09:15 IST.";
  return `The 5-minute chart is unavailable right now (${error.replace(/^[A-Z_]+: /, "")}). It retries on its own.`;
}

/** A short two-tone chime (Web Audio, no file to load). Browsers allow it once the page has been clicked. */
function chime(up: boolean) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const notes = up ? [660, 990] : [880, 520];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const at = ctx.currentTime + i * 0.18;
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(at);
      o.stop(at + 0.4);
    });
    setTimeout(() => void ctx.close(), 1000);
  } catch {
    // No audio: the on-page banner and the desktop notification still show.
  }
}

function desktopNotice(title: string, body: string) {
  try {
    if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body, tag: title });
  } catch {
    // Some mobile browsers only allow notifications from a service worker.
  }
}

/** How close each index is to a trade, while nothing has been bought today. */
function Waiting({ signals, phase }: { signals: SignalView[] | null; phase: string | undefined }) {
  const open = phase === "OPEN" || phase === "PRE_OPEN";
  return (
    <Panel>
      <PanelHeader title="No trade yet today" />
      <div style={{ padding: 16, display: "grid", gap: 14 }}>
        <div style={{ fontSize: 13, color: C.textSoft, lineHeight: 1.5 }}>
          {open
            ? "The engine buys when its conviction reaches the threshold and every check passes. Entries can come from 09:25 to 14:30 IST; this page refreshes every 5 seconds and chimes when one does (turn alerts on above)."
            : "The market is closed. Entries can come from 09:25 to 14:30 IST on the next session."}
        </div>
        {(signals ?? []).map((s) => {
          const v = Math.min(1, Math.abs(s.conviction));
          const color = s.conviction >= 0 ? C.green : C.red;
          return (
            <div key={s.index} style={{ display: "grid", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, fontSize: 12 }}>
                <b style={{ color: C.textStrong }}>{s.index}</b>
                <span style={{ color: C.muted, fontFamily: "var(--font-num)" }}>
                  {s.stance.toLowerCase()} {s.conviction >= 0 ? "+" : "−"}
                  {Math.abs(s.conviction).toFixed(2)} · needs {s.entryThreshold.toFixed(2)} · {s.regime.replace("_", " ").toLowerCase()}
                </span>
              </div>
              <div style={{ position: "relative", height: 8, background: C.track, borderRadius: 4, overflow: "hidden" }}>
                <div style={{ width: `${v * 100}%`, height: "100%", background: color }} />
                <div style={{ position: "absolute", left: `${s.entryThreshold * 100}%`, top: 0, bottom: 0, width: 2, background: C.textStrong }} />
              </div>
              {s.noPlanReason && <div style={{ fontSize: 11, color: C.muted2 }}>{s.noPlanReason}</div>}
            </div>
          );
        })}
      </div>
    </Panel>
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
        gridTemplateColumns: "56px 1fr auto",
        alignItems: "center",
        gap: 10,
        width: "100%",
        textAlign: "left",
        padding: "10px 12px",
        border: "none",
        borderTop: `1px solid ${C.borderSoft}`,
        background: selected ? alpha(C.gold, 0.08) : "transparent",
        cursor: "pointer",
        color: C.textSoft,
        fontSize: 12,
      }}
    >
      <span style={{ fontFamily: "var(--font-num)", color: C.muted }}>{fmtIstHm(t.entry.at)}</span>
      <span>
        <b style={{ color: C.textStrong }}>{t.headline}</b>
        <span style={{ color: C.muted2 }}> · {t.status === "OPEN" ? "open" : t.exit?.reasonText.toLowerCase()}</span>
      </span>
      <span style={{ fontFamily: "var(--font-num)", fontWeight: 700, color: pnlColor(pnl) }}>{fmtInr(pnl, { decimals: 0, sign: true })}</span>
    </button>
  );
}

/** The day's paper trades laid out for copying by hand, with the price action and the setup behind each. */
export default function CopyDesk({ initialId }: { initialId: string | null }) {
  const { state, signals } = useEngineState();
  const clientNow = useClientNow();
  const account = state?.account?.id ?? "main";
  const phase = state?.market.phase;
  const active = phase === "OPEN" || phase === "PRE_OPEN";
  const date = state?.market.nowIst.slice(0, 10) ?? null;
  const tickets = usePolled<CopyTicketView[]>(date ? `/api/engine/copy?date=${date}${account !== "main" ? `&account=${encodeURIComponent(account)}` : ""}` : null, active ? 5_000 : 60_000);
  const list = tickets.data;
  const [picked, setPicked] = useState<string | null>(initialId);
  const [watch, setWatch] = useState<IndexId>("NIFTY");
  const selected = list?.find((t) => t.id === picked) ?? list?.find((t) => t.status === "OPEN") ?? list?.[0] ?? null;
  const chartIndex = selected?.index ?? watch;
  const feed = usePolled<IntradayFeed>(`/api/market/intraday?index=${chartIndex}${selected ? `&date=${selected.entry.at.slice(0, 10)}` : ""}`, active ? 20_000 : 300_000);

  // Alerts: a chime, a desktop notification and the tab title when a trade opens or closes.
  const [alertsOn, setAlertsOn] = useState(false);
  const [banner, setBanner] = useState<{ text: string; up: boolean } | null>(null);
  const seen = useRef<Map<string, string> | null>(null);
  const alertsRef = useRef(alertsOn);
  useEffect(() => {
    alertsRef.current = alertsOn;
  }, [alertsOn]);
  useEffect(() => {
    if (!list) return;
    const before = seen.current;
    seen.current = new Map(list.map((t) => [t.id, t.status]));
    if (!before) return;
    for (const t of list) {
      const was = before.get(t.id);
      const bought = was === undefined && t.status === "OPEN";
      const sold = was === "OPEN" && t.status === "CLOSED";
      if (!bought && !sold) continue;
      const text = bought ? `${t.headline} · ${t.lots} lot (${t.qty}) · stop ₹${t.levels.stop.toFixed(2)}` : `SELL ${t.searchText} now · ${t.exit?.reasonText ?? "closed"}`;
      setBanner({ text, up: bought });
      if (alertsRef.current) {
        chime(bought);
        desktopNotice(bought ? `Copy: ${t.headline}` : `Copy: SELL ${t.searchText}`, text);
      }
    }
  }, [list]);
  const openTicket = list?.find((t) => t.status === "OPEN") ?? null;
  useEffect(() => {
    document.title = openTicket ? `● ${openTicket.headline} — copy` : PAGE_TITLE;
    return () => {
      document.title = PAGE_TITLE;
    };
  }, [openTicket]);

  const pick = (id: string) => {
    setPicked(id);
    const sp = new URLSearchParams(window.location.search);
    sp.set("id", id);
    window.history.replaceState(null, "", `${window.location.pathname}?${sp.toString()}`);
  };

  const turnOnAlerts = async () => {
    setAlertsOn(true);
    chime(true);
    try {
      if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
    } catch {
      // Permission prompt not available: the chime and banner still work.
    }
  };

  const updated = tickets.at != null && clientNow != null ? `updated ${fmtAge(Math.max(0, clientNow - tickets.at))} ago` : "connecting…";
  const accountLabel = state?.account && state.account.id !== "main" ? `${state.account.label} (${fmtInr(state.account.capitalRupees, { decimals: 0 })})` : "Main account";

  return (
    <main style={{ width: "100%", maxWidth: 1240, margin: "0 auto", padding: "32px 16px 56px", display: "grid", gap: 32, boxSizing: "border-box" }}>
      <PageHeader
        eyebrow={state ? fmtIstDay(state.market.nowIst) : "Copy trading"}
        title="Copy trades"
        sub={`${accountLabel}: what the paper engine buys and sells, with the levels, the setup and the price action, to repeat by hand in your own account.`}
        right={
          <>
            <AccountSwitcher basePath="/copy" />
            <span className="tnum" style={{ fontSize: 12, color: C.muted2 }}>{updated}</span>
          </>
        }
      />

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "12px 16px", borderRadius: 14, background: C.panel, border: `1px solid ${C.border}`, boxShadow: "var(--shadow-card)" }}>
        {alertsOn ? (
          <span style={{ fontSize: 12, color: C.green, fontWeight: 700 }}>🔔 Alerts on in this tab</span>
        ) : (
          <Btn variant="gold" size="md" onClick={() => void turnOnAlerts()}>
            🔔 Turn on sound and desktop alerts
          </Btn>
        )}
        <span style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, flex: "1 1 260px" }}>
          Keep this tab open during market hours. Phone alerts come through Telegram once the engine&apos;s Telegram bot is set up; each message links back here.
        </span>
      </div>

      {banner && (
        <div
          role="status"
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 10,
            alignItems: "center",
            padding: "12px 14px",
            borderRadius: 8,
            background: alpha(banner.up ? C.green : C.red, 0.1),
            border: `1px solid ${alpha(banner.up ? C.green : C.red, 0.45)}`,
            color: banner.up ? C.green : C.red,
            fontWeight: 700,
            fontSize: 14,
          }}
        >
          <span>{banner.text}</span>
          <Btn variant="ghost" onClick={() => setBanner(null)} aria-label="Dismiss">
            ✕
          </Btn>
        </div>
      )}

      {tickets.error && !list && (
        <Panel>
          <EmptyState style={{ padding: 16 }}>Could not load the trades: {tickets.error}</EmptyState>
        </Panel>
      )}

      {list == null && !tickets.error ? (
        <Skeleton height={220} />
      ) : list && list.length === 0 ? (
        <Waiting signals={signals} phase={phase} />
      ) : selected ? (
        <>
          <Section title={selected.status === "OPEN" ? "Trade to copy" : "Trade (closed)"}>
            <Panel style={{ padding: 16 }}>
              <TicketCard t={selected} />
            </Panel>
          </Section>
          <Section title={`Price action · ${selected.index} 5-minute`} right={feed.data ? <span style={{ fontSize: 11, color: C.muted2 }}>last {feed.data.last.toLocaleString("en-IN")} at {fmtIstHm(feed.data.asOf)} IST</span> : null}>
            <Panel style={{ padding: 12 }}>
              {feed.data ? (
                <CandleChart
                  feed={feed.data}
                  marks={{ entry: { at: selected.entry.at, spot: selected.entry.spot, side: selected.side }, exit: selected.exit ? { at: selected.exit.at } : null, skipBeyond: selected.status === "OPEN" ? selected.entry.skipBeyondSpot : null }}
                />
              ) : feed.error ? (
                <EmptyState style={{ padding: 16 }}>{candleNote(feed.error)}</EmptyState>
              ) : (
                <Skeleton height={280} />
              )}
              <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                <div style={{ fontSize: 13, color: C.muted, fontWeight: 600 }}>The index when the engine bought</div>
                <MarketChips t={selected} />
              </div>
            </Panel>
          </Section>
          <Section title="Why the engine took it">
            <Panel style={{ padding: 16 }}>
              <SetupPanel t={selected} />
            </Panel>
          </Section>
        </>
      ) : null}

      {list && list.length > 0 && (
        <Section title={`Today's trades (${list.length})`}>
          <Panel style={{ padding: 0, overflow: "hidden" }}>
            {list.map((t) => (
              <TicketRow key={t.id} t={t} selected={t.id === selected?.id} onPick={() => pick(t.id)} />
            ))}
          </Panel>
        </Section>
      )}

      {list && list.length === 0 && (
        <Section
          title={`Price action · ${watch} 5-minute`}
          right={
            <div style={{ display: "inline-flex", gap: 6 }}>
              {(["NIFTY", "SENSEX"] as IndexId[]).map((i) => (
                <Btn key={i} variant={i === watch ? "gold" : "outline"} onClick={() => setWatch(i)}>
                  {i}
                </Btn>
              ))}
            </div>
          }
        >
          <Panel style={{ padding: 12 }}>
            {feed.data ? <CandleChart feed={feed.data} marks={{}} /> : feed.error ? <EmptyState style={{ padding: 16 }}>{candleNote(feed.error)}</EmptyState> : <Skeleton height={280} />}
          </Panel>
        </Section>
      )}

      <p style={{ margin: 0, fontSize: 11, color: C.muted2, lineHeight: 1.6 }}>
        These are paper trades. Over the 54 sessions backtested so far the strategy lost money on both accounts, so copying them with real money is likely to lose money too. The engine&apos;s option prices are
        model prices until a broker feed is connected, and the index data is about a minute late: check the real price, size from your own capital, and use a stop-loss.
      </p>
    </main>
  );
}
