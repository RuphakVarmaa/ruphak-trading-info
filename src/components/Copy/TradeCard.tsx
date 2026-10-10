"use client";

/**
 * The current trade, laid out to be typed into a broker app: every value is a tap-to-copy tile, the
 * order's prices are on the ₹0.05 tick, and the values are checked against the engine's calendar and
 * contract rules. Below: the size check for the account and for ₹5,000, the copier's own fill, and the
 * step-by-step script with a "Copy all steps" button.
 */
import { useMemo } from "react";
import type { CopyTicketView } from "@/engine/api-types";
import { alpha, C, pnlColor } from "@/components/shared/colors";
import { Pill } from "@/components/shared/ui";
import { copyLimit, expiryLong, exitLevels, EXIT_WORDS, hm, hms, KIND_LABEL, shortAge, skipRule, type IndexAction } from "@/lib/copy/action";
import { indexLevel, LIMIT_SLIPPAGE_PCT, rupees, wholeRupees } from "@/lib/copy/prices";
import { paperScript, scriptText, sizeChecks, stopLossLimit } from "@/lib/copy/script";
import { verifyTicket } from "@/lib/copy/verify";
import { CopyAction, CopyTile } from "./CopyButton";
import { YourFill } from "./TicketParts";
import { TONE_COLOR } from "./tone";

const pctText = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x)}%`;
const TICKETS_STALE_MS = 30_000;

function Checks({ t }: { t: CopyTicketView }) {
  const checks = useMemo(() => verifyTicket(t), [t]);
  const bad = checks.filter((c) => !c.ok);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {bad.length > 0 && (
        <div role="alert" style={{ display: "grid", gap: 4, padding: "10px 12px", borderRadius: 10, background: alpha(C.red, 0.06), border: `1px solid ${alpha(C.red, 0.45)}` }}>
          <b style={{ fontSize: 13.5, color: C.red }}>Check before typing it</b>
          {bad.map((c) => (
            <span key={c.id} style={{ fontSize: 13, color: C.textSoft, lineHeight: 1.45 }}>
              <b style={{ color: C.red }}>✗</b> {c.text}
            </span>
          ))}
        </div>
      )}
      <details>
        <summary style={{ cursor: "pointer", fontSize: 13, color: C.muted, minHeight: 32, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: bad.length ? C.red : C.green, fontWeight: 700 }}>{bad.length ? "✗" : "✓"}</span>
          {bad.length ? `${checks.length - bad.length} of ${checks.length} values check out` : `Every value checked (${checks.length}): strike, CE/PE, expiry, quantity, ₹0.05 tick`}
        </summary>
        <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "grid", gap: 4 }}>
          {checks.map((c) => (
            <li key={c.id} style={{ fontSize: 12.5, color: C.textSoft, display: "flex", gap: 8, lineHeight: 1.45 }}>
              <span style={{ color: c.ok ? C.green : C.red, fontWeight: 700, width: 12, flexShrink: 0 }}>{c.ok ? "✓" : "✗"}</span>
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{c.text}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function SizeCheckRows({ t }: { t: CopyTicketView }) {
  const rows = useMemo(() => sizeChecks(t), [t]);
  const x = exitLevels(t);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.textSoft }}>
        Size check <span style={{ fontWeight: 400, color: C.muted }}>(bought at the {rupees(copyLimit(t).price)} limit, stopped at {rupees(x.stop)}, both orders&apos; charges included)</span>
      </div>
      {rows.map((r) => (
        <div key={r.label} className="tnum" style={{ display: "grid", gap: 2, padding: "8px 10px", borderRadius: 8, background: r.warning == null ? C.panelAlt : alpha(C.red, 0.06), border: `1px solid ${r.warning == null ? C.border : alpha(C.red, 0.45)}` }}>
          <span style={{ fontSize: 13, color: C.textStrong, fontWeight: 600 }}>
            {r.label}
            {r.label.includes("₹") ? "" : ` (${wholeRupees(r.capital)})`}: {r.lots} lot{r.lots === 1 ? "" : "s"} = {r.qty} qty
          </span>
          {r.fits && (
            <span style={{ fontSize: 13, color: C.textSoft, lineHeight: 1.45 }}>
              needs {wholeRupees(r.needs)} ({r.costPctOfCapital.toFixed(1)}% of capital) · loss at the stop <b style={{ color: C.red }}>{wholeRupees(-r.maxLoss)}</b> ({r.lossPctOfCapital.toFixed(1)}% of capital; the most one trade may lose is {wholeRupees(r.lossCap)})
            </span>
          )}
          {r.warning && <span style={{ fontSize: 13, color: C.red, fontWeight: 600, lineHeight: 1.45 }}>✗ {r.warning}</span>}
        </div>
      ))}
    </div>
  );
}

function Script({ t }: { t: CopyTicketView }) {
  const steps = useMemo(() => paperScript(t), [t]);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.textSoft }}>Step-by-step script ({steps.length} steps, any F&amp;O paper-trading tab)</span>
        <CopyAction text={scriptText(t)} label="Copy all steps" tone="quiet" style={{ minHeight: 44, fontSize: 14 }} />
      </div>
      <details>
        <summary style={{ cursor: "pointer", fontSize: 13, color: C.muted, minHeight: 32, display: "flex", alignItems: "center" }}>Show the steps</summary>
        <ol style={{ listStyle: "decimal", margin: "8px 0 0", paddingLeft: 24, display: "grid", gap: 7, fontSize: 13.5, color: C.textSoft, lineHeight: 1.5 }}>
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </details>
    </div>
  );
}

/** The current trade. `a`: the status of its index when it is about this trade. */
export default function TradeCard({ t, a, ticketsAgeMs }: { t: CopyTicketView; a: IndexAction | null; ticketsAgeMs: number | null }) {
  const c = t.contract;
  const lv = t.levels;
  const x = exitLevels(t);
  const exit = a?.kind === "EXIT_NOW";
  // On EXIT NOW, sell what the order says (the quantity shown while the trade was open).
  const qty = exit ? Number(/= (\d+) qty/.exec(a?.order ?? "")?.[1] ?? t.qty) : t.qty;
  const lots = c.lotSize > 0 ? Math.max(1, Math.round(qty / c.lotSize)) : t.lots;
  // Frame the tiles the current status acts on: the buy for ENTER NOW, the exits while holding.
  const act = a?.kind === "ENTER_NOW" || exit;
  const hold = a?.kind === "MANAGE";
  const open = t.status === "OPEN";
  const lim = copyLimit(t);
  const limit = lim.price;
  const skip = skipRule(t);
  const call = c.optionType === "CE";
  const status = a ? KIND_LABEL[a.kind] : open ? "OPEN" : "CLOSED";
  const statusColor = a ? TONE_COLOR[a.tone] : C.muted;
  const stale = ticketsAgeMs != null && ticketsAgeMs > TICKETS_STALE_MS;
  const expiryCopy = expiryLong(c.expiry).replace(/^\w{3} /, "");

  return (
    <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Pill color={statusColor} solid={a?.tone === "action"}>
          {status}
        </Pill>
        <Pill color={C.textSoft}>{t.account.shortLabel}</Pill>
        {t.entry.priceSource === "model" && (
          <Pill color={C.textSoft} title="Without a broker feed the engine prices options with Black-Scholes on India VIX; the real price in your app will differ.">
            model price
          </Pill>
        )}
        <span style={{ fontSize: 12, color: C.muted }}>engine bought at {hms(t.entry.at)} IST</span>
        {stale && <span style={{ fontSize: 12, color: C.orange, fontWeight: 600 }}>engine data {shortAge(ticketsAgeMs ?? 0)} old</span>}
      </div>

      <div style={{ fontSize: "clamp(22px, 5.2vw, 28px)", fontWeight: 800, lineHeight: 1.15, color: C.textStrong, overflowWrap: "anywhere" }}>
        {exit ? "SELL" : "BUY"} {t.index} {c.strike} {c.optionType} <span style={{ fontWeight: 500, color: C.muted, fontSize: "0.7em" }}>· {expiryLong(c.expiry)}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 150px), 1fr))", gap: 8 }}>
        <CopyTile label="Side" value={exit ? "SELL" : "BUY"} copy={exit ? "SELL" : "BUY"} valueColor={act ? C.gold : undefined} emphasis={act} />
        <CopyTile label="Search" value={t.searchText} copy={t.searchText} />
        <CopyTile label="Exchange symbol" value={<span style={{ fontSize: 15 }}>{c.tradingSymbol}</span>} copy={c.tradingSymbol} sub={c.growwSymbol ? `Groww ${c.growwSymbol}` : undefined} />
        <CopyTile label="Strike" value={String(c.strike)} copy={String(c.strike)} />
        <CopyTile label="Type" value={`${c.optionType} · ${call ? "call" : "put"}`} copy={c.optionType} />
        <CopyTile label="Expiry" value={expiryLong(c.expiry)} copy={expiryCopy} sub={`${t.index} weekly`} />
        <CopyTile label="Quantity" value={String(qty)} copy={String(qty)} sub={`${lots} lot${lots === 1 ? "" : "s"} × ${c.lotSize}`} />
        {exit ? (
          <CopyTile label="Order type" value="Market" copy="MARKET" sub="sell now" emphasis />
        ) : (
          <>
            <CopyTile
              label="Buy limit"
              value={rupees(limit)}
              copy={limit.toFixed(2)}
              sub={a?.kind === "MANAGE" ? "too late now: don't chase" : `at or below · ${lim.baseLabel} + ${LIMIT_SLIPPAGE_PCT}%`}
              emphasis={act}
            />
            <CopyTile label="Stop-loss trigger" value={rupees(x.stop)} copy={x.stop.toFixed(2)} valueColor={C.red} sub={`${pctText(lv.stopPct)} · SL limit ${rupees(stopLossLimit(x.stop))}`} emphasis={hold} />
            <CopyTile label="Target" value={rupees(x.target)} copy={x.target.toFixed(2)} valueColor={C.green} sub={pctText(lv.targetPct)} emphasis={hold} />
            {skip && <CopyTile label={`Skip if ${t.index} is`} value={`${skip.above ? "above" : "below"} ${indexLevel(skip.level)}`} copy={String(skip.level)} sub={`engine bought at ${indexLevel(t.entry.spot)}`} />}
          </>
        )}
      </div>

      <div style={{ display: "grid", gap: 4, fontSize: 13, color: C.textSoft, lineHeight: 1.5 }}>
        <span>
          Engine fill {rupees(t.entry.premium)} at {hms(t.entry.at)} IST
          {t.entry.priceSource === "model" ? " (a model price: Groww's will differ)" : " (a broker quote)"} · cost {wholeRupees(t.entry.costRupees)}
        </span>
        {open && (
        <span>
          Trailing stop from {rupees(x.trailFrom)} ({pctText(lv.trailActivatePct)}), giving back {lv.trailGivebackPct}% of the gain{x.trail != null ? `: on now at ${rupees(x.trail)}` : ""} · time stop {hm(x.timeStopAt)} unless at least {rupees(x.timeStopKeep)} · out by {hm(x.squareOffAt)} IST
        </span>
        )}
      </div>

      {t.live && (
        <div className="tnum" style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", padding: "10px 12px", borderRadius: 10, background: alpha(pnlColor(t.live.pnl), 0.06), border: `1px solid ${alpha(pnlColor(t.live.pnl), 0.3)}`, fontSize: 13.5 }}>
          <span>
            Engine mark <b>{rupees(t.live.mark)}</b>
            {t.live.markAt ? ` at ${hms(t.live.markAt)} IST` : ""}
          </span>
          <span style={{ color: pnlColor(t.live.movePct), fontWeight: 700 }}>
            {t.live.movePct >= 0 ? "+" : "−"}
            {Math.abs(t.live.movePct).toFixed(1)}% on the premium
          </span>
          <span style={{ color: pnlColor(t.live.pnl), fontWeight: 700 }}>{wholeRupees(t.live.pnl, true)} paper P&amp;L after entry charges</span>
        </div>
      )}
      {t.exit && (
        <div className="tnum" style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", padding: "10px 12px", borderRadius: 10, background: alpha(pnlColor(t.exit.pnl), 0.06), border: `1px solid ${alpha(pnlColor(t.exit.pnl), 0.3)}`, fontSize: 13.5 }}>
          <span>
            Engine sold at <b>{rupees(t.exit.premium)}</b> at {hm(t.exit.at)} IST ({EXIT_WORDS[t.exit.reason]}, held {t.exit.holdMin} min)
          </span>
          <span style={{ color: pnlColor(t.exit.pnl), fontWeight: 700 }}>{wholeRupees(t.exit.pnl, true)} after charges</span>
        </div>
      )}

      <Checks t={t} />
      {!exit && <SizeCheckRows t={t} />}
      {open && <YourFill t={t} />}
      {!exit && <Script t={t} />}
    </div>
  );
}
