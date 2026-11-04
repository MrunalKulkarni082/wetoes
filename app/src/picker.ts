import { now, type DB } from './db.js';
import type { User } from './auth.js';
import { BUDGETS, type Budget, type Category, type Mood } from './util.js';

export interface ItemRow {
  id: string;
  category: Category;
  title: string;
  why: string;
  moods: string;
  diet: string;
  budget: Budget | null;
  genre: string | null;
  city: string;
  data: string;
}

export interface Item {
  id: string;
  category: Category;
  title: string;
  why: string;
  moods: string[];
  diet: string[];
  budget: Budget | null;
  genre: string | null;
  city: string;
  data: Record<string, unknown>;
}

export interface PickContext {
  category: Category;
  mood?: Mood | null;
  budget?: Budget | null;
  genre?: string | null;
}

export function toItem(r: ItemRow): Item {
  return {
    ...r,
    moods: JSON.parse(r.moods) as string[],
    diet: JSON.parse(r.diet) as string[],
    data: JSON.parse(r.data) as Record<string, unknown>,
  };
}

const DAY = 86_400_000;

/**
 * Picks ONE item. Hard constraints (diet, genre, budget, city) filter; soft signals score:
 *  + mood match
 *  + kept this item before (a little — we don't want reruns forever)
 *  - vetoed this item (strong, decays over ~2 weeks)
 *  - vetoed things in the same genre/budget recently (weak)
 *  - served very recently (excluded outright for the last 12 serves in the category)
 * Then a weighted random draw so it never feels like a fixed list.
 */
export function makePicker(db: DB) {
  const q = {
    byCategory: db.prepare<[string], ItemRow>('SELECT * FROM items WHERE category = ? AND active = 1'),
    byId: db.prepare<[string], ItemRow>('SELECT * FROM items WHERE id = ?'),
    recentServed: db.prepare<[number, string], { item_id: string }>(
      `SELECT item_id FROM events WHERE user_id = ? AND category = ? AND action = 'served'
       ORDER BY id DESC LIMIT 12`,
    ),
    history: db.prepare<[number, string, number], { item_id: string; action: string; created_at: number }>(
      `SELECT item_id, action, created_at FROM events
       WHERE user_id = ? AND category = ? AND action IN ('kept','vetoed') AND created_at > ?`,
    ),
  };

  function eligible(item: Item, user: User, ctx: PickContext, strict: boolean): boolean {
    if (item.category === 'eat') {
      if (user.diet === 'veg' && !item.diet.some((d) => d === 'veg' || d === 'vegan')) return false;
      if (user.diet === 'vegan' && !item.diet.includes('vegan')) return false;
      if (item.city !== 'any' && item.city !== user.city) return false;
    }
    if (item.category === 'listen' && ctx.genre && item.genre !== ctx.genre) return false;
    if (!strict) return true;
    if (ctx.budget && item.budget && BUDGETS.indexOf(item.budget) > BUDGETS.indexOf(ctx.budget)) return false;
    return true;
  }

  function pick(user: User, ctx: PickContext, excludeIds: string[] = []): Item | null {
    const all = q.byCategory.all(ctx.category).map(toItem);
    const recent = new Set(q.recentServed.all(user.id, ctx.category).map((r) => r.item_id));
    for (const id of excludeIds) recent.add(id);

    const t = now();
    const hist = q.history.all(user.id, ctx.category, t - 60 * DAY);
    const itemsById = new Map(all.map((i) => [i.id, i]));
    const itemVeto = new Map<string, number>();
    const itemKeep = new Map<string, number>();
    const genreVeto = new Map<string, number>();
    for (const h of hist) {
      const decay = Math.exp(-(t - h.created_at) / (14 * DAY));
      if (h.action === 'vetoed') {
        itemVeto.set(h.item_id, (itemVeto.get(h.item_id) ?? 0) + decay);
        const g = itemsById.get(h.item_id)?.genre;
        if (g) genreVeto.set(g, (genreVeto.get(g) ?? 0) + decay);
      } else {
        itemKeep.set(h.item_id, (itemKeep.get(h.item_id) ?? 0) + decay);
      }
    }

    // Progressive relaxation: strict & unseen → loose & unseen → loose & anything.
    let pool = all.filter((i) => eligible(i, user, ctx, true) && !recent.has(i.id));
    if (pool.length === 0) pool = all.filter((i) => eligible(i, user, ctx, false) && !recent.has(i.id));
    if (pool.length === 0) pool = all.filter((i) => eligible(i, user, ctx, false) && !excludeIds.includes(i.id));
    if (pool.length === 0) return null;

    const scores = pool.map((i) => {
      let s = 0;
      if (ctx.mood && i.moods.includes(ctx.mood)) s += 1.2;
      s += 0.4 * Math.min(itemKeep.get(i.id) ?? 0, 2);
      s -= 2.0 * (itemVeto.get(i.id) ?? 0);
      if (i.genre) s -= 0.25 * Math.min(genreVeto.get(i.genre) ?? 0, 4);
      return Math.exp(s);
    });
    const total = scores.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let k = 0; k < pool.length; k++) {
      r -= scores[k]!;
      if (r <= 0) return pool[k]!;
    }
    return pool[pool.length - 1]!;
  }

  return { pick, byId: (id: string) => {
    const r = q.byId.get(id);
    return r ? toItem(r) : null;
  } };
}

export type Picker = ReturnType<typeof makePicker>;
