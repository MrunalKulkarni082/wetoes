import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;
const N = 16384, r = 8, p = 1, KEYLEN = 32;

export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 72;
const TOO_COMMON = new Set(['123456', '1234567', '12345678', '123456789', 'password', 'qwerty', '111111', '000000', 'abc123', 'wetoes', 'iloveyou', '654321', '123123']);

/** Returns an error code, or null if the password is acceptable. */
export function checkPassword(pw: unknown): string | null {
  if (typeof pw !== 'string') return 'password_invalid';
  if (pw.length < PASSWORD_MIN) return 'password_short';
  if (pw.length > PASSWORD_MAX) return 'password_long';
  if (TOO_COMMON.has(pw.toLowerCase())) return 'password_common';
  return null;
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[2]!, 'base64');
  const expected = Buffer.from(parts[3]!, 'base64');
  const key = await scrypt(pw, salt, expected.length, { N: Number(parts[1]), r, p, maxmem: 64 * 1024 * 1024 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// A fixed hash so a login for an unknown email costs the same time as a real one (no account probing by timing).
let dummy: string | null = null;
export async function burnTime(pw: string) {
  dummy ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(pw, dummy);
}
