// RFC 4226 HOTP / RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s step by default), used to mint
// the daily Groww access token from the API key's base32 TOTP secret.
import { createHmac } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 decode; ignores case, spaces, hyphens and trailing '=' padding. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (clean.length === 0) throw new Error("empty base32 secret");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32 character in secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export type HotpAlgorithm = "sha1" | "sha256" | "sha512";

export function hotp(key: Uint8Array, counter: number | bigint, digits = 6, algorithm: HotpAlgorithm = "sha1"): string {
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new Error("digits must be 6-10");
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export interface TotpOptions {
  stepSeconds?: number;
  digits?: number;
  algorithm?: HotpAlgorithm;
}

/** TOTP code for `timeMs` (epoch milliseconds) from a base32 secret. */
export function totp(secretBase32: string, timeMs: number, opts: TotpOptions = {}): string {
  const step = opts.stepSeconds ?? 30;
  const counter = Math.floor(Math.floor(timeMs / 1000) / step);
  return hotp(base32Decode(secretBase32), counter, opts.digits ?? 6, opts.algorithm ?? "sha1");
}
