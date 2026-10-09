/**
 * WP7 research (main ₹5L paper account only; NOT for the ₹5k/₹10k buy-only accounts and NOT for the
 * live engine): end-of-day backtest of an overnight defined-risk short-premium rule on real exchange
 * prices (bhavcopy cache from scripts/fetch-bhavcopy.ts).
 *
 *   npx tsx scripts/research/overnight_vol.ts [--from 2019-01-01 --to 2026-10-08 --capital 500000 --risk-pct 2]
 *
 * Rule (as specified in the plan, nothing fitted): at the close of each session sell the ATM straddle of
 * the nearest weekly that does not expire that day and buy wings `w` strikes away (iron fly, w = 2 or 3);
 * buy it all back at the next session's open. ATM = listed strike nearest the options' own put-call-parity
 * forward at the close (the official index close has been an auction price since 3 Aug 2026 and can sit
 * 0.2-0.8% away from where options trade). Lots: as many as keep the expiry max loss (width - credit)
 * within --risk-pct of capital AND the estimated margin within capital.
 *
 * Prices are bhavcopy prices: entry = closing price (NSE: VWAP of the last 30 minutes; BSE: published
 * close), exit = first trade of the next session. Neither is a tradeable 15:05 / 09:20 quote; see
 * docs/research/overnight-short-vol.md for what that does to the result.
 *
 * Margin estimate (approximation, not SPAN): width x qty (the defined risk) + extreme-loss margin of 2% of
 * the short legs' notional (NSE Clearing), + another 2% when the next session is the expiry day
 * (SEBI, from 20 Nov 2024). Brokers' calculators may differ.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parityForward, nearestStrike, type BhavRow } from "../../src/engine/backtest/realPrices";
import { computeCharges } from "../../src/engine/broker/charges";
import { daysBetween } from "../../src/engine/clock";
import { ROOT, num, parseArgs, str } from "../lib/node";
import {
  RESEARCH_INDICES,
  SPREAD_SCENARIOS,
  badPrint,
  loadResearchData,
  logTrial,
  md,
  nextExpiry,
  spotClose,
  spotOpen,
  stats,
  tYears,
  type ResearchData,
  type ResearchIndex,
} from "./real_prices";

interface Night {
  index: ResearchIndex["id"];
  date: string;
  next: string;
  expiry: string;
  dte: number;
  gapDays: number;
  wings: number;
  k0: number;
  lot: number;
  credit: number;
  debit: number;
  width: number;
  /** Index move close -> next open (official close to official open). */
  gap: number;
  /** Per unit, after the spread scenario but before charges. */
  pnlUnitGross: number;
  pnlUnitNet: number;
  lots: number;
  qty: number;
  margin: number;
  maxLoss: number;
  rupees: number;
  charges: number;
  intoExpiry: boolean;
}

const ok = (r: BhavRow | undefined, f: "open" | "close"): r is BhavRow => !!r && r.contracts > 0 && r[f] !== null && (r[f] as number) > 0;

/**
 * exit "open": the four legs' first trades of the next session; "vwap": the next session's day VWAPs
 * (an executable average, but a longer hold than the rule). Credit and debit are clamped to
 * [0, width]: an iron fly's buy-back value cannot exceed its wing width, so a sum of opening prints
 * outside that range is an artefact of asynchronous first trades (counted in skipped.clamped).
 */
function buildNights(
  data: ResearchData,
  idx: ResearchIndex,
  wings: number,
  o: { from: string; to: string; capital: number; riskPct: number; spread: number; exit: "open" | "vwap" },
): { nights: Night[]; skipped: Record<string, number> } {
  const { book } = data;
  const sc = SPREAD_SCENARIOS[o.spread];
  const skipped: Record<string, number> = { noForward: 0, missingLeg: 0, badPrint: 0, tooRisky: 0, clamped: 0 };
  const nights: Night[] = [];
  for (const date of book.dates(idx.id)) {
    if (date < o.from || date > o.to || data.special.has(date)) continue;
    const next = book.nextDate(idx.id, date);
    if (!next || next > o.to || data.special.has(next)) continue;
    const expiry = nextExpiry(book, idx.id, date);
    if (!expiry) continue;
    const t = tYears(data, date, "15:15", expiry);
    const fwd = parityForward(book, idx.id, date, expiry, "close", { r: data.cfg.pricing.r, tYears: t });
    const s0 = spotClose(data, idx, date);
    const s1 = spotOpen(data, idx, next);
    if (!fwd || !s0 || !s1) {
      skipped.noForward++;
      continue;
    }
    const strikes = book.strikes(idx.id, date, expiry);
    const k0 = nearestStrike(strikes, fwd.forward)!;
    const kc = k0 + wings * idx.step;
    const kp = k0 - wings * idx.step;
    const legs = [
      { k: k0, type: "CE" as const, short: true },
      { k: k0, type: "PE" as const, short: true },
      { k: kc, type: "CE" as const, short: false },
      { k: kp, type: "PE" as const, short: false },
    ].map((l) => ({ ...l, a: book.option(idx.id, date, expiry, l.k, l.type), b: book.option(idx.id, next, expiry, l.k, l.type) }));
    const exitPx = (r: BhavRow | undefined) => (o.exit === "open" ? r?.open ?? null : r?.vwap ?? null);
    if (legs.some((l) => !ok(l.a, "close") || !l.b || l.b.contracts <= 0 || !(exitPx(l.b)! > 0))) {
      skipped.missingLeg++;
      continue;
    }
    const gap = s1 / s0 - 1;
    if (legs.some((l) => badPrint(exitPx(l.b)!, l.a!.close, gap))) {
      skipped.badPrint++;
      continue;
    }
    const sign = (l: (typeof legs)[number]) => (l.short ? 1 : -1);
    const width = wings * idx.step;
    const rawCredit = legs.reduce((s, l) => s + sign(l) * l.a!.close!, 0);
    const rawDebit = legs.reduce((s, l) => s + sign(l) * exitPx(l.b)!, 0);
    const credit = Math.min(Math.max(rawCredit, 0), width);
    const debit = Math.min(Math.max(rawDebit, 0), width);
    if (credit !== rawCredit || debit !== rawDebit) skipped.clamped++;
    const halfSpreads = legs.reduce((s, l) => s + sc.spread(l.a!.close!) / 2 + sc.spread(exitPx(l.b)!) / 2, 0);
    const lot = legs[0].a!.lot ?? 1;
    const intoExpiry = next === expiry;
    const maxLossUnit = Math.max(width - credit, 0.05);
    const marginLot = width * lot + 0.02 * k0 * lot * 2 * (intoExpiry ? 2 : 1);
    const lots = Math.min(Math.floor((o.capital * o.riskPct) / 100 / (maxLossUnit * lot)), Math.floor(o.capital / marginLot));
    if (lots < 1) {
      skipped.tooRisky++;
      continue;
    }
    const qty = lots * lot;
    let charges = 0;
    for (const l of legs) {
      charges += computeCharges(l.short ? "SELL" : "BUY", l.a!.close!, qty, idx.exchange, date).total;
      charges += computeCharges(l.short ? "BUY" : "SELL", exitPx(l.b)!, qty, idx.exchange, next).total;
    }
    const pnlUnitGross = credit - debit - halfSpreads;
    nights.push({
      index: idx.id,
      date,
      next,
      expiry,
      dte: book.sessionsToExpiry(idx.id, date, expiry),
      gapDays: daysBetween(date, next),
      wings,
      k0,
      lot,
      credit,
      debit,
      width,
      gap,
      pnlUnitGross,
      pnlUnitNet: pnlUnitGross - charges / qty,
      lots,
      qty,
      margin: lots * marginLot,
      maxLoss: maxLossUnit * qty,
      rupees: pnlUnitGross * qty - charges,
      charges,
      intoExpiry,
    });
  }
  return { nights, skipped };
}

function maxDrawdown(xs: number[]): number {
  let peak = 0;
  let eq = 0;
  let dd = 0;
  for (const x of xs) {
    eq += x;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return dd;
}

const pct = (x: number, d = 2) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : "–");
const inr = (x: number) => (Number.isFinite(x) ? `₹${Math.round(x).toLocaleString("en-IN")}` : "–");

async function main(): Promise<void> {
  const args = parseArgs();
  const from = str(args, "from", "2019-01-01")!;
  const to = str(args, "to", "2026-10-08")!;
  const capital = num(args, "capital", 500_000);
  const riskPct = num(args, "risk-pct", 2);
  const data = await loadResearchData({ from, to, dir: str(args, "dir", undefined) });
  const out: string[] = [];
  const json: Record<string, unknown> = {};
  const summary: (string | number)[][] = [[
    "index", "wings", "nights", "sessions", "credit/unit (median)", "gross/unit mean (spread incl.)", "t", "net ₹ total", "net ₹/night mean", "hit", "worst night ₹", "5th pct night ₹", "max DD ₹", "median lots", "median margin ₹", "net ₹ / avg margin, annualised",
  ]];
  const variants: { wings: number; spread: number; exit: "open" | "vwap" }[] = [
    { wings: 2, spread: 2, exit: "open" },
    { wings: 2, spread: 0, exit: "open" },
    { wings: 3, spread: 2, exit: "open" },
    { wings: 3, spread: 0, exit: "open" },
    { wings: 2, spread: 2, exit: "vwap" },
  ];
  for (const idx of RESEARCH_INDICES) {
    for (const { wings, spread, exit } of variants) {
      {
        const { nights, skipped } = buildNights(data, idx, wings, { from, to, capital, riskPct, spread, exit });
        if (nights.length === 0) continue;
        const rupees = nights.map((n) => n.rupees);
        const s = stats(rupees);
        const g = stats(nights.map((n) => n.pnlUnitGross));
        const sorted = [...rupees].sort((a, b) => a - b);
        const avgMargin = nights.reduce((a, n) => a + n.margin, 0) / nights.length;
        const years = Math.max(daysBetween(nights[0].date, nights.at(-1)!.next) / 365, 0.1);
        const total = rupees.reduce((a, b) => a + b, 0);
        const label = `${SPREAD_SCENARIOS[spread].name}, exit at ${exit === "open" ? "next open" : "next-day VWAP"}`;
        summary.push([
          `${idx.id} (${label})`,
          wings,
          nights.length,
          `${nights[0].date} .. ${nights.at(-1)!.next}`,
          (nights.map((n) => n.credit).sort((a, b) => a - b)[Math.floor(nights.length / 2)]).toFixed(1),
          g.mean.toFixed(2),
          g.t.toFixed(2),
          inr(total),
          inr(s.mean),
          pct(s.hit, 0),
          inr(sorted[0]),
          inr(sorted[Math.floor(0.05 * (sorted.length - 1))]),
          inr(maxDrawdown(rupees)),
          nights.map((n) => n.lots).sort((a, b) => a - b)[Math.floor(nights.length / 2)],
          inr(nights.map((n) => n.margin).sort((a, b) => a - b)[Math.floor(nights.length / 2)]),
          pct(total / years / avgMargin, 1),
        ]);
        json[`${idx.id}.w${wings}.${spread}.${exit}`] = { stats: s, grossUnit: g, total, skipped, maxDD: maxDrawdown(rupees), avgMargin, years };
        logTrial({
          wp: "WP7",
          variant: `overnight-ironfly-${idx.id}-w${wings}-spread-${spread === 0 ? "none" : "engine"}-exit-${exit}`,
          params: { wings, capital, riskPct, spread: SPREAD_SCENARIOS[spread].name, exit, atm: "parity forward at the close", from, to },
          data: `bhavcopy ${idx.exchange} close -> next open + Yahoo daily`,
          trades: nights.length,
          net: Math.round(total * 100) / 100,
          notes: `mean ₹${s.mean.toFixed(0)}/night (t ${s.t.toFixed(2)}), worst ₹${sorted[0].toFixed(0)}, max DD ₹${maxDrawdown(rupees).toFixed(0)}; skipped ${JSON.stringify(skipped)}`,
        });
        if (spread !== 2 || wings !== 2 || exit !== "open") continue;
        // Detail for the base case (2-strike wings, engine spread model).
        const byYear: (string | number)[][] = [["year", "nights", "net ₹", "mean ₹/night", "t", "worst ₹"]];
        for (const y of [...new Set(nights.map((n) => n.date.slice(0, 4)))].sort()) {
          const xs = nights.filter((n) => n.date.startsWith(y)).map((n) => n.rupees);
          const st = stats(xs);
          byYear.push([y, xs.length, inr(xs.reduce((a, b) => a + b, 0)), inr(st.mean), st.t.toFixed(2), inr(Math.min(...xs))]);
        }
        const absGap = nights.map((n) => Math.abs(n.gap));
        const cut = [...absGap].sort((a, b) => a - b)[Math.floor(0.9 * (absGap.length - 1))];
        const sub = (label: string, ns: Night[]) => {
          const st = stats(ns.map((n) => n.rupees));
          return [label, ns.length, inr(ns.reduce((a, n) => a + n.rupees, 0)), inr(st.mean), st.t.toFixed(2)];
        };
        const splits = md([
          ["subset", "nights", "net ₹", "mean ₹/night", "t"],
          sub("weekday nights (next calendar day)", nights.filter((n) => n.gapDays === 1)),
          sub("weekend/holiday nights", nights.filter((n) => n.gapDays >= 2)),
          sub("into expiry day", nights.filter((n) => n.intoExpiry)),
          sub("not into expiry day", nights.filter((n) => !n.intoExpiry)),
          sub(`|gap| < ${pct(cut)} (90% of nights)`, nights.filter((n) => Math.abs(n.gap) < cut)),
          sub(`|gap| >= ${pct(cut)} (top decile)`, nights.filter((n) => Math.abs(n.gap) >= cut)),
          sub("gap beyond the wing (|index move| > width / strike)", nights.filter((n) => Math.abs(n.gap) > n.width / n.k0)),
        ]);
        const worst = [...nights].sort((a, b) => a.rupees - b.rupees).slice(0, 8);
        const worstTable = md([
          ["night", "gap", "credit/unit", "debit/unit", "lots", "net ₹", "max loss ₹ (expiry)"],
          ...worst.map((n) => [`${n.date} -> ${n.next}`, pct(n.gap), n.credit.toFixed(1), n.debit.toFixed(1), n.lots, inr(n.rupees), inr(n.maxLoss)]),
        ]);
        out.push(`\n#### ${idx.id}: iron fly ±${wings} strikes, close -> next open, engine spread model\n\nSkipped nights: ${JSON.stringify(skipped)}\n\n${md(byYear)}\n\n${splits}\n\nWorst nights:\n\n${worstTable}`);
      }
    }
    // Unhedged short straddle per unit, for comparison (risk not bounded).
    const straddle: number[] = [];
    for (const date of data.book.dates(idx.id)) {
      if (date < from || date > to || data.special.has(date)) continue;
      const next = data.book.nextDate(idx.id, date);
      const expiry = nextExpiry(data.book, idx.id, date);
      if (!next || !expiry || data.special.has(next)) continue;
      const fwd = parityForward(data.book, idx.id, date, expiry, "close", { r: data.cfg.pricing.r, tYears: tYears(data, date, "15:15", expiry) });
      if (!fwd) continue;
      const k = nearestStrike(data.book.strikes(idx.id, date, expiry), fwd.forward)!;
      const [c0, p0, c1, p1] = [[date, "CE"], [date, "PE"], [next, "CE"], [next, "PE"]].map(([d, ty]) => data.book.option(idx.id, d, expiry, k, ty as "CE" | "PE"));
      if (!ok(c0, "close") || !ok(p0, "close") || !ok(c1, "open") || !ok(p1, "open")) continue;
      straddle.push((c0.close! + p0.close! - c1.open! - p1.open!) / (c0.close! + p0.close!));
    }
    const st = stats(straddle);
    out.push(`\n${idx.id} unhedged short ATM straddle, close -> next open, gross per unit of premium: mean ${pct(st.mean)} (t ${st.t.toFixed(2)}, n ${st.n}), median ${pct(st.median)}, 5th percentile ${pct(st.p05)}, worst ${pct(st.min)}.`);
  }
  const text = `### Overnight iron fly on real prices (capital ₹${capital.toLocaleString("en-IN")}, max loss <= ${riskPct}% per night, margin <= capital)\n\n${md(summary)}\n${out.join("\n")}\n`;
  console.log(text);
  const p = resolve(ROOT, "reports/wp7/overnight-ironfly.md");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  writeFileSync(resolve(ROOT, "reports/wp7/overnight-ironfly.json"), JSON.stringify(json, null, 1));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
