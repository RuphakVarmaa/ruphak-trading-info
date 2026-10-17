"use client";

/**
 * The live option chain for one index and expiry (read-only), Groww style: the expiry selector, stat tiles,
 * the strike table and the side detail. When the engine's live reading says ENTER on a contract of this
 * expiry, that contract is marked on the chain.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { IndexId, LiveIndexLevelsView, OptionChainView, SignalView } from "@/engine/api-types";
import { C, dirColor } from "@/components/shared/colors";
import { fmtAge } from "@/components/shared/format";
import { Btn, EmptyState, Panel, Pill, Segmented, Skeleton, microLabel } from "@/components/shared/ui";
import { plainError, useSharedPoll } from "@/components/Copy/sharedPoll";
import { useClientNow } from "@/hooks/useEngineState";
import { REFRESH_OTHER_MS } from "@/lib/refresh";
import ChainTable, { type Highlight } from "./ChainTable";
import { chainPollMs, diffFlashes, engineTieIn, shortExpiry, visibleRows, type Flash } from "./chainView";
import SideDetail from "./SideDetail";

type Level = LiveIndexLevelsView["levels"][number];

export interface OptionChainPanelProps {
  index: IndexId;
  /** The chosen expiry; null for the nearest. */
  expiry: string | null;
  onExpiryChange: (expiry: string) => void;
  /** Today's change for the spot tile (from the page's index-levels poll). */
  level: Level | null;
  /** Engine clock minus browser clock (the mock runs its own clock). */
  clockOffsetMs: number;
}

export default function OptionChainPanel({ index, expiry, onExpiryChange, level, clockOffsetMs }: OptionChainPanelProps) {
  const [more, setMore] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [picked, setPicked] = useState<Highlight | null>(null);
  const now = useClientNow();

  const url = `/api/engine/chain?index=${index}${expiry ? `&expiry=${expiry}` : ""}`;
  const pollMs = now == null ? REFRESH_OTHER_MS : chainPollMs(now + clockOffsetMs);
  const chainPoll = useSharedPoll<OptionChainView>(url, pollMs);
  const signalsPoll = useSharedPoll<SignalView[]>("/api/engine/signals", pollMs);
  const chain = chainPoll.data && chainPoll.data.index === index && (!expiry || chainPoll.data.expiry === expiry) ? chainPoll.data : null;

  // A new index or expiry clears the picked contract.
  const [pickedFor, setPickedFor] = useState(`${index}|${expiry}`);
  if (pickedFor !== `${index}|${expiry}`) {
    setPickedFor(`${index}|${expiry}`);
    setPicked(null);
  }

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
  const pickedRow = picked && chain ? chain.rows.find((r) => r.strike === picked.strike) : null;
  const pickedSide = pickedRow && picked ? (picked.type === "CE" ? pickedRow.ce : pickedRow.pe) : null;
  const ageMs = chainPoll.at != null && now != null ? now - chainPoll.at : null;
  const loading = !chain && !chainPoll.error;
  const fetchError = plainError(chainPoll.error, "the option chain");

  return (
    <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
      {/* Expiry, spot and chain stats */}
      <Panel style={{ padding: "12px 14px", display: "grid", gap: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px" }}>
          <span style={microLabel}>Expiry</span>
          {chain && chain.expiries.length > 0 ? (
            <Segmented size="sm" label="Expiry" value={activeExpiry} options={chain.expiries.map((e) => ({ value: e, label: shortExpiry(e) }))} onChange={onExpiryChange} />
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
        Read-only market data. Polls every 2 s in market hours (09:15–15:30 IST, Mon–Fri) while this tab is visible, every 10 minutes otherwise. OI and volume in units (L = lakh, Cr = crore); IV in
        percent; theta per day. A contract marked “Engine: ENTER” is the paper engine&apos;s live reading, not advice.
      </p>
    </div>
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
