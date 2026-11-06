import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { now, type DB } from './db.js';
import { newToken, sha256 } from './util.js';
import { burnTime, hashPassword, verifyPassword } from './password.js';

export const SESSION_COOKIE = 'wt_sid';
const DAY = 86_400_000;

export interface User {
  id: number;
  email: string;
  email_verified: number;
  name: string | null;
  diet: 'veg' | 'vegan' | 'everything' | null;
  city: string;
  created_at: number;
}
type UserWithHash = User & { password_hash: string | null };

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

/** In-memory brute-force guard: 8 wrong passwords per email per 15 minutes. Single process, so this is enough. */
class FailureLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max = 8, private windowMs = 15 * 60_000) {}
  private recent(key: string) {
    const t = now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    this.hits.set(key, list);
    return list;
  }
  blocked(key: string) {
    return this.recent(key).length >= this.max;
  }
  fail(key: string) {
    this.recent(key).push(now());
  }
  clear(key: string) {
    this.hits.delete(key);
  }
}

const strip = ({ password_hash: _, ...u }: UserWithHash): User => u;

export function makeAuth(db: DB) {
  const limiter = new FailureLimiter();
  const q = {
    userByEmail: db.prepare<[string], UserWithHash>('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare<[number], User>('SELECT * FROM users WHERE id = ?'),
    hashById: db.prepare<[number], { password_hash: string | null }>('SELECT password_hash FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (email, password_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)'),
    setHash: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    insertSession: db.prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    sessionUser: db.prepare<[string, number], UserWithHash & { s_last: number }>(
      `SELECT u.*, s.last_seen_at AS s_last FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    ),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?'),
    touchUser: db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    purgeExpired: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  };

  function createSession(reply: FastifyReply, userId: number, ua: string | undefined) {
    const token = newToken();
    const t = now();
    q.insertSession.run(sha256(token), userId, t, t + config.sessionDays * DAY, t, (ua ?? '').slice(0, 200));
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: config.sessionDays * 86_400,
    });
  }

  return {
    q,

    async resolveUser(req: FastifyRequest) {
      req.user = null;
      const token = req.cookies[SESSION_COOKIE];
      if (!token || token.length > 100) return;
      const h = sha256(token);
      const t = now();
      const row = q.sessionUser.get(h, t);
      if (!row) return;
      if (t - row.s_last > 600_000) {
        q.touchSession.run(t, h);
        q.touchUser.run(t, row.id);
      }
      const { s_last: _, ...user } = row;
      req.user = strip(user);
    },

    /** New account. An existing account that never set a password (pre-password era) is claimed instead. */
    async signup(email: string, password: string, reply: FastifyReply, ua: string | undefined) {
      const existing = q.userByEmail.get(email);
      if (existing?.password_hash) return { error: 'email_taken' as const };
      const hash = await hashPassword(password);
      let id: number;
      if (existing) {
        q.setHash.run(hash, existing.id);
        id = existing.id;
      } else {
        const t = now();
        id = Number(q.insertUser.run(email, hash, t, t).lastInsertRowid);
      }
      createSession(reply, id, ua);
      return { ok: true as const };
    },

    async login(email: string, password: string, reply: FastifyReply, ua: string | undefined) {
      if (limiter.blocked(email)) return { error: 'too_many_tries' as const };
      const u = q.userByEmail.get(email);
      if (!u) {
        await burnTime(password);
        limiter.fail(email);
        return { error: 'wrong_login' as const };
      }
      if (!u.password_hash) {
        // Legacy account from before passwords: first login sets it.
        q.setHash.run(await hashPassword(password), u.id);
      } else if (!(await verifyPassword(password, u.password_hash))) {
        limiter.fail(email);
        return { error: 'wrong_login' as const };
      }
      limiter.clear(email);
      createSession(reply, u.id, ua);
      return { ok: true as const };
    },

    async changePassword(req: FastifyRequest, userId: number, current: string, next: string) {
      const row = q.hashById.get(userId);
      if (row?.password_hash && !(await verifyPassword(current, row.password_hash))) return { error: 'wrong_password' as const };
      q.setHash.run(await hashPassword(next), userId);
      // Sign out every other device.
      const token = req.cookies[SESSION_COOKIE];
      if (token) q.deleteOtherSessions.run(userId, sha256(token));
      return { ok: true as const };
    },

    logout(req: FastifyRequest, reply: FastifyReply) {
      const token = req.cookies[SESSION_COOKIE];
      if (token) q.deleteSession.run(sha256(token));
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
    },

    logoutEverywhere(userId: number, reply: FastifyReply) {
      q.deleteUserSessions.run(userId);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
    },

    purgeExpired() {
      q.purgeExpired.run(now());
      db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').run(now() - DAY);
    },
  };
}

export type Auth = ReturnType<typeof makeAuth>;

export function requireUser(req: FastifyRequest, reply: FastifyReply): User | null {
  if (!req.user) {
    reply.code(401).send({ error: 'not_signed_in' });
    return null;
  }
  return req.user;
}
