// Regression tests for the protocol translation layer (lib/anthropic_frontend.js
// and the tool-calling paths in the provider adapters) — the part of Bifrost
// most likely to silently break in a way that only shows up as "Claude Code's
// tool calls stopped working," not as a crash. No network access needed:
// everything here operates on plain objects. Run with: npm test
const assert = require('assert');
const af = require('../lib/anthropic_frontend');
const anthropicAdapter = require('../lib/providers/anthropic');
const geminiAdapter = require('../lib/providers/gemini');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS:', name); passed++; }
  catch (e) { console.log('  FAIL:', name, '\n    ', e.message); failed++; }
}

console.log('Protocol translation:');

const claudeCodeRequest = {
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  system: 'You are a coding assistant.',
  stream: false,
  tools: [
    { name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
  ],
  messages: [
    { role: 'user', content: 'Read package.json' },
    { role: 'assistant', content: [
      { type: 'text', text: 'Sure, let me check.' },
      { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'package.json' } }
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_01', content: '{"name":"demo"}' }
    ] }
  ]
};

let openaiBody;
check('anthropicToOpenAI: produces valid OpenAI-shape body', () => {
  openaiBody = af.anthropicToOpenAI(claudeCodeRequest);
  assert.strictEqual(openaiBody.messages[0].role, 'system');
  assert.strictEqual(openaiBody.messages[2].tool_calls[0].function.name, 'read_file');
  assert.deepStrictEqual(JSON.parse(openaiBody.messages[2].tool_calls[0].function.arguments), { path: 'package.json' });
  assert.strictEqual(openaiBody.messages[3].role, 'tool');
  assert.strictEqual(openaiBody.messages[3].tool_call_id, 'toolu_01');
  assert.strictEqual(openaiBody.tools[0].function.name, 'read_file');
});

check('anthropic.js toAnthropicBody: reconstructs tool_use/tool_result blocks', () => {
  const rebuilt = anthropicAdapter.toAnthropicBody('claude-sonnet-4-6', openaiBody);
  assert.strictEqual(rebuilt.messages[1].content[1].type, 'tool_use');
  assert.deepStrictEqual(rebuilt.messages[1].content[1].input, { path: 'package.json' });
  assert.strictEqual(rebuilt.messages[2].content[0].type, 'tool_result');
  assert.strictEqual(rebuilt.tools[0].name, 'read_file');
});

check('gemini.js toGeminiBody: converts to functionCall/functionResponse', () => {
  const geminiBody = geminiAdapter.toGeminiBody(openaiBody);
  assert.strictEqual(geminiBody.tools[0].functionDeclarations[0].name, 'read_file');
  const assistantTurn = geminiBody.contents.find((c) => c.role === 'model' && c.parts.some((p) => p.functionCall));
  assert.ok(assistantTurn, 'expected a model-role turn with a functionCall part');
  assert.strictEqual(assistantTurn.parts.find((p) => p.functionCall).functionCall.name, 'read_file');
  const responseTurn = geminiBody.contents.find((c) => c.parts.some((p) => p.functionResponse));
  assert.ok(responseTurn, 'expected a turn with a functionResponse part');
});

check('openaiResponseToAnthropic: text + tool_use response shape', () => {
  const openaiResp = {
    choices: [{ message: { role: 'assistant', content: 'Done reading.', tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }
    ] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  };
  const anthropicResp = af.openaiResponseToAnthropic(openaiResp, 'claude-sonnet-4-6');
  assert.strictEqual(anthropicResp.content[1].type, 'tool_use');
  assert.deepStrictEqual(anthropicResp.content[1].input, { path: 'a.txt' });
  assert.strictEqual(anthropicResp.stop_reason, 'tool_use');
});

check('gemini.js normalizeResponse: functionCall part -> tool_calls', () => {
  const geminiResp = {
    candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'x.txt' } } }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 }
  };
  const normalized = geminiAdapter.normalizeResponse(geminiResp, 'gemini-2.0-flash');
  assert.strictEqual(normalized.choices[0].message.tool_calls[0].function.name, 'read_file');
  assert.strictEqual(normalized.choices[0].finish_reason, 'tool_calls');
});

check('anthropic.js translateStreamLine: tool_use block streaming', () => {
  const ctx = { id: 'chatcmpl-y', created: 123, model: 'claude-sonnet-4-6' };
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_02', name: 'read_file', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"b.txt"}' } },
    { type: 'message_stop' }
  ];
  const outputs = events.map((e) => anthropicAdapter.translateStreamLine(`data: ${JSON.stringify(e)}`, ctx)).filter(Boolean);
  const firstChunk = JSON.parse(outputs[0].split('\n')[0].slice(6));
  assert.strictEqual(firstChunk.choices[0].delta.tool_calls[0].function.name, 'read_file');
  assert.ok(outputs[outputs.length - 1].includes('"finish_reason":"tool_calls"'));
});

check('openaiChunkToAnthropicEvents: text then tool_call then finish, correct event sequence', () => {
  const state = af.createAnthropicStreamState('msg_test', 'claude-sonnet-4-6');
  const chunks = [
    { choices: [{ delta: { content: 'Checking' }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"c.txt"}' } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { completion_tokens: 12 } }
  ];
  const allEvents = chunks.flatMap((c) => af.openaiChunkToAnthropicEvents(c, state));
  const eventTypes = allEvents.map((e) => e.match(/^event: (\w+)/)[1]);
  assert.deepStrictEqual(eventTypes, [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_stop', 'content_block_start', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop'
  ]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
