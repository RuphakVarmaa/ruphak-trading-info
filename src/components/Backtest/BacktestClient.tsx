"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { ACCOUNTS, type AccountId } from "@/engine/accounts";
import type { BacktestParams, BacktestResult, IndexId } from "@/engine/api-types";
import { storeAdminToken, useStoredAdminToken, verifyAdminToken } from "@/hooks/adminToken";
import { EnvelopeError, errorText, fetchEnvelope } from "@/hooks/engineFetch";
import EquityCurve from "@/components/Blotter/EquityCurve";
import { SignalPerformanceTable } from "@/components/Blotter/Tables";
import { alpha, C, pnlColor } from "@/components/shared/colors";
import { enumLabel, fmtInr, fmtIstDate, fmtIstHm, fmtNum, fmtPct, fmtSigned } from "@/components/shared/format";
import { Btn, inputStyle, microLabel, Panel, Pill, SectionHeader, StatTile, tableStyle, tableWrap, td, tdNum, th, theadRow, thNum } from "@/components/shared/ui";
import { paramsToQuery } from "@/lib/backtestParams";

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

/** Each account's own default stop and target (percent of premium), shown when it is picked. */
const ACCOUNT_EXITS: Record<string, { stopPct: number; targetPct: number }> = {
  main: { stopPct: -30, targetPct: 50 },
  small10k: { stopPct: ACCOUNTS.small10k.configPatch.exits?.stopPct ?? -35, targetPct: ACCOUNTS.small10k.configPatch.exits?.targetPct ?? 60 },
};

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

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <label htmlFor={htmlFor} style={{ ...microLabel, display: "block", marginBottom: 5, color: C.muted }}>
        {label}
      </label>
      {children}
      {hint && <div style={{ fontSize: 9, color: C.muted3, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function TokenGate() {
  const token = useStoredAdminToken();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  if (token) {
    return (
      <div style={{ fontSize: 10, color: C.muted, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: C.green }}>✓</span> admin token set for this tab
        <Btn variant="ghost" onClick={() => storeAdminToken(null)}>
          forget
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
      else setError(res.code === "UNAUTHORIZED" ? "Token rejected." : res.error);
    });
  };
  return (
    <div role="group" aria-label="Admin token" style={{ display: "flex", alignItems: "flex-end", gap: 8, flexWrap: "wrap" }}>
      <Field label="🔑 Admin token (runs are admin-only)" htmlFor={id}>
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
          style={{ ...inputStyle, width: 220 }}
        />
      </Field>
      <Btn variant="outline" size="md" disabled={busy || !value.trim()} onClick={applyToken}>
        {busy ? "Verifying…" : "Use token"}
      </Btn>
      {error && (
        <span role="alert" style={{ fontSize: 10, color: C.red }}>
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
      <div role="status" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 11, color: C.textSoft }}>
          <span style={{ color: C.blue }}>◌</span> Running <span style={{ fontFamily: "monospace", color: C.muted }}>{runId}</span> · {pct}% · polling every 2 s
        </div>
        <div style={{ height: 4, background: "#1a1a1a", borderRadius: 2 }}>
          <div style={{ width: `${Math.max(4, pct)}%`, height: "100%", background: C.gold, borderRadius: 2, transition: "width 0.4s" }} />
        </div>
      </div>
    );
  }
  if (result.status === "ERROR") {
    return (
      <div role="alert" style={{ fontSize: 11, color: C.red }}>
        ✗ Run {runId} failed: {result.error ?? "unknown error"}
      </div>
    );
  }
  return (
    <div role="status" style={{ fontSize: 11, color: C.textSoft }}>
      <span style={{ color: C.green }}>✓</span> Completed <span style={{ fontFamily: "monospace", color: C.muted }}>{runId}</span>
      {result.finishedAt && <> at {fmtIstHm(result.finishedAt)} IST</>} · {result.params.from} → {result.params.to} · {result.params.index}
      {result.params.account && result.params.account !== "main" ? <> · {ACCOUNTS[result.params.account as AccountId]?.label ?? result.params.account}</> : null}
    </div>
  );
}

function Results({ result }: { result: BacktestResult }) {
  const s = result.summary;
  if (!s) return null;
  const startEquity = (result.equityCurve.at(-1)?.equity ?? 0) - s.netPnl;
  const glyph = (n: number) => (n > 0 ? "▲ " : n < 0 ? "▼ " : "");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
        <StatTile hero label="Net P&L" value={`${glyph(s.netPnl)}${fmtInr(s.netPnl, { sign: true })}`} color={pnlColor(s.netPnl)} sub={`gross ${fmtInr(s.grossPnl, { sign: true })} · charges ${fmtInr(s.charges)}`} />
        <StatTile label="Trades" value={String(s.trades)} sub={`${s.tradesPerDay.toFixed(2)} per day · avg hold ${s.avgHoldingMin} min`} />
        <StatTile label="Hit rate" value={fmtPct(s.hitRate * 100, 1, false)} sub="winning trades after costs" />
        <StatTile label="Expectancy" value={fmtPct(s.expectancyPct, 1)} color={pnlColor(s.expectancyPct)} sub={`${fmtInr(s.expectancyRupees, { sign: true })} per trade`} />
        <StatTile label="Profit factor" value={s.profitFactor.toFixed(2)} color={s.profitFactor >= 1.3 ? C.green : s.profitFactor >= 1 ? C.textStrong : C.red} sub="go-live bar: ≥ 1.30" />
        <StatTile label="Sharpe" value={s.sharpe.toFixed(2)} color={s.sharpe >= 0.8 ? C.green : C.textStrong} sub="daily P&L, annualized · go-live bar ≥ 0.80" />
        <StatTile label="Sortino" value={s.sortino.toFixed(2)} sub="downside deviation only" />
        <StatTile label="Max drawdown" value={fmtInr(-s.maxDrawdown)} color={s.maxDrawdown > 0 ? C.red : C.textStrong} sub={`${fmtPct(-s.maxDrawdownPct, 1)} from peak`} />
        <StatTile label="Real option prices" value={fmtPct(s.realPriceShare * 100, 0, false)} sub="rest synthetic (Black-Scholes)" />
      </div>

      <Panel style={{ padding: 16 }}>
        <EquityCurve points={result.equityCurve} baseline={startEquity} label="Backtest equity curve" />
      </Panel>

      <div>
        <div style={{ ...microLabel, color: C.text, fontSize: 11, marginBottom: 8 }}>Attribution by dominant signal</div>
        <SignalPerformanceTable rows={result.attribution} />
      </div>

      <div>
        <div style={{ ...microLabel, color: C.text, fontSize: 11, marginBottom: 8 }}>Trades ({result.trades.length})</div>
        <div style={{ ...tableWrap, maxHeight: 420, overflowY: "auto" }}>
          <table style={tableStyle}>
            <thead>
              <tr style={{ ...theadRow, position: "sticky", top: 0 }}>
                <th style={th}>Entry</th>
                <th style={th}>Exit</th>
                <th style={th}>Contract</th>
                <th style={th}>Side</th>
                <th style={thNum}>Entry ₹</th>
                <th style={thNum}>Exit ₹</th>
                <th style={thNum}>Qty</th>
                <th style={thNum}>P&L</th>
                <th style={th}>Exit reason</th>
                <th style={th}>Driver</th>
                <th style={thNum}>Conviction</th>
                <th style={th}>Prices</th>
              </tr>
            </thead>
            <tbody>
              {result.trades.map((t, i) => (
                <tr key={`${t.entryAt}-${i}`}>
                  <td style={{ ...td, fontFamily: "monospace" }}>
                    {fmtIstDate(t.entryAt)} {fmtIstHm(t.entryAt)}
                  </td>
                  <td style={{ ...td, fontFamily: "monospace" }}>{fmtIstHm(t.exitAt)}</td>
                  <td style={{ ...td, fontFamily: "monospace", color: C.textStrong }}>{t.contractLabel}</td>
                  <td style={{ ...td, color: t.side === "BULL" ? C.green : C.red, fontWeight: 700 }}>{t.side === "BULL" ? "▲ BULL" : "▼ BEAR"}</td>
                  <td style={tdNum}>{fmtNum(t.entry)}</td>
                  <td style={tdNum}>{fmtNum(t.exit)}</td>
                  <td style={tdNum}>{t.qty}</td>
                  <td style={{ ...tdNum, color: pnlColor(t.pnl) }}>
                    {glyph(t.pnl)}
                    {fmtInr(t.pnl, { sign: true })} <span style={{ color: C.muted }}>({fmtPct(t.pnlPct, 1)})</span>
                  </td>
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
        <div style={{ background: C.panelAlt, border: `1px solid ${C.borderSoft}`, borderRadius: 8, padding: "12px 16px" }}>
          <div style={{ ...microLabel, marginBottom: 6 }}>Notes</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: C.textDim, lineHeight: 1.7 }}>
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
  const ids = { from: useId(), to: useId(), account: useId(), index: useId(), delta: useId(), stop: useId(), target: useId() };

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
          setError(notFound ? `Run ${runId} not found (it may have expired).` : errorText(err));
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
      } else setError(errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const running = runId != null && (result == null || result.status === "RUNNING") && !error;

  return (
    <main style={{ flex: 1, padding: "28px 30px 40px" }}>
      <div style={{ maxWidth: 1400, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <SectionHeader
          label="Backtest"
          title="Replay the strategy on past sessions"
          sub="Same decision code as paper and live, fed point-in-time candles and scored events. Results are hypothetical."
        />
        <Panel style={{ padding: 18 }}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            style={{ display: "flex", flexDirection: "column", gap: 16 }}
          >
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
              <Field label="From" htmlFor={ids.from}>
                <input id={ids.from} type="date" value={form.from} max={form.to || todayIst} onChange={(e) => update({ from: e.target.value })} style={inputStyle} />
              </Field>
              <Field label="To" htmlFor={ids.to}>
                <input id={ids.to} type="date" value={form.to} min={form.from} max={todayIst} onChange={(e) => update({ to: e.target.value })} style={inputStyle} />
              </Field>
              <Field label="Account" htmlFor={ids.account} hint="stop and target apply to this account">
                <select
                  id={ids.account}
                  value={form.account}
                  onChange={(e) => {
                    const account = e.target.value;
                    const exits = ACCOUNT_EXITS[account] ?? ACCOUNT_EXITS.main;
                    // The ₹10k account trades NIFTY only; main replays alongside it on the same index.
                    update({ account, stopPct: String(exits.stopPct), targetPct: String(exits.targetPct), ...(account !== "main" ? { index: "NIFTY" as const } : {}) });
                  }}
                  style={inputStyle}
                >
                  <option value="main">Main (₹5L, at the money)</option>
                  <option value="small10k">₹10k (one cheaper lot)</option>
                </select>
              </Field>
              <Field label="Index" htmlFor={ids.index}>
                <select id={ids.index} value={form.index} onChange={(e) => update({ index: e.target.value as FormState["index"] })} style={inputStyle}>
                  <option value="BOTH">NIFTY + SENSEX</option>
                  <option value="NIFTY">NIFTY only</option>
                  <option value="SENSEX">SENSEX only</option>
                </select>
              </Field>
              <Field label="Threshold shift" htmlFor={ids.delta} hint="added to every regime threshold">
                <input
                  id={ids.delta}
                  type="number"
                  step="0.05"
                  min={-0.3}
                  max={0.3}
                  value={form.thresholdDelta}
                  onChange={(e) => update({ thresholdDelta: e.target.value })}
                  style={inputStyle}
                />
              </Field>
              <Field label="Stop % of premium" htmlFor={ids.stop} hint="negative, e.g. −30">
                <input id={ids.stop} type="number" step="5" min={-90} max={-5} value={form.stopPct} onChange={(e) => update({ stopPct: e.target.value })} style={inputStyle} />
              </Field>
              <Field label="Target % of premium" htmlFor={ids.target} hint="e.g. +50">
                <input
                  id={ids.target}
                  type="number"
                  step="5"
                  min={5}
                  max={300}
                  value={form.targetPct}
                  onChange={(e) => update({ targetPct: e.target.value })}
                  style={inputStyle}
                />
              </Field>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.textSoft, cursor: "pointer" }}>
              <input type="checkbox" checked={form.noEvents} onChange={(e) => update({ noEvents: e.target.checked })} />
              No-events baseline <span style={{ color: C.muted3, fontSize: 10 }}>(disable the event layer to measure what events add)</span>
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", justifyContent: "space-between" }}>
              <TokenGate />
              <Btn type="submit" variant="gold" size="md" disabled={submitting || running || !token}>
                {submitting ? "Starting…" : running ? "Running…" : "▶ Run backtest"}
              </Btn>
            </div>
            {error && (
              <div role="alert" style={{ fontSize: 11, color: C.red, background: alpha(C.red, 0.08), border: `1px solid ${alpha(C.red, 0.3)}`, borderRadius: 6, padding: "8px 12px" }}>
                ✗ {error}
              </div>
            )}
          </form>
        </Panel>

        {runId && <RunStatus result={result} runId={runId} />}
        {result?.status === "DONE" && <Results result={result} />}
      </div>
    </main>
  );
}
