import type { Metadata } from "next";
import { ACCOUNTS, parseAccountId } from "@/engine/accounts";
import CopyDesk from "@/components/Copy/CopyDesk";
import LiveHeader from "@/components/Live/LiveHeader";
import { C } from "@/components/shared/colors";
import { CLAUDE_THEME } from "@/components/shared/theme";
import { EngineProvider } from "@/hooks/useEngineState";
import { getEngineModeQuick, getInitialEngineSnapshot } from "@/lib/engine/snapshot";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Copy trades — Ruphak India Index Desk",
  description: "What to do now on NIFTY and SENSEX options, from the paper engine's trades: the exact order to copy, its levels, the setup and the price action.",
};

type Query = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The agent's paper account is a model's experiment: its trades are never offered for copying, so it reads as main here. */
const isAgent = (raw: string) => {
  const id = parseAccountId(raw);
  return id != null && ACCOUNTS[id].kind === "agent";
};

/** `?account=small10k` shows that paper account (no parameter: main; the agent's account is ignored); `?id=` selects a trade. */
export default async function CopyPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const rawAccount = first(query.account);
  const account = rawAccount && rawAccount !== "main" && /^[a-z0-9]{1,32}$/.test(rawAccount) && !isAgent(rawAccount) ? rawAccount : undefined;
  const rawId = first(query.id);
  const id = rawId && /^[A-Za-z0-9._:-]{1,128}$/.test(rawId) ? rawId : null;
  const [initial, mode] = await Promise.all([getInitialEngineSnapshot(account), getEngineModeQuick()]);
  return (
    <div style={{ ...CLAUDE_THEME, minHeight: "100vh", display: "flex", flexDirection: "column", background: C.bg, color: C.text }}>
      <EngineProvider key={account ?? "main"} initial={initial} account={account}>
        <LiveHeader serverMode={initial?.state?.mode ?? mode} active="copy" />
        <CopyDesk initialId={id} account={account} />
      </EngineProvider>
    </div>
  );
}
