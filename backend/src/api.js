import express from 'express';
import { validateCmd } from './contract.js';

export function createApp({ config, db, state, publishCmd, staticDir }) {
  const app = express();
  app.use(express.json({ limit: '10kb' }));

  // CORS longgar: dashboard boleh dibuka dari file:// atau host lain saat pengembangan.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, mqtt: state.connected, time: Date.now() });
  });

  // Keadaan terkini. `stale` true bila data terakhir lebih tua dari batas:
  // dashboard harus menampilkannya sebagai "tidak ada data", bukan sebagai aman.
  app.get('/api/state', (_req, res) => {
    const now = Date.now();
    const age = state.latest ? (now - state.latest.ts) / 1000 : null;
    res.json({
      time: now,
      mqtt: state.connected,
      online: state.online,
      status: state.status,
      latest: state.latest,
      ack: state.ack,
      ageSeconds: age,
      stale: age === null || age > config.staleSeconds,
    });
  });

  app.get('/api/readings', (req, res) => {
    const minutes = Math.min(Math.max(Number(req.query.minutes) || 60, 1), 60 * 24 * 30);
    const limit = Math.min(Math.max(Number(req.query.limit) || 2000, 1), 10000);
    res.json(db.readings(Date.now() - minutes * 60_000, limit));
  });

  app.get('/api/events', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    res.json(db.events(limit));
  });

  app.post('/api/cmd', async (req, res) => {
    if (config.apiKey && req.get('X-API-Key') !== config.apiKey) {
      return res.status(401).json({ error: 'API key salah' });
    }
    const v = validateCmd(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    try {
      await publishCmd(v.cmd);
      // Nilai yang berlaku tetap menunggu `ack` dari perangkat.
      res.status(202).json({ sent: v.cmd });
    } catch (e) {
      res.status(502).json({ error: `Gagal publish: ${e.message}` });
    }
  });

  if (staticDir) app.use(express.static(staticDir));
  return app;
}
