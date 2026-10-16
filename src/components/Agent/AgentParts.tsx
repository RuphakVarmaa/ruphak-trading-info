"use client";

/**
 * The Agent page's parts, in reading order: the honesty banner, the status, one card per index (each
 * finalist's call, the code's checks in plain words, sizing, what the code did, and the snapshot the model
 * saw), escalations, the risk limits with re-arm, calibration, the nightly review with its candidate
 * (approve or reject) and today's cost. Colour always comes with a glyph or a word. No next/link, so the
 * render test (AgentParts.render.test.ts) can render every part on the server.
 */
import { useId, useState, type CSSProperties, type ReactNode } from "react";
import type {
  AgentCalibrationView,
  AgentCandidateView,
  AgentCostView,
  AgentDecisionView,
  AgentEscalationView,
  AgentFinalistView,
  AgentIndexCardView,
  AgentReviewView,
  AgentRiskView,
  AgentSnapshotFieldView,
  AgentView,
} from "@/engine/api-types";
import { ACCOUNTS } from "@/engine/accounts";
import { AGENT_POLICY, CALIBRATION, ESCALATION, OUTCOME } from "@/engine/agent/constants";
import { alpha, C, pnlColor } from "@/components/shared/colors";
import { fmtDateKey, fmtInr, fmtNum, fmtPct } from "@/components/shared/format";
import { SERIF } from "@/components/shared/theme";
import { Btn, ConfirmDialog, Disclosure, Dot, inputStyle, microLabel, Panel, Pill } from "@/components/shared/ui";
import {
  actionWords,
  brierVerdict,
  candidateStatusWords,
  COST_KIND_WORDS,
  dayTime,
  DIRECTION_META,
  escalationStatusWords,
  gateGroups,
  gateHeadline,
  guidanceDiff,
  istTime,
  type GuidancePoint,
  modelsWords,
  modelWords,
  modeWords,
  outcomeWords,
  pct,
  prob,
  REGIME_WORDS,
  reviewStatusWords,
  riskWords,
  sizingOutlook,
  sizingOutlookWords,
  sizingWords,
  snapshotNote,
  stateWords,
  triggerWords,
  usd,
} from "./agentText";

export type ActionResult = { ok: true } | { ok: false; error: string };
/** Runs an admin action with the tab's stored token, or with `typedToken` when none is stored. */
export type AdminAction<A = void> = (arg: A, typedToken: string | null) => Promise<ActionResult>;

/** The agent account's pinned square-off: every agent position is intraday. */
const SQUARE_OFF_IST = ACCOUNTS.agent.configPatch.exits?.squareOffIst ?? "15:05";

const body: CSSProperties = { fontSize: 15.5, lineHeight: 1.6, color: C.textSoft };
const small: CSSProperties = { fontSize: 13.5, lineHeight: 1.5, color: C.muted2 };
const h3: CSSProperties = { margin: 0, fontFamily: SERIF, fontSize: 22, fontWeight: 500, color: C.textStrong, letterSpacing: "-0.01em" };

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** Shown when the page runs on the built-in mock engine. */
export function DemoChip() {
  return (
    <span title="The site is running on its built-in mock engine: the agent's decisions, prices and review here are made up by code for the demo. No model is called.">
      <Pill color={C.purple} style={{ fontSize: 11.5, padding: "4px 10px" }}>
        Demo data
      </Pill>
    </span>
  );
}

export function Notice({ tone, children }: { tone: "error" | "warn" | "info"; children: ReactNode }) {
  const color = tone === "error" ? C.red : tone === "warn" ? C.orange : C.blue;
  return (
    <div role={tone === "error" ? "alert" : "status"} style={{ background: alpha(color, 0.06), border: `1px solid ${alpha(color, 0.3)}`, borderRadius: 10, padding: "10px 12px", fontSize: 15, lineHeight: 1.5, color: C.textSoft, overflowWrap: "anywhere" }}>
      {children}
    </div>
  );
}

function Fact({ label, value, note, color = C.textStrong }: { label: string; value: ReactNode; note?: ReactNode; color?: string }) {
  return (
    <div style={{ flex: "1 1 150px", background: C.panelAlt, border: `1px solid ${C.borderSoft}`, borderRadius: 12, padding: "10px 12px", minWidth: 0 }}>
      <div style={{ ...microLabel, color: C.muted }}>{label}</div>
      <div className="tnum" style={{ fontSize: 18, fontWeight: 650, color, marginTop: 3, overflowWrap: "anywhere" }}>
        {value}
      </div>
      {note != null && <div style={{ ...small, fontSize: 12.5, marginTop: 2 }}>{note}</div>}
    </div>
  );
}

/** A labelled row inside a decision: the label above, the content below. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <div style={{ ...microLabel, color: C.muted }}>{label}</div>
      <div style={{ minWidth: 0, display: "grid", gap: 3 }}>{children}</div>
    </div>
  );
}

function Bullets({ items, marker, color }: { items: readonly ReactNode[]; marker?: string; color?: string }) {
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
      {items.map((t, i) => (
        <li key={i} style={{ display: "grid", gridTemplateColumns: marker ? "18px minmax(0, 1fr)" : "minmax(0, 1fr)", gap: 4, fontSize: 14.5, lineHeight: 1.5, color: C.textSoft, overflowWrap: "anywhere" }}>
          {marker && (
            <span aria-hidden style={{ color: color ?? C.muted, fontWeight: 700 }}>
              {marker}
            </span>
          )}
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

/** A used-against-a-limit bar; the words carry the numbers, the colour only repeats them. */
function Meter({ label, used, cap, value, note }: { label: string; used: number; cap: number; value: string; note?: ReactNode }) {
  const frac = cap > 0 ? Math.min(1, Math.max(0, used / cap)) : 0;
  const color = frac >= 0.8 ? C.red : frac >= 0.5 ? C.orange : C.green;
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "2px 12px", fontSize: 14, color: C.textSoft }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span className="tnum" style={{ color: C.textStrong, fontWeight: 600 }}>
          {value}
        </span>
      </div>
      <div role="img" aria-label={`${label}: ${value}`} style={{ height: 6, background: C.borderSoft, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${frac * 100}%`, height: "100%", background: color, borderRadius: 3 }} />
      </div>
      {note != null && <div style={{ ...small, fontSize: 12.5 }}>{note}</div>}
    </div>
  );
}

function TokenField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} style={{ ...microLabel, display: "block", marginBottom: 6, color: C.muted }}>
        Admin token (kept in this tab only)
      </label>
      <input id={id} type="password" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
    </div>
  );
}

/** Dialog state for an admin action: which one is open, the typed token, busy and the error. */
function useAdminDialog<K extends string>(run: (kind: K, typedToken: string | null) => Promise<ActionResult>, hasToken: boolean) {
  const [open, setOpen] = useState<K | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const show = (kind: K) => {
    setError(null);
    setOpen(kind);
  };
  const close = () => {
    if (busy) return;
    setOpen(null);
    setError(null);
  };
  const confirm = async () => {
    if (!open) return;
    const token = hasToken ? null : typed.trim();
    if (token === "") {
      setError("Enter the admin token.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await run(open, token);
    setBusy(false);
    if (res.ok) {
      setOpen(null);
      setTyped("");
    } else setError(res.error);
  };
  const extra = hasToken ? undefined : <TokenField value={typed} onChange={setTyped} />;
  return { open, show, close, confirm, busy, error, extra };
}

// ---------------------------------------------------------------------------
// 1. Honesty and status
// ---------------------------------------------------------------------------

/** Always first: what this is, and what the research behind it found. */
export function HonestyBanner({ text }: { text: string }) {
  return (
    <div role="note" style={{ display: "grid", gap: 6, background: alpha(C.orange, 0.08), border: `2px solid ${alpha(C.orange, 0.5)}`, borderRadius: 12, padding: "14px 16px" }}>
      <b style={{ fontSize: 16.5, color: C.orange }}>
        <span aria-hidden>⚠ </span>A paper experiment, not advice
      </b>
      <span style={{ ...body, color: C.textStrong, overflowWrap: "anywhere" }}>{text}</span>
    </div>
  );
}

const STATE_COLOR: Record<AgentView["status"]["state"], string> = { OFF: C.muted, CLOSED: C.muted, WAITING: C.blue, RUNNING: C.green, COST_CAP: C.red, ERROR: C.red };

export function StatusBar({ view }: { view: AgentView }) {
  const mode = modeWords(view.mode);
  const s = view.status;
  const color = STATE_COLOR[s.state];
  const cost = view.cost;
  return (
    <Panel style={{ padding: "16px 16px", display: "grid", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px" }}>
        <Pill color={view.mode === "paper" ? C.blue : view.mode === "shadow" ? C.purple : C.muted} solid={view.mode !== "off"} style={{ fontSize: 11.5, padding: "4px 10px" }}>
          {mode.label} mode
        </Pill>
        <span role="status" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 15.5, fontWeight: 600, color }}>
          <Dot color={color} size={8} pulse={s.state === "RUNNING"} /> {stateWords(s.state)}
        </span>
        {s.paused && (
          <Pill color={C.orange} solid style={{ fontSize: 11.5, padding: "4px 10px" }}>
            Paused
          </Pill>
        )}
      </div>
      <p style={{ margin: 0, ...body, fontSize: 15 }}>{mode.detail}</p>
      {s.paused && <Notice tone="warn">Paused by the operator: only the agent&apos;s exits run, and no candle is judged until it is resumed.</Notice>}
      {!view.enabled && <Notice tone="info">The agent&apos;s paper account is not switched on in this engine, so nothing runs and nothing is traded.</Notice>}
      {s.lastError && (
        <Notice tone="error">
          <b>Last error:</b> {s.lastError} No new entries are made while the agent cannot judge; exits still run in code.
        </Notice>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Fact
          label="Last candle"
          value={s.lastBarAt ? dayTime(s.lastBarAt, view.generatedAt) : "None yet"}
          note={s.lastBarAt ? "the latest closed 5-minute candle stored" : `the first is the ${AGENT_POLICY.reflexFirstBarIst} candle`}
        />
        <Fact
          label="Model cost today"
          value={`${usd(cost.spentUsd)} of ${usd(cost.capUsd)}`}
          note={cost.capReached ? "cap reached: no new model calls or entries today" : "a hard daily cap"}
          color={cost.capReached ? C.red : C.textStrong}
        />
        <Fact label="Guidance text" value={<span style={{ fontSize: 15 }}>{view.instructionVersion}</span>} note="changes only when you approve a candidate" />
      </div>
      <p style={{ margin: 0, ...small }}>
        <b style={{ color: C.textSoft }}>How it works.</b> After each 5-minute candle closes, a fast model reads one short set of numbers per index and answers, for each finalist, which way the
        index will go, how sure it is and how good the setup is. Code then runs its own checks, sizes the trade from measured results only and enforces every limit. The model never places
        an order.
      </p>
      <div style={{ ...small, fontSize: 12.5, overflowWrap: "anywhere" }}>
        {modelsWords(view.models)} · updated {istTime(view.generatedAt)}
        {view.account ? ` · account ${view.account.label}` : ""}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 2. One card per index
// ---------------------------------------------------------------------------

function emptyCardWords(view: AgentView): string {
  if (view.mode === "off" || !view.enabled) return "The agent is off: no candle is judged.";
  if (view.status.state === "WAITING") return `No candle judged yet. The first is the one closing at ${AGENT_POLICY.reflexFirstBarIst} IST, and the last at ${AGENT_POLICY.reflexLastBarIst}.`;
  return "No candle was judged on this day.";
}

function PositionLine({ card }: { card: AgentIndexCardView }) {
  const p = card.position;
  if (!p) return <div style={{ ...small, fontSize: 14 }}>No agent position on {card.index}.</div>;
  const side = p.side === "LONG" ? "a call (gains if the index rises)" : "a put (gains if the index falls)";
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 10px", background: C.panelAlt, border: `1px solid ${C.borderSoft}`, borderRadius: 10, padding: "8px 12px" }}>
      <span style={{ fontSize: 14.5, fontWeight: 650, color: C.textStrong, overflowWrap: "anywhere" }}>
        Holding {p.tradingSymbol}: {p.lots} lot{p.lots === 1 ? "" : "s"} of {side}
      </span>
      {p.pnlPct != null && (
        <span className="tnum" style={{ fontSize: 14.5, fontWeight: 700, color: pnlColor(p.pnlPct) }}>
          {fmtPct(p.pnlPct, 1)} on the premium
        </span>
      )}
      <span style={{ ...small }}>paper; the code closes it by {SQUARE_OFF_IST} at the latest</span>
    </div>
  );
}

function IdeaFacts({ f }: { f: AgentFinalistView }) {
  const c = f.contract;
  return (
    <div style={{ display: "grid", gap: 4, fontSize: 13.5, lineHeight: 1.5, color: C.textSoft, background: C.panelAlt, border: `1px solid ${C.borderSoft}`, borderRadius: 10, padding: "8px 12px", overflowWrap: "anywhere" }}>
      {c && (
        <span>
          <b>Contract:</b> {c.tradingSymbol} ({c.optionType === "CE" ? "call" : "put"}, strike {fmtNum(c.strike, 0)}, expires {fmtDateKey(c.expiry)})
        </span>
      )}
      {f.condition && (
        <span>
          <b>Condition:</b> {f.condition}
        </span>
      )}
      {f.wrongIf && (
        <span>
          <b>Wrong if:</b> {f.wrongIf}
        </span>
      )}
      {f.bearCase && (
        <span>
          <b>Case against:</b> {f.bearCase}
        </span>
      )}
      <span style={{ color: C.muted2 }}>Whatever the idea&apos;s horizon, an agent trade is intraday: the code closes it by {SQUARE_OFF_IST}.</span>
    </div>
  );
}

function GateList({ gate }: { gate: AgentDecisionView["gate"] }) {
  const head = gateHeadline(gate);
  if (!gate)
    return (
      <Row label="The code's checks">
        <span style={{ ...small, fontSize: 14 }}>{head.words}</span>
      </Row>
    );
  const { blocked, passed, info } = gateGroups(gate.lines);
  const fired = head.tone === "fired";
  const rest = passed.length + info.length;
  return (
    <Row label="The code's checks">
      <div style={{ fontSize: 15, fontWeight: 650, color: fired ? C.green : C.red }}>
        <span aria-hidden>{fired ? "✓ " : "✗ "}</span>
        {head.words}
      </div>
      {blocked.length > 0 && <Bullets items={blocked.map((l) => l.words)} marker="✗" color={C.red} />}
      {rest > 0 && (
        <details className="inline-disclosure">
          <summary>{fired ? `Show the ${passed.length} checks` : `${passed.length} passed${info.length ? `, ${info.length} for information` : ""}`}</summary>
          <div style={{ marginTop: 6 }}>
            <Bullets items={passed.map((l) => l.words)} marker="✓" color={C.green} />
            {info.length > 0 && <Bullets items={info.map((l) => `For information: ${l.words}`)} marker="•" />}
          </div>
        </details>
      )}
    </Row>
  );
}

function DecisionBlock({ d, finalist, mode }: { d: AgentDecisionView; finalist: AgentFinalistView | null; mode: AgentView["mode"] }) {
  const dir = DIRECTION_META[d.direction];
  const color = d.direction === "LONG" ? C.green : d.direction === "SHORT" ? C.red : C.muted;
  const idea = finalist?.kind === "IDEA";
  const sizing = d.sizing ? sizingWords(d.sizing) : null;
  return (
    <div style={{ display: "grid", gap: 12, borderTop: `1px solid ${C.borderSoft}`, paddingTop: 14, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Pill color={idea ? C.gold : C.blue}>{idea ? "Advisor idea" : "Generic"}</Pill>
        {d.source === "ESCALATION" && <Pill color={C.purple}>Deep model re-read</Pill>}
        <span style={{ fontSize: 15, fontWeight: 650, color: C.textStrong, overflowWrap: "anywhere" }}>{finalist?.label ?? d.finalistId}</span>
      </div>
      {finalist && idea && <IdeaFacts f={finalist} />}
      <Row label={d.source === "ESCALATION" ? "The deep model says" : "The fast model says"}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 10px" }}>
          <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6, color, fontSize: 21, fontWeight: 750, letterSpacing: "0.01em" }}>
            <span aria-hidden>{dir.glyph}</span>
            {dir.word.toUpperCase()}
          </span>
          <span style={{ ...body, fontSize: 15 }}>{dir.trade}</span>
        </div>
        <div className="tnum" style={{ ...small, display: "flex", flexWrap: "wrap", gap: "2px 14px", fontSize: 14 }}>
          <span>
            confidence <b style={{ color: C.textStrong }}>{prob(d.directionConfidence)}</b>
          </span>
          <span>
            setup <b style={{ color: C.textStrong }}>{d.setupQuality} of 3</b>
          </span>
          <span>
            regime <b style={{ color: C.textStrong }}>{REGIME_WORDS[d.regime].toLowerCase()}</b>
          </span>
          <span>
            risk <b style={{ color: C.textStrong }}>{riskWords(d.riskState).toLowerCase()}</b>
          </span>
          <span>
            toxic flow <b style={{ color: C.textStrong }}>{d.toxicFlow ? "yes" : "no"}</b>
          </span>
        </div>
        <p style={{ margin: 0, ...body, fontSize: 15, overflowWrap: "anywhere" }}>&ldquo;{d.reason}&rdquo;</p>
      </Row>
      <GateList gate={d.gate} />
      {sizing && (
        <Row label="Size (Kelly, from measured results)">
          <div style={{ fontSize: 15, fontWeight: 650, color: d.sizing && d.sizing.riskPct > 0 ? C.textStrong : C.orange }}>{sizing.headline}</div>
          <div style={{ ...small }}>{sizing.detail}</div>
        </Row>
      )}
      <Row label={mode === "shadow" ? "What the code did (shadow mode: no orders)" : "What the code did"}>
        <div style={{ fontSize: 15, fontWeight: 650, color: C.textStrong }}>{actionWords(d.action)}</div>
        {d.actionDetail && <div style={{ ...small, overflowWrap: "anywhere" }}>{d.actionDetail}</div>}
      </Row>
      {d.edge && (
        <Row label="Measured-edge check (recorded, not applied)">
          <div style={{ fontSize: 14.5, color: C.textSoft, overflowWrap: "anywhere" }}>
            <b style={{ color: d.edge.passed ? C.green : C.red }}>
              <span aria-hidden>{d.edge.passed ? "✓ " : "✗ "}</span>
              {d.edge.passed ? "Would pass" : "Would block"}:
            </b>{" "}
            {d.edge.detail}
          </div>
          <div style={{ ...small, fontSize: 12.5 }}>This account skips it, as the paper practice quota does; it is kept so the two can be compared.</div>
        </Row>
      )}
      <div style={{ ...small }}>
        <b style={{ color: C.textSoft }}>30-minute result:</b> {outcomeWords(d.outcome)}
      </div>
    </div>
  );
}

function SnapshotGrid({ index, fields }: { index: string; fields: AgentSnapshotFieldView[] }) {
  return (
    <>
      <p style={{ margin: 0, ...small }}>
        Everything the model saw about {index}, computed by code from data up to the candle&apos;s close and never later. Distances are in percent of the close: positive when the level is
        above it.
      </p>
      <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 250px), 1fr))", gap: "0 20px", margin: 0 }}>
        {fields.map((f) => (
          <div key={f.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, borderBottom: `1px solid ${C.borderSoft}`, padding: "5px 0", minWidth: 0 }}>
            <dt style={{ fontSize: 13, color: C.muted, minWidth: 0 }}>{f.label}</dt>
            <dd className="tnum" style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: C.textStrong, textAlign: "right", whiteSpace: "nowrap" }}>
              {f.value}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

export function IndexDecisionCard({ card, view }: { card: AgentIndexCardView; view: AgentView }) {
  const finalistOf = (id: string) => view.finalists.find((f) => f.id === id) ?? null;
  return (
    <Panel style={{ padding: "16px 16px 18px", display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "4px 12px" }}>
        <h3 style={h3}>{card.index}</h3>
        <span className="tnum" style={{ ...small, fontSize: 14 }}>
          {card.barAt ? `candle closing ${istTime(card.barAt)}${card.close != null ? ` · close ${fmtNum(card.close, 2)}` : ""}` : "no candle judged yet"}
        </span>
      </div>
      <PositionLine card={card} />
      {card.decisions.length === 0 ? (
        <p style={{ margin: 0, ...body, fontSize: 15 }}>{emptyCardWords(view)}</p>
      ) : (
        card.decisions.map((d) => <DecisionBlock key={d.id} d={d} finalist={finalistOf(d.finalistId)} mode={view.mode} />)
      )}
      {card.snapshot && (
        <Disclosure title="The numbers the model saw" note={snapshotNote(card)}>
          <SnapshotGrid index={card.index} fields={card.snapshot} />
        </Disclosure>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 3. Escalations
// ---------------------------------------------------------------------------

export function EscalationList({ escalations, finalists, generatedAt }: { escalations: AgentEscalationView[]; finalists: AgentFinalistView[]; generatedAt: string }) {
  if (!escalations.length)
    return (
      <Panel style={{ padding: "16px 18px", ...body, fontSize: 15 }}>
        No escalations today. The deep model is asked to re-read a candle only when the fast model&apos;s confidence is below {prob(ESCALATION.belowConfidence)} on a setup of{" "}
        {ESCALATION.minSetupQuality} or more, or the regime flips to crisis; at most once per index every {ESCALATION.perIndexGapMs / 60_000} minutes.
      </Panel>
    );
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {escalations.map((e) => {
        const f = finalists.find((x) => x.id === e.finalistId);
        const done = e.status === "DONE";
        const color = done ? C.green : e.status === "FAILED" || e.status === "LATE" ? C.red : e.status === "SKIPPED" ? C.muted : C.blue;
        return (
          <Panel key={e.id} style={{ padding: "14px 16px", display: "grid", gap: 8 }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 10px" }}>
              <span style={{ fontSize: 16, fontWeight: 650, color: C.textStrong }}>{e.index}</span>
              <span style={{ ...small }}>asked {dayTime(e.requestedAt, generatedAt)}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 650, color }}>
                <Dot color={color} size={7} /> {escalationStatusWords(e.status)}
              </span>
            </div>
            <div style={{ ...small, fontSize: 14 }}>
              <b style={{ color: C.textSoft }}>Why it was asked:</b> {triggerWords(e.trigger)}
              {f ? `, on "${f.label}"` : ""}.
            </div>
            {e.decision && (
              <div style={{ fontSize: 14.5, color: C.textSoft, overflowWrap: "anywhere" }}>
                <b style={{ color: C.textStrong }}>
                  <span aria-hidden>{DIRECTION_META[e.decision.direction].glyph} </span>
                  {DIRECTION_META[e.decision.direction].word}
                </b>{" "}
                · confidence {prob(e.decision.directionConfidence)} · setup {e.decision.setupQuality} of 3 · {REGIME_WORDS[e.decision.regime].toLowerCase()} · risk {riskWords(e.decision.riskState).toLowerCase()}
              </div>
            )}
            {e.reason && <p style={{ margin: 0, ...body, fontSize: 14.5, overflowWrap: "anywhere" }}>&ldquo;{e.reason}&rdquo;</p>}
            <div style={{ ...small, fontSize: 13 }}>
              {e.appliedToBarAt ? `Applied to the ${istTime(e.appliedToBarAt)} candle, through the same checks.` : done ? "Waits for the next candle; it then goes through the same checks." : "Never waited for: the fast model's candles go on."}
              {e.costUsd != null ? ` Cost ${usd(e.costUsd)}.` : ""}
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Risk limits and re-arm
// ---------------------------------------------------------------------------

export function RiskPanel({ risk, hasToken, onRearm, generatedAt }: { risk: AgentRiskView; hasToken: boolean; onRearm: AdminAction; generatedAt: string }) {
  const dialog = useAdminDialog<"rearm">((_, token) => onRearm(undefined, token), hasToken);
  // Re-arm only undoes a stop (it also restarts the peak), so it is offered only while the halt or the kill switch is on.
  const stopped = risk.drawdownHalt || risk.killSwitch;
  const dd = risk.drawdownPct ?? 0;
  const dl = risk.dayLossPct ?? 0;
  return (
    <Panel style={{ padding: 16, display: "grid", gap: 16 }}>
      <div style={{ fontSize: 16, fontWeight: 650, color: stopped ? C.red : C.green }}>
        <span aria-hidden>{stopped ? "✗ " : "✓ "}</span>
        {risk.drawdownHalt
          ? `Halted: the account fell ${pct(dd)} from its peak (the limit is ${risk.maxDrawdownPct}%). No new entries until you re-arm.`
          : risk.killSwitch
            ? `Kill switch on${risk.killReason ? `: ${risk.killReason}` : ""}. No new entries.`
            : "Within every limit: new entries are allowed when a decision passes every check."}
      </div>
      <Meter
        label="Drawdown from the peak"
        used={dd}
        cap={risk.maxDrawdownPct}
        value={`${pct(risk.drawdownPct)} of ${risk.maxDrawdownPct}%`}
        note={`At ${risk.maxDrawdownPct}% the code closes everything and stops new entries until re-armed.`}
      />
      <Meter label="Today's loss" used={dl} cap={risk.dailyLossCapPct} value={`${pct(risk.dayLossPct)} of ${risk.dailyLossCapPct}%`} note={`At ${risk.dailyLossCapPct}% of equity the code stops new entries for the day.`} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Fact label="Equity" value={risk.equity == null ? "—" : fmtInr(risk.equity)} note={risk.peakEquity == null ? undefined : `peak ${fmtInr(risk.peakEquity)}`} />
        <Fact label="Open positions" value={`${risk.openPositions} of ${risk.maxOpenPositions}`} note={`at most 1 per index, ${risk.maxLotsPerPosition} lots each`} />
        <Fact label="The code's risk state" value={riskWords(risk.codeRiskState)} color={risk.codeRiskState === "SAFE" ? C.textStrong : risk.codeRiskState === "NEAR_LIMIT" ? C.orange : C.red} note="from drawdown, day loss and positions" />
      </div>
      <Bullets
        items={[
          <>
            Agent&apos;s kill switch: <b>{risk.killSwitch ? "on" : "off"}</b>
            {risk.killSwitch && risk.killReason ? ` (${risk.killReason})` : ""}. It is checked again right before every order.
          </>,
          <>
            Main account&apos;s kill switch: <b>{risk.mainKillSwitch ? "on" : "off"}</b>. Main&apos;s kill switch also switches the agent&apos;s on; resetting main does not reset the agent.
          </>,
          <>Every limit here is code. The model cannot change any of them, and it only sees the drawdown and the day&apos;s loss as context.</>,
        ]}
        marker="•"
      />
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 14px" }}>
        <Btn variant={stopped ? "danger" : "outline"} size="md" onClick={() => dialog.show("rearm")} disabled={!stopped}>
          Re-arm the agent
        </Btn>
        <span style={{ ...small }}>{stopped ? "Clears the halt and the agent's kill switch (admin token needed)." : "Nothing to re-arm: no halt and the kill switch is off."}</span>
      </div>
      {risk.asOf && <div style={{ ...small, fontSize: 12.5 }}>As of {dayTime(risk.asOf, generatedAt)}.</div>}
      {dialog.open && (
        <ConfirmDialog
          title="Re-arm the agent"
          tone="danger"
          confirmLabel="Re-arm"
          busy={dialog.busy}
          error={dialog.error}
          onCancel={dialog.close}
          onConfirm={() => void dialog.confirm()}
          extra={dialog.extra}
        >
          <p style={{ margin: 0 }}>
            This clears the drawdown halt and the agent&apos;s kill switch. Its peak equity restarts at today&apos;s equity{risk.equity == null ? "" : ` (${fmtInr(risk.equity)})`}, so the next{" "}
            {risk.maxDrawdownPct}% is measured from here.
          </p>
          {risk.mainKillSwitch && <p style={{ margin: 0, color: C.red }}>Main&apos;s kill switch is on: the engine switches the agent&apos;s on again at its next tick until main is reset.</p>}
          <p style={{ margin: 0, color: C.textDim }}>Every other limit still applies. This is the paper account only; nothing here touches real money.</p>
        </ConfirmDialog>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 5. Calibration
// ---------------------------------------------------------------------------

const rate = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);
const brier = (n: number | null) => (n == null ? "—" : n.toFixed(3));

export function CalibrationPanel({ cal }: { cal: AgentCalibrationView }) {
  const verdict = brierVerdict(cal.brier, cal.baselineBrier, cal.graded);
  const outlook = sizingOutlook(cal);
  const th: CSSProperties = { padding: "8px 8px", textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" };
  const td: CSSProperties = { padding: "8px 8px", textAlign: "right", borderTop: `1px solid ${C.borderSoft}`, whiteSpace: "nowrap" };
  const lines: { label: string; n: number; brier: number | null }[] = [
    ...cal.byIndex.map((x) => ({ label: x.index, n: x.n, brier: x.brier })),
    ...cal.byKind.map((x) => ({ label: x.kind === "IDEA" ? "Advisor ideas" : "Generic finalists", n: x.n, brier: x.brier })),
    ...cal.bySource.map((x) => ({ label: x.source === "ESCALATION" ? "Deep model re-reads" : "Fast model", n: x.n, brier: x.brier })),
  ];
  return (
    <Panel style={{ padding: 16, display: "grid", gap: 16 }}>
      <p style={{ margin: 0, ...body, fontSize: 15 }}>
        Each call with a direction is graded 30 minutes later: right when the index moved at least {OUTCOME.deadbandPct}% the called way. The Brier score measures how honest the stated
        confidence was: 0 is perfect, and always guessing the share of calls that turn out right scores the baseline. Lower is better.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Fact label="Graded calls" value={fmtNum(cal.graded, 0)} note={cal.asOf ? `as of the review of ${fmtDateKey(cal.asOf.slice(0, 10))}` : "none yet"} />
        <Fact
          label="Brier score"
          value={brier(cal.brier)}
          note={`baseline ${brier(cal.baselineBrier)}`}
          color={verdict.tone === "better" ? C.green : verdict.tone === "worse" ? C.red : C.textStrong}
        />
        <Fact label="Paid rate" value={rate(cal.paidRate)} note={`moved ${OUTCOME.payMovePct}% or more: enough to pay for an option`} />
        <Fact label="Sizing chance p" value={prob(cal.sizingP)} note={`from ${fmtNum(cal.sizingN, 0)} effective calls above ${prob(CALIBRATION.fireMinConfidence)}`} />
      </div>
      <div style={{ ...body, fontSize: 15, fontWeight: 600, color: C.textStrong }}>
        <span aria-hidden>{verdict.tone === "better" ? "▲ " : verdict.tone === "worse" ? "▼ " : "▬ "}</span>
        {verdict.words}
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <div style={{ ...microLabel, color: C.muted }}>When can sizing move?</div>
        <Bullets items={sizingOutlookWords(outlook, cal.sizingP)} marker="•" />
        <div style={{ ...small, fontSize: 12.5 }}>
          p is a cautious estimate (the {Math.round(CALIBRATION.sizingQuantile * 100)}th percentile) of how often calls above {prob(CALIBRATION.fireMinConfidence)} moved enough to pay,
          pulled toward 50% by {CALIBRATION.pooledPriorN} imaginary calls; overlapping 30-minute windows count once. The model&apos;s own confidence is never used for size.
          {cal.sizingMode === "buckets" ? " Sizing now uses a separate estimate per confidence band." : ` Per-band estimates start after ${CALIBRATION.switchMinGraded} graded calls.`}
        </div>
      </div>
      {cal.buckets.length > 0 && (
        <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
          <div style={{ ...microLabel, color: C.muted }}>Said against right, by confidence band</div>
          <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 12 }}>
            <table className="tnum" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5, color: C.textSoft }}>
              <thead>
                <tr style={{ background: C.panelAlt, color: C.muted, fontSize: 12.5 }}>
                  <th style={{ ...th, textAlign: "left" }}>Confidence</th>
                  <th style={th}>Calls</th>
                  <th style={th}>Said</th>
                  <th style={th}>Right</th>
                  <th style={th}>Paid</th>
                </tr>
              </thead>
              <tbody>
                {cal.buckets.map((b) => (
                  <tr key={`${b.from}-${b.to}`}>
                    <td style={{ ...td, textAlign: "left" }}>
                      {b.from.toFixed(1)}–{Math.min(1, b.to).toFixed(1)}
                    </td>
                    <td style={td}>{b.n}</td>
                    <td style={td}>{rate(b.statedMean)}</td>
                    <td style={td}>{rate(b.hitRate)}</td>
                    <td style={td}>{rate(b.paidRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ ...small, fontSize: 12.5 }}>Honest confidence means &ldquo;Right&rdquo; is close to &ldquo;Said&rdquo; in every band.</div>
        </div>
      )}
      {lines.length > 0 && (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ ...microLabel, color: C.muted }}>Brier score by group (calls)</div>
          <div className="tnum" style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 14, color: C.textSoft }}>
            {lines.map((l) => (
              <span key={l.label}>
                {l.label} <b style={{ color: C.textStrong }}>{brier(l.brier)}</b> ({l.n})
              </span>
            ))}
            <span>
              No-direction calls <b style={{ color: C.textStrong }}>{brier(cal.neutral.brier)}</b> ({cal.neutral.n}; baseline {brier(cal.neutral.baselineBrier)}, right when the index stayed within{" "}
              {OUTCOME.neutralBandPct}%)
            </span>
          </div>
          <div style={{ ...small, fontSize: 12.5 }}>Only the fast model&apos;s calls feed sizing; the deep model&apos;s re-reads and the no-direction calls are scored on their own lines.</div>
        </div>
      )}
      <div style={{ ...small, fontSize: 14 }}>
        <b style={{ color: C.textSoft }}>Agent trades:</b>{" "}
        {cal.trades.n === 0
          ? "none closed yet."
          : `${cal.trades.n} closed, ${cal.trades.wins} won, net ${fmtInr(cal.trades.netRupees, { sign: true })} after charges.`}{" "}
        Payoff ratio b = {cal.payoffB.toFixed(2)}
        {cal.payoffMeasured != null ? ` (measured ${cal.payoffMeasured.toFixed(2)} over ${cal.payoffTrades} trades)` : " (nothing measured yet)"}.
      </div>
      {cal.note && <div style={{ ...small, fontSize: 12.5, overflowWrap: "anywhere" }}>{cal.note}</div>}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 6. Nightly review and the candidate guidance
// ---------------------------------------------------------------------------

function ReviewList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ ...microLabel, color: C.muted }}>{title}</div>
      {items.length ? <Bullets items={items} marker="•" /> : <div style={{ ...small, fontSize: 14 }}>{empty}</div>}
    </div>
  );
}

function ReviewCard({ review, generatedAt }: { review: AgentReviewView; generatedAt: string }) {
  return (
    <Panel style={{ padding: 16, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 12px" }}>
        <h3 style={h3}>Review of {fmtDateKey(review.date)}</h3>
        <span style={{ ...small }}>
          {reviewStatusWords(review.status)}
          {review.writtenAt ? ` ${dayTime(review.writtenAt, generatedAt)}` : ""}
          {review.model ? ` · ${modelWords(review.model)}` : ""}
          {review.costUsd != null ? ` · cost ${usd(review.costUsd)}` : ""}
        </span>
      </div>
      {review.error && <Notice tone="error">The review failed: {review.error}</Notice>}
      {review.summary && <p style={{ margin: 0, ...body, overflowWrap: "anywhere" }}>{review.summary}</p>}
      <ReviewList title="Trades" items={review.fills} empty="No trades that day." />
      <ReviewList title="Missed moves and false alarms" items={review.misses} empty="None noted." />
      <ReviewList title="Mistakes" items={review.mistakes} empty="None noted." />
      <ReviewList title="Lessons" items={review.lessons} empty="None noted." />
    </Panel>
  );
}

/** One guidance text as its points; a point the proposal adds or drops is marked in words and with + or −. */
function GuidanceList({ title, points, background, border }: { title: string; points: GuidancePoint[]; background: string; border: string }) {
  return (
    <div style={{ display: "grid", gap: 6, alignContent: "start", minWidth: 0 }}>
      <div style={{ ...microLabel, color: C.muted, overflowWrap: "anywhere" }}>{title}</div>
      <ul style={{ margin: 0, padding: "10px 12px", listStyle: "none", display: "grid", gap: 6, background, border: `1px solid ${border}`, borderRadius: 10 }}>
        {points.map((p, i) => (
          <li key={i} style={{ display: "grid", gridTemplateColumns: "14px minmax(0, 1fr)", gap: 6, fontSize: 14, lineHeight: 1.5, color: p.change === "same" ? C.textSoft : C.textStrong, overflowWrap: "anywhere" }}>
            <span aria-hidden style={{ fontWeight: 700, color: p.change === "added" ? C.green : p.change === "removed" ? C.red : C.muted3 }}>
              {p.change === "added" ? "+" : p.change === "removed" ? "−" : "•"}
            </span>
            <span>
              {p.text}
              {p.change !== "same" && <span style={{ color: C.muted }}> ({p.change === "added" ? "new" : "dropped"})</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReplayBox({ replay }: { replay: NonNullable<AgentCandidateView["replay"]> }) {
  const rows: [string, string][] = [
    ["Proposed text, replayed", brier(replay.brierCandidate)],
    ["Current text, replayed", brier(replay.brierCurrentReplayed)],
    ["Current text, as it ran live", brier(replay.brierCurrentLive)],
  ];
  return (
    <div style={{ display: "grid", gap: 8, background: alpha(C.orange, 0.06), border: `1px solid ${alpha(C.orange, 0.35)}`, borderRadius: 12, padding: "12px 14px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 15, fontWeight: 650, color: C.textStrong }}>Replay score</span>
        <Pill color={C.orange} solid style={{ fontSize: 11, padding: "3px 9px" }}>
          {replay.label}
        </Pill>
      </div>
      <p style={{ margin: 0, ...small, fontSize: 13.5 }}>
        The day&apos;s {replay.bars} candles were judged again with each text, on identical inputs. The reviewer had already seen how those candles ended, so a better score here is
        expected and proves nothing; only later sessions can show whether the text helps.
      </p>
      <dl className="tnum" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "4px 16px", margin: 0, fontSize: 14 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt style={{ color: C.textSoft }}>Brier, {k.charAt(0).toLowerCase() + k.slice(1)}</dt>
            <dd style={{ margin: 0, fontWeight: 650, color: C.textStrong, textAlign: "right" }}>{v}</dd>
          </div>
        ))}
        <div style={{ display: "contents" }}>
          <dt style={{ color: C.textSoft }}>Calls that would pass the model-side checks</dt>
          <dd style={{ margin: 0, fontWeight: 650, color: C.textStrong, textAlign: "right" }}>
            {replay.firesCandidate} vs {replay.firesCurrent}
          </dd>
        </div>
      </dl>
      <div style={{ ...small, fontSize: 12.5 }}>
        Lower Brier is better. The gap between the two current-text scores shows how much the score moves from run to run with no change of text. {replay.graded} of the calls could be
        graded.{replay.complete ? "" : " The replay stopped early (cost cap), so it covers only part of the day."}
      </div>
    </div>
  );
}

function CandidateCard({
  c,
  generatedAt,
  hasToken,
  onDecide,
}: {
  c: AgentCandidateView;
  generatedAt: string;
  hasToken: boolean;
  onDecide: AdminAction<{ id: string; decision: "approve" | "reject" }>;
}) {
  const dialog = useAdminDialog<"approve" | "reject">((decision, token) => onDecide({ id: c.id, decision }, token), hasToken);
  const diff = guidanceDiff(c.currentGuidance, c.guidance);
  const pending = c.status === "PENDING";
  const statusColor = pending ? C.gold : c.status === "APPROVED" ? C.green : c.status === "REJECTED" || c.status === "FAILED" ? C.red : C.muted;
  return (
    <Panel style={{ padding: 16, display: "grid", gap: 14, border: pending ? `2px solid ${alpha(C.gold, 0.45)}` : undefined }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 12px" }}>
        <h3 style={h3}>Proposed guidance</h3>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14.5, fontWeight: 650, color: statusColor }}>
          <Dot color={statusColor} size={7} /> {candidateStatusWords(c.status)}
        </span>
      </div>
      <p style={{ margin: 0, ...body, fontSize: 15 }}>
        After the close of {fmtDateKey(c.date)} the nightly review proposed a new guidance text for the fast model. Only this text can change: the thresholds, sizes and limits stay in
        code. Nothing is approved automatically.
      </p>
      {c.replay ? <ReplayBox replay={c.replay} /> : <div style={{ ...small }}>The replay has not run yet.</div>}
      <Row label="What the proposal changes">
        {diff.added.length === 0 && diff.removed.length === 0 ? (
          <div style={{ ...body, fontSize: 15 }}>The points are the same; only their wording, spacing or order differs.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {diff.added.length > 0 && (
              <div style={{ display: "grid", gap: 4 }}>
                <div style={{ fontSize: 13.5, fontWeight: 650, color: C.green }}>Added</div>
                <Bullets items={diff.added} marker="+" color={C.green} />
              </div>
            )}
            {diff.removed.length > 0 && (
              <div style={{ display: "grid", gap: 4 }}>
                <div style={{ fontSize: 13.5, fontWeight: 650, color: C.red }}>Dropped</div>
                <Bullets items={diff.removed} marker="−" color={C.red} />
              </div>
            )}
          </div>
        )}
      </Row>
      <details className="inline-disclosure">
        <summary>Read both texts in full</summary>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 12, marginTop: 10 }}>
          <GuidanceList title={`Current text (${c.baseVersion})`} points={diff.current} background={C.panelAlt} border={C.borderSoft} />
          <GuidanceList title="Proposed text" points={diff.proposed} background={alpha(C.gold, 0.05)} border={alpha(C.gold, 0.3)} />
        </div>
      </details>
      <Row label="Why the review proposes it">
        <p style={{ margin: 0, ...body, fontSize: 15, overflowWrap: "anywhere" }}>{c.rationale}</p>
      </Row>
      <Row label="It would be wrong if">
        <p style={{ margin: 0, ...body, fontSize: 15, overflowWrap: "anywhere" }}>{c.wouldBeWrongIf}</p>
      </Row>
      {pending ? (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <Btn variant="gold" size="md" onClick={() => dialog.show("approve")}>
              Approve
            </Btn>
            <Btn variant="outline" size="md" onClick={() => dialog.show("reject")}>
              Reject
            </Btn>
          </div>
          <div style={{ ...small }}>Approval works only outside market hours (before 09:15 or after 15:30 IST), so one session is judged by one text. Admin token needed.</div>
        </div>
      ) : (
        c.decidedAt && (
          <div style={{ ...small, fontSize: 14 }}>
            {c.status === "APPROVED" ? "Approved" : c.status === "REJECTED" ? "Rejected" : "Decided"} {dayTime(c.decidedAt, generatedAt)}
            {c.decidedBy ? ` by ${c.decidedBy}` : ""}.
          </div>
        )
      )}
      {dialog.open && (
        <ConfirmDialog
          title={dialog.open === "approve" ? "Approve the proposed guidance" : "Reject the proposed guidance"}
          confirmLabel={dialog.open === "approve" ? "Approve" : "Reject"}
          busy={dialog.busy}
          error={dialog.error}
          onCancel={dialog.close}
          onConfirm={() => void dialog.confirm()}
          extra={dialog.extra}
        >
          {dialog.open === "approve" ? (
            <>
              <p style={{ margin: 0 }}>The fast model reads the proposed text from the next candle. Thresholds, sizes and limits do not change, and you can go back to the built-in text later.</p>
              <p style={{ margin: 0, color: C.textDim }}>The replay score is in-sample, not proof: it says little about the sessions ahead.</p>
            </>
          ) : (
            <p style={{ margin: 0 }}>The current text stays. The next review may propose another one.</p>
          )}
        </ConfirmDialog>
      )}
    </Panel>
  );
}

export function ReviewPanel({
  review,
  candidate,
  generatedAt,
  hasToken,
  onDecide,
}: {
  review: AgentReviewView | null;
  candidate: AgentCandidateView | null;
  generatedAt: string;
  hasToken: boolean;
  onDecide: AdminAction<{ id: string; decision: "approve" | "reject" }>;
}) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {review ? (
        <ReviewCard review={review} generatedAt={generatedAt} />
      ) : (
        <Panel style={{ padding: "16px 18px", ...body, fontSize: 15 }}>No review yet. The first is written after the first session&apos;s close, at about 16:20 IST.</Panel>
      )}
      {candidate ? (
        <CandidateCard c={candidate} generatedAt={generatedAt} hasToken={hasToken} onDecide={onDecide} />
      ) : (
        <Panel style={{ padding: "16px 18px", ...body, fontSize: 15 }}>No proposed guidance is waiting. The review proposes one only when the evidence supports a change.</Panel>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 7. Cost
// ---------------------------------------------------------------------------

export function CostPanel({ cost }: { cost: AgentCostView }) {
  const lat = cost.reflexLatencyMs;
  const secs = (ms: number | null) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)} s`);
  const td: CSSProperties = { padding: "8px 8px", borderTop: `1px solid ${C.borderSoft}`, whiteSpace: "nowrap", textAlign: "right" };
  return (
    <Panel style={{ padding: 16, display: "grid", gap: 14 }}>
      <Meter
        label={`Spent on ${fmtDateKey(cost.date)}`}
        used={cost.spentUsd}
        cap={cost.capUsd}
        value={`${usd(cost.spentUsd)} of ${usd(cost.capUsd)}`}
        note="Past the cap the agent makes no new model calls and takes no new entries; exits still run in code."
      />
      {cost.capReached && <Notice tone="error">Today&apos;s cap is reached: no new entries until tomorrow.</Notice>}
      {cost.byKind.length > 0 && (
        <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 12 }}>
          <table className="tnum" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5, color: C.textSoft }}>
            <thead>
              <tr style={{ background: C.panelAlt, color: C.muted, fontSize: 12.5 }}>
                <th style={{ padding: "8px 8px", textAlign: "left", fontWeight: 600 }}>Calls</th>
                <th style={{ padding: "8px 8px", textAlign: "right", fontWeight: 600 }}>Count</th>
                <th style={{ padding: "8px 8px", textAlign: "right", fontWeight: 600 }}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {cost.byKind.map((k) => (
                <tr key={k.kind}>
                  <td style={{ ...td, textAlign: "left", whiteSpace: "normal" }}>{COST_KIND_WORDS[k.kind]}</td>
                  <td style={td}>{k.calls}</td>
                  <td style={td}>{usd(k.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ ...small, fontSize: 14 }}>
        {lat.p50 == null ? "No call times measured today." : `Each-candle call time: typical ${secs(lat.p50)}, slow (1 in 20) ${secs(lat.p95)}.`}
      </div>
    </Panel>
  );
}
