const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { nanoid } = require('nanoid');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const raw = new DatabaseSync(path.join(DATA_DIR, 'bifrost.sqlite'));
raw.exec('PRAGMA journal_mode = WAL');

// --- Thin compatibility wrapper around node:sqlite's DatabaseSync ------
// node:sqlite (built into Node 22.5+, stable from Node 24) needs no native
// compile step, unlike better-sqlite3 — which is exactly why we're on it:
// `npm install` just works on a fresh machine, no Visual Studio / build
// toolchain required. Two behavioral gaps versus better-sqlite3 that the
// rest of the codebase was written against:
//   1. better-sqlite3 silently treated `undefined` bind values as NULL
//      (relied on throughout for `COALESCE(?, col)`-style partial updates);
//      node:sqlite throws on `undefined` instead. sanitize() below closes
//      that gap so every call site keeps working unmodified.
//   2. better-sqlite3 exposed a `db.transaction(fn)` helper; node:sqlite
//      doesn't, so transaction() below reimplements it with BEGIN/COMMIT/ROLLBACK.
function sanitize(args) {
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Buffer.isBuffer(args[0])) {
    const clean = {};
    for (const k of Object.keys(args[0])) clean[k] = args[0][k] === undefined ? null : args[0][k];
    return [clean];
  }
  return args.map((a) => (a === undefined ? null : a));
}

function prepare(sql) {
  const stmt = raw.prepare(sql);
  return {
    run: (...args) => stmt.run(...sanitize(args)),
    get: (...args) => stmt.get(...sanitize(args)),
    all: (...args) => stmt.all(...sanitize(args))
  };
}

function transaction(fn) {
  return (...args) => {
    raw.exec('BEGIN');
    try {
      const result = fn(...args);
      raw.exec('COMMIT');
      return result;
    } catch (err) {
      try { raw.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw err;
    }
  };
}

const db = { prepare, exec: (sql) => raw.exec(sql), transaction };

db.exec(`
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,            -- openai | anthropic | gemini | openai_compatible
  base_url TEXT,                 -- only needed for openai_compatible / self-hosted
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  api_key TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  cooldown_until TEXT,           -- ISO timestamp; skip account until this passes
  last_used_at TEXT,
  consecutive_failures INTEGER DEFAULT 0, -- circuit breaker: resets on any success
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS combos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  steps_json TEXT NOT NULL,      -- JSON array [{provider_id, model, weight?}, ...]
  strategy TEXT DEFAULT 'ordered', -- ordered | cost | weighted
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  ts TEXT DEFAULT (datetime('now')),
  combo_id TEXT,
  provider_id TEXT,
  provider_name TEXT,
  account_label TEXT,
  model TEXT,
  status TEXT,                   -- success | error
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_estimate REAL,
  latency_ms INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT
);
`);

// Migration for databases created before the `strategy` column existed.
// SQLite has no "ADD COLUMN IF NOT EXISTS", so just swallow the error when
// the column is already there.
try { db.exec("ALTER TABLE combos ADD COLUMN strategy TEXT DEFAULT 'ordered'"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE accounts ADD COLUMN consecutive_failures INTEGER DEFAULT 0"); } catch { /* already exists */ }

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value_json); } catch { return fallback; }
}
function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value_json) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(key, JSON.stringify(value));
}

module.exports = { db, nanoid, getSetting, setSetting };
