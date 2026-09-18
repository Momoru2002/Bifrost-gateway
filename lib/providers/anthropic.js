const fetch = require('node-fetch');
const { parseRetryAfterHeader, clampSeconds } = require('./_util');

const ANTHROPIC_VERSION = '2023-06-01';

// --- OpenAI request -> Anthropic request ------------------------------
function toAnthropicBody(model, body) {
  const messages = body.messages || [];
  let system;
  const converted = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system = system ? `${system}\n${m.content}` : m.content;
      continue;
    }
    converted.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content : m.content
    });
  }
  const out = {
    model,
    max_tokens: body.max_tokens || 4096,
    messages: converted,
    stream: !!body.stream
  };
  if (system) out.system = system;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  return out;
}

async function chat({ apiKey, model, body, signal }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify(toAnthropicBody(model, body))
  });
  return res;
}

async function listModels() {
  // Anthropic has no public list-models endpoint keyed to arbitrary API keys;
  // return a static, commonly-used set. Editable from the dashboard later.
  return ['claude-sonnet-4-6', 'claude-opus-4-1', 'claude-haiku-4-5-20251001'];
}

// --- Anthropic response -> OpenAI response -----------------------------
function normalizeResponse(json, requestedModel) {
  const text = (json.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return {
    id: json.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: json.stop_reason === 'max_tokens' ? 'length' : 'stop'
      }
    ],
    usage: {
      prompt_tokens: json.usage?.input_tokens || 0,
      completion_tokens: json.usage?.output_tokens || 0,
      total_tokens: (json.usage?.input_tokens || 0) + (json.usage?.output_tokens || 0)
    }
  };
}

function extractUsage(json) {
  return { input: json.usage?.input_tokens || 0, output: json.usage?.output_tokens || 0 };
}

// --- Anthropic SSE -> OpenAI-style SSE chunks --------------------------
// Anthropic streams: message_start, content_block_delta{text_delta}, message_delta{usage}, message_stop
// We re-emit each text delta as an OpenAI "chat.completion.chunk".
function translateStreamLine(rawLine, ctx) {
  if (!rawLine.startsWith('data:')) return null;
  const data = rawLine.slice(5).trim();
  if (!data || data === '[DONE]') return null;
  let evt;
  try { evt = JSON.parse(data); } catch { return null; }

  if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
    const chunk = {
      id: ctx.id,
      object: 'chat.completion.chunk',
      created: ctx.created,
      model: ctx.model,
      choices: [{ index: 0, delta: { content: evt.delta.text }, finish_reason: null }]
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }
  if (evt.type === 'message_delta' && evt.usage) {
    ctx.usage = { input: ctx.usage?.input || 0, output: evt.usage.output_tokens || 0 };
  }
  if (evt.type === 'message_stop') {
    const chunk = {
      id: ctx.id,
      object: 'chat.completion.chunk',
      created: ctx.created,
      model: ctx.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    };
    return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
  }
  return null;
}

// Anthropic sends a standard `retry-after` header on 429s. It also exposes
// `anthropic-ratelimit-requests-reset` / `anthropic-ratelimit-tokens-reset`
// as RFC3339 timestamps, used as a fallback if retry-after is missing.
function parseRetryAfter(res) {
  const direct = parseRetryAfterHeader(res.headers.get('retry-after'));
  if (direct !== null) return clampSeconds(direct);

  const resetTimestamps = [
    res.headers.get('anthropic-ratelimit-requests-reset'),
    res.headers.get('anthropic-ratelimit-tokens-reset')
  ].filter(Boolean).map((t) => Date.parse(t)).filter((t) => !Number.isNaN(t));

  if (resetTimestamps.length) {
    const latest = Math.max(...resetTimestamps);
    return clampSeconds((latest - Date.now()) / 1000);
  }
  return null;
}

module.exports = {
  chat, listModels, normalizeResponse, extractUsage, translateStreamLine, parseRetryAfter,
  kind: 'anthropic'
};
