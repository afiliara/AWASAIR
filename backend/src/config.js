import 'dotenv/config';

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  mqttUrl: process.env.MQTT_URL || 'mqtt://localhost:1883',
  mqttUsername: process.env.MQTT_USERNAME || undefined,
  mqttPassword: process.env.MQTT_PASSWORD || undefined,
  port: num(process.env.PORT, 3000),
  dbPath: process.env.DB_PATH || './data/awasair.db',
  // Kosong = POST /api/cmd terbuka (hanya untuk pengembangan lokal).
  apiKey: process.env.API_KEY || '',
  // Data lebih lama dari ini dianggap basi oleh dashboard.
  staleSeconds: num(process.env.STALE_SECONDS, 30),
  retentionDays: num(process.env.RETENTION_DAYS, 30),
};
