"use client";

import type { IndexPlanView, PlanCheckView, PlanWindowView, TodayPlanView } from "@/engine/api-types";
import { useEngineState } from "@/hooks/useEngineState";
import { alpha, C } from "@/components/shared/colors";
import { fmtIstDay, fmtIstHm, fmtPct } from "@/components/shared/format";
import { EmptyState, Panel, PanelHeader, Pill, Skeleton } from "@/components/shared/ui";

const VERDICT: Record<IndexPlanView["verdict"], { label: string; color: string }> = {
  no_trade: { label: "No new entries", color: C.red },
  caution: { label: "Caution", color: C.orange },
  clear: { label: "No rule blocks", color: C.green },
};

const STATUS: Record<PlanCheckView["status"], { mark: string; color: string; word: string }> = {
  block: { mark: "✕", color: C.red, word: "blocks" },
  caution: { mark: "!", color: C.orange, word: "caution" },
  clear: { mark: "✓", color: C.green, word: "clear" },
  unknown: { mark: "?", color: C.muted, word: "no data" },
};

const WINDOW_COLOR: Record<PlanWindowView["kind"], string> = { trade: C.green, avoid: C.orange, close: C.muted };

/** First letter upper-cased (the reason follows a bold "Buying is paused."). */
const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function Windows({ windows }: { windows: PlanWindowView[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "12px 16px", borderTop: `1px solid ${C.borderSoft}` }}>
      {windows.map((w) => {
        const color = WINDOW_COLOR[w.kind];
        return (
          <div
            key={`${w.from}-${w.to}`}
            title={w.why}
            style={{ flex: "1 1 150px", minWidth: 0, borderRadius: 10, padding: "8px 10px", border: `1px solid ${alpha(color, 0.35)}`, background: alpha(color, 0.07) }}
          >
            <div className="tnum" style={{ fontSize: 12, fontWeight: 700, color: C.textStrong, fontFamily: "var(--font-num)" }}>
              {w.from}–{w.to}
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: "0.04em", marginTop: 2 }}>
              {w.kind === "close" ? w.label : `${w.kind === "trade" ? "Entry window" : "No new buys"} · ${w.label}`}
            </div>
            <div style={{ fontSize: 11, color: C.textSoft, marginTop: 4, lineHeight: 1.45 }}>{w.why}</div>
          </div>
        );
      })}
    </div>
  );
}

function CheckRow({ c }: { c: PlanCheckView }) {
  const s = STATUS[c.status];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "22px minmax(0, 1fr)", gap: 8, padding: "8px 0", borderTop: `1px solid ${C.borderSoft}` }}>
      <span
        aria-label={s.word}
        title={s.word}
        style={{ width: 20, height: 20, borderRadius: 999, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, color: s.color, background: alpha(s.color, 0.12), border: `1px solid ${alpha(s.color, 0.35)}` }}
      >
        {s.mark}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.textStrong }}>{c.label}</div>
        <div style={{ fontSize: 12, color: C.textSoft, lineHeight: 1.45, marginTop: 2, overflowWrap: "anywhere" }}>{c.detail}</div>
      </div>
    </div>
  );
}

function IndexCard({ p }: { p: IndexPlanView }) {
  const v = VERDICT[p.verdict];
  const facts = [
    p.gapPct !== null ? `opened ${fmtPct(p.gapPct)}` : p.expectedGapPct !== null ? `gap estimate ${fmtPct(p.expectedGapPct)}` : null,
    p.expiry ? `contract ${fmtIstDay(`${p.expiry}T15:30:00+05:30`)}${p.sessionsLeft !== null ? ` (${p.sessionsLeft} session${p.sessionsLeft === 1 ? "" : "s"} left)` : ""}` : null,
  ].filter((x): x is string => x !== null);
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 14px", background: C.panel, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 15, fontWeight: 800, color: C.textStrong }}>{p.index}</span>
        <Pill color={v.color} solid={p.verdict === "no_trade"}>
          {v.label}
        </Pill>
      </div>
      <div style={{ fontSize: 12, color: C.textSoft, marginTop: 6, lineHeight: 1.45 }}>{p.headline}</div>
      {facts.length > 0 && <div className="tnum" style={{ fontSize: 11, color: C.muted, marginTop: 4, fontFamily: "var(--font-num)" }}>{facts.join(" · ")}</div>}
      <div style={{ marginTop: 8 }}>
        {p.checks.map((c) => (
          <CheckRow key={c.rule} c={c} />
        ))}
      </div>
    </div>
  );
}

function PlanBody({ plan }: { plan: TodayPlanView }) {
  return (
    <>
      {plan.buyingPaused && plan.pausedReason && (
        <div role="status" style={{ padding: "10px 16px", background: alpha(C.red, 0.08), borderTop: `1px solid ${alpha(C.red, 0.25)}`, fontSize: 12, color: C.textStrong, lineHeight: 1.5 }}>
          <strong style={{ color: C.red }}>Buying is paused.</strong> {sentence(plan.pausedReason.replace(/^Buying is paused: /, ""))}
        </div>
      )}
      <Windows windows={plan.windows} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 12, padding: "12px 16px", borderTop: `1px solid ${C.borderSoft}` }}>
        {plan.indices.map((p) => (
          <IndexCard key={p.index} p={p} />
        ))}
      </div>
      <div style={{ padding: "10px 16px", borderTop: `1px solid ${C.borderSoft}`, fontSize: 11, color: C.muted3, lineHeight: 1.5 }}>
        Information only, from the research plan: {plan.source}. These rules cut losses; they do not create an edge. The engine&apos;s own checks decide every paper trade.
      </div>
    </>
  );
}

/** The plan's no-trade rules for today's session (or the next one), with the session's entry windows. */
export default function TodayPlan() {
  const { plan } = useEngineState();
  const title = plan ? `${plan.when === "next" ? "Next session" : "Today"} · ${fmtIstDay(`${plan.date}T09:15:00+05:30`)}` : "Today";
  return (
    <Panel>
      <PanelHeader title={title} right={plan?.asOf ? <span style={{ fontSize: 11, color: C.muted3, textTransform: "none", letterSpacing: "0.02em" }}>market data {fmtIstDay(plan.asOf)} {fmtIstHm(plan.asOf)}</span> : undefined} />
      {plan == null ? (
        <div style={{ padding: 16, display: "grid", gap: 10 }}>
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} height={52} />
          ))}
        </div>
      ) : plan.indices.length === 0 ? (
        <EmptyState>No index is configured.</EmptyState>
      ) : (
        <PlanBody plan={plan} />
      )}
    </Panel>
  );
}
