const fetch = require('node-fetch');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

function toGeminiBody(body) {
  const contents = [];
  let systemInstruction;
  for (const m of body.messages || []) {
    if (m.role === 'system') {
      systemInstruction = { parts: [{ text: m.content }] };
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
  const text = (cand.content?.parts || []).map((p) => p.text || '').join('');
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: cand.finishReason === 'MAX_TOKENS' ? 'length' : 'stop'
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
function translateStreamLine(rawLine, ctx) {
  if (!rawLine.startsWith('data:')) return null;
  const data = rawLine.slice(5).trim();
  if (!data) return null;
  let evt;
  try { evt = JSON.parse(data); } catch { return null; }
  const cand = (evt.candidates || [])[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
  const finishReason = cand?.finishReason;

  const chunk = {
    id: ctx.id,
    object: 'chat.completion.chunk',
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: finishReason ? 'stop' : null }]
  };
  let out = `data: ${JSON.stringify(chunk)}\n\n`;
  if (finishReason) out += `data: [DONE]\n\n`;
  return out;
}

module.exports = {
  chat, listModels, normalizeResponse, extractUsage, translateStreamLine,
  kind: 'gemini'
};
