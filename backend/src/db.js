import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS readings (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      ts     INTEGER NOT NULL,           -- epoch ms, dari backend
      level  REAL,
      jarak  REAL,
      adc    INTEGER,
      hujan  TEXT,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);
    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      type    TEXT NOT NULL,             -- 'status' | 'online'
      value   TEXT NOT NULL,             -- status baru / online|offline
      prev    TEXT,
      level   REAL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  `);

  const insReading = db.prepare(
    'INSERT INTO readings (ts, level, jarak, adc, hujan, status) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insEvent = db.prepare(
    'INSERT INTO events (ts, type, value, prev, level, message) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const selReadings = db.prepare(
    'SELECT ts, level, jarak, adc, hujan, status FROM readings WHERE ts >= ? ORDER BY ts DESC LIMIT ?',
  );
  const selEvents = db.prepare(
    'SELECT id, ts, type, value, prev, level, message FROM events ORDER BY ts DESC, id DESC LIMIT ?',
  );
  const delReadings = db.prepare('DELETE FROM readings WHERE ts < ?');
  const delEvents = db.prepare('DELETE FROM events WHERE ts < ?');

  return {
    raw: db,
    addReading: (ts, r) => insReading.run(ts, r.level, r.jarak, r.adc, r.hujan, r.status),
    addEvent: (ts, e) => insEvent.run(ts, e.type, e.value, e.prev ?? null, e.level ?? null, e.message),
    // Urut naik (lama ke baru), siap dipakai grafik.
    readings: (sinceTs, limit = 2000) => selReadings.all(sinceTs, limit).reverse(),
    events: (limit = 50) => selEvents.all(limit),
    prune: (olderThanTs) => {
      delReadings.run(olderThanTs);
      delEvents.run(olderThanTs);
    },
    close: () => db.close(),
  };
}
