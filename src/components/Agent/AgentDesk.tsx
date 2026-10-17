"use client";

/**
 * The Agent page: the options agent, a paper experiment in which a fast model judges each closed 5-minute
 * candle and code decides every trade. It reads, in order: the honesty banner, the status, one card per index
 * (the latest decisions, the code's checks, sizing, what the code did, the snapshot), escalations, the risk
 * limits (re-arm), calibration, the nightly review with its candidate (approve or reject) and today's cost.
 * It polls every 15 s while the agent is judging candles and every 2 minutes otherwise, never while the tab is
 * hidden; a sequence counter drops a poll that an admin action overtook (the AdvisorDesk pattern).
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentView } from "@/engine/api-types";
import { AGENT_HONESTY } from "@/engine/agent/constants";
import { C } from "@/components/shared/colors";
import { PageHeader, Panel, Section, Skeleton } from "@/components/shared/ui";
import { storeAdminToken, useStoredAdminToken } from "@/hooks/adminToken";
import { errorCode, errorText, fetchEnvelope } from "@/hooks/engineFetch";
import {
  CalibrationPanel,
  CostPanel,
  DemoChip,
  EscalationList,
  HonestyBanner,
  IndexDecisionCard,
  Notice,
  ReviewPanel,
  RiskPanel,
  StatusBar,
  type ActionResult,
} from "./AgentParts";

const AGENT_URL = "/api/engine/agent";
const CANDIDATE_URL = "/api/engine/admin/agent/candidate";
const REARM_URL = "/api/engine/admin/agent/rearm";
export const POLL_ACTIVE_MS = 15_000;
export const POLL_IDLE_MS = 120_000;

/** The poll interval: quick while candles are judged, and while no view has loaded yet; slow otherwise. */
export function pollEveryMs(hasView: boolean, active: boolean): number {
  return !hasView || active ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}

type Source = "engine" | "mock" | null;

const linkStyle = { color: C.gold, fontWeight: 600, textDecoration: "none" } as const;

export default function AgentDesk({ initial, initialSource }: { initial: AgentView | null; initialSource: Source }) {
  const [view, setView] = useState<AgentView | null>(initial);
  const [source, setSource] = useState<Source>(initialSource);
  const [loadError, setLoadError] = useState<string | null>(null);
  const token = useStoredAdminToken();
  const active = view?.status.state === "WAITING" || view?.status.state === "RUNNING";
  const hasView = view != null;
  // Each GET and POST takes a number; a GET answer is dropped when a newer request started after it, so a
  // poll sent just before an approval cannot put the old candidate back on the page.
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const my = ++seq.current;
    try {
      const res = await fetchEnvelope<AgentView>(AGENT_URL);
      if (my !== seq.current) return;
      setView(res.data);
      setSource(res.source);
      setLoadError(null);
    } catch (err) {
      if (my !== seq.current) return;
      setLoadError(errorText(err));
    }
  }, []);

  // Every 15 s while candles are being judged or while there is no view yet (a failed first load retries soon),
  // every 2 minutes otherwise, at once without data; a tab that comes back into view refreshes at once.
  useEffect(() => {
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const every = pollEveryMs(hasView, active);
    const tick = async () => {
      // One poll at a time: a tick already in flight schedules the next one itself.
      if (running) return;
      running = true;
      try {
        if (!document.hidden) await refresh();
      } finally {
        running = false;
      }
      if (!stopped) timer = setTimeout(() => void tick(), every);
    };
    const onVisible = () => {
      if (document.hidden || stopped) return;
      clearTimeout(timer);
      void tick();
    };
    timer = setTimeout(() => void tick(), hasView ? every : 0);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, hasView, refresh]);

  /** An admin POST that answers with the new view. A typed token is kept for the tab once the server accepted it. */
  const post = useCallback(
    async (url: string, payload: Record<string, unknown>, typedToken: string | null): Promise<ActionResult> => {
      const use = typedToken ?? token;
      if (!use) return { ok: false, error: "Enter the admin token." };
      // Polls sent before the action are now stale.
      ++seq.current;
      try {
        const res = await fetchEnvelope<AgentView>(url, { method: "POST", headers: { "content-type": "application/json", "x-admin-token": use }, body: JSON.stringify(payload) }, 20_000);
        // So are polls sent while it was in flight.
        ++seq.current;
        if (typedToken) storeAdminToken(typedToken);
        setView(res.data);
        setSource(res.source);
        setLoadError(null);
        return { ok: true };
      } catch (err) {
        const code = errorCode(err);
        if (code === "UNAUTHORIZED") storeAdminToken(null);
        // A refusal after the token check (a conflict or a bad value) means the token itself was accepted.
        else if (typedToken && (code === "CONFLICT" || code === "BAD_REQUEST")) storeAdminToken(typedToken);
        return { ok: false, error: errorText(err) };
      }
    },
    [token],
  );

  const decide = useCallback((arg: { id: string; decision: "approve" | "reject" }, typedToken: string | null) => post(CANDIDATE_URL, arg, typedToken), [post]);
  const rearm = useCallback((_: void, typedToken: string | null) => post(REARM_URL, {}, typedToken), [post]);

  const hasToken = token != null && token !== "";

  return (
    <main style={{ width: "100%", maxWidth: 900, margin: "0 auto", padding: "28px 16px 64px", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 40, boxSizing: "border-box" }}>
      <PageHeader eyebrow="Paper experiment" title="Agent" right={source === "mock" ? <DemoChip /> : undefined}>
        <HonestyBanner text={view?.honesty ?? AGENT_HONESTY} />
        {view ? (
          <StatusBar view={view} />
        ) : (
          !loadError && (
            <Panel style={{ padding: 20, display: "grid", gap: 12 }}>
              <Skeleton height={28} width="40%" />
              <Skeleton height={18} />
              <Skeleton height={18} width="70%" />
            </Panel>
          )
        )}
        {loadError && <Notice tone="error">Could not refresh the agent: {loadError} The page keeps what it has and tries again.</Notice>}
      </PageHeader>

      {view && (
        <>
          <Section
            id="decisions"
            title="The latest candle"
            sub="For each index: what the model said about each finalist (the trades it may consider), the code's own checks, the size, and what the code did. Finalists are each index's best call or put now, plus the morning brief's ideas."
          >
            <div style={{ display: "grid", gap: 16 }}>
              {view.indices.map((card) => (
                <IndexDecisionCard key={card.index} card={card} view={view} />
              ))}
            </div>
          </Section>

          <Section id="escalations" title="Escalations to the deep model" sub="When the fast model is unsure on a good setup, or the regime flips to crisis, a slower model re-reads the candle. Its answer applies to the next candle, through the same checks.">
            <EscalationList escalations={view.escalations} finalists={view.finalists} generatedAt={view.generatedAt} />
          </Section>

          <Section id="risk" title="Risk limits" sub="Hard limits in code: the model can never change or override them.">
            <RiskPanel risk={view.risk} mode={view.mode} enabled={view.enabled} status={view.status} hasToken={hasToken} onRearm={rearm} generatedAt={view.generatedAt} />
          </Section>

          <Section id="calibration" title="Is the confidence honest?" sub="Calibration: how often calls at each stated confidence turned out right, and what that means for sizing.">
            <CalibrationPanel cal={view.calibration} />
          </Section>

          <Section id="review" title="Nightly review" sub="After the close a deep model reviews the session and may propose a new guidance text. You approve or reject it here.">
            <ReviewPanel review={view.review} candidate={view.candidate} generatedAt={view.generatedAt} hasToken={hasToken} onDecide={decide} />
          </Section>

          <Section id="cost" title="Today's cost">
            <CostPanel cost={view.cost} />
          </Section>
        </>
      )}

      <div style={{ display: "grid", gap: 14 }}>
        {view?.account && view.enabled && (
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: C.muted }}>
            The agent&apos;s paper book ({view.account.label}) is on{" "}
            <Link href="/live?account=agent" className="link-quiet" style={linkStyle}>
              Live P&amp;L
            </Link>{" "}
            and the{" "}
            <Link href="/?account=agent" className="link-quiet" style={linkStyle}>
              Paper Engine
            </Link>{" "}
            page.
          </p>
        )}
        <Panel style={{ padding: "18px 20px", background: C.panelAlt }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.textStrong, marginBottom: 8 }}>Disclaimer</div>
          <div style={{ display: "grid", gap: 8, fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
            <p style={{ margin: 0 }}>
              Nothing here is investment advice, and the author is not a SEBI-registered investment adviser or research analyst. The agent trades a paper account only: no order from it
              ever reaches a broker.
            </p>
            <p style={{ margin: 0 }}>
              A model&apos;s confidence is not a probability until graded results show it is. Options can lose the whole premium within minutes, and this project&apos;s research found no
              edge for option buyers.
            </p>
          </div>
        </Panel>
      </div>
    </main>
  );
}
