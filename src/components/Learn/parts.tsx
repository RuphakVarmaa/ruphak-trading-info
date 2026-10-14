/** Small building blocks for the /learn guide. Server-safe: no hooks, no browser APIs. */
import type { CSSProperties, ReactNode } from "react";
import { alpha, C } from "@/components/shared/colors";
import { SERIF } from "@/components/shared/theme";
import s from "./learn.module.css";

/** Where a figure comes from, in the research's own short tags (WP11, Q1, plan §13 …). */
export function Src({ children }: { children: ReactNode }) {
  return (
    <span style={{ display: "inline-block", fontSize: 11.5, fontWeight: 600, color: C.muted2, background: C.panelDeep, borderRadius: 6, padding: "1px 7px", marginLeft: 4, verticalAlign: "1px", maxWidth: "100%", boxSizing: "border-box" }}>
      {children}
    </span>
  );
}

/** A section of the guide: a number, a serif heading, a one-line lead and its content. */
export function GuideSection({ id, n, title, lead, children }: { id: string; n: number; title: ReactNode; lead?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} style={{ scrollMarginTop: 84, minWidth: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16 }}>
      <header style={{ display: "grid", gap: 8 }}>
        <div className="tnum" style={{ fontSize: 13, fontWeight: 600, color: C.gold, fontFamily: "var(--font-num)" }}>
          {String(n).padStart(2, "0")}
        </div>
        <h2 id={`${id}-h`} style={{ margin: 0, fontFamily: SERIF, fontSize: "clamp(25px, 2.8vw, 32px)", fontWeight: 500, lineHeight: 1.18, letterSpacing: "-0.015em", color: C.textStrong }}>
          {title}
        </h2>
        {lead != null && <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: C.textSoft, maxWidth: 720 }}>{lead}</p>}
      </header>
      {children}
    </section>
  );
}

export function Card({ children, style, tone }: { children: ReactNode; style?: CSSProperties; tone?: string }) {
  return (
    <div
      style={{
        background: tone ? alpha(tone, 0.06) : C.panel,
        border: `1px solid ${tone ? alpha(tone, 0.3) : C.border}`,
        borderRadius: 14,
        padding: "16px 18px",
        minWidth: 0,
        boxShadow: tone ? "none" : "var(--shadow-card)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children, color = C.textStrong }: { children: ReactNode; color?: string }) {
  return <div style={{ fontSize: 15, fontWeight: 650, color, marginBottom: 6, letterSpacing: "-0.005em" }}>{children}</div>;
}

export function P({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.62, color: C.text, ...style }}>{children}</p>;
}

/** A big figure with what it is and where it comes from. */
export function Fact({ value, label, src, color = C.textStrong }: { value: ReactNode; label: ReactNode; src?: ReactNode; color?: string }) {
  return (
    <Card>
      <div className="tnum" style={{ fontFamily: "var(--font-num)", fontSize: "clamp(24px, 2.6vw, 30px)", fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.1, color }}>
        {value}
      </div>
      <div style={{ fontSize: 13.5, color: C.textSoft, lineHeight: 1.5, marginTop: 8 }}>{label}</div>
      {src != null && <div style={{ marginTop: 8, marginLeft: -4 }}>{<Src>{src}</Src>}</div>}
    </Card>
  );
}

/** A coloured note: the takeaway of a section. */
export function Callout({ children, color = C.gold, title }: { children: ReactNode; color?: string; title?: ReactNode }) {
  return (
    <div role="note" style={{ borderLeft: `3px solid ${color}`, background: alpha(color, 0.07), borderRadius: "0 12px 12px 0", padding: "12px 16px", fontSize: 14.5, lineHeight: 1.6, color: C.text }}>
      {title != null && <div style={{ fontWeight: 700, color, marginBottom: 2 }}>{title}</div>}
      {children}
    </div>
  );
}

/** Bulleted points with a little more air than a plain list. */
export function Points({ items }: { items: ReactNode[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 8, fontSize: 14.5, lineHeight: 1.6, color: C.text }}>
      {items.map((it, i) => (
        <li key={i} style={{ paddingLeft: 2 }}>
          {it}
        </li>
      ))}
    </ul>
  );
}

export interface Bar {
  label: ReactNode;
  value: number;
  text: string;
  color?: string;
}

/**
 * Horizontal bars with the value written at the end of each bar (no axis to read). Values are drawn
 * against `max`; a negative value draws a short muted stub.
 */
export function Bars({ bars, max, caption, src }: { bars: Bar[]; max: number; caption: ReactNode; src: ReactNode }) {
  return (
    <figure style={{ margin: 0 }}>
      <Card>
        <figcaption style={{ fontSize: 13.5, fontWeight: 600, color: C.textStrong, marginBottom: 14, lineHeight: 1.45 }}>{caption}</figcaption>
        <div style={{ display: "grid", gap: 10 }}>
          {bars.map((b, i) => {
            const w = Math.max(0, Math.min(1, b.value / max));
            const color = b.color ?? C.goldBright;
            return (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(96px, 150px) minmax(0, 1fr)", gap: 12, alignItems: "center" }}>
                <div style={{ fontSize: 12.5, color: C.textSoft, lineHeight: 1.3 }}>{b.label}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <div style={{ height: 14, width: `${Math.max(w * 100, 1.5)}%`, maxWidth: "calc(100% - 64px)", background: b.value > 0 ? color : C.track, borderRadius: "0 4px 4px 0" }} />
                  <span className="tnum" style={{ fontSize: 12.5, fontWeight: 600, color: C.textStrong, fontFamily: "var(--font-num)", whiteSpace: "nowrap" }}>
                    {b.text}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 12, marginLeft: -4 }}>
          <Src>{src}</Src>
        </div>
      </Card>
    </figure>
  );
}

/** Rows of three cells (term, what it tells you, what it does not) that stack on phones. */
export function DefTable({ head, rows }: { head: [string, string, string]; rows: [ReactNode, ReactNode, ReactNode][] }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, overflow: "hidden", boxShadow: "var(--shadow-card)" }}>
      <div className={`${s.defRow} ${s.defHead}`}>
        {head.map((h) => (
          <div key={h}>{h}</div>
        ))}
      </div>
      {rows.map((r, i) => (
        <div key={i} className={s.defRow} style={{ fontSize: 14, lineHeight: 1.55, color: C.text }}>
          <div style={{ fontWeight: 650, color: C.textStrong }}>{r[0]}</div>
          <div>
            <span className={s.cellLabel}>{head[1]}</span>
            {r[1]}
          </div>
          <div style={{ color: C.textSoft }}>
            <span className={s.cellLabel}>{head[2]}</span>
            {r[2]}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A rule badge: N1 … N9, or an action word. */
export function Tag({ children, color = C.gold, solid = false }: { children: ReactNode; color?: string; solid?: boolean }) {
  return (
    <span
      className="tnum"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 30,
        padding: "2px 8px",
        borderRadius: 7,
        fontSize: 12,
        fontWeight: 700,
        fontFamily: "var(--font-num)",
        letterSpacing: "0.02em",
        color: solid ? "#fff" : color,
        background: solid ? color : alpha(color, 0.1),
        border: `1px solid ${solid ? color : alpha(color, 0.35)}`,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export const linkStyle: CSSProperties = { color: C.gold, fontWeight: 600, textDecoration: "none" };
