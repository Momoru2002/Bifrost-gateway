const fetch = require('node-fetch');
const { parseRetryAfterHeader, clampSeconds } = require('./_util');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

function toGeminiBody(body) {
  const contents = [];
  let systemInstruction;
  // Gemini has no "id" concept for tool calls the way OpenAI/Anthropic do —
  // functionResponse is matched back to a call by function *name*, so this
  // tracks which name a given OpenAI tool_call_id belongs to.
  const toolCallNameById = {};

  for (const m of body.messages || []) {
    if (m.role === 'system') {
      systemInstruction = { parts: [{ text: m.content }] };
      continue;
    }
    if (m.role === 'tool') {
      const name = toolCallNameById[m.tool_call_id] || 'unknown_function';
      contents.push({ role: 'user', parts: [{ functionResponse: { name, response: { result: m.content } } }] });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls) {
        toolCallNameById[tc.id] = tc.function.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* leave empty on malformed JSON */ }
        parts.push({ functionCall: { name: tc.function.name, args } });
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
    });
  }
  const out = {
    contents,
    generationConfig: {
      maxOutputTokens: body.max_tokens || 4096,
      temperature: body.temperature,
      topP: body.top_p
    }
  };
  if (systemInstruction) out.systemInstruction = systemInstruction;
  if (body.tools && body.tools.length) {
    out.tools = [{
      functionDeclarations: body.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
      }))
    }];
  }
  return out;
}

async function chat({ apiKey, model, body, signal }) {
  const streaming = !!body.stream;
  const method = streaming ? 'streamGenerateContent' : 'generateContent';
  const url = `${BASE}/models/${model}:${method}?key=${apiKey}${streaming ? '&alt=sse' : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toGeminiBody(body))
  });
  return res;
}

async function listModels({ apiKey }) {
  const res = await fetch(`${BASE}/models?key=${apiKey}`);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.models || []).map((m) => m.name.replace('models/', ''));
}

function normalizeResponse(json, requestedModel) {
  const cand = (json.candidates || [])[0] || {};
  const parts = cand.content?.parts || [];
  const text = parts.filter((p) => p.text).map((p) => p.text).join('');
  const functionCalls = parts.filter((p) => p.functionCall);

  const message = { role: 'assistant', content: text || null };
  if (functionCalls.length) {
    message.tool_calls = functionCalls.map((p, i) => ({
      id: `toolu_${Date.now()}_${i}`,
      type: 'function',
      function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) }
    }));
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: functionCalls.length ? 'tool_calls' : (cand.finishReason === 'MAX_TOKENS' ? 'length' : 'stop')
      }
    ],
    usage: {
      prompt_tokens: json.usageMetadata?.promptTokenCount || 0,
      completion_tokens: json.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: json.usageMetadata?.totalTokenCount || 0
    }
  };
}

function extractUsage(json) {
  return {
    input: json.usageMetadata?.promptTokenCount || 0,
    output: json.usageMetadata?.candidatesTokenCount || 0
  };
}

// Gemini SSE sends full-object deltas per event (alt=sse -> `data: {...}` per chunk,
// each chunk already just the incremental candidate). Re-emit as OpenAI chunks.
// Unlike OpenAI/Anthropic, Gemini typically delivers a functionCall as one
// complete part in a single chunk rather than fragmented JSON deltas, so
// it's re-emitted as one complete tool_calls delta rather than streamed
// incrementally — still valid OpenAI-shape, just delivered in one piece.
function translateStreamLine(rawLine, ctx) {
  if (!rawLine.startsWith('data:')) return null;
  const data = rawLine.slice(5).trim();
  if (!data) return null;
  let evt;
  try { evt = JSON.parse(data); } catch { return null; }
  const cand = (evt.candidates || [])[0];
  const parts = cand?.content?.parts || [];
  const text = parts.filter((p) => p.text).map((p) => p.text).join('');
  const functionCalls = parts.filter((p) => p.functionCall);
  const finishReason = cand?.finishReason;

  const delta = {};
  if (text) delta.content = text;
  if (functionCalls.length) {
    delta.tool_calls = functionCalls.map((p, i) => ({
      index: i,
      id: `toolu_${Date.now()}_${i}`,
      type: 'function',
      function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) }
    }));
  }

  const chunk = {
    id: ctx.id,
    object: 'chat.completion.chunk',
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, delta, finish_reason: finishReason ? (functionCalls.length ? 'tool_calls' : 'stop') : null }]
  };
  let out = `data: ${JSON.stringify(chunk)}\n\n`;
  if (finishReason) out += `data: [DONE]\n\n`;
  return out;
}

// Gemini rarely sets a `retry-after` header; the useful signal is a
// RetryInfo object buried in the JSON error body, e.g.
// { error: { details: [{ "@type": ".../RetryInfo", retryDelay: "31s" }] } }.
// bodyText is the already-read response body (router reads it once and
// reuses it, since a Response body can only be consumed once).
function parseRetryAfter(res, bodyText) {
  const direct = parseRetryAfterHeader(res.headers.get('retry-after'));
  if (direct !== null) return clampSeconds(direct);

  if (bodyText) {
    try {
      const json = JSON.parse(bodyText);
      const details = json?.error?.details || [];
      const retryInfo = details.find((d) => typeof d.retryDelay === 'string');
      if (retryInfo) {
        const seconds = parseFloat(retryInfo.retryDelay.replace('s', ''));
        if (!Number.isNaN(seconds)) return clampSeconds(seconds);
      }
    } catch { /* not JSON or unexpected shape; fall through */ }
  }
  return null;
}

// Gemini's embedding API is call-shaped differently per single-vs-batch
// input (embedContent vs batchEmbedContents) and its own request/response
// shape, so unlike chat's mostly-shared plumbing this gets a dedicated path.
async function embeddings({ apiKey, model, input, signal }) {
  const inputs = Array.isArray(input) ? input : [input];
  const isBatch = inputs.length > 1;
  const url = isBatch
    ? `${BASE}/models/${model}:batchEmbedContents?key=${apiKey}`
    : `${BASE}/models/${model}:embedContent?key=${apiKey}`;
  const body = isBatch
    ? { requests: inputs.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] } })) }
    : { content: { parts: [{ text: inputs[0] }] } };
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res;
}

function normalizeEmbeddingsResponse(json, requestedModel) {
  const vectors = json.embeddings ? json.embeddings.map((e) => e.values) : [json.embedding.values];
  return {
    object: 'list',
    data: vectors.map((embedding, index) => ({ object: 'embedding', embedding, index })),
    model: requestedModel,
    usage: { prompt_tokens: 0, total_tokens: 0 } // Gemini's embedding API doesn't report token usage
  };
}

module.exports = {
  chat, embeddings, normalizeEmbeddingsResponse, listModels, normalizeResponse, extractUsage, translateStreamLine, parseRetryAfter, toGeminiBody,
  kind: 'gemini'
};
