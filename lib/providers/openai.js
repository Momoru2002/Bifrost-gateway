const fetch = require('node-fetch');

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

module.exports = { chat, listModels, normalizeResponse, extractUsage, kind: 'openai' };
