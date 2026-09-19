const fetch = require('node-fetch');
const { parseRetryAfterHeader, parseCompoundDuration, clampSeconds } = require('./_util');

// OpenAI (and any openai_compatible provider) already speaks the format we
// expose, so this adapter is close to a passthrough. `baseUrl` lets this
// same adapter serve custom OpenAI-compatible providers (Groq, Together,
// local vLLM, etc.) by just pointing at a different base_url.

async function chat({ apiKey, baseUrl, model, body, signal }) {
  const url = `${baseUrl || 'https://api.openai.com'}/v1/chat/completions`;
  const outBody = { ...body, model };
  // Ask for usage on the final SSE chunk when streaming, so we can log real
  // token counts instead of leaving streamed requests unmeasured. This is a
  // standard OpenAI schema field; OpenAI-compatible third parties that don't
  // recognize it generally just ignore unknown fields.
  if (outBody.stream) {
    outBody.stream_options = { ...(outBody.stream_options || {}), include_usage: true };
  }
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(outBody)
  });
  return res; // caller handles both streaming and non-streaming responses
}

// OpenAI already has a native /v1/embeddings endpoint in the exact shape
// we expose, so — like chat() — this is close to a passthrough.
async function embeddings({ apiKey, baseUrl, model, input, signal }) {
  const url = `${baseUrl || 'https://api.openai.com'}/v1/embeddings`;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input })
  });
  return res;
}

// Already OpenAI-shaped; nothing to normalize.
function normalizeEmbeddingsResponse(json) {
  return json;
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

// OpenAI streams already match the shape we expose, so we don't need to
// translate the chunk — just pass it straight through. The only reason to
// touch each line at all is to peek for the `usage` object OpenAI attaches
// to the final chunk (present because chat() sets stream_options.include_usage),
// so the router can log real token counts for streamed requests too.
function translateStreamLine(rawLine, ctx) {
  if (!rawLine.startsWith('data:')) return null;
  const data = rawLine.slice(5).trim();
  if (!data) return null;
  if (data !== '[DONE]') {
    try {
      const evt = JSON.parse(data);
      if (evt.usage) {
        ctx.usage = { input: evt.usage.prompt_tokens || 0, output: evt.usage.completion_tokens || 0 };
      }
    } catch { /* not JSON we can parse; still pass it through below */ }
  }
  return `${rawLine}\n\n`;
}

module.exports = {
  chat, embeddings, normalizeEmbeddingsResponse, listModels, normalizeResponse, extractUsage, parseRetryAfter, translateStreamLine,
  kind: 'openai'
};
