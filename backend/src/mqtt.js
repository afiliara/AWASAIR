import mqtt from 'mqtt';
import { TOPICS, parseData } from './contract.js';

// Subscriber MQTT: menyimpan data ke DB, mendeteksi perubahan status, dan
// menyimpan keadaan terakhir di memori untuk REST API.
export function startMqtt({ config, db, notifier, log = console.log }) {
  const state = {
    connected: false, // koneksi backend ke broker
    latest: null, // data terakhir + ts
    status: null, // status terakhir dari topic `status`
    online: null, // 'online' | 'offline' | null (belum diketahui)
    ack: null, // konfigurasi yang berlaku di perangkat
  };

  const client = mqtt.connect(config.mqttUrl, {
    username: config.mqttUsername,
    password: config.mqttPassword,
    clientId: `awasair-backend-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 3000,
  });

  async function record(event) {
    db.addEvent(event.ts, event);
    await notifier.notify(event).catch((e) => log('[notif] gagal:', e.message));
  }

  client.on('connect', () => {
    state.connected = true;
    log(`[mqtt] terhubung ke ${config.mqttUrl}`);
    client.subscribe([TOPICS.data, TOPICS.status, TOPICS.online, TOPICS.ack], { qos: 1 });
  });
  client.on('close', () => {
    state.connected = false;
  });
  client.on('error', (e) => log('[mqtt] error:', e.message));

  client.on('message', async (topic, payload, packet) => {
    const text = payload.toString();
    const ts = Date.now();

    if (topic === TOPICS.data) {
      const r = parseData(text);
      if (!r) return log('[mqtt] data tidak sesuai kontrak, diabaikan:', text.slice(0, 120));
      state.latest = { ...r, ts };
      db.addReading(ts, r);
      return;
    }

    if (topic === TOPICS.status) {
      const prev = state.status;
      state.status = text;
      // Pesan retained = replay saat subscribe, bukan perubahan baru: jangan jadikan alert.
      if (packet.retain || prev === text) return;
      const lvl = state.latest?.level ?? null;
      await record({
        ts,
        type: 'status',
        value: text,
        prev,
        level: lvl,
        message: `Status berubah ${prev ?? '?'} → ${text}${lvl != null ? ` (level ${lvl} cm)` : ''}`,
      });
      return;
    }

    if (topic === TOPICS.online) {
      const prev = state.online;
      state.online = text;
      if (packet.retain || prev === text) return;
      await record({
        ts,
        type: 'online',
        value: text,
        prev,
        message: text === 'online' ? 'Sensor terhubung kembali' : 'Sensor offline',
      });
      return;
    }

    if (topic === TOPICS.ack) {
      try {
        state.ack = JSON.parse(text);
      } catch {
        log('[mqtt] ack bukan JSON:', text.slice(0, 120));
      }
    }
  });

  return {
    state,
    publishCmd: (cmd) =>
      new Promise((resolve, reject) => {
        client.publish(TOPICS.cmd, JSON.stringify(cmd), { qos: 1 }, (err) =>
          err ? reject(err) : resolve(),
        );
      }),
    stop: () => new Promise((resolve) => client.end(false, {}, resolve)),
  };
}
