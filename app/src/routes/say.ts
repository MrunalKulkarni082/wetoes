import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireUser, type User } from '../auth.js';
import { now, type DB } from '../db.js';
import { LlmLimitError, type Llm } from '../llm.js';
import { ENABLED_LANGS, RECIPIENTS, TONES, sayPrompt, validateDraft, type Lang, type Recipient, type Tone } from '../prompts.js';
import { toItem, type ItemRow } from '../picker.js';
import { clampText } from '../util.js';
import { llmErrorReply } from './picks.js';

interface SayBody {
  to: Recipient;
  about: string;
  tone: Tone;
  lang: Lang;
}

export function sayRoutes(app: FastifyInstance, db: DB, llm: Llm) {
  const q = {
    insertDraft: db.prepare('INSERT INTO drafts (user_id, recipient, about, tone, lang, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    insertEvent: db.prepare(
      'INSERT INTO events (user_id, item_id, category, action, context, ref_event, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    draft: db.prepare<[number, number], { id: number; recipient: Recipient; about: string; tone: Tone; lang: Lang; text: string }>(
      'SELECT * FROM drafts WHERE id = ? AND user_id = ?',
    ),
    event: db.prepare<[number, number], { id: number; action: string; context: string }>(
      "SELECT id, action, context FROM events WHERE id = ? AND user_id = ? AND category = 'say'",
    ),
    resolved: db.prepare<[number], { action: string }>("SELECT action FROM events WHERE ref_event = ? AND action IN ('kept','vetoed') LIMIT 1"),
    templates: db.prepare<[], ItemRow>("SELECT * FROM items WHERE category = 'say' AND active = 1"),
  };

  /** Offline fallback: a hand-written template for this recipient (keeps the app useful if the LLM is down). */
  function template(to: Recipient, avoid?: string): { text: string; tone: Tone } | null {
    const all = q.templates.all().map(toItem);
    const group: Record<string, string[]> = { ma: ['ma', 'parent'], papa: ['parent'], parents: ['parent', 'ma'], sibling: ['sister', 'sibling'] };
    const keys = group[to] ?? [to];
    const pool = all.filter((i) => keys.includes(String(i.data.to)) && i.title !== avoid);
    const pickFrom = pool.length ? pool : all.filter((i) => String(i.data.to) === 'self');
    const t = pickFrom[Math.floor(Math.random() * pickFrom.length)];
    return t ? { text: t.title, tone: (String(t.data.tone) as Tone) || 'warm' } : null;
  }

  async function generate(user: User, b: SayBody, reply: FastifyReply, avoid?: string) {
    let text: string;
    let tone = b.tone;
    let source: 'llm' | 'template' = 'llm';
    try {
      const out = await llm.json({
        userId: user.id,
        // Hinglish degrades fast at high temperature on a 7B model.
        temperature: b.lang === 'hinglish' ? (avoid ? 0.6 : 0.45) : avoid ? 0.9 : 0.75,
        cacheKey: avoid ? undefined : `say|${b.to}|${b.tone}|${b.lang}|${b.about.toLowerCase()}`,
        messages: sayPrompt({ ...b, avoid }),
        validate: validateDraft,
      });
      text = out.draft;
    } catch (e) {
      if (e instanceof LlmLimitError) return llmErrorReply(reply, e);
      const t = template(b.to, avoid);
      if (!t) return llmErrorReply(reply, e);
      text = t.text;
      tone = t.tone;
      source = 'template';
    }
    const d = q.insertDraft.run(user.id, b.to, b.about, tone, b.lang, text, now());
    const draftId = Number(d.lastInsertRowid);
    const ev = q.insertEvent.run(user.id, null, 'say', 'served', JSON.stringify({ draft_id: draftId, to: b.to, tone, lang: b.lang }), null, now());
    const n = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND action = 'served'").get(user.id) as { n: number }).n;
    return { event_id: Number(ev.lastInsertRowid), draft_id: draftId, n, text, to: b.to, tone, lang: b.lang, source };
  }

  const llmLimit = { rateLimit: { max: 12, timeWindow: '1 minute' } };

  app.post<{ Body: SayBody }>(
    '/api/say',
    {
      config: llmLimit,
      schema: {
        body: {
          type: 'object',
          required: ['to', 'about', 'tone', 'lang'],
          additionalProperties: false,
          properties: {
            to: { type: 'string', enum: [...RECIPIENTS] },
            about: { type: 'string', minLength: 2, maxLength: 500 },
            tone: { type: 'string', enum: [...TONES] },
            lang: { type: 'string', enum: [...ENABLED_LANGS] },
          },
        },
      },
    },
    async (req, reply) => {
      const u = requireUser(req, reply);
      if (!u) return;
      const about = clampText(req.body.about, 500);
      if (about.length < 2) return reply.code(400).send({ error: 'too_short' });
      return generate(u, { ...req.body, about }, reply);
    },
  );

  // Veto a draft → log it and write a clearly different one (optionally in a new tone).
  app.post<{ Params: { id: number }; Body: { tone?: Tone } }>(
    '/api/say/:id/veto',
    {
      config: llmLimit,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } },
        body: { type: ['object', 'null'], additionalProperties: false, properties: { tone: { type: 'string', enum: [...TONES] } } },
      },
    },
    async (req, reply) => {
      const u = requireUser(req, reply);
      if (!u) return;
      const ev = q.event.get(req.params.id, u.id);
      if (!ev || ev.action !== 'served') return reply.code(404).send({ error: 'not_found' });
      if (q.resolved.get(ev.id)) return reply.code(409).send({ error: 'already_decided' });
      const ctx = JSON.parse(ev.context) as { draft_id: number };
      const d = q.draft.get(ctx.draft_id, u.id);
      if (!d) return reply.code(404).send({ error: 'not_found' });
      q.insertEvent.run(u.id, null, 'say', 'vetoed', ev.context, ev.id, now());
      return generate(u, { to: d.recipient, about: d.about, tone: req.body?.tone ?? d.tone, lang: d.lang }, reply, d.text);
    },
  );
}
