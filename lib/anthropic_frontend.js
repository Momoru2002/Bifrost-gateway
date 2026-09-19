// Fronts /v1/messages (the Anthropic-native protocol Claude Code and other
// Anthropic-SDK-based tools speak) on top of Bifrost's internal routing,
// which works in OpenAI-shape end to end. This file only translates
// shapes — the actual provider fan-out/fallback is unchanged, reusing
// lib/router.js exactly as the OpenAI-facing /v1/chat/completions endpoint
// does. That's what lets a Claude-Code request get served by Gemini or
// OpenAI behind the scenes: whichever provider adapter runs, it already
// speaks OpenAI-shape in and out.
//
// Known gap: inline image content blocks are flagged with a placeholder
// rather than translated end-to-end — real multi-provider image support
// would need every adapter updated together, tracked separately.

const { nanoid } = require('./db');

// --- Anthropic request -> OpenAI-shape request --------------------------
function anthropicToOpenAI(body) {
  const messages = [];

  if (body.system) {
    const sysText = typeof body.system === 'string'
      ? body.system
      : (body.system || []).map((b) => b.text || '').join('\n');
    if (sysText) messages.push({ role: 'system', content: sysText });
  }

  for (const m of body.messages || []) {
    if (typeof m.content === 'string' || m.content == null) {
      messages.push({ role: m.role, content: m.content || '' });
      continue;
    }

    let textBuffer = '';
    let toolCalls = [];
    const flushText = () => {
      if (textBuffer) { messages.push({ role: m.role, content: textBuffer }); textBuffer = ''; }
    };
    const flushToolCalls = () => {
      if (toolCalls.length) {
        messages.push({ role: 'assistant', content: textBuffer || null, tool_calls: toolCalls });
        textBuffer = '';
        toolCalls = [];
      }
    };

    for (const block of m.content) {
      if (block.type === 'text') {
        textBuffer += (textBuffer ? '\n' : '') + block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
        });
      } else if (block.type === 'tool_result') {
        flushToolCalls();
        flushText();
        const resultText = Array.isArray(block.content)
          ? block.content.map((c) => c.text || '').join('\n')
          : (block.content || '');
        messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: resultText });
      } else if (block.type === 'image') {
        textBuffer += (textBuffer ? '\n' : '') + '[image omitted — Bifrost does not translate inline images across providers yet]';
      }
    }
    flushToolCalls();
    flushText();
  }

  const out = { model: body.model, messages, max_tokens: body.max_tokens || 4096, stream: !!body.stream };
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop_sequences) out.stop = body.stop_sequences;
  if (body.tools && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema }
    }));
  }
  if (body.tool_choice) {
    if (body.tool_choice.type === 'auto') out.tool_choice = 'auto';
    else if (body.tool_choice.type === 'any') out.tool_choice = 'required';
    else if (body.tool_choice.type === 'tool') out.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
  }
  return out;
}

const STOP_REASON_MAP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'end_turn' };

// --- OpenAI-shape response -> Anthropic response (non-streaming) -------
function openaiResponseToAnthropic(json, requestedModel) {
  const choice = (json.choices || [])[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* leave empty on malformed JSON */ }
    content.push({ type: 'tool_use', id: tc.id || `toolu_${nanoid(12)}`, name: tc.function.name, input });
  }
  return {
    id: json.id || `msg_${nanoid(12)}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: STOP_REASON_MAP[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: json.usage?.prompt_tokens || 0,
      output_tokens: json.usage?.completion_tokens || 0
    }
  };
}

// --- OpenAI-shape SSE chunk -> Anthropic SSE event(s) (streaming) ------
// Anthropic's stream is block-based and stateful (message_start ->
// content_block_start/delta/stop, repeated -> message_delta ->
// message_stop), unlike OpenAI's flatter per-token deltas, so this needs
// to track open/closed block state across calls.
function createAnthropicStreamState(id, model) {
  return { started: false, blockIndex: -1, blockOpen: false, toolIndexMap: {}, id, model, outputTokens: 0 };
}

function sse(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function openaiChunkToAnthropicEvents(chunk, state) {
  const events = [];
  if (chunk.usage?.completion_tokens) state.outputTokens = chunk.usage.completion_tokens;

  if (!state.started) {
    state.started = true;
    events.push(sse('message_start', {
      type: 'message_start',
      message: {
        id: state.id, type: 'message', role: 'assistant', content: [], model: state.model,
        stop_reason: null, stop_sequence: null,
        // Real input token count isn't known until the provider's own
        // final usage arrives, which is after message_start must already
        // have gone out — this starts at 0 as a known cosmetic gap.
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    }));
  }

  const choice = (chunk.choices || [])[0];
  if (!choice) return events;
  const delta = choice.delta || {};

  if (delta.content) {
    if (!state.blockOpen || state.blockType !== 'text') {
      if (state.blockOpen) events.push(sse('content_block_stop', { type: 'content_block_stop', index: state.blockIndex }));
      state.blockIndex += 1;
      state.blockOpen = true;
      state.blockType = 'text';
      events.push(sse('content_block_start', { type: 'content_block_start', index: state.blockIndex, content_block: { type: 'text', text: '' } }));
    }
    events.push(sse('content_block_delta', { type: 'content_block_delta', index: state.blockIndex, delta: { type: 'text_delta', text: delta.content } }));
  }

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!(idx in state.toolIndexMap)) {
        if (state.blockOpen) events.push(sse('content_block_stop', { type: 'content_block_stop', index: state.blockIndex }));
        state.blockIndex += 1;
        state.blockOpen = true;
        state.blockType = 'tool_use';
        state.toolIndexMap[idx] = state.blockIndex;
        events.push(sse('content_block_start', {
          type: 'content_block_start', index: state.blockIndex,
          content_block: { type: 'tool_use', id: tc.id || `toolu_${nanoid(8)}`, name: tc.function?.name || '', input: {} }
        }));
      }
      if (tc.function?.arguments) {
        events.push(sse('content_block_delta', {
          type: 'content_block_delta', index: state.toolIndexMap[idx],
          delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
        }));
      }
    }
  }

  if (choice.finish_reason) {
    if (state.blockOpen) {
      events.push(sse('content_block_stop', { type: 'content_block_stop', index: state.blockIndex }));
      state.blockOpen = false;
    }
    events.push(sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: STOP_REASON_MAP[choice.finish_reason] || 'end_turn', stop_sequence: null },
      usage: { output_tokens: state.outputTokens }
    }));
    events.push(sse('message_stop', { type: 'message_stop' }));
  }
  return events;
}

module.exports = { anthropicToOpenAI, openaiResponseToAnthropic, createAnthropicStreamState, openaiChunkToAnthropicEvents };
