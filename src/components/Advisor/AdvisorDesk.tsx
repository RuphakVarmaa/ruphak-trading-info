"use client";

/**
 * The Advisor page: one plain-English brief written by Claude from everything the site knows. The top bar
 * starts an analysis (POST, then polls every 3 s while it is queued or running); the brief below reads in
 * order: the answer for today, where the market may go, trade ideas, what moves the market, premiums, the
 * zero-hero check, things you may not know, what not to do, sources, past briefs and the honesty line.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AdvisorView } from "@/engine/api-types";
import { alpha, C } from "@/components/shared/colors";
import { Btn, Dot, PageHeader, Panel, Pill, Section, Skeleton } from "@/components/shared/ui";
import { errorText, fetchEnvelope } from "@/hooks/engineFetch";
import { useClientNow } from "@/hooks/useEngineState";
import { FactorsSection, IdeasSection, NumberedList, OutlookSection, PremiumCard, SourcesList, TodayCard, ZeroHeroCard } from "./AdvisorParts";
import { costWords, isBusy, modelName, nextAllowedLine, statusWords, writtenLine } from "./advisorText";
import PastBriefs from "./PastBriefs";

const ADVISOR_URL = "/api/engine/advisor";
const POLL_BUSY_MS = 3_000;
const POLL_IDLE_MS = 60_000;

type Source = "engine" | "mock" | null;

function DemoChip() {
  return (
    <span title="The site is running on its built-in mock engine: prices, option chains and this brief are made up for the demo. No Claude call is made.">
      <Pill color={C.purple} style={{ fontSize: 11.5, padding: "4px 10px" }}>
        Demo data
      </Pill>
    </span>
  );
}

function Notice({ tone, children }: { tone: "error" | "info"; children: ReactNode }) {
  const color = tone === "error" ? C.red : C.blue;
  return (
    <div role={tone === "error" ? "alert" : "status"} style={{ background: alpha(color, 0.06), border: `1px solid ${alpha(color, 0.3)}`, borderRadius: 10, padding: "10px 12px", fontSize: 15, lineHeight: 1.5, color: C.textSoft }}>
      {children}
    </div>
  );
}

function TopBar({
  view,
  nowMs,
  posting,
  actionError,
  loadError,
  onAnalyze,
}: {
  view: AdvisorView | null;
  nowMs: number | null;
  posting: boolean;
  actionError: string | null;
  loadError: string | null;
  onAnalyze: () => void;
}) {
  const busy = view ? isBusy(view.status) : false;
  const waitLine = view ? nextAllowedLine(view.nextAllowedAt, nowMs) : null;
  const status = view ? statusWords(view) : null;
  const latest = view?.latest ?? null;
  const cost = latest ? costWords(latest.costUsd) : null;
  return (
    <Panel style={{ padding: "16px 16px", display: "grid", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <Btn
          variant="gold"
          size="md"
          onClick={onAnalyze}
          disabled={posting || busy || waitLine != null || view == null}
          style={{ minHeight: 48, fontSize: 16, padding: "12px 20px", whiteSpace: "normal", textAlign: "left" }}
        >
          {busy ? "Analyzing…" : posting ? "Starting…" : "Analyze the market now"}
        </Btn>
        {status && (
          <span role="status" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 15.5, fontWeight: 600, color: C.blue }}>
            <Dot color={C.blue} size={8} pulse /> {status}
          </span>
        )}
        {!status && waitLine && <span style={{ fontSize: 15, color: C.muted }}>{waitLine}</span>}
      </div>
      {latest && (
        <div style={{ fontSize: 14.5, color: C.muted, lineHeight: 1.55, display: "flex", flexWrap: "wrap", gap: "2px 8px" }}>
          <span style={{ color: C.textSoft, fontWeight: 600 }}>{writtenLine(latest.createdAt, nowMs)}</span>
          <span aria-hidden>·</span>
          <span>{modelName(latest.model)}</span>
          <span aria-hidden>·</span>
          <span>{cost ? `cost ${cost}` : "cost not known"}</span>
          {view && view.maxRunsPerDay > 0 && (
            <>
              <span aria-hidden>·</span>
              <span>
                {view.runsToday} of {view.maxRunsPerDay} analyses today
              </span>
            </>
          )}
        </div>
      )}
      {view?.lastError && (
        <Notice tone="error">
          <b>The last analysis did not finish.</b> {view.lastError}
          {latest ? " The brief below is the previous one." : ""}
        </Notice>
      )}
      {actionError && <Notice tone="error">Could not start an analysis: {actionError}</Notice>}
      {loadError && <Notice tone="error">Could not refresh the advisor: {loadError} The page keeps what it has and tries again.</Notice>}
    </Panel>
  );
}

export default function AdvisorDesk({ initial, initialSource }: { initial: AdvisorView | null; initialSource: Source }) {
  const [view, setView] = useState<AdvisorView | null>(initial);
  const [source, setSource] = useState<Source>(initialSource);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const nowMs = useClientNow();
  const busy = view ? isBusy(view.status) : false;
  const hasView = view != null;

  const refresh = useCallback(async () => {
    try {
      const res = await fetchEnvelope<AdvisorView>(ADVISOR_URL);
      setView(res.data);
      setSource(res.source);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);

  // Every 3 s while an analysis is queued or running, every minute otherwise (a morning auto-run shows up), at once without data.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const every = busy ? POLL_BUSY_MS : POLL_IDLE_MS;
    const tick = async () => {
      if (!document.hidden) await refresh();
      if (!stopped) timer = setTimeout(() => void tick(), every);
    };
    timer = setTimeout(() => void tick(), hasView ? every : 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [busy, hasView, refresh]);

  const analyze = async () => {
    setPosting(true);
    setActionError(null);
    try {
      const res = await fetchEnvelope<AdvisorView>(ADVISOR_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "Analyze button on /advisor" }) }, 20_000);
      setView(res.data);
      setSource(res.source);
      setLoadError(null);
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setPosting(false);
    }
  };

  const report = view?.latest ?? null;

  return (
    <main style={{ width: "100%", maxWidth: 900, margin: "0 auto", padding: "28px 16px 64px", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 40, boxSizing: "border-box" }}>
      <PageHeader
        title="Advisor"
        sub="Everything the site knows, in plain English: where the market may go and which option, if any, is worth buying. Written by Claude Opus 5.5 when you press Analyze."
        right={source === "mock" ? <DemoChip /> : undefined}
      >
        <TopBar view={view} nowMs={nowMs} posting={posting} actionError={actionError} loadError={loadError} onAnalyze={() => void analyze()} />
      </PageHeader>

      {view == null && !loadError && (
        <Panel style={{ padding: 20, display: "grid", gap: 12 }}>
          <Skeleton height={40} width="40%" />
          <Skeleton height={22} />
          <Skeleton height={22} width="80%" />
        </Panel>
      )}

      {view != null && report == null && (
        <Panel style={{ padding: "28px 20px", textAlign: "center", display: "grid", gap: 8 }}>
          <div style={{ fontSize: 22, fontWeight: 600, color: C.textStrong }}>No brief yet.</div>
          <div style={{ fontSize: 16.5, color: C.muted }}>{busy ? "The first one is being written now: about 1–2 minutes." : "Press Analyze to get the first one."}</div>
        </Panel>
      )}

      {report && (
        <>
          <section aria-label="Today" style={{ minWidth: 0 }}>
            <TodayCard report={report} nowMs={nowMs} />
          </section>

          <Section id="outlook" title="Where the market may go" sub="A lean (up, down or sideways) for today, this week and this month, with the range option prices imply.">
            <OutlookSection report={report} />
          </Section>

          <Section id="ideas" title="Trade ideas" sub="Real listed contracts with the live price checked when the brief was written. Each one has its stop, its most you can lose, and what would prove it wrong.">
            <IdeasSection report={report} nowMs={nowMs} />
          </Section>

          <Section id="factors" title="What's moving the market" sub="Each factor the advisor weighed, what it points to, and where the numbers came from.">
            <FactorsSection factors={report.factors} />
          </Section>

          <Section id="premium" title="Option premiums right now">
            <PremiumCard premium={report.premium} />
          </Section>

          <Section id="zero-hero" title="Zero-hero (expiry-day lottery) check">
            <ZeroHeroCard zeroHero={report.zeroHero} />
          </Section>

          <Section id="also-know" title="Things you may not know">
            <NumberedList items={report.alsoKnow} tone="know" />
          </Section>

          <Section id="avoid" title="Don't do this today">
            <NumberedList items={report.avoid} tone="avoid" />
          </Section>

          <Section id="sources" title="Sources">
            <SourcesList sources={report.sources} />
          </Section>
        </>
      )}

      {view != null && (view.history.length > 0 || report) && (
        <Section id="history" title="Past briefs" sub="Earlier briefs and how their ideas are doing now.">
          <PastBriefs history={view.history} latestId={report?.id ?? null} nowMs={nowMs} />
        </Section>
      )}

      <div style={{ display: "grid", gap: 14 }}>
        {report?.honesty && <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: C.muted }}>{report.honesty}</p>}
        <Panel style={{ padding: "18px 20px", background: C.panelAlt }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.textStrong, marginBottom: 8 }}>Disclaimer</div>
          <div style={{ display: "grid", gap: 8, fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
            <p style={{ margin: 0 }}>
              Nothing here is investment advice, and the author is not a SEBI-registered investment adviser or research analyst. The brief is written by an AI model from data believed to be reliable but not
              guaranteed; it can be wrong.
            </p>
            <p style={{ margin: 0 }}>
              Options can lose the whole premium within minutes, and gaps, slippage or outages can make losses larger than the &quot;most you can lose&quot; shown. Nothing is ordered from this page.
            </p>
          </div>
        </Panel>
      </div>
    </main>
  );
}
