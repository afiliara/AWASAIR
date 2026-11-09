// AwasLink - platform dashboard & kontrol IoT real-time (mirip Blynk)
// - Broker MQTT bawaan (TCP :1883 dan WebSocket /mqtt)
// - Dashboard web real-time (WebSocket /ws) dengan widget yang bisa diatur
// - Datastream, kontrol dua arah (topic <base>/cmd), event + notifikasi (browser & Telegram)
// - HTTP API untuk perangkat/aplikasi lain (/external/api/...)
//
// Jalankan: npm install && npm start

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { createDatalog } from './datalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Konfigurasi
// ---------------------------------------------------------------------------
let fileCfg = {};
const cfgPath = path.join(__dirname, 'config.json');
if (fs.existsSync(cfgPath)) fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const bool = (v, d) => (v === undefined ? d : v === true || v === 'true' || v === '1');

const CFG = {
  httpPort: Number(process.env.PORT || fileCfg.httpPort || 8080),
  mqttPort: Number(process.env.MQTT_PORT || fileCfg.mqttPort || 1883),
  adminUser: process.env.ADMIN_USER || fileCfg.adminUser || 'admin',
  adminPass: process.env.ADMIN_PASS || fileCfg.adminPass || 'admin123',
  // true: warga bisa melihat dashboard tanpa login (hanya-baca). Kontrol tetap butuh login.
  publicView: bool(process.env.PUBLIC_VIEW ?? fileCfg.publicView, true),
  historyDays: Number(process.env.HISTORY_DAYS || fileCfg.historyDays || 30),
  // Data Logger (ala ThingSpeak): jeda minimum antar /update per channel, detik
  rateLimitSec: Number(process.env.RATE_LIMIT_SEC ?? fileCfg.rateLimitSec ?? 5),
  dataDir: process.env.DATA_DIR || fileCfg.dataDir || path.join(__dirname, 'data'),
};
fs.mkdirSync(CFG.dataDir, { recursive: true });

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new DatabaseSync(path.join(CFG.dataDir, 'awaslink.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL UNIQUE, topic TEXT NOT NULL UNIQUE,
  config TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS latest (device_id TEXT, key TEXT, value TEXT, ts INTEGER, PRIMARY KEY(device_id, key));
CREATE TABLE IF NOT EXISTS history (device_id TEXT, key TEXT, ts INTEGER, value TEXT);
CREATE INDEX IF NOT EXISTS idx_hist ON history(device_id, key, ts);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, ts INTEGER, level TEXT, message TEXT);
CREATE INDEX IF NOT EXISTS idx_events ON events(device_id, ts);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

const getSetting = (k, d = '') => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? d;
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

// Cache perangkat di memori: id -> { id, name, token, topic, config, values:{key:{v,ts}}, online, last_seen }
const devices = new Map();
const reserved = new Set(['cmd', 'data', 'online', 'ack']);

function loadDevices() {
  devices.clear();
  for (const row of db.prepare('SELECT * FROM devices').all()) {
    const d = { ...row, config: JSON.parse(row.config), values: {}, online: false, evState: {} };
    let ubah = false;
    if (d.config.contract === 'awasair-v1' && !d.config.datalog) { d.config.datalog = awasairTemplate().datalog; ubah = true; }
    if (migrasiAturanHujan(d.config)) ubah = true;
    if (ubah) db.prepare('UPDATE devices SET config=? WHERE id=?').run(JSON.stringify(d.config), d.id);
    for (const v of db.prepare('SELECT key, value, ts FROM latest WHERE device_id=?').all(row.id)) d.values[v.key] = { v: v.value, ts: v.ts };
    devices.set(row.id, d);
  }
}

function saveDevice(d) {
  db.prepare('UPDATE devices SET name=?, token=?, topic=?, config=? WHERE id=?').run(d.name, d.token, d.topic, JSON.stringify(d.config), d.id);
}

const newToken = () => crypto.randomBytes(16).toString('hex');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'device';

// Template AWASAIR: datastream, widget, dan aturan event bawaan
// Template AWASAIR mengikuti docs/mqtt-contract.md (v1):
//   ESP32 -> <base>/data (JSON), <base>/status, <base>/online, <base>/ack
//   server -> <base>/cmd  {"mute":true} / {"siaga":200,"bahaya":240}
function awasairTemplate() {
  return {
    contract: 'awasair-v1',
    useAck: true, // nilai pengaturan yang tampil = isi `ack` dari alat, bukan yang dikirim dashboard
    staleSeconds: 30,
    // Data Logger: catat data MQTT ke channel 1 tiap 15 detik (field1 level, field2 adc, field3 kode status, field4 jarak)
    datalog: { channel: 1, everySec: 15, fields: { level: 1, adc: 2, status_code: 3, jarak: 4 } },
    datastreams: [
      { key: 'level', name: 'Ketinggian Air', type: 'number', unit: 'cm', min: 0, max: 300, dir: 'in' },
      { key: 'jarak', name: 'Jarak Sensor', type: 'number', unit: 'cm', min: 0, max: 400, dir: 'in' },
      { key: 'adc', name: 'Rain Sensor (ADC)', type: 'number', unit: '', min: 0, max: 4095, dir: 'in' },
      { key: 'hujan', name: 'Kondisi Hujan', type: 'string', dir: 'in' },
      { key: 'status', name: 'Status Sungai', type: 'string', dir: 'in' },
      { key: 'mute', name: 'Bisukan Buzzer', type: 'bool', dir: 'out', def: 0 },
      { key: 'siaga', name: 'Ambang Siaga', type: 'number', unit: 'cm', min: 1, max: 400, dir: 'out', def: 200 },
      { key: 'bahaya', name: 'Ambang Bahaya', type: 'number', unit: 'cm', min: 1, max: 400, dir: 'out', def: 240 },
    ],
    widgets: [
      { id: 'w1', type: 'status', key: 'status', title: 'Status Sungai', w: 2 },
      { id: 'w2', type: 'gauge', key: 'level', title: 'Ketinggian Air', w: 1, lines: 'siaga,bahaya' },
      { id: 'w3', type: 'value', key: 'hujan', title: 'Kondisi Hujan', w: 1 },
      { id: 'w4', type: 'chart', key: 'level', title: 'Riwayat Ketinggian Air', w: 2, minutes: 60, lines: 'siaga,bahaya' },
      { id: 'w5', type: 'chart', key: 'adc', title: 'Riwayat Rain Sensor (ADC, makin kecil makin basah)', w: 2, minutes: 60 },
      { id: 'w6', type: 'switch', key: 'mute', title: 'Bisukan Buzzer', w: 1 },
      { id: 'w7', type: 'value', key: 'jarak', title: 'Jarak Sensor ke Air', w: 1 },
      { id: 'w8', type: 'slider', key: 'siaga', title: 'Ambang Siaga', w: 1 },
      { id: 'w9', type: 'slider', key: 'bahaya', title: 'Ambang Bahaya', w: 1 },
      { id: 'w10', type: 'log', title: 'Notifikasi Terbaru', w: 2 },
    ],
    // Status dari alat sudah menggabungkan air + hujan (hujan lebat = BAHAYA), lihat docs/mqtt-contract.md.
    rules: 2,
    events: [
      { id: 'e1', key: 'status', op: '==', value: 'BAHAYA', level: 'critical', message: BAHAYA_MSG, telegram: true },
      { id: 'e2', key: 'status', op: '==', value: 'SIAGA', level: 'warning', message: 'SIAGA: ketinggian air naik ke {{level}} cm (hujan: {{hujan}}).', telegram: true },
      { id: 'e3', key: 'status', op: '==', value: 'NORMAL', level: 'info', message: 'Kondisi sungai kembali NORMAL ({{level}} cm, hujan: {{hujan}}).', telegram: false },
      { id: 'e4', key: 'status', op: '==', value: 'ERROR', level: 'warning', message: 'Sensor ketinggian gagal membaca (ERROR). Data tidak dapat dipercaya, cek HC-SR04.', telegram: true },
      { id: 'e5', key: 'hujan', op: '==', value: 'sedang', level: 'info', message: 'Hujan sedang terdeteksi di lokasi sensor ({{level}} cm).', telegram: false },
    ],
    notifyOffline: true,
  };
}

const BAHAYA_MSG = 'BAHAYA! Ketinggian air {{level}} cm, hujan {{hujan}}. Segera waspada dan bersiap evakuasi.';

// Perbarui aturan bawaan perangkat lama ke aturan status air + hujan (rules 2).
// Hanya mengganti pesan yang masih bawaan; pesan yang sudah diubah pengguna dibiarkan.
function migrasiAturanHujan(cfg) {
  if (cfg.contract !== 'awasair-v1' || (cfg.rules || 1) >= 2) return false;
  const lama = {
    e1: 'BAHAYA! Ketinggian air {{level}} cm. Segera waspada dan bersiap evakuasi.',
    e3: 'Kondisi sungai kembali NORMAL ({{level}} cm).',
    e5: 'Hujan lebat terdeteksi di lokasi sensor.',
  };
  const baru = Object.fromEntries(awasairTemplate().events.map((e) => [e.id, e]));
  cfg.events = cfg.events.map((e) => (lama[e.id] && e.message === lama[e.id] ? { ...e, ...baru[e.id], telegram: e.telegram } : e));
  cfg.rules = 2;
  return true;
}

function blankTemplate() {
  return { datastreams: [], widgets: [], events: [], notifyOffline: true };
}

function createDevice({ name, topic, template }) {
  let id = slug(name);
  while (devices.has(id)) id = slug(name) + '-' + crypto.randomBytes(2).toString('hex');
  const t = String(topic || 'awasair/' + id).trim().replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9_\-/]+$/.test(t)) throw new Error('Topic hanya boleh huruf, angka, _, -, dan /');
  for (const d of devices.values()) if (d.topic === t) throw new Error('Topic sudah dipakai perangkat lain');
  const config = template === 'blank' ? blankTemplate() : awasairTemplate();
  db.prepare('INSERT INTO devices(id,name,token,topic,config,created_at) VALUES(?,?,?,?,?,?)').run(id, String(name), newToken(), t, JSON.stringify(config), Date.now());
  loadDevices();
  return devices.get(id);
}

loadDevices();
if (devices.size === 0) createDevice({ name: 'Sungai AWASAIR', topic: 'awasair/sungai' });

// ---------------------------------------------------------------------------
// Nilai datastream, riwayat, event
// ---------------------------------------------------------------------------
const wsClients = new Set(); // { ws, admin }

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of wsClients) if (c.ws.readyState === 1) c.ws.send(s);
}

function dsOf(d, key) { return d.config.datastreams.find((x) => x.key === key); }

function normalizeValue(ds, raw) {
  let v = typeof raw === 'string' ? raw.trim() : raw;
  if (ds?.type === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    v = n;
  } else if (ds?.type === 'bool') {
    if (v === true || v === 1 || /^(true|1|on)$/i.test(String(v))) v = 1;
    else if (v === false || v === 0 || /^(false|0|off)$/i.test(String(v))) v = 0;
    else return null;
  }
  return String(v).slice(0, 255);
}

const insertHist = db.prepare('INSERT INTO history(device_id,key,ts,value) VALUES(?,?,?,?)');
const upsertLatest = db.prepare('INSERT INTO latest(device_id,key,value,ts) VALUES(?,?,?,?) ON CONFLICT(device_id,key) DO UPDATE SET value=excluded.value, ts=excluded.ts');

// source: 'device' | 'dashboard' | 'api'
function setValue(d, key, raw, source = 'device') {
  if (reserved.has(key) || !/^[A-Za-z0-9_\-]{1,40}$/.test(key)) return false;
  const ds = dsOf(d, key);
  const v = normalizeValue(ds, raw);
  if (v === null) return false;
  const ts = Date.now();
  d.values[key] = { v, ts };
  upsertLatest.run(d.id, key, v, ts);
  insertHist.run(d.id, key, ts, v);
  broadcast({ t: 'v', d: d.id, k: key, v, ts, src: source });
  if (source !== 'dashboard') evaluateEvents(d, key);
  return true;
}

function touch(d) {
  d.last_seen = Date.now();
  db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(d.last_seen, d.id);
}

function cmp(op, a, b) {
  const na = Number(a); const nb = Number(b);
  const num = Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '';
  switch (op) {
    case '==': return num ? na === nb : String(a).toLowerCase() === String(b).toLowerCase();
    case '!=': return num ? na !== nb : String(a).toLowerCase() !== String(b).toLowerCase();
    case '>': return num && na > nb;
    case '>=': return num && na >= nb;
    case '<': return num && na < nb;
    case '<=': return num && na <= nb;
    default: return false;
  }
}

function render(tpl, d) {
  return String(tpl || '').replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, k) => (k === 'device' ? d.name : d.values[k]?.v ?? '-'));
}

// Event terpicu saat kondisi berubah dari tidak-terpenuhi menjadi terpenuhi (tidak berulang tiap data).
function evaluateEvents(d, key) {
  for (const ev of d.config.events || []) {
    if (ev.key !== key) continue;
    const val = d.values[key]?.v;
    const prev = d.evState[ev.id];
    let fire;
    if (ev.op === 'change') {
      fire = prev !== undefined && prev !== val;
      d.evState[ev.id] = val;
    } else {
      const ok = cmp(ev.op, val, ev.value);
      // Data pertama: event "info" (mis. kembali NORMAL) tidak dipicu, peringatan tetap dipicu.
      fire = ok && (prev === false || (prev === undefined && ev.level !== 'info'));
      d.evState[ev.id] = ok;
    }
    if (fire) logEvent(d, ev.level, render(ev.message, d), ev.telegram);
  }
}

// Isi status awal event dari nilai tersimpan, agar restart server tidak memicu notifikasi ulang.
function primeEvents(d) {
  d.evState = {};
  for (const ev of d.config.events || []) {
    const val = d.values[ev.key]?.v;
    if (val === undefined) continue;
    d.evState[ev.id] = ev.op === 'change' ? val : cmp(ev.op, val, ev.value);
  }
}
for (const d of devices.values()) primeEvents(d);

function logEvent(d, level, message, telegram = false) {
  const ts = Date.now();
  const r = db.prepare('INSERT INTO events(device_id,ts,level,message) VALUES(?,?,?,?)').run(d.id, ts, level, message);
  const ev = { id: Number(r.lastInsertRowid), device_id: d.id, ts, level, message };
  broadcast({ t: 'event', d: d.id, ev, device: d.name });
  console.log(`[event] ${d.name} ${level.toUpperCase()}: ${message}`);
  if (telegram) sendTelegram(`${level === 'critical' ? '🚨' : level === 'warning' ? '⚠️' : 'ℹ️'} ${d.name}\n${message}`);
}

async function sendTelegram(textMsg) {
  const token = getSetting('telegram_token');
  const chats = getSetting('telegram_chats').split(',').map((s) => s.trim()).filter(Boolean);
  if (!token || !chats.length) return;
  for (const chat_id of chats) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, text: textMsg }), signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) console.error('[telegram]', r.status, await r.text());
    } catch (e) { console.error('[telegram]', e.message); }
  }
}

// Bersihkan riwayat lama tiap jam
setInterval(() => {
  const cut = Date.now() - CFG.historyDays * 86400000;
  db.prepare('DELETE FROM history WHERE ts < ?').run(cut);
  db.prepare('DELETE FROM events WHERE ts < ?').run(cut);
}, 3600000).unref();

// ---------------------------------------------------------------------------
// Broker MQTT
// ---------------------------------------------------------------------------
const broker = await Aedes.createBroker();
const clientDevice = new Map(); // mqtt client.id -> device id

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const topicIn = (topic, base) => topic === base || topic.startsWith(base + '/');

broker.authenticate = (client, username, password, cb) => {
  const pass = password ? password.toString() : '';
  if (username === CFG.adminUser && safeEqual(pass, CFG.adminPass)) { client.awas = { admin: true }; return cb(null, true); }
  // Perangkat: password = auth token (username bebas, misalnya id perangkat)
  for (const d of devices.values()) {
    if (pass && safeEqual(pass, d.token)) { client.awas = { device: d.id }; return cb(null, true); }
  }
  const err = new Error('Token salah'); err.returnCode = 4;
  cb(err, false);
};

broker.authorizePublish = (client, packet, cb) => {
  if (packet.topic.startsWith('$SYS')) return cb(new Error('$SYS reserved'));
  if (!client) return cb(null);
  if (client.awas?.admin) return cb(null);
  const d = devices.get(client.awas?.device);
  if (!d || !topicIn(packet.topic, d.topic) || packet.topic === d.topic + '/cmd') return cb(new Error('Topic tidak diizinkan'));
  cb(null);
};

broker.authorizeSubscribe = (client, sub, cb) => {
  if (client.awas?.admin) return cb(null, sub);
  const d = devices.get(client.awas?.device);
  cb(null, d && topicIn(sub.topic, d.topic) ? sub : null);
};

broker.on('clientReady', (client) => {
  const d = devices.get(client.awas?.device);
  if (!d) return;
  clientDevice.set(client.id, d.id);
  const wasOnline = d.online;
  d.online = true; touch(d);
  clearTimeout(d.offTimer);
  broadcast({ t: 'online', d: d.id, online: true, ts: d.last_seen });
  if (!wasOnline) console.log(`[mqtt] ${d.name} online (${client.id})`);
  if (d.offNotified) { d.offNotified = false; logEvent(d, 'info', 'Perangkat online kembali.', d.config.notifyOffline); }
});

broker.on('clientDisconnect', (client) => {
  const id = clientDevice.get(client.id);
  if (!id) return;
  clientDevice.delete(client.id);
  if ([...clientDevice.values()].includes(id)) return; // masih ada koneksi lain
  const d = devices.get(id);
  if (!d) return;
  d.online = false;
  broadcast({ t: 'online', d: d.id, online: false, ts: Date.now() });
  console.log(`[mqtt] ${d.name} offline`);
  // Catat event hanya bila offline lebih dari 30 detik (hindari spam saat reconnect singkat)
  clearTimeout(d.offTimer);
  d.offTimer = setTimeout(() => {
    if (d.online || !d.config.notifyOffline) return;
    d.offNotified = true;
    logEvent(d, 'warning', 'Perangkat terputus (offline) lebih dari 30 detik. Cek daya dan koneksi WiFi.', true);
  }, 30000);
});

// Sinkronisasi: saat perangkat subscribe ke <base>/cmd, kirim semua nilai datastream "out"
broker.on('subscribe', (subs, client) => {
  const d = devices.get(client?.awas?.device);
  if (!d || d.config.useAck) return; // perangkat dengan `ack` adalah sumber kebenaran pengaturannya
  if (!subs.some((s) => s.qos !== 128 && (s.topic === d.topic + '/cmd' || s.topic === d.topic + '/#'))) return;
  setTimeout(() => {
    for (const ds of d.config.datastreams.filter((x) => x.dir === 'out')) {
      const v = d.values[ds.key]?.v ?? (ds.def !== undefined ? String(ds.def) : undefined);
      if (v !== undefined) sendCmd(d, { [ds.key]: v });
    }
  }, 200);
});

broker.on('publish', (packet, client) => {
  if (!client) return;
  const d = devices.get(client.awas?.device) || (client.awas?.admin ? [...devices.values()].find((x) => topicIn(packet.topic, x.topic)) : null);
  if (!d || !topicIn(packet.topic, d.topic)) return;
  const sub = packet.topic.slice(d.topic.length + 1);
  if (!sub || sub === 'cmd' || sub.startsWith('cmd/')) return;
  const payload = packet.payload.toString();
  if (client.awas?.device) touch(d);
  if (sub === 'online') return; // LWT / status koneksi ditangani event klien
  if (sub === 'data' || sub === 'ack') {
    try {
      const obj = JSON.parse(payload);
      for (const [k, v] of Object.entries(obj)) if (v !== null && typeof v !== 'object') setValue(d, k, v, sub === 'ack' ? 'ack' : 'device');
      if (sub === 'ack') { clearTimeout(d.ackTimer); broadcast({ t: 'ack', d: d.id, values: obj }); }
      if (sub === 'data' && d.config.datalog) datalog.recordDevice(d.config.datalog, obj);
    } catch { console.warn(`[mqtt] payload ${packet.topic} bukan JSON valid`); }
    return;
  }
  if (!sub.includes('/')) setValue(d, sub, payload, 'device');
});

// cmd = objek {key: nilai}, contoh {"mute":true} atau {"siaga":200,"bahaya":240}
function sendCmd(d, values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    const ds = dsOf(d, k);
    out[k] = ds?.type === 'bool' ? Number(v) === 1 : ds?.type === 'number' ? Number(v) : v;
  }
  broker.publish({ topic: d.topic + '/cmd', payload: Buffer.from(JSON.stringify(out)), qos: 1, retain: false }, () => {});
  return out;
}

// Tulis pengaturan dari dashboard/API ke perangkat. values = {key: nilai}
function writeToDevice(d, values) {
  const clean = {};
  for (const [key, value] of Object.entries(values || {})) {
    const ds = dsOf(d, key);
    if (!ds || ds.dir !== 'out') throw new Error(`Datastream "${key}" bukan tipe kontrol (out)`);
    const v = normalizeValue(ds, value);
    if (v === null) throw new Error(`Nilai "${key}" tidak valid`);
    if (ds.type === 'number' && ((ds.min != null && Number(v) < ds.min) || (ds.max != null && Number(v) > ds.max))) {
      throw new Error(`${ds.name} harus antara ${ds.min} dan ${ds.max}`);
    }
    clean[key] = v;
  }
  if (!Object.keys(clean).length) throw new Error('Tidak ada nilai yang dikirim');
  if (d.config.contract === 'awasair-v1') {
    // Aturan kontrak: siaga harus lebih kecil dari bahaya (dibanding nilai yang sedang berlaku)
    const siaga = Number(clean.siaga ?? d.values.siaga?.v ?? 200);
    const bahaya = Number(clean.bahaya ?? d.values.bahaya?.v ?? 240);
    if (siaga >= bahaya) throw new Error('Ambang Siaga harus lebih kecil dari ambang Bahaya');
  }
  const cmd = sendCmd(d, clean);
  if (d.config.useAck) {
    // Nilai baru tampil setelah alat mengirim `ack`
    broadcast({ t: 'pending', d: d.id, values: clean });
    clearTimeout(d.ackTimer);
    d.ackTimer = setTimeout(() => broadcast({ t: 'ack-timeout', d: d.id }), 10000);
  } else {
    for (const [k, v] of Object.entries(clean)) setValue(d, k, v, 'dashboard');
  }
  return cmd;
}

const writeBody = (b) => (b.values && typeof b.values === 'object' ? b.values : { [b.key]: b.value });

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const sessions = new Map();
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((p) => p.trim().split('=').map(decodeURIComponent)).filter((x) => x[0]));
function isAdmin(req) {
  const s = sessions.get(parseCookies(req).al_sid);
  if (!s) return false;
  if (s.exp < Date.now()) { sessions.delete(parseCookies(req).al_sid); return false; }
  return true;
}
const canView = (req) => CFG.publicView || isAdmin(req);
const datalog = createDatalog({ db, isAdmin, rateLimitSec: CFG.rateLimitSec });

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...extra });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
const json = (res, o, s = 200) => send(res, s, o);
const text = (res, t, s = 200) => send(res, s, String(t), 'text/plain; charset=utf-8');
const fail = (res, s, msg) => json(res, { error: msg }, s);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 1e6) { req.destroy(); reject(new Error('Body terlalu besar')); } else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve(Object.fromEntries(new URLSearchParams(raw))); }
    });
    req.on('error', reject);
  });
}

function publicDevice(d, admin) {
  const out = { id: d.id, name: d.name, topic: d.topic, online: d.online, last_seen: d.last_seen, config: d.config, values: d.values };
  if (admin) out.token = d.token;
  return out;
}

function findByToken(token) {
  for (const d of devices.values()) if (token && safeEqual(token, d.token)) return d;
  return null;
}

const routes = [];
const route = (m, p, h) => routes.push({ m, p, h });
const admin = (h) => (req, res, q, m) => (isAdmin(req) ? h(req, res, q, m) : fail(res, 401, 'Perlu login admin'));
const viewer = (h) => (req, res, q, m) => (canView(req) ? h(req, res, q, m) : fail(res, 401, 'Perlu login'));
const withDevice = (h) => (req, res, q, m) => { const d = devices.get(m[1]); return d ? h(req, res, q, m, d) : fail(res, 404, 'Perangkat tidak ditemukan'); };

// Auth
route('POST', /^\/api\/login$/, async (req, res) => {
  const b = await readBody(req);
  if (!(safeEqual(b.username || '', CFG.adminUser) && safeEqual(b.password || '', CFG.adminPass))) return fail(res, 401, 'Username atau password salah');
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { exp: Date.now() + SESSION_TTL });
  send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': `al_sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}` });
});
route('POST', /^\/api\/logout$/, (req, res) => { sessions.delete(parseCookies(req).al_sid); send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': 'al_sid=; Path=/; Max-Age=0' }); });
route('GET', /^\/api\/me$/, (req, res) => json(res, { admin: isAdmin(req), user: isAdmin(req) ? CFG.adminUser : null, publicView: CFG.publicView, mqttPort: CFG.mqttPort, httpPort: CFG.httpPort, rateLimitSec: CFG.rateLimitSec }));

// Perangkat
route('GET', /^\/api\/devices$/, viewer((req, res) => json(res, [...devices.values()].map((d) => publicDevice(d, isAdmin(req))))));
route('POST', /^\/api\/devices$/, admin(async (req, res) => {
  const b = await readBody(req);
  if (!b.name) return fail(res, 400, 'Nama perangkat wajib diisi');
  try { json(res, publicDevice(createDevice(b), true), 201); } catch (e) { fail(res, 400, e.message); }
}));
route('GET', /^\/api\/devices\/([\w-]+)$/, viewer(withDevice((req, res, q, m, d) => json(res, publicDevice(d, isAdmin(req))))));
route('PUT', /^\/api\/devices\/([\w-]+)$/, admin(withDevice(async (req, res, q, m, d) => {
  const b = await readBody(req);
  if (b.name) d.name = String(b.name).slice(0, 60);
  if (b.topic && b.topic !== d.topic) {
    const t = String(b.topic).trim().replace(/^\/+|\/+$/g, '');
    if (!/^[A-Za-z0-9_\-/]+$/.test(t)) return fail(res, 400, 'Topic tidak valid');
    if ([...devices.values()].some((x) => x !== d && x.topic === t)) return fail(res, 400, 'Topic sudah dipakai');
    d.topic = t;
  }
  if (b.config) {
    const c = b.config;
    if (!Array.isArray(c.datastreams) || !Array.isArray(c.widgets) || !Array.isArray(c.events)) return fail(res, 400, 'Config tidak valid');
    for (const ds of c.datastreams) {
      if (!/^[A-Za-z0-9_\-]{1,40}$/.test(ds.key || '') || reserved.has(ds.key)) return fail(res, 400, `Key datastream "${ds.key}" tidak valid`);
    }
    if (new Set(c.datastreams.map((x) => x.key)).size !== c.datastreams.length) return fail(res, 400, 'Key datastream tidak boleh kembar');
    d.config = { ...d.config, datastreams: c.datastreams, widgets: c.widgets, events: c.events, notifyOffline: c.notifyOffline !== false };
    primeEvents(d);
  }
  saveDevice(d);
  broadcast({ t: 'config', d: d.id });
  json(res, publicDevice(d, true));
})));
route('DELETE', /^\/api\/devices\/([\w-]+)$/, admin(withDevice((req, res, q, m, d) => {
  for (const t of ['latest', 'history', 'events']) db.prepare(`DELETE FROM ${t} WHERE device_id=?`).run(d.id);
  db.prepare('DELETE FROM devices WHERE id=?').run(d.id);
  devices.delete(d.id);
  broadcast({ t: 'config', d: d.id });
  json(res, { ok: true });
})));
route('POST', /^\/api\/devices\/([\w-]+)\/token$/, admin(withDevice((req, res, q, m, d) => {
  d.token = newToken(); saveDevice(d);
  for (const c of broker.clients ? Object.values(broker.clients) : []) if (c.awas?.device === d.id) c.close();
  json(res, publicDevice(d, true));
})));
route('POST', /^\/api\/devices\/([\w-]+)\/write$/, admin(withDevice(async (req, res, q, m, d) => {
  const b = await readBody(req);
  try { json(res, { ok: true, cmd: writeToDevice(d, writeBody(b)), pending: !!d.config.useAck }); } catch (e) { fail(res, 400, e.message); }
})));
route('GET', /^\/api\/devices\/([\w-]+)\/history$/, viewer(withDevice((req, res, q, m, d) => {
  const minutes = Math.min(Number(q.minutes) || 60, CFG.historyDays * 1440);
  const rows = db.prepare('SELECT ts, value v FROM history WHERE device_id=? AND key=? AND ts>=? ORDER BY ts').all(d.id, String(q.key), Date.now() - minutes * 60000);
  // perkecil jumlah titik agar grafik tetap ringan
  const max = 600; const stepN = Math.ceil(rows.length / max);
  json(res, stepN > 1 ? rows.filter((_, i) => i % stepN === 0 || i === rows.length - 1) : rows);
})));
route('GET', /^\/api\/devices\/([\w-]+)\/history\.csv$/, viewer(withDevice((req, res, q, m, d) => {
  const minutes = Number(q.minutes) || 1440;
  const rows = db.prepare('SELECT ts, key, value FROM history WHERE device_id=? AND ts>=? ORDER BY ts').all(d.id, Date.now() - minutes * 60000);
  send(res, 200, 'waktu,key,value\n' + rows.map((r) => `${new Date(r.ts).toISOString()},${r.key},"${String(r.value).replace(/"/g, '""')}"`).join('\n') + '\n',
    'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${d.id}_history.csv"` });
})));
// CSV data air untuk warga: kolom sudah dipivot (waktu, ketinggian, hujan, status), tanpa data teknis (ADC, konfigurasi buzzer).
route('GET', /^\/api\/devices\/([\w-]+)\/air\.csv$/, viewer(withDevice((req, res, q, m, d) => {
  const minutes = Math.min(Number(q.minutes) || 1440, CFG.historyDays * 1440);
  const rows = db.prepare(`SELECT ts/1000 AS sec, MIN(ts) AS ts,
      MAX(CASE WHEN key='level' THEN value END) AS level,
      MAX(CASE WHEN key='hujan' THEN value END) AS hujan,
      MAX(CASE WHEN key='status' THEN value END) AS status
    FROM history WHERE device_id=? AND key IN ('level','hujan','status') AND ts>=?
    GROUP BY sec HAVING level IS NOT NULL ORDER BY sec`).all(d.id, Date.now() - minutes * 60000);
  const cell = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
  const body = 'waktu,ketinggian_air_cm,hujan,status\n' + rows.map((r) => [new Date(r.ts).toISOString(), r.level, cell(r.hujan), cell(r.status)].join(',')).join('\n') + '\n';
  send(res, 200, '\ufeff' + body, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="data_air_${d.id}.csv"` });
})));
route('GET', /^\/api\/devices\/([\w-]+)\/events$/, viewer(withDevice((req, res, q, m, d) => {
  json(res, db.prepare('SELECT * FROM events WHERE device_id=? ORDER BY ts DESC LIMIT ?').all(d.id, Math.min(Number(q.limit) || 50, 500)));
})));
route('DELETE', /^\/api\/devices\/([\w-]+)\/events$/, admin(withDevice((req, res, q, m, d) => { db.prepare('DELETE FROM events WHERE device_id=?').run(d.id); json(res, { ok: true }); })));
route('GET', /^\/api\/events$/, viewer((req, res, q) => {
  json(res, db.prepare('SELECT * FROM events ORDER BY ts DESC LIMIT ?').all(Math.min(Number(q.limit) || 50, 500)));
}));

// Pengaturan
route('GET', /^\/api\/settings$/, admin((req, res) => json(res, { telegram_token: getSetting('telegram_token') ? '********' : '', telegram_chats: getSetting('telegram_chats') })));
route('PUT', /^\/api\/settings$/, admin(async (req, res) => {
  const b = await readBody(req);
  if (b.telegram_token !== undefined && b.telegram_token !== '********') setSetting('telegram_token', String(b.telegram_token).trim());
  if (b.telegram_chats !== undefined) setSetting('telegram_chats', String(b.telegram_chats));
  json(res, { ok: true });
}));
route('POST', /^\/api\/settings\/telegram-test$/, admin(async (req, res) => {
  if (!getSetting('telegram_token') || !getSetting('telegram_chats')) return fail(res, 400, 'Isi token bot dan chat id dulu');
  await sendTelegram('✅ Tes notifikasi dari AwasLink berhasil.');
  json(res, { ok: true });
}));

// HTTP API eksternal (mirip Blynk HTTP API), autentikasi dengan token perangkat
route('GET', /^\/external\/api\/get$/, (req, res, q) => {
  const d = findByToken(q.token);
  if (!d) return fail(res, 401, 'Token salah');
  if (q.key) return d.values[q.key] ? text(res, d.values[q.key].v) : fail(res, 404, 'Belum ada nilai');
  json(res, Object.fromEntries(Object.entries(d.values).map(([k, v]) => [k, v.v])));
});
route('GET', /^\/external\/api\/update$/, (req, res, q) => {
  const d = findByToken(q.token);
  if (!d) return fail(res, 401, 'Token salah');
  touch(d);
  const updated = Object.entries(q).filter(([k]) => k !== 'token').filter(([k, v]) => setValue(d, k, v, 'api')).map(([k]) => k);
  json(res, { ok: true, updated });
});
route('GET', /^\/external\/api\/write$/, (req, res, q) => {
  const d = findByToken(q.token);
  if (!d) return fail(res, 401, 'Token salah');
  try { json(res, { ok: true, cmd: writeToDevice(d, writeBody(q)), pending: !!d.config.useAck }); } catch (e) { fail(res, 400, e.message); }
});
route('GET', /^\/external\/api\/isHardwareConnected$/, (req, res, q) => {
  const d = findByToken(q.token);
  if (!d) return fail(res, 401, 'Token salah');
  text(res, d.online ? 'true' : 'false');
});

const MIME = { '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
function serveStatic(req, res, pathname) {
  // Halaman Data & Ekspor khusus admin; selain admin dikembalikan ke dashboard utama.
  if (/^\/data(\/|$)/.test(pathname) && !isAdmin(req)) { res.writeHead(302, { Location: '/' }); return res.end(); }
  const pub = path.join(__dirname, 'public');
  if (pathname === '/console' || pathname === '/data') { res.writeHead(301, { Location: pathname + '/' }); return res.end(); }
  let f = path.normalize(path.join(pub, decodeURIComponent(pathname)));
  if (!f.startsWith(pub)) return fail(res, 403, 'Forbidden');
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) {
    if (path.extname(f)) return fail(res, 404, 'File tidak ditemukan');
    f = path.join(pub, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const q = Object.fromEntries(url.searchParams);
    for (const r of routes) {
      if (r.m !== req.method) continue;
      const m = url.pathname.match(r.p);
      if (m) return await r.h(req, res, q, m);
    }
    if (await datalog.handle(req, res, url)) return; // API & halaman Data Logger (ala ThingSpeak)
    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    fail(res, 404, 'Tidak ditemukan');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) fail(res, 500, e.message);
  }
});

// WebSocket: /ws untuk dashboard, /mqtt untuk MQTT over WebSocket
const wssApp = new WebSocketServer({ noServer: true });
const wssMqtt = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://localhost').pathname;
  if (p === '/ws') wssApp.handleUpgrade(req, socket, head, (ws) => wssApp.emit('connection', ws, req));
  else if (p === '/mqtt') wssMqtt.handleUpgrade(req, socket, head, (ws) => wssMqtt.emit('connection', ws, req));
  else socket.destroy();
});

wssMqtt.on('connection', (ws, req) => broker.handle(createWebSocketStream(ws), req));

wssApp.on('connection', (ws, req) => {
  if (!canView(req)) { ws.close(4001, 'unauthorized'); return; }
  const c = { ws, admin: isAdmin(req) };
  wsClients.add(c);
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'write') {
      if (!c.admin) return ws.send(JSON.stringify({ t: 'error', msg: 'Login admin untuk mengontrol perangkat' }));
      const d = devices.get(m.d);
      if (!d) return;
      try { writeToDevice(d, m.values || { [m.k]: m.v }); } catch (e) { ws.send(JSON.stringify({ t: 'error', msg: e.message })); }
    }
  });
  ws.on('close', () => wsClients.delete(c));
  const ping = setInterval(() => ws.readyState === 1 && ws.ping(), 25000);
  ws.on('close', () => clearInterval(ping));
});

net.createServer(broker.handle).listen(CFG.mqttPort, () => {
  console.log(`\n  AwasLink MQTT broker  : mqtt://0.0.0.0:${CFG.mqttPort}  (WebSocket: ws://localhost:${CFG.httpPort}/mqtt)`);
});
server.listen(CFG.httpPort, () => {
  console.log(`  AwasLink dashboard    : http://localhost:${CFG.httpPort}`);
  console.log(`  Konsol teknisi        : http://localhost:${CFG.httpPort}/console/`);
  console.log(`  Data Logger (ala ThingSpeak): http://localhost:${CFG.httpPort}/data/`);
  const ch1 = datalog.getChannel(1);
  if (ch1) console.log(`  Channel #1 write key  : ${ch1.write_key}`);
  console.log(`  Login admin           : ${CFG.adminUser} / ${CFG.adminPass === 'admin123' ? 'admin123 (GANTI lewat ADMIN_PASS!)' : '********'}`);
  for (const d of devices.values()) console.log(`  Perangkat "${d.name}"  : topic ${d.topic}/...  token ${d.token}`);
  console.log('');
});
