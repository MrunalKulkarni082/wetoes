// Idempotent catalog loader: upserts every seed/*.json item by id. Safe to run on every boot.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from './db.js';
import { CATEGORIES, MOODS, BUDGETS } from './util.js';

interface SeedItem {
  id: string;
  category: string;
  title: string;
  why?: string;
  moods?: string[];
  diet?: string[];
  budget?: string | null;
  genre?: string | null;
  city?: string;
  data?: Record<string, unknown>;
  active?: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));

export function seed(db: DB, dir = join(here, '..', 'seed')) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const up = db.prepare(`
    INSERT INTO items (id, category, title, why, moods, diet, budget, genre, city, data, active)
    VALUES (@id, @category, @title, @why, @moods, @diet, @budget, @genre, @city, @data, @active)
    ON CONFLICT(id) DO UPDATE SET category=excluded.category, title=excluded.title, why=excluded.why, moods=excluded.moods,
      diet=excluded.diet, budget=excluded.budget, genre=excluded.genre, city=excluded.city, data=excluded.data, active=excluded.active`);
  let n = 0;
  const seen = new Set<string>();
  const tx = db.transaction((items: SeedItem[], file: string) => {
    for (const it of items) {
      if (seen.has(it.id)) throw new Error(`${file}: duplicate id ${it.id}`);
      seen.add(it.id);
      if (!CATEGORIES.includes(it.category as never)) throw new Error(`${file}: ${it.id} bad category`);
      for (const m of it.moods ?? []) if (!MOODS.includes(m as never)) throw new Error(`${file}: ${it.id} bad mood ${m}`);
      if (it.budget && !BUDGETS.includes(it.budget as never)) throw new Error(`${file}: ${it.id} bad budget`);
      up.run({
        id: it.id,
        category: it.category,
        title: it.title,
        why: it.why ?? '',
        moods: JSON.stringify(it.moods ?? []),
        diet: JSON.stringify(it.diet ?? []),
        budget: it.budget ?? null,
        genre: it.genre ?? null,
        city: it.city ?? 'any',
        data: JSON.stringify(it.data ?? {}),
        active: it.active === false ? 0 : 1,
      });
      n++;
    }
  });
  for (const f of files) tx(JSON.parse(readFileSync(join(dir, f), 'utf8')) as SeedItem[], f);
  return n;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const db = openDb();
  const n = seed(db);
  const counts = db.prepare('SELECT category, COUNT(*) AS n FROM items WHERE active = 1 GROUP BY category').all();
  console.log(`[seed] upserted ${n} items`, counts);
  db.close();
}
