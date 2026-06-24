import 'dotenv/config'
import express from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import * as wa from './whatsapp.js'

const PORT = 3210                          // hardcoded; localhost-only behind reverse proxy
const HOST = '127.0.0.1'                   // never bind publicly
const SECRET = process.env.INTERNAL_SECRET

if (!SECRET) {
    console.error('FATAL: INTERNAL_SECRET is not set in .env')
    process.exit(1)
}

const app = express()
app.set('trust proxy', 1) // behind CloudPanel's reverse proxy (one hop)
app.use(helmet())
app.use(express.json())
app.use(rateLimit({ windowMs: 60_000, max: 120 }))

// ── Auth: every route except /health and /link requires the shared secret ──
// (/link does its own ?key= check since a browser can't send custom headers)
app.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/link') return next()
    if (req.get('X-Internal-Secret') !== SECRET) {
        return res.status(401).json({ success: false, message: 'Unauthorized.' })
    }
    next()
})

app.get('/health', (req, res) => {
    res.json({ status: 'ok', state: wa.getStatus().state })
})

// Self-refreshing QR page for first-time/relink scanning. Auth via ?key=.
// Open https://wab.tarkib.co.uk/link?key=<INTERNAL_SECRET> in a browser.
app.get('/link', (req, res) => {
    if (req.query.key !== SECRET) {
        return res.status(401).send('Unauthorized.')
    }

    const { qr, state } = wa.getQR()
    let body
    if (state === 'open') {
        body = '<h2>✅ Connected</h2><p>This number is linked.</p>'
    } else if (qr) {
        body = `<img src="${qr}" alt="QR" style="width:320px;height:320px">
                <p>WhatsApp → Linked Devices → Link a Device. Auto-refreshes every 3s.</p>`
    } else {
        body = '<p>Waiting for a QR code… (refreshing)</p>'
    }

    res.send(`<!doctype html><html><head><meta http-equiv="refresh" content="3">
        <title>Link wab</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:40px">${body}</body></html>`)
})

app.get('/api/status', (req, res) => {
    res.json(wa.getStatus())
})

app.get('/api/qr', (req, res) => {
    res.json(wa.getQR())
})

app.post('/api/send', async (req, res) => {
    const { to, message } = req.body ?? {}
    if (!to || !message) {
        return res.status(422).json({ success: false, message: 'Fields "to" and "message" are required.' })
    }

    try {
        const result = await wa.sendMessage(to, message)
        res.json({ success: true, ...result })
    } catch (err) {
        if (err.code === 'NOT_CONNECTED') {
            return res.status(409).json({ success: false, message: 'WhatsApp is not connected.' })
        }
        if (err.code === 'NOT_ON_WHATSAPP') {
            return res.status(400).json({ success: false, message: 'Number is not on WhatsApp.' })
        }
        res.status(500).json({ success: false, message: err.message })
    }
})

app.post('/api/pair', async (req, res) => {
    const { number } = req.body ?? {}
    if (!number) {
        return res.status(422).json({ success: false, message: 'Field "number" is required.' })
    }
    try {
        const code = await wa.requestPairing(number)
        res.json({ success: true, code })
    } catch (err) {
        if (err.code === 'ALREADY_CONNECTED') {
            return res.status(409).json({ success: false, message: 'Already connected.' })
        }
        res.status(500).json({ success: false, message: err.message })
    }
})

app.post('/api/reconnect', async (req, res) => {
    await wa.reconnect()
    res.json({ success: true })
})

app.post('/api/logout', async (req, res) => {
    await wa.logout()
    res.json({ success: true })
})

app.listen(PORT, HOST, () => {
    console.log(`wab listening on ${HOST}:${PORT}`)
    wa.start()
})
