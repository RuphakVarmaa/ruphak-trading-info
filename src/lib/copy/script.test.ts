import { describe, expect, it } from "vitest";
import { computeCharges } from "@/engine/broker/charges";
import { isOnTick } from "./prices";
import { paperScript, scriptText, sizeCheck, sizeChecks, SMALL_CAPITAL, stopLossLimit } from "./script";
import { niftyTicket, sensexTicket } from "./testTickets";

describe("paperScript", () => {
  it("walks through a NIFTY call for the main account, step by step", () => {
    const s = paperScript(niftyTicket());
    expect(s).toEqual([
      'Open the F&O (options) order screen and search "NIFTY 22600 CE".',
      "Pick the expiry Tue 13 Oct 2026 (NIFTY weekly).",
      "Choose strike 22600 CE (call) and tap BUY.",
      "Quantity: 1 lot = 65 (lot size 65).",
      "Order type LIMIT at ₹145.35 or less: the engine paid ₹142.50 at 10:05 IST (a model price: Groww's will differ), plus 2% room. Don't place it if NIFTY is already above 22,631.",
      "Once filled, place the stop-loss: SELL 65 qty, stop-loss (SL) order, trigger ₹99.75, limit ₹97.75 (−30% on the engine's fill; from your own fill F the trigger is F × 0.70). The limit sits 2% under the trigger so the order fills in a fast fall.",
      "Target ₹213.75 (+50%): sell there. Keep one exit order per lot: when the premium nears the target, change the stop-loss into a LIMIT SELL at ₹213.75, or use an OCO order if your app has one. Two open SELL orders for one lot can leave you short.",
      "Trail: once the premium reaches ₹185.25 (+30%), raise the stop so it gives back at most 50% of the gain from the peak: at ₹185.25 the stop goes to ₹163.85, and it rises with every new high.",
      "Time stop 12:05 IST: sell then unless the premium is at least ₹156.75 (+10%).",
      "Latest exit 15:05 IST: sell whatever is left.",
      "Sell at once whenever this page shows EXIT NOW for this trade.",
    ]);
  });

  it("walks through a SENSEX put for the ₹10k account (lot of 20, skip below, broker price)", () => {
    const s = paperScript(sensexTicket());
    expect(s[1]).toBe("Pick the expiry Thu 15 Oct 2026 (SENSEX weekly).");
    expect(s[2]).toBe("Choose strike 81500 PE (put) and tap BUY.");
    expect(s[3]).toBe("Quantity: 1 lot = 20 (lot size 20).");
    expect(s[4]).toBe("Order type LIMIT at ₹171.75 or less: the engine paid ₹168.35 at 10:20 IST, plus 2% room. Don't place it if SENSEX is already below 81,234.");
    expect(s[5]).toContain("trigger ₹109.40, limit ₹107.20 (−35% on the engine's fill; from your own fill F the trigger is F × 0.65)");
    expect(s[6]).toContain("Target ₹269.40 (+60%)");
  });

  it("numbers the steps for 'Copy all steps'", () => {
    const text = scriptText(niftyTicket());
    expect(text.split("\n")[0]).toBe("BUY NIFTY 22600 CE (13 Oct) · Main · Tue 13 Oct 2026");
    expect(text).toContain("\n1. Open the F&O");
    expect(text).toContain("\n11. Sell at once");
  });

  it("puts every stop-loss limit on the tick, under its trigger", () => {
    for (const trigger of [99.75, 109.4, 0.1, 37.15]) {
      const l = stopLossLimit(trigger);
      expect(isOnTick(l)).toBe(true);
      expect(l).toBeLessThan(trigger);
    }
  });
});

describe("sizeCheck", () => {
  it("prices one NIFTY lot at the limit with both orders' charges, against the main account", () => {
    const t = niftyTicket();
    const c = sizeCheck(t, 500_000, 1, "Main account");
    const buy = computeCharges("BUY", 145.35, 65, "NSE", "2026-10-09").total;
    const sell = computeCharges("SELL", 99.75, 65, "NSE", "2026-10-09").total;
    expect(c.qty).toBe(65);
    expect(c.entry).toBe(145.35);
    expect(c.stop).toBe(99.75);
    expect(c.cost).toBeCloseTo(9447.75, 6);
    expect(c.buyCharges).toBe(buy);
    expect(buy).toBeCloseTo(27.86, 2);
    expect(c.needs).toBeCloseTo(9447.75 + buy, 6);
    expect(c.maxLoss).toBeCloseTo((145.35 - 99.75) * 65 + buy + sell, 6);
    expect(c.maxLoss).toBeCloseTo(3027.9, 0);
    expect(c.lossPctOfCapital).toBeCloseTo(0.61, 2);
    expect(c.fits).toBe(true);
    expect(c.warning).toBeNull();
  });

  it("warns plainly when one lot costs more than ₹5,000", () => {
    const c = sizeCheck(niftyTicket(), SMALL_CAPITAL, 1, "₹5,000");
    expect(c.fits).toBe(false);
    expect(c.warning).toBe("1 lot needs ₹9,476 (premium at the ₹145.35 limit plus charges): more than ₹5,000. This trade does not fit ₹5,000.");
    expect(c.costPctOfCapital).toBeGreaterThan(100);
  });

  it("fits a premium-band SENSEX lot into ₹10k and ₹5,000 (BSE charges)", () => {
    const [own, small] = sizeChecks(sensexTicket());
    expect(own.label).toBe("₹10k account");
    expect(own.qty).toBe(20);
    expect(own.cost).toBeCloseTo(3435, 6);
    expect(own.buyCharges).toBe(computeCharges("BUY", 171.75, 20, "BSE", "2026-10-09").total);
    expect(own.maxLoss).toBeCloseTo(1299.8, 0);
    expect(own.lossPctOfCapital).toBeCloseTo(13, 0);
    expect(own.fits).toBe(true);
    expect(small.label).toBe("₹5,000");
    expect(small.fits).toBe(true);
    expect(small.lossPctOfCapital).toBeCloseTo(26, 0);
  });

  it("checks several lots against the account and one lot against ₹5,000", () => {
    const t = niftyTicket({ lots: 2, qty: 130, contract: { lots: 2 } });
    const [own, small] = sizeChecks(t);
    expect(own.lots).toBe(2);
    expect(own.qty).toBe(130);
    expect(small.lots).toBe(1);
    expect(small.qty).toBe(65);
  });

  it("shows one row for a ₹5,000 account buying one lot", () => {
    const t = sensexTicket({ account: { id: "small5k", label: "₹5k account", shortLabel: "₹5k", capitalRupees: 5000 } });
    const rows = sizeChecks(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("₹5k account");
  });
});
