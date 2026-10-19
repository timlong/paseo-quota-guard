import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (key TEXT PRIMARY KEY, body TEXT NOT NULL, attempts INTEGER DEFAULT 0, next_at INTEGER DEFAULT 0, status TEXT DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, time INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  load() { return new Map(this.db.prepare('SELECT id,body FROM state').all().map(r => [r.id, JSON.parse(r.body)])); }
  save(a) { this.db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(a.id, JSON.stringify(a)); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  enqueue(key, payload, now) {
    this.db.prepare('INSERT OR IGNORE INTO outbox(key,body,next_at) VALUES (?,?,?)').run(key, JSON.stringify(payload), now);
  }
  pending(now) { return this.db.prepare("SELECT * FROM outbox WHERE status='pending' AND next_at<=? ORDER BY rowid LIMIT 20").all(now); }
  complete(key) { this.db.prepare("UPDATE outbox SET status='submitted' WHERE key=?").run(key); }
  retry(key, attempts, now) {
    this.db.prepare('UPDATE outbox SET attempts=?, next_at=? WHERE key=?').run(attempts, now + Math.min(3600000, 30000 * 2 ** Math.min(attempts, 7)), key);
  }
  audit(kind, body, now) { this.db.prepare('INSERT INTO audit(time,kind,body) VALUES (?,?,?)').run(now, kind, JSON.stringify(body)); }
  events() { return this.db.prepare('SELECT time,kind,body FROM audit ORDER BY seq DESC LIMIT 50').all().map(r => ({ ...r, body: JSON.parse(r.body) })); }
  getMeta(key) { const r = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return r ? JSON.parse(r.value) : undefined; }
  setMeta(key, value) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  close() { this.db.close(); }
}
