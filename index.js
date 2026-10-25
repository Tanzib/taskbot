/**
 * TEAM TASK TRACKER — WhatsApp bot
 * Runs on a free cloud host (Render — no card needed) or any server/PC. No browser needed.
 *
 *   node index.js           → run the bot
 *   node index.js --login   → link WhatsApp only, then exit (used by install.sh on a VPS)
 *
 * Settings come from environment variables (Render) or config.json (server/PC).
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import makeWASocket, {
  useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore,
  DisconnectReason, Browsers, normalizeMessageContent, isLidUser, jidNormalizedUser,
} from 'baileys';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import cron from 'node-cron';
import { parseTask, findDate } from './parser.js';
import { useSheetAuthState } from './sheet-auth.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LOGIN_ONLY = process.argv.includes('--login');

// ---------- settings ----------
const CONFIG_PATH = path.join(DIR, 'config.json');
let fileCfg = {};
if (fs.existsSync(CONFIG_PATH)) fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const env = process.env;
const config = {
  SHEET_URL: env.SHEET_URL || fileCfg.SHEET_URL,
  SECRET: env.SECRET || fileCfg.SECRET,
  GROUP_NAME: env.GROUP_NAME || fileCfg.GROUP_NAME || '',
  GROUP_ID: env.GROUP_ID || fileCfg.GROUP_ID || '',
  PAIR_WITH_NUMBER: env.PAIR_WITH_NUMBER || fileCfg.PAIR_WITH_NUMBER || '',
  TIMEZONE: env.TIMEZONE || fileCfg.TIMEZONE || 'Asia/Dhaka',
  REMINDER_CRON: env.REMINDER_CRON !== undefined ? env.REMINDER_CRON : (fileCfg.REMINDER_CRON !== undefined ? fileCfg.REMINDER_CRON : '0 10 * * 0-4'),
  POST_SHEET_UPDATES: String(env.POST_SHEET_UPDATES !== undefined ? env.POST_SHEET_UPDATES : (fileCfg.POST_SHEET_UPDATES !== undefined ? fileCfg.POST_SHEET_UPDATES : true)) !== 'false',
  // Where the WhatsApp login is kept: "sheet" (Google Drive, for hosts that wipe disk) or "files"
  AUTH_STORE: env.AUTH_STORE || fileCfg.AUTH_STORE || (env.RENDER ? 'sheet' : 'files'),
  PUBLIC_URL: env.RENDER_EXTERNAL_URL || env.PUBLIC_URL || '',
};
if (!config.SHEET_URL || !config.SECRET) {
  if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(path.join(DIR, 'config.example.json')) && !env.RENDER) {
    fs.copyFileSync(path.join(DIR, 'config.example.json'), CONFIG_PATH);
  }
  console.log('\n⚠️  Missing settings: set SHEET_URL and SECRET (environment variables or config.json), then start again.\n');
  process.exit(1);
}
process.env.TZ = config.TIMEZONE;

const MARK = '⁣';           // invisible marker on every bot message, so it never reacts to itself
const MAX_AGE_HOURS = 48;        // messages missed while offline are caught up if newer than this
const logger = pino({ level: 'silent' });

let sock = null;
let auth = null;                 // { state, saveCreds, flush, extra, touchExtra, reset }
let groupId = config.GROUP_ID || null;
let started = false;
const names = new Map();
const groupCache = new Map();
const seen = new Set();
const status = { state: 'starting', pairingCode: '', qr: '', groups: [], since: new Date(), events: [] };

function log(...a) {
  const line = new Date().toLocaleString('en-GB') + ' | ' + a.join(' ');
  console.log(line);
  status.events.push(line);
  if (status.events.length > 40) status.events.shift();
}

// ---------- processed-message memory ----------
const STATE_PATH = path.join(DIR, '.state.json');
let processed = new Set();
function loadProcessed() {
  if (config.AUTH_STORE === 'sheet') processed = new Set(auth.extra.processed || []);
  else { try { processed = new Set(JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')).processed || []); } catch {} }
}
function markProcessed(id) {
  processed.add(id);
  const arr = [...processed].slice(-1500);
  if (config.AUTH_STORE === 'sheet') { auth.extra.processed = arr; auth.touchExtra(); }
  else { try { fs.writeFileSync(STATE_PATH, JSON.stringify({ processed: arr })); } catch {} }
}

// ---------- Google Sheet ----------
async function sheet(payload) {
  const res = await fetch(config.SHEET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, secret: config.SECRET }),
    redirect: 'follow',
  });
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch { throw new Error('Sheet did not return JSON (check SHEET_URL / deployment access): ' + txt.slice(0, 150)); }
  if (!data.ok) throw new Error('Sheet error: ' + data.error);
  return data;
}

// ---------- web page (status, pairing code, keep-awake) ----------
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
async function statusPage() {
  const badge = {
    connected: ['#1E7B34', '✅ Connected — the bot is running'],
    'waiting-for-link': ['#B26A00', '📱 Waiting to be linked to WhatsApp'],
    'group-not-found': ['#E4002B', '⚠️ Linked, but the group was not found'],
    starting: ['#666', '⏳ Starting…'],
    reconnecting: ['#666', '🔄 Reconnecting…'],
  }[status.state] || ['#666', status.state];
  let body = '';
  if (status.state === 'waiting-for-link') {
    if (status.pairingCode) {
      body += `<p>On the <b>bot phone</b>: WhatsApp → Settings → <b>Linked devices</b> → Link a device → <b>Link with phone number instead</b> → enter:</p>
        <div class="code">${esc(status.pairingCode)}</div><p class="muted">The code refreshes every few minutes — reload this page if it expires.</p>`;
    } else if (status.qr) {
      body += `<p>On the <b>bot phone</b>: WhatsApp → Settings → <b>Linked devices</b> → Link a device → scan:</p>
        <div class="qr">${await QRCode.toString(status.qr, { type: 'svg', margin: 1, width: 260 })}</div>`;
    }
  }
  if (status.state === 'group-not-found') {
    body += `<p>Set <b>GROUP_NAME</b> to one of these exactly, then redeploy/restart:</p><ul>${status.groups.map(g => '<li>' + esc(g) + '</li>').join('')}</ul>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Task Tracker Bot</title><meta http-equiv="refresh" content="20">
  <style>body{font-family:system-ui,Arial,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;color:#1f1f1f}
  h1{color:#E4002B;font-size:22px}.badge{display:inline-block;padding:8px 14px;border-radius:8px;color:#fff;background:${badge[0]};font-weight:600}
  .code{font:700 34px/1.2 ui-monospace,Consolas,monospace;letter-spacing:4px;background:#f4f4f4;padding:14px 18px;border-radius:10px;display:inline-block;margin:8px 0}
  .muted{color:#777;font-size:13px}pre{background:#f6f6f6;padding:10px;border-radius:8px;font-size:12px;white-space:pre-wrap}</style></head>
  <body><h1>Team Task Tracker — bot status</h1><p><span class="badge">${badge[1]}</span></p>${body}
  <h3>Recent activity</h3><pre>${esc(status.events.slice(-15).join('\n'))}</pre>
  <p class="muted">This page refreshes every 20 seconds.</p></body></html>`;
}

function startWebServer() {
  const port = Number(env.PORT || 0);
  if (!port) return;
  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok ' + status.state); }
    if (url.searchParams.get('key') !== config.SECRET) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<p style="font-family:Arial">Task Tracker bot is running. Add <b>?key=YOUR_KEY</b> to the address to see its status.</p>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await statusPage());
  }).listen(port, () => log('🌐 Status page on port', port));
}

// ---------- WhatsApp connection ----------
async function connect() {
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  sock = makeWASocket({
    version,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, logger) },
    markOnlineOnConnect: false,
    syncFullHistory: false,
    cachedGroupMetadata: async jid => groupCache.get(jid),
  });
  sock.ev.on('creds.update', auth.saveCreds);

  let pairingAsked = false;
  sock.ev.on('connection.update', async u => {
    const { connection, lastDisconnect, qr } = u;
    if (qr && !auth.state.creds.registered) {
      status.state = 'waiting-for-link';
      const num = String(config.PAIR_WITH_NUMBER || '').replace(/\D/g, '');
      if (num) {
        if (!pairingAsked) {
          pairingAsked = true;
          try {
            const code = await sock.requestPairingCode(num);
            status.pairingCode = code.match(/.{1,4}/g).join('-');
            log('🔢 Pairing code: ' + status.pairingCode + ' (enter it on the bot phone)');
            console.log('\n  On the BOT phone: WhatsApp → Settings → Linked devices → Link a device');
            console.log('  → "Link with phone number instead" → enter the code above\n');
          } catch (e) { log('Could not get pairing code:', e.message); }
        }
      } else {
        status.qr = qr;
        if (!env.RENDER) qrcodeTerminal.generate(qr, { small: true });
        log('📱 QR code ready — scan it with the bot phone (Linked devices → Link a device)');
      }
    }
    if (connection === 'open') {
      status.pairingCode = ''; status.qr = '';
      log('✅ WhatsApp connected');
      if (LOGIN_ONLY) {
        await auth.flush();
        console.log('\n✅ Linked successfully.\n');
        setTimeout(() => process.exit(0), 3000);
        return;
      }
      await onReady();
    }
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      status.state = 'reconnecting';
      if (code === DisconnectReason.loggedOut) {
        log('❌ WhatsApp was logged out. Showing a new link code…');
        await auth.reset();
        auth = await loadAuth();
        setTimeout(connect, 3000);
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        log('⚠️ Another copy of the bot took over (normal during a redeploy). Retrying in 60s…');
        setTimeout(connect, 60000);
        return;
      }
      log('⚠️ Connection closed (' + (code || 'unknown') + '), reconnecting in 5s…');
      setTimeout(connect, 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      try { await onMessage(m); } catch (e) { log('Error handling message:', e.message); }
    }
  });
  sock.ev.on('groups.update', ups => ups.forEach(g => groupCache.delete(g.id)));
  sock.ev.on('group-participants.update', g => groupCache.delete(g.id));
}

async function onReady() {
  const groups = Object.values(await sock.groupFetchAllParticipating());
  groups.forEach(g => groupCache.set(g.id, g));
  if (!config.GROUP_ID) {
    const g = groups.find(x => (x.subject || '').trim().toLowerCase() === String(config.GROUP_NAME).trim().toLowerCase());
    groupId = g ? g.id : null;
  }
  if (!groupId) {
    status.state = 'group-not-found';
    status.groups = groups.map(g => g.subject);
    log(`❌ Group "${config.GROUP_NAME}" not found. Groups this number is in: ${status.groups.join(' | ') || '(none — add the bot number to the group)'}`);
    return;
  }
  status.state = 'connected';
  log('👥 Watching group: ' + ((groupCache.get(groupId) || {}).subject || groupId));
  try { const r = await sheet({ action: 'ping', botUrl: config.PUBLIC_URL }); log(r.reply); }
  catch (e) { log('❌ Cannot reach Google Sheet:', e.message); }

  if (started) return; // timers only once, even after reconnects
  started = true;
  if (config.REMINDER_CRON) {
    cron.schedule(config.REMINDER_CRON, sendDigest, { timezone: config.TIMEZONE });
    log('⏰ Daily reminder scheduled: ' + config.REMINDER_CRON);
  }
  setInterval(pushSheetUpdates, 5 * 60 * 1000); // heartbeat + sheet-side updates
  pushSheetUpdates();
}

// ---------- sending ----------
async function send(text, mentions = [], quoted) {
  if (!text || !groupId) return;
  const sent = await sock.sendMessage(groupId, { text: text + MARK, mentions }, quoted ? { quoted } : {});
  if (sent && sent.key && sent.key.id) markProcessed(sent.key.id);
}

async function sendDigest() {
  try {
    const r = await sheet({ action: 'digest' });
    if (r.reply) await send(r.reply, r.mentions || []);
    log('☀️ Daily reminder ' + (r.reply ? 'sent' : '— nothing due'));
  } catch (e) { log('Reminder error:', e.message); }
}

async function pushSheetUpdates() {
  try {
    const r = await sheet({ action: 'pending', post: config.POST_SHEET_UPDATES, botUrl: config.PUBLIC_URL });
    if (config.POST_SHEET_UPDATES && r.reply && r.rows && r.rows.length) {
      await send(r.reply);
      await sheet({ action: 'ack', rows: r.rows });
      log('🔄 Posted ' + r.rows.length + ' sheet update(s)');
    }
  } catch (e) { log('Sheet check error:', e.message); }
}

// ---------- people ----------
async function pnFor(jid, alt) {
  if (alt && !isLidUser(alt)) return alt;
  if (!isLidUser(jid)) return jid;
  try { const pn = await sock.signalRepository.lidMapping.getPNForLID(jid); if (pn) return pn; } catch {}
  const g = groupCache.get(groupId);
  const p = g && g.participants && g.participants.find(x => x.id === jid || x.lid === jid);
  return (p && p.phoneNumber) || '';
}

async function person(jid, alt, pushName) {
  const id = jidNormalizedUser(jid);
  const pn = await pnFor(id, alt);
  return {
    id,
    lid: isLidUser(id) ? id : '',
    number: pn ? pn.split('@')[0].split(':')[0] : '',
    name: pushName || names.get(id) || '',
  };
}

function textOf(message) {
  const m = normalizeMessageContent(message) || {};
  return (
    m.conversation ||
    (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.imageMessage && m.imageMessage.caption) ||
    (m.videoMessage && m.videoMessage.caption) ||
    (m.documentMessage && m.documentMessage.caption) ||
    (m.documentWithCaptionMessage && m.documentWithCaptionMessage.message &&
      m.documentWithCaptionMessage.message.documentMessage &&
      m.documentWithCaptionMessage.message.documentMessage.caption) || ''
  );
}

function mentionsOf(message) {
  const m = normalizeMessageContent(message) || {};
  for (const k of Object.keys(m)) {
    const ci = m[k] && m[k].contextInfo;
    if (ci && ci.mentionedJid && ci.mentionedJid.length) return ci.mentionedJid;
  }
  return [];
}

// ---------- messages ----------
async function onMessage(msg) {
  const key = msg.key || {};
  if (!groupId || key.remoteJid !== groupId || !msg.message) return;
  if (processed.has(key.id)) return;
  const ts = Number(msg.messageTimestamp || 0) * 1000;
  if (ts && Date.now() - ts > MAX_AGE_HOURS * 3600 * 1000) return;

  const body = String(textOf(msg.message) || '').trim();
  if (!body || body.includes(MARK)) return;
  markProcessed(key.id);

  const senderJid = key.fromMe ? (sock.user.lid || sock.user.id) : key.participant;
  const senderAlt = key.fromMe ? sock.user.id : key.participantAlt;
  if (msg.pushName) names.set(jidNormalizedUser(senderJid), msg.pushName);
  const sender = await person(senderJid, senderAlt && jidNormalizedUser(senderAlt), msg.pushName);

  if (!seen.has(sender.id)) { seen.add(sender.id); sheet({ action: 'seen', sender }).catch(() => {}); }

  const mentionIds = mentionsOf(msg.message).map(jidNormalizedUser);

  // ---- Commands
  if (body.startsWith('!')) {
    const mentions = await Promise.all(mentionIds.map(j => person(j)));
    const d = findDate(body.replace(/T-?\d+/i, ''));
    const r = await sheet({ action: 'command', text: body, sender, mentions, date: d ? d.date : '' });
    if (r.reply) await send(r.reply, r.mentions || [], msg);
    log('⌨️ ' + (sender.name || sender.number) + ' ' + body.split(/\s+/)[0]);
    return;
  }

  // ---- Task assignment
  const parsed = parseTask(body, mentionIds.length, ts ? new Date(ts) : new Date());
  if (!parsed) return;
  if (parsed.needsDeadline) {
    await send('⚠️ I need a deadline to log this task. Please resend with e.g. *by 30 Oct* or *by tomorrow*.', [], msg);
    return;
  }
  const assignees = await Promise.all(mentionIds.map(j => person(j)));
  const r = await sheet({ action: 'create', sender, assignees, task: parsed.task, deadline: parsed.deadline, msgId: key.id });
  if (r.reply) { await send(r.reply, r.mentions || [], msg); log('📝 Task logged: ' + parsed.task + ' → ' + parsed.deadline); }
}

// ---------- start ----------
async function loadAuth() {
  if (config.AUTH_STORE === 'sheet') return useSheetAuthState(sheet, log);
  const { state, saveCreds } = await useMultiFileAuthState(path.join(DIR, '.auth'));
  return { state, saveCreds, flush: async () => {}, extra: {}, touchExtra: () => {}, reset: async () => fs.rmSync(path.join(DIR, '.auth'), { recursive: true, force: true }) };
}

async function shutdown(sig) {
  log('Stopping (' + sig + '), saving login…');
  try { await auth.flush(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', e => log('Unhandled:', e && e.message));

(async () => {
  startWebServer();
  log(LOGIN_ONLY ? 'Linking WhatsApp…' : 'Starting Task Tracker bot (login stored in: ' + (config.AUTH_STORE === 'sheet' ? 'Google Drive' : 'this server') + ')');
  for (;;) {
    try { auth = await loadAuth(); break; }
    catch (e) { log('❌ Cannot load login from the sheet (' + e.message + '). Retrying in 30s…'); await new Promise(r => setTimeout(r, 30000)); }
  }
  loadProcessed();
  connect();
})();
