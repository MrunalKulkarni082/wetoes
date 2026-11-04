import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb, type DB } from './db.js';
import { makeAuth } from './auth.js';
import { makePicker } from './picker.js';
import { makeLlm } from './llm.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { pickRoutes } from './routes/picks.js';
import { sayRoutes } from './routes/say.js';
import { feedbackRoutes } from './routes/feedback.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function buildApp(
  opts: { db?: DB; logger?: boolean; checkEmailDomain?: boolean } = {},
): Promise<FastifyInstance> {
  const db = opts.db ?? openDb();
  const auth = makeAuth(db);
  const picker = makePicker(db);
  const llm = makeLlm(db);

  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.isProd ? 'info' : 'debug', redact: ['req.headers.cookie', 'req.body.password', 'req.body.current', 'req.body.next'] },
    // Behind Cloudflare Tunnel the proxy (cloudflared) connects over loopback; trust only that hop,
    // so req.ip is the real visitor IP and a client can't spoof it with its own X-Forwarded-For.
    trustProxy: config.trustProxy ? 'loopback' : false,
    bodyLimit: 16 * 1024,
    // Reject unknown fields instead of silently stripping them.
    ajv: { customOptions: { removeAdditional: false } },
    disableRequestLogging: config.isProd,
  });
  app.decorateRequest('user', null);

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Templates use inline style attributes; no inline scripts are allowed.
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: config.cookieSecure ? [] : null,
      },
    },
    hsts: config.cookieSecure ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  });

  app.addHook('onRequest', async (req) => auth.resolveUser(req));

  await app.register(rateLimit, {
    global: true,
    max: 240,
    timeWindow: '1 minute',
    // Per signed-in user where possible, else per IP.
    keyGenerator: (req) => (req.user ? `u:${req.user.id}` : `ip:${req.ip}`),
  });

  // CSRF: state-changing API calls must carry a custom header (not settable cross-site without CORS,
  // which we never enable) and, if the browser sends Origin, it must be ours.
  const allowedOrigins = new Set([new URL(config.publicUrl).origin, ...config.extraOrigins]);
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.method === 'GET' || req.method === 'HEAD') return;
    if (req.headers['x-wetoes'] !== '1') return reply.code(403).send({ error: 'csrf' });
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin) && config.isProd) return reply.code(403).send({ error: 'bad_origin' });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: 'bad_request', detail: err.message });
    if (err.statusCode === 429) return reply.code(429).send({ error: 'slow_down' });
    req.log.error(err);
    return reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500).send({ error: 'server_error' });
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/status', async () => {
    const h = await llm.health();
    return { llm: h.ok && h.loaded ? 'ready' : h.ok ? 'model_missing' : 'down', queue: llm.queueDepth(), contact: config.contactEmail || null };
  });

  authRoutes(app, auth, opts.checkEmailDomain ?? config.checkEmailDomain);
  feedbackRoutes(app, db);
  meRoutes(app, db, auth);
  pickRoutes(app, db, picker, llm);
  sayRoutes(app, db, llm);

  await app.register(fastifyStatic, {
    root: join(here, '..', 'public'),
    index: ['index.html'],
    maxAge: config.isProd ? '1h' : 0,
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
    return reply.sendFile('index.html');
  });

  // Housekeeping.
  const timer = setInterval(() => auth.purgeExpired(), 3_600_000);
  app.addHook('onClose', async () => {
    clearInterval(timer);
    if (!opts.db) db.close();
  });

  return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      app.log.info(`${sig} received, shutting down`);
      app.close().then(() => process.exit(0));
    });
  }
}
