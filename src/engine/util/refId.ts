/** Broker order reference ids: Groww requires 8-20 alphanumerics (at most two hyphens). */
const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function makeRefId(nowMs: number, prefix = "R"): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let rand = "";
  for (const b of bytes) rand += ALNUM[b % ALNUM.length];
  return `${prefix}${nowMs.toString(36).toUpperCase()}${rand}`.slice(0, 20);
}

export function isValidRefId(id: string): boolean {
  return /^[A-Za-z0-9-]{8,20}$/.test(id) && (id.match(/-/g) ?? []).length <= 2;
}
