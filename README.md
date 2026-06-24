# wab — WhatsApp (Baileys) engine

A thin, single-purpose Node service that owns one WhatsApp connection (via [Baileys](https://github.com/WhiskeySockets/Baileys)) and exposes a small HTTP API. It does **no** logging, queueing, or business logic — that's [Notify](https://notify.tarkib.co.uk)'s job. wab just connects and sends.

Runs on `127.0.0.1:3210` in PM2 **fork** mode, fronted by a CloudPanel reverse proxy at `https://wab.tarkib.co.uk` with SSL. Every endpoint requires the `X-Internal-Secret` header (except `/health` and `/link`).

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/health` | — | `{ status, state }` (no auth) |
| `GET` | `/api/status` | — | `{ state, phone, since, hasQr }` |
| `GET` | `/api/qr` | — | `{ qr: "<data-url>" \| null, state }` |
| `POST` | `/api/pair` | `{ number }` | `{ success, code }` — 8-char pairing code |
| `POST` | `/api/send` | `{ to, message }` | `{ success, id, to }` |
| `POST` | `/api/reconnect` | — | `{ success }` |
| `POST` | `/api/logout` | — | `{ success }` |
| `GET` | `/link?key=<secret>` | — | HTML page with a live auto-refreshing QR |

`state` is one of `connecting`, `open`, `logged_out`.

`/api/send` errors: `409` not connected · `400` number not on WhatsApp · `422` missing fields.

## Deploy (server, one-time)

```bash
# 1. Clone (CloudPanel reverse-proxy sites don't serve files, so location is flexible)
cd ~/htdocs && git clone <repo-url> wab.tarkib.co.uk && cd wab.tarkib.co.uk

# 2. Install deps (no Chromium — Baileys is pure WebSocket)
npm ci

# 3. Configure the shared secret
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste into INTERNAL_SECRET
nano .env

# 4. Install PM2 (once, as root) then launch in fork mode
npm install -g pm2                 # as root
pm2 start ecosystem.config.cjs     # as the site user
pm2 save
pm2 startup                        # prints a sudo command — run it as root, then `pm2 save` again
```

Then in CloudPanel: create a **Reverse Proxy** site for `wab.tarkib.co.uk` → `http://127.0.0.1:3210`, and issue Let's Encrypt SSL.

## Linking the WhatsApp number — use the PAIRING CODE

> ⚠️ **QR scanning does not work from a datacenter/VPS IP.** WhatsApp refuses to link a
> device via QR from cloud IPs ("Couldn't link device. Try again later."), even though the
> QR renders fine. **Use the pairing-code method instead** — it links over a different flow
> that WhatsApp accepts from servers.

Prerequisite: the number must already be registered on WhatsApp on a **primary phone** (Baileys links as a companion device — it does not register numbers).

```bash
# Request an 8-character pairing code for the number (international format, digits only)
curl -s -X POST \
  -H "X-Internal-Secret: <secret>" \
  -H "Content-Type: application/json" \
  -d '{"number":"447848103867"}' \
  https://wab.tarkib.co.uk/api/pair
# → {"success":true,"code":"ABCD1234"}
```

On the phone: **WhatsApp → Linked Devices → Link a Device → "Link with phone number instead"** → enter the code. WhatsApp shows a "might be a scam" warning for this flow — that's normal; proceed.

Confirm:

```bash
curl -s -H "X-Internal-Secret: <secret>" https://wab.tarkib.co.uk/api/status
# → {"state":"open","phone":"447848103867",...}
```

The session persists in `auth/`, so restarts reconnect with no re-link. `logged_out` means the phone unlinked the device — request a new pairing code to re-link.

> Fallback if pairing code ever fails too: link from a **residential** connection (QR works there) using a local copy of this service, then `scp` the local `auth/` folder up to `~/htdocs/wab.tarkib.co.uk/auth` and `pm2 restart wab`. The IP sensitivity is only at the moment of linking — an established session runs fine from the server.

## Changing the phone number (e.g. swapping the temp number for a permanent one)

1. **Register the new number on WhatsApp** on its own primary phone first (receive the SMS code, set up the account). Send a manual message or two so it's "warmed up."
2. **Log out the current session** on the server:
   ```bash
   curl -s -X POST -H "X-Internal-Secret: <secret>" https://wab.tarkib.co.uk/api/logout
   ```
   This wipes `auth/` and resets the service to an unlinked state.
3. **Request a pairing code for the new number** (same `/api/pair` call as above, with the new number) and enter it on the new phone.
4. **Verify** `/api/status` shows `open` with the new number.

No redeploy or restart needed — linking is a runtime operation. (Notify's dashboard exposes all of this as buttons, so in practice you do it from the UI.)

## Logs

```bash
pm2 logs wab
```

## Operational notes / gotchas

- **Fork mode only.** Run under PM2 as `exec_mode: 'fork'`. Cluster mode breaks the single stateful socket (causes a code-408 `connectionLost` reconnect loop). Never set `instances` > 1.
- **`trust proxy` is set** (`app.set('trust proxy', 1)`) because the service sits behind CloudPanel's reverse proxy — otherwise `express-rate-limit` throws on the `X-Forwarded-For` header.
- **Stale Baileys version** causes immediate code-405 disconnect loops with no QR; the service pins the current version via `fetchLatestBaileysVersion()`.
- **Code 515** right after first link is normal (a restart-required handshake) — it auto-reconnects to `open`.
- **The ~14-day rule:** the primary phone must connect to WhatsApp at least every couple of weeks, or WhatsApp logs out all linked devices (including this one). Notify's weekly health check surfaces this.
