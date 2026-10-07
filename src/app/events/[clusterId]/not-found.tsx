import Link from "next/link";

export default function EventNotFound() {
  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", color: "#ededed", display: "flex", alignItems: "center", justifyContent: "center", padding: 30 }}>
      <div style={{ maxWidth: 480, textAlign: "center", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 10, color: "#ffb300", fontWeight: 700, letterSpacing: "0.1em" }}>404 · EVENT NOT FOUND</div>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 400, fontFamily: "var(--font-playfair), 'Playfair Display', Georgia, serif" }}>
          This event cluster does not exist
        </h1>
        <p style={{ margin: 0, fontSize: 13, color: "#777" }}>It may have been merged into another story or pruned after 30 days.</p>
        <Link href="/#desk" style={{ color: "#ffb300", textDecoration: "none", fontSize: 12, fontWeight: 700 }}>
          ← Back to the desk
        </Link>
      </div>
    </div>
  );
}
