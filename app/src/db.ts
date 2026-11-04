import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));

export type DB = Database.Database;

export function openDb(path = config.dbPath): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

/** Additive migrations for databases created by older versions. */
function migrate(db: DB) {
  const cols = (t: string) => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols('users').has('password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
}

export const now = () => Date.now();
