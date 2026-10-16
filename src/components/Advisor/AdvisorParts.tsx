"use client";

/**
 * The Advisor page's sections, in reading order: the "Today" answer, where the market may go, the trade
 * ideas, what is moving the market, option premiums, the zero-hero check, things you may not know, what
 * not to do, and the sources. Plain words first; every term gets a one-line explanation in brackets.
 */
import type { CSSProperties, ReactNode } from "react";
import type { AdvisorFactor, AdvisorIdea, AdvisorLean, AdvisorOutlook, AdvisorReport, IndexId } from "@/engine/api-types";
import { alpha, C } from "@/components/shared/colors";
import { fmtNum } from "@/components/shared/format";
import { SERIF } from "@/components/shared/theme";
import { microLabel, Panel, Pill } from "@/components/shared/ui";
import { CopyAction } from "@/components/Copy/CopyButton";
import {
  chainHref,
  chanceWords,
  CONFIDENCE_WORDS,
  exitByWords,
  groupIdeas,
  HORIZON_WORDS,
  HORIZONS,
  ideaLine,
  LEAN_META,
  plainContract,
  premium,
  PREMIUM_WORDS,
  rangeWords,
  READING_META,
  rupees,
  safeHref,
  sortFactors,
  sourceHost,
} from "./advisorText";

const INDICES: readonly IndexId[] = ["NIFTY", "SENSEX"];
const CAPITAL = 10_000;

export const body: CSSProperties = { fontSize: 16.5, lineHeight: 1.6, color: C.textSoft };
const small: CSSProperties = { fontSize: 13.5, lineHeight: 1.5, color: C.muted2 };
const h3: CSSProperties = { margin: 0, fontFamily: SERIF, fontSize: 21, fontWeight: 500, color: C.textStrong, letterSpacing: "-0.01em" };

export const ACTION_META: Record<AdvisorReport["today"]["action"], { color: string; note: string }> = {
  BUY: { color: C.green, note: "One idea below is worth a small buy, with its stop." },
  WAIT: { color: C.orange, note: "Nothing is worth buying right now. Waiting is a valid answer." },
  AVOID: { color: C.red, note: "Stay out of options today." },
};

const LEAN_COLOR: Record<AdvisorLean, string> = { UP: C.green, DOWN: C.red, SIDEWAYS: C.muted };

const READING_COLOR: Record<AdvisorFactor["reading"], string> = {
  SUPPORTS_UP: C.green,
  SUPPORTS_DOWN: C.red,
  NEUTRAL: C.muted,
  RISK: C.orange,
  NO_DATA: C.muted3,
};

const PREMIUM_COLOR: Record<AdvisorReport["premium"]["verdict"], string> = { CHEAP: C.green, NORMAL: C.blue, EXPENSIVE: C.red, NO_DATA: C.muted3 };

function Bullets({ items, style }: { items: readonly string[]; style?: CSSProperties }) {
  if (!items.length) return null;
  return (
    <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6, ...body, fontSize: 15.5, ...style }}>
      {items.map((t, i) => (
        <li key={i} style={{ overflowWrap: "anywhere" }}>
          {t}
        </li>
      ))}
    </ul>
  );
}

/** A small native disclosure ("2 more reasons"). */
function More({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details>
      <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 600, color: C.gold, padding: "4px 0", listStylePosition: "inside" }}>{label}</summary>
      <div style={{ marginTop: 8 }}>{children}</div>
    </details>
  );
}

function Fact({ label, value, note, color = C.textStrong }: { label: string; value: ReactNode; note?: ReactNode; color?: string }) {
  return (
    <div style={{ flex: "1 1 140px", background: C.panelAlt, border: `1px solid ${C.borderSoft}`, borderRadius: 12, padding: "10px 12px", minWidth: 0 }}>
      <div style={{ ...microLabel, color: C.muted }}>{label}</div>
      <div className="tnum" style={{ fontSize: 19, fontWeight: 650, color, marginTop: 3, overflowWrap: "anywhere" }}>
        {value}
      </div>
      {note != null && <div style={{ ...small, fontSize: 12.5, marginTop: 2 }}>{note}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Today
// ---------------------------------------------------------------------------

export function TodayCard({ report, nowMs }: { report: AdvisorReport; nowMs: number | null }) {
  const { action, summary, ideaId } = report.today;
  const meta = ACTION_META[action];
  const idea = action === "BUY" && ideaId ? (report.ideas.find((i) => i.id === ideaId) ?? null) : null;
  const m = report.market;
  const strip = [
    m.nifty != null ? `NIFTY ${fmtNum(m.nifty, 0)}` : null,
    m.sensex != null ? `SENSEX ${fmtNum(m.sensex, 0)}` : null,
    m.vix != null ? `India VIX ${m.vix.toFixed(2)} (the fear gauge)` : null,
    m.phase ? `Market ${m.phase.toLowerCase().replace(/_/g, " ")}` : null,
  ].filter(Boolean);
  return (
    <Panel style={{ border: `2px solid ${alpha(meta.color, 0.45)}`, padding: "22px 20px", display: "grid", gap: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 14px" }}>
        <span style={{ ...microLabel, fontSize: 13, color: C.muted }}>Today</span>
        <span
          style={{
            fontSize: "clamp(38px, 9vw, 56px)",
            fontWeight: 800,
            letterSpacing: "0.02em",
            lineHeight: 1,
            color: meta.color,
          }}
        >
          {action}
        </span>
        <span style={{ ...small, fontSize: 14.5, color: C.muted, flex: "1 1 200px" }}>{meta.note}</span>
      </div>
      <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: "clamp(23px, 3.4vw, 30px)", fontWeight: 500, lineHeight: 1.25, color: C.textStrong, overflowWrap: "anywhere" }}>{report.headline}</h2>
      <p style={{ margin: 0, ...body, fontSize: 17 }}>{summary}</p>
      {idea && (
        <div style={{ display: "grid", gap: 12, background: alpha(C.green, 0.06), border: `1px solid ${alpha(C.green, 0.3)}`, borderRadius: 12, padding: "14px 14px" }}>
          <div style={{ ...microLabel, color: C.muted }}>The order, in one line</div>
          <div className="tnum" style={{ fontSize: 17, fontWeight: 650, lineHeight: 1.5, color: C.textStrong, overflowWrap: "anywhere" }}>
            {ideaLine(idea)}
          </div>
          <div style={{ ...small }}>{plainContract(idea.contract, nowMs ?? Date.parse(report.createdAt))}. Details in the idea card below.</div>
          <CopyAction text={ideaLine(idea)} label="Copy order" style={{ justifySelf: "start" }} />
        </div>
      )}
      {strip.length > 0 && <div style={{ ...small, borderTop: `1px solid ${C.borderSoft}`, paddingTop: 12 }}>{strip.join(" · ")} · when written</div>}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 3. Where the market may go
// ---------------------------------------------------------------------------

function OutlookColumn({ o, horizon }: { o: AdvisorOutlook | undefined; horizon: (typeof HORIZONS)[number] }) {
  if (!o)
    return (
      <div style={{ padding: "14px 14px", border: `1px solid ${C.borderSoft}`, borderRadius: 12, minWidth: 0 }}>
        <div style={{ ...microLabel }}>{HORIZON_WORDS[horizon]}</div>
        <div style={{ ...small, marginTop: 8 }}>No reading.</div>
      </div>
    );
  const lean = LEAN_META[o.lean];
  const range = rangeWords(o.rangeLow, o.rangeHigh);
  const top = o.why.slice(0, 2);
  const rest = o.why.slice(2);
  return (
    <div style={{ padding: "14px 14px", border: `1px solid ${C.borderSoft}`, borderRadius: 12, minWidth: 0, display: "grid", gap: 10, alignContent: "start" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span style={{ ...microLabel, fontSize: 13, color: C.muted }}>{HORIZON_WORDS[horizon]}</span>
        <Pill color={o.confidence === "HIGH" ? C.green : o.confidence === "MEDIUM" ? C.blue : C.muted}>{CONFIDENCE_WORDS[o.confidence]}</Pill>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, color: LEAN_COLOR[o.lean] }}>
        <span aria-hidden style={{ fontSize: 26 }}>
          {lean.glyph}
        </span>
        <span style={{ fontSize: 26, fontWeight: 750, letterSpacing: "0.01em" }}>{lean.word.toUpperCase()}</span>
      </div>
      <div>
        <div className="tnum" style={{ fontSize: 16, fontWeight: 600, color: C.textStrong }}>
          {range ?? "Range: no data"}
        </div>
        {range && <div style={{ ...small, fontSize: 12.5 }}>Likely range (what option prices imply, not a forecast)</div>}
      </div>
      <Bullets items={top} style={{ fontSize: 15 }} />
      {rest.length > 0 && (
        <More label={`${rest.length} more reason${rest.length === 1 ? "" : "s"}`}>
          <Bullets items={rest} style={{ fontSize: 15 }} />
        </More>
      )}
    </div>
  );
}

export function OutlookSection({ report }: { report: AdvisorReport }) {
  const indices = INDICES.filter((i) => report.outlook.some((o) => o.index === i));
  if (!indices.length) return <Panel style={{ padding: 18, ...small }}>No outlook in this brief.</Panel>;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {indices.map((index) => {
        const level = index === "NIFTY" ? report.market.nifty : report.market.sensex;
        return (
          <Panel key={index} style={{ padding: "16px 16px 18px", display: "grid", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <h3 style={h3}>{index}</h3>
              {level != null && <span className="tnum" style={{ ...small, fontSize: 14.5 }}>at {fmtNum(level, 2)} when written</span>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
              {HORIZONS.map((h) => (
                <OutlookColumn key={h} horizon={h} o={report.outlook.find((o) => o.index === index && o.horizon === h)} />
              ))}
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Trade ideas
// ---------------------------------------------------------------------------

export function IdeaCard({ idea, isPick, nowMs, fallbackNow }: { idea: AdvisorIdea; isPick: boolean; nowMs: number | null; fallbackNow: number }) {
  const c = idea.contract;
  const lots = Math.max(1, idea.lots);
  const chance = chanceWords(idea.probItm);
  return (
    <Panel id={`idea-${idea.id}`} style={{ padding: "18px 16px", display: "grid", gap: 14, border: isPick ? `2px solid ${alpha(C.green, 0.45)}` : undefined }}>
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {isPick && <Pill color={C.green} solid>Today&apos;s pick</Pill>}
          <Pill color={c.optionType === "CE" ? C.green : C.red}>{c.optionType === "CE" ? "Call: gains if the index rises" : "Put: gains if the index falls"}</Pill>
          <Pill color={idea.confidence === "HIGH" ? C.green : idea.confidence === "MEDIUM" ? C.blue : C.muted}>{CONFIDENCE_WORDS[idea.confidence]}</Pill>
        </div>
        <h4 style={{ margin: 0, fontSize: 19, fontWeight: 700, lineHeight: 1.35, color: C.textStrong, overflowWrap: "anywhere" }}>{plainContract(c, nowMs ?? fallbackNow)}</h4>
        <div className="tnum" style={{ ...body, fontSize: 17, color: C.textStrong }}>
          Buy between <b>{premium(idea.entry.low)}</b> and <b>{premium(idea.entry.high)}</b> <span style={{ color: C.muted }}>(price when written {premium(idea.entry.ask)})</span>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Fact label="Stop (sell if it falls to)" value={premium(idea.stop)} color={C.red} />
        <Fact label="Target (take profit at)" value={premium(idea.target)} color={C.green} />
        <Fact label="Exit by" value={exitByWords(idea.exitBy, nowMs)} note="if neither is hit" />
      </div>
      <div>
        <div style={{ ...microLabel, color: C.muted, marginBottom: 6 }}>
          For {lots} lot{lots === 1 ? "" : "s"} ({c.lotSize * lots} units)
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Fact label="Cost" value={rupees(idea.costPerLot * lots)} note={idea.costPerLot * lots > CAPITAL ? "more than ₹10,000" : undefined} />
          <Fact label="Most you can lose (at the stop)" value={rupees(idea.maxLossPerLot * lots)} note="incl. charges; gaps can make it worse" color={C.red} />
          <Fact label="Gain at the target" value={rupees(idea.rewardPerLot * lots)} note="after charges" color={C.green} />
        </div>
      </div>
      <div style={{ ...body, fontSize: 15.5 }}>
        {chance ? (
          <>
            Chance it ends in the money at expiry <b>{chance}</b>: a rough market estimate from delta (how much the option moves for a 1-point move in the index).
            {idea.breakevenAtExpiry != null && (
              <>
                {" "}
                To end in profit {c.index} must be {c.optionType === "CE" ? "above" : "below"} <b className="tnum">{fmtNum(idea.breakevenAtExpiry, 0)}</b> at expiry (the break-even), so the chance of profit is lower.
              </>
            )}
          </>
        ) : (
          "Chance it ends in the money: no data."
        )}
        {idea.iv != null && <span style={{ color: C.muted }}> IV {idea.iv.toFixed(1)}% (implied volatility: the yearly swing this option&apos;s price assumes).</span>}
      </div>
      {idea.why.length > 0 && (
        <div>
          <div style={{ ...microLabel, color: C.muted, marginBottom: 6 }}>Why</div>
          <Bullets items={idea.why} />
        </div>
      )}
      <div style={{ background: alpha(C.red, 0.05), border: `1px solid ${alpha(C.red, 0.25)}`, borderRadius: 10, padding: "10px 12px", ...body, fontSize: 15.5 }}>
        <b style={{ color: C.red }}>Wrong if:</b> {idea.wrongIf}
      </div>
      <a href={chainHref(c)} className="link-quiet" style={{ color: C.gold, fontWeight: 600, fontSize: 15, textDecoration: "none", justifySelf: "start" }}>
        See it in the option chain →
      </a>
    </Panel>
  );
}

export function IdeasSection({ report, nowMs }: { report: AdvisorReport; nowMs: number | null }) {
  const groups = groupIdeas(report.ideas);
  const fallbackNow = Date.parse(report.createdAt);
  if (!groups.length)
    return (
      <Panel style={{ padding: "18px 18px", ...body }}>
        No trade ideas in this brief. When nothing is worth paying time decay for, the advisor says so: waiting is often the right call.
      </Panel>
    );
  return (
    <div style={{ display: "grid", gap: 22 }}>
      {groups.map((g) => (
        <div key={g.horizon} style={{ display: "grid", gap: 12 }}>
          <h3 style={h3}>{HORIZON_WORDS[g.horizon]}</h3>
          {g.ideas.map((idea) => (
            <IdeaCard key={idea.id} idea={idea} isPick={report.today.action === "BUY" && report.today.ideaId === idea.id} nowMs={nowMs} fallbackNow={fallbackNow} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. What's moving the market
// ---------------------------------------------------------------------------

export function FactorsSection({ factors }: { factors: AdvisorFactor[] }) {
  if (!factors.length) return <Panel style={{ padding: 18, ...small }}>No factors in this brief.</Panel>;
  return (
    <Panel>
      {sortFactors(factors).map((f, i) => {
        const meta = READING_META[f.reading];
        const color = READING_COLOR[f.reading];
        return (
          <div key={`${f.key}-${i}`} style={{ display: "grid", gridTemplateColumns: "34px minmax(0, 1fr)", gap: 12, padding: "14px 16px", borderTop: i ? `1px solid ${C.borderSoft}` : "none" }}>
            <span
              aria-hidden
              style={{ width: 34, height: 34, borderRadius: "50%", display: "grid", placeItems: "center", fontSize: 15, fontWeight: 800, color, background: alpha(color, 0.12), border: `1px solid ${alpha(color, 0.35)}` }}
            >
              {meta.glyph}
            </span>
            <div style={{ minWidth: 0, display: "grid", gap: 4 }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 10px" }}>
                <span style={{ fontSize: 16.5, fontWeight: 650, color: C.textStrong }}>{f.label}</span>
                <span style={{ fontSize: 13.5, fontWeight: 700, color }}>{meta.word}</span>
              </div>
              <div style={{ ...body, fontSize: 15.5, overflowWrap: "anywhere" }}>{f.detail}</div>
              {f.source && <div style={{ ...small, fontSize: 12.5 }}>Source: {f.source}</div>}
            </div>
          </div>
        );
      })}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 6–10. Premiums, zero-hero, also know, avoid, sources
// ---------------------------------------------------------------------------

export function PremiumCard({ premium: p }: { premium: AdvisorReport["premium"] }) {
  const color = PREMIUM_COLOR[p.verdict];
  return (
    <Panel style={{ padding: "18px 18px", display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 30, fontWeight: 800, color, lineHeight: 1 }}>{PREMIUM_WORDS[p.verdict]}</span>
        <span style={{ ...small }}>Premium = the price you pay for an option.</span>
      </div>
      <p style={{ margin: 0, ...body, overflowWrap: "anywhere" }}>{p.detail}</p>
    </Panel>
  );
}

export function ZeroHeroCard({ zeroHero }: { zeroHero: AdvisorReport["zeroHero"] }) {
  if (!zeroHero.applicable) {
    const extra = zeroHero.summary.replace(/^no expiry today\.?\s*/i, "");
    return (
      <Panel style={{ padding: "14px 18px", ...body }}>
        <b>No expiry today.</b>
        {extra && <span style={{ color: C.muted }}> {extra}</span>}
      </Panel>
    );
  }
  return (
    <Panel style={{ padding: "18px 18px", display: "grid", gap: 10, border: `1px solid ${alpha(C.orange, 0.4)}` }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Pill color={C.orange}>Expiry today</Pill>
        <Pill color={C.red}>Most expire worthless</Pill>
      </div>
      <p style={{ margin: 0, ...body, overflowWrap: "anywhere" }}>{zeroHero.summary}</p>
      <div style={{ ...small }}>Zero-hero: a far out-of-the-money option bought for a few rupees on its last day, hoping for a huge move. It is a lottery ticket, sized as one.</div>
    </Panel>
  );
}

export function NumberedList({ items, tone }: { items: readonly string[]; tone: "know" | "avoid" }) {
  if (!items.length) return <Panel style={{ padding: 18, ...small }}>Nothing in this brief.</Panel>;
  const color = tone === "avoid" ? C.red : C.gold;
  return (
    <Panel>
      {items.map((t, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "30px minmax(0, 1fr)", gap: 12, padding: "13px 16px", borderTop: i ? `1px solid ${C.borderSoft}` : "none", alignItems: "start" }}>
          <span
            aria-hidden
            style={{ width: 28, height: 28, borderRadius: "50%", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 800, color, background: alpha(color, 0.1), border: `1px solid ${alpha(color, 0.3)}` }}
          >
            {tone === "avoid" ? "✕" : i + 1}
          </span>
          <div style={{ ...body, fontSize: 16, overflowWrap: "anywhere" }}>{t}</div>
        </div>
      ))}
    </Panel>
  );
}

export function SourcesList({ sources }: { sources: AdvisorReport["sources"] }) {
  if (!sources.length) return <Panel style={{ padding: 18, ...small }}>No sources listed.</Panel>;
  return (
    <Panel style={{ padding: "8px 0" }}>
      {sources.map((s, i) => {
        const href = safeHref(s.url);
        const external = href != null && !href.startsWith("/");
        return (
          <div key={i} style={{ padding: "9px 16px", display: "grid", gap: 2, minWidth: 0 }}>
            {href ? (
              <a href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined} style={{ color: C.gold, fontSize: 15.5, fontWeight: 600, overflowWrap: "anywhere" }}>
                {s.title || s.url}
              </a>
            ) : (
              <span style={{ fontSize: 15.5, color: C.textSoft, overflowWrap: "anywhere" }}>{s.title || s.url}</span>
            )}
            <span style={{ ...small, fontSize: 12.5, overflowWrap: "anywhere" }}>{href ? sourceHost(href) : "link not shown (not a web address)"}</span>
          </div>
        );
      })}
    </Panel>
  );
}
