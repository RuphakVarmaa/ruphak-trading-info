"use client";

import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import type { BacktestParams, BacktestResult, IndexId } from "@/engine/api-types";
import { storeAdminToken, useStoredAdminToken, verifyAdminToken } from "@/hooks/adminToken";
import { EnvelopeError, fetchEnvelope } from "@/hooks/engineFetch";
import EquityCurve from "@/components/Blotter/EquityCurve";
import { SignalPerformanceTable } from "@/components/Blotter/Tables";
import { alpha, C, pnlColor } from "@/components/shared/colors";
import { enumLabel, fmtInr, fmtIstDate, fmtIstHm, fmtNum, fmtPct, fmtSigned } from "@/components/shared/format";
import { Btn, inputStyle, PageHeader, Panel, PanelHeader, Pill, Segmented, StatTile, tableStyle, tableWrap, td, tdNum, th, theadRow, thNum } from "@/components/shared/ui";
import { SERIF } from "@/components/shared/theme";
import { BACKTEST_ACCOUNTS, backtestAccount, paramsToQuery, type BacktestAccount } from "@/lib/backtestParams";

interface FormState {
  from: string;
  to: string;
  /** "main", or a follower account such as "small10k" (main replays alongside it). */
  account: string;
  index: IndexId | "BOTH";
  thresholdDelta: string;
  stopPct: string;
  targetPct: string;
  noEvents: boolean;
}

/** Each account's own default stop and target (percent of premium), read from its config patch and applied when it is picked. */
const ACCOUNT_EXITS: Record<string, { stopPct: number; targetPct: number }> = Object.fromEntries(
  BACKTEST_ACCOUNTS.map((a) => [a.id, { stopPct: a.stopPct, targetPct: a.targetPct }]),
);

/** "₹5L", "₹10k", "₹5k": the account's capital in a few characters. */
const fmtCapitalShort = (rupees: number) =>
  rupees >= 100_000 ? `₹${Number((rupees / 100_000).toFixed(1))}L` : rupees >= 1000 ? `₹${Number((rupees / 1000).toFixed(1))}k` : `₹${rupees}`;

/** The toggle's label: the short label, plus the capital when the label does not already say it. */
const accountOptionLabel = (a: BacktestAccount) =>
  a.shortLabel.includes(fmtCapitalShort(a.capitalRupees)) ? a.shortLabel : `${a.shortLabel} ${fmtCapitalShort(a.capitalRupees)}`;

/** The account's capital and default exits in one line, from its registry entry. */
function accountHint(a: BacktestAccount): string {
  const base = `${fmtInr(a.capitalRupees, { decimals: 0 })} capital; default stop ${fmtPct(a.stopPct, 0)} and target ${fmtPct(a.targetPct, 0)} of premium`;
  return a.id === "main" ? `${base}.` : `${base}. Follows the main account's signals, which replay alongside it.`;
}

/**
 * A plain sentence for a failed request, never an error code. The engine's own wording is kept only
 * for rejected settings, where it names the field to fix.
 */
function plainError(err: unknown): string {
  if (err instanceof EnvelopeError) {
    if (err.status === 401 || err.code === "UNAUTHORIZED") return "The admin token was not accepted. Enter it again.";
    if (err.code === "BAD_REQUEST") return err.message ? `The engine did not accept these settings: ${err.message}` : "The engine did not accept these settings.";
    if (err.code === "CONFLICT") return "Another backtest is still running. Wait for it to finish, then run again.";
    if (err.code === "ADMIN_DISABLED") return "Backtests are switched off on this deployment because no admin token is configured.";
    if (err.code === "NOT_FOUND") return "The engine does not know this run. It may have expired.";
  }
  return "The engine did not answer. Check your connection and try again in a moment.";
}

const toForm = (p: BacktestParams): FormState => ({
  from: p.from,
  to: p.to,
  account: p.account ?? "main",
  index: p.index,
  thresholdDelta: String(p.thresholdDelta),
  stopPct: String(p.stopPct),
  targetPct: String(p.targetPct),
  noEvents: p.noEvents,
});

function parseForm(f: FormState, today: string): { ok: true; params: BacktestParams } | { ok: false; error: string } {
  const thresholdDelta = Number(f.thresholdDelta);
  const stopPct = Number(f.stopPct);
  const targetPct = Number(f.targetPct);
  if (!f.from || !f.to) return { ok: false, error: "Pick both dates." };
  if (f.from > f.to) return { ok: false, error: "'From' must be on or before 'To'." };
  if (f.to > today) return { ok: false, error: "'To' cannot be in the future." };
  if (!Number.isFinite(thresholdDelta) || thresholdDelta < -0.3 || thresholdDelta > 0.3) return { ok: false, error: "Threshold shift must be between −0.30 and +0.30." };
  if (!Number.isFinite(stopPct) || stopPct < -90 || stopPct > -5) return { ok: false, error: "Stop must be between −90% and −5% of premium." };
  if (!Number.isFinite(targetPct) || targetPct < 5 || targetPct > 300) return { ok: false, error: "Target must be between +5% and +300% of premium." };
  const account = f.account !== "main" ? { account: f.account } : {};
  return { ok: true, params: { from: f.from, to: f.to, index: f.index, thresholdDelta, stopPct, targetPct, noEvents: f.noEvents, ...account } };
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <label htmlFor={htmlFor} style={{ display: "block", marginBottom: 6, fontSize: 13, fontWeight: 600, color: C.textSoft }}>
        {label}
      </label>
      {children}
      {hint && <div style={{ fontSize: 12, color: C.muted2, marginTop: 5, lineHeight: 1.45 }}>{hint}</div>}
    </div>
  );
}

/** One block of the settings panel: a small heading and its fields. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 12, padding: "16px 18px", borderTop: `1px solid ${C.borderSoft}` }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.muted, letterSpacing: "0.02em" }}>{title}</div>
      {children}
    </div>
  );
}

const PRESETS: { days: number; label: string }[] = [
  { days: 7, label: "1 week" },
  { days: 14, label: "2 weeks" },
  { days: 30, label: "1 month" },
  { days: 60, label: "2 months" },
  { days: 90, label: "3 months" },
];

/** YYYY-MM-DD shifted by whole days (calendar arithmetic on the date only). */
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const chip = (on: boolean): CSSProperties => ({
  border: `1px solid ${on ? C.gold : C.border}`,
  background: on ? alpha(C.gold, 0.08) : C.panel,
  color: on ? C.gold : C.textSoft,
  borderRadius: 999,
  padding: "5px 11px",
  fontSize: 12.5,
  fontWeight: on ? 600 : 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
});

function TokenGate() {
  const token = useStoredAdminToken();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  if (token) {
    return (
      <div style={{ fontSize: 13, color: C.textSoft, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ color: C.green, fontWeight: 700 }}>✓</span> Admin token set for this tab
        <Btn variant="ghost" onClick={() => storeAdminToken(null)} style={{ marginLeft: "auto" }}>
          Forget
        </Btn>
      </div>
    );
  }
  // Not a <form>: this sits inside the backtest form, and forms cannot nest.
  const applyToken = () => {
    const candidate = value.trim();
    if (!candidate || busy) return;
    setBusy(true);
    setError(null);
    void verifyAdminToken(candidate).then((res) => {
      setBusy(false);
      if (res.ok) storeAdminToken(candidate);
      else setError(res.code === "UNAUTHORIZED" ? "That token was not accepted." : "The token could not be checked because the engine did not answer. Try again in a moment.");
    });
  };
  return (
    <div role="group" aria-label="Admin token" style={{ display: "grid", gap: 8 }}>
      <Field label="Admin token" htmlFor={id} hint="Runs use the engine, so they need the admin token. It stays in this tab only.">
        <input
          id={id}
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              applyToken();
            }
          }}
          style={inputStyle}
        />
      </Field>
      <Btn variant="outline" size="md" disabled={busy || !value.trim()} onClick={applyToken} style={{ justifyContent: "center" }}>
        {busy ? "Verifying…" : "Use token"}
      </Btn>
      {error && (
        <span role="alert" style={{ fontSize: 12.5, color: C.red }}>
          ✗ {error}
        </span>
      )}
    </div>
  );
}

function RunStatus({ result, runId }: { result: BacktestResult | null; runId: string }) {
  if (!result || result.status === "RUNNING") {
    const pct = Math.round((result?.progress ?? 0) * 100);
    return (
      <Panel style={{ padding: "18px 20px" }}>
        <div role="status" style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: C.textStrong }}>Replaying sessions…</span>
            <span className="tnum" style={{ fontSize: 22, fontWeight: 600, color: C.gold }}>{pct}%</span>
          </div>
          <div style={{ height: 8, background: C.track, borderRadius: 999, overflow: "hidden" }}>
            <div style={{ width: `${Math.max(3, pct)}%`, height: "100%", background: C.gold, borderRadius: 999, transition: "width 0.4s" }} />
          </div>
          <div style={{ fontSize: 12.5, color: C.muted2 }}>
            Run <span style={{ color: C.textSoft }}>{runId}</span> · checking every 2 s · long periods take a few minutes
          </div>
        </div>
      </Panel>
    );
  }
  if (result.status === "ERROR") {
    return (
      <div role="alert" style={{ fontSize: 14, color: C.red, background: alpha(C.red, 0.06), border: `1px solid ${alpha(C.red, 0.3)}`, borderRadius: 14, padding: "14px 18px" }}>
        ✗ This run stopped before it finished, so it has no results. Run it again, or pick a shorter period.
        {result.error && (
          <details style={{ marginTop: 8, fontSize: 12.5, color: C.textSoft }}>
            <summary style={{ cursor: "pointer", color: C.muted }}>Details</summary>
            <div style={{ marginTop: 6, overflowWrap: "anywhere" }}>
              Run {runId}: {result.error}
            </div>
          </details>
        )}
      </div>
    );
  }
  return (
    <div role="status" style={{ fontSize: 13, color: C.muted, display: "flex", gap: "4px 10px", flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ color: C.green, fontWeight: 700 }}>✓ Completed</span>
      <span>
        {result.params.from} → {result.params.to} · {result.params.index === "BOTH" ? "NIFTY + SENSEX" : result.params.index}
        {result.params.account && result.params.account !== "main" ? <> · {BACKTEST_ACCOUNTS.find((a) => a.id === result.params.account)?.label ?? result.params.account}</> : null}
        {result.finishedAt && <> · finished {fmtIstHm(result.finishedAt)} IST</>}
      </span>
      <span style={{ color: C.muted3 }}>run {runId}</span>
    </div>
  );
}

/** The documented paper-to-live bar (README): profit factor ≥ 1.3 and Sharpe ≥ 0.8 over at least 60 trades. */
const BAR = { profitFactor: 1.3, sharpe: 0.8, trades: 60 };

function Verdict({ s }: { s: NonNullable<BacktestResult["summary"]> }) {
  const checks = [
    { ok: s.profitFactor >= BAR.profitFactor, text: `Profit factor ${s.profitFactor.toFixed(2)} (needs ≥ ${BAR.profitFactor.toFixed(2)})` },
    { ok: s.sharpe >= BAR.sharpe, text: `Sharpe ${s.sharpe.toFixed(2)} (needs ≥ ${BAR.sharpe.toFixed(2)})` },
    { ok: s.trades >= BAR.trades, text: `${s.trades} trades (needs ≥ ${BAR.trades})` },
  ];
  const pass = checks.every((c) => c.ok);
  const tone = pass ? C.green : s.netPnl >= 0 ? C.orange : C.red;
  return (
    <div style={{ borderRadius: 14, border: `1px solid ${alpha(tone, 0.35)}`, background: alpha(tone, 0.06), padding: "16px 20px", display: "grid", gap: 10 }}>
      <div style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 500, color: C.textStrong, letterSpacing: "-0.01em" }}>
        {pass ? "Meets the go-live bar on this run" : s.netPnl >= 0 ? "Profitable, but below the go-live bar" : "Loses money: below the go-live bar"}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", fontSize: 13 }}>
        {checks.map((c) => (
          <span key={c.text} style={{ color: c.ok ? C.green : C.textSoft }}>
            <b style={{ color: c.ok ? C.green : C.red }}>{c.ok ? "✓" : "✗"}</b> {c.text}
          </span>
        ))}
      </div>
      <div style={{ fontSize: 12.5, color: C.muted2, lineHeight: 1.5 }}>
        One replay is in-sample. Going live also needs the walk-forward (out-of-sample) test, the shuffled-events placebo and at least six weeks of paper trading that agrees.
      </div>
    </div>
  );
}

function SubHeading({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
      <h3 style={{ margin: 0, fontFamily: SERIF, fontSize: 21, fontWeight: 500, color: C.textStrong, letterSpacing: "-0.01em" }}>{children}</h3>
      {right}
    </div>
  );
}

function Results({ result }: { result: BacktestResult }) {
  const s = result.summary;
  if (!s) return null;
  const startEquity = (result.equityCurve.at(-1)?.equity ?? 0) - s.netPnl;
  const glyph = (n: number) => (n > 0 ? "▲ " : n < 0 ? "▼ " : "");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28, minWidth: 0 }}>
      <Verdict s={s} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))", gap: 12 }}>
        <StatTile hero label="Net P&L" value={fmtInr(s.netPnl, { sign: true, decimals: 0 })} color={pnlColor(s.netPnl)} sub={`gross ${fmtInr(s.grossPnl, { sign: true, decimals: 0 })} · charges ${fmtInr(s.charges, { decimals: 0 })}`} />
        <StatTile label="Trades" value={String(s.trades)} sub={`${s.tradesPerDay.toFixed(2)} per day · avg hold ${s.avgHoldingMin} min`} />
        <StatTile label="Hit rate" value={fmtPct(s.hitRate * 100, 1, false)} sub="winning trades after costs" />
        <StatTile label="Expectancy" value={fmtPct(s.expectancyPct, 1)} color={pnlColor(s.expectancyPct)} sub={`${fmtInr(s.expectancyRupees, { sign: true })} per trade`} />
        <StatTile label="Profit factor" value={s.profitFactor.toFixed(2)} color={s.profitFactor >= BAR.profitFactor ? C.green : s.profitFactor >= 1 ? C.textStrong : C.red} sub={`go-live bar: ≥ ${BAR.profitFactor.toFixed(2)}`} />
        <StatTile label="Sharpe" value={s.sharpe.toFixed(2)} color={s.sharpe >= BAR.sharpe ? C.green : C.textStrong} sub={`daily P&L, annualized · go-live bar ≥ ${BAR.sharpe.toFixed(2)}`} />
        <StatTile label="Sortino" value={s.sortino.toFixed(2)} sub="downside deviation only" />
        <StatTile label="Max drawdown" value={fmtInr(-s.maxDrawdown)} color={s.maxDrawdown > 0 ? C.red : C.textStrong} sub={`${fmtPct(-s.maxDrawdownPct, 1)} from peak`} />
        <StatTile label="Real option prices" value={fmtPct(s.realPriceShare * 100, 0, false)} sub="rest synthetic (Black-Scholes)" />
      </div>

      <div>
        <SubHeading>Equity curve</SubHeading>
        <Panel style={{ padding: 16 }}>
          <EquityCurve points={result.equityCurve} baseline={startEquity} label="Backtest equity" />
        </Panel>
      </div>

      <div style={{ minWidth: 0 }}>
        <SubHeading>Which signals made or lost money</SubHeading>
        <SignalPerformanceTable rows={result.attribution} />
      </div>

      <div style={{ minWidth: 0 }}>
        <SubHeading right={<span style={{ fontSize: 13, color: C.muted2 }}>{result.trades.length} trades</span>}>Trades</SubHeading>
        <div style={{ ...tableWrap, maxHeight: 480, overflowY: "auto" }}>
          <table style={tableStyle}>
            <thead>
              <tr style={{ ...theadRow, position: "sticky", top: 0 }}>
                <th style={th}>Entry</th>
                <th style={th}>Exit</th>
                <th style={th}>Contract</th>
                <th style={th}>Side</th>
                <th style={thNum}>P&L</th>
                <th style={thNum}>Entry ₹</th>
                <th style={thNum}>Exit ₹</th>
                <th style={thNum}>Qty</th>
                <th style={th}>Exit reason</th>
                <th style={th}>Driver</th>
                <th style={thNum}>Conviction</th>
                <th style={th}>Prices</th>
              </tr>
            </thead>
            <tbody>
              {result.trades.map((t, i) => (
                <tr key={`${t.entryAt}-${i}`}>
                  <td style={{ ...td, fontFamily: "var(--font-num)" }}>
                    {fmtIstDate(t.entryAt)} {fmtIstHm(t.entryAt)}
                  </td>
                  <td style={{ ...td, fontFamily: "var(--font-num)" }}>{fmtIstHm(t.exitAt)}</td>
                  <td style={{ ...td, fontFamily: "var(--font-num)", color: C.textStrong }}>{t.contractLabel}</td>
                  <td style={{ ...td, color: t.side === "BULL" ? C.green : C.red, fontWeight: 600 }}>{t.side === "BULL" ? "▲ Bull" : "▼ Bear"}</td>
                  <td style={{ ...tdNum, color: pnlColor(t.pnl) }}>
                    {glyph(t.pnl)}
                    {fmtInr(t.pnl, { sign: true })} <span style={{ color: C.muted }}>({fmtPct(t.pnlPct, 1)})</span>
                  </td>
                  <td style={tdNum}>{fmtNum(t.entry)}</td>
                  <td style={tdNum}>{fmtNum(t.exit)}</td>
                  <td style={tdNum}>{t.qty}</td>
                  <td style={td}>{enumLabel(t.exitReason)}</td>
                  <td style={{ ...td, color: C.textDim }}>{enumLabel(t.dominantSource)}</td>
                  <td style={tdNum}>{fmtSigned(t.conviction)}</td>
                  <td style={td}>
                    <Pill color={t.priceSource === "real" ? C.green : C.purple}>{t.priceSource}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {result.notes.length > 0 && (
        <div style={{ background: C.panelAlt, border: `1px solid ${C.border}`, borderRadius: 14, padding: "14px 20px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.textSoft, marginBottom: 6 }}>Notes</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: C.textDim, lineHeight: 1.7 }}>
            {result.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function BacktestClient({
  initialParams,
  initialRunId,
  todayIst,
}: {
  initialParams: BacktestParams;
  initialRunId: string | null;
  todayIst: string;
}) {
  const token = useStoredAdminToken();
  const [form, setForm] = useState<FormState>(() => toForm(initialParams));
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ids = { from: useId(), to: useId(), delta: useId(), stop: useId(), target: useId() };

  // Poll the run every 2 s until it is DONE or ERROR.
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const poll = () => {
      fetchEnvelope<BacktestResult>(`/api/engine/backtest/${encodeURIComponent(runId)}`)
        .then(({ data }) => {
          if (cancelled) return;
          failures = 0;
          setResult(data);
          setError(null);
          if (data.status === "RUNNING") timer = setTimeout(poll, 2000);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          failures += 1;
          const notFound = err instanceof EnvelopeError && err.status === 404;
          setError(notFound ? "That run is no longer available (runs expire). Start a new one." : plainError(err));
          if (!notFound && failures < 5) timer = setTimeout(poll, 4000);
        });
    };
    timer = setTimeout(poll, 0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  const update = (patch: Partial<FormState>) => {
    const next = { ...form, ...patch };
    setForm(next);
    const parsed = parseForm(next, todayIst);
    if (parsed.ok) window.history.replaceState(null, "", `?${paramsToQuery(parsed.params, runId)}`);
  };

  const submit = async () => {
    const parsed = parseForm(form, todayIst);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (!token) {
      setError("Enter the admin token first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetchEnvelope<{ runId: string; status: string }>("/api/engine/backtest", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify(parsed.params),
      });
      setRunId(res.data.runId);
      window.history.replaceState(null, "", `?${paramsToQuery(parsed.params, res.data.runId)}`);
    } catch (err) {
      if (err instanceof EnvelopeError && err.status === 401) {
        storeAdminToken(null);
        setError("Admin token rejected; enter it again.");
      } else setError(plainError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const running = runId != null && (result == null || result.status === "RUNNING") && !error;

  const matchedPreset = PRESETS.find((p) => form.to === todayIst && form.from === addDays(todayIst, -p.days))?.days ?? null;

  return (
    <main style={{ flex: 1, width: "100%", maxWidth: 1240, margin: "0 auto", padding: "32px 16px 56px", display: "grid", gap: 28, boxSizing: "border-box" }}>
      <PageHeader
        eyebrow="Backtest"
        title="Replay the strategy on past sessions"
        sub="The same decision code as paper and live trading, fed the candles and scored news that were known at each moment, with Groww's charges. Results are hypothetical."
      />

      <div className="bt-grid">
        <form
          className="bt-settings"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Panel>
            <PanelHeader title="Settings" />
            <Group title="Period">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {PRESETS.map((p) => (
                  <button key={p.days} type="button" aria-pressed={matchedPreset === p.days} onClick={() => update({ from: addDays(todayIst, -p.days), to: todayIst })} style={chip(matchedPreset === p.days)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                <Field label="From" htmlFor={ids.from}>
                  <input id={ids.from} type="date" value={form.from} max={form.to || todayIst} onChange={(e) => update({ from: e.target.value })} style={inputStyle} />
                </Field>
                <Field label="To" htmlFor={ids.to}>
                  <input id={ids.to} type="date" value={form.to} min={form.from} max={todayIst} onChange={(e) => update({ to: e.target.value })} style={inputStyle} />
                </Field>
              </div>
            </Group>

            <Group title="Account and index">
              <Field label="Account" hint={accountHint(backtestAccount(form.account))}>
                <Segmented<string>
                  label="Account"
                  value={backtestAccount(form.account).id}
                  options={BACKTEST_ACCOUNTS.map((a) => ({ value: a.id, label: accountOptionLabel(a), title: a.label }))}
                  onChange={(account) => {
                    const exits = ACCOUNT_EXITS[account] ?? ACCOUNT_EXITS.main;
                    update({ account, stopPct: String(exits.stopPct), targetPct: String(exits.targetPct) });
                  }}
                />
              </Field>
              <Field label="Index">
                <Segmented
                  label="Index"
                  value={form.index}
                  options={[
                    { value: "BOTH", label: "Both" },
                    { value: "NIFTY", label: "NIFTY" },
                    { value: "SENSEX", label: "SENSEX" },
                  ]}
                  onChange={(index) => update({ index })}
                />
              </Field>
            </Group>

            <Group title="Exits (percent of the option premium)">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                <Field label="Stop" htmlFor={ids.stop} hint="e.g. −30">
                  <input id={ids.stop} type="number" step="5" min={-90} max={-5} value={form.stopPct} onChange={(e) => update({ stopPct: e.target.value })} style={inputStyle} />
                </Field>
                <Field label="Target" htmlFor={ids.target} hint="e.g. +50">
                  <input id={ids.target} type="number" step="5" min={5} max={300} value={form.targetPct} onChange={(e) => update({ targetPct: e.target.value })} style={inputStyle} />
                </Field>
              </div>
            </Group>

            <details style={{ borderTop: `1px solid ${C.borderSoft}` }}>
              <summary style={{ padding: "14px 18px", fontSize: 13, fontWeight: 600, color: C.textSoft, cursor: "pointer" }}>Advanced</summary>
              <div style={{ display: "grid", gap: 12, padding: "0 18px 16px" }}>
                <Field label="Threshold shift" htmlFor={ids.delta} hint="Added to every regime's conviction threshold (−0.30 to +0.30).">
                  <input id={ids.delta} type="number" step="0.05" min={-0.3} max={0.3} value={form.thresholdDelta} onChange={(e) => update({ thresholdDelta: e.target.value })} style={inputStyle} />
                </Field>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13, color: C.textSoft, cursor: "pointer", lineHeight: 1.45 }}>
                  <input type="checkbox" checked={form.noEvents} onChange={(e) => update({ noEvents: e.target.checked })} style={{ marginTop: 3 }} />
                  <span>
                    No-events baseline
                    <span style={{ display: "block", color: C.muted2, fontSize: 12 }}>Turn the news layer off to measure what it adds.</span>
                  </span>
                </label>
              </div>
            </details>

            <div style={{ display: "grid", gap: 12, padding: "16px 18px", borderTop: `1px solid ${C.borderSoft}`, background: C.panelAlt }}>
              <TokenGate />
              <Btn type="submit" variant="gold" size="md" disabled={submitting || running || !token} style={{ justifyContent: "center", width: "100%" }}>
                {submitting ? "Starting…" : running ? "Running…" : "Run backtest"}
              </Btn>
              {error && (
                <div role="alert" style={{ fontSize: 13, color: C.red, background: alpha(C.red, 0.06), border: `1px solid ${alpha(C.red, 0.3)}`, borderRadius: 10, padding: "9px 12px" }}>
                  ✗ {error}
                </div>
              )}
            </div>
          </Panel>
        </form>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 20, minWidth: 0 }}>
          {runId ? (
            <>
              <RunStatus result={result} runId={runId} />
              {result?.status === "DONE" && <Results result={result} />}
            </>
          ) : (
            <Panel style={{ padding: "20px 22px" }}>
              <p style={{ margin: 0, fontSize: 15, color: C.textSoft, lineHeight: 1.55 }}>Pick a period and press Run backtest; the results appear here.</p>
              <p style={{ margin: "8px 0 0", fontSize: 13, color: C.muted2, lineHeight: 1.55 }}>
                Go-live bar: profit factor ≥ {BAR.profitFactor.toFixed(2)} and Sharpe ≥ {BAR.sharpe.toFixed(2)} over at least {BAR.trades} trades, out of sample.
              </p>
            </Panel>
          )}
        </div>
      </div>
    </main>
  );
}
