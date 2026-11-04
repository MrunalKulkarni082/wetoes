import { createHash, randomBytes } from 'node:crypto';
import { promises as dns } from 'node:dns';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

// Pragmatic email check: one @, a dot in the domain, no spaces, sane length.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) return null;
  return e;
}

/**
 * True if the domain can receive mail: has at least one real MX record (a null MX "." means "no mail").
 * DNS timeouts/server failures fail open so a flaky resolver doesn't lock people out.
 */
export async function domainAcceptsMail(email: string, timeoutMs = 3000): Promise<boolean> {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  try {
    const mx = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), timeoutMs)),
    ]);
    return mx.some((r) => r.exchange && r.exchange !== '.');
  } catch (e) {
    const code = (e as { code?: string }).code;
    return !(code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN');
  }
}

export function clampText(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  // strip control chars, collapse whitespace
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export const today = () => new Date().toISOString().slice(0, 10);

export const MOODS = ['tired', 'wired', 'blah', 'okay', 'good', 'glowing'] as const;
export const CATEGORIES = ['eat', 'listen', 'watch', 'do', 'wear', 'say'] as const;
export const BUDGETS = ['free', 'u100', 'u300', 'splurge'] as const;
export const DIETS = ['veg', 'vegan', 'everything'] as const;
export type Mood = (typeof MOODS)[number];
export type Category = (typeof CATEGORIES)[number];
export type Budget = (typeof BUDGETS)[number];
