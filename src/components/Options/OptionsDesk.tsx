"use client";

/**
 * /options: the live option chain for NIFTY or SENSEX (read-only), Groww style, with the engine's live
 * reading on top: when it says ENTER, that contract is highlighted on the chain.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { IndexId, LiveIndexLevelsView, OptionChainView, SignalView } from "@/engine/api-types";
import { alpha, C, dirColor } from "@/components/shared/colors";
import { fmtAge } from "@/components/shared/format";
import { SERIF } from "@/components/shared/theme";
import { Btn, EmptyState, Panel, Pill, Segmented, Skeleton, microLabel } from "@/components/shared/ui";
import { plainError, useSharedPoll } from "@/components/Copy/sharedPoll";
import ChainTable, { type Highlight } from "./ChainTable";
import { adviceLine, chainPollMs, diffFlashes, engineTieIn, shortExpiry, visibleRows, type Flash } from "./chainView";
import SideDetail from "./SideDetail";

const INDEX_OPTIONS = [
  { value: "NIFTY", label: "NIFTY" },
  { value: "SENSEX", label: "SENSEX" },
] as const;

export default function OptionsDesk({ initialIndex, initialExpiry }: { initialIndex: IndexId; initialExpiry: string | null }) {
  const [index, setIndex] = useState<IndexId>(initialIndex);
  const [expiry, setExpiry] = useState<string | null>(initialExpiry);
  const [more, setMore] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [picked, setPicked] = useState<Highlight | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const url = `/api/engine/chain?index=${index}${expiry ? `&expiry=${expiry}` : ""}`;
  // The engine's clock decides the session (the mock runs its own): its offset from this browser at the last answer.
  const [clockOffset, setClockOffset] = useState(0);
  const pollMs = chainPollMs(now + clockOffset);
  const chainPoll = useSharedPoll<OptionChainView>(url, pollMs);
  const signalsPoll = useSharedPoll<SignalView[]>("/api/engine/signals", Math.max(pollMs, 5_000));
  const levelsPoll = useSharedPoll<LiveIndexLevelsView>("/api/engine/live-indices", Math.max(pollMs, 5_000));
  const chain = chainPoll.data && chainPoll.data.index === index && (!expiry || chainPoll.data.expiry === expiry) ? chainPoll.data : null;

  const fetchedAt = chain?.fetchedAt ?? null;
  const receivedAt = chainPoll.at;
  const fetchedMs = fetchedAt ? Date.parse(fetchedAt) : NaN;
  // Derived state, adjusted during render (the poll interval depends on it, and the poll on the interval).
  const offset = Number.isFinite(fetchedMs) && receivedAt != null ? Math.round((fetchedMs - receivedAt) / 60_000) * 60_000 : clockOffset;
  if (offset !== clockOffset) setClockOffset(offset);

  // Flash LTPs that moved since the previous poll of the same chain.
  const prev = useRef<{ key: string; rows: OptionChainView["rows"] } | null>(null);
  const [flashes, setFlashes] = useState<Map<string, Flash>>(new Map());
  useEffect(() => {
    if (!chain) return;
    const key = `${chain.index}|${chain.expiry}`;
    const before = prev.current?.key === key ? prev.current.rows : null;
    prev.current = { key, rows: chain.rows };
    const f = diffFlashes(before, chain.rows);
    if (f.size === 0) return;
    setFlashes(f);
    const t = setTimeout(() => setFlashes(new Map()), 900);
    return () => clearTimeout(t);
  }, [chain]);

  const activeExpiry = chain?.expiry ?? expiry ?? "";
  const tie = engineTieIn(signalsPoll.data, index, activeExpiry);
  const highlight: Highlight | null = tie.advice && tie.onThisExpiry ? { strike: tie.advice.contract.strike, type: tie.advice.contract.optionType } : null;
  const rows = useMemo(() => (chain ? visibleRows(chain.rows, chain.spot, chain.atmStrike, showAll) : []), [chain, showAll]);
  const level = levelsPoll.data?.levels.find((l) => l.key === index) ?? null;
  const pickedRow = picked && chain ? chain.rows.find((r) => r.strike === picked.strike) : null;
  const pickedSide = pickedRow && picked ? (picked.type === "CE" ? pickedRow.ce : pickedRow.pe) : null;
  const ageMs = chainPoll.at != null ? now - chainPoll.at : null;
  const loading = !chain && !chainPoll.error;
  const fetchError = plainError(chainPoll.error, "the option chain");

  const switchIndex = (i: IndexId) => {
    setIndex(i);
    setExpiry(null);
    setPicked(null);
  };

  return (
    <main style={{ width: "100%", maxWidth: 1240, margin: "0 auto", padding: "16px 16px 56px", display: "grid", gap: 14, boxSizing: "border-box", minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.gold, marginBottom: 6 }}>Option chain · read-only</div>
          <h1 style={{ margin: 0, fontFamily: SERIF, fontSize: "clamp(28px, 4vw, 40px)", fontWeight: 500, lineHeight: 1.1, letterSpacing: "-0.02em", color: C.textStrong }}>
            {index} options
          </h1>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Segmented label="Index" value={index} options={INDEX_OPTIONS} onChange={switchIndex} />
        </div>
      </div>

      {/* Expiry, spot and chain stats */}
      <Panel style={{ padding: "12px 14px", display: "grid", gap: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px" }}>
          <span style={microLabel}>Expiry</span>
          {chain && chain.expiries.length > 0 ? (
            <Segmented
              size="sm"
              label="Expiry"
              value={activeExpiry}
              options={chain.expiries.map((e) => ({ value: e, label: shortExpiry(e) }))}
              onChange={(e) => {
                setExpiry(e);
                setPicked(null);
              }}
            />
          ) : (
            <Skeleton width={220} height={28} />
          )}
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: C.muted }}>
            <span className="tnum">{ageMs == null ? "connecting…" : `updated ${fmtAge(ageMs)} ago`}</span>
            {chain && <Pill color={chain.source === "mock" ? C.purple : C.blue}>{chain.source === "mock" ? "Mock" : "Upstox"}</Pill>}
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 26px" }}>
          <Stat label={`${index} spot`}>
            {chain ? (
              <>
                <span className="tnum" style={{ fontSize: 20, fontWeight: 600, color: C.textStrong }}>
                  {chain.spot.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                {level?.change != null && level.changePct != null && (
                  <span className="tnum" style={{ marginLeft: 8, fontSize: 13, fontWeight: 600, color: dirColor(level.change) }}>
                    {level.change > 0 ? "+" : ""}
                    {level.change.toFixed(2)} ({level.changePct > 0 ? "+" : ""}
                    {level.changePct.toFixed(2)}%)
                  </span>
                )}
              </>
            ) : (
              <Skeleton width={110} height={22} />
            )}
          </Stat>
          <Stat label="PCR">{chain ? <Big>{chain.pcr == null ? "–" : chain.pcr.toFixed(2)}</Big> : <Skeleton width={40} height={22} />}</Stat>
          <Stat label="Max pain">{chain ? <Big>{chain.maxPain == null ? "–" : chain.maxPain.toLocaleString("en-IN")}</Big> : <Skeleton width={60} height={22} />}</Stat>
          <Stat label="Lot size">{chain ? <Big>{chain.lotSize}</Big> : <Skeleton width={30} height={22} />}</Stat>
          <Stat label="ATM strike">{chain ? <Big>{chain.atmStrike.toLocaleString("en-IN")}</Big> : <Skeleton width={60} height={22} />}</Stat>
        </div>
      </Panel>

      {/* The engine's live reading */}
      {tie.advice ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px", padding: "10px 14px", borderRadius: 12, border: `1px solid ${alpha(C.green, 0.35)}`, background: alpha(C.green, 0.07), fontSize: 13.5, color: C.textStrong }}>
          <Pill color={C.green} solid>
            Engine: ENTER
          </Pill>
          <span style={{ flex: "1 1 260px", minWidth: 0 }}>
            {adviceLine(tie.advice)}
            {!tie.onThisExpiry && <span style={{ color: C.muted }}> (on the {shortExpiry(tie.advice.contract.expiry)} expiry)</span>}
          </span>
          <Link href="/copy" style={{ color: C.gold, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>
            Copy page →
          </Link>
        </div>
      ) : tie.reason ? (
        <div style={{ fontSize: 13, color: C.muted, padding: "0 2px" }}>
          Engine: no entry on {index} — {tie.reason}
        </div>
      ) : null}

      {/* Columns and range */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Btn onClick={() => setMore((m) => !m)} aria-pressed={more}>
          {more ? "Fewer columns" : "More columns"}
        </Btn>
        <Btn onClick={() => setShowAll((s) => !s)} aria-pressed={showAll}>
          {showAll ? "Show ±10 strikes" : "Show all strikes"}
        </Btn>
        <span style={{ fontSize: 12, color: C.muted2 }}>Tap a price for its greeks, premium per lot and breakeven.</span>
      </div>

      {chain?.error ? (
        <Panel>
          <EmptyState>Live chain unavailable: {chain.error}</EmptyState>
        </Panel>
      ) : fetchError && !chain ? (
        <Panel>
          <EmptyState>Live chain unavailable: {fetchError}</EmptyState>
        </Panel>
      ) : loading ? (
        <Panel style={{ padding: 16, display: "grid", gap: 10 }}>
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} height={26} />
          ))}
        </Panel>
      ) : chain && chain.rows.length === 0 ? (
        <Panel>
          <EmptyState>No strikes listed for this expiry.</EmptyState>
        </Panel>
      ) : chain ? (
        <>
          {fetchError && <div style={{ fontSize: 12.5, color: C.red }}>Last refresh failed: {fetchError} Showing the previous chain.</div>}
          <ChainTable
            rows={rows}
            spot={chain.spot}
            atmStrike={chain.atmStrike}
            more={more}
            flashes={flashes}
            highlight={highlight}
            selected={picked}
            onPick={setPicked}
            scrollKey={`${chain.index}|${chain.expiry}|${showAll}`}
          />
        </>
      ) : null}

      {chain && picked && pickedSide && (
        <SideDetail
          index={chain.index}
          expiry={chain.expiry}
          strike={picked.strike}
          type={picked.type}
          side={pickedSide}
          lotSize={chain.lotSize}
          engineEnter={highlight?.strike === picked.strike && highlight.type === picked.type}
          onClose={() => setPicked(null)}
        />
      )}

      <p style={{ margin: 0, fontSize: 12, color: C.muted2, lineHeight: 1.55 }}>
        Read-only market data. Polls every 3 s in market hours (09:15–15:30 IST, Mon–Fri) while this tab is visible, every minute otherwise. OI and volume in units (L = lakh, Cr = crore); IV in percent; theta per day.
      </p>
    </main>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
      <span style={microLabel}>{label}</span>
      <span style={{ display: "inline-flex", alignItems: "baseline", flexWrap: "wrap" }}>{children}</span>
    </div>
  );
}

function Big({ children }: { children: ReactNode }) {
  return (
    <span className="tnum" style={{ fontSize: 20, fontWeight: 600, color: C.textStrong }}>
      {children}
    </span>
  );
}
