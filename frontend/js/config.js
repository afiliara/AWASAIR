// Satu tempat untuk pengaturan dashboard.
const host = location.hostname || 'localhost';

export const CONFIG = {
  // Broker MQTT lewat WebSocket. Dev: broker lokal (npm run broker). Produksi: wss://domain/mqtt
  mqttUrl: `ws://${host}:9001`,
  mqttUsername: '',
  mqttPassword: '',

  // Backend REST. Kosong = satu origin dengan halaman (dilayani oleh backend).
  // Dibuka langsung dari file:// -> arahkan ke backend lokal.
  apiBase: location.protocol === 'file:' ? 'http://localhost:3000' : '',
  apiKey: '',

  topicBase: 'awasair/sungai',
  lokasi: 'Sungai (isi nama lokasi dan koordinat sensor)',

  // Nilai awal sebelum perangkat mengirim `ack`. Samakan dengan docs/mqtt-contract.md.
  defaultSiaga: 200,
  defaultBahaya: 240,

  // Data lebih tua dari ini dianggap basi, bukan aman.
  staleSeconds: 30,
  // Peringatan kewaspadaan: level sudah dalam jarak ini dari ambang Siaga dan hujan lebat.
  waspadaMarginCm: 20,
};
