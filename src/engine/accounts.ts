/**
 * Paper accounts. "main" is the engine's own book; every other account follows main's signals with
 * its own capital, strike choice, sizing, loss caps and exits, and is never LIVE. Pure (no I/O), so
 * the dashboard can import it.
 */
import { withOverrides, type DeepPartial, type EngineConfig } from "./config";
import type { TradingMode } from "./types";

export const ACCOUNT_IDS = ["main", "small10k"] as const;
export type AccountId = (typeof ACCOUNT_IDS)[number];

export interface AccountSpec {
  id: AccountId;
  label: string;
  /** Prefix for alerts and compact UI. */
  shortLabel: string;
  paperOnly: boolean;
  /**
   * Applied on top of the Worker config. It pins every value the account depends on, so the main
   * account's Worker variables (capital, indices, position and entry limits) cannot leak in.
   */
  configPatch: DeepPartial<EngineConfig>;
}

export const ACCOUNTS: Record<AccountId, AccountSpec> = {
  main: { id: "main", label: "Main account", shortLabel: "Main", paperOnly: false, configPatch: {} },
  small10k: {
    id: "small10k",
    label: "₹10k account",
    shortLabel: "₹10k",
    paperOnly: true,
    configPatch: {
      capitalRupees: 10_000,
      indices: ["NIFTY", "SENSEX"],
      // One lot of the strike nearest the money that costs about ₹2,600–4,500: ₹40–70 for NIFTY's
      // 65 units, ₹130–210 for SENSEX's 20 (its weekly expiry is further away on most days, so the
      // band sits up to 20 strikes out).
      selection: {
        mode: "PREMIUM_BAND",
        minPremium: 40,
        maxPremium: 70,
        maxOtmSteps: 8,
        maxQuotes: 4,
        byIndex: { SENSEX: { minPremium: 130, maxPremium: 210, maxOtmSteps: 20 } },
      },
      sizing: {
        defaultRiskPct: 15,
        minRiskPct: 12,
        maxRiskPctPerTrade: 20,
        maxPremiumPctPerTrade: 50,
        maxCombinedPremiumPct: 50,
        maxLots: 1,
        maxOpenPerIndex: 1,
        // One position at a time across NIFTY and SENSEX.
        maxOpenTotal: 1,
        maxTradesPerDay: 3,
        useCurrentEquity: true,
      },
      risk: { dailyLossCapPct: 25, weeklyLossCapPct: 40, maxConsecutiveLossesPerDay: 2, prospectiveLossCap: true },
      exits: { stopPct: -35, targetPct: 60 },
    },
  },
};

export function accountSpec(id: AccountId): AccountSpec {
  return ACCOUNTS[id];
}

/** The account's engine config: the Worker config for main, otherwise the Worker config with the account's patch. */
export function accountConfig(base: EngineConfig, id: AccountId): EngineConfig {
  return id === "main" ? base : withOverrides(base, ACCOUNTS[id].configPatch);
}

/** Known account id, "main" when empty, or null when the value names no account. */
export function parseAccountId(raw: string | null | undefined): AccountId | null {
  const text = (raw ?? "").trim();
  if (text === "") return "main";
  return (ACCOUNT_IDS as readonly string[]).includes(text) ? (text as AccountId) : null;
}

/** Comma-separated account ids ("main,small10k"). Main is always first; unknown names and duplicates are dropped. */
export function parseAccounts(raw: string | undefined): AccountId[] {
  const out: AccountId[] = ["main"];
  for (const part of (raw ?? "").split(",")) {
    const id = parseAccountId(part);
    if (id && part.trim() !== "" && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The mode stored for an account's book: "PAPER" for main, "PAPER@small10k" for the ₹10k account. */
export function bookMode(account: AccountId, mode: TradingMode): string {
  return account === "main" ? mode : `${mode}@${account}`;
}

/** Inverse of bookMode. */
export function unbookMode(stored: string): TradingMode {
  const at = stored.indexOf("@");
  return (at < 0 ? stored : stored.slice(0, at)) as TradingMode;
}

/** The account a stored mode belongs to. */
export function bookAccount(stored: string): AccountId | null {
  const at = stored.indexOf("@");
  return at < 0 ? "main" : parseAccountId(stored.slice(at + 1));
}

/** Key for account-owned engine state (kv); main keeps its existing keys. */
export function accountStateKey(account: AccountId, key: string): string {
  return account === "main" ? key : `acct:${account}:${key}`;
}
