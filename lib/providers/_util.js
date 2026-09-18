// Parses Go-style/OpenAI-style compound durations: "6m0s", "1.5s", "500ms",
// "2h1m3s". Returns seconds (float) or null if unparseable.
function parseCompoundDuration(str) {
  if (!str) return null;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(str))) {
    matched = true;
    const value = parseFloat(m[1]);
    const unit = m[2];
    if (unit === 'ms') total += value / 1000;
    else if (unit === 's') total += value;
    else if (unit === 'm') total += value * 60;
    else if (unit === 'h') total += value * 3600;
  }
  return matched ? total : null;
}

// Standard HTTP `Retry-After` header: either an integer number of seconds,
// or an HTTP-date. Returns seconds or null.
function parseRetryAfterHeader(value) {
  if (!value) return null;
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber)) return asNumber;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, (date - Date.now()) / 1000);
  return null;
}

// Clamp so one bad header never sleeps an account for absurdly long or short.
function clampSeconds(seconds, min = 1, max = 600) {
  if (seconds === null || Number.isNaN(seconds)) return null;
  return Math.min(Math.max(seconds, min), max);
}

module.exports = { parseCompoundDuration, parseRetryAfterHeader, clampSeconds };
