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
app.use(helmet())
app.use(express.json())
app.use(rateLimit({ windowMs: 60_000, max: 120 }))

// ── Auth: every route except /health requires the shared secret ──
app.use((req, res, next) => {
    if (req.path === '/health') return next()
    if (req.get('X-Internal-Secret') !== SECRET) {
        return res.status(401).json({ success: false, message: 'Unauthorized.' })
    }
    next()
})

app.get('/health', (req, res) => {
    res.json({ status: 'ok', state: wa.getStatus().state })
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
