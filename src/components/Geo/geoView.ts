/**
 * Pure view logic for the Geo intel page: placing the engine's scored stories on the map, the
 * map markers, and the per-index "does the news make a trade possible now?" card.
 *
 * Everything comes from the engine's SignalView and EventClusterView, or from the Bing headline
 * feed (context only: it never reaches the engine). Nothing here invents a number.
 */
import type {
  EventClusterView,
  EventContribution,
  EventTaxonomy,
  GateResult,
  ImpactView,
  IndexId,
  RecommendationStatus,
  Regime,
  ScheduledEventView,
  SignalView,
} from "@/engine/api-types";
import { DEFAULT_CONFIG } from "@/engine/config";
import { blocksFor, SIGNAL_MAX_AGE_MS } from "@/lib/copy/action";
import { placeReason, placeText, type PlaceMatch } from "@/lib/geo/places";
import { CHOKEPOINT_WINDOW_HOURS, type ChokepointNews, type IntelItem } from "@/utils/api";

// ---------------------------------------------------------------------------
// Placing stories
// ---------------------------------------------------------------------------

export interface PlacedEvent {
  event: EventClusterView;
  primary: PlaceMatch;
  also: PlaceMatch[];
}

/** |score| × decay still left for one index, or the largest over the indices. 0 while unscored. */
export function activeImpact(e: EventClusterView, index?: IndexId): number {
  if (e.scorer === "pending" || e.impacts.length === 0) return 0;
  const decay = Number.isFinite(e.decayRemaining) ? e.decayRemaining : 0;
  const of = (i: ImpactView) => Math.abs(i.score) * decay;
  if (index) {
    const hit = e.impacts.find((i) => i.index === index);
    return hit ? of(hit) : 0;
  }
  return e.impacts.reduce((m, i) => Math.max(m, of(i)), 0);
}

const msOf = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** Stories whose own title (or, failing that, summary) names a place, and the rest. */
export function placeEvents(events: readonly EventClusterView[]): { placed: PlacedEvent[]; unplaced: EventClusterView[] } {
  const placed: PlacedEvent[] = [];
  const unplaced: EventClusterView[] = [];
  for (const event of events) {
    const { primary, also } = placeText(event.title, event.summary);
    if (primary) placed.push({ event, primary, also });
    else unplaced.push(event);
  }
  placed.sort((a, b) => activeImpact(b.event) - activeImpact(a.event));
  unplaced.sort((a, b) => msOf(b.lastSeenAt) - msOf(a.lastSeenAt));
  return { placed, unplaced };
}

// ---------------------------------------------------------------------------
// Map markers (hex colours: Leaflet writes SVG attributes, so CSS variables do not work there)
// ---------------------------------------------------------------------------

export type GeoLayer = "engine" | "headline" | "chokepoint";

export const MAP_COLORS = {
  bull: "#2f7d4f",
  bear: "#c2412d",
  flat: "#8a8981",
  headline: "#2f6db5",
  cpQuiet: "#8a8981",
  cpInNews: "#b5650d",
  cpHeavy: "#7a3410",
  /** The dark outline of a marker whose story drives a signal now. */
  ring: "#1f1e1d",
} as const;

export interface GeoMarkerItem {
  title: string;
  href: string | null;
  /** True for a link out to a news site (headlines), false for a story page on this site. */
  external: boolean;
  /** "NIFTY ▼0.46 · SENSEX ▼0.52 · 23 min ago · placed by 'RBI'". */
  meta: string;
}

export interface GeoMarker {
  id: string;
  layer: GeoLayer;
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  color: string;
  radius: number;
  /** Drawn hollow (chokepoints). */
  hollow: boolean;
  /** A story here is driving a signal now (thicker outline). */
  ring: boolean;
  /** One line under the name in the popup. */
  summary: string;
  /** How many stories or headlines sit at this place (a chokepoint: its headlines in the window). `items` holds the first few. */
  itemCount: number;
  items: GeoMarkerItem[];
}

/** "23 min ago", "4 h ago", "2 d ago"; empty when the clock is not known yet. */
export function ageText(iso: string, nowMs: number | null): string {
  if (nowMs == null) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const min = Math.max(0, Math.round((nowMs - t) / 60_000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

const signedScore = (x: number) => `${x > 0 ? "▲" : x < 0 ? "▼" : "▬"}${Math.abs(x).toFixed(2)}`;

/** "NIFTY ▼0.46 · SENSEX ▼0.52", or "not scored yet". */
export function impactText(e: EventClusterView): string {
  if (e.scorer === "pending" || e.impacts.length === 0) return "not scored yet";
  return e.impacts.map((i) => `${i.index} ${signedScore(i.score)}`).join(" · ");
}

const dirWord = (d: number) => (d > 0 ? "bullish" : d < 0 ? "bearish" : "no net direction");

/** One marker per place for the engine's stories, coloured by the NIFTY direction still active there. */
export function eventMarkers(placed: readonly PlacedEvent[], driving: ReadonlySet<string>, nowMs: number | null): GeoMarker[] {
  const byPlace = new Map<string, PlacedEvent[]>();
  for (const p of placed) {
    const list = byPlace.get(p.primary.place.id) ?? [];
    list.push(p);
    byPlace.set(p.primary.place.id, list);
  }
  const out: GeoMarker[] = [];
  for (const [placeId, list] of byPlace) {
    const sorted = [...list].sort((a, b) => activeImpact(b.event) - activeImpact(a.event));
    const place = sorted[0].primary.place;
    const strongest = activeImpact(sorted[0].event);
    let niftyNet = 0;
    for (const p of sorted) {
      const n = p.event.impacts.find((i) => i.index === "NIFTY");
      if (n && p.event.scorer !== "pending") niftyNet += n.score * p.event.decayRemaining;
    }
    const dir = Math.abs(niftyNet) < 1e-9 ? 0 : Math.sign(niftyNet);
    out.push({
      id: `ev-${placeId}`,
      layer: "engine",
      placeId,
      name: place.name,
      lat: place.lat,
      lng: place.lng,
      color: dir > 0 ? MAP_COLORS.bull : dir < 0 ? MAP_COLORS.bear : MAP_COLORS.flat,
      radius: strongest >= 0.3 ? 11 : strongest >= 0.1 ? 9 : 7,
      hollow: false,
      ring: sorted.some((p) => driving.has(p.event.clusterId)),
      summary: `${sorted.length} engine stor${sorted.length === 1 ? "y" : "ies"} · NIFTY ${dirWord(dir)} on balance`,
      itemCount: sorted.length,
      items: sorted.slice(0, 4).map((p) => ({
        title: p.event.title,
        href: `/events/${encodeURIComponent(p.event.clusterId)}`,
        external: false,
        meta: [impactText(p.event), ageText(p.event.lastSeenAt, nowMs), placeReason(p.primary), driving.has(p.event.clusterId) ? "drives a signal now" : ""].filter(Boolean).join(" · "),
      })),
    });
  }
  return out;
}

/**
 * Bing headlines placed by the same strict finder (their own location field is ignored), one marker
 * per place. Headlines naming a chokepoint are left to the chokepoint layer.
 */
export function headlineMarkers(items: readonly IntelItem[], nowMs: number | null): GeoMarker[] {
  const byPlace = new Map<string, { item: IntelItem; match: PlaceMatch }[]>();
  for (const item of items) {
    const { primary } = placeText(item.title, item.description);
    if (!primary || primary.place.kind === "chokepoint") continue;
    const list = byPlace.get(primary.place.id) ?? [];
    list.push({ item, match: primary });
    byPlace.set(primary.place.id, list);
  }
  const out: GeoMarker[] = [];
  for (const [placeId, list] of byPlace) {
    const sorted = [...list].sort((a, b) => msOf(b.item.publishedAt) - msOf(a.item.publishedAt));
    const place = sorted[0].match.place;
    out.push({
      id: `hl-${placeId}`,
      layer: "headline",
      placeId,
      name: place.name,
      lat: place.lat,
      lng: place.lng,
      color: MAP_COLORS.headline,
      radius: sorted.length >= 3 ? 6 : 5,
      hollow: false,
      ring: false,
      summary: `${sorted.length} headline${sorted.length === 1 ? "" : "s"} in the feed · context, not scored`,
      itemCount: sorted.length,
      items: sorted.slice(0, 3).map(({ item, match }) => ({
        title: item.title,
        href: item.url || null,
        external: true,
        meta: [item.source, ageText(item.publishedAt, nowMs), placeReason(match)].filter(Boolean).join(" · "),
      })),
    });
  }
  return out;
}

/** The shipping chokepoints, hollow, coloured by how often the headlines name them. */
export function chokepointMarkers(chokepoints: readonly ChokepointNews[], nowMs: number | null): GeoMarker[] {
  return chokepoints.map((cp) => ({
    id: `cp-${cp.spec.id}`,
    layer: "chokepoint" as const,
    placeId: cp.spec.id,
    name: cp.spec.name,
    lat: cp.spec.lat,
    lng: cp.spec.lng,
    color: cp.level === "heavy" ? MAP_COLORS.cpHeavy : cp.level === "in_news" ? MAP_COLORS.cpInNews : MAP_COLORS.cpQuiet,
    radius: cp.level === "heavy" ? 10 : cp.level === "in_news" ? 8 : 6,
    hollow: true,
    ring: false,
    summary: `${cp.count} headline${cp.count === 1 ? "" : "s"} in ${CHOKEPOINT_WINDOW_HOURS} h · news level, not vessel data`,
    itemCount: cp.count,
    items: cp.latest ? [{ title: cp.latest.title, href: cp.latest.url || null, external: true, meta: [cp.latest.source, ageText(cp.latest.publishedAt, nowMs)].filter(Boolean).join(" · ") }] : [],
  }));
}

/**
 * The count on a map layer's toggle: the stories or headlines placed and the places they sit at
 * ("5 · 4 places"), the number of chokepoints, or "no data" while the layer's feed has not loaded
 * (a 0 there would claim the feed is empty).
 */
export function layerChipText(layer: GeoLayer, markers: readonly GeoMarker[], ready: boolean): string {
  if (!ready) return "no data";
  const mine = markers.filter((m) => m.layer === layer);
  if (layer === "chokepoint") return String(mine.length);
  const items = mine.reduce((a, m) => a + m.itemCount, 0);
  return items === 0 ? "0" : `${items} · ${mine.length} place${mine.length === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// The 30-day calendar
// ---------------------------------------------------------------------------

/** Rows the 8-day ScheduledEventsStrip shows: it renders `scheduled.slice(0, 8)`. */
export const STRIP_ROWS = 8;

/**
 * The 30-day calendar minus the events the strip already shows, still ahead of now, in time order.
 * It excludes by id, not by date, so a busy week whose 9th event falls inside the strip's 8-day
 * window still appears here. With no strip data yet, nothing is excluded.
 */
export function moreScheduled(month: readonly ScheduledEventView[], strip: readonly ScheduledEventView[] | null, nowMs: number): ScheduledEventView[] {
  const shown = new Set((strip ?? []).slice(0, STRIP_ROWS).map((e) => e.id));
  return month.filter((e) => !shown.has(e.id) && Date.parse(e.at) > nowMs).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// ---------------------------------------------------------------------------
// The EVENT signal's vote
// ---------------------------------------------------------------------------

export type EventVote =
  | { kind: "absent" }
  | { kind: "disabled"; notes?: string }
  | { kind: "abstain"; notes: string; outOfRegime: boolean }
  | {
      kind: "voting";
      /** The EVENT value: the event pressure index (EPI) at the decision, in [-1, 1]. */
      epi: number;
      weight: number;
      /** w·v / Σw over the voting sources: what EVENT adds to the weighted mean. */
      pull: number;
      /** |w·v| / Σ|w·v| × 100: its share of the signal pull. */
      sharePct: number;
      /** Same sign as the conviction; null when the conviction is 0. */
      sameSide: boolean | null;
      notes?: string;
    };

/** How the EVENT source took part in the conviction, counted as the engine counts it (weight > 0, not abstaining). */
export function eventVote(s: Pick<SignalView, "components" | "conviction">): EventVote {
  const ev = s.components.find((c) => c.source === "EVENT");
  if (!ev) return { kind: "absent" };
  if (!ev.enabled) return { kind: "disabled", notes: ev.notes };
  if (ev.abstain || ev.weight <= 0) {
    const notes = ev.notes ?? (ev.weight <= 0 ? "no weight in this decision" : "no view");
    return { kind: "abstain", notes, outOfRegime: /not used in the .* regime/.test(notes) };
  }
  const active = s.components.filter((c) => c.weight > 0 && !c.abstain && c.source !== "VOL_REGIME");
  const sumW = active.reduce((a, c) => a + c.weight, 0);
  const sumAbs = active.reduce((a, c) => a + Math.abs(c.weight * c.value), 0);
  const wv = ev.weight * ev.value;
  return {
    kind: "voting",
    epi: ev.value,
    weight: ev.weight,
    pull: sumW > 0 ? wv / sumW : 0,
    sharePct: sumAbs > 0 ? (Math.abs(wv) / sumAbs) * 100 : 0,
    sameSide: s.conviction === 0 || ev.value === 0 ? null : Math.sign(ev.value) === Math.sign(s.conviction),
    notes: ev.notes,
  };
}

export interface PressureWords {
  side: "bullish" | "bearish" | "none";
  band: "none" | "weak" | "moderate" | "strong";
}

/** Display bands for the EPI. Below 0.1 the engine's EVENT signal abstains. */
export function pressureWords(epi: number): PressureWords {
  const a = Math.abs(epi);
  if (!Number.isFinite(epi) || a < 0.1) return { side: "none", band: "none" };
  return { side: epi > 0 ? "bullish" : "bearish", band: a < 0.3 ? "weak" : a < 0.6 ? "moderate" : "strong" };
}

// ---------------------------------------------------------------------------
// The engine's verdict and the answer
// ---------------------------------------------------------------------------

export type EngineVerdict =
  | {
      kind: "HOLDING";
      contractLabel: string;
      eventLed: boolean;
      /** +1 for an open CE (gains when the index rises), -1 for an open PE. */
      side: 1 | -1;
    }
  | { kind: "ENTERING"; contractLabel: string }
  | { kind: "ENTER_ADVICE"; contractLabel: string; pausedBy: string[] }
  | { kind: "WAIT"; reason: string; trigger: string | null }
  | { kind: "STALE"; ageMs: number }
  | { kind: "NO_SIGNAL" };

export function engineVerdict(s: SignalView | null, nowMs: number | null): EngineVerdict {
  if (!s) return { kind: "NO_SIGNAL" };
  const at = Date.parse(s.computedAt);
  if (nowMs != null && Number.isFinite(at) && nowMs - at > SIGNAL_MAX_AGE_MS) return { kind: "STALE", ageMs: nowMs - at };
  if (s.position) {
    return { kind: "HOLDING", contractLabel: s.position.contract.label, eventLed: s.position.dominantSource === "EVENT", side: s.position.contract.optionType === "CE" ? 1 : -1 };
  }
  if (s.allGatesPassed && s.contract && s.contract.lots > 0) return { kind: "ENTERING", contractLabel: s.contract.label };
  if (s.advice) return { kind: "ENTER_ADVICE", contractLabel: s.advice.contract.label, pausedBy: s.advice.pausedBy };
  const first = blocksFor(s, DEFAULT_CONFIG.gates.noEntryBeforeIst, DEFAULT_CONFIG.gates.noEntryAfterIst)[0];
  if (first) return { kind: "WAIT", reason: first.reason, trigger: first.trigger };
  return { kind: "WAIT", reason: s.noPlanReason ?? "The engine has no plan for this index right now.", trigger: null };
}

export type GeoAnswerKind =
  | "news_in_entry"
  | "holding_news_with"
  | "holding_news_against"
  | "news_supports_engine_waits"
  | "news_against_reading"
  | "news_silent"
  | "news_not_used"
  | "no_reading";

export interface GeoAnswer {
  kind: GeoAnswerKind;
  /** "Yes" / "Holding" / "Not yet" / "No" / "Unknown": the short word before the sentence. */
  word: string;
  text: string;
  tone: "action" | "hold" | "idle" | "stale";
}

const pct = (x: number) => `${Math.round(x)}%`;
const signed2 = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(2)}`;
const stripDot = (s: string) => s.replace(/[.\s]+$/, "");

export function geoTradeAnswer(index: IndexId, vote: EventVote, verdict: EngineVerdict): GeoAnswer {
  if (verdict.kind === "STALE" || verdict.kind === "NO_SIGNAL") {
    return { kind: "no_reading", word: "Unknown", text: `No fresh engine reading for ${index}, so this cannot be answered now.`, tone: "stale" };
  }
  if (vote.kind === "absent" || vote.kind === "disabled") {
    return { kind: "news_not_used", word: "No", text: `The news signal is not part of ${index}'s decision right now${vote.kind === "disabled" ? " (switched off)" : ""}.`, tone: "idle" };
  }
  if (vote.kind === "abstain") {
    // The engine's notes already say why ("no live events", "6 live stories, no net direction (EPI −0.02)").
    return { kind: "news_silent", word: "No", text: `The news signal abstains for ${index}: ${stripDot(vote.notes)}.`, tone: "idle" };
  }
  if (vote.epi === 0) {
    return { kind: "news_silent", word: "No", text: `The news signal has no net direction for ${index} (EPI 0.00).`, tone: "idle" };
  }
  const lean = vote.epi > 0 ? "bullish" : "bearish";
  const epi = `EPI ${signed2(vote.epi)}`;
  // An open position is judged against its own side: the engine keeps holding after its conviction flips.
  if (verdict.kind === "HOLDING") {
    if (Math.sign(vote.epi) === verdict.side) {
      return {
        kind: "holding_news_with",
        word: "Holding",
        text: `The engine already holds ${verdict.contractLabel}; news supplies ${pct(vote.sharePct)} of the current pull, on the same side. No new entry while it is open.`,
        tone: "hold",
      };
    }
    return { kind: "holding_news_against", word: "Holding", text: `The news now leans ${lean} (${epi}), against the open ${verdict.contractLabel}.`, tone: "stale" };
  }
  if (vote.sameSide == null) {
    // Conviction 0: the engine zeroes the score when too little weight votes, so nothing outweighs the news.
    const why = verdict.kind === "WAIT" ? ` The engine waits: ${stripDot(verdict.reason)}.${verdict.trigger ? ` It would enter when: ${stripDot(verdict.trigger)}.` : ""}` : "";
    return {
      kind: "news_supports_engine_waits",
      word: "Not yet",
      text: `News leans ${lean} (${epi}), but the engine's conviction is 0: too little signal weight has a view.${why}`,
      tone: "idle",
    };
  }
  if (vote.sameSide === false) {
    return {
      kind: "news_against_reading",
      word: "No",
      text: `The news leans ${lean} (${epi}), against the engine's overall reading; the other signals outweigh it.`,
      tone: "idle",
    };
  }
  if (verdict.kind === "ENTERING" || verdict.kind === "ENTER_ADVICE") {
    const what = verdict.kind === "ENTERING" ? `the engine's entry on ${verdict.contractLabel}` : `the engine's ENTER advice on ${verdict.contractLabel}`;
    return {
      kind: "news_in_entry",
      word: "Yes",
      text: `News supplies ${pct(vote.sharePct)} of the pull behind ${what}. Not a profit promise; the news signal has no measured edge yet.`,
      tone: "action",
    };
  }
  return {
    kind: "news_supports_engine_waits",
    word: "Not yet",
    text: `News leans ${lean} (${epi}), but the engine waits: ${stripDot(verdict.reason)}.${verdict.trigger ? ` It would enter when: ${stripDot(verdict.trigger)}.` : ""}`,
    tone: "idle",
  };
}

// ---------------------------------------------------------------------------
// The per-index card
// ---------------------------------------------------------------------------

export interface TopStory {
  clusterId: string;
  title: string;
  taxonomy: EventTaxonomy;
  /** Signed share of the index's event pressure among the top-5 stories. */
  share: number;
  /** This index's impact (from the contributor itself). */
  impact: ImpactView;
  ageMin: number;
  pricedIn: boolean;
  place: PlaceMatch | null;
}

export interface EngineLinkView {
  index: IndexId;
  computedAt: string | null;
  regime: Regime | null;
  conviction: number | null;
  entryThreshold: number | null;
  vote: EventVote;
  pressure: PressureWords | null;
  topStories: TopStory[];
  /** The event_fresh gate when the decision applied it. */
  eventFresh: GateResult | null;
  verdict: EngineVerdict;
  answer: GeoAnswer;
  /** The ₹10k card's status (setup + option flow, not news). */
  reco: { status: RecommendationStatus; headline: string } | null;
}

const impactOf = (c: EventContribution): ImpactView => ({
  index: c.index,
  direction: c.direction,
  score: c.score,
  magnitudePct: c.magnitudePct,
  confidence: c.confidence,
  halfLifeHours: c.halfLifeHours,
});

export function engineLinkFor(index: IndexId, signal: SignalView | null, events: readonly EventClusterView[] | null, nowMs: number | null): EngineLinkView {
  const vote: EventVote = signal ? eventVote(signal) : { kind: "absent" };
  const verdict = engineVerdict(signal, nowMs);
  const byId = new Map((events ?? []).map((e) => [e.clusterId, e]));
  const topStories: TopStory[] = signal
    ? [...signal.contributors]
        .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
        .slice(0, 3)
        .map((c) => {
          const e = byId.get(c.clusterId);
          return {
            clusterId: c.clusterId,
            title: c.title,
            taxonomy: c.taxonomy,
            share: c.weight,
            impact: impactOf(c),
            ageMin: c.ageMin,
            pricedIn: c.pricedIn,
            place: placeText(c.title, e?.summary).primary,
          };
        })
    : [];
  const eventFresh = signal?.gates.find((g) => /event_fresh/i.test(g.gate) && g.passed != null) ?? null;
  // The headline often repeats the status ("WAIT: …"); the card prints the status itself.
  const reco = signal?.recommendation
    ? { status: signal.recommendation.status, headline: signal.recommendation.headline.replace(/^(?:ENTER|WAIT|NO[ _]TRADE)\s*[:·—-]\s*/i, "") }
    : null;
  return {
    index,
    computedAt: signal?.computedAt ?? null,
    regime: signal?.regime ?? null,
    conviction: signal?.conviction ?? null,
    entryThreshold: signal?.entryThreshold ?? null,
    vote,
    pressure: vote.kind === "voting" ? pressureWords(vote.epi) : null,
    topStories,
    eventFresh,
    verdict,
    answer: geoTradeAnswer(index, vote, verdict),
    reco,
  };
}

/** clusterIds named by any index's signal contributors: the stories driving a signal now. */
export function drivingIds(signals: readonly SignalView[] | null): Set<string> {
  const out = new Set<string>();
  for (const s of signals ?? []) for (const c of s.contributors) out.add(c.clusterId);
  return out;
}
