import { describe, expect, it } from "vitest";
import { expectedExpiry, problems, verifyTicket } from "./verify";
import { at, niftyTicket, sensexTicket } from "./testTickets";

const byId = (t: Parameters<typeof verifyTicket>[0]) => Object.fromEntries(verifyTicket(t).map((c) => [c.id, c]));

describe("verifyTicket", () => {
  it("passes a correct NIFTY Tuesday call and a SENSEX Thursday put", () => {
    expect(problems(niftyTicket())).toEqual([]);
    expect(problems(sensexTicket())).toEqual([]);
    const n = byId(niftyTicket());
    expect(n.strike.text).toBe("Strike 22600 is on NIFTY's 50-point grid");
    expect(n.type.text).toBe("CE for a bullish trade");
    expect(n.expiry.text).toBe("Tue 13 Oct 2026 is a NIFTY weekly expiry (Tuesday)");
    expect(n.qty.text).toBe("1 lot × 65 = 65 qty");
    expect(n.tick.text).toBe("Every price to type is on the ₹0.05 tick: limit and target rounded up, stop down");
    const s = byId(sensexTicket());
    expect(s.expiry.text).toBe("Thu 15 Oct 2026 is a SENSEX weekly expiry (Thursday)");
    expect(s.qty.text).toBe("1 lot × 20 = 20 qty");
    expect(s.type.text).toBe("PE for a bearish trade");
  });

  it("accepts the holiday shift: NIFTY expires Mon 19 Oct because Tue 20 Oct is Dussehra", () => {
    const t = niftyTicket({ entry: { at: at("10:05", "2026-10-15") }, contract: { expiry: "2026-10-19" } });
    expect(expectedExpiry(t)).toBe("2026-10-19");
    expect(problems(t)).toEqual([]);
    expect(byId(t).expiry.text).toBe("Mon 19 Oct 2026: Tue 20 Oct is a holiday (Dussehra), so NIFTY expires the trading day before");
  });

  it("expects next week's contract on the shifted expiry day itself", () => {
    const t = niftyTicket({ entry: { at: at("10:05", "2026-10-19") }, contract: { expiry: "2026-10-27" } });
    expect(expectedExpiry(t)).toBe("2026-10-27");
    expect(problems(t)).toEqual([]);
  });

  it("flags an expiry on the wrong weekday", () => {
    const t = niftyTicket({ contract: { expiry: "2026-10-14" } });
    expect(problems(t).map((c) => c.id)).toContain("expiry");
    expect(byId(t).expiry.text).toBe("Wed 14 Oct 2026 is not a NIFTY weekly expiry (Tuesday, or the trading day before a Tuesday holiday): check it in Groww");
  });

  it("flags a same-day expiry and a far one", () => {
    const sameDay = niftyTicket({ entry: { at: at("10:05", "2026-10-13") } });
    expect(problems(sameDay).map((c) => c.id)).toEqual(["expiry_next"]);
    const far = niftyTicket({ contract: { expiry: "2026-10-27" } });
    expect(problems(far).map((c) => c.id)).toEqual(["expiry_next"]);
    expect(byId(far).expiry_next.text).toBe("The calendar expects Tue 13 Oct 2026, the nearest weekly expiry: pick the expiry Groww lists for NIFTY 22600 CE carefully");
  });

  it("flags strikes off the grid, the wrong option type and a wrong search text", () => {
    expect(problems(niftyTicket({ contract: { strike: 22625 }, searchText: "NIFTY 22625 CE" })).map((c) => c.id)).toEqual(["strike"]);
    expect(problems(sensexTicket({ contract: { strike: 81550 }, searchText: "SENSEX 81550 PE" })).map((c) => c.id)).toEqual(["strike"]);
    expect(problems(niftyTicket({ contract: { optionType: "PE" }, searchText: "NIFTY 22600 PE" })).map((c) => c.id)).toEqual(["type"]);
    expect(problems(niftyTicket({ searchText: "NIFTY 22650 CE" })).map((c) => c.id)).toEqual(["search"]);
  });

  it("checks lots × lot size = quantity and the lot size the engine expects", () => {
    expect(problems(niftyTicket({ qty: 75 })).map((c) => c.id)).toEqual(["qty"]);
    const relisted = niftyTicket({ qty: 75, contract: { lotSize: 75 } });
    expect(problems(relisted).map((c) => c.id)).toEqual(["lot_size"]);
    expect(byId(relisted).lot_size.text).toBe("Lot size 75 differs from the 65 the engine expects for NIFTY: use the lot size Groww shows");
    expect(problems(sensexTicket({ lots: 2, qty: 40 }))).toEqual([]);
  });

  it("rounds an off-tick engine fill and says so", () => {
    const t = niftyTicket({ entry: { premium: 142.53 } });
    const c = byId(t).tick;
    expect(c.ok).toBe(true);
    expect(c.text).toContain("the engine's fill ₹142.53 is not, so it is rounded");
  });
});
