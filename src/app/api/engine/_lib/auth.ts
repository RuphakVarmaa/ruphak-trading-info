import type { NextResponse } from "next/server";
import { getAdminToken } from "@/lib/engine/server";
import { fail } from "./respond";

export const ADMIN_ACTOR = "dashboard";

/** Constant-time string comparison (hashes both sides so length differences don't leak either). */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export type AdminCheck = { ok: true; token: string } | { ok: false; response: NextResponse };

/** Validates the `x-admin-token` header against ADMIN_TOKEN. */
export async function requireAdmin(req: Request): Promise<AdminCheck> {
  const expected = await getAdminToken();
  if (!expected) {
    return { ok: false, response: fail("ADMIN_DISABLED", "Admin actions are disabled: ADMIN_TOKEN is not configured.") };
  }
  const provided = req.headers.get("x-admin-token") ?? "";
  if (!provided || !(await constantTimeEqual(provided, expected))) {
    return { ok: false, response: fail("UNAUTHORIZED", "Missing or invalid admin token.") };
  }
  return { ok: true, token: provided };
}
