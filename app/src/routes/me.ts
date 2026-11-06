import type { FastifyInstance } from 'fastify';
import { requireUser, type Auth } from '../auth.js';
import type { DB } from '../db.js';
import { clampText, DIETS } from '../util.js';
import { checkPassword, PASSWORD_MAX } from '../password.js';

const CITIES = ['mumbai', 'other'] as const;

export function meRoutes(app: FastifyInstance, db: DB, auth: Auth) {
  const counts = db.prepare<[number], { kept: number; vetoed: number }>(
    `SELECT COALESCE(SUM(action = 'kept'), 0) - COALESCE(SUM(action = 'undone'), 0) AS kept,
            COALESCE(SUM(action = 'vetoed'), 0) AS vetoed
     FROM events WHERE user_id = ?`,
  );

  const publicUser = (u: NonNullable<ReturnType<typeof requireUser>>) => ({
    email: u.email,
    verified: !!u.email_verified,
    name: u.name,
    diet: u.diet,
    city: u.city,
    ...counts.get(u.id),
  });

  app.get('/api/me', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    return publicUser(u);
  });

  app.patch<{ Body: { name?: string | null; diet?: string; city?: string } }>(
    '/api/me',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: ['string', 'null'], maxLength: 40 },
            diet: { type: 'string', enum: [...DIETS] },
            city: { type: 'string', enum: [...CITIES] },
          },
        },
      },
    },
    async (req, reply) => {
      const u = requireUser(req, reply);
      if (!u) return;
      const b = req.body;
      if (b.name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(b.name ? clampText(b.name, 40) || null : null, u.id);
      if (b.diet) db.prepare('UPDATE users SET diet = ? WHERE id = ?').run(b.diet, u.id);
      if (b.city) db.prepare('UPDATE users SET city = ? WHERE id = ?').run(b.city, u.id);
      return publicUser(auth.q.userById.get(u.id)!);
    },
  );

  // DPDP Act 2023: users can see and erase their data.
  app.get('/api/me/export', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const events = db
      .prepare('SELECT e.created_at, e.category, e.action, i.title FROM events e LEFT JOIN items i ON i.id = e.item_id WHERE e.user_id = ? ORDER BY e.id')
      .all(u.id);
    const drafts = db.prepare('SELECT created_at, recipient, about, tone, lang, text FROM drafts WHERE user_id = ? ORDER BY id').all(u.id);
    const feedback = db.prepare('SELECT created_at, kind, rating, comment FROM feedback WHERE user_id = ? ORDER BY id').all(u.id);
    reply.header('content-disposition', 'attachment; filename="wetoes-my-data.json"');
    return { exported_at: new Date().toISOString(), profile: publicUser(u), events, drafts, feedback };
  });

  app.delete('/api/me', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    auth.logoutEverywhere(u.id, reply);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id); // cascades to sessions, events, drafts, usage
    return { ok: true };
  });

  app.post<{ Body: { current: string; next: string } }>(
    '/api/me/password',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['current', 'next'],
          additionalProperties: false,
          properties: { current: { type: 'string', maxLength: PASSWORD_MAX }, next: { type: 'string', maxLength: PASSWORD_MAX } },
        },
      },
    },
    async (req, reply) => {
      const u = requireUser(req, reply);
      if (!u) return;
      const err = checkPassword(req.body.next);
      if (err) return reply.code(400).send({ error: err });
      const res = await auth.changePassword(req, u.id, req.body.current, req.body.next);
      if ('error' in res) return reply.code(401).send(res);
      return { ok: true };
    },
  );

  app.post('/api/me/logout-everywhere', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    auth.logoutEverywhere(u.id, reply);
    return { ok: true };
  });
}
