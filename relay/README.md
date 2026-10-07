# Order relay

A small Node 22 service that sits between the trading engine (Cloudflare Workers) and the
Groww Trade API. It runs on a machine with a **static public IPv4**, holds its own Groww
session, and enforces its own hard caps on every order.

## Why it exists

Since 1 April 2026 SEBI's retail-algo framework requires brokers to accept API **order**
calls only from a static IP that the client has whitelisted (Groww: up to a primary and a
secondary IP, changeable at most about once a week). Cloudflare Workers have no static
egress IP, so the engine cannot place orders itself. Every live order goes:

```
engine Worker ──HTTPS──▶ Cloudflare edge ──Tunnel──▶ cloudflared ──▶ relay :8790 ──▶ api.groww.in
  signs X-Relay-*        Access checks the            (on the VPS,     checks JWT +      (from the
  + service token        service token, adds JWT       outbound only)   HMAC + caps       whitelisted IP)
```

Defense in depth: the relay re-checks every order against caps from **its own**
environment (lots, orders per day, trading window, premium per order and per day, no
shorts, allowlists), so even a compromised engine cannot exceed them. It also keeps a
local SQLite ledger of every decision.

Paper trading does not need the relay. Shadow mode (`RELAY_LIVE=false`) lets the engine
exercise the full live path while every order is rejected with `relay not live`.

## Setup

### 1. A machine with a static IPv4 in Mumbai

Pick a VPS in Mumbai (`ap-south-1` or equivalent) with a **dedicated static public IPv4**:
for example AWS Lightsail Mumbai with an attached static IP, Vultr Mumbai, Akamai/Linode
Mumbai or Oracle Cloud Mumbai. The smallest plan is enough (1 vCPU, 512 MB to 1 GB RAM);
budget about ₹300 to ₹800 a month. A PC on an ISP connection with a static IP also works,
but it must be on for the whole session.

- Use Ubuntu 24.04 LTS or Debian 12. Keep the clock synced: `timedatectl set-ntp true`
  (requests more than 30 s off are rejected).
- The address must stay the same: an IP change means re-whitelisting at Groww, and Groww
  limits how often you can change it.
- Note the IP: `curl -s https://api.ipify.org`.

### 2. Groww: API key of type TOTP and IP whitelist

1. Subscribe to the Trade API on Groww (₹499/month + GST).
2. Open **https://groww.in/trade-api/api-keys** and create an API key of type **TOTP**.
   Copy the **API key** (a long token) and the **TOTP secret** (base32 text behind the QR
   code). They become `GROWW_API_KEY` and `GROWW_TOTP_SECRET` on the relay only. The engine
   never needs them for orders.
3. On the same page, add the VPS's static IP as the **primary** IP (and optionally your
   home static IP as secondary for manual tests).

The relay mints its own access token (`POST /v1/token/api/access` with a TOTP code) at
startup when none is cached, every day at 06:05 IST (tokens expire at 06:00 IST), and after
a 401 (at most once per 5 minutes). Tokens are cached in SQLite, so restarts do not mint
again. It never uses more than 100 of Groww's 150 token calls per 24 h.

### 3. Install the relay

You need Node 22.13 or newer (`node:sqlite` without flags). Generate the shared secret:
`openssl rand -hex 32`.

#### Option A: systemd

```bash
# Node 22 (NodeSource) and a service user
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo useradd --system --home /opt/ruphak-relay --shell /usr/sbin/nologin relay

# Code: copy the relay/ directory to /opt/ruphak-relay (git clone + copy, or rsync)
sudo mkdir -p /opt/ruphak-relay && sudo rsync -a --delete --exclude node_modules --exclude data --exclude .env relay/ /opt/ruphak-relay/
cd /opt/ruphak-relay && sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
sudo mkdir -p data && sudo chown -R relay:relay /opt/ruphak-relay/data && sudo chmod 700 /opt/ruphak-relay/data

# Configuration (start in shadow mode: RELAY_LIVE=false)
sudo cp .env.example /etc/ruphak-relay.env && sudo chmod 600 /etc/ruphak-relay.env
sudoedit /etc/ruphak-relay.env    # RELAY_HMAC_SECRET, GROWW_API_KEY, GROWW_TOTP_SECRET, CF_ACCESS_*

sudo cp deploy/relay.service /etc/systemd/system/relay.service
sudo systemctl daemon-reload && sudo systemctl enable --now relay
journalctl -u relay -f
curl -s http://127.0.0.1:8790/healthz    # {"ok":true}
```

If `command -v node` is not `/usr/bin/node`, edit `ExecStart` in the unit.

#### Option B: Docker Compose (relay + cloudflared)

```bash
cd relay
cp .env.example .env && chmod 600 .env   # fill the secrets and TUNNEL_TOKEN; RELAY_LIVE=false
docker compose up -d --build
docker compose logs -f relay
```

The relay listens on the private compose network only; cloudflared reaches it as
`http://relay:8790`. The ledger lives in the `relay-data` volume. The image includes the
signing helper, so checks can run inside the container (it reads the secret from the
container environment; once `CF_ACCESS_*` is set, requests that bypass Cloudflare get
`ACCESS_MISSING`, so test through the tunnel instead):

```bash
docker compose exec relay node scripts/sign-request.mjs --url http://127.0.0.1:8790 GET /health
```

### 4. Cloudflare Tunnel, Access and engine secrets

Follow [deploy/cloudflared.md](deploy/cloudflared.md). In short:

1. Create an Access **service token** `ruphak-engine` (Client ID and Client Secret).
2. Create the tunnel `ruphak-relay` and the public hostname `relay.<domain>` →
   `http://127.0.0.1:8790` (systemd) or `http://relay:8790` (Docker).
3. Create a self-hosted Access application for `relay.<domain>` with one policy:
   **Action: Service Auth**, include **Service Token = ruphak-engine**. Put its AUD tag and
   your team name into `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` on the relay.
4. Set the engine Worker secrets:

| Worker secret | Value |
|---|---|
| `RELAY_URL` | `https://relay.<domain>` (origin only, no path, no trailing slash) |
| `RELAY_HMAC_SECRET` | the same value as the relay's `RELAY_HMAC_SECRET` |
| `CF_ACCESS_CLIENT_ID` | service token Client ID (sent as `CF-Access-Client-Id`) |
| `CF_ACCESS_CLIENT_SECRET` | service token Client Secret (sent as `CF-Access-Client-Secret`) |

```bash
npx wrangler secret put RELAY_URL --config workers/engine/wrangler.jsonc
# ...and the other three the same way
```

### 5. Shadow mode first

With `RELAY_LIVE=false` the relay is fully wired (auth, Groww token, health, positions,
margins, status lookups) but **every** `POST /v1/orders` is rejected with HTTP 422:

```json
{ "status": "REJECTED", "reason": "relay not live", "violations": ["relay not live", "..."], "rejectedBy": "RELAY" }
```

The engine logs these as would-be orders. `violations` also lists any other cap the
order would have broken (position- and LTP-based checks are skipped in shadow mode, and
Groww is never called for orders). Cancel, modify and panic answer 422 `RELAY_NOT_LIVE`.

Go live only after the engine's go/no-go checklist: set `RELAY_LIVE=true`, restart, and
keep the caps at their minimum for the first sessions.

### 6. Verification checklist

Run from `relay/` on any machine (`RELAY_URL`, `RELAY_HMAC_SECRET`, and for the tunnel
`CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` in the environment or `./.env`):

- [ ] `curl -s http://127.0.0.1:8790/healthz` on the box answers `{"ok":true}`.
- [ ] Without the service token, `https://relay.<domain>/health` is blocked by Access.
- [ ] Signed health: `node scripts/sign-request.mjs GET /health` returns 200 with
      `ok: true`, `growwReachable: true`, `publicIp` equal to the whitelisted IP,
      `tokenValidUntil` in the future and `clockSkewMs` within a few hundred ms.
- [ ] Replay is refused: `node scripts/sign-request.mjs --replay GET /health` prints
      `[1] HTTP 200` then `[2] HTTP 401` (`AUTH_REPLAY`).
- [ ] Skew is refused: `node scripts/sign-request.mjs --skew -40000 GET /health` → 401 `AUTH_SKEW`.
- [ ] An over-cap order is rejected (3 lots > `MAX_LOTS_PER_ORDER=2`), with nothing sent to Groww:
      ```bash
      node scripts/sign-request.mjs POST /v1/orders '{"idempotencyKey":"CHECK-0001","underlying":"NIFTY","tradingSymbol":"<a current NIFTY CE from instrument.csv>","exchange":"NSE","segment":"FNO","side":"BUY","qty":195,"lotSize":65,"orderType":"LIMIT","price":1,"product":"MIS","validity":"DAY"}'
      ```
      → 422 `REJECTED`, violation `3 lots exceeds MAX_LOTS_PER_ORDER 2`.
- [ ] One supervised 1-lot order (market hours, `RELAY_LIVE=true`, watching the Groww app):
      a LIMIT BUY of 1 lot priced well below the market so it rests unfilled, then cancel it:
      ```bash
      node scripts/sign-request.mjs POST /v1/orders '{"idempotencyKey":"MANUAL-0001","underlying":"NIFTY","tradingSymbol":"<symbol>","exchange":"NSE","segment":"FNO","side":"BUY","qty":65,"lotSize":65,"orderType":"LIMIT","price":<far below LTP>,"product":"MIS","validity":"DAY"}'
      node scripts/sign-request.mjs GET '/v1/orders/ref/MANUAL-0001?segment=FNO'
      node scripts/sign-request.mjs POST /v1/orders/<growwOrderId>/cancel '{"segment":"FNO"}'
      ```
      Sending the first command again must return `DUPLICATE` with the same `growwOrderId`.
      Then repeat with a marketable price to see a fill round-trip: `ref` → `trades` →
      `GET /v1/positions` → exit with a SELL of the same quantity.

## Wire protocol (what the engine client implements)

### Authentication

Every request except `GET /healthz` carries:

| Header | Value |
|---|---|
| `X-Relay-Ts` | Unix epoch **milliseconds**, decimal string. Rejected if more than 30 s from the relay clock. |
| `X-Relay-Nonce` | Random string, 16 to 64 characters from `[A-Za-z0-9._~+/=-]` (32 hex chars recommended). Rejected if seen in the last 5 minutes. |
| `X-Relay-Sig` | Lower-case hex `HMAC-SHA256(RELAY_HMAC_SECRET, canonical)` |
| `CF-Access-Client-Id` / `CF-Access-Client-Secret` | Service token, consumed by Cloudflare Access (which then adds `Cf-Access-Jwt-Assertion`; the relay verifies it when `CF_ACCESS_*` is set). |

```
canonical = ts + "\n" + nonce + "\n" + METHOD + "\n" + pathWithQuery + "\n" + sha256hex(rawBody)
```

- `METHOD` upper case; `pathWithQuery` is the path plus `?query` exactly as sent
  (e.g. `/v1/orders/ref/RT123?segment=FNO`), no origin, no fragment; do not re-encode or
  reorder the query after signing.
- `rawBody` is the exact body bytes sent (empty string for GET); hash the same string you send.
- Keep paths and queries to URL-safe characters (percent-encode anything else before
  signing): servers and proxies may normalize other characters, which breaks the signature.
- Test vector (secret `unit-test-secret-0123456789abcdef`, ts `1791263400000`, nonce
  `3f9a1c0d5e7b2a4f6c8d0e1f2a3b4c5d`): `GET /v1/orders/ref/RT20261006A1?segment=FNO` with an
  empty body signs to `c6aaef3a8bf10438339b756a766c776014fe33b760dbddfa1f0d655afc57f679`;
  `POST /v1/orders` with body `{"idempotencyKey":"RT20261006A1","side":"BUY"}` signs to
  `1f4bd6eba737d40998a59b3bc33e777092487d77088da3d07d9907c63b73ba17`.

Auth failures are HTTP 401 `{error, code}` with `code` one of `AUTH_MISSING`,
`AUTH_BAD_TS`, `AUTH_SKEW`, `AUTH_BAD_NONCE`, `AUTH_BAD_SIG`, `AUTH_REPLAY`,
`ACCESS_MISSING`, `ACCESS_INVALID` (503 `ACCESS_UNAVAILABLE` if the Access certs cannot be
fetched; 413 `BODY_TOO_LARGE` above 64 KiB). A nonce is consumed only by a request whose
signature is valid.

### Errors

All errors are JSON `{ "error": string, "code": string }`. Groww failures on non-order
endpoints map to: `GROWW_TOKEN_UNAVAILABLE` 503, `GROWW_AUTH_FAILED` 502, `GROWW_FORBIDDEN`
502 (IP not whitelisted, subscription), `GROWW_NOT_FOUND` 404, `GROWW_REJECTED` 422,
`GROWW_RATE_LIMITED` 503, `GROWW_TIMEOUT` 504, `GROWW_UNAVAILABLE` 502. Others:
`BAD_REQUEST` 400, `NOT_FOUND` 404, `INTERNAL` 500.

### Endpoints

| Method and path | Request | Success response |
|---|---|---|
| `GET /healthz` | no auth | `{ok:true}` |
| `GET /health` | | `{ok, live, version, publicIp, tokenValidUntil, ordersToday, buyPremiumToday, caps, growwReachable, clockIso, clockSkewMs, dataProxy, tokenError?}` |
| `POST /v1/orders` | order (below) | `{status:"ACCEPTED"\|"DUPLICATE"\|"REJECTED", growwOrderId?, orderStatus?, reason?, ...}` |
| `GET /v1/orders/ref/:ref?segment=FNO` | | `{growwOrderId, orderStatus, filledQty, avgFillPrice, remark}` (404 `NOT_FOUND` if Groww has no such reference) |
| `GET /v1/orders/:growwOrderId/trades?segment=FNO` | | `{trades:[{tradeId, price, qty, time}]}` |
| `POST /v1/orders/:growwOrderId/cancel` | `{segment}` | `{orderStatus}` |
| `POST /v1/orders/:growwOrderId/modify` | `{segment, qty?, price?, orderType?, premiumEstimate?}` | `{orderStatus}` |
| `GET /v1/positions?segment=FNO` | | `{positions:[{tradingSymbol, exchange, qty, avgPrice, product}]}`, `qty` signed (long > 0) |
| `GET /v1/margin` | | Groww's `/margins/detail/user` payload as-is |
| `POST /v1/panic` | `{reason}` | `{cancelled, exitOrders:[...], openOrdersRemaining?, shortsLeft?, errors?}` |
| `GET /v1/groww/<path>?<query>` | | Groww's JSON as-is (only with `RELAY_DATA_PROXY=true`) |

`/health`: `ok` is false when no Groww token can be obtained (`tokenError` says why).
`publicIp` comes from api.ipify.org (cached 10 min, `null` on failure); `growwReachable`
is a margins call (cached 60 s). ARM in LIVE should require `ok && live && growwReachable`.

#### POST /v1/orders

```json
{
  "idempotencyKey": "RT-20261006-01",
  "underlying": "NIFTY",
  "tradingSymbol": "NIFTY26O1325000CE",
  "exchange": "NSE",
  "segment": "FNO",
  "side": "BUY",
  "qty": 65,
  "lotSize": 65,
  "orderType": "LIMIT",
  "price": 101.5,
  "product": "MIS",
  "validity": "DAY",
  "premiumEstimate": 101.5
}
```

`idempotencyKey` is sent to Groww as `order_reference_id`: 8 to 20 characters,
alphanumerics plus at most two hyphens. `price` is required for LIMIT and must be omitted
(or 0) for MARKET. `premiumEstimate` (per unit) is required for a MARKET BUY.

| HTTP | Body | Meaning for the engine |
|---|---|---|
| 200 | `{status:"ACCEPTED", growwOrderId, orderStatus, reason?}` | Groww created the order. `reason` carries Groww's remark, or `recovered by order_reference_id lookup after: ...` when the create call timed out and the order was found by reference. |
| 200 | `{status:"DUPLICATE", originalStatus, growwOrderId?, orderStatus?, reason?}` | This key was already sent to Groww; nothing was re-sent. `originalStatus` is the ledger outcome: `ACCEPTED`, `BROKER_REJECTED` or `UNKNOWN`. Without `growwOrderId` the original outcome is still unknown: reconcile by reference. Also returned when Groww answers GA007 (reference already used) and the existing order is found. |
| 422 | `{status:"REJECTED", reason, violations[], rejectedBy:"RELAY"}` | A relay cap (or shadow mode, or no Groww token) refused it. **Nothing was sent**; the key is not consumed (resending the same key is evaluated afresh). `reason` = `violations[0]`. |
| 422 | `{status:"REJECTED", reason, rejectedBy:"BROKER", growwCode?}` | Groww refused the create call (e.g. GA001, margin, IP). The key is consumed. |
| 502 | `{error, code:"ORDER_OUTCOME_UNKNOWN", idempotencyKey}` | Groww timed out or failed (5xx/transport) and no order was found by reference after three lookups (about 6 s). **It was not re-sent.** Poll `GET /v1/orders/ref/:ref`; resending the same key returns `DUPLICATE` (with the order once it appears). |
| 400 | `{error, code:"BAD_REQUEST"}` | Malformed request. |

## Caps

All caps come from the relay's environment (see `.env.example`); defaults in brackets.

| Rule | Behaviour |
|---|---|
| `RELAY_LIVE` [false] | Must be `true` for any order, cancel, modify or panic to reach Groww. |
| `ALLOWED_UNDERLYINGS` [NIFTY,SENSEX] | Underlying must be listed. The symbol must be an option of that underlying (`<UNDERLYING><yy>...CE\|PE`) on its exchange (NIFTY → NSE, SENSEX → BSE). |
| `PRODUCT_ALLOWLIST` [MIS] | Product must be listed. |
| `LOT_SIZES` [NIFTY:65,SENSEX:20] | The order's `lotSize` must equal the relay's, so a compromised engine cannot inflate it. Update after exchange lot revisions (or `off`). |
| `MAX_LOTS_PER_ORDER` [2] | `qty % lotSize == 0` and `qty / lotSize <= max`. |
| `MAX_ORDERS_PER_DAY` [12] | Counts every order sent to Groww today (IST): entries, exits, broker rejections, panic exits. Once reached, **entries** are refused; exits (below) are always allowed so a position can be closed. |
| `TRADING_WINDOW_IST` [09:16-15:12] | Mon-Fri, not in `MARKET_HOLIDAYS` (default: the 2026 NSE/BSE list), start inclusive, end exclusive. |
| `EXIT_WINDOW_END_IST` [15:25] | An **exit** (a SELL whose quantity fits in the long position) is allowed until this time. |
| `ALLOW_SHORT` [false] | A SELL may not exceed the long in that symbol and product (Groww `/positions/user`) minus quantity already pending in open SELL orders (Groww `/order/list`; unknown remaining quantity counts as infinite). If positions or orders cannot be read, the SELL is refused. |
| `MAX_PREMIUM_PER_ORDER_INR` [25000] | BUY premium = `price × qty` (LIMIT) or, for MARKET, `max(premiumEstimate, LTP × 1.01) × qty` using the relay's own Groww LTP; no LTP or no estimate → refused. |
| `MAX_DAILY_PREMIUM_INR` [60000] | Today's BUY premium (every BUY sent today except broker rejections, filled or not) plus this order. |
| Modify | Only orders placed through this relay. Re-checks lots, premium (per order and the daily delta) and the window; a SELL's quantity cannot grow; a BUY changed to MARKET needs `premiumEstimate`. |
| Panic | Needs `RELAY_LIVE=true`; bypasses the window, daily count, lots and allowlists. Cancels every open FNO order, waits up to 5 s for cancellations, then sells each long with a MARKET SELL of `long − still-pending SELL quantity`. Never buys, so it never creates or covers shorts (reported as `shortsLeft`). If the order list cannot be read it sells nothing (502 `PANIC_INCOMPLETE`). |

Order calls to Groww (create, modify, cancel, panic) run one at a time, at least
`ORDER_MIN_INTERVAL_MS` [250] apart, far below Groww's 10/s and 250/min.

## Operations

- **Logs:** JSON lines on stdout (`journalctl -u relay -f`, `docker compose logs -f relay`).
  Secrets are never logged.
- **Ledger:** `data/relay.sqlite` (mode 0600). Tables: `orders` (every decision, with
  request and Groww response), `nonces`, `token`, `events` (startup, token mints, duplicates,
  cancels, modifies, panic). Inspect read-only:
  ```bash
  node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("data/relay.sqlite",{readOnly:true});console.table(db.prepare("SELECT id,ist_date,idempotency_key,side,qty,trading_symbol,status,reason,groww_order_id,order_status FROM orders ORDER BY id DESC LIMIT 20").all())'
  ```
- **Restarts:** an order in flight during a crash is marked `UNKNOWN` at the next start;
  the engine resolves it with `GET /v1/orders/ref/:ref` (which also updates the ledger).
- **Token problems:** `/health` shows `ok:false` and `tokenError`. After a failed mint the
  relay waits 30 s, doubling up to 15 min, before trying again.
- **Upgrades:** copy the new `relay/`, `npm ci && npm run build && npm prune --omit=dev`,
  `sudo systemctl restart relay` (or `docker compose up -d --build`) outside market hours.
- **Backups:** copy `data/relay.sqlite` while the service is stopped, or use
  `sqlite3 data/relay.sqlite ".backup relay-backup.sqlite"`.
- **Every December:** update `MARKET_HOLIDAYS` from the NSE/BSE circulars, and `LOT_SIZES`
  whenever the exchanges revise lots.

## Groww assumptions to re-check on the first live day

Groww specifics live in `src/groww.ts`. Verified against the official cURL docs
(fetched 2026-10-07) and the community `growwapi` SDK, but not yet against a live account:

1. **TOTP key and daily approval.** The docs' heading for the TOTP flow says it "requires
   daily approval on the Groww Cloud API keys page"; the project plan assumes TOTP keys
   need no daily approval. If approval turns out to be required, approve before 06:05 IST
   each trading day; until then `/health` stays `ok:false` (the relay retries with backoff).
2. **Token request body.** The relay sends the documented `{key_type:"totp", totp}` and
   falls back once to the SDK's `{totp}` if Groww answers 400.
3. **Token `expiry`** is read as IST when it has no offset, and never later than the next
   06:00 IST.
4. **Error shapes.** Documented failures are `{status:"FAILURE", error:{code,message}}`.
   A rejected API key was observed to return `{"errorCode":401,"errorMessage":{"message":...}}`;
   both are handled.
5. **Average fill price** is not in the status payloads; the relay reads it from
   `GET /order/detail/{id}`. Field names are mapped defensively and raw payloads are kept
   in the ledger.
6. **MARKET orders** may be converted by the exchange to market-price-protection orders
   (SEBI/NSE), which can rest unfilled in a fast market. The engine should use marketable
   LIMIT orders; panic uses MARKET SELLs and reports their status, so check them.
7. Whether Groww IP-restricts read endpoints (status, list, trades) is unknown; the relay
   serves them from the whitelisted IP anyway.
8. Product names for position rows (`product`) are used to match exits to entries (MIS vs
   NRML); a position row without `product` is squared off as MIS.

## Development

```bash
npm install
npm run dev          # tsx watch; reads ./.env
npm run typecheck
npm test             # vitest: HMAC vectors, replay, TOTP RFC vectors, every cap, idempotency,
                     # timeout -> reference lookup, panic without shorts, proxy allowlist
npm run build && npm start
node scripts/sign-request.mjs --help
```

Code map: `src/app.ts` (routes, injected deps), `src/auth.ts` (HMAC, nonces, Access JWT),
`src/caps.ts` (request schema and caps), `src/orders.ts` (order flows and panic),
`src/groww.ts` (all Groww specifics and the token lifecycle), `src/ledger.ts` (SQLite),
`src/totp.ts`, `src/ist.ts`, `src/config.ts`, `src/index.ts` (process entrypoint).
