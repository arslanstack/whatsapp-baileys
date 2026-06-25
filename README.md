# wab — WhatsApp (Baileys) engine

A thin, single-purpose Node service that owns one WhatsApp connection (via [Baileys](https://github.com/WhiskeySockets/Baileys)) and exposes a small HTTP API. It does **no** logging, queueing, or business logic — that's [Notify](https://notify.tarkib.co.uk)'s job. wab just connects and sends.

Runs on `127.0.0.1:3210` in PM2 **fork** mode, behind a CloudPanel reverse proxy at `https://wab.tarkib.co.uk` (SSL). Every endpoint requires the `X-Internal-Secret` header (except `/health`).

> **The single most important fact:** wab routes its WhatsApp connection through a **residential IP** (a phone running Tailscale as an exit node). Without this it does not work — see [Why the residential proxy is essential](#why-the-residential-proxy-is-essential).

---

## Table of contents
- [Why the residential proxy is essential](#why-the-residential-proxy-is-essential)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [API](#api)
- [Deploy the service](#deploy-the-service)
- [Set up the residential proxy (Tailscale)](#set-up-the-residential-proxy-tailscale)
- [Link a WhatsApp number](#link-a-whatsapp-number)
- [Changing the number](#changing-the-number)
- [Warm-up & safe usage](#warm-up--safe-usage)
- [Operational notes & gotchas](#operational-notes--gotchas)

---

## Why the residential proxy is essential

WhatsApp **silently restricts Baileys companion devices that connect from datacenter / VPS IPs.** The symptom is nasty and confusing:

- The socket connects fine and `/api/send` returns `success` with a real message ID…
- …but the messages **never propagate** — not to the recipient, and **not even to the primary phone's own chat list**.
- Meanwhile a *genuine* WhatsApp Web/Desktop device on the same account works perfectly, and manual phone messages send fine.

So the **account is healthy** — WhatsApp is specifically dropping the unofficial companion's traffic because it originates from a flagged datacenter IP. No browser-identity change, presence flag, or re-link fixes this.

**The fix:** make wab's WhatsApp connection exit from a **residential IP**. We do this by running [Tailscale](https://tailscale.com) on a phone (as an *exit node*) and routing **only wab's WhatsApp socket** through it via a local SOCKS proxy. WhatsApp then sees the companion on a normal residential IP, co-located with the primary phone, and everything propagates.

Two hard-won rules that go with this:
1. **Use an aged, warmed-up number** — a fresh/temp number gets burned almost immediately. (We burned one permanently during development.)
2. **Link once, gently, and never churn it** — repeated re-link/logout cycles are what flag a number, *more* than the IP. Leave a working session alone.

## Architecture

```
                       https://notify.tarkib.co.uk            https://wab.tarkib.co.uk
                                  │                                      │
                          ┌───────▼────────┐                    ┌────────▼─────────┐
                          │ Notify (Laravel)│  localhost call    │ CloudPanel proxy │
                          │ API · queue ·   │───X-Internal-Secret│   → 127.0.0.1:3210│
                          │ logging · UI    │                    └────────┬─────────┘
                          └─────────────────┘                             │
                                                              ┌───────────▼────────────┐
                                                              │ wab (Node, PM2 fork)    │
                                                              │ Baileys socket          │
                                                              │   └─ agent: SOCKS5 ─────┐│
                                                              └─────────────────────────┘│
                                                                                         │ socks5h://127.0.0.1:1055
                                                              ┌──────────────────────────▼┐
                                                              │ tailscaled (userspace, PM2)│
                                                              │ SOCKS5 :1055 → exit node   │
                                                              └──────────────┬─────────────┘
                                                                             │ Tailscale
                                                              ┌──────────────▼─────────────┐
                                                              │ Phone (Tailscale exit node)│
                                                              │ home WiFi · residential IP │
                                                              └──────────────┬─────────────┘
                                                                             ▼
                                                                       WhatsApp servers
```

Only wab's WhatsApp traffic goes through the phone. Everything else on the server (Notify, system, updates) uses its normal connection — and if the phone goes offline, **only wab** is affected.

## Requirements

- **An aged, warmed WhatsApp number** registered on a primary phone (Baileys links as a *companion*; it does not register numbers). Not a fresh/temp number.
- **A phone to act as the Tailscale exit node**, kept **at home on stable WiFi, plugged in** (mobile data causes connection flapping — see gotchas).
- **VPS:** Node 20+, PM2, a CloudPanel reverse-proxy site with SSL.
- **A Tailscale account** (free tier is enough).

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/health` | — | `{ status, state }` (no auth) |
| `GET` | `/api/status` | — | `{ state, phone, since, hasQr }` |
| `POST` | `/api/pair` | `{ number }` | `{ success, code }` — 8-char pairing code |
| `POST` | `/api/send` | `{ to, message }` | `{ success, id, to }` |
| `POST` | `/api/reconnect` | — | `{ success }` |
| `POST` | `/api/logout` | — | `{ success }` |

`state`: `connecting` · `open` · `logged_out`. `/api/send` errors: `409` not connected · `400` not on WhatsApp · `422` missing fields. All endpoints except `/health` require header `X-Internal-Secret`.

## Deploy the service

On the VPS, as the **site user** (e.g. `tarkib-wab`) — no root needed:

```bash
cd ~/htdocs && git clone <repo-url> wab.tarkib.co.uk && cd wab.tarkib.co.uk
npm ci

cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → INTERNAL_SECRET
nano .env     # set INTERNAL_SECRET and WAB_PROXY=socks5h://127.0.0.1:1055
```

PM2 (install once as root: `npm install -g pm2`):

```bash
pm2 start ecosystem.config.cjs    # runs wab in fork mode
pm2 save
pm2 startup                        # run the printed sudo command as root, then `pm2 save` again
```

In CloudPanel: create a **Reverse Proxy** site for `wab.tarkib.co.uk` → `http://127.0.0.1:3210`, issue Let's Encrypt SSL.

## Set up the residential proxy (Tailscale)

This is what makes wab actually work. Two sides: the phone (exit node) and the VPS (SOCKS proxy through it).

### On the phone

1. Install the **Tailscale** app, sign in (same account you'll use on the VPS).
2. Enable **"Use as exit node"** (app menu / Settings → Exit Node → Run as exit node).
3. Approve it: **https://login.tailscale.com/admin/machines** → the phone → ⋯ → **Edit route settings** → tick **Use as exit node** → Save.
4. Harden so Android doesn't kill it:
   - **Always-on VPN**: Android Settings → VPN → Tailscale (gear) → Always-on VPN **ON** (leave "Block connections without VPN" **OFF**).
   - Battery: set Tailscale to **Unrestricted** + allow background + auto-launch.
   - **Lock** Tailscale in the recent-apps list so "clear all" doesn't kill it.
   - WiFi → **Keep WiFi on during sleep = Always**.
   - **Keep the phone on home WiFi and plugged in.** (Mobile data / network switching causes flapping.)

### On the VPS (as the site user, no root — userspace mode)

```bash
cd ~
curl -fsSL https://pkgs.tailscale.com/stable/tailscale_latest_amd64.tgz | tar xz   # use arm64 if uname -m = aarch64
mkdir -p ~/ts-state

# Run tailscaled in userspace mode with a SOCKS proxy, under PM2:
pm2 start $HOME/tailscale_*_amd64/tailscaled --name tailscaled -- \
  --tun=userspace-networking \
  --socks5-server=127.0.0.1:1055 \
  --statedir=$HOME/ts-state \
  --socket=$HOME/ts-state/tailscaled.sock
pm2 save

# Connect, using the phone as exit node (get the phone's Tailscale IP from the admin console):
$HOME/tailscale_*_amd64/tailscale --socket=$HOME/ts-state/tailscaled.sock up \
  --exit-node=<PHONE_TAILSCALE_IP> --hostname=wab-vps
# → open the printed URL, sign in with the same Tailscale account
```

**Verify** the proxy exits the phone's residential IP:

```bash
curl --socks5-hostname 127.0.0.1:1055 https://api.ipify.org   # → the phone's IP
curl https://api.ipify.org                                    # → the VPS's IP (should differ)
```

Then set `WAB_PROXY=socks5h://127.0.0.1:1055` in wab's `.env` and `pm2 restart wab`. wab logs `Routing WhatsApp through proxy …` on start.

> Note: in userspace mode, system tools like `ping` cannot reach Tailscale `100.x` addresses — only the SOCKS proxy can. That's expected and is the point (nothing system-wide is touched).

## Link a WhatsApp number

**QR scanning does not work from a server** — use the **pairing code**. The number must already be registered on a primary phone.

From the Notify dashboard (`/wab`): **Generate pairing code** with the number → on the phone, **WhatsApp → Linked Devices → Link a Device → "Link with phone number instead"** → enter the code. (A "might be a scam" warning is normal for this flow.) Or via API:

```bash
curl -s -X POST -H "X-Internal-Secret: <secret>" -H "Content-Type: application/json" \
  -d '{"number":"<international digits>"}' http://127.0.0.1:3210/api/pair
```

Confirm with `/api/status` → `"state":"open"`. The session persists in `auth/`; restarts reconnect with no re-link. **Link once and leave it alone.**

## Changing the number

1. Register/age the new number on its own primary phone first.
2. `POST /api/logout` (or dashboard **Re-link / Logout**) — wipes the session.
3. `POST /api/pair` with the new number, enter the code on its phone.
4. Verify `/api/status` shows `open` with the new number. No redeploy needed.

## Warm-up & safe usage

The number works, but stay un-flagged by behaving like a human:

- **Only message people who expect it.** Recipients blocking/reporting you is the #1 ban trigger — far more than volume.
- **Ramp gradually:** ~10–20 msgs/day week 1, ~30–50/day week 2, increase slowly after. Never sudden spikes.
- **Two-way conversations** (replies) look natural; pure one-way blasting is a flag.
- **Vary content** — identical bulk text looks like spam. Personalize.
- **Don't re-link** a working session; churn is what burns numbers.
- Internal/transactional notifications to known contacts (staff, opted-in customers) is the safest, lowest-risk use case.

If the session starts logging out repeatedly or messages stop propagating, WhatsApp is pushing back — **back off the volume and let it rest.**

## Operational notes & gotchas

- **Fork mode only.** PM2 `exec_mode: 'fork'`. Cluster mode breaks the single stateful socket (code-408 reconnect loop). Never `instances > 1`.
- **`trust proxy` is set** (`app.set('trust proxy', 1)`) because it's behind a reverse proxy — otherwise `express-rate-limit` throws on `X-Forwarded-For`.
- **Phone must be on stable WiFi.** Mobile data / network-switching causes constant code-408 `connectionLost` flapping (keepalives time out over the jittery path). WiFi + plugged in is stable.
- **Both `wab` and `tailscaled` run under PM2** as the site user; `pm2 save` + `pm2 startup` make them survive reboots.
- **The 14-day rule:** the primary phone must connect to WhatsApp at least every couple of weeks or all linked devices get logged out.
- **Brief drops are absorbed:** real traffic goes through Notify's queue (`SendWabJob`, 3 retries + backoff), so momentary reconnects don't lose messages. Direct `curl` to wab has no retry and will show `409` during a blip.
- **Code 515** right after first link is normal (restart-required handshake) → auto-reconnects to `open`.
