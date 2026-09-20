// Lightweight prompt compression: long tool results from earlier in a
// conversation get truncated before being sent upstream, since an agent
// rarely needs the full text of a file it read five turns ago once it's
// moved on — only the most recent tool outputs are likely still
// load-bearing context.
//
// This is NOT semantic caching or a diff-based scheme (unlike some other
// gateways' RTK-style compression) — it's a simple, predictable truncation
// heuristic that trades a little context fidelity for real token savings
// on long agentic sessions (the kind Claude Code racks up fast). Disabled
// changes nothing; even enabled, only OLD tool-role messages beyond a
// configurable recency window are ever touched, and only when they exceed
// a size threshold.

const DEFAULT_CONFIG = {
  enabled: true,
  keepRecentMessages: 6,    // never touch the last N messages, any role
  maxToolResultChars: 4000  // tool-role content longer than this gets truncated
};

function truncateMiddle(text, maxChars) {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars;
  const omitted = text.length - maxChars;
  return `${text.slice(0, headChars)}\n...[${omitted} characters truncated by Bifrost to save tokens]...\n${text.slice(text.length - tailChars)}`;
}

// messages: OpenAI-shape message array (Bifrost's internal representation
// regardless of which frontend protocol the request came in on). Always
// returns { messages, savedChars } for a consistent call-site shape.
function compressMessages(messages, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.enabled || !Array.isArray(messages)) return { messages, savedChars: 0 };
  const cutoff = messages.length - cfg.keepRecentMessages;
  let savedChars = 0;
  const out = messages.map((m, i) => {
    if (i >= cutoff) return m; // recent messages are always sent in full
    if (m.role !== 'tool' || typeof m.content !== 'string') return m;
    if (m.content.length <= cfg.maxToolResultChars) return m;
    savedChars += m.content.length - cfg.maxToolResultChars;
    return { ...m, content: truncateMiddle(m.content, cfg.maxToolResultChars) };
  });
  return { messages: out, savedChars };
}

module.exports = { compressMessages, DEFAULT_CONFIG };
