import { describe, expect, it } from "vitest";
import {
  errorKindFor,
  GrowwClient,
  GrowwError,
  GrowwTokenManager,
  isOpenOrderStatus,
  normalizeOrderList,
  normalizePositions,
  normalizeTrades,
  type CreateOrderInput,
} from "./groww.js";
import { Ledger } from "./ledger.js";
import { silentLogger } from "./log.js";
import { FakeClock, ist } from "./test-helpers.js";
import { totp } from "./totp.js";

const BASE = "https://api.groww.test/v1";
const TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}
type Reply = { status: number; body: unknown } | Error;
type Handler = (req: SeenRequest) => Reply | Promise<Reply>;

function setup(handler: Handler, opts: { apiKey?: string | null; budget?: number; start?: number } = {}) {
  const clock = new FakeClock(opts.start ?? ist("2026-10-06T08:00:00"));
  const ledger = new Ledger(":memory:", clock);
  const calls: SeenRequest[] = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const req: SeenRequest = {
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    };
    calls.push(req);
    const r = await handler(req);
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  };
  const tokens = new GrowwTokenManager({
    apiKey: opts.apiKey === undefined ? "API-KEY" : opts.apiKey,
    totpSecret: opts.apiKey === null ? null : TOTP_SECRET,
    baseUrl: BASE,
    fetch: fetchFn,
    clock,
    store: ledger,
    logger: silentLogger,
    timeoutMs: 1_000,
    mintBudgetPer24h: opts.budget,
  });
  const client = new GrowwClient({ baseUrl: BASE, fetch: fetchFn, tokens, timeoutMs: 1_000, logger: silentLogger });
  const tokenCalls = () => calls.filter((c) => c.url.endsWith("/token/api/access"));
  return { clock, ledger, tokens, client, calls, tokenCalls, fetchFn };
}

const isToken = (r: SeenRequest) => r.url === `${BASE}/token/api/access`;
const ok = (payload: unknown): Reply => ({ status: 200, body: { status: "SUCCESS", payload } });
const tokenReply = (token: string, expiry = "2026-10-07T06:00:00"): Reply => ({
  status: 200,
  body: { token, tokenRefId: "ref-1", sessionName: "relay", expiry, isActive: true },
});

describe("Groww access token", () => {
  it("mints with the documented TOTP body, then caches the token in SQLite", async () => {
    const s = setup((r) => (isToken(r) ? tokenReply("tok-1") : ok({ clear_cash: 1 })));
    expect(await s.client.getMargins()).toEqual({ clear_cash: 1 });

    const [mint, margins] = s.calls;
    expect(mint).toMatchObject({ method: "POST", body: { key_type: "totp", totp: totp(TOTP_SECRET, s.clock.now()) } });
    expect(mint?.headers).toMatchObject({ authorization: "Bearer API-KEY", "content-type": "application/json", "x-api-version": "1.0" });
    expect(margins).toMatchObject({ method: "GET", url: `${BASE}/margins/detail/user` });
    expect(margins?.headers).toMatchObject({ authorization: "Bearer tok-1", accept: "application/json", "x-api-version": "1.0" });

    // Expiry "2026-10-07T06:00:00" is IST.
    expect(s.tokens.status().validUntil).toBe(Date.parse("2026-10-07T00:30:00Z"));
    expect(s.ledger.loadToken()?.token).toBe("tok-1");
    expect(s.ledger.countMintsSince(0)).toBe(1);

    // A restarted relay reuses the cached token instead of spending the 150/day mint budget.
    const again = new GrowwTokenManager({
      apiKey: "API-KEY",
      totpSecret: TOTP_SECRET,
      baseUrl: BASE,
      fetch: s.fetchFn,
      clock: s.clock,
      store: s.ledger,
      logger: silentLogger,
      timeoutMs: 1_000,
    });
    expect(await again.getToken()).toBe("tok-1");
    expect(s.tokenCalls()).toHaveLength(1);
  });

  it("falls back once to the SDK's {totp} body when the documented form is refused", async () => {
    const s = setup((r) => {
      if (!isToken(r)) return ok({});
      if (r.body?.key_type) return { status: 400, body: { status: "FAILURE", error: { code: "GA001", message: "Bad request" } } };
      return tokenReply("tok-2");
    });
    expect(await s.tokens.getToken()).toBe("tok-2");
    expect(s.tokenCalls().map((c) => Object.keys(c.body ?? {}).sort())).toEqual([["key_type", "totp"], ["totp"]]);
    expect(s.ledger.countMintsSince(0)).toBe(2); // both calls count toward Groww's 150/24 h
  });

  it("accepts token and expiry nested under payload, and caps the expiry at the next 06:00 IST", async () => {
    const s = setup(() => ({ status: 200, body: { status: "SUCCESS", payload: { token: "tok-3", expiry: "2026-10-09T06:00:00" } } }));
    expect(await s.tokens.getToken()).toBe("tok-3");
    expect(s.tokens.status().validUntil).toBe(Date.parse("2026-10-07T00:30:00Z"));
  });

  it("single-flights concurrent mints", async () => {
    const s = setup(async (r) => {
      if (isToken(r)) await new Promise((res) => setTimeout(res, 20));
      return tokenReply("tok-1");
    });
    const tokens = await Promise.all([1, 2, 3, 4, 5].map(() => s.tokens.getToken()));
    expect(new Set(tokens)).toEqual(new Set(["tok-1"]));
    expect(s.tokenCalls()).toHaveLength(1);
  });

  it("re-mints once on 401 and retries, but at most once per 5 minutes", async () => {
    let minted = 0;
    let rejectAll = false;
    const s = setup((r) => {
      if (isToken(r)) return tokenReply(`tok-${++minted}`);
      if (rejectAll || r.headers.authorization === "Bearer tok-1") return { status: 401, body: { status: "FAILURE", error: { code: "GA005", message: "unauthorised" } } };
      return ok({ clear_cash: 2 });
    });
    expect(await s.client.getMargins()).toEqual({ clear_cash: 2 });
    expect(s.tokenCalls()).toHaveLength(2);

    rejectAll = true;
    await expect(s.client.getMargins()).rejects.toMatchObject({ kind: "auth" });
    expect(s.tokenCalls()).toHaveLength(2); // within 5 minutes of the last re-mint: no new mint

    s.clock.advance(6 * 60_000);
    await expect(s.client.getMargins()).rejects.toMatchObject({ kind: "auth" });
    expect(s.tokenCalls()).toHaveLength(3);
  });

  it("backs off after a failed mint and honours the daily mint budget", async () => {
    let fail = true;
    const s = setup(() => (fail ? { status: 500, body: { status: "FAILURE", error: { code: "GA000", message: "Internal error occurred" } } } : tokenReply("tok-ok")), {
      budget: 3,
    });
    await expect(s.tokens.getToken()).rejects.toMatchObject({ kind: "token" });
    await expect(s.tokens.getToken()).rejects.toThrow(/paused until/);
    expect(s.tokenCalls()).toHaveLength(1);
    expect(s.tokens.status().lastError).toMatch(/GA000/);

    s.clock.advance(31_000);
    await expect(s.tokens.getToken()).rejects.toMatchObject({ kind: "token" });
    expect(s.tokenCalls()).toHaveLength(2);

    s.clock.advance(61_000);
    fail = false;
    expect(await s.tokens.getToken()).toBe("tok-ok"); // third call: budget reached afterwards
    s.ledger.clearToken();
    await expect(s.tokens.refresh("test")).rejects.toThrow(/budget exhausted/);
    expect(s.tokenCalls()).toHaveLength(3);
  });

  it("reads the gateway's error shape for rejected API keys", async () => {
    // Observed live from api.groww.in with an invalid API key (2026-10-07).
    const s = setup(() => ({ status: 401, body: { errorCode: 401, errorMessage: { message: "Please Login and Try Again" } } }));
    await expect(s.tokens.getToken()).rejects.toThrow("token mint failed: token endpoint HTTP 401: Please Login and Try Again");
  });

  it("refuses an inactive token and reports missing credentials without calling Groww", async () => {
    const inactive = setup(() => ({ status: 200, body: { token: "tok", expiry: "2026-10-07T06:00:00", isActive: false } }));
    await expect(inactive.tokens.getToken()).rejects.toThrow(/inactive/);

    const none = setup(() => tokenReply("never"), { apiKey: null });
    await expect(none.tokens.getToken()).rejects.toThrow(/not configured/);
    expect(none.calls).toHaveLength(0);
  });

  it("re-mints proactively after 06:05 IST", async () => {
    let minted = 0;
    const s = setup(() => tokenReply(`tok-${++minted}`), { start: ist("2026-10-06T10:00:00") });
    await s.tokens.getToken();
    s.clock.set(ist("2026-10-07T06:04:00"));
    expect(await s.tokens.maybeScheduledRefresh()).toBe(false);
    s.clock.set(ist("2026-10-07T06:05:00"));
    expect(await s.tokens.maybeScheduledRefresh()).toBe(true);
    expect(s.ledger.loadToken()?.token).toBe("tok-2");
    s.clock.set(ist("2026-10-07T07:00:00"));
    expect(await s.tokens.maybeScheduledRefresh()).toBe(false);
    expect(minted).toBe(2);
  });
});

describe("Groww REST mapping", () => {
  const order: CreateOrderInput = {
    tradingSymbol: "NIFTY26O1325000CE",
    quantity: 65,
    price: 101.5,
    validity: "DAY",
    exchange: "NSE",
    segment: "FNO",
    product: "MIS",
    orderType: "LIMIT",
    transactionType: "BUY",
    orderReferenceId: "RT-20261006-01",
  };

  it("sends a snake_case create body and reads the ack", async () => {
    const s = setup((r) =>
      isToken(r)
        ? tokenReply("tok")
        : ok({ groww_order_id: "GMK39038RDT490CCVRO", order_status: "OPEN", order_reference_id: "RT-20261006-01", remark: "Order placed successfully" }),
    );
    const ack = await s.client.createOrder(order);
    expect(ack).toMatchObject({ growwOrderId: "GMK39038RDT490CCVRO", orderStatus: "OPEN", remark: "Order placed successfully" });
    const create = s.calls.find((c) => c.url === `${BASE}/order/create`);
    expect(create?.method).toBe("POST");
    expect(create?.body).toEqual({
      trading_symbol: "NIFTY26O1325000CE",
      quantity: 65,
      price: 101.5,
      validity: "DAY",
      exchange: "NSE",
      segment: "FNO",
      product: "MIS",
      order_type: "LIMIT",
      transaction_type: "BUY",
      order_reference_id: "RT-20261006-01",
    });

    await s.client.createOrder({ ...order, orderType: "MARKET", price: null, transactionType: "SELL" });
    expect(s.calls.filter((c) => c.url.endsWith("/order/create"))[1]?.body).toMatchObject({ price: 0, order_type: "MARKET", transaction_type: "SELL" });
  });

  it("uses the documented paths for status, trades, list, cancel, modify, positions and LTP", async () => {
    const s = setup((r) => {
      if (isToken(r)) return tokenReply("tok");
      const path = r.url.slice(BASE.length);
      if (path.startsWith("/order/status/reference/RT-")) return ok({ groww_order_id: "G1", order_status: "EXECUTED", filled_quantity: 65, remark: "done" });
      if (path.startsWith("/order/trades/")) return ok({ trade_list: [{ groww_trade_id: "T1", price: 101.5, quantity: 65, trade_date_time: "2026-10-06T10:40:01" }] });
      if (path.startsWith("/order/list")) return ok({ order_list: [{ groww_order_id: "G1", trading_symbol: "X", order_status: "OPEN", transaction_type: "SELL", quantity: 65, filled_quantity: 0, remaining_quantity: 65, product: "MIS" }] });
      if (path === "/order/cancel") return ok({ groww_order_id: "G1", order_status: "CANCELLATION_REQUESTED" });
      if (path === "/order/modify") return ok({ groww_order_id: "G1", order_status: "MODIFICATION_REQUESTED" });
      if (path.startsWith("/positions/user")) return ok({ positions: [] });
      if (path.startsWith("/live-data/ltp")) return ok({ NSE_NIFTY26O1325000CE: 123.4 });
      return { status: 404, body: { status: "FAILURE", error: { code: "GA004", message: "Requested entity does not exist" } } };
    });
    expect(await s.client.getOrderStatusByRef("RT-20261006-01", "FNO")).toMatchObject({ growwOrderId: "G1", orderStatus: "EXECUTED", filledQty: 65 });
    expect(await s.client.getTrades("G1", "FNO")).toEqual([{ tradeId: "T1", price: 101.5, qty: 65, time: "2026-10-06T10:40:01" }]);
    expect((await s.client.listOrders("FNO", 0, 25))[0]).toMatchObject({ growwOrderId: "G1", transactionType: "SELL", remainingQty: 65 });
    expect(await s.client.cancelOrder("G1", "FNO")).toMatchObject({ orderStatus: "CANCELLATION_REQUESTED" });
    expect(await s.client.modifyOrder({ growwOrderId: "G1", segment: "FNO", quantity: 65, price: 99, orderType: "LIMIT" })).toMatchObject({
      orderStatus: "MODIFICATION_REQUESTED",
    });
    expect(await s.client.getPositions("FNO")).toEqual([]);
    expect(await s.client.getLtp("FNO", ["NSE_NIFTY26O1325000CE"])).toEqual({ NSE_NIFTY26O1325000CE: 123.4 });
    expect(await s.client.getOrderStatusByRef("NOPE1234", "FNO")).toBeNull(); // GA004

    const urls = s.calls.filter((c) => !isToken(c)).map((c) => `${c.method} ${c.url.slice(BASE.length)}`);
    expect(urls).toEqual([
      "GET /order/status/reference/RT-20261006-01?segment=FNO",
      "GET /order/trades/G1?segment=FNO&page=0&page_size=50",
      "GET /order/list?segment=FNO&page=0&page_size=25",
      "POST /order/cancel",
      "POST /order/modify",
      "GET /positions/user?segment=FNO",
      "GET /live-data/ltp?segment=FNO&exchange_symbols=NSE_NIFTY26O1325000CE",
      "GET /order/status/reference/NOPE1234?segment=FNO",
    ]);
    expect(s.calls.find((c) => c.url.endsWith("/order/cancel"))?.body).toEqual({ segment: "FNO", groww_order_id: "G1" });
    expect(s.calls.find((c) => c.url.endsWith("/order/modify"))?.body).toEqual({ segment: "FNO", groww_order_id: "G1", order_type: "LIMIT", quantity: 65, price: 99 });
  });

  it("classifies failures so ambiguous ones are looked up, never resent", async () => {
    const replies: Reply[] = [];
    const s = setup((r) => (isToken(r) ? tokenReply("tok") : (replies.shift() ?? { status: 500, body: "" })));
    const attempt = async (reply: Reply) => {
      replies.push(reply);
      try {
        await s.client.createOrder(order);
        return null;
      } catch (e) {
        return e as GrowwError;
      }
    };
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const cases: [Reply, string, boolean][] = [
      [{ status: 400, body: { status: "FAILURE", error: { code: "GA007", message: "Duplicate order reference id" } } }, "duplicate_ref", false],
      [{ status: 400, body: { status: "FAILURE", error: { code: "GA001", message: "Bad request" } } }, "bad_request", false],
      [{ status: 403, body: { status: "FAILURE", error: { code: "GA005", message: "User not authorised" } } }, "forbidden", false],
      [{ status: 429, body: "Too Many Requests" }, "rate_limited", false],
      [{ status: 503, body: "<html>bad gateway</html>" }, "server", true],
      [{ status: 200, body: "not json" }, "invalid_response", true],
      [{ status: 200, body: { status: "SUCCESS", payload: { order_status: "OPEN" } } }, "invalid_response", true],
      [timeout, "timeout", true],
      [new TypeError("fetch failed"), "network", true],
    ];
    for (const [reply, kind, ambiguous] of cases) {
      const e = await attempt(reply);
      expect(e, kind).toBeInstanceOf(GrowwError);
      expect(e?.kind, kind).toBe(kind);
      expect(e?.ambiguous, kind).toBe(ambiguous);
    }
    expect(errorKindFor(200, undefined)).toBe("bad_request");
  });

  it("passes data-proxy responses through as-is", async () => {
    const s = setup((r) => (isToken(r) ? tokenReply("tok") : { status: 200, body: { status: "SUCCESS", payload: { NSE_NIFTY: 25000 } } }));
    expect(await s.client.proxyGet("/live-data/ltp?segment=CASH&exchange_symbols=NSE_NIFTY")).toEqual({
      status: 200,
      body: { status: "SUCCESS", payload: { NSE_NIFTY: 25000 } },
    });
    expect(s.calls.at(-1)?.url).toBe(`${BASE}/live-data/ltp?segment=CASH&exchange_symbols=NSE_NIFTY`);
  });
});

describe("Groww payload normalization", () => {
  it("reads the documented positions example (net quantity, product, net price)", () => {
    const docs = {
      positions: [
        {
          trading_symbol: "RELIANCE",
          credit_quantity: 10,
          credit_price: 12500,
          debit_quantity: 5,
          debit_price: 12000,
          carry_forward_credit_quantity: 8,
          carry_forward_credit_price: 12300,
          carry_forward_debit_quantity: 3,
          carry_forward_debit_price: 11800,
          exchange: "NSE",
          symbol_isin: "INE123A01016",
          quantity: 15,
          product: "CNC",
          net_carry_forward_quantity: 10,
          net_price: 12400,
          net_carry_forward_price: 12200,
          realised_pnl: 500,
        },
      ],
    };
    expect(normalizePositions(docs)).toMatchObject([{ tradingSymbol: "RELIANCE", exchange: "NSE", product: "CNC", qty: 15, avgPrice: 12400 }]);
    // Without `quantity`, net = credit - debit + net carry-forward.
    const noQty = Object.fromEntries(Object.entries(docs.positions[0] as Record<string, unknown>).filter(([k]) => k !== "quantity"));
    expect(normalizePositions({ positions: [noQty] })[0]?.qty).toBe(15);
    expect(normalizePositions({ positions: [{ trading_symbol: "X", quantity: -20 }] })[0]?.qty).toBe(-20);
    expect(normalizePositions(null)).toEqual([]);
  });

  it("treats an unknown payload shape as an error, never as 'no positions'", () => {
    expect(() => normalizePositions({ data: [{ trading_symbol: "X", quantity: 65 }] })).toThrow(GrowwError);
    expect(() => normalizeOrderList({ something: [] })).toThrow(GrowwError);
  });

  it("treats only documented terminal statuses as closed", () => {
    for (const s of ["EXECUTED", "COMPLETED", "CANCELLED", "REJECTED", "FAILED", "DELIVERY_AWAITED", "executed"]) expect(isOpenOrderStatus(s), s).toBe(false);
    for (const s of ["NEW", "ACKED", "OPEN", "TRIGGER_PENDING", "APPROVED", "CANCELLATION_REQUESTED", "MODIFICATION_REQUESTED", "PARTIALLY_EXECUTED", "", null]) {
      expect(isOpenOrderStatus(s), String(s)).toBe(true);
    }
  });

  it("reads order lists and trade lists", () => {
    expect(normalizeOrderList({ order_list: [{ groww_order_id: "G1", order_status: "OPEN", average_fill_price: 2500 }] })[0]).toMatchObject({
      growwOrderId: "G1",
      orderStatus: "OPEN",
      avgFillPrice: 2500,
    });
    expect(normalizeTrades({ trade_list: [{ groww_trade_id: "T1", price: 0, quantity: 100, trade_date_time: "2024-08-24T14:15:22Z" }] })).toEqual([
      { tradeId: "T1", price: 0, qty: 100, time: "2024-08-24T14:15:22Z" },
    ]);
  });
});
