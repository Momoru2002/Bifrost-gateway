// Pure aggregation helpers for the Analytics tab. Kept free of DB/Express
// so they can be unit-tested directly (see test/analytics.test.js).

// Nearest-rank percentile on an already-sorted ascending array.
// Returns null for an empty array (callers render that as "-").
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

// rows: [{ provider_name, latency_ms }] — successful requests only.
// Failed requests are excluded on purpose: an instant "401 bad key" or a
// 120s timeout would distort what "how fast is this provider" means.
function latencyByProvider(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!r.provider_name || !(r.latency_ms > 0)) continue;
    if (!groups.has(r.provider_name)) groups.set(r.provider_name, []);
    groups.get(r.provider_name).push(r.latency_ms);
  }
  return [...groups.entries()]
    .map(([provider_name, arr]) => {
      arr.sort((a, b) => a - b);
      return {
        provider_name,
        samples: arr.length,
        p50: percentile(arr, 50),
        p95: percentile(arr, 95),
        max: arr[arr.length - 1]
      };
    })
    .sort((a, b) => b.samples - a.samples);
}

// rows: [{ day, requests, errors }] -> adds success_rate (0-100, null if no requests)
function withSuccessRate(rows) {
  return rows.map((r) => ({
    ...r,
    success_rate: r.requests > 0 ? Math.round(((r.requests - (r.errors || 0)) / r.requests) * 1000) / 10 : null
  }));
}

module.exports = { percentile, latencyByProvider, withSuccessRate };
