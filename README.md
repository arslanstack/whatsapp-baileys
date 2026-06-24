# wab — WhatsApp (Baileys) engine

A thin, single-purpose Node service that owns one WhatsApp connection (via [Baileys](https://github.com/WhiskeySockets/Baileys)) and exposes a small HTTP API. It does **no** logging, queueing, or business logic — that's [Notify](https://notify.tarkib.co.uk)'s job. wab just connects and sends.

Runs on `127.0.0.1:3210`, fronted by a CloudPanel reverse proxy at `https://wab.tarkib.co.uk` with SSL. Every endpoint requires the `X-Internal-Secret` header (except `/health`).

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/health` | — | `{ status, state }` (no auth) |
| `GET` | `/api/status` | — | `{ state, phone, since, hasQr }` |
| `GET` | `/api/qr` | — | `{ qr: "<data-url>" \| null, state }` |
| `POST` | `/api/send` | `{ to, message }` | `{ success, id, to }` |
| `POST` | `/api/reconnect` | — | `{ success }` |
| `POST` | `/api/logout` | — | `{ success }` |

`state` is one of `connecting`, `open`, `logged_out`.

`/api/send` errors: `409` not connected · `400` number not on WhatsApp · `422` missing fields.

## Deploy (server, one-time)

```bash
# 1. Clone outside any web root
cd /home/<wab-site-user>
git clone <repo-url> wab && cd wab

# 2. Install deps (no Chromium — Baileys is pure WebSocket)
npm ci

# 3. Configure the shared secret
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste into INTERNAL_SECRET
nano .env

# 4. Install PM2 (once, as root) and launch
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup        # follow the printed command to enable boot start
```

Then in CloudPanel: create a **Reverse Proxy** site for `wab.tarkib.co.uk` → `http://127.0.0.1:3210`, and issue Let's Encrypt SSL.

## Link the WhatsApp number

1. Visit `https://wab.tarkib.co.uk/api/qr` (send the `X-Internal-Secret` header — use a REST client or browser extension).
2. Scan the returned QR image with the phone: **WhatsApp → Linked Devices → Link a Device**.
3. `GET /api/status` should flip to `{ "state": "open" }`.

The session persists in `auth/` — restarts reconnect with no re-scan. A `logged_out` state means the phone unlinked the device; a fresh QR is generated automatically for re-linking.

## Logs

```bash
pm2 logs wab
```

> Note: the primary phone must connect to WhatsApp roughly every 14 days, or WhatsApp logs out all linked devices (including this one). Notify's weekly health check surfaces this.
