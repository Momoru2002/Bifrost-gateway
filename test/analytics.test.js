// Tests for the Analytics tab: pure helpers (percentiles, success rate) and
// the /api/stats/analytics endpoint against a real server + seeded DB.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { percentile, latencyByProvider, withSuccessRate } = require('../lib/analytics');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  PASS:', name); passed++; }
  else { console.log('  FAIL:', name, detail ? '\n    ' + detail : ''); failed++; }
}

// ---- Unit: percentile / latencyByProvider / withSuccessRate ----
console.log('Analytics helpers:');
const ten = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
check('percentile p50 of 10 values (nearest-rank) = 500', percentile(ten, 50) === 500);
check('percentile p95 of 10 values = 1000', percentile(ten, 95) === 1000);
check('percentile of a single value returns that value', percentile([42], 95) === 42);
check('percentile of empty array is null (rendered as "-")', percentile([], 50) === null);

const lat = latencyByProvider([
  { provider_name: 'A', latency_ms: 300 },
  { provider_name: 'A', latency_ms: 100 },
  { provider_name: 'A', latency_ms: 200 },
  { provider_name: 'B', latency_ms: 50 },
  { provider_name: 'A', latency_ms: 0 },      // zero latency = no real measurement, ignored
  { provider_name: null, latency_ms: 999 }    // no provider (failed before routing), ignored
]);
check('latencyByProvider ignores 0ms and provider-less rows', lat.length === 2 && lat[0].provider_name === 'A' && lat[0].samples === 3, JSON.stringify(lat));
check('latencyByProvider sorts unsorted input before taking percentiles', lat[0].p50 === 200 && lat[0].max === 300, JSON.stringify(lat[0]));
check('latencyByProvider orders providers by sample count', lat[1].provider_name === 'B');

const rates = withSuccessRate([{ day: 'd1', requests: 4, errors: 1 }, { day: 'd2', requests: 0, errors: 0 }]);
check('withSuccessRate computes 75% for 3/4 ok', rates[0].success_rate === 75, JSON.stringify(rates[0]));
check('withSuccessRate gives null (not NaN/100) for a day with no requests', rates[1].success_rate === null);

// ---- Integration: seeded DB through the real server ----
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'bifrost.sqlite');
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;

function req(method, urlPath, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${BASE}${urlPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json; try { json = JSON.parse(raw); } catch { json = raw; }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function startBifrost() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.on('error', reject);
    setTimeout(() => resolve(proc), 1500);
  });
}

(async () => {
  console.log('\n/api/stats/analytics endpoint:');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const f of ['bifrost.sqlite', 'bifrost.sqlite-shm', 'bifrost.sqlite-wal']) {
    fs.rmSync(path.join(DATA_DIR, f), { force: true });
  }

  const bifrost = await startBifrost();
  try {
    await req('POST', '/api/auth/setup', { body: { password: 'testpass123' } });
    const login = await req('POST', '/api/auth/login', { body: { password: 'testpass123' } });
    const cookie = (login.headers['set-cookie'] || [])[0]?.split(';')[0];

    // Seed rows straight into the DB the server is using.
    const db = new DatabaseSync(DB_FILE);
    db.prepare(`INSERT INTO combos (id, name, steps_json) VALUES ('combo-1', 'Route Utama', '[]')`).run();
    const ins = db.prepare(`INSERT INTO request_logs
      (id, ts, combo_id, provider_id, provider_name, model, status, input_tokens, output_tokens, cost_estimate, latency_ms)
      VALUES (?, datetime('now', ?), ?, 'p', ?, ?, ?, ?, ?, ?, ?)`);
    let n = 0;
    // 10 successful requests on provider "Alpha" with latencies 100..1000, today
    for (let i = 1; i <= 10; i++) ins.run(`s${n++}`, '-1 minutes', 'combo-1', 'Alpha', 'model-a', 'success', 10, 5, 0.01, i * 100);
    // 2 failed requests with tiny latency — must NOT drag p50/p95 down
    for (let i = 0; i < 2; i++) ins.run(`e${n++}`, '-1 minutes', 'combo-1', 'Alpha', 'model-a', 'error', 0, 0, 0, 5);
    // yesterday: 1 ok on a different model, no route (combo_id null)
    ins.run(`y${n++}`, '-1 days', null, 'Beta', 'model-b', 'success', 100, 50, 0.5, 250);
    // way outside the default 14-day window — must be excluded
    ins.run(`old${n++}`, '-40 days', 'combo-1', 'Alpha', 'model-old', 'success', 1, 1, 99, 99999);
    db.close();

    const res = await req('GET', '/api/stats/analytics?days=14', { cookie });
    check('endpoint responds 200 to an authenticated request', res.status === 200, JSON.stringify(res.json));
    const j = res.json;

    const alpha = j.latencyByProvider.find((p) => p.provider_name === 'Alpha');
    check('Alpha p50 = 500ms and p95 = 1000ms (errors excluded)', alpha && alpha.p50 === 500 && alpha.p95 === 1000, JSON.stringify(alpha));
    check('Alpha sample count only counts the 10 successes', alpha && alpha.samples === 10, JSON.stringify(alpha));

    const modelA = j.costByModel.find((m) => m.model === 'model-a');
    const modelB = j.costByModel.find((m) => m.model === 'model-b');
    check('cost by model sums correctly (10 x $0.01)', modelA && Math.abs(modelA.cost - 0.1) < 1e-9, JSON.stringify(modelA));
    check('cost by model is sorted most-expensive first', j.costByModel[0].model === 'model-b', JSON.stringify(j.costByModel.map((m) => m.model)));
    check('rows older than the window are excluded', !j.costByModel.some((m) => m.model === 'model-old'));
    check('model-b present with its own tokens', modelB && modelB.input_tokens === 100, JSON.stringify(modelB));

    check('success trend has one entry per day with data', j.successTrend.length === 2, JSON.stringify(j.successTrend));
    const today = j.successTrend[j.successTrend.length - 1];
    check('today success rate = 10/12 = 83.3%', today.requests === 12 && today.success_rate === 83.3, JSON.stringify(today));

    const route = j.byRoute.find((r) => r.route_name === 'Route Utama');
    check('per-route row joins the combo name', !!route, JSON.stringify(j.byRoute));
    check('per-route success rate and avg latency (successes only)', route && route.requests === 12 && route.success_rate === 83.3 && route.avg_latency_ms === 550, JSON.stringify(route));
    check('requests with no route are grouped under a fallback label', j.byRoute.some((r) => r.route_name.includes('tidak ada')), JSON.stringify(j.byRoute));

    const unauth = await req('GET', '/api/stats/analytics');
    check('endpoint requires dashboard auth', unauth.status === 401, String(unauth.status));

    const clamped = await req('GET', '/api/stats/analytics?days=99999', { cookie });
    check('days param is clamped to 90', clamped.json.days === 90, JSON.stringify(clamped.json.days));
  } finally {
    bifrost.kill();
    await new Promise((r) => setTimeout(r, 300));
    for (const f of ['bifrost.sqlite', 'bifrost.sqlite-shm', 'bifrost.sqlite-wal']) {
      fs.rmSync(path.join(DATA_DIR, f), { force: true });
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
