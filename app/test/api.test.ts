import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.OLLAMA_URL = 'http://127.0.0.1:9'; // force LLM-down path
process.env.LLM_TIMEOUT_MS = '500';

const { buildApp } = await import('../src/server.js');
const { openDb } = await import('../src/db.js');
const { seed } = await import('../src/seed.js');

const db = openDb(':memory:');
seed(db);
const app = await buildApp({ db, logger: false, checkEmailDomain: false });
const { domainAcceptsMail } = await import('../src/util.js');

const H = { 'x-wetoes': '1', 'content-type': 'application/json' };
function cookieOf(res: { headers: Record<string, unknown> }) {
  const sc = res.headers['set-cookie'];
  const s = Array.isArray(sc) ? sc.join(';') : String(sc ?? '');
  const m = /wt_sid=([^;]+)/.exec(s);
  return m ? `wt_sid=${m[1]}` : '';
}
async function call(method: string, url: string, cookie: string, body?: unknown) {
  const headers: Record<string, string> = body === undefined ? { 'x-wetoes': '1', cookie } : { ...H, cookie };
  return app.inject({ method: method as 'GET', url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
}

before(async () => app.ready());
after(async () => app.close());

const PW = 'chai-time-42';
async function signup(email: string, password = PW) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: H, payload: { email, password } });
  assert.equal(res.statusCode, 200, res.body);
  return cookieOf(res);
}
const login = (email: string, password: string) => app.inject({ method: 'POST', url: '/api/auth/login', headers: H, payload: { email, password } });

test('signup → login with password, wrong password rejected, hash not plaintext', async () => {
  const c = await signup('A@Example.com ');
  const me = await call('GET', '/api/me', c);
  assert.equal(me.json().email, 'a@example.com');
  const row = db.prepare("SELECT password_hash FROM users WHERE email = 'a@example.com'").get() as { password_hash: string };
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes(PW));
  assert.equal((await login('a@example.com', 'wrong-pass')).statusCode, 401);
  const ok = await login('a@example.com', PW);
  assert.equal(ok.statusCode, 200);
  assert.ok(cookieOf(ok));
});

test('signup refuses an email that already has a password', async () => {
  await signup('taken@example.com');
  const res = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: H, payload: { email: 'taken@example.com', password: 'another-one' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'email_taken');
});

test('weak passwords rejected', async () => {
  for (const [pw, code] of [['abc', 'password_short'], ['123456', 'password_common']] as const) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: H, payload: { email: `w${pw}@example.com`, password: pw } });
    assert.equal(res.json().error, code);
  }
});

test('unknown email and wrong password give the same error', async () => {
  const a = await login('nobody@example.com', 'whatever1');
  const b = await login('a@example.com', 'whatever1');
  assert.equal(a.statusCode, 401);
  assert.equal(a.body, b.body);
});

test('brute force locks the email after 8 misses', async () => {
  await signup('lock@example.com');
  for (let i = 0; i < 8; i++) await login('lock@example.com', 'nope-nope-' + i);
  const res = await login('lock@example.com', PW);
  assert.equal(res.statusCode, 429);
});

test('legacy account without password is claimed on first login', async () => {
  db.prepare("INSERT INTO users (email, created_at, last_seen_at) VALUES ('old@example.com', 1, 1)").run();
  assert.equal((await login('old@example.com', 'my-new-pass')).statusCode, 200);
  assert.equal((await login('old@example.com', 'other-pass')).statusCode, 401);
});

test('change password signs out other devices', async () => {
  const d1 = await signup('pw@example.com');
  const d2 = cookieOf(await login('pw@example.com', PW));
  assert.equal((await call('POST', '/api/me/password', d1, { current: 'bad-current', next: 'new-pass-1' })).statusCode, 401);
  assert.equal((await call('POST', '/api/me/password', d1, { current: PW, next: 'new-pass-1' })).statusCode, 200);
  assert.equal((await call('GET', '/api/me', d1)).statusCode, 200);
  assert.equal((await call('GET', '/api/me', d2)).statusCode, 401);
  assert.equal((await login('pw@example.com', 'new-pass-1')).statusCode, 200);
});

test('feedback is stored and tied only to own events', async () => {
  const a = await signup('fb@example.com');
  const b = await signup('fb2@example.com');
  const r = (await call('POST', '/api/pick', a, { category: 'do' })).json();
  assert.equal((await call('POST', '/api/feedback', a, { kind: 'pick', rating: 'good', event_id: r.event_id })).statusCode, 200);
  assert.equal((await call('POST', '/api/feedback', b, { kind: 'pick', rating: 'bad', event_id: r.event_id })).statusCode, 200);
  assert.equal((await call('POST', '/api/feedback', a, { kind: 'session', comment: 'love the veto button' })).statusCode, 200);
  assert.equal((await call('POST', '/api/feedback', a, { kind: 'session' })).statusCode, 400);
  const rows = db.prepare('SELECT user_id, event_id FROM feedback ORDER BY id').all() as Array<{ event_id: number | null }>;
  assert.equal(rows[0]!.event_id, r.event_id);
  assert.equal(rows[1]!.event_id, null); // someone else's event is not linked
});

test('csrf header required for writes', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: { 'content-type': 'application/json' }, payload: { email: 'x@y.com', password: PW } });
  assert.equal(res.statusCode, 403);
});

test('hinglish is disabled for now', async () => {
  const s2 = await signup('hi@example.com');
  const r2 = await call('POST', '/api/say', s2, { to: 'ma', about: 'diwali plans', tone: 'warm', lang: 'hinglish' });
  assert.equal(r2.statusCode, 400);
});

test('email domain check (needs network)', async () => {
  assert.equal(await domainAcceptsMail('someone@gmail.com'), true);
  assert.equal(await domainAcceptsMail('someone@no-such-domain-wetoes-zz9.com'), false);
  assert.equal(await domainAcceptsMail('someone@example.com'), false); // null MX
});

test('pick → veto → keep → undo, diet respected, history counted', async () => {
  const s = await signup('veg@example.com');
  await call('PATCH', '/api/me', s, { diet: 'veg' });
  const seen = new Set<string>();
  let r = (await call('POST', '/api/pick', s, { category: 'eat', mood: 'tired', budget: 'u100' })).json();
  for (let i = 0; i < 15; i++) {
    const item = db.prepare('SELECT diet FROM items WHERE id = ?').get(r.item.id) as { diet: string };
    assert.ok(/veg/.test(item.diet), `non-veg served: ${r.item.title}`);
    seen.add(r.item.id);
    const v = await call('POST', `/api/events/${r.event_id}/veto`, s);
    assert.equal(v.statusCode, 200);
    r = v.json();
  }
  assert.ok(seen.size >= 10, 'recent picks should not repeat quickly');
  // can't veto the same event twice
  const k = await call('POST', `/api/events/${r.event_id}/keep`, s);
  assert.equal(k.statusCode, 200);
  assert.equal((await call('POST', `/api/events/${r.event_id}/veto`, s)).statusCode, 409);
  assert.equal((await call('POST', `/api/events/${r.event_id}/undo`, s)).statusCode, 200);
  const mem = (await call('GET', '/api/memory', s)).json();
  assert.equal(mem.vetoed, 15);
  assert.equal(mem.kept, 0);
});

test('users cannot touch each other’s events', async () => {
  const a = await signup('u1@example.com');
  const b = await signup('u2@example.com');
  const r = (await call('POST', '/api/pick', a, { category: 'watch' })).json();
  assert.equal((await call('POST', `/api/events/${r.event_id}/keep`, b)).statusCode, 404);
});

test('say falls back to a template when the LLM is down', async () => {
  const s = await signup('say@example.com');
  const r = await call('POST', '/api/say', s, { to: 'ma', about: 'not coming home this diwali', tone: 'warm', lang: 'english' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().source, 'template');
  const v = await call('POST', `/api/say/${r.json().event_id}/veto`, s, { tone: 'firm' });
  assert.equal(v.statusCode, 200);
});

test('validation rejects junk', async () => {
  const s = await signup('v@example.com');
  assert.equal((await call('POST', '/api/pick', s, { category: 'drugs' })).statusCode, 400);
  assert.equal((await call('POST', '/api/pick', s, { category: 'eat', extra: 1 })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/signup', headers: H, payload: { email: 'nope', password: PW } })).statusCode, 400);
  assert.equal((await call('GET', '/api/me', '')).statusCode, 401);
});

test('delete account removes everything', async () => {
  const s = await signup('gone@example.com');
  await call('POST', '/api/pick', s, { category: 'do' });
  assert.equal((await call('DELETE', '/api/me', s)).statusCode, 200);
  assert.equal((await call('GET', '/api/me', s)).statusCode, 401);
  const n = db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'gone@example.com'").get() as { n: number };
  assert.equal(n.n, 0);
});

test('security headers present', async () => {
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-security-policy']), /script-src 'self'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});
