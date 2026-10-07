"use client";

/** Small inline-styled primitives matching the terminal look (no icon libraries). */
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode, type Ref } from "react";
import { alpha, C } from "./colors";

export const mono: CSSProperties = { fontFamily: "monospace", fontVariantNumeric: "tabular-nums" };

export const microLabel: CSSProperties = {
  fontSize: 9,
  color: C.muted2,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontWeight: 700,
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
        padding: "2px 7px",
        borderRadius: 3,
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        color: solid ? (color === C.gold ? "#000" : "#fff") : color,
        background: solid ? color : alpha(color, 0.12),
        border: `1px solid ${solid ? color : alpha(color, 0.45)}`,
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

export function Panel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", ...style }}>{children}</div>;
}

export function PanelHeader({ icon, title, right, live }: { icon?: ReactNode; title: ReactNode; right?: ReactNode; live?: boolean }) {
  return (
    <div
      style={{
        minHeight: 40,
        borderBottom: `1px solid ${C.border}`,
        padding: "6px 14px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "4px 8px",
        fontSize: 11,
        letterSpacing: "0.08em",
        fontWeight: 700,
        textTransform: "uppercase",
        flexShrink: 0,
      }}
    >
      {icon != null && <span style={{ color: C.gold }}>{icon}</span>}
      <span style={{ whiteSpace: "nowrap" }}>{title}</span>
      {live && (
        <span style={{ color: C.green, fontSize: 10, display: "flex", alignItems: "center", gap: 4 }}>
          <Dot color={C.green} pulse /> LIVE
        </span>
      )}
      {right != null && <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>{right}</div>}
    </div>
  );
}

export function SectionHeader({ label, title, sub, right }: { label: string; title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 20 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ marginBottom: 6 }}>
          <span style={{ fontSize: 10, color: C.gold, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</span>
        </div>
        <h3 style={{ margin: "0 0 6px", fontSize: 26, fontWeight: 400, color: "#e0e0e0", fontFamily: "var(--font-playfair), 'Playfair Display', Georgia, serif" }}>
          {title}
        </h3>
        {sub != null && <p style={{ margin: 0, fontSize: 13, color: C.muted2 }}>{sub}</p>}
      </div>
      {right}
    </div>
  );
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
        gap: 2,
        padding: "6px 8px",
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
              background: selected ? "#2a2a2a" : "transparent",
              color: selected ? "#fff" : "#777",
              border: "none",
              padding: "5px 8px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.04em",
              transition: "all 0.15s",
            }}
          >
            {tab}
            {count != null && count > 0 && <span style={{ color: selected ? C.gold : C.muted3, marginLeft: 4 }}>{count}</span>}
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
        border: `1px solid ${hero ? alpha(C.gold, 0.35) : C.border}`,
        borderRadius: 8,
        padding: hero ? "16px 18px" : 16,
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 9, color: C.muted2, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, fontWeight: 700 }}>{label}</div>
      <div
        className="tnum"
        style={{
          fontSize: hero ? 26 : 20,
          fontWeight: 700,
          color,
          fontFamily: "monospace",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {value}
      </div>
      {sub != null && <div style={{ fontSize: 10, color: C.muted2, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

type BtnVariant = "gold" | "outline" | "danger" | "dangerSolid" | "ghost";

const BTN_STYLES: Record<BtnVariant, CSSProperties> = {
  gold: { background: C.gold, color: "#000", border: `1px solid ${C.gold}` },
  outline: { background: "transparent", color: C.textSoft, border: "1px solid #3a3a3a" },
  danger: { background: alpha(C.red, 0.12), color: "#ff6b5e", border: `1px solid ${alpha(C.red, 0.55)}` },
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
        padding: size === "md" ? "8px 18px" : "5px 10px",
        borderRadius: size === "md" ? 6 : 4,
        fontSize: size === "md" ? 12 : 10,
        fontWeight: 700,
        letterSpacing: "0.05em",
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
        borderRadius: 3,
        background: "#1a1a1a",
        animation: "skeleton-pulse 1.4s ease-in-out infinite",
        ...style,
      }}
    />
  );
}

export function EmptyState({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ textAlign: "center", color: C.muted3, fontSize: 12, padding: "28px 12px", ...style }}>{children}</div>;
}

export const inputStyle: CSSProperties = {
  colorScheme: "dark",
  width: "100%",
  background: "#1a1a1a",
  border: "1px solid #333",
  borderRadius: 4,
  color: C.textStrong,
  padding: "8px",
  fontSize: 12,
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
        borderRadius: 10,
        padding: 0,
        // Tailwind's preflight zeroes margins; modal dialogs need margin:auto to centre.
        margin: "auto",
        width: "min(460px, calc(100vw - 32px))",
        maxHeight: "calc(100vh - 32px)",
        overflowY: "auto",
        boxShadow: "0 12px 60px rgba(0,0,0,0.7)",
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
            padding: "14px 18px",
            borderBottom: `1px solid ${C.border}`,
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: tone === "danger" ? C.red : C.gold,
          }}
        >
          {tone === "danger" ? "⚠ " : ""}
          {title}
        </div>
        <div style={{ padding: "16px 18px", fontSize: 12, lineHeight: 1.6, color: C.textSoft, display: "flex", flexDirection: "column", gap: 12 }}>
          {children}
          {extra}
          {requireText != null && (
            <div>
              <label htmlFor={inputId} style={{ ...microLabel, display: "block", marginBottom: 6, color: C.muted }}>
                Type <span style={{ color: C.red, fontFamily: "monospace" }}>{requireText}</span> to confirm
              </label>
              <input
                id={inputId}
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                style={{ ...inputStyle, fontFamily: "monospace", letterSpacing: "0.1em" }}
              />
            </div>
          )}
          {error && (
            <div role="alert" style={{ color: C.red, fontSize: 11 }}>
              ✗ {error}
            </div>
          )}
        </div>
        <div style={{ padding: "12px 18px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end", gap: 10 }}>
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

export const tableWrap: CSSProperties = { border: `1px solid ${C.border}`, borderRadius: 8, overflowX: "auto", background: C.panel };
export const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 11 };
export const theadRow: CSSProperties = { background: "#151515", color: C.muted, textTransform: "uppercase", fontSize: 9, letterSpacing: "0.06em" };
export const th: CSSProperties = { padding: "10px 12px", textAlign: "left", fontWeight: 700, whiteSpace: "nowrap" };
export const thNum: CSSProperties = { ...th, textAlign: "right" };
export const td: CSSProperties = { padding: "8px 12px", borderTop: `1px solid ${C.borderSoft}`, color: C.textSoft, whiteSpace: "nowrap" };
export const tdNum: CSSProperties = { ...td, textAlign: "right", fontFamily: "monospace", fontVariantNumeric: "tabular-nums", color: C.textStrong };
