import { describe, expect, it } from "vitest";
import { base32Decode, hotp, totp } from "./totp.js";

// RFC 6238 Appendix B uses the ASCII seed "12345678901234567890" for SHA1.
const SEED_ASCII = "12345678901234567890";
const SEED_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("base32Decode", () => {
  it("decodes the RFC 6238 seed", () => {
    expect(base32Decode(SEED_BASE32).toString("ascii")).toBe(SEED_ASCII);
  });

  it("ignores case, spaces, hyphens and padding", () => {
    expect(base32Decode("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq===").toString("ascii")).toBe(SEED_ASCII);
    expect(base32Decode("MZXW6===").toString("ascii")).toBe("foo"); // RFC 4648 test vector
  });

  it("rejects invalid characters", () => {
    expect(() => base32Decode("GEZD1NBV")).toThrow(/base32/);
    expect(() => base32Decode("")).toThrow();
  });
});

describe("hotp (RFC 4226 Appendix D)", () => {
  it("matches the published values for counters 0-9", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    const key = Buffer.from(SEED_ASCII, "ascii");
    expected.forEach((code, counter) => expect(hotp(key, counter)).toBe(code));
  });
});

describe("totp (RFC 6238 Appendix B, SHA1)", () => {
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  it.each(vectors)("T=%i gives %s with 8 digits", (seconds, code) => {
    expect(totp(SEED_BASE32, seconds * 1000, { digits: 8 })).toBe(code);
  });

  it.each(vectors)("T=%i gives the last six digits by default (Groww: 6 digits, 30 s)", (seconds, code) => {
    expect(totp(SEED_BASE32, seconds * 1000)).toBe(code.slice(-6));
  });

  it("is stable within a 30 s step and changes across steps", () => {
    expect(totp(SEED_BASE32, 60_000)).toBe(totp(SEED_BASE32, 89_999));
    expect(totp(SEED_BASE32, 89_999)).not.toBe(totp(SEED_BASE32, 90_000));
  });
});
