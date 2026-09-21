require('dotenv').config();
const express = require('express');
const path = require('path');
const { db, nanoid, getSetting, setSetting } = require('./lib/db');
const { attemptChain, attemptEmbeddings, testAccount, listModelsForProvider, estimateCost, logRequest, getCombo } = require('./lib/router');
const { DEFAULT_CONFIG: COMPRESSION_DEFAULTS } = require('./lib/compression');
const sync = require('./lib/sync');
const auth = require('./lib/auth');
const anthropicFrontend = require('./lib/anthropic_frontend');

const app = express();
app.use(express.json({ limit: '25mb' }));

// Basic security headers on every response.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const PORT = process.env.PORT || 8787;
const BOOT_TIME = Date.now();
const DEFAULT_LOG_RETENTION_DAYS = 30;

// No auth — standard for health checks (Docker healthcheck, uptime
// monitors, load balancers all expect this to be reachable unauthenticated).
// Deliberately reveals nothing about configuration, just liveness.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime_seconds: Math.floor((Date.now() - BOOT_TIME) / 1000) });
});

// ---------------------------------------------------------------------
// Gateway auth: a local key so random processes on your machine can't
// silently spend your provider credits. Generated on first boot.
// ---------------------------------------------------------------------
if (!getSetting('gateway_key')) {
  setSetting('gateway_key', `bf-${nanoid(32)}`);
}
if (!getSetting('session_secret')) {
  setSetting('session_secret', nanoid(48));
}
function requireGatewayKey(req, res, next) {
  // Accept both auth styles: `Authorization: Bearer <key>` (most
  // OpenAI-SDK tools) and `x-api-key: <key>` (Anthropic-SDK tools like
  // Claude Code, which is what ANTHROPIC_API_KEY gets sent as).
  const authHeader = req.headers.authorization || '';
  const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const key = bearerKey || req.headers['x-api-key'] || null;
  if (key !== getSetting('gateway_key')) {
    return res.status(401).json({ error: { message: 'Invalid or missing gateway API key' } });
  }
  next();
}

// ---------------------------------------------------------------------
// Dashboard auth (human, browser-based). Separate concern from the
// gateway key above, which authenticates *tools* calling /v1/*. This
// protects the /api/* management surface (providers, accounts, API keys,
// logs, settings) — without it, anything that can reach this port can
// read every provider API key stored here.
//
// Stateless signed-cookie sessions (see lib/auth.js) rather than a
// session store: simple, and a server restart just means re-logging in.
// ---------------------------------------------------------------------
const SESSION_COOKIE = 'bifrost_session';

app.use((req, res, next) => {
  const cookies = auth.parseCookies(req.headers.cookie);
  req.session = { authenticated: auth.verifySession(cookies[SESSION_COOKIE], getSetting('session_secret')) };
  next();
});

function setSessionCookie(res) {
  const token = auth.signSession(getSetting('session_secret'));
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(auth.SESSION_TTL_MS / 1000)}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

const authApi = express.Router();

// --- In-memory rate limiter (per IP, sliding window) --------------------
// Applied to the auth endpoints so the dashboard password can't just be
// brute-forced. In-memory is fine here: a restart resetting the counters
// is an acceptable tradeoff for a single-process local tool, and this
// only needs to survive within one server lifetime.
const rateLimitBuckets = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = rateLimitBuckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateLimitBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfterSec);
      return res.status(429).json({ error: `Too many attempts — try again in ${retryAfterSec}s` });
    }
    next();
  };
}
const authRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
authApi.get('/status', (req, res) => {
  res.json({ needsSetup: !getSetting('dashboard_password_hash'), authenticated: req.session.authenticated });
});
authApi.post('/setup', authRateLimit, (req, res) => {
  if (getSetting('dashboard_password_hash')) return res.status(400).json({ error: 'Already set up — use /login instead' });
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  setSetting('dashboard_password_hash', auth.hashPassword(password));
  setSessionCookie(res);
  res.json({ ok: true });
});
authApi.post('/login', authRateLimit, (req, res) => {
  const hash = getSetting('dashboard_password_hash');
  if (!hash) return res.status(400).json({ error: 'No password set up yet' });
  const { password } = req.body;
  if (!auth.verifyPassword(password || '', hash)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  setSessionCookie(res);
  res.json({ ok: true });
});
authApi.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});
authApi.post('/change-password', authRateLimit, (req, res) => {
  if (!req.session.authenticated) return res.status(401).json({ error: 'Not authenticated' });
  const hash = getSetting('dashboard_password_hash');
  const { currentPassword, newPassword } = req.body;
  if (!auth.verifyPassword(currentPassword || '', hash)) return res.status(401).json({ error: 'Current password is wrong' });
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  setSetting('dashboard_password_hash', auth.hashPassword(newPassword));
  res.json({ ok: true });
});
app.use('/api/auth', authApi);

// Everything else under /api/* requires a valid dashboard session.
function requireDashboardAuth(req, res, next) {
  if (!getSetting('dashboard_password_hash')) {
    return res.status(403).json({ error: 'Dashboard not set up yet — visit the dashboard first to create a password' });
  }
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
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

app.post('/v1/embeddings', requireGatewayKey, async (req, res) => {
  const comboId = req.query.combo || req.header('x-bifrost-combo') || undefined;
  const { input } = req.body;
  if (!input) return res.status(400).json({ error: { message: 'input is required' } });
  try {
    const { result, provider, account, model, comboId: resolvedComboId } = await attemptEmbeddings(comboId, { input });
    const usage = result.usage || {};
    logRequest({
      combo_id: resolvedComboId, provider_id: provider.id, provider_name: provider.name, account_label: account.label,
      model, status: 'success',
      input_tokens: usage.prompt_tokens || 0, output_tokens: 0,
      cost_estimate: estimateCost(model, usage.prompt_tokens || 0, 0)
    });
    res.json(result);
  } catch (err) {
    logRequest({ combo_id: comboId, status: 'error', error: err.message });
    res.status(502).json({ error: { message: err.message } });
  }
});

app.get('/v1/models', requireGatewayKey, (req, res) => {
  const combos = db.prepare('SELECT * FROM combos').all();
  const models = new Set();
  combos.forEach((c) => JSON.parse(c.steps_json).forEach((s) => models.add(s.model)));
  res.json({ object: 'list', data: [...models].map((id) => ({ id, object: 'model' })) });
});

// ---------------------------------------------------------------------
// Anthropic-native endpoint — point Claude Code (or anything else that
// speaks the Anthropic Messages API rather than OpenAI's) at
// http://localhost:8787/v1. Translates in both directions (including
// tool-calling) around the exact same routing/fallback used above, so a
// Claude-Code request can transparently be served by Gemini or OpenAI.
// See lib/anthropic_frontend.js for the translation and its known gaps
// (inline images aren't translated across providers yet).
// ---------------------------------------------------------------------
app.post('/v1/messages', requireGatewayKey, async (req, res) => {
  const comboId = req.query.combo || req.header('x-bifrost-combo') || undefined;
  const anthropicBody = req.body;
  const requestedModel = anthropicBody.model;
  const openaiBody = anthropicFrontend.anthropicToOpenAI(anthropicBody);

  let attempt;
  try {
    attempt = await attemptChain(comboId, openaiBody);
  } catch (err) {
    logRequest({ combo_id: comboId, status: 'error', error: err.message });
    return res.status(502).json({ type: 'error', error: { type: 'api_error', message: err.message } });
  }

  const { res: upstream, adapter, provider, account, model, started } = attempt;
  const latency = () => Date.now() - started;

  if (anthropicBody.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const ctx = { id: `chatcmpl-${nanoid(12)}`, created: Math.floor(Date.now() / 1000), model, usage: null };
    const anthropicState = anthropicFrontend.createAnthropicStreamState(`msg_${nanoid(12)}`, requestedModel);
    let buffer = '';

    upstream.body.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const evt of events) {
        const dataLine = evt.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const openaiSse = adapter.translateStreamLine ? adapter.translateStreamLine(dataLine, ctx) : null;
        if (!openaiSse) continue;
        // Re-parse the OpenAI-shape chunk(s) we just produced and run them
        // through the second translation stage into Anthropic-shape events.
        for (const openaiEvt of openaiSse.split('\n\n')) {
          const openaiDataLine = openaiEvt.split('\n').find((l) => l.startsWith('data:'));
          if (!openaiDataLine) continue;
          const raw = openaiDataLine.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          let chunkJson;
          try { chunkJson = JSON.parse(raw); } catch { continue; }
          for (const anthropicEvt of anthropicFrontend.openaiChunkToAnthropicEvents(chunkJson, anthropicState)) {
            res.write(anthropicEvt);
          }
        }
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
    const openaiNormalized = adapter.normalizeResponse(json, model);
    const anthropicShaped = anthropicFrontend.openaiResponseToAnthropic(openaiNormalized, requestedModel);
    const usage = adapter.extractUsage(json);
    logRequest({
      combo_id: attempt.comboId, provider_id: provider.id, provider_name: provider.name,
      account_label: account.label, model, status: 'success',
      input_tokens: usage.input, output_tokens: usage.output,
      cost_estimate: estimateCost(model, usage.input, usage.output), latency_ms: latency()
    });
    res.json(anthropicShaped);
  } catch (err) {
    logRequest({ combo_id: attempt.comboId, provider_id: provider.id, provider_name: provider.name,
      account_label: account.label, model, status: 'error', error: err.message, latency_ms: latency() });
    res.status(502).json({ type: 'error', error: { type: 'api_error', message: `Upstream response parse error: ${err.message}` } });
  }
});

// ---------------------------------------------------------------------
// Dashboard REST API — everything here requires a logged-in dashboard
// session (see requireDashboardAuth above). Mounted under /api.
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
  // key_preview is the last 4 characters only — enough to tell accounts
  // apart in the UI without ever sending the real key back to the browser.
  const accounts = db.prepare("SELECT id, provider_id, label, enabled, cooldown_until, last_used_at, consecutive_failures, SUBSTR(api_key, -4) as key_preview FROM accounts").all();
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
api.post('/accounts/:id/test', async (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ ok: false, error: 'Account not found' });
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(account.provider_id);
  if (!provider) return res.status(404).json({ ok: false, error: 'Provider not found' });
  const { model } = req.body;
  if (!model) return res.status(400).json({ ok: false, error: 'model is required to test with' });
  const result = await testAccount({ provider, account, model });
  res.json(result);
});
api.get('/providers/:id/models', async (req, res) => {
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  const account = db.prepare('SELECT * FROM accounts WHERE provider_id = ? AND enabled = 1 LIMIT 1').get(provider.id);
  const models = await listModelsForProvider(provider, account);
  res.json({ models });
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

// One-shot setup: creates a provider, an account under it, and either a
// new default route or a new fallback step on the existing default route
// — all in one call, atomically. This is what backs the dashboard's
// single "Connect a provider" form, so a first-time user gets from zero
// to a working route without needing to understand that providers,
// accounts, and routes are three separate things first. Power users can
// still manage each piece individually afterward in Providers/Routes.
api.post('/quick-connect', async (req, res) => {
  const { name, kind, base_url, api_key, model } = req.body;
  if (!name || !kind || !api_key || !model) {
    return res.status(400).json({ error: 'name, kind, api_key, and model are required' });
  }
  try {
    const providerId = nanoid();
    const accountId = nanoid();
    let comboId;

    const tx = db.transaction(() => {
      db.prepare('INSERT INTO providers (id, name, kind, base_url) VALUES (?, ?, ?, ?)').run(providerId, name, kind, base_url || null);
      db.prepare('INSERT INTO accounts (id, provider_id, label, api_key) VALUES (?, ?, ?, ?)').run(accountId, providerId, 'main', api_key);

      const existingDefault = db.prepare('SELECT * FROM combos WHERE is_default = 1').get();
      if (existingDefault) {
        const steps = JSON.parse(existingDefault.steps_json);
        steps.push({ provider_id: providerId, model });
        db.prepare('UPDATE combos SET steps_json = ? WHERE id = ?').run(JSON.stringify(steps), existingDefault.id);
        comboId = existingDefault.id;
      } else {
        comboId = nanoid();
        db.prepare('INSERT INTO combos (id, name, steps_json, is_default, strategy) VALUES (?, ?, ?, 1, ?)')
          .run(comboId, 'default', JSON.stringify([{ provider_id: providerId, model }]), 'ordered');
      }
    });
    tx();

    res.json({ providerId, accountId, comboId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
api.delete('/logs', (req, res) => {
  // Manual "clear logs now" from the dashboard, independent of the
  // automatic retention sweep below.
  const days = req.query.olderThanDays ? parseInt(req.query.olderThanDays) : null;
  const result = days
    ? db.prepare("DELETE FROM request_logs WHERE ts < datetime('now', ?)").run(`-${days} days`)
    : db.prepare('DELETE FROM request_logs').run();
  res.json({ ok: true, deleted: result.changes });
});
api.get('/settings/log-retention', (req, res) => {
  res.json({ retentionDays: getSetting('log_retention_days', DEFAULT_LOG_RETENTION_DAYS) });
});
api.post('/settings/log-retention', (req, res) => {
  const days = Math.max(1, parseInt(req.body.retentionDays) || DEFAULT_LOG_RETENTION_DAYS);
  setSetting('log_retention_days', days);
  res.json({ retentionDays: days });
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
api.get('/stats/daily', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 14, 90);
  const rows = db.prepare(`
    SELECT date(ts) as day, COUNT(*) as requests, SUM(cost_estimate) as cost,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
    FROM request_logs
    WHERE date(ts) >= date('now', ?)
    GROUP BY date(ts)
    ORDER BY day ASC
  `).all(`-${days} days`);
  res.json(rows);
});

api.get('/settings/compression', (req, res) => {
  res.json({ ...COMPRESSION_DEFAULTS, ...getSetting('compression', {}) });
});
api.post('/settings/compression', (req, res) => {
  const { enabled, keepRecentMessages, maxToolResultChars } = req.body;
  const current = { ...COMPRESSION_DEFAULTS, ...getSetting('compression', {}) };
  const updated = {
    enabled: enabled === undefined ? current.enabled : !!enabled,
    keepRecentMessages: keepRecentMessages === undefined ? current.keepRecentMessages : Math.max(0, parseInt(keepRecentMessages) || 0),
    maxToolResultChars: maxToolResultChars === undefined ? current.maxToolResultChars : Math.max(200, parseInt(maxToolResultChars) || 200)
  };
  setSetting('compression', updated);
  res.json(updated);
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

app.use('/api', requireDashboardAuth, api);
app.use(express.static(path.join(__dirname, 'public')));

// Automatic log retention — request_logs grows unbounded otherwise, which
// matters once this is running unattended (Docker) rather than started
// fresh each session locally. Runs once on boot, then every 6 hours.
function pruneOldLogs() {
  const days = getSetting('log_retention_days', DEFAULT_LOG_RETENTION_DAYS);
  const result = db.prepare("DELETE FROM request_logs WHERE ts < datetime('now', ?)").run(`-${days} days`);
  if (result.changes > 0) console.log(`pruned ${result.changes} log entries older than ${days} days`);
}
pruneOldLogs();
setInterval(pruneOldLogs, 6 * 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`bifrost gateway listening on http://localhost:${PORT}`);
  console.log(`dashboard:            http://localhost:${PORT}`);
  console.log(`OpenAI-compatible base: http://localhost:${PORT}/v1`);
  console.log(`gateway key:           ${getSetting('gateway_key')}`);
});
