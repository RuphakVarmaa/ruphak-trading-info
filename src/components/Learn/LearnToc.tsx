"use client";

import { useEffect, useState, type MouseEvent } from "react";
import s from "./learn.module.css";

export interface TocItem {
  id: string;
  label: string;
}

/**
 * On-page contents: a sticky column on wide screens, a sticky bar that opens into the list on phones.
 * It marks the section being read, and the phone list closes once a section is picked.
 */
export default function LearnToc({ items }: { items: readonly TocItem[] }) {
  const [active, setActive] = useState<string>(items[0]?.id ?? "");

  useEffect(() => {
    const els = items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => e !== null);
    if (els.length === 0 || typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top);
          else visible.delete(e.target.id);
        }
        // The topmost section in the reading band wins.
        const first = items.find((i) => visible.has(i.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-90px 0px -55% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [items]);

  /** The phone list closes once a section is picked. */
  const closeBar = (e: MouseEvent<HTMLAnchorElement>) => {
    const bar = e.currentTarget.closest("details");
    if (bar) bar.open = false;
  };

  const list = (onPick?: (e: MouseEvent<HTMLAnchorElement>) => void) => (
    <ol className={s.tocList}>
      {items.map((it, n) => (
        <li key={it.id}>
          <a href={`#${it.id}`} className={s.tocLink} aria-current={active === it.id ? "true" : undefined} onClick={onPick}>
            <span className={s.tocNum}>{n + 1}</span>
            <span>{it.label}</span>
          </a>
        </li>
      ))}
    </ol>
  );

  const activeIdx = Math.max(0, items.findIndex((i) => i.id === active));

  return (
    <>
      <details className={s.tocBar}>
        <summary>
          <span style={{ color: "var(--c-muted2)", fontWeight: 500 }}>Contents</span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {activeIdx + 1}. {items[activeIdx]?.label}
          </span>
        </summary>
        <nav aria-label="On this page (compact)">
          {list(closeBar)}
        </nav>
      </details>
      <nav aria-label="On this page" className={s.tocSide}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--c-muted2)", padding: "0 10px 8px" }}>On this page</div>
        {list()}
      </nav>
    </>
  );
}
