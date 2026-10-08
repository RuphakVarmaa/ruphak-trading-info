import type { Metadata } from "next";
import CopyDesk from "@/components/Copy/CopyDesk";
import LiveHeader from "@/components/Live/LiveHeader";
import { C } from "@/components/shared/colors";
import { CLAUDE_THEME } from "@/components/shared/theme";
import { EngineProvider } from "@/hooks/useEngineState";
import { getEngineModeQuick, getInitialEngineSnapshot } from "@/lib/engine/snapshot";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Copy trades — Ruphak India Index Desk",
  description: "What the paper engine buys and sells on NIFTY and SENSEX options, with the levels, the setup and the price action, to copy by hand.",
};

type Query = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** `?account=small10k` shows that paper account (no parameter: main); `?id=` selects a trade. */
export default async function CopyPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const rawAccount = first(query.account);
  const account = rawAccount && rawAccount !== "main" && /^[a-z0-9]{1,32}$/.test(rawAccount) ? rawAccount : undefined;
  const rawId = first(query.id);
  const id = rawId && /^[A-Za-z0-9._:-]{1,128}$/.test(rawId) ? rawId : null;
  const [initial, mode] = await Promise.all([getInitialEngineSnapshot(account), getEngineModeQuick()]);
  return (
    <div style={{ ...CLAUDE_THEME, minHeight: "100vh", display: "flex", flexDirection: "column", background: C.bg, color: C.text, fontFamily: "var(--font-inter), 'Inter', sans-serif" }}>
      <EngineProvider key={account ?? "main"} initial={initial} account={account}>
        <LiveHeader serverMode={initial?.state?.mode ?? mode} active="copy" />
        <CopyDesk initialId={id} />
      </EngineProvider>
    </div>
  );
}
