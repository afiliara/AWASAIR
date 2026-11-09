// Simulator ESP32: meniru perilaku firmware sesuai docs/mqtt-contract.md,
// supaya backend dan dashboard bisa diuji tanpa hardware.
//
//   npm run sim                 skenario naik-turun otomatis
//   npm run sim -- --scenario=bahaya   tahan di level bahaya
//   npm run sim -- --interval=2        publish tiap 2 detik (default 5)
import mqtt from 'mqtt';
import { TOPICS, DEFAULTS, hitungStatus, kategoriHujan, validateCmd } from '../src/contract.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')),
);
const url = process.env.MQTT_URL || 'mqtt://localhost:1883';
const interval = Number(args.interval) || 5;
const scenario = args.scenario || 'siklus';

const cfg = { mute: false, siaga: DEFAULTS.siaga, bahaya: DEFAULTS.bahaya };
let level = 120;
let adc = 4095;
let status = null;
let hujanPrev = null;
let t = 0;

const client = mqtt.connect(url, {
  clientId: 'awasair-simulator',
  username: process.env.MQTT_USERNAME || undefined,
  password: process.env.MQTT_PASSWORD || undefined,
  will: { topic: TOPICS.online, payload: 'offline', qos: 1, retain: true },
  reconnectPeriod: 3000,
});

const pub = (topic, payload, opts = {}) =>
  client.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), opts);

function publishAck() {
  pub(TOPICS.ack, cfg, { qos: 1, retain: true });
}

function nextValues() {
  t += 1;
  if (scenario === 'normal') {
    level = 120 + Math.sin(t / 10) * 8;
    adc = 4095;
  } else if (scenario === 'siaga') {
    level = 215 + Math.sin(t / 8) * 4;
    adc = 2200;
  } else if (scenario === 'bahaya') {
    level = 255 + Math.sin(t / 8) * 4;
    adc = 900;
  } else if (scenario === 'error') {
    level = NaN;
    adc = 4095;
  } else {
    // siklus: naik pelan ke bahaya, lalu surut. Satu putaran sekitar 60 langkah.
    const phase = (t % 60) / 60;
    const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2; // 0 -> 1 -> 0
    level = 120 + tri * 150 + (Math.random() - 0.5) * 3;
    adc = Math.round(4095 - tri * 3300 + (Math.random() - 0.5) * 100);
  }
}

function tick() {
  nextValues();
  const hujan = (hujanPrev = kategoriHujan(adc, hujanPrev));
  const baru = hitungStatus(level, cfg, status, DEFAULTS.histeresis, hujan);
  if (baru !== status) {
    status = baru;
    pub(TOPICS.status, status, { qos: 1, retain: true });
  }
  if (Number.isFinite(level)) {
    const tinggi = DEFAULTS.tinggiPasang;
    pub(TOPICS.data, {
      level: +level.toFixed(1),
      jarak: +(tinggi - level).toFixed(1),
      adc,
      hujan,
      status,
    });
  } else {
    pub(TOPICS.data, { adc, hujan, status });
  }
  console.log(
    `${status.padEnd(6)} level=${Number.isFinite(level) ? level.toFixed(1) : '-'} adc=${adc} ${hujan}${cfg.mute ? ' [mute]' : ''}`,
  );
}

client.on('connect', () => {
  console.log(`[sim] terhubung ke ${url}, skenario=${scenario}, interval=${interval}s`);
  pub(TOPICS.online, 'online', { qos: 1, retain: true });
  client.subscribe(TOPICS.cmd, { qos: 1 });
  publishAck();
  tick();
});

client.on('message', (topic, payload) => {
  if (topic !== TOPICS.cmd) return;
  let o;
  try {
    o = JSON.parse(payload.toString());
  } catch {
    return console.log('[sim] cmd bukan JSON, ditolak');
  }
  const v = validateCmd(o);
  if (!v.ok) return console.log(`[sim] cmd ditolak: ${v.error}`);
  // Perangkat nyata juga harus memeriksa terhadap nilai yang sedang berlaku.
  const next = { ...cfg, ...v.cmd };
  if (next.siaga >= next.bahaya) return console.log('[sim] cmd ditolak: siaga >= bahaya');
  Object.assign(cfg, next);
  console.log('[sim] cmd diterapkan:', v.cmd);
  publishAck();
});

client.on('error', (e) => console.log('[sim] error:', e.message));
setInterval(() => client.connected && tick(), interval * 1000);

process.on('SIGINT', () => {
  pub(TOPICS.online, 'offline', { qos: 1, retain: true });
  setTimeout(() => process.exit(0), 200);
});
