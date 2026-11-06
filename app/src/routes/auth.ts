import type { FastifyInstance } from 'fastify';
import type { Auth } from '../auth.js';
import { checkPassword, PASSWORD_MAX } from '../password.js';
import { domainAcceptsMail, normalizeEmail } from '../util.js';

const body = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: { email: { type: 'string', maxLength: 254 }, password: { type: 'string', maxLength: PASSWORD_MAX } },
} as const;

// Per IP. Generous because Indian mobile carriers put many users behind one CGNAT IP;
// the per-email failure limiter in auth.ts is the real brute-force guard.
const limit = { rateLimit: { max: 30, timeWindow: '10 minutes' } };

export function authRoutes(app: FastifyInstance, auth: Auth, checkDomain: boolean) {
  app.post<{ Body: { email: string; password: string } }>('/api/auth/signup', { config: limit, schema: { body } }, async (req, reply) => {
    const email = normalizeEmail(req.body.email);
    if (!email) return reply.code(400).send({ error: 'invalid_email' });
    const pwErr = checkPassword(req.body.password);
    if (pwErr) return reply.code(400).send({ error: pwErr });
    if (checkDomain && !(await domainAcceptsMail(email))) return reply.code(400).send({ error: 'email_domain' });
    const res = await auth.signup(email, req.body.password, reply, req.headers['user-agent']);
    if ('error' in res) return reply.code(409).send(res);
    return { status: 'in' };
  });

  app.post<{ Body: { email: string; password: string } }>('/api/auth/login', { config: limit, schema: { body } }, async (req, reply) => {
    const email = normalizeEmail(req.body.email);
    if (!email) return reply.code(400).send({ error: 'invalid_email' });
    const res = await auth.login(email, req.body.password, reply, req.headers['user-agent']);
    if ('error' in res) return reply.code(res.error === 'too_many_tries' ? 429 : 401).send(res);
    return { status: 'in' };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    auth.logout(req, reply);
    return { ok: true };
  });
}
