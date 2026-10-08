import type { Metadata } from "next";
import BacktestClient from "@/components/Backtest/BacktestClient";
import { C } from "@/components/shared/colors";
import SiteHeader from "@/components/shared/SiteHeader";
import { paramsFromQuery } from "@/lib/backtestParams";
import { getEngineModeQuick } from "@/lib/engine/snapshot";
import { todayIst } from "@/lib/ist";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Backtest — Ruphak India Index Desk",
  description: "Replay the event-driven NIFTY / SENSEX options strategy over past sessions with adjustable thresholds, stops and a no-events baseline.",
};

export default async function BacktestPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const today = todayIst();
  const initialParams = paramsFromQuery(query, today);
  const runIdRaw = Array.isArray(query.runId) ? query.runId[0] : query.runId;
  const initialRunId = runIdRaw && /^[A-Za-z0-9._:-]{1,128}$/.test(runIdRaw) ? runIdRaw : null;
  const mode = await getEngineModeQuick();

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: C.bg, color: C.text }}>
      <SiteHeader active="backtest" mode={mode} />
      <BacktestClient initialParams={initialParams} initialRunId={initialRunId} todayIst={today} />
    </div>
  );
}
