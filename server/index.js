const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');
const antiban = require('./antiban'); // delay Gaussian, typing, batch cooldown, daily-limit, warmup, health, circuit-breaker

const PORT = 8790;
const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---------- REALTIME LEAD STORE (Indonesia-ready) ----------
// Disimpan di memori + bisa diakses dashboard secara realtime via REST + socket.
let leadStore = []; // [{phone, name, category, address, source, createdAt}]
let broadcastHistory = []; // [{startedAt, finishedAt, total, success, failed}]

function normalizeID(raw) {
    if (raw === undefined || raw === null) return null;
    let d = String(raw).replace(/\D/g, '');
    if (!d) return null;
    // 08xx... -> 628xx...
    if (d.startsWith('0')) d = '62' + d.slice(1);
    // 8xx... (tanpa 0, 9-12 digit) -> 628xx...
    else if (/^8\d{8,12}$/.test(d)) d = '62' + d;
    // harus 62... dengan total 10-15 digit (62 + 8-13 digit)
    if (!/^62\d{8,13}$/.test(d)) return null;
    return d;
}

function personalize(msg, contact) {
    if (!msg) return msg;
    const name = (contact && contact.name) ? String(contact.name).split('|')[0].trim() : 'Kak';
    return String(msg)
        .replace(/\{\{\s*nama\s*\}\}/gi, name)
        .replace(/\{\{\s*name\s*\}\}/gi, name);
}
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8, // 100 MB
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

let client = null;
let isConnected = false;
let qrCode = null;
let isInitializing = false;

async function startWhatsApp() {
    if (isInitializing) {
        console.log('WhatsApp is already initializing...');
        return;
    }
    isInitializing = true;

    // --- CLEANUP PREVIOUS CLIENT ---
    if (client) {
        console.log('Cleaning up previous connection...');
        try {
            await client.destroy();
        } catch (e) {
            console.error('Cleanup error:', e.message);
        }
        client = null;
    }

    // --- ORPHAN CHROME GUARD ---
    // Jika node terbunuh (SIGKILL/crash), child Chrome puppeteer bisa tetap hidup
    // dan memegang kunci userDataDir → instance baru gagal dengan
    // "The browser is already running for <dataPath>". Hanya dijalankan saat ON_WINDOWS=false.
    if (process.platform !== 'win32') {
        try {
            const lockGlob = path.join(SESSION_DIR, 'session', 'Singleton*');
            const lockFiles = require('glob').sync(lockGlob);
            if (lockFiles.length) {
                console.log(`🧹 Found ${lockFiles.length} stale Chrome lock(s); clearing...`);
                for (const f of lockFiles) fs.removeSync(f);
            }
        } catch (e) {
            console.error('Lock cleanup error:', e.message);
        }
    }

    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: SESSION_DIR
        }),
        puppeteer: {
            // Linux-ready: pakai Chrome bawaan Puppeteer.
            // Bisa dioverride via env PUPPETEER_EXECUTABLE_PATH kalau punya Chrome sendiri.
            ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--js-flags="--max-old-space-size=2048"', // Give more memory to browser JS
                // DNS FIX (Indonesia): beberapa DNS ISP meresolve domain Meta ke
                // address link-local (fe80::) palsu → WA Web Comet gak bisa sync
                // ke graph.facebook.com dan "ready" gak pernah fire.
                '--host-resolver-rules=MAP graph.facebook.com 57.144.0.141, MAP crashlogs.whatsapp.net 57.144.101.32, MAP *.whatsapp.net 57.144.101.32',
                '--enable-features=DnsOverHttps',
                '--dns-over-http-templates=https://dns.google/dns-query'
            ]
        }
    });

    client.on('qr', async (qr) => {
        isConnected = false;
        isInitializing = false;
        qrCode = await qrcode.toDataURL(qr);
        io.emit('qr', { qr: qrCode });
        console.log('New QR code generated');
    });

    client.on('ready', async () => {
        isConnected = true;
        isInitializing = false;
        qrCode = null;
        console.log('✅ WhatsApp Connected!');

        // Increase timeouts for media handling
        try {
            const page = client.pupPage;
            if (page) {
                await page.setDefaultTimeout(60000); 
                await page.setDefaultNavigationTimeout(60000);
            }
        } catch (e) {
            console.error('Timeout setup error:', e.message);
        }

        io.emit('status', { 
            connected: true, 
            user: {
                id: client.info.wid._serialized,
                name: client.info.pushname || 'WhatsApp User'
            } 
        });
    });

    client.on('authenticated', () => {
        console.log('AUTHENTICATED');
        armReadyFallback();
    });

    // FALLBACK READY-GUARD (kerja sama dengant antiban.health):
    // whatsapp-web.js 1.34.6 kadang menunggu `change:hasSynced` yang sudah lewat
    // (race condition) → event 'ready' gak pernah fire walau WA Web sudah CONNECTED.
    // Kita poll state WA Web secara periodik; jika sudah sync tapi 'ready' belum
    // muncul dalam 45 detik, kita emit status connected agar dashboard bisa dipakai.
    let readyFallbackTimer = null;
    const armReadyFallback = () => {
        if (readyFallbackTimer) return;
        readyFallbackTimer = setInterval(async () => {
            if (isConnected || !client || !client.pupPage) {
                clearInterval(readyFallbackTimer);
                readyFallbackTimer = null;
                return;
            }
            try {
                const st = await client.pupPage.evaluate(() => {
                    try {
                        return JSON.stringify({
                            state: window.AuthStore?.AppState?.state,
                            hasSynced: window.AuthStore?.AppState?.hasSynced
                        });
                    } catch { return null; }
                });
                const parsed = JSON.parse(st || '{}');
                if (parsed.state === 'CONNECTED' && parsed.hasSynced === true) {
                    console.log('⚠️ Native ready event terlewat; fallback memaksa status connected.');

                    // === INJECT-FIX (akar masalah broadcast gagal) ===
                    // Library 1.34.6 kadang stuck tepat sebelum `LoadUtils` di handler
                    // `onAppStateHasSyncedEvent` (race). Akibatnya `window.WWebJS` gak pernah
                    // ada, walau `window.Store` sudah lengkap. Tanpa WWebJS, semua method
                    // kirim (`client.sendMessage`) pasti gagal dengan "WWebJS is not defined".
                    // Di sini kita selesaikan inject secara manual, lalu isi client.info.
                    try {
                        const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');
                        await client.pupPage.evaluate(LoadUtils);
                        // pastikan inject benar-benar masuk (poll singkat)
                        for (let k = 0; k < 30; k++) {
                            const ok = await client.pupPage.evaluate(() => typeof window.WWebJS !== 'undefined' && !!window.WWebJS.sendMessage).catch(() => false);
                            if (ok) break;
                            await new Promise(r => setTimeout(r, 300));
                        }
                    } catch (e) {
                        console.error('Inject LoadUtils via fallback gagal:', e.message);
                    }

                    // Build client.info manual dari window.Store karena handler library
                    // juga yang ngisi this.info (juga tertinggal di flow yang sama).
                    try {
                        const info = await client.pupPage.evaluate(() => {
                            try {
                                const conn = window.Store.Conn.serialize();
                                const wid = window.Store.User.getMaybeMePnUser() || window.Store.User.getMaybeMeLidUser();
                                return { ...conn, wid: wid ? wid._serialized : null };
                            } catch (e) { return null; }
                        });
                        if (info && info.wid) {
                            client.info = client.info || {};
                            try { client.info.wid = { _serialized: info.wid, user: info.wid.split('@')[0], server: 'c.us' }; } catch {}
                            try { if (info.pushname) client.info.pushname = info.pushname; } catch {}
                            if (!client.info.pushname) client.info.pushname = info.pushname || 'WhatsApp User';
                        }
                    } catch (e) {
                        console.error('Build client.info via fallback gagal:', e.message);
                    }

                    clearInterval(readyFallbackTimer);
                    readyFallbackTimer = null;
                    isConnected = true;
                    qrCode = null;
                    io.emit('status', {
                        connected: true,
                        user: {
                            id: (client.info && client.info.wid && client.info.wid._serialized) || 'unknown',
                            name: (client.info && client.info.pushname) || 'WhatsApp User'
                        }
                    });
                }
            } catch (e) { /* page belum siap, coba lagi */ }
        }, 5000);
    };

    client.on('auth_failure', msg => {
        console.error('AUTHENTICATION FAILURE', msg);
        io.emit('status', { connected: false, reason: msg });
    });

    client.on('disconnected', (reason) => {
        isConnected = false;
        isInitializing = false;
        qrCode = null;
        console.log('Client was logged out', reason);
        io.emit('status', { connected: false, reason: reason });
        // Attempt to re-initialize for new QR
        setTimeout(startWhatsApp, 2000);
    });

    client.initialize().catch(err => {
        console.error('Initialization error:', err.message);
        isInitializing = false;
    });
}

async function logout() {
    isInitializing = false;
    try {
        if (client) {
            await client.logout();
            await client.destroy();
        }
    } catch (e) {}
    
    // session folder will be handled by wwebjs logout usually, but we force clean
    if (fs.existsSync(SESSION_DIR)) {
        await fs.remove(SESSION_DIR);
    }
    
    client = null;
    isConnected = false;
    qrCode = null;
    io.emit('status', { connected: false });
    console.log('Logged out and auth files deleted.');
    startWhatsApp(); 
}

// Broadcast State
let activeBroadcast = null;

io.on('connection', (socket) => {
    console.log('New client connected');
    
    // Send initial status
    socket.emit('status', { 
        connected: isConnected, 
        user: isConnected && client?.info ? {
            id: client.info.wid._serialized,
            name: client.info.pushname || 'WhatsApp User'
        } : null 
    });
    if (qrCode) {
        socket.emit('qr', { qr: qrCode });
    }

    socket.on('logout', async () => {
        await logout();
    });

    socket.on('start_broadcast', async (data) => {
        // GUARD ANTI-DOUBLE START: kalau masih ada campaign jalan, tolak.
        // Mencegah 2 loop paralel → nomor dikirim 2x (bisa memicu ban).
        if (activeBroadcast && !activeBroadcast.stopped) {
            return socket.emit('broadcast_status', { message: '🚫 Sudah ada campaign berjalan. Tunggu selesai atau tekan Stop dulu sebelum launch lagi.', done: true });
        }
        const { numbers, contacts, message, delay, media, document: doc, checkWA = true,
            batchSize = 10, cooldownSec = 60, dailyLimit = 200, warmup = true } = data;
        // contacts (baru, realtime): [{phone, name}] — numbers (lama): ["628.."] tetap didukung.
        const list = Array.isArray(contacts) && contacts.length
            ? contacts
            : (numbers || []).map(n => ({ phone: n, name: '' }));
        
        console.log('--- START BROADCAST EVENT RECEIVED ---');
        console.log(`Contacts: ${list?.length}, Delay: ${delay?.min}-${delay?.max}s`);

        if (!isConnected || !client) {
            console.log('Broadcast failed: WhatsApp not connected');
            return socket.emit('broadcast_status', { message: '❌ Error: WhatsApp not connected. Please go to "Connect" tab.', done: true });
        }

        if (!numbers?.length && !contacts?.length) {
            return socket.emit('broadcast_status', { message: '❌ Error: No numbers provided.', done: true });
        }

        // ANTI-BAN: daily-limit server-side + warmup akun baru
        const cap = warmup ? antiban.warmupLimit(dailyLimit) : dailyLimit;
        const remaining = antiban.dailyRemaining(cap);
        if (remaining <= 0) {
            return socket.emit('broadcast_status', { message: `🛑 Limit harian tercapai (${cap}/hari, umur akun hari ke-${antiban.accountAgeDays()}). Lanjut besok agar aman dari ban.`, done: true });
        }
        const todo = list.slice(0, remaining);
        if (todo.length < list.length) {
            socket.emit('broadcast_status', { message: `⚠️ Sisa kuota hari ini ${remaining}; ${list.length - todo.length} kontak dijadwalkan besok.` });
        }

        activeBroadcast = {
            stopped: false,
            paused: false,
            current: 0,
            total: todo.length,
            success: 0,
            failed: 0,
            startedAt: new Date().toISOString()
        };

        socket.emit('broadcast_status', { message: `🚀 Campaign started for ${todo.length} contacts. (limit ${cap}/hari • batch ${batchSize} + jeda ${cooldownSec}s • delay acak Gaussian)` });

        // Wait a small moment to ensure everything is initialized
        await new Promise(resolve => setTimeout(resolve, 1000));

        let ratePenalty = 0; // penalti adaptif ala SendStack (+10s per rate-limit, max 60s)
        for (let i = 0; i < todo.length; i++) {
            if (activeBroadcast.stopped) {
                console.log('Broadcast stopped by user.');
                break;
            }
            
            while (activeBroadcast.paused) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                if (activeBroadcast.stopped) break;
            }
            // ANTI-BAN: auto-pause saat health kritis (sinyal ban), user bisa resume manual
            if (antiban.health.level() === 'critical' && !activeBroadcast.paused) {
                activeBroadcast.paused = true;
                socket.emit('broadcast_status', { message: '🛑 AUTO-PAUSE: sinyal rate-limit/ban terdeteksi. Cek akun, lalu Resume manual.' });
            }

            const raw = todo[i] && todo[i].phone !== undefined ? todo[i].phone : todo[i];
            const display = String(raw);
            const number = normalizeID(raw);
            if (!number) {
                activeBroadcast.failed++;
                socket.emit('broadcast_status', {
                    number: display, status: 'error', current: i + 1, total: todo.length,
                    message: `❌ Nomor tidak valid: ${display}`
                });
                continue;
            }
            // ANTI-BAN: circuit-breaker per nomor (3 gagal -> skip 10 mnt)
            if (antiban.isBlocked(number)) {
                socket.emit('broadcast_status', {
                    number: display, status: 'error', current: i + 1, total: todo.length,
                    message: `⏭️ Skip ${display}: gagal 3x beruntun (cooldown)`
                });
                continue;
            }
            const jid = `${number}@c.us`;
            // ANTI-BAN: spin {a|b} + personalisasi {{nama}} agar tiap pesan unik
            const text = antiban.resolveSpin(personalize(message, todo[i]));
            
            socket.emit('broadcast_status', { message: `⏳ Processing contact ${i + 1}/${todo.length}: ${display}` });

            try {
                await antiban.sendOne(client, MessageMedia, { jid, display, text, media, doc, checkWA, typing: true });
                antiban.health.record(true);
                antiban.recordResult(number, true);
                antiban.recordSent(1);
                socket.emit('broadcast_status', { 
                    number: display, 
                    status: 'success', 
                    current: i + 1,
                    total: todo.length,
                    message: `✅ Delivered to ${display}`
                });
                activeBroadcast.success++;
            } catch (err) {
                console.error(`Failed for ${display}:`, err.message);
                const kind = antiban.classifyError(err.message);
                antiban.health.record(false, err.message);
                antiban.recordResult(number, false);
                activeBroadcast.failed++;
                // ANTI-BAN: rate-limit -> backoff + penalti adaptif, fatal -> stop
                if (kind === 'rate_limited') {
                    ratePenalty = Math.min(60000, ratePenalty + 10000);
                    socket.emit('broadcast_status', { message: `⚠️ Rate-limit terdeteksi. Istirahat ${Math.round((20000 + ratePenalty) / 1000)}s…` });
                    await antiban.sleep(20000 + ratePenalty);
                } else if (kind === 'fatal_conn') {
                    socket.emit('broadcast_status', { message: `🛑 Koneksi WA bermasalah (${err.message}). Campaign dihentikan aman.`, done: true });
                    break;
                }
                socket.emit('broadcast_status', { 
                    number: display, 
                    status: 'error', 
                    current: i + 1,
                    total: todo.length,
                    message: `❌ Failed for ${display}: ${err.message}`
                });
            }

            // ANTI-BAN: batch cooldown tiap N pesan (SendStack)
            const sent = activeBroadcast.success + activeBroadcast.failed;
            if (sent > 0 && sent % batchSize === 0 && i < todo.length - 1 && !activeBroadcast.stopped) {
                socket.emit('broadcast_status', { message: `☕ Batch ${sent} terkirim. Cooldown ${cooldownSec}s…` });
                const t0 = Date.now();
                while (Date.now() - t0 < cooldownSec * 1000) {
                    if (activeBroadcast.stopped) break;
                    await antiban.sleep(1000);
                }
                continue;
            }
            // Random delay Gaussian antar pesan
            if (i < todo.length - 1 && !activeBroadcast.stopped) {
                const min = Math.max(1, parseInt(delay.min) || 15);
                const max = Math.max(min, parseInt(delay.max) || 45);
                const waitTime = antiban.jitteredDelay(min * 1000, max * 1000) + ratePenalty;
                
                socket.emit('broadcast_status', { message: `⏸️ Cooling down for ${Math.round(waitTime/1000)}s...` });
                await antiban.sleep(waitTime);
            }
        }

        const completionMsg = activeBroadcast.stopped ? 'Campaign stopped.' : '🎉 Campaign completed successfully!';
        socket.emit('broadcast_status', { message: completionMsg, done: true });
        broadcastHistory.unshift({
            startedAt: activeBroadcast.startedAt,
            finishedAt: new Date().toISOString(),
            total: todo.length,
            success: activeBroadcast.success || 0,
            failed: activeBroadcast.failed || 0,
            stopped: activeBroadcast.stopped
        });
        activeBroadcast = null;
    });

    socket.on('stop_broadcast', () => {
        if (activeBroadcast) {
            activeBroadcast.stopped = true;
            socket.emit('broadcast_status', { message: 'Broadcast stopped by user', done: true });
        }
    });

    socket.on('refresh_qr', () => {
        console.log('Manual QR refresh requested.');
        startWhatsApp();
    });

    socket.on('pause_broadcast', (paused) => {
        if (activeBroadcast) {
            activeBroadcast.paused = paused;
            socket.emit('broadcast_status', { message: paused ? 'Broadcast paused' : 'Broadcast resumed' });
        }
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: isConnected });
});

// ---------- HTTP API untuk Marketing Suite (dipanggil Worker /api/send) ----------
// Proteksi opsional: set env SENDER_TOKEN, lalu kirim header Authorization: Bearer <token>
function senderAuth(req, res, next) {
    if (!process.env.SENDER_TOKEN) return next();
    const h = req.headers.authorization || '';
    if (h === 'Bearer ' + process.env.SENDER_TOKEN) return next();
    return res.status(401).json({ ok: false, error: 'unauthorized sender' });
}

app.get('/status', senderAuth, (req, res) => {
    res.json({ ok: true, connected: isConnected, user: isConnected && client?.info ? { id: client.info.wid._serialized, name: client.info.pushname } : null });
});

// POST /send { contacts:[{phone,name}], message, delay:{min,max}, checkWA=true }
// Mengirim sinkron-ringkas lalu mengembalikan ringkasan (dipakai Worker + dashboard web).
app.post('/send', senderAuth, async (req, res) => {
    const { contacts, numbers, message, delay, checkWA = true, batchSize = 10, cooldownSec = 60, dailyLimit = 200, warmup = true } = req.body || {};
    const full = Array.isArray(contacts) && contacts.length ? contacts : (numbers || []).map(n => ({ phone: n, name: '' }));
    if (!isConnected || !client) return res.status(409).json({ ok: false, error: 'WhatsApp belum connect (scan QR dulu di dashboard :5173)' });
    if (!full.length) return res.status(400).json({ ok: false, error: 'contacts kosong' });
    // ANTI-BAN: daily-limit + warmup
    const cap = warmup ? antiban.warmupLimit(dailyLimit) : dailyLimit;
    const list = full.slice(0, antiban.dailyRemaining(cap));
    if (!list.length) return res.status(429).json({ ok: false, error: `Limit harian tercapai (${cap}/hari). Lanjut besok.` });
    const min = Math.max(1, parseInt(delay?.min) || 15), max = Math.max(min, parseInt(delay?.max) || 45);
    let success = 0, failed = 0, ratePenalty = 0; const details = [];
    for (let i = 0; i < list.length; i++) {
        const raw = list[i]?.phone ?? list[i];
        const number = normalizeID(raw);
        if (!number) { failed++; details.push({ phone: String(raw), status: 'error', note: 'invalid' }); continue; }
        if (antiban.isBlocked(number)) { failed++; details.push({ phone: String(raw), status: 'error', note: 'circuit-cooldown' }); continue; }
        if (antiban.health.level() === 'critical') break;
        const jid = `${number}@c.us`;
        const text = antiban.resolveSpin(personalize(message, list[i]));
        try {
            await antiban.sendOne(client, MessageMedia, { jid, display: String(raw), text, checkWA, typing: true });
            antiban.health.record(true); antiban.recordResult(number, true); antiban.recordSent(1);
            success++; details.push({ phone: String(raw), status: 'success' });
        } catch (err) {
            const kind = antiban.classifyError(err.message);
            antiban.health.record(false, err.message); antiban.recordResult(number, false);
            failed++; details.push({ phone: String(raw), status: 'error', note: err.message });
            if (kind === 'rate_limited') { ratePenalty = Math.min(60000, ratePenalty + 10000); await antiban.sleep(20000 + ratePenalty); }
            else if (kind === 'fatal_conn') break;
        }
        if (i < list.length - 1) {
            const sent = success + failed;
            if (sent > 0 && sent % batchSize === 0) await antiban.sleep(cooldownSec * 1000);
            else await antiban.sleep(antiban.jitteredDelay(min * 1000, max * 1000) + ratePenalty);
        }
    }
    try { fs.appendFileSync('/tmp/wa-http-sends.log', `${new Date().toISOString()} total=${list.length} ok=${success} fail=${failed}\n`); } catch {}
    res.json({ ok: true, total: list.length, success, failed, details: details.slice(0, 200) });
});

// ---------- REALTIME LEAD API (jembatan extractor -> sender) ----------
// POST /api/leads  { leads: [{phone, name, category, address}], source }
// GET  /api/leads  -> { total, leads }
// DELETE /api/leads -> kosongkan
// GET  /api/reports -> riwayat broadcast
app.post('/api/leads', (req, res) => {
    const incoming = Array.isArray(req.body.leads) ? req.body.leads
        : Array.isArray(req.body) ? req.body : [];
    const source = req.body.source || 'extractor';
    let added = 0; const invalid = [];
    const seen = new Set(leadStore.map(l => l.phone));
    for (const l of incoming) {
        const phone = normalizeID(l.phone ?? l.number ?? l.wa ?? '');
        if (!phone) { invalid.push(l.phone ?? l.number ?? JSON.stringify(l)); continue; }
        if (seen.has(phone)) continue;
        seen.add(phone);
        leadStore.push({
            phone,
            name: (l.name || l.nama || '').toString().slice(0, 100),
            category: (l.category || '').toString().slice(0, 100),
            address: (l.address || '').toString().slice(0, 200),
            source, createdAt: new Date().toISOString()
        });
        added++;
    }
    io.emit('leads_updated', { total: leadStore.length, added });
    res.json({ ok: true, added, total: leadStore.length, invalid: invalid.slice(0, 20) });
});

app.get('/api/leads', (req, res) => {
    res.json({ total: leadStore.length, leads: leadStore });
});

app.delete('/api/leads', (req, res) => {
    leadStore = [];
    io.emit('leads_updated', { total: 0, added: 0 });
    res.json({ ok: true, total: 0 });
});

app.get('/api/reports', (req, res) => {
    res.json({ total: broadcastHistory.length, reports: broadcastHistory.slice(0, 50) });
});

// Serve static files from React app in production
if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, '../client/dist')));

    // Root route untuk dashboard UI (menimpa dev-helper di bawah).
    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, '../client/dist/index.html'));
    });

    app.get('/*splat', (req, res) => {
        res.sendFile(path.join(__dirname, '../client/dist/index.html'));
    });
}

// Root route for development helper (hanya muncul saat NODE_ENV !== production)
if (process.env.NODE_ENV !== 'production') {
    app.get('/', (req, res) => {
        res.send(`
        <div style="font-family: sans-serif; text-align: center; margin-top: 50px; background: #0f172a; color: white; min-height: 100vh; padding-top: 50px;">
            <h1 style="color: #25D366;">WhatsApp Dashboard API (wwebjs)</h1>
            <p>The backend server is running successfully on port ${PORT}.</p>
            <div style="background: #1e293b; padding: 20px; border-radius: 10px; display: inline-block; margin-top: 20px; border: 1px solid #334155;">
                <p>To see the Dashboard UI, please run:</p>
                <code style="background: black; padding: 5px 10px; border-radius: 5px; color: #fbbf24;">npm run dev-client</code>
                <p>in a separate terminal and open <a href="http://localhost:5173" style="color: #60a5fa;">http://localhost:5173</a></p>
            </div>
        </div>
    `);
    });
}

server.listen(PORT, () => {
    console.log(`\n===========================================`);
    console.log(`🚀 SERVER RUNNING: http://localhost:${PORT}`);
    console.log(`🔗 DASHBOARD UI:  http://localhost:5173`);
    console.log(`===========================================\n`);
    startWhatsApp();
});

