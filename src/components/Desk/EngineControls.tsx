"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { EngineMode } from "@/engine/api-types";
import { useEngineState, useNow, type ActionResult } from "@/hooks/useEngineState";
import { alpha, C } from "@/components/shared/colors";
import { fmtCountdown, fmtInr, fmtIstHm } from "@/components/shared/format";
import { ModeBadge } from "@/components/shared/SiteHeader";
import { Btn, ConfirmDialog, inputStyle, microLabel, Skeleton } from "@/components/shared/ui";

type DialogKind = "arm" | "kill" | "reset" | "mode" | null;

function Meter({
  label,
  used,
  cap,
  format,
  title,
  fullIsNormal = false,
}: {
  label: string;
  used: number;
  cap: number;
  format: (n: number) => string;
  title: string;
  /** At-cap is an expected state (e.g. holding the one allowed position), not an alarm. */
  fullIsNormal?: boolean;
}) {
  const frac = cap > 0 ? Math.min(1, used / cap) : 0;
  const atCap = cap > 0 && used >= cap;
  const full = atCap && !fullIsNormal;
  const color = full ? C.red : atCap ? C.gold : frac >= 0.75 ? C.orange : C.green;
  return (
    <div title={title} style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 96 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 9, fontFamily: "monospace", whiteSpace: "nowrap" }}>
        <span style={{ color: C.muted2, letterSpacing: "0.08em", fontWeight: 700 }}>{label}</span>
        <span className="tnum" style={{ color: full ? C.red : C.textDim }}>
          {full ? "⚠ " : ""}
          {format(used)}/{format(cap)}
        </span>
      </div>
      <div style={{ height: 3, background: C.border, borderRadius: 2 }} role="presentation">
        <div style={{ width: `${frac * 100}%`, height: "100%", background: color, borderRadius: 2, transition: "width 0.4s" }} />
      </div>
    </div>
  );
}

function ArmedCountdown({ until }: { until: string }) {
  const now = useNow();
  const left = now == null ? null : Date.parse(until) - now;
  return (
    <span className="tnum" style={{ fontFamily: "monospace" }}>
      {left == null ? "—" : fmtCountdown(left)}
    </span>
  );
}

function AdminTokenPopover() {
  const { admin, actions } = useEngineState();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close when clicking anywhere outside the popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await actions.setAdminToken(value);
    setBusy(false);
    if (res.ok) {
      setValue("");
      setOpen(false);
      buttonRef.current?.focus();
    } else {
      setError(res.code === "UNAUTHORIZED" ? "Token rejected." : res.error);
    }
  };

  const status = admin.verified ? "✓" : admin.verifying ? "…" : admin.token ? "✗" : "";
  const statusColor = admin.verified ? C.green : admin.token && !admin.verifying ? C.red : C.muted;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <Btn
        ref={buttonRef}
        variant="outline"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        title={admin.verified ? "Admin token verified for this tab" : "Enter the admin token to enable controls"}
        style={{ borderColor: admin.verified ? alpha(C.green, 0.5) : "#3a3a3a" }}
      >
        <span aria-hidden>🔑</span> ADMIN{" "}
        {status && (
          <span style={{ color: statusColor }} aria-label={admin.verified ? "verified" : "not verified"}>
            {status}
          </span>
        )}
      </Btn>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Admin token"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              buttonRef.current?.focus();
            }
          }}
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 8px)",
            zIndex: 50,
            width: 280,
            background: C.panel,
            border: `1px solid ${C.borderStrong}`,
            borderRadius: 8,
            boxShadow: "0 8px 30px rgba(0,0,0,0.6)",
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 11, color: C.textSoft, lineHeight: 1.5 }}>
            {admin.verified
              ? "Admin controls are enabled in this tab. The token is kept in session storage until the tab closes."
              : "Arm, kill switch, mode and backtests need the admin token. It is kept in this tab's session storage only."}
          </div>
          {!admin.verified && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
              style={{ display: "flex", flexDirection: "column", gap: 8 }}
            >
              <label htmlFor={inputId} style={{ ...microLabel }}>
                Admin token
              </label>
              <input
                id={inputId}
                type="password"
                autoComplete="off"
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                style={inputStyle}
              />
              {(error || admin.error) && (
                <div role="alert" style={{ fontSize: 10, color: C.red }}>
                  ✗ {error ?? admin.error}
                </div>
              )}
              <Btn type="submit" variant="gold" disabled={busy || !value.trim()}>
                {busy ? "Verifying…" : "Verify token"}
              </Btn>
            </form>
          )}
          {admin.token && (
            <Btn
              variant="ghost"
              onClick={() => {
                actions.clearAdminToken();
                setOpen(false);
              }}
            >
              Forget token
            </Btn>
          )}
        </div>
      )}
    </div>
  );
}

function Divider() {
  return <span aria-hidden style={{ width: 1, alignSelf: "stretch", background: C.border, margin: "2px 2px" }} />;
}

export default function EngineControls() {
  const { state, admin, status, pending, actions, positions } = useEngineState();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [squareOff, setSquareOff] = useState(true);
  const [reason, setReason] = useState("");
  const [targetMode, setTargetMode] = useState<EngineMode>("PAPER");

  const offline = status === "offline" || state == null;
  const canAdmin = admin.verified && !offline && pending == null;
  const disabledTitle = !admin.verified ? "Enter the admin token (🔑 ADMIN) to enable" : offline ? "Engine offline" : undefined;

  const open = (kind: DialogKind) => {
    setDialogError(null);
    if (kind === "kill") {
      setSquareOff(true);
      setReason("");
    }
    if (kind === "mode" && state) setTargetMode(state.mode === "LIVE" ? "PAPER" : "LIVE");
    setDialog(kind);
  };

  const run = async (fn: () => Promise<ActionResult>) => {
    setDialogError(null);
    const res = await fn();
    if (res.ok) setDialog(null);
    else setDialogError(res.error);
  };

  const openPositions = positions?.length ?? state?.caps.openPositions ?? 0;
  const live = state?.mode === "LIVE";

  let dialogEl: ReactNode = null;
  if (dialog === "arm" && state) {
    dialogEl = (
      <ConfirmDialog
        title={live ? "Arm LIVE trading" : "Arm the engine"}
        tone={live ? "danger" : "gold"}
        requireText={live ? "LIVE" : undefined}
        confirmLabel={live ? "ARM LIVE" : "ARM"}
        busy={pending === "arm"}
        error={dialogError}
        onCancel={() => setDialog(null)}
        onConfirm={() => void run(actions.arm)}
      >
        {live ? (
          <>
            <p style={{ margin: 0 }}>
              Arming in <strong style={{ color: C.red }}>LIVE</strong> mode lets the engine send real orders to Groww until the session closes (15:30 IST),
              provided the Worker key <code>LIVE_TRADING</code> is on ({state.liveTradingEnabled ? "✓ on" : "✗ off: orders stay simulated"}) and the order relay is healthy.
            </p>
            <p style={{ margin: 0, color: C.textDim }}>
              Index options can lose the entire premium within minutes. Caps: daily loss {fmtInr(state.caps.dailyLossCap)}, {state.caps.maxPositions} open position(s),{" "}
              {state.caps.maxOrdersPerDay} orders/day.
            </p>
          </>
        ) : (
          <p style={{ margin: 0 }}>
            The engine is in <strong style={{ color: C.blue }}>PAPER</strong> mode, so every order stays simulated. Arming is the third of the three keys a live order
            needs; it expires at the session close (15:30 IST).
          </p>
        )}
      </ConfirmDialog>
    );
  } else if (dialog === "kill" && state) {
    dialogEl = (
      <ConfirmDialog
        title="Engage kill switch"
        tone="danger"
        confirmLabel="ENGAGE KILL SWITCH"
        busy={pending === "kill"}
        error={dialogError}
        onCancel={() => setDialog(null)}
        onConfirm={() => void run(() => actions.kill(squareOff, reason))}
        extra={
          <>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.textSoft, cursor: "pointer" }}>
              <input type="checkbox" checked={squareOff} onChange={(e) => setSquareOff(e.target.checked)} />
              Square off open positions at market ({openPositions} open)
            </label>
            <div>
              <label htmlFor="kill-reason" style={{ ...microLabel, display: "block", marginBottom: 6, color: C.muted }}>
                Reason (audit log)
              </label>
              <input
                id="kill-reason"
                value={reason}
                maxLength={200}
                placeholder="e.g. abnormal fills, news shock"
                onChange={(e) => setReason(e.target.value)}
                style={inputStyle}
              />
            </div>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          Blocks every new entry immediately, disarms the engine and keeps it <strong style={{ color: C.red }}>KILLED</strong> until a human resets it.
        </p>
      </ConfirmDialog>
    );
  } else if (dialog === "reset" && state) {
    dialogEl = (
      <ConfirmDialog
        title="Reset kill switch"
        confirmLabel="RESET"
        busy={pending === "reset"}
        error={dialogError}
        onCancel={() => setDialog(null)}
        onConfirm={() => void run(actions.resetKill)}
      >
        <p style={{ margin: 0 }}>
          New entries resume on the next tick when every gate passes. The engine stays disarmed.
          {state.killReason && (
            <>
              {" "}
              Kill reason: <em style={{ color: C.textDim }}>{state.killReason}</em>
            </>
          )}
        </p>
      </ConfirmDialog>
    );
  } else if (dialog === "mode" && state) {
    const toLive = targetMode === "LIVE";
    dialogEl = (
      <ConfirmDialog
        title={toLive ? "Switch to LIVE mode" : "Switch to PAPER mode"}
        tone={toLive ? "danger" : "gold"}
        requireText={toLive ? "LIVE" : undefined}
        confirmLabel={toLive ? "SWITCH TO LIVE" : "SWITCH TO PAPER"}
        busy={pending === "mode"}
        error={dialogError}
        onCancel={() => setDialog(null)}
        onConfirm={() => void run(() => actions.setMode(targetMode))}
      >
        {toLive ? (
          <>
            <p style={{ margin: 0 }}>
              LIVE mode is one of three keys for real orders: the Worker var <code>LIVE_TRADING</code> ({state.liveTradingEnabled ? "✓ on" : "✗ off"}), mode LIVE, and an
              ARM that expires at 15:30 IST. Switching disarms the engine.
            </p>
            <p style={{ margin: 0, color: C.textDim }}>
              Real money is at risk: options can lose the entire premium. This dashboard is not investment advice and its author is not a SEBI-registered adviser.
            </p>
          </>
        ) : (
          <p style={{ margin: 0 }}>All new orders will be simulated on live quotes. Switching disarms the engine; open positions are unaffected.</p>
        )}
      </ConfirmDialog>
    );
  }

  return (
    <div
      className="controls-bar"
      style={{
        minHeight: 46,
        borderBottom: `1px solid ${C.border}`,
        background: C.panelAlt,
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "8px 14px",
        padding: "8px 14px",
      }}
    >
      <span style={{ color: C.gold, fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", fontFamily: "monospace", whiteSpace: "nowrap" }}>
        ⚡ INDIA INDEX DESK
      </span>
      <Divider />
      {state ? (
        <>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <ModeBadge mode={state.mode} />
            <span
              title="Worker var LIVE_TRADING: the first of three keys for a live order"
              style={{ fontSize: 9, fontFamily: "monospace", color: state.liveTradingEnabled ? C.orange : C.muted3, whiteSpace: "nowrap" }}
            >
              LIVE KEY {state.liveTradingEnabled ? "✓ ON" : "✗ OFF"}
            </span>
            <Btn variant="ghost" disabled={!canAdmin} title={disabledTitle ?? "Switch PAPER / LIVE"} onClick={() => open("mode")}>
              MODE ▾
            </Btn>
          </span>
          <Divider />
          {state.armed && state.armedUntil ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span
                title={`Armed until ${fmtIstHm(state.armedUntil)} IST`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 9px",
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 800,
                  letterSpacing: "0.08em",
                  color: "#000",
                  background: C.gold,
                  whiteSpace: "nowrap",
                }}
              >
                ◉ ARMED · <ArmedCountdown until={state.armedUntil} />
              </span>
              <Btn variant="outline" disabled={!canAdmin} title={disabledTitle} onClick={() => void actions.disarm()}>
                DISARM
              </Btn>
            </span>
          ) : (
            <Btn variant="outline" disabled={!canAdmin || state.killSwitch} title={state.killSwitch ? "Reset the kill switch first" : disabledTitle} onClick={() => open("arm")}>
              ○ ARM
            </Btn>
          )}
          {state.killSwitch ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span
                title={state.killReason ?? "Kill switch engaged"}
                style={{
                  padding: "4px 9px",
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 800,
                  letterSpacing: "0.08em",
                  color: "#fff",
                  background: C.red,
                  whiteSpace: "nowrap",
                  maxWidth: 260,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                ■ KILLED{state.killReason ? ` · ${state.killReason}` : ""}
              </span>
              <Btn variant="outline" disabled={!canAdmin} title={disabledTitle} onClick={() => open("reset")}>
                RESET
              </Btn>
            </span>
          ) : (
            <Btn variant="danger" disabled={!canAdmin} title={disabledTitle ?? "Stop all new entries"} onClick={() => open("kill")}>
              ■ KILL SWITCH
            </Btn>
          )}
          <Divider />
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <Meter
              label="DAY LOSS"
              used={state.caps.dailyLossUsed}
              cap={state.caps.dailyLossCap}
              format={(n) => fmtInr(n, { compact: n >= 100_000 })}
              title="Today's realized + unrealized loss against the daily loss cap"
            />
            <Meter label="ORDERS" used={state.caps.ordersToday} cap={state.caps.maxOrdersPerDay} format={String} title="Orders placed today against the daily cap" />
            <Meter
              label="POSITIONS"
              used={state.caps.openPositions}
              cap={state.caps.maxPositions}
              format={String}
              fullIsNormal
              title="Open positions against the cap (at cap = no new entries)"
            />
          </div>
        </>
      ) : (
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Skeleton width={70} height={18} />
          <Skeleton width={60} height={18} />
          <Skeleton width={110} height={18} />
          <Skeleton width={220} height={18} />
        </div>
      )}
      <div style={{ marginLeft: "auto" }}>
        <AdminTokenPopover />
      </div>
      {dialogEl}
    </div>
  );
}
