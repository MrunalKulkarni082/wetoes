import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireUser, type User } from '../auth.js';
import { now, type DB } from '../db.js';
import type { Item, PickContext, Picker } from '../picker.js';
import { LlmBusyError, LlmLimitError, type Llm } from '../llm.js';
import { moodPrompt, validateMood, validateWhy, whyPrompt } from '../prompts.js';
import { BUDGETS, CATEGORIES, MOODS, clampText } from '../util.js';

const GENRES = ['kpop', 'hiphop', 'classical', 'lofi', 'bollywood', 'indie', 'jazz', 'afrobeats', 'rnb', 'rock', 'electronic', 'punjabi', 'tamil', 'telugu', 'sufi', 'indiepop'];

interface EventRow {
  id: number;
  user_id: number;
  item_id: string | null;
  category: string;
  action: string;
  context: string;
  created_at: number;
}

export const publicItem = (i: Item) => ({
  id: i.id,
  category: i.category,
  title: i.title,
  why: i.why,
  budget: i.budget,
  genre: i.genre,
  data: i.data,
});

export function llmErrorReply(reply: FastifyReply, e: unknown) {
  if (e instanceof LlmLimitError) return reply.code(429).send({ error: 'llm_daily_limit' });
  if (e instanceof LlmBusyError) return reply.code(503).send({ error: 'llm_busy' });
  return reply.code(503).send({ error: 'llm_unavailable' });
}

export function pickRoutes(app: FastifyInstance, db: DB, picker: Picker, llm: Llm) {
  const q = {
    insertEvent: db.prepare(
      'INSERT INTO events (user_id, item_id, category, action, context, ref_event, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    event: db.prepare<[number, number], EventRow>('SELECT * FROM events WHERE id = ? AND user_id = ?'),
    resolution: db.prepare<[number], { action: string; id: number; created_at: number }>(
      'SELECT action, id, created_at FROM events WHERE ref_event = ? ORDER BY id DESC LIMIT 1',
    ),
    servedCount: db.prepare<[number], { n: number }>("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND action = 'served'"),
    weekVetoes: db.prepare<[number, number], { n: number }>(
      "SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND action = 'vetoed' AND created_at > ?",
    ),
    recentTitles: db.prepare<[number, string, string], { title: string }>(
      `SELECT i.title FROM events e JOIN items i ON i.id = e.item_id
       WHERE e.user_id = ? AND e.category = ? AND e.action = ? ORDER BY e.id DESC LIMIT 4`,
    ),
  };

  function serve(user: User, ctx: PickContext, exclude: string[] = []) {
    const item = picker.pick(user, ctx, exclude);
    if (!item) return null;
    const info = q.insertEvent.run(user.id, item.id, ctx.category, 'served', JSON.stringify(ctx), null, now());
    return {
      event_id: Number(info.lastInsertRowid),
      n: q.servedCount.get(user.id)?.n ?? 0,
      week_vetoes: q.weekVetoes.get(user.id, now() - 7 * 86_400_000)?.n ?? 0,
      item: publicItem(item),
    };
  }

  /** Loads a served event owned by the user that hasn't been kept/vetoed yet. */
  function openServed(user: User, id: number, reply: FastifyReply): EventRow | null {
    const ev = q.event.get(id, user.id);
    if (!ev || ev.action !== 'served') {
      reply.code(404).send({ error: 'not_found' });
      return null;
    }
    const res = q.resolution.get(ev.id);
    if (res && res.action !== 'undone') {
      reply.code(409).send({ error: 'already_decided' });
      return null;
    }
    return ev;
  }

  const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } as const;

  app.post<{ Body: PickContext }>(
    '/api/pick',
    {
      schema: {
        body: {
          type: 'object',
          required: ['category'],
          additionalProperties: false,
          properties: {
            category: { type: 'string', enum: CATEGORIES.filter((c) => c !== 'say') },
            mood: { type: ['string', 'null'], enum: [...MOODS, null] },
            budget: { type: ['string', 'null'], enum: [...BUDGETS, null] },
            genre: { type: ['string', 'null'], enum: [...GENRES, null] },
          },
        },
      },
    },
    async (req, reply) => {
      const u = requireUser(req, reply);
      if (!u) return;
      const out = serve(u, req.body);
      if (!out) return reply.code(404).send({ error: 'nothing_to_pick' });
      return out;
    },
  );

  app.post<{ Params: { id: number } }>('/api/events/:id/veto', { schema: { params: idParam } }, async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const ev = openServed(u, req.params.id, reply);
    if (!ev) return;
    q.insertEvent.run(u.id, ev.item_id, ev.category, 'vetoed', ev.context, ev.id, now());
    const out = serve(u, JSON.parse(ev.context) as PickContext, ev.item_id ? [ev.item_id] : []);
    if (!out) return reply.code(404).send({ error: 'nothing_to_pick' });
    return { vetoed: ev.item_id ? picker.byId(ev.item_id)?.title : null, ...out };
  });

  app.post<{ Params: { id: number } }>('/api/events/:id/keep', { schema: { params: idParam } }, async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const ev = openServed(u, req.params.id, reply);
    if (!ev) return;
    q.insertEvent.run(u.id, ev.item_id, ev.category, 'kept', ev.context, ev.id, now());
    return { ok: true };
  });

  // Undo a "yes" within 60 seconds.
  app.post<{ Params: { id: number } }>('/api/events/:id/undo', { schema: { params: idParam } }, async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const ev = q.event.get(req.params.id, u.id);
    const res = ev ? q.resolution.get(ev.id) : undefined;
    if (!ev || !res || res.action !== 'kept') return reply.code(404).send({ error: 'nothing_to_undo' });
    if (now() - res.created_at > 60_000) return reply.code(409).send({ error: 'too_late' });
    q.insertEvent.run(u.id, ev.item_id, ev.category, 'undone', ev.context, ev.id, now());
    return { ok: true };
  });

  // Personalised "why" line, fetched after the card renders (never blocks the pick).
  app.get<{ Params: { id: number } }>(
    '/api/events/:id/why',
    { schema: { params: idParam }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const u = requireUser(req, reply);
      if (!u) return;
      const ev = q.event.get(req.params.id, u.id);
      const item = ev?.item_id ? picker.byId(ev.item_id) : null;
      if (!ev || !item) return reply.code(404).send({ error: 'not_found' });
      const kept = q.recentTitles.all(u.id, ev.category, 'kept').map((r) => r.title);
      const vetoed = q.recentTitles.all(u.id, ev.category, 'vetoed').map((r) => r.title);
      // With no history, the curated line is better than anything generated.
      if (kept.length + vetoed.length < 2) return { why: item.why, personal: false };
      const ctx = JSON.parse(ev.context) as PickContext;
      try {
        const out = await llm.json({
          userId: u.id,
          temperature: 0.6,
          cacheKey: `why|${item.id}|${ctx.mood}|${kept.join(',')}|${vetoed.join(',')}`,
          messages: whyPrompt({ title: item.title, category: item.category, baseWhy: item.why, mood: ctx.mood ?? null, kept, vetoed }),
          validate: validateWhy,
        });
        return { why: out.why, personal: true };
      } catch {
        return { why: item.why, personal: false };
      }
    },
  );

  app.post<{ Body: { text: string } }>(
    '/api/mood/parse',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', maxLength: 300 } } },
      },
    },
    async (req, reply) => {
      const u = requireUser(req, reply);
      if (!u) return;
      const text = clampText(req.body.text, 300);
      if (text.length < 2) return reply.code(400).send({ error: 'too_short' });
      try {
        return await llm.json({ userId: u.id, temperature: 0.2, cacheKey: `mood|${text.toLowerCase()}`, messages: moodPrompt(text), validate: validateMood });
      } catch (e) {
        return llmErrorReply(reply, e);
      }
    },
  );

  app.get('/api/memory', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const log = db
      .prepare<[number, number], { id: number; ref_event: number; category: string; action: string; created_at: number; title: string | null; draft: string | null }>(
        `SELECT e.id, e.ref_event, e.category, e.action, e.created_at, i.title,
                (SELECT d.text FROM drafts d WHERE d.id = json_extract(e.context, '$.draft_id') AND d.user_id = e.user_id) AS draft
         FROM events e LEFT JOIN items i ON i.id = e.item_id
         WHERE e.user_id = ? AND e.action IN ('kept','vetoed','undone') ORDER BY e.id DESC LIMIT ?`,
      )
      .all(u.id, 60);
    // Drop "kept" rows that were later undone.
    const undone = new Set(log.filter((l) => l.action === 'undone').map((l) => l.ref_event));
    const rows = log
      .filter((l) => l.action !== 'undone' && !(l.action === 'kept' && undone.has(l.ref_event)))
      .map((l) => ({ name: l.title ?? l.draft ?? 'a draft', category: l.category, action: l.action, ts: l.created_at }));
    const last: Record<string, { name: string; action: string }> = {};
    for (const r of rows) last[r.category] ??= { name: r.name, action: r.action };
    const c = db
      .prepare<[number], { kept: number; vetoed: number }>(
        `SELECT COALESCE(SUM(action = 'kept'), 0) - COALESCE(SUM(action = 'undone'), 0) AS kept, COALESCE(SUM(action = 'vetoed'), 0) AS vetoed FROM events WHERE user_id = ?`,
      )
      .get(u.id)!;
    return { kept: c.kept, vetoed: c.vetoed, recent: rows.slice(0, 24), last };
  });
}
