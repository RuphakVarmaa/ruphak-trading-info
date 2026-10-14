"use client";

/** The detail card for one strike side: every field, greeks and POP, one lot's premium and the breakeven. */
import type { IndexId, OptionSideView } from "@/engine/api-types";
import { alpha, C } from "@/components/shared/colors";
import { Pill } from "@/components/shared/ui";
import { breakeven, fmtLakh, shortExpiry, type Side } from "./chainView";

const n = (v: number | null, d = 2) => (v == null ? "–" : v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }));
const rupees = (v: number) => `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function SideDetail({
  index,
  expiry,
  strike,
  type,
  side,
  lotSize,
  engineEnter,
  onClose,
}: {
  index: IndexId;
  expiry: string;
  strike: number;
  type: Side;
  side: OptionSideView;
  lotSize: number;
  engineEnter: boolean;
  onClose: () => void;
}) {
  const ltp = side.ltp;
  const fields: [string, string][] = [
    ["LTP", n(ltp)],
    ["Change", side.change == null ? "–" : `${side.change > 0 ? "+" : ""}${n(side.change)} (${n(side.changePct)}%)`],
    ["Prev close", n(side.close)],
    ["Bid / Ask", `${n(side.bid)} / ${n(side.ask)}`],
    ["Bid / Ask qty", `${side.bidQty ?? "–"} / ${side.askQty ?? "–"}`],
    ["Volume", side.volume == null ? "–" : fmtLakh(side.volume)],
    ["OI", side.oi == null ? "–" : fmtLakh(side.oi)],
    ["OI change", side.oiChange == null ? "–" : `${side.oiChange > 0 ? "+" : ""}${fmtLakh(side.oiChange)}`],
    ["IV", side.iv == null ? "–" : `${n(side.iv, 1)}%`],
    ["Delta", n(side.delta, 3)],
    ["Gamma", n(side.gamma, 5)],
    ["Theta / day", n(side.theta)],
    ["Vega", n(side.vega)],
    ["POP", side.pop == null ? "–" : `${n(side.pop, 1)}%`],
  ];
  return (
    <div
      role="dialog"
      aria-label={`${index} ${strike} ${type} details`}
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 50,
        width: "min(360px, calc(100vw - 32px))",
        maxHeight: "calc(100vh - 32px)",
        overflowY: "auto",
        background: C.panel,
        border: `1px solid ${C.borderStrong}`,
        borderRadius: 14,
        boxShadow: "0 12px 32px rgba(20,20,19,0.18)",
        padding: 14,
        boxSizing: "border-box",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.textStrong }}>
            {index} {strike.toLocaleString("en-IN")} {type}
          </div>
          <div style={{ fontSize: 12, color: C.muted }}>Expiry {shortExpiry(expiry)}</div>
        </div>
        {engineEnter && (
          <Pill color={C.green} solid style={{ marginTop: 2 }}>
            Engine: ENTER
          </Pill>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{ marginLeft: "auto", border: "none", background: "transparent", color: C.muted, fontSize: 20, lineHeight: 1, cursor: "pointer", padding: 2 }}
        >
          ×
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
        <Key label={`Premium for 1 lot (${lotSize})`} value={ltp == null ? "–" : rupees(ltp * lotSize)} />
        <Key label="Breakeven at expiry" value={ltp == null ? "–" : breakeven(strike, ltp, type).toLocaleString("en-IN", { maximumFractionDigits: 2 })} />
      </div>
      <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "5px 12px", fontSize: 13 }}>
        {fields.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt style={{ color: C.muted }}>{k}</dt>
            <dd className="tnum" style={{ margin: 0, textAlign: "right", color: C.textStrong }}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Key({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: "8px 10px", borderRadius: 10, background: alpha(C.gold, 0.06), border: `1px solid ${alpha(C.gold, 0.2)}` }}>
      <div style={{ fontSize: 11.5, color: C.muted }}>{label}</div>
      <div className="tnum" style={{ fontSize: 16, fontWeight: 700, color: C.textStrong }}>
        {value}
      </div>
    </div>
  );
}
