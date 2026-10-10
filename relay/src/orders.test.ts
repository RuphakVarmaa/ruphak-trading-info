import { describe, expect, it } from "vitest";
import { buyOrder, harness, ist, json, newKey, position, sellOrder } from "./test-helpers.js";

const SYMBOL = "NIFTY26O1325000CE";

async function place(h: ReturnType<typeof harness>, order: Record<string, unknown>) {
  const res = await h.call("POST", "/v1/orders", order);
  return { status: res.status, body: await json(res) };
}

describe("POST /v1/orders: happy path and validation", () => {
  it("places a capped LIMIT BUY and records it", async () => {
    const h = harness();
    const order = buyOrder();
    const r = await place(h, order);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "ACCEPTED", growwOrderId: "GMK1", orderStatus: "OPEN" });
    expect(h.groww.created()[0]).toMatchObject({
      tradingSymbol: SYMBOL,
      quantity: 65,
      price: 100,
      orderType: "LIMIT",
      transactionType: "BUY",
      product: "MIS",
      exchange: "NSE",
      segment: "FNO",
      validity: "DAY",
      orderReferenceId: order.idempotencyKey,
    });
    const rows = h.ledger.listOrders();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "ACCEPTED", sent: true, premiumInr: 6500, growwOrderId: "GMK1" });
  });

  it("answers 400 for malformed requests without touching Groww", async () => {
    const h = harness();
    const bad = [
      buyOrder({ idempotencyKey: "short" }),
      buyOrder({ idempotencyKey: "has-too-many-hyphens-x" }),
      buyOrder({ idempotencyKey: "A-B-C-D1234" }),
      buyOrder({ underlying: "BANKNIFTY" }),
      buyOrder({ qty: 65.5 }),
      buyOrder({ orderType: "LIMIT", price: undefined }),
      buyOrder({ orderType: "SL" }),
      buyOrder({ validity: "IOC" }),
      buyOrder({ segment: "CASH" }),
    ];
    for (const order of bad) {
      const r = await place(h, order);
      expect(r.status, JSON.stringify(order)).toBe(400);
      expect(r.body.code).toBe("BAD_REQUEST");
    }
    const notJson = await h.call("POST", "/v1/orders", "{not json");
    expect(notJson.status).toBe(400);
    expect(h.groww.count("createOrder")).toBe(0);
  });
});

describe("POST /v1/orders: relay caps (422 REJECTED)", () => {
  async function expectRejected(h: ReturnType<typeof harness>, order: Record<string, unknown>, pattern: RegExp) {
    const r = await place(h, order);
    expect(r.status).toBe(422);
    expect(r.body.status).toBe("REJECTED");
    expect(r.body.rejectedBy).toBe("RELAY");
    expect((r.body.violations as string[]).join(" | ")).toMatch(pattern);
    return r;
  }

  it("shadow mode: RELAY_LIVE=false rejects with 'relay not live' and never calls Groww", async () => {
    const h = harness({ RELAY_LIVE: "false" });
    const r = await expectRejected(h, buyOrder(), /relay not live/);
    expect(r.body.reason).toBe("relay not live");
    expect(h.groww.calls).toHaveLength(0);
    const rows = h.ledger.listOrders();
    expect(rows[0]).toMatchObject({ status: "REJECTED", sent: false, reason: "relay not live" });
  });

  it("shadow mode still reports the other caps a would-be order breaks", async () => {
    const h = harness({ RELAY_LIVE: "false" });
    const r = await expectRejected(h, buyOrder({ qty: 195 }), /relay not live/);
    expect(r.body.violations).toEqual(["relay not live", "3 lots exceeds MAX_LOTS_PER_ORDER 2"]);
  });

  it("enforces ALLOWED_UNDERLYINGS", async () => {
    const h = harness({ ALLOWED_UNDERLYINGS: "NIFTY" });
    await expectRejected(
      h,
      buyOrder({ underlying: "SENSEX", tradingSymbol: "SENSEX26O1581000CE", exchange: "BSE", lotSize: 20, qty: 20 }),
      /not in ALLOWED_UNDERLYINGS/,
    );
  });

  it("ties the symbol and exchange to the underlying", async () => {
    const h = harness();
    await expectRejected(h, buyOrder({ tradingSymbol: "SENSEX26O1581000CE" }), /not a NIFTY option contract/);
    await expectRejected(h, buyOrder({ tradingSymbol: "NIFTYNXT5026O1325000CE" }), /not a NIFTY option contract/);
    await expectRejected(h, buyOrder({ tradingSymbol: "NIFTY26OCTFUT" }), /not a NIFTY option contract/);
    await expectRejected(h, buyOrder({ exchange: "BSE" }), /trade on NSE, not BSE/);
  });

  it("enforces PRODUCT_ALLOWLIST", async () => {
    const h = harness();
    await expectRejected(h, buyOrder({ product: "NRML" }), /PRODUCT_ALLOWLIST/);
  });

  it("enforces lot multiples, MAX_LOTS_PER_ORDER and the relay's own lot sizes", async () => {
    const h = harness();
    await expectRejected(h, buyOrder({ qty: 100 }), /not a multiple of lotSize 65/);
    await expectRejected(h, buyOrder({ qty: 195, price: 10 }), /3 lots exceeds MAX_LOTS_PER_ORDER 2/);
    // A compromised engine cannot inflate the lot size to sneak past the lots cap.
    await expectRejected(h, buyOrder({ qty: 2600, lotSize: 1300, price: 1 }), /LOT_SIZES/);
    expect(h.groww.count("createOrder")).toBe(0);
  });

  it("enforces MAX_ORDERS_PER_DAY for entries but still lets exits out", async () => {
    const h = harness({ MAX_ORDERS_PER_DAY: "2" });
    expect((await place(h, buyOrder())).status).toBe(200);
    expect((await place(h, buyOrder())).status).toBe(200);
    await expectRejected(h, buyOrder(), /MAX_ORDERS_PER_DAY 2 reached/);
    h.groww.positions = [position(SYMBOL, 130)];
    // Our two BUYs are still open at the broker but they are BUYs: 130 sellable.
    const exit = await place(h, sellOrder({ qty: 130 }));
    expect(exit.status).toBe(200);
    // The next IST day starts a fresh count.
    h.clock.set(ist("2026-10-07T10:00:00"));
    expect((await place(h, buyOrder())).status).toBe(200);
  });

  it("enforces the IST trading window, weekends and holidays", async () => {
    const h = harness();
    h.clock.set(ist("2026-10-06T09:15:59"));
    await expectRejected(h, buyOrder(), /outside the entry window 09:16-15:12/);
    h.clock.set(ist("2026-10-06T09:16:00"));
    expect((await place(h, buyOrder())).status).toBe(200);
    h.clock.set(ist("2026-10-06T15:12:00"));
    await expectRejected(h, buyOrder(), /outside the entry window/);
    h.clock.set(ist("2026-10-10T11:00:00")); // Saturday
    await expectRejected(h, buyOrder(), /Mon-Fri/);
    h.clock.set(ist("2026-10-20T11:00:00")); // Dussehra (Tuesday)
    await expectRejected(h, buyOrder(), /market holiday 2026-10-20/);
  });

  it("allows SELL exits that reduce a long until 15:25 IST", async () => {
    const h = harness();
    h.groww.positions = [position(SYMBOL, 65)];
    h.clock.set(ist("2026-10-06T15:20:00"));
    const exit = await place(h, sellOrder());
    expect(exit.status).toBe(200);
    expect(h.ledger.listOrders()[0]).toMatchObject({ isExit: true, premiumInr: null });
    h.clock.set(ist("2026-10-06T15:25:00"));
    h.groww.positions = [position(SYMBOL, 65)];
    h.groww.orders.clear();
    await expectRejected(h, sellOrder(), /outside the exit window 09:16-15:25/);
  });

  it("ALLOW_SHORT=false: a SELL may not exceed the long minus pending SELL orders", async () => {
    const h = harness();
    await expectRejected(h, sellOrder(), /exceeds the sellable long of 0/); // flat
    h.groww.positions = [position(SYMBOL, 65)];
    await expectRejected(h, sellOrder({ qty: 130 }), /exceeds the sellable long of 65/);
    // Another open SELL for the same symbol already covers the long.
    h.groww.seedOrder({ tradingSymbol: SYMBOL, transactionType: "SELL", quantity: 65 });
    await expectRejected(h, sellOrder(), /sellable long of 0 .*pending sells 65/);
    // A long in a different product does not count.
    const h2 = harness();
    h2.groww.positions = [position(SYMBOL, 65, { product: "NRML" })];
    await expectRejected(h2, sellOrder(), /sellable long of 0/);
    // An open SELL with unknown remaining quantity blocks (fail-safe).
    const h3 = harness();
    h3.groww.positions = [position(SYMBOL, 65)];
    h3.groww.seedOrder({ tradingSymbol: SYMBOL, transactionType: "SELL", quantity: 65 }, "OPEN", { reportQty: false });
    await expectRejected(h3, sellOrder(), /exceeds the sellable long/);
  });

  it("rejects the SELL when positions cannot be read", async () => {
    const h = harness();
    h.groww.getPositions = async () => {
      throw new Error("groww down");
    };
    await expectRejected(h, sellOrder(), /cannot verify the long position/);
  });

  it("ALLOW_SHORT=true lets a SELL open a short inside the entry window", async () => {
    const h = harness({ ALLOW_SHORT: "true" });
    expect((await place(h, sellOrder())).status).toBe(200);
  });

  it("enforces MAX_PREMIUM_PER_ORDER_INR on LIMIT BUYs", async () => {
    const h = harness();
    await expectRejected(h, buyOrder({ qty: 130, price: 200 }), /premium INR 26,000 exceeds MAX_PREMIUM_PER_ORDER_INR INR 25,000/);
  });

  it("requires premiumEstimate for MARKET BUYs and bounds it by the relay's own LTP", async () => {
    const h = harness();
    await expectRejected(h, buyOrder({ orderType: "MARKET", price: undefined }), /requires premiumEstimate/);
    // The engine claims INR 50 but the option trades at INR 300: 130 x 303 > INR 25,000.
    h.groww.ltp[`NSE_${SYMBOL}`] = 300;
    await expectRejected(h, buyOrder({ orderType: "MARKET", price: undefined, premiumEstimate: 50, qty: 130 }), /premium INR 39,390 exceeds MAX_PREMIUM_PER_ORDER_INR/);
    // No LTP: cannot bound the premium, so no MARKET BUY.
    delete h.groww.ltp[`NSE_${SYMBOL}`];
    await expectRejected(h, buyOrder({ orderType: "MARKET", price: undefined, premiumEstimate: 50 }), /LTP unavailable/);
    h.groww.ltp[`NSE_${SYMBOL}`] = 100;
    const ok = await place(h, buyOrder({ orderType: "MARKET", price: undefined, premiumEstimate: 100 }));
    expect(ok.status).toBe(200);
    expect(h.groww.created()[0]).toMatchObject({ orderType: "MARKET", price: null });
  });

  it("enforces MAX_DAILY_PREMIUM_INR across the day", async () => {
    const h = harness();
    expect((await place(h, buyOrder({ qty: 130, price: 190 }))).status).toBe(200); // 24,700
    expect((await place(h, buyOrder({ qty: 130, price: 190 }))).status).toBe(200); // 49,400
    await expectRejected(h, buyOrder({ qty: 130, price: 190 }), /MAX_DAILY_PREMIUM_INR/); // 74,100
    expect((await place(h, buyOrder({ qty: 65, price: 150 }))).status).toBe(200); // 59,150
  });

  it("does not count broker-rejected BUYs against the daily premium", async () => {
    const h = harness();
    h.groww.createBehavior = "reject";
    const r = await place(h, buyOrder({ qty: 130, price: 190 }));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ status: "REJECTED", rejectedBy: "BROKER", growwCode: "GA001" });
    expect(h.ledger.buyPremium("2026-10-06")).toBe(0);
    expect(h.ledger.countSentOrders("2026-10-06")).toBe(1);
  });

  it("rejects without sending when no Groww token can be obtained", async () => {
    const h = harness();
    h.groww.tokenOk = false;
    const r = await place(h, buyOrder());
    expect(r.status).toBe(422);
    expect(r.body.reason).toMatch(/token unavailable/);
    expect(h.groww.count("createOrder")).toBe(0);
  });
});

describe("POST /v1/orders: idempotency and ambiguous outcomes", () => {
  it("returns DUPLICATE with the original growwOrderId and never re-sends", async () => {
    const h = harness();
    const order = buyOrder();
    const first = await place(h, order);
    expect(first.body).toMatchObject({ status: "ACCEPTED", growwOrderId: "GMK1" });
    const second = await place(h, order);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: "DUPLICATE", growwOrderId: "GMK1", orderStatus: "OPEN", originalStatus: "ACCEPTED" });
    expect(h.groww.count("createOrder")).toBe(1);
    expect(h.ledger.events("order_duplicate")).toHaveLength(1);
  });

  it("serializes concurrent duplicates", async () => {
    const h = harness();
    const order = buyOrder();
    const [a, b] = await Promise.all([place(h, order), place(h, order)]);
    expect([a.body.status, b.body.status].sort()).toEqual(["ACCEPTED", "DUPLICATE"]);
    expect(h.groww.count("createOrder")).toBe(1);
  });

  it("flags a reused key with different parameters", async () => {
    const h = harness();
    const order = buyOrder();
    await place(h, order);
    const r = await place(h, { ...order, qty: 130 });
    expect(r.body).toMatchObject({ status: "DUPLICATE", growwOrderId: "GMK1" });
    expect(r.body.reason).toMatch(/different order parameters/);
    expect(h.groww.count("createOrder")).toBe(1);
  });

  it("re-evaluates a key whose earlier attempt the relay rejected (nothing was sent)", async () => {
    const h = harness();
    const order = buyOrder();
    h.clock.set(ist("2026-10-06T09:00:00"));
    expect((await place(h, order)).status).toBe(422);
    h.clock.set(ist("2026-10-06T09:30:00"));
    expect((await place(h, order)).body).toMatchObject({ status: "ACCEPTED" });
  });

  it("on a timeout, looks the order up by reference instead of resending", async () => {
    const h = harness();
    h.groww.createBehavior = "timeout-after-create";
    const order = buyOrder();
    const r = await place(h, order);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "ACCEPTED", growwOrderId: "GMK1", orderStatus: "OPEN" });
    expect(r.body.reason).toMatch(/recovered by order_reference_id lookup/);
    expect(h.groww.count("createOrder")).toBe(1);
    expect(h.groww.calls.filter((c) => c.method === "getOrderStatusByRef").map((c) => c.args[0])).toEqual([order.idempotencyKey]);
    expect(h.ledger.findSentOrder(order.idempotencyKey as string)).toMatchObject({ status: "ACCEPTED", growwOrderId: "GMK1" });
  });

  it("on a 5xx, also looks up by reference", async () => {
    const h = harness();
    h.groww.createBehavior = "server-error-after-create";
    const r = await place(h, buyOrder());
    expect(r.body).toMatchObject({ status: "ACCEPTED", growwOrderId: "GMK1" });
    expect(h.groww.count("createOrder")).toBe(1);
  });

  it("when the order is not found by reference, answers 502 ORDER_OUTCOME_UNKNOWN and still never resends", async () => {
    const h = harness();
    h.groww.createBehavior = "timeout-no-create";
    const order = buyOrder();
    const r = await place(h, order);
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ code: "ORDER_OUTCOME_UNKNOWN", idempotencyKey: order.idempotencyKey });
    expect(h.groww.count("getOrderStatusByRef")).toBe(3);
    expect(h.ledger.findSentOrder(order.idempotencyKey as string)?.status).toBe("UNKNOWN");

    // A retry with the same key is answered from the ledger: no second create.
    h.groww.createBehavior = "ok";
    const retry = await place(h, order);
    expect(retry.body).toMatchObject({ status: "DUPLICATE", orderStatus: "UNKNOWN", originalStatus: "UNKNOWN" });
    expect(h.groww.count("createOrder")).toBe(1);

    // If the order shows up at Groww later, the next lookup recovers it.
    h.groww.seedOrder({ tradingSymbol: SYMBOL, transactionType: "BUY", quantity: 65 }, "OPEN", { ref: order.idempotencyKey as string });
    const later = await place(h, order);
    expect(later.body).toMatchObject({ status: "DUPLICATE", growwOrderId: "GMKSEED1", originalStatus: "ACCEPTED" });
    expect(h.groww.count("createOrder")).toBe(1);
  });

  it("treats Groww GA007 (reference already used) as a duplicate of the existing order", async () => {
    const h = harness();
    const order = buyOrder();
    h.groww.seedOrder({ tradingSymbol: SYMBOL, transactionType: "BUY", quantity: 65 }, "EXECUTED", { ref: order.idempotencyKey as string });
    const r = await place(h, order);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "DUPLICATE", growwOrderId: "GMKSEED1", orderStatus: "EXECUTED" });
  });

  it("spaces order calls at least ORDER_MIN_INTERVAL_MS apart", async () => {
    const h = harness();
    await place(h, buyOrder());
    expect(h.sleeps).toEqual([]);
    await place(h, buyOrder()); // same instant on the fake clock: must wait the full interval
    expect(h.sleeps).toEqual([250]);
    h.clock.advance(1_000);
    await place(h, buyOrder());
    expect(h.sleeps).toEqual([250]);
  });
});

describe("order status, trades, positions", () => {
  it("normalizes the status by reference and fills in the average price from the order detail", async () => {
    const h = harness();
    const order = buyOrder();
    await place(h, order);
    const o = h.groww.orders.get("GMK1");
    if (!o) throw new Error("missing order");
    o.status = "EXECUTED";
    o.filled = 65;
    o.avg = 101.5;
    const res = await h.call("GET", `/v1/orders/ref/${order.idempotencyKey}?segment=FNO`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ growwOrderId: "GMK1", orderStatus: "EXECUTED", filledQty: 65, avgFillPrice: 101.5, remark: "ok" });
    expect(h.ledger.findSentOrder(order.idempotencyKey as string)?.orderStatus).toBe("EXECUTED");

    const trades = await h.call("GET", "/v1/orders/GMK1/trades?segment=FNO");
    expect(await json(trades)).toEqual({ trades: [{ tradeId: "T-GMK1", price: 101.5, qty: 65, time: "2026-10-06T10:40:01" }] });

    const missing = await h.call("GET", "/v1/orders/ref/NOPE1234?segment=FNO");
    expect(missing.status).toBe(404);
  });

  it("returns signed positions", async () => {
    const h = harness();
    h.groww.positions = [position(SYMBOL, 65), position("SENSEX26O1581000PE", -20)];
    const res = await h.call("GET", "/v1/positions?segment=FNO");
    expect(await json(res)).toEqual({
      positions: [
        { tradingSymbol: SYMBOL, exchange: "NSE", qty: 65, avgPrice: 100, product: "MIS" },
        { tradingSymbol: "SENSEX26O1581000PE", exchange: "BSE", qty: -20, avgPrice: 100, product: "MIS" },
      ],
    });
  });
});

describe("cancel and modify", () => {
  it("cancels through the queue and records it", async () => {
    const h = harness();
    await place(h, buyOrder());
    const res = await h.call("POST", "/v1/orders/GMK1/cancel", { segment: "FNO" });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ orderStatus: "CANCELLED" });
    expect(h.ledger.events("order_cancel")).toHaveLength(1);
  });

  it("refuses order mutations in shadow mode", async () => {
    const h = harness({ RELAY_LIVE: "false" });
    expect((await json(await h.call("POST", "/v1/orders/GMK1/cancel", { segment: "FNO" }))).code).toBe("RELAY_NOT_LIVE");
    expect((await json(await h.call("POST", "/v1/orders/GMK1/modify", { segment: "FNO", price: 99 }))).code).toBe("RELAY_NOT_LIVE");
    expect((await json(await h.call("POST", "/v1/panic", { reason: "test" }))).code).toBe("RELAY_NOT_LIVE");
    expect(h.groww.calls).toHaveLength(0);
  });

  it("re-applies the caps to modifications", async () => {
    const h = harness();
    await place(h, buyOrder({ qty: 65, price: 100 }));
    const modify = (body: Record<string, unknown>) => h.call("POST", "/v1/orders/GMK1/modify", { segment: "FNO", ...body });

    const tooManyLots = await modify({ qty: 195 });
    expect(tooManyLots.status).toBe(422);
    expect((await json(tooManyLots)).code).toBe("CAP_REJECTED");
    expect((await json(await modify({ price: 400 }))).error).toMatch(/MAX_PREMIUM_PER_ORDER_INR/);
    expect((await json(await modify({ orderType: "MARKET" }))).error).toMatch(/requires premiumEstimate/);
    expect(h.groww.count("modifyOrder")).toBe(0);

    const ok = await modify({ price: 110 });
    expect(ok.status).toBe(200);
    expect(h.groww.calls.find((c) => c.method === "modifyOrder")?.args[0]).toEqual({
      growwOrderId: "GMK1",
      segment: "FNO",
      quantity: 65,
      price: 110,
      orderType: "LIMIT",
    });
    expect(h.ledger.findOrderByGrowwId("GMK1")?.premiumInr).toBe(7150);

    const unknown = await h.call("POST", "/v1/orders/GMKOTHER/modify", { segment: "FNO", price: 1 });
    expect((await json(unknown)).code).toBe("UNKNOWN_ORDER");
  });

  it("does not let a SELL modify grow beyond the original quantity", async () => {
    const h = harness();
    h.groww.positions = [position(SYMBOL, 65)];
    await place(h, sellOrder());
    const res = await h.call("POST", "/v1/orders/GMK1/modify", { segment: "FNO", qty: 130 });
    expect(res.status).toBe(422);
    expect((await json(res)).error).toMatch(/increasing a SELL/);
  });
});

describe("POST /v1/panic", () => {
  it("cancels open orders and squares off longs without ever creating a short", async () => {
    const h = harness();
    h.clock.set(ist("2026-10-06T15:40:00")); // after the exit window: panic bypasses it
    const PE = "NIFTY26O1324000PE";
    h.groww.positions = [
      position(SYMBOL, 130), // long 2 lots
      position(PE, 65, { product: "NRML" }), // long 1 lot, NRML
      position("SENSEX26O1581000PE", -20), // a manual short: never touched
      position("NIFTY26O1326000CE", 0), // flat
    ];
    const openBuy = h.groww.seedOrder({ tradingSymbol: SYMBOL, transactionType: "BUY", quantity: 65 });
    const stuckSell = h.groww.seedOrder({ tradingSymbol: SYMBOL, transactionType: "SELL", quantity: 65 });
    h.groww.seedOrder({ tradingSymbol: PE, transactionType: "BUY", quantity: 65 }, "EXECUTED");
    h.groww.failCancelFor.add(stuckSell); // its cancel fails, so it may still fill

    const res = await h.call("POST", "/v1/panic", { reason: "kill switch" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.cancelled).toBe(1);
    expect(h.groww.orders.get(openBuy)?.status).toBe("CANCELLED");

    const sells = h.groww.created();
    expect(sells.every((o) => o.transactionType === "SELL" && o.orderType === "MARKET")).toBe(true);
    expect(sells.map((o) => [o.tradingSymbol, o.quantity, o.product])).toEqual([
      [SYMBOL, 65, "MIS"], // 130 long - 65 still pending in the stuck SELL
      [PE, 65, "NRML"],
    ]);
    // Never a sell beyond (long - pending sells), so never a short.
    for (const s of sells) {
      const long = h.groww.positions.find((p) => p.tradingSymbol === s.tradingSymbol)?.qty ?? 0;
      const pending = [...h.groww.orders.values()]
        .filter((o) => o.input.tradingSymbol === s.tradingSymbol && o.input.transactionType === "SELL" && o.status === "OPEN" && !o.ref.startsWith("PANIC-"))
        .reduce((sum, o) => sum + o.input.quantity, 0);
      expect(s.quantity).toBeLessThanOrEqual(long - pending);
    }
    expect(sells.some((s) => s.tradingSymbol.startsWith("SENSEX"))).toBe(false);
    expect(body.shortsLeft).toEqual([{ tradingSymbol: "SENSEX26O1581000PE", exchange: "BSE", product: "MIS", qty: -20 }]);
    expect((body.errors as string[]).join()).toMatch(new RegExp(`cancel ${stuckSell}`));
    expect(body.exitOrders).toHaveLength(2);
    expect((body.exitOrders as Record<string, unknown>[]).every((e) => e.status === "ACCEPTED")).toBe(true);
    expect(h.ledger.events("panic_done")).toHaveLength(1);
    expect(h.ledger.listOrders().filter((o) => o.source === "PANIC")).toHaveLength(2);
  });

  it("skips a long whose open SELL has an unknown remaining quantity", async () => {
    const h = harness();
    h.groww.positions = [position(SYMBOL, 65)];
    const sell = h.groww.seedOrder({ tradingSymbol: SYMBOL, transactionType: "SELL", quantity: 65 }, "OPEN", { reportQty: false });
    h.groww.failCancelFor.add(sell);
    const body = await json(await h.call("POST", "/v1/panic", { reason: "test" }));
    expect(h.groww.count("createOrder")).toBe(0);
    expect(body.exitOrders).toEqual([expect.objectContaining({ tradingSymbol: SYMBOL, status: "SKIPPED" })]);
  });

  it("bypasses the daily order count", async () => {
    const h = harness({ MAX_ORDERS_PER_DAY: "1" });
    await place(h, buyOrder());
    const filled = h.groww.orders.get("GMK1");
    if (filled) filled.status = "EXECUTED";
    h.groww.positions = [position(SYMBOL, 65)];
    const body = await json(await h.call("POST", "/v1/panic", {}));
    expect(body.exitOrders).toEqual([expect.objectContaining({ status: "ACCEPTED", qty: 65 })]);
  });

  it("stops before selling when the order list cannot be read", async () => {
    const h = harness();
    h.groww.positions = [position(SYMBOL, 65)];
    h.groww.listOrders = async () => {
      throw new Error("groww down");
    };
    const res = await h.call("POST", "/v1/panic", { reason: "test" });
    expect(res.status).toBe(502);
    expect((await json(res)).code).toBe("PANIC_INCOMPLETE");
    expect(h.groww.count("createOrder")).toBe(0);
  });

  it("uses valid Groww reference ids for exit orders", async () => {
    const h = harness();
    h.groww.positions = [position(SYMBOL, 65)];
    await h.call("POST", "/v1/panic", { reason: "test" });
    const ref = h.groww.created()[0]?.orderReferenceId ?? "";
    expect(ref).toMatch(/^PANIC-[A-Z0-9]+-0$/);
    expect(ref.length).toBeLessThanOrEqual(20);
    expect(ref.length).toBeGreaterThanOrEqual(8);
  });
});

describe("newKey helper", () => {
  it("produces valid reference ids", () => {
    expect(newKey()).toMatch(/^[A-Za-z0-9]{8,20}$/);
  });
});
