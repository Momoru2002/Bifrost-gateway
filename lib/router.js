const { db, nanoid, getSetting } = require('./db');
const adapters = {
  openai: require('./providers/openai'),
  openai_compatible: require('./providers/openai'),
  anthropic: require('./providers/anthropic'),
  gemini: require('./providers/gemini')
};

// Rough $/1M token pricing so the dashboard can show *estimated* cost.
// Editable via settings; falls back to a generic guess if model unknown.
const DEFAULT_PRICING = {
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-opus-4-1': { in: 15, out: 75 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'gemini-2.0-flash': { in: 0.1, out: 0.4 },
  'gemini-1.5-pro': { in: 1.25, out: 5 }
};

function estimateCost(model, input, output) {
  const pricing = getSetting('pricing', DEFAULT_PRICING);
  const rate = pricing[model] || { in: 1, out: 3 }; // generic fallback guess
  return (input / 1e6) * rate.in + (output / 1e6) * rate.out;
}

// A rough per-token "price tier" for a model, used only to rank steps
// relative to each other for the 'cost' strategy — not a real cost estimate
// (we don't know actual token counts before the call completes).
function modelPriceTier(model) {
  const pricing = getSetting('pricing', DEFAULT_PRICING);
  const rate = pricing[model] || { in: 1, out: 3 };
  return rate.in + rate.out;
}

// Weighted random shuffle (without replacement): each step is picked with
// probability proportional to its weight among what's left. Used so a
// 'weighted' route spreads load across providers/accounts instead of always
// hitting the same one first, without needing a hard fallback order.
function weightedShuffle(steps) {
  const pool = steps.map((s) => ({ step: s, weight: s.weight && s.weight > 0 ? s.weight : 1 }));
  const ordered = [];
  while (pool.length) {
    const total = pool.reduce((sum, p) => sum + p.weight, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) {
      r -= pool[idx].weight;
      if (r <= 0) break;
    }
    ordered.push(pool.splice(Math.min(idx, pool.length - 1), 1)[0].step);
  }
  return ordered;
}

// Decides the order steps are attempted in, based on the combo's strategy.
// 'ordered' (default): exactly as configured — a strict fallback chain.
// 'cost': cheapest-modeled-price-first, falling back to the next cheapest.
// 'weighted': random order weighted by each step's `weight`, for load spread.
function orderSteps(combo) {
  const steps = combo.steps;
  if (combo.strategy === 'cost') {
    return [...steps].sort((a, b) => modelPriceTier(a.model) - modelPriceTier(b.model));
  }
  if (combo.strategy === 'weighted') {
    return weightedShuffle(steps);
  }
  return steps;
}

function getCombo(comboId) {
  const row = comboId
    ? db.prepare('SELECT * FROM combos WHERE id = ?').get(comboId)
    : db.prepare('SELECT * FROM combos WHERE is_default = 1').get();
  if (!row) return null;
  return { ...row, steps: JSON.parse(row.steps_json) };
}

function eligibleAccounts(providerId) {
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT * FROM accounts
    WHERE provider_id = ? AND enabled = 1
      AND (cooldown_until IS NULL OR cooldown_until < ?)
    ORDER BY (last_used_at IS NULL) DESC, last_used_at ASC
  `).all(providerId, now);
}

function markUsed(accountId) {
  db.prepare('UPDATE accounts SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), accountId);
}
function markCooldown(accountId, seconds) {
  const until = new Date(Date.now() + seconds * 1000).toISOString();
  db.prepare('UPDATE accounts SET cooldown_until = ? WHERE id = ?').run(until, accountId);
}

function logRequest(fields) {
  db.prepare(`
    INSERT INTO request_logs (id, combo_id, provider_id, provider_name, account_label, model, status, input_tokens, output_tokens, cost_estimate, latency_ms, error)
    VALUES (@id, @combo_id, @provider_id, @provider_name, @account_label, @model, @status, @input_tokens, @output_tokens, @cost_estimate, @latency_ms, @error)
  `).run({
    id: nanoid(),
    combo_id: fields.combo_id || null,
    provider_id: fields.provider_id || null,
    provider_name: fields.provider_name || null,
    account_label: fields.account_label || null,
    model: fields.model || null,
    status: fields.status,
    input_tokens: fields.input_tokens || 0,
    output_tokens: fields.output_tokens || 0,
    cost_estimate: fields.cost_estimate || 0,
    latency_ms: fields.latency_ms || 0,
    error: fields.error || null
  });
}

// Walks the combo's fallback chain: for each {provider, model} step, try every
// eligible account for that provider before moving to the next step.
// Returns { res, adapter, provider, account, model, comboId, started } on
// the first success, or throws after every option is exhausted.
async function attemptChain(comboId, overrideBody) {
  const combo = getCombo(comboId);
  if (!combo) throw new Error('No combo found (create one, or mark one as default, in the dashboard)');

  const errors = [];
  for (const step of orderSteps(combo)) {
    const provider = db.prepare('SELECT * FROM providers WHERE id = ? AND enabled = 1').get(step.provider_id);
    if (!provider) continue;
    const adapter = adapters[provider.kind];
    if (!adapter) continue;

    for (const account of eligibleAccounts(provider.id)) {
      const started = Date.now();
      try {
        const res = await adapter.chat({
          apiKey: account.api_key,
          baseUrl: provider.base_url,
          model: step.model,
          body: overrideBody
        });

        if (res.status === 429) {
          // Rate limited: read the body once (some providers put retry info
          // there, not in headers) and cool this account down for exactly as
          // long as the provider says, instead of a blind flat guess.
          const text = await res.text().catch(() => '');
          const suggested = adapter.parseRetryAfter ? adapter.parseRetryAfter(res, text) : null;
          const cooldownSeconds = suggested ?? 60; // fallback guess if provider gave no signal
          markCooldown(account.id, cooldownSeconds);
          errors.push(`${provider.name}/${account.label}: rate limited (429), cooling down ${Math.round(cooldownSeconds)}s`);
          continue;
        }
        if (res.status >= 500) {
          // Transient server-side hiccup, not a hard rate limit — short
          // cooldown so we don't hammer it, but don't sideline the account long.
          markCooldown(account.id, 10);
          const text = await res.text().catch(() => '');
          errors.push(`${provider.name}/${account.label}: HTTP ${res.status} ${text.slice(0, 200)}`);
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          errors.push(`${provider.name}/${account.label}: HTTP ${res.status} ${text.slice(0, 200)}`);
          continue;
        }

        markUsed(account.id);
        return { res, adapter, provider, account, model: step.model, comboId: combo.id, started };
      } catch (err) {
        errors.push(`${provider.name}/${account.label}: ${err.message}`);
      }
    }
  }
  throw new Error(`All providers/accounts exhausted:\n${errors.join('\n')}`);
}

module.exports = { attemptChain, estimateCost, logRequest, getCombo, orderSteps, weightedShuffle, modelPriceTier, DEFAULT_PRICING };
