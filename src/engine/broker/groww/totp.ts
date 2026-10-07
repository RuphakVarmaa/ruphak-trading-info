/**
 * RFC 6238 TOTP on WebCrypto (Workers and Node 22), for Groww API keys of type TOTP.
 * Defaults match authenticator apps and Groww: HMAC-SHA1, 6 digits, 30-second steps.
 */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export interface TotpOptions {
  digits?: number;
  periodSec?: number;
  algorithm?: TotpAlgorithm;
}

/** Decodes an RFC 4648 base32 secret (case-insensitive; spaces, hyphens and padding ignored). */
export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (clean.length === 0) throw new Error("TOTP secret is empty");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("TOTP secret is not valid base32");
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** RFC 4226 HOTP value for a counter. */
export async function hotp(key: Uint8Array<ArrayBuffer>, counter: number, digits = 6, algorithm: TotpAlgorithm = "SHA-1"): Promise<string> {
  const msg = new Uint8Array(8);
  let c = Math.floor(counter);
  for (let i = 7; i >= 0; i--) {
    msg[i] = c % 256;
    c = Math.floor(c / 256);
  }
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: algorithm }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** Current TOTP code for a base32 secret at `nowMs`. */
export async function totp(secretBase32: string, nowMs: number, o: TotpOptions = {}): Promise<string> {
  const period = o.periodSec ?? 30;
  return hotp(base32Decode(secretBase32), Math.floor(nowMs / 1000 / period), o.digits ?? 6, o.algorithm ?? "SHA-1");
}

/** Milliseconds until the current TOTP step ends. */
export function msLeftInStep(nowMs: number, periodSec = 30): number {
  const period = periodSec * 1000;
  return period - (nowMs % period);
}
