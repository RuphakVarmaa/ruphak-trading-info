# Cloudflare Tunnel + Access for the relay

The engine Worker reaches the relay at `https://relay.<your-domain>`. Nothing on the VPS
listens on a public port: `cloudflared` makes an outbound connection to Cloudflare, and
Cloudflare Access only lets requests through that carry the engine's **service token**.
The relay then checks the Access JWT (optional but recommended) **and** the HMAC signature.

```
Worker --HTTPS + CF-Access-Client-Id/Secret + X-Relay-*--> Cloudflare edge (Access)
       --tunnel--> cloudflared (VPS) --> http://127.0.0.1:8790 (relay) --> api.groww.in
```

Prerequisites: a domain on Cloudflare (DNS proxied by Cloudflare) and a Zero Trust
organization (free plan is enough). Your team name is shown in Zero Trust under
**Settings > Custom pages** (or **Settings > General**) as `<team>.cloudflareaccess.com`.

## 1. Create the service token (the engine's credential)

1. Zero Trust dashboard > **Access > Service auth > Service Tokens > Create Service Token**.
2. Name it `ruphak-engine`, choose a duration (e.g. 1 year; set a calendar reminder to rotate).
3. Copy the **Client ID** and **Client Secret**. The secret is shown only once.
   They become the engine Worker secrets `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.

## 2. Create the tunnel

1. Zero Trust > **Networks > Tunnels > Create a tunnel** > type **Cloudflared** > name `ruphak-relay`.
2. Choose the environment:
   - **systemd (relay installed with deploy/relay.service):** pick Debian/Ubuntu and run
     the shown commands on the VPS. They install the `cloudflared` package and run
     `sudo cloudflared service install <TOKEN>`, which creates and starts
     `cloudflared.service`. Check with `systemctl status cloudflared`.
   - **Docker (docker-compose.yml):** copy only the token (the long string after
     `service install`) into `relay/.env` as `TUNNEL_TOKEN=...`. Compose runs cloudflared.
3. **Public hostname** tab > Add a public hostname:
   - Subdomain `relay`, domain `<your-domain>`, path empty.
   - Service type `HTTP`, URL:
     - systemd install: `127.0.0.1:8790`
     - Docker install: `relay:8790`
4. Save. DNS for `relay.<your-domain>` is created automatically.

## 3. Protect the hostname with Access

1. Zero Trust > **Access > Applications > Add an application > Self-hosted**.
2. Application name `ruphak-relay`, application domain `relay.<your-domain>` (no path).
   Session duration does not matter for service tokens.
3. Add a policy:
   - Policy name `engine service token`, **Action: Service Auth**.
   - Include rule: **Service Token** = `ruphak-engine`.
   - Do not add any Allow/email rules: only the engine should ever reach this host.
4. Save the application, open it again and copy the **Application Audience (AUD) Tag**
   (Overview / Basic information).
5. On the relay, set (in `/etc/ruphak-relay.env` or `relay/.env`):
   ```
   CF_ACCESS_TEAM_DOMAIN=<team>            # or <team>.cloudflareaccess.com
   CF_ACCESS_AUD=<the AUD tag>
   ```
   and restart the relay. With these set, every request except `/healthz` must carry a
   valid `Cf-Access-Jwt-Assertion` (Cloudflare adds it after validating the service token),
   verified with RS256 against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`.

## 4. Engine Worker secrets

From the repository root:

```bash
npx wrangler secret put RELAY_URL --config workers/engine/wrangler.jsonc               # https://relay.<your-domain>
npx wrangler secret put RELAY_HMAC_SECRET --config workers/engine/wrangler.jsonc       # same value as on the relay
npx wrangler secret put CF_ACCESS_CLIENT_ID --config workers/engine/wrangler.jsonc     # from step 1
npx wrangler secret put CF_ACCESS_CLIENT_SECRET --config workers/engine/wrangler.jsonc # from step 1
```

`RELAY_URL` is an origin only (no path, no trailing slash): the engine signs the request
path exactly as it sends it.

## 5. Lock down the VPS

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from <your-home-ip> to any port 22 proto tcp   # SSH only from you
sudo ufw enable
```

cloudflared needs only outbound TCP/UDP 7844 (and 443). The relay binds to
`127.0.0.1` (systemd) or to the private Docker network (no published port).

## 6. Verify

```bash
# 1. Without credentials Access blocks the request (403 or a redirect to the Access login page):
curl -sS -o /dev/null -w '%{http_code}\n' https://relay.<your-domain>/health

# 2. With the service token but without HMAC the relay answers 401 AUTH_MISSING:
curl -sS https://relay.<your-domain>/health \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"

# 3. Fully signed (run from relay/ on any machine with the secrets in the environment):
RELAY_URL=https://relay.<your-domain> node scripts/sign-request.mjs GET /health
```

The third call must return `200` with `publicIp` equal to the VPS's static IP (the one
whitelisted at Groww). If the relay logs `ACCESS_INVALID`, re-check `CF_ACCESS_AUD` and
`CF_ACCESS_TEAM_DOMAIN`; `ACCESS_UNAVAILABLE` means the relay could not download the certs.

## Rotation

- **Service token:** create a new token, add it to the Access policy, update the two
  Worker secrets, then delete the old token.
- **HMAC secret:** update the relay env and the Worker secret together (requests fail with
  `AUTH_BAD_SIG` in between; do it outside market hours).
- **Tunnel token:** Zero Trust > Tunnels > `ruphak-relay` > Configure > Refresh token, then
  reinstall the service (`sudo cloudflared service uninstall && sudo cloudflared service install <NEW>`)
  or update `TUNNEL_TOKEN` and `docker compose up -d`.
