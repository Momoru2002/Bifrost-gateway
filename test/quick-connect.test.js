// Regression tests for two related fixes:
//   1. POST /api/quick-connect now verifies the key/model against the real
//      provider before saving anything (previously it inserted blindly and
//      always reported success).
//   2. GET /api/logs now carries the `error` field through to the dashboard
//      (previously stored in the DB but never rendered), so a failed
//      request is diagnosable instead of showing only "-  -  error".
//
// Run with: npm test
// Spins up a mock upstream "provider" HTTP server plus a real instance of
// the Bifrost server itself (pointed at a scratch sqlite file), and drives
// both over HTTP the same way the dashboard / a real client would.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  PASS:', name); passed++; }
  else { console.log('  FAIL:', name, detail ? '\n    ' + detail : ''); failed++; }
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'bifrost.sqlite');
const BIFROST_PORT = 8799;
const MOCK_PORT = 8798;
const BASE = `http://127.0.0.1:${BIFROST_PORT}`;

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
        let json;
        try { json = JSON.parse(raw); } catch { json = raw; }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// A tiny mock "OpenAI-compatible" upstream: /v1/chat/completions accepts
// only Authorization: Bearer good-key and rejects everything else with a
// distinctive error body, so we can prove that error string round-trips
// all the way to the dashboard's /api/logs response.
function startMockProvider() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        const auth = req.headers['authorization'] || '';
        if (auth === 'Bearer good-key') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'x', object: 'chat.completion', model: 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }
          }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'MOCK_INVALID_API_KEY: the key you sent is wrong' } }));
        }
      } else {
        res.writeHead(404); res.end('{}');
      }
    });
    server.listen(MOCK_PORT, () => resolve(server));
  });
}

function startBifrost() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(BIFROST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let ready = false;
    const onData = (d) => {
      if (!ready && d.toString().match(/listening|running|8799|Bifrost/i)) {
        ready = true;
        setTimeout(() => resolve(proc), 300); // small settle margin
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    // Fallback: if we never see a matching log line, just try after a beat.
    setTimeout(() => { if (!ready) { ready = true; resolve(proc); } }, 1500);
  });
}

function postChat(key) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] });
    const r = http.request(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let raw = ''; res.on('data', (c) => (raw += c));
      res.on('end', () => { let j; try { j = JSON.parse(raw); } catch { j = raw; } resolve({ status: res.statusCode, json: j }); });
    });
    r.write(body); r.end();
  });
}

(async () => {
  // Scratch DB so this never touches a real dev database.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

  console.log('Quick-connect validation + logs error surfacing:');
  const mock = await startMockProvider();
  const bifrost = await startBifrost();

  try {
    // First-time setup + login, same as a fresh dashboard.
    const setup = await req('POST', '/api/auth/setup', { body: { password: 'testpass123' } });
    check('dashboard setup succeeds', setup.status === 200, JSON.stringify(setup.json));
    const login = await req('POST', '/api/auth/login', { body: { password: 'testpass123' } });
    const cookie = (login.headers['set-cookie'] || [])[0]?.split(';')[0];
    check('login returns a session cookie', !!cookie);

    // --- Bug fix #1 setup: reproduce the exact screenshot scenario — zero
    // providers/routes configured yet, then a real client hits the gateway.
    // This must fail with "no combo found" AND that error must be visible
    // later in GET /api/logs (previously it was stored but never surfaced).
    const keyResEarly = await req('GET', '/api/gateway-key', { cookie });
    const chatFailNoRoute = await postChat(keyResEarly.json.key);
    check('a request with zero providers/routes configured fails as expected', chatFailNoRoute.status === 502, JSON.stringify(chatFailNoRoute.json));

    const logsNoRoute = await req('GET', '/api/logs?limit=5', { cookie });
    const hasErrorField = Array.isArray(logsNoRoute.json) && logsNoRoute.json.length > 0 && typeof logsNoRoute.json[0].error === 'string' && logsNoRoute.json[0].error.length > 0;
    check('GET /api/logs includes a non-empty error field for the frontend to render', hasErrorField, JSON.stringify(logsNoRoute.json[0]));

    // --- Bug fix #2: quick-connect with a bad key must fail, not silently save ---
    const bad = await req('POST', '/api/quick-connect', {
      cookie,
      body: { name: 'Bad Test Provider', kind: 'openai_compatible', base_url: `http://127.0.0.1:${MOCK_PORT}`, api_key: 'wrong-key', model: 'mock-model' }
    });
    check('quick-connect rejects an invalid key (was: always 200 before this fix)', bad.status === 400, JSON.stringify(bad.json));
    check('quick-connect surfaces the real upstream error text', typeof bad.json.error === 'string' && bad.json.error.includes('MOCK_INVALID_API_KEY'), JSON.stringify(bad.json));

    const providersAfterBad = await req('GET', '/api/providers', { cookie });
    check('a rejected quick-connect does not leave a ghost provider in the DB', providersAfterBad.json.length === 0, JSON.stringify(providersAfterBad.json));

    // --- Bug fix #2, happy path: a valid key still connects normally ---
    const good = await req('POST', '/api/quick-connect', {
      cookie,
      body: { name: 'Good Test Provider', kind: 'openai_compatible', base_url: `http://127.0.0.1:${MOCK_PORT}`, api_key: 'good-key', model: 'mock-model' }
    });
    check('quick-connect still succeeds with a valid key', good.status === 200, JSON.stringify(good.json));

    // Confirm the dashboard bundle itself actually reads/escapes/renders it now.
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    check('public/app.js renders l.error in the Logs table (was previously dropped)', /l\.error/.test(appJs) && /log-error/.test(appJs));
    check('public/app.js escapes error text before inserting into the DOM', /escapeHtml\(l\.error/.test(appJs));
  } finally {
    bifrost.kill();
    mock.close();
    fs.rmSync(DB_FILE, { force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
