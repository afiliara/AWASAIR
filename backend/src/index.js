import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb } from './db.js';
import { startMqtt } from './mqtt.js';
import { createNotifier } from './notifier.js';
import { createApp } from './api.js';

const db = openDb(config.dbPath);
const mq = startMqtt({ config, db, notifier: createNotifier() });

const staticDir = fileURLToPath(new URL('../../frontend', import.meta.url));
const app = createApp({ config, db, state: mq.state, publishCmd: mq.publishCmd, staticDir });
const server = app.listen(config.port, () => {
  console.log(`[http] http://localhost:${config.port}  (dashboard + /api)`);
});

const prune = () => db.prune(Date.now() - config.retentionDays * 86_400_000);
prune();
const pruneTimer = setInterval(prune, 3_600_000);

async function shutdown() {
  clearInterval(pruneTimer);
  server.close();
  await mq.stop();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
