// Regression tests for lib/compression.js. Run with: npm test
const assert = require('assert');
const { compressMessages } = require('../lib/compression');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS:', name); passed++; }
  catch (e) { console.log('  FAIL:', name, '\n    ', e.message); failed++; }
}

console.log('Token compression:');

const longContent = 'x'.repeat(5000);
function buildConversation() {
  return [
    { role: 'user', content: 'turn1' },
    { role: 'assistant', content: 'ok', tool_calls: [{ id: '1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '1', content: longContent }, // old once conversation grows
    { role: 'user', content: 'turn2' },
    { role: 'assistant', content: 'ok2' },
    { role: 'user', content: 'turn3' },
    { role: 'assistant', content: 'ok3' },
    { role: 'user', content: 'turn4' },
    { role: 'assistant', content: 'ok4', tool_calls: [{ id: '2', type: 'function', function: { name: 'y', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '2', content: longContent } // recent — within the default keep window
  ];
}

check('old, oversized tool_result gets truncated with a marker', () => {
  const { messages: out, savedChars } = compressMessages(buildConversation(), { enabled: true, keepRecentMessages: 6, maxToolResultChars: 4000 });
  assert.ok(out[2].content.length < longContent.length);
  assert.ok(out[2].content.includes('truncated by Bifrost'));
  assert.strictEqual(savedChars, longContent.length - 4000);
});

check('recent tool_result within the keep window is untouched', () => {
  const { messages: out } = compressMessages(buildConversation(), { enabled: true, keepRecentMessages: 6, maxToolResultChars: 4000 });
  assert.strictEqual(out[9].content.length, longContent.length);
});

check('non-tool and short messages are never touched', () => {
  const { messages: out } = compressMessages(buildConversation(), { enabled: true, keepRecentMessages: 6, maxToolResultChars: 4000 });
  assert.strictEqual(out[0].content, 'turn1');
  assert.strictEqual(out[3].content, 'turn2');
});

check('disabled is a true no-op', () => {
  const { messages: out, savedChars } = compressMessages(buildConversation(), { enabled: false });
  assert.strictEqual(out[2].content.length, longContent.length);
  assert.strictEqual(savedChars, 0);
});

check('non-array input passes through unchanged rather than throwing', () => {
  const { messages: out } = compressMessages(undefined, { enabled: true });
  assert.strictEqual(out, undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
