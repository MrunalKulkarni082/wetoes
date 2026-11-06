// Online SQLite backup (safe while the app is running).
//   docker exec <app container> node dist/backup.js [keepDays]
// Writes /data/backups/wetoes-YYYY-MM-DD.db and deletes backups older than keepDays (default 14).
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { config } from './config.js';

const keepDays = Number(process.argv[2] ?? 14);
const dir = join(dirname(config.dbPath), 'backups');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = join(dir, `wetoes-${new Date().toISOString().slice(0, 10)}.db`);

const db = openDb();
await db.backup(file);
db.close();

const cutoff = Date.now() - keepDays * 86_400_000;
let removed = 0;
for (const f of readdirSync(dir)) {
  if (!/^wetoes-\d{4}-\d{2}-\d{2}\.db$/.test(f)) continue;
  const full = join(dir, f);
  if (statSync(full).mtimeMs < cutoff) { unlinkSync(full); removed++; }
}
console.log(`backup ok: ${file} (${(statSync(file).size / 1024).toFixed(0)} KB), removed ${removed} old`);
