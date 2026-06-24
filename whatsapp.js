import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
} from 'baileys'
import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import pino from 'pino'
import { rm } from 'node:fs/promises'

// ── Silence libsignal's internal console noise (prekey/session churn) ──
// libsignal logs directly via console.log and ignores our pino logger.
const NOISE = ['Closing open session', 'Closing session', 'Closing stale']
const _consoleLog = console.log.bind(console)
console.log = (...args) => {
    if (typeof args[0] === 'string' && NOISE.some((n) => args[0].includes(n))) return
    _consoleLog(...args)
}

const logger = pino({ level: 'silent' })
const AUTH_DIR = 'auth'

// ── In-memory connection state ──
let sock = null
let state = 'connecting'   // connecting | open | logged_out
let qrDataUrl = null       // latest pairing QR as a data-URL image
let phone = null           // connected number, once open
let since = null           // ISO timestamp of last successful connect
let starting = false       // guard against overlapping start() calls

export function getStatus() {
    return { state, phone, since, hasQr: Boolean(qrDataUrl) }
}

export function getQR() {
    return { qr: qrDataUrl, state }
}

export async function start() {
    if (starting) return
    starting = true

    try {
        const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

        // Always announce the CURRENT WhatsApp Web version — a stale one
        // triggers immediate code-405 disconnect loops with no QR.
        const { version } = await fetchLatestBaileysVersion()

        sock = makeWASocket({
            version,
            auth: authState,
            logger,
            browser: Browsers.windows('Chrome'), // present as WhatsApp Web on Windows/Chrome
            syncFullHistory: false,
            markOnlineOnConnect: true,          // mark online so outgoing messages route/propagate reliably
            qrTimeout: 120_000,        // keep each QR/socket alive 2 min for scanning
            connectTimeoutMs: 60_000,  // give the handshake more time on a VPS link
            keepAliveIntervalMs: 15_000,
        })

        sock.ev.on('creds.update', saveCreds)

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update

            if (qr) {
                qrDataUrl = await QRCode.toDataURL(qr)
                if (state !== 'open') state = 'connecting'
            }

            if (connection === 'open') {
                state = 'open'
                qrDataUrl = null
                phone = sock.user?.id?.split(':')[0]?.split('@')[0] ?? null
                since = new Date().toISOString()
                console.log(`✅ Connected as ${phone}`)

                // Announce presence so WhatsApp treats this device as active.
                try {
                    await sock.sendPresenceUpdate('available')
                } catch {
                    // non-fatal
                }
            }

            if (connection === 'close') {
                const code = lastDisconnect?.error instanceof Boom
                    ? lastDisconnect.error.output.statusCode
                    : 0

                if (code === DisconnectReason.loggedOut) {
                    // Phone unlinked this device — session is dead.
                    console.log('❌ Logged out — wiping session, generating fresh QR')
                    state = 'logged_out'
                    phone = null
                    qrDataUrl = null
                    await rm(AUTH_DIR, { recursive: true, force: true })
                    setTimeout(start, 1000) // produce a new QR for re-linking
                } else {
                    // Transient drop (515 restart, network, timeout) — reconnect.
                    console.log(`🔄 Connection closed (code ${code}). Reconnecting in 3s…`)
                    state = 'connecting'
                    setTimeout(start, 3000)
                }
            }
        })
    } finally {
        starting = false
    }
}

export async function sendMessage(to, text) {
    if (state !== 'open') {
        const err = new Error('WhatsApp not connected')
        err.code = 'NOT_CONNECTED'
        throw err
    }

    const digits = String(to).replace(/\D/g, '')
    const [info] = await sock.onWhatsApp(digits)

    if (!info?.exists) {
        const err = new Error('Number is not on WhatsApp')
        err.code = 'NOT_ON_WHATSAPP'
        throw err
    }

    const sent = await sock.sendMessage(info.jid, { text })
    return { id: sent.key.id, to: digits }
}

export async function requestPairing(number) {
    if (state === 'open') {
        const err = new Error('Already connected')
        err.code = 'ALREADY_CONNECTED'
        throw err
    }
    if (!sock) {
        const err = new Error('Socket not ready yet')
        err.code = 'NOT_READY'
        throw err
    }
    const digits = String(number).replace(/\D/g, '')
    const code = await sock.requestPairingCode(digits)
    console.log(`🔢 Pairing code for ${digits}: ${code}`)
    return code
}

export async function reconnect() {
    // Force-close; the close handler reconnects (it's not a loggedOut event).
    try {
        sock?.end(new Error('manual reconnect'))
    } catch {
        // ignore
    }
    state = 'connecting'
}

export async function logout() {
    try {
        await sock?.logout()
    } catch {
        // ignore — we wipe locally regardless
    }
    state = 'logged_out'
    phone = null
    qrDataUrl = null
    await rm(AUTH_DIR, { recursive: true, force: true })
    setTimeout(start, 1000)
}
