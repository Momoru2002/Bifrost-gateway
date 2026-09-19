const fetch = require('node-fetch');
const { parseRetryAfterHeader, clampSeconds } = require('./_util');

const ANTHROPIC_VERSION = '2023-06-01';

// --- OpenAI-shape request -> Anthropic request --------------------------
function toAnthropicBody(model, body) {
  const messages = body.messages || [];
  let system;
  const converted = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system = system ? `${system}\n${m.content}` : m.content;
      continue;
    }
    if (m.role === 'tool') {
      converted.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content || '' }] });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* leave empty on malformed JSON */ }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      converted.push({ role: 'assistant', content });
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
  if (body.tools && body.tools.length) {
    out.tools = body.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  }
  if (body.tool_choice) {
    if (body.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
    else if (body.tool_choice === 'required') out.tool_choice = { type: 'any' };
    else if (typeof body.tool_choice === 'object' && body.tool_choice.function) out.tool_choice = { type: 'tool', name: body.tool_choice.function.name };
  }
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
  const toolUseBlocks = (json.content || []).filter((b) => b.type === 'tool_use');
  const message = { role: 'assistant', content: text || null };
  if (toolUseBlocks.length) {
    message.tool_calls = toolUseBlocks.map((b) => ({
      id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
    }));
  }
  return {
    id: json.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: json.stop_reason === 'tool_use' ? 'tool_calls' : (json.stop_reason === 'max_tokens' ? 'length' : 'stop')
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
// Anthropic streams: message_start, content_block_start/delta/stop
// (text_delta for text blocks, input_json_delta for tool_use blocks),
// message_delta{usage}, message_stop. Re-emitted as OpenAI-style chunks,
// including tool_calls deltas so streamed tool-calling round-trips too.
function translateStreamLine(rawLine, ctx) {
  if (!rawLine.startsWith('data:')) return null;
  const data = rawLine.slice(5).trim();
  if (!data || data === '[DONE]') return null;
  let evt;
  try { evt = JSON.parse(data); } catch { return null; }

  if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
    ctx.toolBlocks = ctx.toolBlocks || {};
    const toolIndex = Object.keys(ctx.toolBlocks).length;
    ctx.toolBlocks[evt.index] = toolIndex;
    ctx.sawToolUse = true;
    const chunk = {
      id: ctx.id, object: 'chat.completion.chunk', created: ctx.created, model: ctx.model,
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: toolIndex, id: evt.content_block.id, type: 'function', function: { name: evt.content_block.name, arguments: '' } }] },
        finish_reason: null
      }]
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }
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
  if (evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta') {
    const toolIndex = ctx.toolBlocks?.[evt.index] ?? 0;
    const chunk = {
      id: ctx.id, object: 'chat.completion.chunk', created: ctx.created, model: ctx.model,
      choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex, function: { arguments: evt.delta.partial_json } }] }, finish_reason: null }]
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
      choices: [{ index: 0, delta: {}, finish_reason: ctx.sawToolUse ? 'tool_calls' : 'stop' }]
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
  chat, listModels, normalizeResponse, extractUsage, translateStreamLine, parseRetryAfter, toAnthropicBody,
  kind: 'anthropic'
};
