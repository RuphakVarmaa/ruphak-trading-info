"use client";

/** Small inline-styled primitives for the light dashboard theme (no icon libraries). */
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode, type Ref } from "react";
import { alpha, C } from "./colors";
import { SERIF } from "./theme";

export const mono: CSSProperties = { fontFamily: "var(--font-num)", fontVariantNumeric: "tabular-nums" };

/** A small sentence-case label above a value or a group. */
export const microLabel: CSSProperties = {
  fontSize: 12,
  color: C.muted2,
  fontWeight: 600,
};

export function Pill({
  color,
  children,
  solid = false,
  title,
  style,
}: {
  color: string;
  children: ReactNode;
  solid?: boolean;
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        lineHeight: 1.5,
        whiteSpace: "nowrap",
        color: solid ? "#fff" : color,
        background: solid ? color : alpha(color, 0.1),
        border: `1px solid ${solid ? color : alpha(color, 0.32)}`,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export function Dot({ color, size = 6, pulse = false, title }: { color: string; size?: number; pulse?: boolean; title?: string }) {
  return (
    <span
      title={title}
      aria-hidden={title ? undefined : true}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        display: "inline-block",
        flexShrink: 0,
        animation: pulse ? "pulse-ring 2s infinite ease-out" : undefined,
      }}
    />
  );
}

export function Panel({ children, style, id }: { children: ReactNode; style?: CSSProperties; id?: string }) {
  return (
    <div id={id} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, overflow: "hidden", boxShadow: "var(--shadow-card)", ...style }}>
      {children}
    </div>
  );
}

/** The page title block: an optional eyebrow, a large serif heading, a lead paragraph and actions. */
export function PageHeader({ eyebrow, title, sub, right, children }: { eyebrow?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; children?: ReactNode }) {
  return (
    <header style={{ display: "grid", gap: 18, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
        <div style={{ minWidth: 0, maxWidth: 820 }}>
          {eyebrow != null && <div style={{ fontSize: 13, fontWeight: 600, color: C.gold, marginBottom: 10 }}>{eyebrow}</div>}
          <h1 style={{ margin: 0, fontFamily: SERIF, fontSize: "clamp(32px, 4.4vw, 46px)", fontWeight: 500, lineHeight: 1.08, letterSpacing: "-0.02em", color: C.textStrong }}>{title}</h1>
          {sub != null && <p style={{ margin: "12px 0 0", fontSize: 16, lineHeight: 1.6, color: C.muted }}>{sub}</p>}
        </div>
        {right != null && <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>{right}</div>}
      </div>
      {children}
    </header>
  );
}

/** A page section: a serif heading, an optional note, optional actions on the right, and content. */
export function Section({ id, title, sub, right, children }: { id?: string; title: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} style={{ scrollMarginTop: 84, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "8px 16px", flexWrap: "wrap", marginBottom: 16 }}>
        <div style={{ minWidth: 0, maxWidth: 780 }}>
          <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: "clamp(23px, 2.5vw, 29px)", fontWeight: 500, lineHeight: 1.2, letterSpacing: "-0.012em", color: C.textStrong }}>{title}</h2>
          {sub != null && <p style={{ margin: "6px 0 0", fontSize: 14, color: C.muted, lineHeight: 1.55 }}>{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

/** A small set of mutually exclusive options shown as one pill row. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = "md",
}: {
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: "inline-flex", flexWrap: "wrap", gap: 2, padding: 3, background: C.panelDeep, border: `1px solid ${C.border}`, borderRadius: 11 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            style={{
              border: "none",
              borderRadius: 8,
              padding: size === "sm" ? "5px 11px" : "7px 14px",
              fontSize: size === "sm" ? 12 : 13,
              fontWeight: on ? 600 : 500,
              cursor: "pointer",
              background: on ? C.panel : "transparent",
              color: on ? C.textStrong : C.muted,
              boxShadow: on ? "0 1px 2px rgba(20,20,19,0.12)" : "none",
              whiteSpace: "nowrap",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function PanelHeader({ icon, title, right, live }: { icon?: ReactNode; title: ReactNode; right?: ReactNode; live?: boolean }) {
  return (
    <div
      style={{
        minHeight: 52,
        borderBottom: `1px solid ${C.border}`,
        padding: "12px 18px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "6px 10px",
        flexShrink: 0,
      }}
    >
      {icon != null && <span style={{ color: C.gold, fontSize: 15 }}>{icon}</span>}
      <span style={{ whiteSpace: "nowrap", fontSize: 15.5, fontWeight: 600, color: C.textStrong, letterSpacing: "-0.005em" }}>{title}</span>
      {live && (
        <span style={{ color: C.green, fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}>
          <Dot color={C.green} pulse /> Live
        </span>
      )}
      {right != null && <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.muted2 }}>{right}</div>}
    </div>
  );
}

export function SectionHeader({ label, title, sub, right }: { label: string; title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 20 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: C.gold, fontWeight: 600 }}>{label}</span>
        </div>
        <h2 style={{ margin: "0 0 6px", fontSize: "clamp(23px, 2.5vw, 29px)", fontWeight: 500, color: C.textStrong, fontFamily: SERIF, letterSpacing: "-0.012em", lineHeight: 1.2 }}>
          {title}
        </h2>
        {sub != null && <p style={{ margin: 0, fontSize: 14, color: C.muted, lineHeight: 1.55 }}>{sub}</p>}
      </div>
      {right}
    </div>
  );
}

/** "GEOPOLITICS" -> "Geopolitics"; labels that are not all capitals are kept as they are. */
export function prettyEnum(s: string): string {
  return /^[A-Z0-9 _&/-]+$/.test(s) ? (s.charAt(0) + s.slice(1).toLowerCase()).replace(/_/g, " ") : s;
}

export function TabBar<T extends string>({
  tabs,
  active,
  onChange,
  counts,
  label,
}: {
  tabs: readonly T[];
  active: T;
  onChange: (tab: T) => void;
  counts?: Partial<Record<T, number>>;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
        padding: "10px 14px",
        borderBottom: `1px solid ${C.border}`,
        flexShrink: 0,
      }}
    >
      {tabs.map((tab) => {
        const selected = tab === active;
        const count = counts?.[tab];
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab)}
            style={{
              background: selected ? C.panelDeep : "transparent",
              color: selected ? C.textStrong : C.muted,
              border: "none",
              padding: "6px 12px",
              borderRadius: 999,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: selected ? 600 : 500,
              transition: "background 0.15s, color 0.15s",
            }}
          >
            {prettyEnum(tab)}
            {count != null && count > 0 && <span style={{ color: selected ? C.gold : C.muted3, marginLeft: 6, fontSize: 12, fontWeight: 600 }}>{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function StatTile({
  label,
  value,
  sub,
  color = C.textStrong,
  hero = false,
  title,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  color?: string;
  hero?: boolean;
  title?: string;
}) {
  return (
    <div
      title={title}
      style={{
        background: C.panel,
        border: `1px solid ${hero ? alpha(C.gold, 0.4) : C.border}`,
        borderRadius: 14,
        padding: hero ? "18px 20px" : "16px 18px",
        minWidth: 0,
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 8, fontWeight: 500 }}>{label}</div>
      {/* Figures are never cut off: the size steps down on narrow tiles and, as a last resort, the figure wraps. */}
      <div
        className="tnum"
        style={{
          fontSize: hero ? "clamp(22px, 2.4vw, 30px)" : "clamp(18px, 1.9vw, 23px)",
          fontWeight: 600,
          color,
          fontFamily: "var(--font-num)",
          letterSpacing: "-0.02em",
          lineHeight: 1.15,
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </div>
      {sub != null && <div style={{ fontSize: 12, color: C.muted2, marginTop: 6, lineHeight: 1.45 }}>{sub}</div>}
    </div>
  );
}

/**
 * A collapsed card for secondary material: the summary row is its header (an H2 with an optional
 * note); the content renders only once it has been opened, and stays mounted after that.
 */
export function Disclosure({
  id,
  title,
  note,
  defaultOpen = false,
  children,
}: {
  id?: string;
  title: ReactNode;
  note?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [opened, setOpened] = useState(defaultOpen);
  const ref = useRef<HTMLDetailsElement>(null);
  // A link to the disclosure (#id) opens it.
  useEffect(() => {
    if (!id) return;
    const openIfTarget = () => {
      if (window.location.hash === `#${id}` && ref.current) ref.current.open = true;
    };
    openIfTarget();
    window.addEventListener("hashchange", openIfTarget);
    return () => window.removeEventListener("hashchange", openIfTarget);
  }, [id]);
  return (
    <details
      ref={ref}
      id={id}
      className="card-disclosure"
      open={defaultOpen || undefined}
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) setOpened(true);
      }}
      style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, boxShadow: "var(--shadow-card)", scrollMarginTop: 84, minWidth: 0 }}
    >
      <summary>
        <h2 style={{ display: "inline", margin: 0, fontFamily: SERIF, fontSize: "clamp(20px, 2.2vw, 24px)", fontWeight: 500, letterSpacing: "-0.01em", color: C.textStrong }}>{title}</h2>
        {note != null && <span style={{ fontSize: 13.5, color: C.muted2 }}>{note}</span>}
      </summary>
      {opened && <div style={{ padding: 18, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 20, minWidth: 0 }}>{children}</div>}
    </details>
  );
}

type BtnVariant = "gold" | "outline" | "danger" | "dangerSolid" | "ghost";

const BTN_STYLES: Record<BtnVariant, CSSProperties> = {
  gold: { background: C.gold, color: "#fff", border: `1px solid ${C.gold}` },
  outline: { background: C.panel, color: C.textStrong, border: `1px solid ${C.borderStrong}` },
  danger: { background: alpha(C.red, 0.08), color: C.red, border: `1px solid ${alpha(C.red, 0.45)}` },
  dangerSolid: { background: C.red, color: "#fff", border: `1px solid ${C.red}` },
  ghost: { background: "transparent", color: C.muted, border: "1px solid transparent" },
};

export function Btn({
  variant = "outline",
  size = "sm",
  style,
  children,
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md"; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      style={{
        ...BTN_STYLES[variant],
        padding: size === "md" ? "10px 18px" : "6px 12px",
        borderRadius: size === "md" ? 10 : 8,
        fontSize: size === "md" ? 14 : 12.5,
        fontWeight: 600,
        cursor: rest.disabled ? "not-allowed" : "pointer",
        opacity: rest.disabled ? 0.45 : 1,
        whiteSpace: "nowrap",
        lineHeight: 1.3,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function Skeleton({ width = "100%", height = 12, style }: { width?: number | string; height?: number | string; style?: CSSProperties }) {
  return (
    <div
      aria-hidden
      style={{
        width,
        height,
        borderRadius: 6,
        background: C.borderSoft,
        animation: "skeleton-pulse 1.4s ease-in-out infinite",
        ...style,
      }}
    />
  );
}

export function EmptyState({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ textAlign: "center", color: C.muted2, fontSize: 13.5, padding: "32px 16px", lineHeight: 1.55, ...style }}>{children}</div>;
}

export const inputStyle: CSSProperties = {
  width: "100%",
  background: C.panel,
  border: `1px solid ${C.borderStrong}`,
  borderRadius: 10,
  color: C.textStrong,
  padding: "10px 12px",
  fontSize: 14,
  boxSizing: "border-box",
};

/**
 * Confirmation on a native <dialog> (focus trap, Esc, backdrop for free). Mount it only
 * while open: each open starts with a fresh typed-confirmation field.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  tone = "gold",
  requireText,
  busy = false,
  error,
  onConfirm,
  onCancel,
  extra,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: "gold" | "danger";
  /** User must type this exactly (e.g. "LIVE") before confirming. */
  requireText?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  extra?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
    };
  }, []);

  const blocked = busy || (requireText != null && typed.trim() !== requireText);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      style={{
        background: C.panel,
        color: C.text,
        border: `1px solid ${tone === "danger" ? alpha(C.red, 0.6) : C.borderStrong}`,
        borderRadius: 16,
        padding: 0,
        // Tailwind's preflight zeroes margins; modal dialogs need margin:auto to centre.
        margin: "auto",
        width: "min(460px, calc(100vw - 32px))",
        maxHeight: "calc(100vh - 32px)",
        overflowY: "auto",
        boxShadow: "var(--shadow-pop)",
      }}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked) onConfirm();
        }}
      >
        <div
          id={titleId}
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${C.border}`,
            fontSize: 20,
            fontWeight: 500,
            fontFamily: SERIF,
            color: tone === "danger" ? C.red : C.textStrong,
          }}
        >
          {tone === "danger" ? "⚠ " : ""}
          {title}
        </div>
        <div style={{ padding: "16px 20px", fontSize: 13.5, lineHeight: 1.6, color: C.textSoft, display: "flex", flexDirection: "column", gap: 12 }}>
          {children}
          {extra}
          {requireText != null && (
            <div>
              <label htmlFor={inputId} style={{ ...microLabel, display: "block", marginBottom: 6, color: C.muted }}>
                Type <span style={{ color: C.red, fontFamily: "var(--font-num)" }}>{requireText}</span> to confirm
              </label>
              <input
                id={inputId}
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                style={{ ...inputStyle, fontFamily: "var(--font-num)", letterSpacing: "0.1em" }}
              />
            </div>
          )}
          {error && (
            <div role="alert" style={{ color: C.red, fontSize: 11 }}>
              ✗ {error}
            </div>
          )}
        </div>
        <div style={{ padding: "14px 20px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <Btn variant="outline" size="md" onClick={onCancel} disabled={busy}>
            Cancel
          </Btn>
          <Btn type="submit" variant={tone === "danger" ? "dangerSolid" : "gold"} size="md" disabled={blocked}>
            {busy ? "Working…" : confirmLabel}
          </Btn>
        </div>
      </form>
    </dialog>
  );
}

// ---------------------------------------------------------------------------
// Tables (same look as the stack tracker table)
// ---------------------------------------------------------------------------

export const tableWrap: CSSProperties = { border: `1px solid ${C.border}`, borderRadius: 14, overflowX: "auto", background: C.panel, boxShadow: "var(--shadow-card)" };
export const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
export const theadRow: CSSProperties = { background: C.panelAlt, color: C.muted, fontSize: 12 };
export const th: CSSProperties = { padding: "11px 16px", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" };
export const thNum: CSSProperties = { ...th, textAlign: "right" };
export const td: CSSProperties = { padding: "11px 16px", borderTop: `1px solid ${C.borderSoft}`, color: C.textSoft, whiteSpace: "nowrap" };
export const tdNum: CSSProperties = { ...td, textAlign: "right", fontFamily: "var(--font-num)", fontVariantNumeric: "tabular-nums", color: C.textStrong };
