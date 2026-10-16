import type { Metadata } from "next";
import { HonestAnswer, HowPriced, NoTrade, PremiumTiming } from "@/components/Learn/BasicsSections";
import LearnToc, { type TocItem } from "@/components/Learn/LearnToc";
import { AdviceExplained, IndexHolding, ReadingChain, RiskSizing } from "@/components/Learn/PracticeSections";
import s from "@/components/Learn/learn.module.css";
import { C } from "@/components/shared/colors";
import SiteFooter from "@/components/shared/SiteFooter";
import SiteHeader from "@/components/shared/SiteHeader";
import { SERIF } from "@/components/shared/theme";

export const metadata: Metadata = {
  title: "Learn options buying — Ruphak Trading Info",
  description:
    "Everything about buying NIFTY and SENSEX options, from this project's own research on real prices: how premium works, when it is richest, when not to enter, risk, and what the data supports.",
};

const TOC: TocItem[] = [
  { id: "answer", label: "The honest answer" },
  { id: "pricing", label: "How an option's price works" },
  { id: "timing", label: "When premium is richest" },
  { id: "no-trade", label: "When not to enter" },
  { id: "advice", label: "How “What to do now” works" },
  { id: "chain", label: "Reading an option chain" },
  { id: "risk", label: "Risk and sizing" },
  { id: "index", label: "What the data supports" },
];

/** A static guide to buying index options, built only from docs/research and reports/. */
export default function LearnPage() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: C.bg, color: C.text }}>
      <SiteHeader active="learn" />
      <main className={s.wrap}>
        <header style={{ maxWidth: 820 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.gold, marginBottom: 10 }}>Learn · NIFTY and SENSEX options</div>
          <h1 style={{ margin: 0, fontFamily: SERIF, fontSize: "clamp(32px, 4.4vw, 46px)", fontWeight: 500, lineHeight: 1.08, letterSpacing: "-0.02em", color: C.textStrong }}>
            Buying index options, from the evidence
          </h1>
          <p style={{ margin: "14px 0 0", fontSize: 16.5, lineHeight: 1.6, color: C.muted }}>
            What this project learned from five years of real 1-minute option prices, the exchanges&apos; daily files and SEBI&apos;s studies: how a premium is priced, when it
            is cheapest, when not to trade, and how the site&apos;s advice is made. Every figure carries its source in the research.
          </p>
        </header>
        <div className={s.grid}>
          <LearnToc items={TOC} />
          <div className={s.main}>
            <HonestAnswer />
            <HowPriced />
            <PremiumTiming />
            <NoTrade />
            <AdviceExplained />
            <ReadingChain />
            <RiskSizing />
            <IndexHolding />
            <p style={{ margin: 0, fontSize: 12.5, color: C.muted2, lineHeight: 1.6 }}>
              Sources: docs/research/options-trading-plan.md and its notes (R1–R6, Q1, Q2), and the work-package reports in reports/ (WP2, WP6, WP10, WP11, WP13–WP16). Short
              tags next to each figure name the source.
            </p>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
