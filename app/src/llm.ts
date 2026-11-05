import { config } from './config.js';
import { now, type DB } from './db.js';
import { sha256, today } from './util.js';

// Bump when prompts change so cached outputs from old prompts are not reused.
export const PROMPT_VERSION = 'p5';

export class LlmBusyError extends Error {}
export class LlmLimitError extends Error {}
export class LlmUnavailableError extends Error {}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Tiny FIFO semaphore: CPU inference is serial, so we queue and shed load past a cap. */
class Queue {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private concurrency: number, private maxQueue: number) {}
  get depth() {
    return this.waiting.length;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxQueue) throw new LlmBusyError('llm queue full');
      await new Promise<void>((res) => this.waiting.push(res));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export function makeLlm(db: DB) {
  const queue = new Queue(config.llmConcurrency, config.llmMaxQueue);
  const q = {
    getCache: db.prepare<[string], { output: string }>('SELECT output FROM llm_cache WHERE key = ?'),
    putCache: db.prepare('INSERT OR REPLACE INTO llm_cache (key, output, created_at) VALUES (?, ?, ?)'),
    usage: db.prepare<[number, string], { count: number }>('SELECT count FROM llm_usage WHERE user_id = ? AND day = ?'),
    bump: db.prepare(
      `INSERT INTO llm_usage (user_id, day, count) VALUES (?, ?, 1)
       ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1`,
    ),
  };

  async function callOllama(messages: ChatMessage[], temperature: number): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.llmTimeoutMs);
    try {
      const res = await fetch(`${config.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: config.llmModel,
          messages,
          stream: false,
          format: 'json',
          keep_alive: '24h',
          options: { temperature, num_predict: 220, num_ctx: 2048 },
        }),
      });
      if (!res.ok) throw new LlmUnavailableError(`ollama ${res.status}`);
      const body = (await res.json()) as { message?: { content?: string } };
      return body.message?.content ?? '';
    } catch (e) {
      if (e instanceof LlmUnavailableError) throw e;
      throw new LlmUnavailableError(String((e as Error).message ?? e));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Generate a JSON object. `cacheKey` (if given) makes identical requests free forever.
   * `userId` enforces the per-user daily budget (cache hits don't count).
   */
  async function json<T>(opts: {
    messages: ChatMessage[];
    temperature?: number;
    cacheKey?: string;
    userId: number;
    validate: (raw: unknown) => T | null;
  }): Promise<T> {
    const key = opts.cacheKey ? sha256(`${PROMPT_VERSION}|${config.llmModel}|${opts.cacheKey}`) : null;
    if (key) {
      const hit = q.getCache.get(key);
      if (hit) {
        const v = opts.validate(JSON.parse(hit.output));
        if (v) return v;
      }
    }
    const used = q.usage.get(opts.userId, today())?.count ?? 0;
    if (used >= config.llmDailyLimit) throw new LlmLimitError('daily limit');

    return queue.run(async () => {
      // two attempts: small models occasionally emit invalid JSON
      for (let attempt = 0; attempt < 2; attempt++) {
        const out = await callOllama(opts.messages, opts.temperature ?? 0.7);
        let parsed: unknown;
        try {
          parsed = JSON.parse(out);
        } catch {
          continue;
        }
        const v = opts.validate(parsed);
        if (v) {
          q.bump.run(opts.userId, today());
          if (key) q.putCache.run(key, JSON.stringify(v), now());
          return v;
        }
      }
      throw new LlmUnavailableError('model returned unusable output');
    });
  }

  async function health(): Promise<{ ok: boolean; model: string; loaded: boolean }> {
    try {
      const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return { ok: false, model: config.llmModel, loaded: false };
      const body = (await res.json()) as { models?: Array<{ name: string }> };
      const loaded = !!body.models?.some((m) => m.name === config.llmModel || m.name === `${config.llmModel}:latest`);
      return { ok: true, model: config.llmModel, loaded };
    } catch {
      return { ok: false, model: config.llmModel, loaded: false };
    }
  }

  return { json, health, queueDepth: () => queue.depth };
}

export type Llm = ReturnType<typeof makeLlm>;
