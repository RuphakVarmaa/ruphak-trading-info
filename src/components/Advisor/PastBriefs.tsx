"use client";

/**
 * Past briefs with their ideas. Opening a brief checks how its ideas did: for each contract still listed it
 * fetches the live chain once per index and expiry (client-side, only when opened) and shows the price now
 * against the ask when the brief was written. Expired contracts are said to be expired, not priced, and a day
 * trade from an earlier day is not priced either (it was for that day only; today's price says nothing about it).
 */
import { useRef, useState } from "react";
import type { AdvisorReportSummary, OptionChainView } from "@/engine/api-types";
import { alpha, C } from "@/components/shared/colors";
import { Panel, Pill } from "@/components/shared/ui";
import { errorText, fetchEnvelope } from "@/hooks/engineFetch";
import { ACTION_META, body } from "./AdvisorParts";
import { chainKey, daysToExpiry, HORIZON_WORDS, isOldDayTrade, parseContractLabel, pastCheck, plainContract, premium, writtenLine, type ParsedContract } from "./advisorText";

type ChainState = { state: "loading" } | { state: "ok"; chain: OptionChainView } | { state: "error"; error: string };

function IdeaCheck({
  idea,
  parsed,
  chain,
  createdAt,
  nowMs,
}: {
  idea: AdvisorReportSummary["ideas"][number];
  parsed: ParsedContract | null;
  chain: ChainState | undefined;
  createdAt: string;
  nowMs: number | null;
}) {
  const muted = { fontSize: 14.5, color: C.muted2, lineHeight: 1.5 } as const;
  if (isOldDayTrade(idea.horizon, createdAt, nowMs)) return <div style={muted}>A day trade for that day only: today&apos;s price does not show how it did.</div>;
  if (!parsed) return <div style={muted}>Current price: cannot tell which contract this is.</div>;
  if (nowMs != null && daysToExpiry(parsed.expiry, nowMs) < 0) return <div style={muted}>Expired: no longer listed, so no current price.</div>;
  if (!chain || chain.state === "loading") return <div style={muted}>Checking the price now…</div>;
  if (chain.state === "error") return <div style={muted}>Current price not available ({chain.error})</div>;
  // The chain answered but could not be read (broker or token trouble): that says nothing about the contract.
  if (chain.chain.error) return <div style={muted}>Current price not available ({chain.chain.error})</div>;
  if (chain.chain.expiry !== parsed.expiry) return <div style={muted}>No longer listed, so no current price.</div>;
  const row = chain.chain.rows.find((r) => r.strike === parsed.strike);
  const s = parsed.optionType === "CE" ? row?.ce : row?.pe;
  const ltp = s?.ltp ?? null;
  if (ltp == null) return <div style={muted}>No current price for this strike.</div>;
  const check = pastCheck(idea, ltp);
  const color = check.tone === "up" ? C.green : check.tone === "down" ? C.red : C.muted;
  return (
    <div className="tnum" style={{ fontSize: 15, fontWeight: 600, color, lineHeight: 1.5 }}>
      {check.words}
    </div>
  );
}

function BriefRow({
  brief,
  nowMs,
  chains,
  onOpen,
}: {
  brief: AdvisorReportSummary;
  nowMs: number | null;
  chains: Record<string, ChainState>;
  onOpen: (contracts: ParsedContract[]) => void;
}) {
  const parsed = brief.ideas.map((i) => parseContractLabel(i.label));
  const meta = ACTION_META[brief.todayAction];
  // Only contracts still listed, and not day trades from an earlier day (those are not priced), are fetched.
  const toCheck = parsed.filter(
    (p, i): p is ParsedContract => p != null && (nowMs == null || daysToExpiry(p.expiry, nowMs) >= 0) && !isOldDayTrade(brief.ideas[i].horizon, brief.createdAt, nowMs),
  );
  return (
    <details
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) onOpen(toCheck);
      }}
      style={{ borderTop: `1px solid ${C.borderSoft}` }}
    >
      <summary style={{ cursor: "pointer", padding: "14px 16px", display: "flex", alignItems: "flex-start", gap: 6 }}>
        <span style={{ display: "grid", gap: 6, flex: 1, minWidth: 0 }}>
          <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 10px" }}>
            <Pill color={meta.color} solid>
              {brief.todayAction}
            </Pill>
            <span style={{ fontSize: 14, color: C.muted2 }}>{writtenLine(brief.createdAt, nowMs)}</span>
            <span style={{ fontSize: 14, color: C.gold, fontWeight: 600, marginLeft: "auto" }}>{brief.ideas.length ? `${brief.ideas.length} idea${brief.ideas.length === 1 ? "" : "s"}` : "no ideas"}</span>
          </span>
          <span style={{ ...body, fontSize: 16, color: C.textStrong, overflowWrap: "anywhere" }}>{brief.headline}</span>
        </span>
      </summary>
      <div style={{ padding: "0 16px 16px", display: "grid", gap: 10 }}>
        {brief.ideas.length === 0 && <div style={{ fontSize: 14.5, color: C.muted2 }}>This brief had no trade ideas.</div>}
        {brief.ideas.map((idea, i) => {
          const p = parsed[i];
          return (
            <div key={idea.id} style={{ background: C.panelAlt, border: `1px solid ${C.borderSoft}`, borderRadius: 12, padding: "12px 12px", display: "grid", gap: 6 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
                <span style={{ fontSize: 16, fontWeight: 650, color: C.textStrong, overflowWrap: "anywhere" }}>{p ? plainContract(p, nowMs ?? Date.parse(brief.createdAt)) : idea.label}</span>
                <span style={{ fontSize: 13, color: C.muted2 }}>{HORIZON_WORDS[idea.horizon]}</span>
              </div>
              <div className="tnum" style={{ fontSize: 14.5, color: C.textSoft }}>
                Price when written {premium(idea.entryAsk)} · stop {premium(idea.stop)} · target {premium(idea.target)}
              </div>
              <IdeaCheck idea={idea} parsed={p} chain={p ? chains[chainKey(p)] : undefined} createdAt={brief.createdAt} nowMs={nowMs} />
            </div>
          );
        })}
      </div>
    </details>
  );
}

export default function PastBriefs({ history, latestId, nowMs }: { history: AdvisorReportSummary[]; latestId: string | null; nowMs: number | null }) {
  const [chains, setChains] = useState<Record<string, ChainState>>({});
  const requested = useRef(new Set<string>());
  const past = history.filter((h) => h.id !== latestId);

  const load = (contracts: ParsedContract[]) => {
    for (const c of contracts) {
      const key = chainKey(c);
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      setChains((s) => ({ ...s, [key]: { state: "loading" } }));
      fetchEnvelope<OptionChainView>(`/api/engine/chain?index=${encodeURIComponent(c.index)}&expiry=${encodeURIComponent(c.expiry)}`)
        .then(({ data }) => setChains((s) => ({ ...s, [key]: { state: "ok", chain: data } })))
        .catch((err: unknown) => {
          // Let a later open try again.
          requested.current.delete(key);
          setChains((s) => ({ ...s, [key]: { state: "error", error: errorText(err) } }));
        });
    }
  };

  if (!past.length) return <Panel style={{ padding: 18, fontSize: 15, color: C.muted2 }}>No earlier briefs yet.</Panel>;
  return (
    <Panel style={{ background: C.panel }}>
      <div style={{ padding: "12px 16px", fontSize: 14, color: C.muted2, background: alpha(C.gold, 0.04) }}>
        Open a brief to see what its ideas are worth now, against the price when it was written. This is the price now; it does not show whether the stop or the target was hit along the way.
      </div>
      {past.map((b) => (
        <BriefRow key={b.id} brief={b} nowMs={nowMs} chains={chains} onOpen={load} />
      ))}
    </Panel>
  );
}
