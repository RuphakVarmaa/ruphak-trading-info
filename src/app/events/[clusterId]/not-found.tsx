import Link from "next/link";
import { C } from "@/components/shared/colors";
import { SERIF } from "@/components/shared/theme";

export default function EventNotFound() {
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, display: "flex", alignItems: "center", justifyContent: "center", padding: 30 }}>
      <div style={{ maxWidth: 520, textAlign: "center", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 13, color: C.gold, fontWeight: 600 }}>Event not found</div>
        <h1 style={{ margin: 0, fontSize: "clamp(28px, 4vw, 38px)", fontWeight: 500, fontFamily: SERIF, letterSpacing: "-0.02em", color: C.textStrong }}>
          This event cluster does not exist
        </h1>
        <p style={{ margin: 0, fontSize: 15, color: C.muted, lineHeight: 1.6 }}>It may have been merged into another story or pruned after 30 days.</p>
        <Link href="/#news" style={{ color: C.gold, textDecoration: "none", fontSize: 14, fontWeight: 600 }}>
          ← Back to the desk
        </Link>
      </div>
    </div>
  );
}
