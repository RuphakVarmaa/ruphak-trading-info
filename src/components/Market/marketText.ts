/**
 * Plain-language text for the live index components: feed ages, freshness labels, the change against the
 * previous close and the market-phase sentence. Pure, so it is unit-tested.
 */
import { fmtIstDay, fmtIstHm, fmtNum, fmtPct } from "@/components/shared/format";
import { LIVE_POLL_MS, OFFLINE_AFTER_MS, type Freshness, type LiveIndex, type LiveIndicesFeed, type LiveVix } from "@/lib/market/liveIndices";

/** While the market is open, a last trade older than this (against the payload time) reads as stale. */
export const LAGGING_TRADE_MS = 3 * 60_000;

/** Feed age: "1 s", "14 s", "2 min", "1 h 5 min", "2 d". */
export function fmtFeedAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** "Live · 1 s", "Stale · 14 s", "Offline · 2 min", "Connecting…". */
export function freshnessLabel(freshness: Freshness, ageMs: number | null): string {
  if (freshness === "loading" || ageMs == null) return "Connecting…";
  const word = freshness === "live" ? "Live" : freshness === "stale" ? "Stale" : "Offline";
  return `${word} · ${fmtFeedAge(ageMs)}`;
}

export interface EntryFreshness {
  freshness: Freshness;
  ageMs: number | null;
  /** Why the entry is not live, in a sentence; null when it is. */
  note: string | null;
}

/**
 * Freshness of one entry (an index or VIX) from the poll's freshness and age plus what the payload says: a
 * value served after a failed upstream fetch is stale by its own fetch age, and while the market is open a
 * last trade over 3 minutes old is stale too.
 */
export function entryFreshness(
  feed: LiveIndicesFeed | null,
  entry: Pick<LiveIndex, "asOf" | "stale" | "fetchedAt"> | null,
  freshness: Freshness,
  ageMs: number | null,
): EntryFreshness {
  if (!feed || freshness === "loading" || ageMs == null) return { freshness: "loading", ageMs: null, note: null };
  if (freshness === "offline") return { freshness, ageMs, note: `No answer from the server for ${fmtFeedAge(ageMs)}; these are the last prices received.` };
  const served = Date.parse(feed.generatedAt);
  const fetched = Date.parse(entry?.fetchedAt ?? feed.fetchedAt);
  if (entry?.stale ?? feed.stale) {
    const dataAge = ageMs + (Number.isFinite(served) && Number.isFinite(fetched) ? Math.max(0, served - fetched) : 0);
    return {
      freshness: dataAge > OFFLINE_AFTER_MS ? "offline" : "stale",
      ageMs: dataAge,
      note: `Yahoo Finance did not answer the latest refresh; this value was fetched ${fmtFeedAge(dataAge)} ago.`,
    };
  }
  if (feed.marketPhase === "OPEN" && entry) {
    const tradeAge = served - Date.parse(entry.asOf);
    if (Number.isFinite(tradeAge) && tradeAge > LAGGING_TRADE_MS) {
      return { freshness: "stale", ageMs: tradeAge + ageMs, note: `No new trade from Yahoo Finance for ${fmtFeedAge(tradeAge + ageMs)}.` };
    }
  }
  if (freshness === "stale") return { freshness, ageMs, note: `No update from the server for ${fmtFeedAge(ageMs)}.` };
  return { freshness, ageMs, note: null };
}

/** Signed, en-IN grouped: "+1,045.46", "−371.25", "0.00". */
export function fmtSignedGrouped(x: number, decimals = 2): string {
  if (Number(Math.abs(x).toFixed(decimals)) === 0) return fmtNum(0, decimals);
  return `${x < 0 ? "−" : "+"}${fmtNum(Math.abs(x), decimals)}`;
}

/** Change against the previous close: "−1,045.46 (−1.44%)" with its direction; "—" when the previous close is unknown. */
export function changeText(index: Pick<LiveIndex, "change" | "changePct">, decimals = 2): { text: string; dir: number } {
  if (index.change == null || index.changePct == null) return { text: "—", dir: 0 };
  const shown = Number(index.change.toFixed(decimals));
  return { text: `${fmtSignedGrouped(index.change, decimals)} (${fmtPct(index.changePct, 2)})`, dir: Math.sign(shown) };
}

/** "22,179.90 – 22,599.05", or "—". */
export function rangeText(low: number | null | undefined, high: number | null | undefined): string {
  return low != null && high != null ? `${fmtNum(low)} – ${fmtNum(high)}` : "—";
}

const vixFormat = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** India VIX keeps its own precision (it moves in 0.0025 steps), so value, previous close and change add up. */
export function vixText(vix: Pick<LiveVix, "price" | "prevClose" | "change" | "changePct">): { value: string; prevClose: string | null; change: string; dir: number } {
  const signed = (x: number) => `${x < 0 ? "−" : x > 0 ? "+" : ""}${vixFormat.format(Math.abs(x))}`;
  return {
    value: vixFormat.format(vix.price),
    prevClose: vix.prevClose != null ? vixFormat.format(vix.prevClose) : null,
    change: vix.change != null && vix.changePct != null ? `${signed(vix.change)} (${fmtPct(vix.changePct, 2)})` : "—",
    dir: vix.change != null ? Math.sign(vix.change) : 0,
  };
}

export interface PanelStatus {
  /** wait = grey, stale = orange, down = red. */
  tone: "wait" | "stale" | "down";
  text: string;
}

/** The panel's status line as plain sentences (no codes), or null while everything is live. */
export function panelStatus(
  state: { data: LiveIndicesFeed | null; error: string | null; freshness: Freshness; ageMs: number | null },
  pollMs: number,
): PanelStatus | null {
  const { data, error, freshness, ageMs } = state;
  const retry = `Trying again every ${pollMs < 60_000 ? `${pollMs / 1000} s` : `${Math.round(pollMs / 60_000)} min`}.`;
  if (!data) return error ? { tone: "down", text: `The index feed did not load. ${error} ${retry}` } : { tone: "wait", text: "Connecting to the index feed…" };
  if (freshness === "offline" && ageMs != null) {
    return { tone: "down", text: `No update for ${fmtFeedAge(ageMs)}. ${error ?? "The server is not answering."} Showing the last prices received. ${retry}` };
  }
  if (data.stale && ageMs != null) {
    const lag = Math.max(0, Date.parse(data.generatedAt) - Date.parse(data.fetchedAt)) || 0;
    return { tone: "stale", text: `Yahoo Finance did not answer the latest refresh, so these prices were fetched ${fmtFeedAge(ageMs + lag)} ago.` };
  }
  if (freshness === "stale" && ageMs != null) return { tone: "stale", text: `Updates are late: the last one arrived ${fmtFeedAge(ageMs)} ago.${error ? ` ${error}` : ""}` };
  if (data.missing.length > 0) {
    const names = data.missing.map((id) => (id === "NIFTY" ? "NIFTY 50" : id)).join(" and ");
    return { tone: "stale", text: `${names} did not load from Yahoo Finance; ${data.missing.length > 1 ? "they" : "it"} will show when a refresh brings ${data.missing.length > 1 ? "them" : "it"}.` };
  }
  return null;
}

/** IST date (YYYY-MM-DD) of an ISO time. */
const istDateOf = (iso: string): string => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);

/** "today's session" or "the Thu 08 Oct session" for a session date, judged at the payload time. */
export function sessionPhrase(session: string, generatedAt: string): string {
  return session === istDateOf(generatedAt) ? "today's session" : `the ${fmtIstDay(`${session}T12:00:00+05:30`)} session`;
}

/** One sentence on what the market is doing and what the bars show. */
export function phaseSentence(feed: LiveIndicesFeed): string {
  const session = feed.indices[0]?.session;
  const showing = session ? ` Showing ${sessionPhrase(session, feed.generatedAt)}.` : "";
  const next = feed.nextOpenAt ? ` Next open ${fmtIstDay(feed.nextOpenAt)}, ${fmtIstHm(feed.nextOpenAt)} IST.` : "";
  switch (feed.marketPhase) {
    case "OPEN":
      return `Market open. 1-minute bars, refreshed every ${LIVE_POLL_MS / 1000} s.`;
    case "PRE_OPEN":
      return `Pre-open: trading starts at 09:15 IST.${showing}`;
    case "HOLIDAY":
      return `${feed.holidayName === "Weekend" ? "Weekend: the market is shut." : feed.holidayName ? `Exchange holiday (${feed.holidayName}).` : "Exchange holiday."}${showing}${next}`;
    default:
      return `Market closed.${showing}${next}`;
  }
}
