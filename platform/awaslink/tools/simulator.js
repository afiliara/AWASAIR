// Simulator ESP32 AWASAIR untuk AwasLink, mengikuti docs/mqtt-contract.md.
// Data otomatis ikut tercatat di Data Logger (channel 1) oleh server.
// Logika status/histeresis sama dengan backend/src/contract.js dan firmware.
//
//   node tools/simulator.js --token <TOKEN_AWASLINK>
//
// Opsi: --host localhost --port 1883 --topic awasair/sungai --interval 5
//       --scenario siklus|normal|siaga|bahaya|error
import mqtt from 'mqtt';

const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (!a.startsWith('--')) return;
  const [k, v] = a.slice(2).split('=');
  args[k] = v ?? (arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true');
});

const HOST = args.host || 'localhost';
const PORT = Number(args.port || 1883);
const TOKEN = args.token || process.env.AWASLINK_TOKEN;
const BASE = args.topic || 'awasair/sungai';
const INTERVAL = Number(args.interval || 5);
const SCENARIO = args.scenario || 'siklus';
const TINGGI_PASANG = 300; const HIST = 5;

if (!TOKEN) { console.error('Wajib isi --token <auth token perangkat dari AwasLink>'); process.exit(1); }

const T = { data: `${BASE}/data`, status: `${BASE}/status`, online: `${BASE}/online`, cmd: `${BASE}/cmd`, ack: `${BASE}/ack` };
const cfg = { mute: false, siaga: 200, bahaya: 240 }; // konfigurasi yang berlaku di "alat"
let status = null; let level = 120; let adc = 4095; let t = 0;

const kategoriHujan = (a) => (a >= 4000 ? 'kering' : a >= 2500 ? 'ringan' : a >= 1500 ? 'sedang' : 'lebat');

// Naik langsung, turun bertahap satu tingkat dengan histeresis (sama dengan contract.js)
function hitungStatus(lv, prev) {
  if (!Number.isFinite(lv)) return 'ERROR';
  const rank = { NORMAL: 0, SIAGA: 1, BAHAYA: 2 }; const nama = ['NORMAL', 'SIAGA', 'BAHAYA'];
  let cur = rank[prev] ?? 0;
  const naik = lv >= cfg.bahaya ? 2 : lv >= cfg.siaga ? 1 : 0;
  if (naik >= cur) return nama[naik];
  while (cur > 0) { if (lv < (cur === 2 ? cfg.bahaya : cfg.siaga) - HIST) cur--; else break; }
  return nama[cur];
}

function nextValues() {
  t += 1;
  if (SCENARIO === 'normal') { level = 120 + Math.sin(t / 10) * 8; adc = 4095; }
  else if (SCENARIO === 'siaga') { level = 215 + Math.sin(t / 8) * 4; adc = 2200; }
  else if (SCENARIO === 'bahaya') { level = 255 + Math.sin(t / 8) * 4; adc = 900; }
  else if (SCENARIO === 'error') { level = NaN; adc = 4095; }
  else {
    const phase = (t % 60) / 60; const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
    level = 120 + tri * 150 + (Math.random() - 0.5) * 3;
    adc = Math.round(Math.min(4095, Math.max(0, 4095 - tri * 3300 + (Math.random() - 0.5) * 100)));
  }
}

const client = mqtt.connect(`mqtt://${HOST}:${PORT}`, {
  clientId: 'awasair-sim-' + Math.random().toString(16).slice(2, 8),
  username: 'device', password: TOKEN,
  will: { topic: T.online, payload: 'offline', qos: 1, retain: true },
  reconnectPeriod: 3000,
});
const pub = (topic, payload, opts = {}) => client.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), opts);

client.on('connect', () => {
  console.log(`[sim] terhubung ke mqtt://${HOST}:${PORT}, topic ${BASE}, skenario ${SCENARIO}`);
  pub(T.online, 'online', { qos: 1, retain: true });
  client.subscribe(T.cmd, { qos: 1 });
  pub(T.ack, cfg, { qos: 1, retain: true }); // kontrak: ack dikirim sekali saat boot
  tick();
});
client.on('error', (e) => console.error('[sim] error:', e.message));

client.on('message', (topic, payload) => {
  let o; try { o = JSON.parse(payload.toString()); } catch { return console.log('[sim] cmd bukan JSON, ditolak'); }
  const next = { ...cfg };
  if ('mute' in o) { if (typeof o.mute !== 'boolean') return console.log('[sim] cmd ditolak: mute harus boolean'); next.mute = o.mute; }
  for (const k of ['siaga', 'bahaya']) if (k in o) { if (typeof o[k] !== 'number' || o[k] <= 0) return console.log(`[sim] cmd ditolak: ${k}`); next[k] = o[k]; }
  if (next.siaga >= next.bahaya) return console.log('[sim] cmd ditolak: siaga >= bahaya');
  Object.assign(cfg, next);
  console.log('[sim] cmd diterapkan:', o);
  pub(T.ack, cfg, { qos: 1, retain: true });
});

function tick() {
  if (!client.connected) return;
  nextValues();
  const hujan = kategoriHujan(adc);
  const baru = hitungStatus(level, status);
  if (baru !== status) { status = baru; pub(T.status, status, { qos: 1, retain: true }); }
  if (Number.isFinite(level)) pub(T.data, { level: +level.toFixed(1), jarak: +(TINGGI_PASANG - level).toFixed(1), adc, hujan, status });
  else pub(T.data, { adc, hujan, status });
  console.log(`[sim] ${status.padEnd(6)} level=${Number.isFinite(level) ? level.toFixed(1) : '-'} adc=${adc} ${hujan}${cfg.mute ? ' [mute]' : ''}`);

}
setInterval(tick, INTERVAL * 1000);

process.on('SIGINT', () => { pub(T.online, 'offline', { qos: 1, retain: true }); setTimeout(() => process.exit(0), 200); });
