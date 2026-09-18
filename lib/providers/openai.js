const fetch = require('node-fetch');
const { parseRetryAfterHeader, parseCompoundDuration, clampSeconds } = require('./_util');

// OpenAI (and any openai_compatible provider) already speaks the format we
// expose, so this adapter is close to a passthrough. `baseUrl` lets this
// same adapter serve custom OpenAI-compatible providers (Groq, Together,
// local vLLM, etc.) by just pointing at a different base_url.

async function chat({ apiKey, baseUrl, model, body, signal }) {
  const url = `${baseUrl || 'https://api.openai.com'}/v1/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ ...body, model })
  });
  return res; // caller handles both streaming and non-streaming responses
}

async function listModels({ apiKey, baseUrl }) {
  const url = `${baseUrl || 'https://api.openai.com'}/v1/models`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}

// Response is already OpenAI-shaped; nothing to normalize.
function normalizeResponse(json) {
  return json;
}

// Usage is already in OpenAI's {prompt_tokens, completion_tokens} shape.
function extractUsage(json) {
  const u = json.usage || {};
  return { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 };
}

// Figures out how long to cool this account down for, using (in priority
// order): standard `retry-after` header, then OpenAI's own
// `x-ratelimit-reset-requests` / `x-ratelimit-reset-tokens` duration headers
// (format "6m0s", "1.5s"). Returns seconds, or null to let the caller fall
// back to a default.
function parseRetryAfter(res) {
  const direct = parseRetryAfterHeader(res.headers.get('retry-after'));
  if (direct !== null) return clampSeconds(direct);

  const resetRequests = parseCompoundDuration(res.headers.get('x-ratelimit-reset-requests'));
  const resetTokens = parseCompoundDuration(res.headers.get('x-ratelimit-reset-tokens'));
  const candidates = [resetRequests, resetTokens].filter((v) => v !== null);
  if (candidates.length) return clampSeconds(Math.max(...candidates));

  return null;
}

module.exports = { chat, listModels, normalizeResponse, extractUsage, parseRetryAfter, kind: 'openai' };
