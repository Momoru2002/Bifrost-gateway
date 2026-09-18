require('dotenv').config();
const express = require('express');
const path = require('path');
const { db, nanoid, getSetting, setSetting } = require('./lib/db');
const { attemptChain, estimateCost, logRequest, getCombo } = require('./lib/router');
const sync = require('./lib/sync');

const app = express();
app.use(express.json({ limit: '25mb' }));

const PORT = process.env.PORT || 8787;

// ---------------------------------------------------------------------
// Gateway auth: a local key so random processes on your machine can't
// silently spend your provider credits. Generated on first boot.
// ---------------------------------------------------------------------
if (!getSetting('gateway_key')) {
  setSetting('gateway_key', `bf-${nanoid(32)}`);
}
function requireGatewayKey(req, res, next) {
  const auth = req.headers.authorization || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (key !== getSetting('gateway_key')) {
    return res.status(401).json({ error: { message: 'Invalid or missing gateway API key' } });
  }
  next();
}

// ---------------------------------------------------------------------
// OpenAI-compatible endpoint — point Claude Code / Cursor / any
// OpenAI-SDK-based tool at http://localhost:8787/v1
// ---------------------------------------------------------------------
app.post('/v1/chat/completions', requireGatewayKey, async (req, res) => {
  const comboId = req.query.combo || req.header('x-bifrost-combo') || undefined;
  const body = req.body;

  let attempt;
  try {
    attempt = await attemptChain(comboId, body);
  } catch (err) {
    logRequest({ combo_id: comboId, status: 'error', error: err.message });
    return res.status(502).json({ error: { message: err.message } });
  }

  const { res: upstream, adapter, provider, account, model, started } = attempt;
  const latency = () => Date.now() - started;

  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const ctx = { id: `chatcmpl-${nanoid(12)}`, created: Math.floor(Date.now() / 1000), model, usage: null };
    let buffer = '';

    // SSE events are separated by a blank line ("\n\n"). Buffer raw bytes and
    // split on that boundary so we always hand adapters one complete event.
    upstream.body.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const events = buffer.split('\n\n');
      buffer = events.pop(); // keep incomplete trailing event
      for (const evt of events) {
        const dataLine = evt.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const out = adapter.translateStreamLine ? adapter.translateStreamLine(dataLine, ctx) : null;
        if (out) res.write(out);
      }
    });
    upstream.body.on('end', () => {
      res.end();
      logRequest({
        combo_id: attempt.comboId, provider_id: provider.id, provider_name: provider.name,
        account_label: account.label, model, status: 'success',
        input_tokens: ctx.usage?.input || 0, output_tokens: ctx.usage?.output || 0,
        cost_estimate: ctx.usage ? estimateCost(model, ctx.usage.input, ctx.usage.output) : 0,
        latency_ms: latency()
      });
    });
    upstream.body.on('error', (err) => {
      res.end();
      logRequest({ combo_id: attempt.comboId, provider_id: provider.id, provider_name: provider.name,
        account_label: account.label, model, status: 'error', error: err.message, latency_ms: latency() });
    });
    return;
  }

  // Non-streaming
  try {
    const json = await upstream.json();
    const normalized = adapter.normalizeResponse(json, model);
    const usage = adapter.extractUsage(json);
    logRequest({
      combo_id: attempt.comboId, provider_id: provider.id, provider_name: provider.name,
      account_label: account.label, model, status: 'success',
      input_tokens: usage.input, output_tokens: usage.output,
      cost_estimate: estimateCost(model, usage.input, usage.output), latency_ms: latency()
    });
    res.json(normalized);
  } catch (err) {
    logRequest({ combo_id: attempt.comboId, provider_id: provider.id, provider_name: provider.name,
      account_label: account.label, model, status: 'error', error: err.message, latency_ms: latency() });
    res.status(502).json({ error: { message: `Upstream response parse error: ${err.message}` } });
  }
});

app.get('/v1/models', requireGatewayKey, (req, res) => {
  const combos = db.prepare('SELECT * FROM combos').all();
  const models = new Set();
  combos.forEach((c) => JSON.parse(c.steps_json).forEach((s) => models.add(s.model)));
  res.json({ object: 'list', data: [...models].map((id) => ({ id, object: 'model' })) });
});

// ---------------------------------------------------------------------
// Dashboard REST API (no gateway-key required — local-only dashboard).
// Mount everything under /api.
// ---------------------------------------------------------------------
const api = express.Router();

api.get('/gateway-key', (req, res) => res.json({ key: getSetting('gateway_key') }));
api.post('/gateway-key/regenerate', (req, res) => {
  const key = `bf-${nanoid(32)}`;
  setSetting('gateway_key', key);
  res.json({ key });
});

api.get('/providers', (req, res) => {
  const providers = db.prepare('SELECT * FROM providers ORDER BY created_at').all();
  const accounts = db.prepare('SELECT id, provider_id, label, enabled, cooldown_until, last_used_at FROM accounts').all();
  res.json(providers.map((p) => ({ ...p, accounts: accounts.filter((a) => a.provider_id === p.id) })));
});
api.post('/providers', (req, res) => {
  const { name, kind, base_url } = req.body;
  if (!name || !kind) return res.status(400).json({ error: 'name and kind are required' });
  const id = nanoid();
  db.prepare('INSERT INTO providers (id, name, kind, base_url) VALUES (?, ?, ?, ?)').run(id, name, kind, base_url || null);
  res.json({ id });
});
api.patch('/providers/:id', (req, res) => {
  const { name, base_url, enabled } = req.body;
  db.prepare('UPDATE providers SET name = COALESCE(?, name), base_url = COALESCE(?, base_url), enabled = COALESCE(?, enabled) WHERE id = ?')
    .run(name, base_url, enabled === undefined ? undefined : (enabled ? 1 : 0), req.params.id);
  res.json({ ok: true });
});
api.delete('/providers/:id', (req, res) => {
  db.prepare('DELETE FROM providers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

api.post('/accounts', (req, res) => {
  const { provider_id, label, api_key } = req.body;
  if (!provider_id || !label || !api_key) return res.status(400).json({ error: 'provider_id, label, api_key required' });
  const id = nanoid();
  db.prepare('INSERT INTO accounts (id, provider_id, label, api_key) VALUES (?, ?, ?, ?)').run(id, provider_id, label, api_key);
  res.json({ id });
});
api.patch('/accounts/:id', (req, res) => {
  const { label, api_key, enabled } = req.body;
  db.prepare('UPDATE accounts SET label = COALESCE(?, label), api_key = COALESCE(?, api_key), enabled = COALESCE(?, enabled) WHERE id = ?')
    .run(label, api_key, enabled === undefined ? undefined : (enabled ? 1 : 0), req.params.id);
  res.json({ ok: true });
});
api.delete('/accounts/:id', (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

api.get('/combos', (req, res) => {
  const rows = db.prepare('SELECT * FROM combos ORDER BY created_at').all();
  res.json(rows.map((r) => ({ ...r, steps: JSON.parse(r.steps_json) })));
});
api.post('/combos', (req, res) => {
  const { name, steps, is_default, strategy } = req.body;
  if (!name || !Array.isArray(steps) || !steps.length) return res.status(400).json({ error: 'name and steps[] required' });
  const id = nanoid();
  if (is_default) db.prepare('UPDATE combos SET is_default = 0').run();
  db.prepare('INSERT INTO combos (id, name, steps_json, is_default, strategy) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, JSON.stringify(steps), is_default ? 1 : 0, strategy || 'ordered');
  res.json({ id });
});
api.patch('/combos/:id', (req, res) => {
  const { name, steps, is_default, strategy } = req.body;
  if (is_default) db.prepare('UPDATE combos SET is_default = 0').run();
  db.prepare('UPDATE combos SET name = COALESCE(?, name), steps_json = COALESCE(?, steps_json), is_default = COALESCE(?, is_default), strategy = COALESCE(?, strategy) WHERE id = ?')
    .run(name, steps ? JSON.stringify(steps) : undefined, is_default === undefined ? undefined : (is_default ? 1 : 0), strategy, req.params.id);
  res.json({ ok: true });
});
api.delete('/combos/:id', (req, res) => {
  db.prepare('DELETE FROM combos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

api.get('/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json(db.prepare('SELECT * FROM request_logs ORDER BY ts DESC LIMIT ?').all(limit));
});
api.get('/stats', (req, res) => {
  const totals = db.prepare(`
    SELECT COUNT(*) as requests,
           SUM(input_tokens) as input_tokens,
           SUM(output_tokens) as output_tokens,
           SUM(cost_estimate) as cost,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
    FROM request_logs
  `).get();
  const byProvider = db.prepare(`
    SELECT provider_name, COUNT(*) as requests, SUM(cost_estimate) as cost
    FROM request_logs WHERE provider_name IS NOT NULL
    GROUP BY provider_name
  `).all();
  res.json({ totals, byProvider });
});

// Local "sync": export/import the whole config (providers, accounts, combos,
// settings) as one JSON blob. Point this at a synced folder (Dropbox/Drive)
// or commit it (with keys stripped) to move config between machines.
api.get('/export', (req, res) => {
  res.json({
    providers: db.prepare('SELECT * FROM providers').all(),
    accounts: db.prepare('SELECT * FROM accounts').all(),
    combos: db.prepare('SELECT * FROM combos').all(),
    // gateway_key is per-machine auth for this gateway instance — importing
    // it elsewhere would silently break whatever's already authenticating
    // there, so it's deliberately left out of both export paths.
    settings: db.prepare("SELECT * FROM settings WHERE key != 'gateway_key'").all()
  });
});
api.post('/import', (req, res) => {
  const { providers = [], accounts = [], combos = [], settings = [] } = req.body;
  const tx = db.transaction(() => {
    for (const p of providers) db.prepare('INSERT OR REPLACE INTO providers (id, name, kind, base_url, enabled, created_at) VALUES (@id, @name, @kind, @base_url, @enabled, @created_at)').run(p);
    for (const a of accounts) db.prepare('INSERT OR REPLACE INTO accounts (id, provider_id, label, api_key, enabled, cooldown_until, last_used_at, created_at) VALUES (@id, @provider_id, @label, @api_key, @enabled, @cooldown_until, @last_used_at, @created_at)').run(a);
    for (const c of combos) db.prepare('INSERT OR REPLACE INTO combos (id, name, steps_json, is_default, strategy, created_at) VALUES (@id, @name, @steps_json, @is_default, @strategy, @created_at)').run({ strategy: 'ordered', ...c });
    for (const s of settings) db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (@key, @value_json)').run(s);
  });
  tx();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Cloud sync via a private GitHub Gist the user owns. The config is
// AES-256-GCM encrypted with the user's passphrase *before* it leaves this
// machine, so the plaintext (including provider API keys) never touches
// GitHub. Neither the GitHub token nor the passphrase is ever persisted —
// both are supplied fresh on each push/pull and used only in-memory for
// that one request. Only the resulting gist ID is remembered locally, so
// repeat syncs update the same gist instead of creating new ones.
// ---------------------------------------------------------------------
api.get('/sync/status', (req, res) => {
  res.json({
    gistId: getSetting('sync_gist_id', null),
    lastSyncedAt: getSetting('sync_last_at', null)
  });
});

api.post('/sync/push', async (req, res) => {
  const { token, passphrase } = req.body;
  if (!token || !passphrase) return res.status(400).json({ error: 'token and passphrase are required' });
  try {
    const exportData = {
      providers: db.prepare('SELECT * FROM providers').all(),
      accounts: db.prepare('SELECT * FROM accounts').all(),
      combos: db.prepare('SELECT * FROM combos').all(),
      settings: db.prepare("SELECT * FROM settings WHERE key NOT LIKE 'sync_%' AND key != 'gateway_key'").all()
    };
    const blob = sync.encrypt(exportData, passphrase);
    const existingGistId = getSetting('sync_gist_id', null);
    const gistId = await sync.pushToGist({ token, gistId: existingGistId, encryptedBlob: blob });
    setSetting('sync_gist_id', gistId);
    setSetting('sync_last_at', new Date().toISOString());
    res.json({ ok: true, gistId, url: `https://gist.github.com/${gistId}` });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

api.post('/sync/pull', async (req, res) => {
  const { token, passphrase } = req.body;
  if (!token || !passphrase) return res.status(400).json({ error: 'token and passphrase are required' });
  const gistId = getSetting('sync_gist_id', null);
  if (!gistId) return res.status(400).json({ error: 'No gist linked yet on this machine — push from the machine that has your config first' });
  try {
    const blob = await sync.pullFromGist({ token, gistId });
    const data = sync.decrypt(blob, passphrase);
    const tx = db.transaction(() => {
      for (const p of data.providers || []) db.prepare('INSERT OR REPLACE INTO providers (id, name, kind, base_url, enabled, created_at) VALUES (@id, @name, @kind, @base_url, @enabled, @created_at)').run(p);
      for (const a of data.accounts || []) db.prepare('INSERT OR REPLACE INTO accounts (id, provider_id, label, api_key, enabled, cooldown_until, last_used_at, created_at) VALUES (@id, @provider_id, @label, @api_key, @enabled, @cooldown_until, @last_used_at, @created_at)').run(a);
      for (const c of data.combos || []) db.prepare('INSERT OR REPLACE INTO combos (id, name, steps_json, is_default, strategy, created_at) VALUES (@id, @name, @steps_json, @is_default, @strategy, @created_at)').run({ strategy: 'ordered', ...c });
      for (const s of data.settings || []) db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (@key, @value_json)').run(s);
    });
    tx();
    setSetting('sync_last_at', new Date().toISOString());
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Allows linking to a gist created on another machine, before the first pull.
api.post('/sync/link', (req, res) => {
  const { gistId } = req.body;
  if (!gistId) return res.status(400).json({ error: 'gistId required' });
  setSetting('sync_gist_id', gistId);
  res.json({ ok: true });
});

app.use('/api', api);
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`bifrost gateway listening on http://localhost:${PORT}`);
  console.log(`dashboard:            http://localhost:${PORT}`);
  console.log(`OpenAI-compatible base: http://localhost:${PORT}/v1`);
  console.log(`gateway key:           ${getSetting('gateway_key')}`);
});
