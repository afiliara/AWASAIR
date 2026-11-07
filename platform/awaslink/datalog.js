// Data Logger AwasLink: fitur ala ThingSpeak di dalam AwasLink.
// - Channel 8 field dengan Write/Read API key
// - API kompatibel ThingSpeak: /update, /channels/:id/feeds.json, .csv, fields, last, status, stream (SSE)
// - Impor/ekspor CSV, React (aksi otomatis: log / webhook / Telegram)
// - Data perangkat MQTT dicatat otomatis ke channel (lihat recordDevice)
// Memakai database, login admin, dan port HTTP yang sama dengan AwasLink.
import crypto from 'node:crypto';

export function createDatalog({ db, isAdmin, rateLimitSec = 5, maxResults = 8000 }) {
const CFG = { rateLimitSec, maxResults };

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  latitude REAL, longitude REAL,
  field1 TEXT, field2 TEXT, field3 TEXT, field4 TEXT,
  field5 TEXT, field6 TEXT, field7 TEXT, field8 TEXT,
  public INTEGER DEFAULT 0,
  write_key TEXT NOT NULL UNIQUE,
  read_key TEXT NOT NULL UNIQUE,
  last_entry_id INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feeds (
  channel_id INTEGER NOT NULL,
  entry_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  field1 TEXT, field2 TEXT, field3 TEXT, field4 TEXT,
  field5 TEXT, field6 TEXT, field7 TEXT, field8 TEXT,
  status TEXT,
  PRIMARY KEY (channel_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_feeds_time ON feeds(channel_id, created_at);
CREATE TABLE IF NOT EXISTS reacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  field INTEGER NOT NULL,
  op TEXT NOT NULL,
  value TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'change',
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  message TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  last_state INTEGER DEFAULT 0,
  last_fired TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

const FIELDS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => 'field' + n);

const isoNoMs = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const nowIso = () => isoNoMs(Date.now());
const newKey = () => crypto.randomBytes(8).toString('hex').toUpperCase();

function getSetting(key, def = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

const getChannel = (id) => db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(id));

// Seed channel AWASAIR saat database masih kosong
if (db.prepare('SELECT COUNT(*) n FROM channels').get().n === 0) {
  const t = nowIso();
  db.prepare(`INSERT INTO channels(name,description,field1,field2,field3,field4,public,write_key,read_key,created_at,updated_at,latitude,longitude)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'AWASAIR - Sungai',
    'Pemantauan ketinggian muka air sungai dan kondisi hujan (prototipe AWASAIR, UNS).',
    'Ketinggian Air (cm)', 'Hujan (ADC)', 'Status (0=Normal,1=Siaga,2=Bahaya,-1=Error)', 'Jarak Sensor (cm)',
    1, newKey(), newKey(), t, t, -7.5608, 110.8566,
  );
  db.prepare(`INSERT INTO reacts(channel_id,name,field,op,value,mode,action,target,message)
              VALUES(1,'Air masuk status BAHAYA',3,'>=','2','change','log','-','BAHAYA! Ketinggian air {{field1}} cm di {{channel}}')`).run();
}

// ---------------------------------------------------------------------------
// Utilitas HTTP
// ---------------------------------------------------------------------------

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(data);
}
const json = (res, obj, status = 200) => send(res, status, obj);
const text = (res, str, status = 200) => send(res, status, String(str), 'text/plain; charset=utf-8');
const fail = (res, status, msg) => json(res, { error: msg }, status);

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body terlalu besar')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseParams(req, url) {
  const params = Object.fromEntries(url.searchParams);
  if (req.method === 'GET' || req.method === 'HEAD') return params;
  const raw = await readBody(req);
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!raw) return params;
  if (ct.includes('application/json')) {
    try { Object.assign(params, JSON.parse(raw)); } catch { /* abaikan */ }
  } else if (ct.includes('text/csv') || ct.includes('text/plain')) {
    params._raw = raw;
  } else {
    Object.assign(params, Object.fromEntries(new URLSearchParams(raw)));
  }
  return params;
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function apiKeyFrom(req, params) {
  return params.api_key || params.key || req.headers['x-thingspeakapikey'] || req.headers['x-api-key'] || '';
}

function canRead(req, ch, params) {
  if (ch.public || isAdmin(req)) return true;
  const k = String(apiKeyFrom(req, params)).toUpperCase();
  return k && (k === ch.read_key || k === ch.write_key);
}

// ---------------------------------------------------------------------------
// Logika feed
// ---------------------------------------------------------------------------
const lastUpdateAt = new Map(); // channel_id -> ms
const streams = new Map(); // channel_id -> Set<res>  (Server-Sent Events)

function channelJson(ch, withKeys = false) {
  const out = {
    id: ch.id, name: ch.name, description: ch.description,
    latitude: ch.latitude, longitude: ch.longitude,
    created_at: ch.created_at, updated_at: ch.updated_at,
    last_entry_id: ch.last_entry_id, public: !!ch.public,
  };
  for (const f of FIELDS) if (ch[f]) out[f] = ch[f];
  if (withKeys) { out.write_key = ch.write_key; out.read_key = ch.read_key; }
  return out;
}

function feedJson(ch, row, onlyField) {
  const out = { created_at: row.created_at, entry_id: row.entry_id };
  for (const f of FIELDS) {
    if (onlyField && f !== onlyField) continue;
    if (ch[f] || row[f] != null) out[f] = row[f];
  }
  if (!onlyField && row.status != null) out.status = row.status;
  return out;
}

function normTime(s) {
  if (!s) return null;
  // Terima "YYYY-MM-DD HH:MM:SS", "YYYY-MM-DDTHH:MM:SSZ", epoch detik
  if (/^\d{9,11}$/.test(s)) return new Date(Number(s) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const d = new Date(String(s).includes('T') || /Z|[+-]\d\d:?\d\d$/.test(s) ? s : String(s).replace(' ', 'T') + 'Z');
  return isNaN(d) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function insertFeed(ch, params, { skipRateLimit = false } = {}) {
  const now = Date.now();
  if (!skipRateLimit && CFG.rateLimitSec > 0) {
    const last = lastUpdateAt.get(ch.id) || 0;
    if (now - last < CFG.rateLimitSec * 1000) return { error: 'rate_limit' };
  }
  const values = {};
  let any = false;
  for (const f of FIELDS) {
    if (params[f] !== undefined && params[f] !== '') { values[f] = String(params[f]).slice(0, 255); any = true; }
  }
  const status = params.status !== undefined ? String(params.status).slice(0, 255) : null;
  if (!any && status == null) return { error: 'no_data' };
  const createdAt = normTime(params.created_at) || nowIso();
  const entryId = ch.last_entry_id + 1;
  db.prepare(`INSERT INTO feeds(channel_id,entry_id,created_at,${FIELDS.join(',')},status)
              VALUES(?,?,?,${FIELDS.map(() => '?').join(',')},?)`)
    .run(ch.id, entryId, createdAt, ...FIELDS.map((f) => values[f] ?? null), status);
  db.prepare('UPDATE channels SET last_entry_id=?, updated_at=? WHERE id=?').run(entryId, nowIso(), ch.id);
  ch.last_entry_id = entryId;
  if (!skipRateLimit) lastUpdateAt.set(ch.id, now);
  const row = { entry_id: entryId, created_at: createdAt, status, ...Object.fromEntries(FIELDS.map((f) => [f, values[f] ?? null])) };
  return { row };
}

function afterInsert(ch, row) {
  const payload = `event: feed\ndata: ${JSON.stringify(feedJson(ch, row))}\n\n`;
  for (const res of streams.get(ch.id) || []) res.write(payload);
  runReacts(ch, row).catch((e) => console.error('[react]', e.message));
}

function queryFeeds(ch, params) {
  const where = ['channel_id = ?'];
  const args = [ch.id];
  const start = normTime(params.start);
  const end = normTime(params.end);
  if (start) { where.push('created_at >= ?'); args.push(start); }
  if (end) { where.push('created_at <= ?'); args.push(end); }
  if (params.minutes) { where.push('created_at >= ?'); args.push(isoNoMs(Date.now() - Number(params.minutes) * 60000)); }
  if (params.days) { where.push('created_at >= ?'); args.push(isoNoMs(Date.now() - Number(params.days) * 86400000)); }
  const hasRange = start || end || params.minutes || params.days;
  let limit = Number(params.results);
  if (!Number.isFinite(limit) || limit <= 0) limit = hasRange ? CFG.maxResults : 100;
  limit = Math.min(limit, CFG.maxResults);
  const rows = db.prepare(`SELECT * FROM feeds WHERE ${where.join(' AND ')} ORDER BY entry_id DESC LIMIT ?`).all(...args, limit);
  return rows.reverse();
}

function toCsv(ch, rows) {
  const cols = ['created_at', 'entry_id', ...FIELDS.filter((f) => ch[f]), 'status'];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

function parseCsv(textData) {
  const rows = [];
  let row = []; let cur = ''; let q = false;
  for (let i = 0; i < textData.length; i++) {
    const c = textData[i];
    if (q) {
      if (c === '"' && textData[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && textData[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

// ---------------------------------------------------------------------------
// React: aksi otomatis saat kondisi data terpenuhi (mirip ThingSpeak React)
// ---------------------------------------------------------------------------
function check(op, a, b) {
  const na = Number(a); const nb = Number(b);
  const numeric = Number.isFinite(na) && Number.isFinite(nb);
  switch (op) {
    case '>': return numeric && na > nb;
    case '>=': return numeric && na >= nb;
    case '<': return numeric && na < nb;
    case '<=': return numeric && na <= nb;
    case '==': return numeric ? na === nb : String(a).toLowerCase() === String(b).toLowerCase();
    case '!=': return numeric ? na !== nb : String(a).toLowerCase() !== String(b).toLowerCase();
    case 'contains': return String(a).toLowerCase().includes(String(b).toLowerCase());
    default: return false;
  }
}

function renderTemplate(tpl, ch, row, r) {
  const map = { channel: ch.name, channel_id: ch.id, entry_id: row.entry_id, created_at: row.created_at, status: row.status ?? '', value: row['field' + r.field] ?? '', react: r.name };
  for (const f of FIELDS) map[f] = row[f] ?? '';
  return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (k in map ? map[k] : ''));
}

const reactLog = []; // 100 kejadian terakhir (in-memory)

async function runReacts(ch, row) {
  const list = db.prepare('SELECT * FROM reacts WHERE channel_id = ? AND enabled = 1').all(ch.id);
  for (const r of list) {
    const v = row['field' + r.field];
    if (v == null) continue;
    const ok = check(r.op, v, r.value);
    const prev = !!r.last_state;
    if (ok !== prev) db.prepare('UPDATE reacts SET last_state=? WHERE id=?').run(ok ? 1 : 0, r.id);
    const fire = ok && (r.mode === 'every' || !prev);
    if (!fire) continue;
    const msg = renderTemplate(r.message || `{{react}}: field${r.field} = {{value}} ({{channel}})`, ch, row, r);
    let result = 'ok';
    try {
      if (r.action === 'webhook') {
        const resp = await fetch(r.target, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ react: r.name, message: msg, channel_id: ch.id, channel: ch.name, field: r.field, value: v, entry: feedJson(ch, row) }),
          signal: AbortSignal.timeout(8000),
        });
        result = 'HTTP ' + resp.status;
      } else if (r.action === 'telegram') {
        const token = getSetting('telegram_token');
        if (!token) throw new Error('Token bot Telegram belum diisi (menu Pengaturan)');
        const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: r.target, text: msg }),
          signal: AbortSignal.timeout(8000),
        });
        result = 'Telegram HTTP ' + resp.status;
      }
    } catch (e) { result = 'gagal: ' + e.message; }
    db.prepare('UPDATE reacts SET last_fired=? WHERE id=?').run(nowIso(), r.id);
    reactLog.unshift({ time: nowIso(), channel_id: ch.id, react: r.name, action: r.action, message: msg, result });
    reactLog.length = Math.min(reactLog.length, 100);
    console.log(`[react] ${r.name} -> ${r.action}: ${msg} (${result})`);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });
const adminOnly = (handler) => (req, res, p, m) => (isAdmin(req) ? handler(req, res, p, m) : fail(res, 401, 'Perlu login admin'));

// ---- API kompatibel ThingSpeak --------------------------------------------
async function handleUpdate(req, res, params, m) {
  const key = String(apiKeyFrom(req, params)).toUpperCase();
  const ch = key && db.prepare('SELECT * FROM channels WHERE write_key = ?').get(key);
  const asJson = m[1] === '.json';
  if (!ch) return asJson ? fail(res, 401, 'Write API key salah') : text(res, '0', 401);
  const r = insertFeed(ch, params);
  if (r.error) return asJson ? fail(res, r.error === 'rate_limit' ? 429 : 400, r.error) : text(res, '0');
  afterInsert(ch, r.row);
  return asJson ? json(res, { channel_id: ch.id, ...feedJson(ch, r.row) }) : text(res, r.row.entry_id);
}
route('GET', /^\/update(\.json)?$/, handleUpdate);
route('POST', /^\/update(\.json)?$/, handleUpdate);

// Bulk update: POST /channels/:id/bulk_update.json  {write_api_key, updates:[{created_at, field1..}]}
route('POST', /^\/channels\/(\d+)\/bulk_update\.json$/, (req, res, p, m) => {
  const ch = getChannel(m[1]);
  if (!ch) return fail(res, 404, 'Channel tidak ditemukan');
  if (String(p.write_api_key || apiKeyFrom(req, p)).toUpperCase() !== ch.write_key) return fail(res, 401, 'Write API key salah');
  const updates = Array.isArray(p.updates) ? p.updates.slice(0, 960) : [];
  let n = 0;
  for (const u of updates) { const r = insertFeed(ch, u, { skipRateLimit: true }); if (r.row) { n++; afterInsert(ch, r.row); } }
  json(res, { success: true, inserted: n });
});

function withReadableChannel(handler) {
  return (req, res, p, m) => {
    const ch = getChannel(m[1]);
    if (!ch) return fail(res, 404, 'Channel tidak ditemukan');
    if (!canRead(req, ch, p)) return fail(res, 401, 'Channel privat: butuh Read API key');
    return handler(req, res, p, m, ch);
  };
}

route('GET', /^\/channels\/(\d+)\.json$/, withReadableChannel((req, res, p, m, ch) => json(res, channelJson(ch))));

route('GET', /^\/channels\/(\d+)\/feeds\.json$/, withReadableChannel((req, res, p, m, ch) => {
  const rows = queryFeeds(ch, p);
  json(res, { channel: channelJson(ch), feeds: rows.map((r) => feedJson(ch, r)) });
}));

route('GET', /^\/channels\/(\d+)\/feeds\.csv$/, withReadableChannel((req, res, p, m, ch) => {
  send(res, 200, toCsv(ch, queryFeeds(ch, p)), 'text/csv; charset=utf-8', {
    'Content-Disposition': `attachment; filename="channel_${ch.id}_feeds.csv"`,
  });
}));

route('GET', /^\/channels\/(\d+)\/feeds\/last(\.json|\.txt)?$/, withReadableChannel((req, res, p, m, ch) => {
  const row = db.prepare('SELECT * FROM feeds WHERE channel_id=? ORDER BY entry_id DESC LIMIT 1').get(ch.id);
  if (m[2] === '.txt') return text(res, row ? row.field1 ?? '' : '-1');
  json(res, row ? feedJson(ch, row) : -1);
}));

route('GET', /^\/channels\/(\d+)\/fields\/([1-8])\.(json|csv)$/, withReadableChannel((req, res, p, m, ch) => {
  const f = 'field' + m[2];
  const rows = queryFeeds(ch, p);
  if (m[3] === 'csv') {
    return send(res, 200, ['created_at,entry_id,' + f, ...rows.map((r) => `${r.created_at},${r.entry_id},${r[f] ?? ''}`)].join('\n') + '\n', 'text/csv; charset=utf-8');
  }
  json(res, { channel: channelJson(ch), feeds: rows.map((r) => feedJson(ch, r, f)) });
}));

route('GET', /^\/channels\/(\d+)\/fields\/([1-8])\/last(\.json|\.txt)?$/, withReadableChannel((req, res, p, m, ch) => {
  const f = 'field' + m[2];
  const row = db.prepare(`SELECT * FROM feeds WHERE channel_id=? AND ${f} IS NOT NULL ORDER BY entry_id DESC LIMIT 1`).get(ch.id);
  if (m[3] === '.json') return json(res, row ? feedJson(ch, row, f) : -1);
  text(res, row ? row[f] : '-1');
}));

route('GET', /^\/channels\/(\d+)\/status\.json$/, withReadableChannel((req, res, p, m, ch) => {
  const rows = db.prepare('SELECT entry_id, created_at, status FROM feeds WHERE channel_id=? AND status IS NOT NULL ORDER BY entry_id DESC LIMIT ?')
    .all(ch.id, Math.min(Number(p.results) || 100, CFG.maxResults)).reverse();
  json(res, { channel: { id: ch.id, name: ch.name }, feeds: rows });
}));

// Server-Sent Events: data baru dikirim langsung ke browser
route('GET', /^\/channels\/(\d+)\/stream$/, withReadableChannel((req, res, p, m, ch) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  res.write(': connected\n\n');
  if (!streams.has(ch.id)) streams.set(ch.id, new Set());
  streams.get(ch.id).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); streams.get(ch.id)?.delete(res); });
}));

// ---- API manajemen (halaman Data Logger) -----------------------------------
route('GET', /^\/api\/channels$/, (req, res) => {
  const admin = isAdmin(req);
  const rows = db.prepare(`SELECT * FROM channels ${admin ? '' : 'WHERE public = 1'} ORDER BY id`).all();
  json(res, rows.map((c) => channelJson(c, admin)));
});

route('GET', /^\/api\/channels\/(\d+)$/, (req, res, p, m) => {
  const ch = getChannel(m[1]);
  if (!ch) return fail(res, 404, 'Channel tidak ditemukan');
  const admin = isAdmin(req);
  if (!admin && !canRead(req, ch, p)) return fail(res, 401, 'Channel privat');
  const count = db.prepare('SELECT COUNT(*) n FROM feeds WHERE channel_id=?').get(ch.id).n;
  json(res, { ...channelJson(ch, admin), entries: count, admin });
});

function channelFieldsFrom(p) {
  const out = {};
  for (const k of ['name', 'description', ...FIELDS]) if (p[k] !== undefined) out[k] = String(p[k]).trim().slice(0, 255) || null;
  if (p.public !== undefined) out.public = p.public === true || p.public === 1 || p.public === '1' || p.public === 'true' ? 1 : 0;
  for (const k of ['latitude', 'longitude']) if (p[k] !== undefined) out[k] = p[k] === '' || p[k] === null ? null : Number(p[k]);
  return out;
}

route('POST', /^\/api\/channels$/, adminOnly((req, res, p) => {
  const f = channelFieldsFrom(p);
  if (!f.name) return fail(res, 400, 'Nama channel wajib diisi');
  const t = nowIso();
  const cols = Object.keys(f);
  const r = db.prepare(`INSERT INTO channels(${cols.join(',')},write_key,read_key,created_at,updated_at) VALUES(${cols.map(() => '?').join(',')},?,?,?,?)`)
    .run(...cols.map((c) => f[c]), newKey(), newKey(), t, t);
  json(res, channelJson(getChannel(r.lastInsertRowid), true), 201);
}));

route('PUT', /^\/api\/channels\/(\d+)$/, adminOnly((req, res, p, m) => {
  const ch = getChannel(m[1]);
  if (!ch) return fail(res, 404, 'Channel tidak ditemukan');
  const f = channelFieldsFrom(p);
  if ('name' in f && !f.name) return fail(res, 400, 'Nama channel wajib diisi');
  const cols = Object.keys(f);
  if (cols.length) db.prepare(`UPDATE channels SET ${cols.map((c) => c + '=?').join(',')}, updated_at=? WHERE id=?`).run(...cols.map((c) => f[c]), nowIso(), ch.id);
  json(res, channelJson(getChannel(ch.id), true));
}));

route('DELETE', /^\/api\/channels\/(\d+)$/, adminOnly((req, res, p, m) => {
  const id = Number(m[1]);
  db.prepare('DELETE FROM feeds WHERE channel_id=?').run(id);
  db.prepare('DELETE FROM reacts WHERE channel_id=?').run(id);
  db.prepare('DELETE FROM channels WHERE id=?').run(id);
  json(res, { ok: true });
}));

route('POST', /^\/api\/channels\/(\d+)\/keys$/, adminOnly((req, res, p, m) => {
  const ch = getChannel(m[1]);
  if (!ch) return fail(res, 404, 'Channel tidak ditemukan');
  const col = p.type === 'read' ? 'read_key' : 'write_key';
  db.prepare(`UPDATE channels SET ${col}=? WHERE id=?`).run(newKey(), ch.id);
  json(res, channelJson(getChannel(ch.id), true));
}));

route('DELETE', /^\/api\/channels\/(\d+)\/feeds$/, adminOnly((req, res, p, m) => {
  const ch = getChannel(m[1]);
  if (!ch) return fail(res, 404, 'Channel tidak ditemukan');
  db.prepare('DELETE FROM feeds WHERE channel_id=?').run(ch.id);
  db.prepare('UPDATE channels SET last_entry_id=0 WHERE id=?').run(ch.id);
  json(res, { ok: true });
}));

route('POST', /^\/api\/channels\/(\d+)\/import$/, adminOnly((req, res, p, m) => {
  const ch = getChannel(m[1]);
  if (!ch) return fail(res, 404, 'Channel tidak ditemukan');
  const rows = parseCsv(p._raw || p.csv || '');
  if (rows.length < 2) return fail(res, 400, 'CSV kosong. Baris pertama harus header, contoh: created_at,field1,field2');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  let n = 0;
  for (const r of rows.slice(1)) {
    const obj = {};
    header.forEach((h, i) => { if (h === 'created_at' || h === 'status' || FIELDS.includes(h)) obj[h] = r[i]; });
    const out = insertFeed(ch, obj, { skipRateLimit: true });
    if (out.row) n++;
  }
  json(res, { ok: true, imported: n });
}));

// React CRUD
route('GET', /^\/api\/channels\/(\d+)\/reacts$/, adminOnly((req, res, p, m) => {
  json(res, {
    reacts: db.prepare('SELECT * FROM reacts WHERE channel_id=? ORDER BY id').all(Number(m[1])),
    log: reactLog.filter((l) => l.channel_id === Number(m[1])),
  });
}));
route('POST', /^\/api\/channels\/(\d+)\/reacts$/, adminOnly((req, res, p, m) => {
  const ops = ['>', '>=', '<', '<=', '==', '!=', 'contains'];
  const actions = ['log', 'webhook', 'telegram'];
  const field = Number(p.field);
  if (!p.name || !(field >= 1 && field <= 8) || !ops.includes(p.op) || p.value === undefined || !actions.includes(p.action)) return fail(res, 400, 'Data React tidak lengkap');
  if (p.action === 'webhook' && !/^https?:\/\//.test(p.target || '')) return fail(res, 400, 'URL webhook harus diawali http:// atau https://');
  if (p.action === 'telegram' && !p.target) return fail(res, 400, 'Chat ID Telegram wajib diisi');
  db.prepare('INSERT INTO reacts(channel_id,name,field,op,value,mode,action,target,message) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(Number(m[1]), String(p.name), field, p.op, String(p.value), p.mode === 'every' ? 'every' : 'change', p.action, String(p.target || '-'), String(p.message || ''));
  json(res, { ok: true }, 201);
}));
route('PUT', /^\/api\/reacts\/(\d+)$/, adminOnly((req, res, p, m) => {
  db.prepare('UPDATE reacts SET enabled=? WHERE id=?').run(p.enabled ? 1 : 0, Number(m[1]));
  json(res, { ok: true });
}));
route('DELETE', /^\/api\/reacts\/(\d+)$/, adminOnly((req, res, p, m) => {
  db.prepare('DELETE FROM reacts WHERE id=?').run(Number(m[1]));
  json(res, { ok: true });
}));


// ---------------------------------------------------------------------------
// Antarmuka untuk server AwasLink
// ---------------------------------------------------------------------------
async function handle(req, res, url) {
  if (req.method === 'OPTIONS' && /^\/(update|channels\/)/.test(url.pathname)) {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type,X-THINGSPEAKAPIKEY,X-API-KEY' });
    res.end();
    return true;
  }
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (!m) continue;
    const params = await parseParams(req, url);
    await r.handler(req, res, params, m);
    return true;
  }
  return false;
}

// Catat data perangkat MQTT ke channel.
// map = { channel: 1, everySec: 15, fields: { level: 1, adc: 2, status_code: 3, jarak: 4 } }
const lastRecord = new Map();
const STATUS_CODE = { NORMAL: 0, SIAGA: 1, BAHAYA: 2, ERROR: -1 };
function recordDevice(map, values) {
  const ch = map && getChannel(map.channel);
  if (!ch) return null;
  const now = Date.now();
  if (now - (lastRecord.get(ch.id) || 0) < (map.everySec ?? 15) * 1000) return null;
  const src = { ...values };
  const st = String(src.status ?? '').toUpperCase();
  if (st in STATUS_CODE) src.status_code = STATUS_CODE[st];
  const params = {};
  for (const [key, n] of Object.entries(map.fields || {})) if (src[key] !== undefined && src[key] !== null) params['field' + n] = src[key];
  if (src.status !== undefined) params.status = src.status;
  const r = insertFeed(ch, params, { skipRateLimit: true });
  if (!r.row) return null;
  lastRecord.set(ch.id, now);
  afterInsert(ch, r.row);
  return r.row.entry_id;
}

return { handle, recordDevice, getChannel, rateLimitSec: CFG.rateLimitSec };
}
