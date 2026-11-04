PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  password_hash   TEXT,
  name            TEXT,
  diet            TEXT CHECK (diet IN ('veg','vegan','everything')),
  city            TEXT NOT NULL DEFAULT 'mumbai',
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL
);

-- Only the SHA-256 of the session token is stored; the raw token lives in the cookie.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- One-time magic-link tokens (hashed), short-lived, single use.
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX IF NOT EXISTS login_tokens_user ON login_tokens(user_id, created_at);

-- The catalog. Category-specific fields live in `data` (JSON).
CREATE TABLE IF NOT EXISTS items (
  id        TEXT PRIMARY KEY,
  category  TEXT NOT NULL CHECK (category IN ('eat','listen','watch','do','wear','say')),
  title     TEXT NOT NULL,
  why       TEXT NOT NULL DEFAULT '',
  moods     TEXT NOT NULL DEFAULT '[]',
  diet      TEXT NOT NULL DEFAULT '[]',
  budget    TEXT CHECK (budget IN ('free','u100','u300','splurge')),
  genre     TEXT,
  city      TEXT NOT NULL DEFAULT 'any',
  data      TEXT NOT NULL DEFAULT '{}',
  active    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS items_cat ON items(category, active);

-- Every serve / keep / veto / undo. This is the learning signal.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     TEXT,
  category    TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('served','kept','vetoed','undone')),
  context     TEXT NOT NULL DEFAULT '{}',
  ref_event   INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_user ON events(user_id, created_at);

-- LLM-generated drafts the user is working on (so veto/keep work the same as catalog picks).
CREATE TABLE IF NOT EXISTS drafts (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient   TEXT NOT NULL,
  about       TEXT NOT NULL,
  tone        TEXT NOT NULL,
  lang        TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_cache (
  key         TEXT PRIMARY KEY,
  output      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_usage (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Feedback: per pick (from the done screen) or per session (when signing out / from settings).
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('pick','session')),
  event_id    INTEGER,
  rating      TEXT CHECK (rating IN ('good','okay','bad')),
  comment     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_time ON feedback(created_at);
