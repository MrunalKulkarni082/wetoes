function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be an integer`);
  return n;
}

const env = process.env.NODE_ENV ?? 'development';

export const config = {
  env,
  isProd: env === 'production',
  port: int('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ?? './wetoes.db',
  publicUrl: (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  sessionDays: int('SESSION_DAYS', 90),
  loginTokenMinutes: int('LOGIN_TOKEN_MINUTES', 15),
  ollamaUrl: (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, ''),
  llmModel: process.env.LLM_MODEL ?? 'qwen2.5:7b',
  llmConcurrency: int('LLM_CONCURRENCY', 1),
  llmMaxQueue: int('LLM_MAX_QUEUE', 16),
  llmTimeoutMs: int('LLM_TIMEOUT_MS', 60_000),
  llmDailyLimit: int('LLM_DAILY_LIMIT', 60),
  trustProxy: process.env.TRUST_PROXY === 'true',
  extraOrigins: (process.env.EXTRA_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
  // Reject emails whose domain has no mail server (catches typos like gmial.con).
  // Shown on the privacy screen as the grievance / data-request contact (DPDP Act).
  contactEmail: process.env.CONTACT_EMAIL ?? '',
  checkEmailDomain: process.env.CHECK_EMAIL_DOMAIN !== 'false',
};

if (config.isProd) {
  if (!config.cookieSecure) {
    console.warn('[wetoes] WARNING: COOKIE_SECURE is false in production.');
  }
  if (config.publicUrl.startsWith('https://') && !config.cookieSecure) {
    throw new Error('PUBLIC_URL is https but COOKIE_SECURE is not true: refusing to start.');
  }
}
