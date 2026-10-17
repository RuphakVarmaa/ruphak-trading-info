import { describe, expect, it } from "vitest";
import { buildNiftyChain, niftyExpiries } from "./niftyChain";

const ist = (d: string, hm: string) => Date.parse(`${d}T${hm}:00+05:30`);

describe("niftyExpiries", () => {
  it("lists the next weekly expiries, holiday-adjusted", () => {
    // Tue 20 Oct is Dussehra, so that week's contract expires Mon 19 Oct.
    expect(niftyExpiries(ist("2026-10-08", "09:30"))).toEqual(["2026-10-13", "2026-10-19", "2026-10-27"]);
  });
  it("skips the contract expiring today", () => {
    expect(niftyExpiries(ist("2026-10-13", "10:00"))[0]).toBe("2026-10-19");
  });
});

describe("buildNiftyChain", () => {
  const nowMs = ist("2026-10-08", "10:00");
  const chain = buildNiftyChain({ spot: 22560, vix: 13.9, nowMs, expiry: "2026-10-13", expiries: niftyExpiries(nowMs) });

  it("centres 21 strikes on the at-the-money strike", () => {
    expect(chain.atm).toBe(22550);
    expect(chain.rows).toHaveLength(21);
    expect(chain.rows[10].strike).toBe(22550);
    expect(chain.rows[0].strike).toBe(22050);
    expect(chain.ivPct).toBeCloseTo(13.9, 6);
  });

  it("prices calls down and puts up the strike ladder, with bid below ask", () => {
    for (let i = 1; i < chain.rows.length; i++) {
      expect(chain.rows[i].ce.ltp).toBeLessThanOrEqual(chain.rows[i - 1].ce.ltp);
      expect(chain.rows[i].pe.ltp).toBeGreaterThanOrEqual(chain.rows[i - 1].pe.ltp);
    }
    for (const r of chain.rows) {
      expect(r.ce.bid).toBeLessThan(r.ce.ask);
      expect(r.pe.bid).toBeLessThan(r.pe.ask);
    }
  });

  it("keeps put-call parity at the money", () => {
    const atm = chain.rows[10];
    // C - P = S - K·e^(-rT): above S - K = 10 by the carry K·r·T, which is under ₹41 for a week at 6.5%.
    const carry = atm.ce.ltp - atm.pe.ltp - 10;
    expect(carry).toBeGreaterThan(0);
    expect(carry).toBeLessThan(22550 * 0.065 * (7 / 252));
    expect(atm.ce.ltp).toBeGreaterThan(100);
    expect(atm.ce.ltp).toBeLessThan(250);
  });
});
