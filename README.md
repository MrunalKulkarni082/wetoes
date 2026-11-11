# Wetoes

### 👉 Live: **[mrunalkulkarni082.github.io/wetoes](https://mrunalkulkarni082.github.io/wetoes/)**: free, no install, works on any phone.

**tell us how you feel. we'll hand you one thing for it.** we pick, you veto. You get one pick at a time for food, music, a watch, something to do, what to wear, or what to say. Every veto teaches it what you'll say yes to.

## Two ways to run it

| | **Web (GitHub Pages)**: `docs/` | **Self-hosted server**: `app/` |
|---|---|---|
| Hosting | static files on GitHub Pages, free | Node + SQLite + Ollama in Docker |
| Your data | the visitor's browser (localStorage) | our database |
| Sign-in | email only, no password | email + password |
| AI | free open-weight models (gpt-oss-120b/20b, Llama 3.3 70B, Mistral Small) on OVHcloud AI Endpoints, called from the browser with no key | qwen2.5:7b on our own GPU |
| Emails + feedback | sent to a Google Sheet | stored in our database |

### Web version (`docs/`)

- `engine.js` does in the browser what the server does: the veto-aware picker, the event log, drafts, memory, and export/delete. It answers the same `/api/...` paths, so `app.js` is nearly identical in both versions.
- **AI:** each model allows about 2 requests per minute per visitor, so the engine rotates through 4 models (about 8 per minute). On a 429 it moves to the next model. When every model is busy or down:
  - "say" falls back to hand-written templates
  - typed moods fall back to keyword matching
  - "why this" keeps the curated line

  Prompts wrap user text as data, and every answer is validated before it is shown.
- **Email check:** format, plus an MX lookup through DNS-over-HTTPS (dns.google) that fails open, to catch typos like `gmial.con`.
- **Collecting emails and feedback:** see [`sheet/Code.gs`](sheet/Code.gs). Then set `sheetUrl` (and `contact`) in [`docs/config.js`](docs/config.js).
- **Security:**
  - strict CSP: scripts only from our own origin; network calls only to the AI endpoint, dns.google and Apps Script
  - no secrets in the page
  - the sheet script dedupes sign-ups, caps field lengths and neutralises spreadsheet formulas
- **Run locally:** `cd docs && python3 -m http.server 8080`

## Server version (`app/`)

### Stack

| Part | Choice | Why |
|---|---|---|
| API + web | Node 22, TypeScript, Fastify 5 | small, fast, schema-validated routes |
| Database | SQLite (WAL) via better-sqlite3 | one file, no ops, handles thousands of users |
| LLM | Ollama + `qwen2.5:7b` | runs on our own hardware, so user text never leaves the server |
| Packaging | Docker Compose (app + ollama) | the same thing runs on a laptop and on the server |

```
app/
  src/
    server.ts        Fastify app: security headers, CSRF, rate limits, routes
    auth.ts          email + password login, hashed sessions, brute-force lockout
    password.ts      scrypt hashing + password rules
    picker.ts        the "one pick" engine (hard filters + veto-aware weighted draw)
    llm.ts           Ollama client: queue, timeout, cache, per-user daily cap
    prompts.ts       the prompt templates + output validators
    routes/          auth, me (profile/export/delete), picks, say
    seed.ts          idempotent catalog loader (runs on every boot)
    schema.sql
  seed/*.json        the catalog: edit these to add or change picks
  public/            frontend (index.html, app.js, app.css): no build step
  test/              API tests (node:test)
```

### Run locally

```bash
cp .env.example .env
docker compose up --build -d
docker compose exec ollama ollama pull qwen2.5:7b    # one-time, ~4.7 GB
open http://localhost:3000
```

#### Without Docker for the app (fast dev loop)

```bash
cd app && npm install
OLLAMA_URL=http://127.0.0.1:11434 npm run dev
npm test
```

### How login works

- **I'm new**: email and password (6+ characters, very common ones refused). The email domain must have a mail server, which catches typos like `gmial.con`.
- **I've been here**: email and password. A wrong password and an unknown email give the same error, and it takes the same time, so nobody can probe which emails exist.
- After 8 wrong passwords for an email within 15 minutes, that email is locked out for a while.
- Passwords are hashed with scrypt (salted) and are never stored or logged in plain text.
- Changing the password signs out every other device.
- Accounts made before passwords existed set their password on their first sign-in.
- There is no "forgot password" yet, because it needs an email provider, which is a deployment decision.

### Feedback

Users are asked "how did we do?" after every yes, and again when they sign out. It is also under Settings, as "give us feedback". To read it:

```bash
docker exec wetoes-local-app-1 node dist/feedback-report.js 30   # last 30 days
```

### Security baseline (built in)

- Strict CSP (`script-src 'self'`, no inline JS) plus Helmet headers. HSTS turns on when `COOKIE_SECURE=true`.
- CSRF: every write needs an `x-wetoes: 1` header, and the Origin is checked in production. CORS is never enabled.
- Every body, param and enum is validated by JSON schema, and unknown fields are rejected.
- Rate limits: global per user or IP, a tighter one on auth, a lockout after repeated wrong passwords for an email, and a cap on LLM calls (per minute and per day).
- LLM: user text is wrapped as data, outputs are validated against enums and lengths, the queue sheds load (503 instead of hanging), and "say" falls back to hand-written templates if the model is down.
- Users can only read or change their own events (enforced in SQL).
- The container runs as non-root on a read-only filesystem with all capabilities dropped. Ollama is not exposed outside the Docker network.
- Data rights (DPDP Act 2023): `GET /api/me/export` and `DELETE /api/me`, which cascades to everything.

### Editing the catalog

Add objects to any `app/seed/*.json` (ids must be unique). On the next restart they are upserted. To retire an item without deleting it, set `"active": false`.

## Deployment

- **Web:** GitHub Pages serves `docs/` from `main`, so push to deploy.
- **Server:** `docker compose up -d --build` on any machine with Docker. Put HTTPS in front before exposing it, and set `COOKIE_SECURE=true` and `TRUST_PROXY=true`.
