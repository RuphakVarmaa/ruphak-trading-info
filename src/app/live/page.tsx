import type { Metadata } from "next";
import LiveBook from "@/components/Live/LiveBook";
import LiveHeader from "@/components/Live/LiveHeader";
import { C } from "@/components/shared/colors";
import { CLAUDE_THEME } from "@/components/shared/theme";
import { EngineProvider } from "@/hooks/useEngineState";
import { getEngineModeQuick, getInitialEngineSnapshot } from "@/lib/engine/snapshot";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Live P&L — Ruphak India Index Desk",
  description: "Today's paper-trading P&L, open NIFTY option positions, and whether the market and option-price feeds are coming through.",
};

/** `?account=small10k` shows that paper account; no parameter (or "main") shows the main account. */
function accountFrom(query: Record<string, string | string[] | undefined>): string | undefined {
  const raw = Array.isArray(query.account) ? query.account[0] : query.account;
  return raw && raw !== "main" && /^[a-z0-9]{1,32}$/.test(raw) ? raw : undefined;
}

export default async function LivePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const account = accountFrom(await searchParams);
  const [initial, mode] = await Promise.all([getInitialEngineSnapshot(account), getEngineModeQuick()]);
  return (
    <div style={{ ...CLAUDE_THEME, minHeight: "100vh", display: "flex", flexDirection: "column", background: C.bg, color: C.text }}>
      <EngineProvider key={account ?? "main"} initial={initial} account={account}>
        <LiveHeader serverMode={initial?.state?.mode ?? mode} />
        <LiveBook />
      </EngineProvider>
    </div>
  );
}
