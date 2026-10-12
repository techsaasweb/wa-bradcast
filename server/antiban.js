/* Anti-ban toolkit untuk sender WA (whatsapp-web.js).
 * Teknik diporting dari:
 *  - mohamed-arabi16/SendStack (delay preset, jitter ±30-50%, batch cooldown,
 *    daily-limit 200, spin syntax, validasi isRegisteredUser, retry eksponensial,
 *    rate-limit penalty adaptif, circuit breaker)
 *  - kobie3717/baileys-antiban (Gaussian jitter Box-Muller, typing按 panjang pesan,
 *    new-chat extra delay, identical-message block, warmup 7 hari, health scoring,
 *    klasifikasi backoff 401/429/503, circuit-breaker per-JID, delivery adaptive)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '.antiban');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const DAILY_FILE = path.join(DATA_DIR, 'daily.json');
const SEEN_FILE = path.join(DATA_DIR, 'first_seen');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return min + Math.random() * (max - min); }

// Gaussian (Box-Muller, ala baileys-antiban rateLimiter.ts) -> 0..1
function gauss01() {
    let u1 = 0, u2 = 0;
    while (u1 === 0) u1 = Math.random();
    while (u2 === 0) u2 = Math.random();
    const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.min(1, Math.max(0, (n + 3) / 6));
}

// Delay antar pesan: base acak + jitter Gaussian, min floor 3 dtk
function jitteredDelay(minMs, maxMs) {
    const base = rand(minMs, maxMs);
    const j = 0.7 + gauss01() * 0.8; // 0.7x .. 1.5x
    return Math.max(3000, Math.round(base * j));
}

// Simulasi mengetik: min(panjang*30ms, 3000ms) + jitter (baileys-antiban)
function typingMs(len) {
    return Math.min((len || 20) * 30, 3000) + Math.round(rand(500, 1500));
}

// Spin syntax {Halo|Hai|Halo kak} -> variasi acak per pesan (SendStack resolveSpin)
function resolveSpin(text) {
    if (!text) return text;
    return String(text).replace(/\{([^{}|]+(\|[^{}|]+)+)\}/g, (m, g) => {
        const opts = g.split('|');
        return opts[Math.floor(Math.random() * opts.length)];
    });
}

/* ---------- Daily limit (server-side, persisten) ---------- */
function todayStr() { return new Date().toISOString().slice(0, 10); }
function loadDaily() {
    try {
        const d = JSON.parse(fs.readFileSync(DAILY_FILE, 'utf8'));
        if (d.date === todayStr()) return d;
    } catch {}
    return { date: todayStr(), count: 0 };
}
function saveDaily(d) { try { fs.writeFileSync(DAILY_FILE, JSON.stringify(d)); } catch {} }
function dailyRemaining(limit) {
    const d = loadDaily();
    return Math.max(0, limit - d.count);
}
function recordSent(n) {
    const d = loadDaily();
    d.count += (n || 1);
    saveDaily(d);
    return d.count;
}

/* ---------- Warm-up: akun baru mulai kecil (baileys-antiban warmup.ts) ---------- */
function accountAgeDays() {
    try {
        const t = fs.readFileSync(SEEN_FILE, 'utf8').trim();
        const days = Math.floor((Date.now() - new Date(t).getTime()) / 86400000);
        return Math.max(1, days + 1);
    } catch {
        try { fs.writeFileSync(SEEN_FILE, new Date().toISOString()); } catch {}
        return 1;
    }
}
function warmupLimit(baseLimit) {
    const day = accountAgeDays();
    if (day >= 7) return baseLimit;
    // growth 1.5..2.2 deterministik per tanggal (hindari fingerprint seragam)
    const h = [...todayStr()].reduce((a, c) => a + c.charCodeAt(0), 0);
    const growth = 1.5 + (h % 70) / 100;
    return Math.min(baseLimit, Math.max(20, Math.round(20 * Math.pow(growth, day - 1))));
}

/* ---------- Health scoring (baileys-antiban health.ts) ---------- */
const health = {
    score: 0, fails: 0, lastDecay: Date.now(),
    record(ok, errMsg) {
        const now = Date.now();
        // decay: -5/menit normal
        this.score = Math.max(0, this.score - Math.floor((now - this.lastDecay) / 60000) * 5);
        this.lastDecay = now;
        const m = String(errMsg || '').toLowerCase();
        if (ok) { this.fails = 0; return; }
        this.fails++;
        if (/401|logged.?out|forbidden/.test(m)) this.score += 60;
        else if (/403/.test(m)) this.score += 40;
        else if (/rate|spam|too many|overlimit|429|blocked/.test(m)) this.score += 25;
        else if (this.fails >= 5) this.score += 20;
    },
    level() { return this.score >= 80 ? 'critical' : this.score >= 40 ? 'high' : this.score >= 15 ? 'medium' : 'ok'; }
};

/* ---------- Circuit breaker per nomor (3 gagal -> skip 10 mnt) ---------- */
const breaker = new Map(); // number -> {fails, blockedUntil}
function isBlocked(number) {
    const b = breaker.get(number);
    if (!b) return false;
    if (Date.now() > b.blockedUntil) { breaker.delete(number); return false; }
    return true;
}
function recordResult(number, ok) {
    if (ok) { breaker.delete(number); return; }
    const b = breaker.get(number) || { fails: 0, blockedUntil: 0 };
    b.fails++;
    if (b.fails >= 3) b.blockedUntil = Date.now() + 10 * 60 * 1000;
    breaker.set(number, b);
}

/* ---------- Klasifikasi error (SendStack + sessionStability) ---------- */
function classifyError(msg) {
    const m = String(msg || '').toLowerCase();
    if (/not.?registered|invalid wid|phone number shared|tidak terdaftar/.test(m)) return 'not_registered';
    if (/rate|spam|too many|overlimit|429|blocked|ban/.test(m)) return 'rate_limited';
    if (/not connected|disconnected|session|destroy|conflict|440|405|logged.?out|401|403/.test(m)) return 'fatal_conn';
    if (/timeout|network|econn|503|500|408/.test(m)) return 'transient';
    return 'unknown';
}

/* ---------- Satu pengiriman: cek WA + typing + kirim + media/dok ---------- */
async function sendOne(client, MessageMedia, opts) {
    const { jid, display, text, media, doc, checkWA = true, typing = true } = opts;
    if (checkWA) {
        try {
            const nid = await client.getNumberId(jid);
            if (!nid) throw new Error('Nomor tidak terdaftar di WhatsApp');
        } catch (e) {
            if (/tidak terdaftar/i.test(e.message)) throw e;
        }
    }
    // Simulasi manusia mengetik sebelum kirim (composing -> jeda -> kirim)
    if (typing && text) {
        try {
            const chat = await client.getChatById(jid);
            await chat.sendStateTyping();
            await sleep(typingMs(String(text).length));
            await chat.clearState();
        } catch {} // chat belum ada: kirim langsung
    }
    if (media && media.data) {
        const msgMedia = new MessageMedia(media.type, media.data.split(',')[1], media.name || 'image');
        await client.sendMessage(jid, msgMedia, { caption: text });
    } else if (text) {
        await client.sendMessage(jid, text);
    }
    if (doc && doc.data) {
        const docMedia = new MessageMedia(doc.type, doc.data.split(',')[1], doc.name);
        await client.sendMessage(jid, docMedia);
    }
}

module.exports = {
    sleep, rand, gauss01, jitteredDelay, typingMs, resolveSpin,
    loadDaily, dailyRemaining, recordSent, accountAgeDays, warmupLimit,
    health, isBlocked, recordResult, classifyError, sendOne
};
