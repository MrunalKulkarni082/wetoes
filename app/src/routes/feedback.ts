import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { now, type DB } from '../db.js';
import { clampText } from '../util.js';

export function feedbackRoutes(app: FastifyInstance, db: DB) {
  const ownsEvent = db.prepare<[number, number], { id: number }>('SELECT id FROM events WHERE id = ? AND user_id = ?');
  const insert = db.prepare('INSERT INTO feedback (user_id, kind, event_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)');

  app.post<{ Body: { kind: 'pick' | 'session'; rating?: 'good' | 'okay' | 'bad' | null; comment?: string; event_id?: number } }>(
    '/api/feedback',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
      schema: {
        body: {
          type: 'object',
          required: ['kind'],
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['pick', 'session'] },
            rating: { type: ['string', 'null'], enum: ['good', 'okay', 'bad', null] },
            comment: { type: 'string', maxLength: 1000 },
            event_id: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const u = requireUser(req, reply);
      if (!u) return;
      const b = req.body;
      const comment = clampText(b.comment ?? '', 1000) || null;
      if (!b.rating && !comment) return reply.code(400).send({ error: 'empty_feedback' });
      const eventId = b.event_id && ownsEvent.get(b.event_id, u.id) ? b.event_id : null;
      insert.run(u.id, b.kind, eventId, b.rating ?? null, comment, now());
      return { ok: true };
    },
  );
}
