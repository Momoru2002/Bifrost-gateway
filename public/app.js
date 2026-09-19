const view = document.getElementById('view');
const toastEl = document.getElementById('toast');

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 2200);
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    // Session expired or not logged in — bounce to the login screen instead
    // of letting every tab's fetch fail silently with a generic error.
    renderLogin();
    throw new Error('Session expired, please log in again');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

const KIND_LABEL = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', openai_compatible: 'OpenAI-compatible' };
const DEFAULT_TEST_MODEL = { openai: 'gpt-4o-mini', anthropic: 'claude-haiku-4-5-20251001', gemini: 'gemini-2.0-flash', openai_compatible: '' };

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------
document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  render(btn.dataset.tab);
});

function render(tab) {
  const renderers = { overview: renderOverview, providers: renderProviders, combos: renderCombos, logs: renderLogs, settings: renderSettings };
  (renderers[tab] || renderOverview)();
}

// ---------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------
async function renderOverview() {
  view.innerHTML = `<h1>Overview</h1><p class="subhead">Status jaringan gateway lu, hari ini.</p><div id="ov-body">Loading…</div>`;
  const [stats, providers] = await Promise.all([api('/stats'), api('/providers')]);
  const t = stats.totals || {};
  const activeAccounts = providers.reduce((n, p) => n + p.accounts.filter((a) => a.enabled).length, 0);

  document.getElementById('ov-body').innerHTML = `
    <div class="grid-3">
      <div class="stat"><div class="label">Total requests</div><div class="value">${t.requests || 0}</div></div>
      <div class="stat"><div class="label">Estimated cost</div><div class="value">$${(t.cost || 0).toFixed(4)}</div></div>
      <div class="stat"><div class="label">Errors</div><div class="value">${t.errors || 0}</div></div>
    </div>
    <div class="grid-3" style="margin-top:16px">
      <div class="stat"><div class="label">Providers configured</div><div class="value">${providers.length}</div></div>
      <div class="stat"><div class="label">Active accounts</div><div class="value">${activeAccounts}</div></div>
      <div class="stat"><div class="label">Tokens in / out</div><div class="value" style="font-size:16px">${t.input_tokens || 0} / ${t.output_tokens || 0}</div></div>
    </div>
    <div class="panel" style="margin-top:18px">
      <h2>Usage per provider</h2>
      ${
        stats.byProvider.length
          ? `<table><thead><tr><th>Provider</th><th>Requests</th><th>Cost</th></tr></thead><tbody>
              ${stats.byProvider.map((p) => `<tr><td>${p.provider_name}</td><td>${p.requests}</td><td>$${(p.cost || 0).toFixed(4)}</td></tr>`).join('')}
            </tbody></table>`
          : `<div class="empty">Belum ada request. Hit endpoint /v1/chat/completions buat mulai lihat data.</div>`
      }
    </div>
  `;
}

// ---------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------
async function renderProviders() {
  view.innerHTML = `
    <h1>Providers</h1>
    <p class="subhead">Tiap provider bisa punya beberapa account (API key) — gateway rotasi & fallback otomatis di antara mereka.</p>
    <div class="panel">
      <h2>Tambah provider baru</h2>
      <form id="add-provider-form">
        <label>Nama (bebas, buat lu sendiri)</label>
        <input name="name" placeholder="mis. OpenAI utama" required />
        <label>Tipe</label>
        <select name="kind">
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="gemini">Google Gemini</option>
          <option value="openai_compatible">OpenAI-compatible lain (Groq, Together, local vLLM, dst.)</option>
        </select>
        <div id="base-url-field" style="display:none">
          <label>Base URL</label>
          <input name="base_url" placeholder="https://api.groq.com/openai" />
        </div>
        <div style="margin-top:14px"><button class="btn primary" type="submit">Tambah provider</button></div>
      </form>
    </div>
    <div id="provider-list"></div>
  `;

  const form = document.getElementById('add-provider-form');
  form.kind.addEventListener('change', () => {
    document.getElementById('base-url-field').style.display = form.kind.value === 'openai_compatible' ? 'block' : 'none';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    await api('/providers', { method: 'POST', body: { name: fd.get('name'), kind: fd.get('kind'), base_url: fd.get('base_url') } });
    toast('Provider ditambahkan');
    renderProviders();
  });

  const providers = await api('/providers');
  const list = document.getElementById('provider-list');
  if (!providers.length) {
    list.innerHTML = `<div class="empty">Belum ada provider. Tambah satu di atas dulu.</div>`;
    return;
  }
  list.innerHTML = providers.map((p) => `
    <div class="provider-card" data-provider="${p.id}">
      <div class="row-between">
        <div class="row"><span class="badge kind-${p.kind}">${KIND_LABEL[p.kind] || p.kind}</span><strong>${p.name}</strong></div>
        <div class="row">
          <button class="btn small toggle-provider" data-id="${p.id}" data-enabled="${p.enabled}">${p.enabled ? 'Enabled' : 'Disabled'}</button>
          <button class="btn small danger del-provider" data-id="${p.id}">Hapus</button>
        </div>
      </div>
      ${p.accounts.map((a) => {
        const cooldownMs = a.cooldown_until ? new Date(a.cooldown_until) - new Date() : 0;
        const onCooldown = cooldownMs > 0;
        return `
        <div class="account-row" data-account-row="${a.id}">
          <span>${a.label} ${onCooldown ? `<span class="badge" style="color:var(--warn);border-color:var(--warn-dim)">cooldown ${Math.ceil(cooldownMs / 1000)}s</span>` : ''}</span>
          <span class="row">
            <span class="test-result" data-test-result="${a.id}" style="font-size:11.5px;color:var(--text-dim)"></span>
            <button class="btn small test-account" data-id="${a.id}" data-kind="${p.kind}">Test</button>
            <span class="status-dot ${!a.enabled ? 'error' : onCooldown ? 'warn' : 'ok'}"></span>
            <button class="btn small danger del-account" data-id="${a.id}">Hapus</button>
          </span>
        </div>
      `;
      }).join('') || '<div class="empty" style="padding:10px 0">Belum ada account/API key.</div>'}
      <form class="add-account-form" data-provider="${p.id}" style="margin-top:12px">
        <div class="row">
          <input name="label" placeholder="label (mis. akun-1)" required style="flex:1" />
          <input name="api_key" placeholder="API key" required type="password" style="flex:2" />
          <button class="btn small" type="submit">+ Account</button>
        </div>
      </form>
    </div>
  `).join('');

  list.querySelectorAll('.add-account-form').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    await api('/accounts', { method: 'POST', body: { provider_id: f.dataset.provider, label: fd.get('label'), api_key: fd.get('api_key') } });
    toast('Account ditambahkan');
    renderProviders();
  }));
  list.querySelectorAll('.del-account').forEach((b) => b.addEventListener('click', async () => {
    await api(`/accounts/${b.dataset.id}`, { method: 'DELETE' });
    renderProviders();
  }));
  list.querySelectorAll('.test-account').forEach((b) => b.addEventListener('click', async () => {
    const kind = b.dataset.kind;
    const defaultModel = DEFAULT_TEST_MODEL[kind] || '';
    const model = prompt('Model buat test koneksi:', defaultModel);
    if (!model) return;
    const resultEl = document.querySelector(`[data-test-result="${b.dataset.id}"]`);
    b.disabled = true;
    resultEl.textContent = 'Testing…';
    resultEl.style.color = 'var(--text-dim)';
    try {
      const result = await api(`/accounts/${b.dataset.id}/test`, { method: 'POST', body: { model } });
      if (result.ok) {
        resultEl.textContent = `OK — "${(result.sample || '').slice(0, 40)}"`;
        resultEl.style.color = 'var(--signal)';
      } else {
        resultEl.textContent = `Gagal: ${(result.error || 'unknown error').slice(0, 60)}`;
        resultEl.style.color = 'var(--danger)';
      }
    } catch (err) {
      resultEl.textContent = 'Gagal: ' + err.message;
      resultEl.style.color = 'var(--danger)';
    } finally {
      b.disabled = false;
    }
  }));
  list.querySelectorAll('.del-provider').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Hapus provider ini beserta semua account-nya?')) return;
    await api(`/providers/${b.dataset.id}`, { method: 'DELETE' });
    renderProviders();
  }));
  list.querySelectorAll('.toggle-provider').forEach((b) => b.addEventListener('click', async () => {
    const enabled = b.dataset.enabled === '1' ? 0 : 1;
    await api(`/providers/${b.dataset.id}`, { method: 'PATCH', body: { enabled: !!enabled } });
    renderProviders();
  }));
}

// ---------------------------------------------------------------------
// Combos (routes / fallback chains)
// ---------------------------------------------------------------------
let comboSteps = [];

async function renderCombos() {
  const providers = await api('/providers');
  view.innerHTML = `
    <h1>Routes</h1>
    <p class="subhead">Satu route = urutan fallback provider+model. Kalau langkah pertama gagal/limit, gateway otomatis coba langkah berikutnya.</p>
    <div class="panel">
      <h2>Buat route baru</h2>
      <form id="combo-form">
        <label>Nama route</label>
        <input name="name" placeholder="mis. default-coding" required />
        <label>Strategi</label>
        <select name="strategy" id="strategy-select">
          <option value="ordered">Ordered fallback — coba sesuai urutan langkah</option>
          <option value="cost">Least cost — coba yang termurah dulu, fallback ke lebih mahal</option>
          <option value="weighted">Weighted random — sebar beban sesuai bobot tiap langkah</option>
        </select>
        <label>Tambah langkah</label>
        <div class="row">
          <select id="step-provider" style="flex:1">
            ${providers.map((p) => `<option value="${p.id}">${p.name}</option>`).join('')}
          </select>
          <input id="step-model" placeholder="nama model, mis. gpt-4o-mini" style="flex:1" />
          <input id="step-weight" type="number" min="1" value="1" placeholder="bobot" style="flex:0 0 70px; display:none" />
          <button type="button" id="add-step-btn" class="btn small">+ Langkah</button>
        </div>
        <div id="steps-preview" style="margin-top:12px"></div>
        <label class="row" style="margin-top:14px"><input type="checkbox" name="is_default" style="width:auto" /> &nbsp;Jadikan default route</label>
        <div style="margin-top:14px"><button class="btn primary" type="submit">Simpan route</button></div>
      </form>
    </div>
    <div id="combo-list"></div>
  `;

  document.getElementById('strategy-select').addEventListener('change', (e) => {
    document.getElementById('step-weight').style.display = e.target.value === 'weighted' ? 'block' : 'none';
  });

  if (!providers.length) {
    document.querySelector('#combo-form').innerHTML = `<div class="empty">Tambah provider dulu di tab Providers sebelum bikin route.</div>`;
  }

  comboSteps = [];
  const preview = document.getElementById('steps-preview');
  function drawPreview() {
    preview.innerHTML = comboSteps.map((s, i) => `
      <span class="step-chip"><span class="step-order">${i + 1}</span> ${providerName(providers, s.provider_id)} / ${s.model}${s.weight && s.weight !== 1 ? ` <span style="color:var(--text-dim)">(bobot ${s.weight})</span>` : ''}
        <button type="button" data-i="${i}" class="rm-step" style="background:none;border:none;color:var(--text-dim);cursor:pointer">✕</button>
      </span>
    `).join(' ');
    preview.querySelectorAll('.rm-step').forEach((b) => b.addEventListener('click', () => {
      comboSteps.splice(+b.dataset.i, 1);
      drawPreview();
    }));
  }

  document.getElementById('add-step-btn').addEventListener('click', () => {
    const providerId = document.getElementById('step-provider').value;
    const model = document.getElementById('step-model').value.trim();
    if (!providerId || !model) return toast('Isi model dulu');
    const strategy = document.getElementById('strategy-select').value;
    const weight = strategy === 'weighted' ? (parseInt(document.getElementById('step-weight').value) || 1) : undefined;
    comboSteps.push(weight ? { provider_id: providerId, model, weight } : { provider_id: providerId, model });
    document.getElementById('step-model').value = '';
    drawPreview();
  });

  document.getElementById('combo-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!comboSteps.length) return toast('Tambah minimal 1 langkah fallback');
    const fd = new FormData(e.target);
    await api('/combos', { method: 'POST', body: { name: fd.get('name'), steps: comboSteps, strategy: fd.get('strategy'), is_default: fd.get('is_default') === 'on' } });
    toast('Route disimpan');
    renderCombos();
  });

  const combos = await api('/combos');
  const list = document.getElementById('combo-list');
  const STRATEGY_LABEL = { ordered: 'Ordered fallback', cost: 'Least cost', weighted: 'Weighted random' };
  list.innerHTML = combos.length ? combos.map((c) => `
    <div class="panel">
      <div class="row-between">
        <div class="row">
          <strong>${c.name}</strong>
          <span class="badge">${STRATEGY_LABEL[c.strategy] || 'Ordered fallback'}</span>
          ${c.is_default ? '<span class="badge" style="color:var(--signal);border-color:var(--signal-dim)">default</span>' : ''}
        </div>
        <button class="btn small danger del-combo" data-id="${c.id}">Hapus</button>
      </div>
      <div style="margin-top:10px">
        ${c.steps.map((s, i) => `<span class="step-chip"><span class="step-order">${i + 1}</span> ${providerName(providers, s.provider_id)} / ${s.model}${s.weight && s.weight !== 1 ? ` <span style="color:var(--text-dim)">(bobot ${s.weight})</span>` : ''}</span>`).join(' ')}
      </div>
      ${c.strategy && c.strategy !== 'ordered' ? `<div style="color:var(--text-dim);font-size:12px;margin-top:8px">Urutan aktual per-request bisa beda dari daftar di atas — ${c.strategy === 'cost' ? 'termurah dicoba duluan' : 'dipilih random sesuai bobot'}.</div>` : ''}
    </div>
  `).join('') : `<div class="empty">Belum ada route.</div>`;

  list.querySelectorAll('.del-combo').forEach((b) => b.addEventListener('click', async () => {
    await api(`/combos/${b.dataset.id}`, { method: 'DELETE' });
    renderCombos();
  }));
}
function providerName(providers, id) {
  return providers.find((p) => p.id === id)?.name || '(deleted)';
}

// ---------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------
async function renderLogs() {
  view.innerHTML = `<h1>Logs</h1><p class="subhead">100 request terakhir.</p><div id="log-body">Loading…</div>`;
  const logs = await api('/logs?limit=100');
  document.getElementById('log-body').innerHTML = logs.length ? `
    <table>
      <thead><tr><th>Waktu</th><th>Provider</th><th>Model</th><th>Status</th><th>Tokens</th><th>Cost</th><th>Latency</th></tr></thead>
      <tbody>
        ${logs.map((l) => `
          <tr>
            <td>${new Date(l.ts + 'Z').toLocaleTimeString()}</td>
            <td>${l.provider_name || '-'}${l.account_label ? ' / ' + l.account_label : ''}</td>
            <td>${l.model || '-'}</td>
            <td><span class="status-dot ${l.status === 'success' ? 'ok' : 'error'}"></span>${l.status}</td>
            <td>${l.input_tokens || 0}/${l.output_tokens || 0}</td>
            <td>$${(l.cost_estimate || 0).toFixed(5)}</td>
            <td>${l.latency_ms || 0}ms</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : `<div class="empty">Belum ada log request.</div>`;
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------
async function renderSettings() {
  const { key } = await api('/gateway-key');
  const syncStatus = await api('/sync/status');
  view.innerHTML = `
    <h1>Settings</h1>
    <p class="subhead">Konfigurasi lokal gateway lu.</p>
    <div class="panel">
      <h2>Gateway API key</h2>
      <p style="color:var(--text-dim);font-size:13px;margin-top:-6px">Pakai key ini sebagai Bearer token pas nunjuk tool (Claude Code, Cursor, dll) ke <code>http://localhost:8787/v1</code>. Ini bukan API key provider — ini kunci lokal biar cuma tool lu yang bisa lewat gateway.</p>
      <div class="key-box" id="gw-key">${key}</div>
      <div style="margin-top:10px"><button class="btn small" id="regen-key">Regenerate key</button></div>
    </div>
    <div class="panel">
      <h2>Cloud sync</h2>
      <p style="color:var(--text-dim);font-size:13px;margin-top:-6px">
        Sync provider, account, dan route ke mesin lain lewat <strong>private GitHub Gist</strong> milik lu sendiri.
        Config dienkripsi (AES-256) pakai passphrase lu <em>sebelum</em> dikirim — GitHub cuma nyimpen ciphertext,
        gak pernah liat API key asli lu. Token GitHub &amp; passphrase gak pernah disimpen di sini, cuma dipakai sekali pas proses push/pull.
      </p>
      <div style="font-size:12.5px;color:var(--text-dim);margin-bottom:10px">
        Status: ${syncStatus.gistId
          ? `terhubung ke <a href="https://gist.github.com/${syncStatus.gistId}" target="_blank" style="color:var(--signal)">gist ${syncStatus.gistId.slice(0, 8)}…</a>${syncStatus.lastSyncedAt ? ` · terakhir sync ${new Date(syncStatus.lastSyncedAt).toLocaleString()}` : ''}`
          : 'belum pernah sync dari mesin ini'}
      </div>
      <label>GitHub Personal Access Token</label>
      <input type="password" id="sync-token" placeholder="ghp_... (scope: gist)" />
      <label>Passphrase enkripsi</label>
      <input type="password" id="sync-passphrase" placeholder="passphrase buat enkripsi config lu" />
      <div class="row" style="margin-top:14px">
        <button class="btn primary small" id="sync-push">Push ke cloud</button>
        <button class="btn small" id="sync-pull">Pull dari cloud</button>
      </div>
      <details style="margin-top:14px">
        <summary style="cursor:pointer;color:var(--text-dim);font-size:12.5px">Mesin baru, mau pull dari gist yang udah ada?</summary>
        <div style="margin-top:10px">
          <label>Gist ID</label>
          <input id="sync-link-id" placeholder="id gist dari mesin sebelumnya" />
          <div style="margin-top:10px"><button class="btn small" id="sync-link">Hubungkan</button></div>
        </div>
      </details>
    </div>
    <div class="panel">
      <h2>Password dashboard</h2>
      <p style="color:var(--text-dim);font-size:13px;margin-top:-6px">Password buat login ke dashboard ini (bukan API key provider).</p>
      <form id="change-password-form">
        <label>Password sekarang</label>
        <input type="password" id="current-password" required />
        <label>Password baru (min. 6 karakter)</label>
        <input type="password" id="new-password" required minlength="6" />
        <div style="margin-top:14px"><button class="btn small" type="submit">Ganti password</button></div>
      </form>
    </div>
    <div class="panel">
      <h2>Export / Import config (manual, file lokal)</h2>
      <p style="color:var(--text-dim);font-size:13px;margin-top:-6px">Backup atau pindahin config lewat file, tanpa GitHub. File berisi API key dalam plain text — simpan aman, jangan commit ke repo publik.</p>
      <div class="row">
        <button class="btn small" id="export-btn">Export ke file</button>
        <label class="btn small" style="cursor:pointer">Import dari file<input type="file" id="import-file" accept="application/json" style="display:none" /></label>
      </div>
    </div>
  `;
  document.getElementById('regen-key').addEventListener('click', async () => {
    if (!confirm('Regenerate gateway key? Tool yang udah pakai key lama harus update.')) return;
    const { key } = await api('/gateway-key/regenerate', { method: 'POST' });
    document.getElementById('gw-key').textContent = key;
    toast('Key baru dibuat');
  });
  document.getElementById('change-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = document.getElementById('current-password').value;
    const newPassword = document.getElementById('new-password').value;
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
      toast('Password berhasil diganti');
      e.target.reset();
    } catch (err) { toast('Gagal: ' + err.message); }
  });
  document.getElementById('sync-push').addEventListener('click', async () => {
    const token = document.getElementById('sync-token').value.trim();
    const passphrase = document.getElementById('sync-passphrase').value;
    if (!token || !passphrase) return toast('Isi token dan passphrase dulu');
    try {
      await api('/sync/push', { method: 'POST', body: { token, passphrase } });
      toast('Config berhasil di-push ke cloud');
      renderSettings();
    } catch (e) { toast('Gagal push: ' + e.message); }
  });
  document.getElementById('sync-pull').addEventListener('click', async () => {
    const token = document.getElementById('sync-token').value.trim();
    const passphrase = document.getElementById('sync-passphrase').value;
    if (!token || !passphrase) return toast('Isi token dan passphrase dulu');
    if (!confirm('Ini bakal timpa config lokal yang overlap. Lanjut?')) return;
    try {
      await api('/sync/pull', { method: 'POST', body: { token, passphrase } });
      toast('Config berhasil di-pull dari cloud');
    } catch (e) { toast('Gagal pull: ' + e.message); }
  });
  document.getElementById('sync-link').addEventListener('click', async () => {
    const gistId = document.getElementById('sync-link-id').value.trim();
    if (!gistId) return toast('Isi gist ID dulu');
    await api('/sync/link', { method: 'POST', body: { gistId } });
    toast('Terhubung ke gist. Sekarang klik "Pull dari cloud".');
    renderSettings();
  });
  document.getElementById('export-btn').addEventListener('click', async () => {
    const data = await api('/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bifrost-config-${Date.now()}.json`;
    a.click();
  });
  document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    await api('/import', { method: 'POST', body: JSON.parse(text) });
    toast('Config di-import');
  });
}

// ---------------------------------------------------------------------
// Auth: first-run password setup, login, logout, session gating.
// Every tab's data lives behind /api/*, which the server rejects with 401
// until this passes — so nothing else renders until we're through here.
// ---------------------------------------------------------------------
function showChrome(show) {
  document.getElementById('tabs').style.display = show ? '' : 'none';
  document.getElementById('logout-btn').style.display = show ? '' : 'none';
}

function renderSetup() {
  showChrome(false);
  view.innerHTML = `
    <div class="auth-screen">
      <div class="panel auth-card">
        <div class="brand" style="margin-bottom:18px"><span class="brand-mark">bf⁄</span><span class="brand-name">Bifrost</span></div>
        <h2>Bikin password dashboard</h2>
        <p style="color:var(--text-dim);font-size:13px;margin-top:-6px">Ini pertama kalinya Bifrost jalan di mesin ini. Bikin password buat lindungin dashboard — tanpa ini siapapun yang akses port 8787 bisa baca API key provider lu.</p>
        <form id="setup-form">
          <label>Password (min. 6 karakter)</label>
          <input type="password" name="password" required minlength="6" autofocus />
          <label>Ulangi password</label>
          <input type="password" name="confirm" required minlength="6" />
          <div id="setup-error" style="color:var(--danger);font-size:12.5px;margin-top:8px"></div>
          <div style="margin-top:16px"><button class="btn primary" type="submit" style="width:100%">Bikin & masuk</button></div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const password = fd.get('password');
    const errorEl = document.getElementById('setup-error');
    if (password !== fd.get('confirm')) { errorEl.textContent = 'Password gak sama'; return; }
    try {
      const res = await fetch('/api/auth/setup', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); errorEl.textContent = j.error || 'Gagal setup'; return; }
      boot();
    } catch { errorEl.textContent = 'Gagal konek ke server'; }
  });
}

function renderLogin() {
  showChrome(false);
  view.innerHTML = `
    <div class="auth-screen">
      <div class="panel auth-card">
        <div class="brand" style="margin-bottom:18px"><span class="brand-mark">bf⁄</span><span class="brand-name">Bifrost</span></div>
        <h2>Masuk ke dashboard</h2>
        <form id="login-form">
          <label>Password</label>
          <input type="password" name="password" required autofocus />
          <div id="login-error" style="color:var(--danger);font-size:12.5px;margin-top:8px"></div>
          <div style="margin-top:16px"><button class="btn primary" type="submit" style="width:100%">Masuk</button></div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errorEl = document.getElementById('login-error');
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: fd.get('password') }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); errorEl.textContent = j.error || 'Login gagal'; return; }
      boot();
    } catch { errorEl.textContent = 'Gagal konek ke server'; }
  });
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  renderLogin();
});

async function boot() {
  const statusRes = await fetch('/api/auth/status', { credentials: 'same-origin' });
  const status = await statusRes.json();
  if (status.needsSetup) return renderSetup();
  if (!status.authenticated) return renderLogin();
  showChrome(true);
  render('overview');
}

boot();
