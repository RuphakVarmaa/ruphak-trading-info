import { C } from "./colors";

/** Site footer: who maintains the site, and the one-line disclaimer. */
export default function SiteFooter() {
  return (
    <footer style={{ padding: "28px 16px", borderTop: `1px solid ${C.border}`, background: C.panelAlt, textAlign: "center", fontSize: 13, color: C.muted }}>
      Maintained by Ruphak ·{" "}
      <a href="https://www.ruphak.me" target="_blank" rel="noopener noreferrer" className="link-quiet" style={{ color: C.gold, textDecoration: "none" }}>
        www.ruphak.me
      </a>
      <div style={{ fontSize: 12, color: C.muted2, marginTop: 4 }}>© {new Date().getFullYear()} Ruphak Trading Info. Not financial advice.</div>
    </footer>
  );
}
