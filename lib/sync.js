const crypto = require('crypto');
const fetch = require('node-fetch');

const GIST_FILENAME = 'bifrost-sync.json.enc';
const GIST_DESCRIPTION = 'Bifrost gateway config (encrypted — do not edit manually)';

// --- Encryption -----------------------------------------------------
// AES-256-GCM, key derived from the user's passphrase via scrypt with a
// random salt. Salt + IV + authTag travel alongside the ciphertext inside
// one self-contained blob, so the Gist needs nothing else to decrypt later
// (no separate secret stored server-side beyond what's in this blob).
function encrypt(plaintextObj, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(plaintextObj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    v: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    data: ciphertext.toString('base64')
  };
}

function decrypt(blob, passphrase) {
  const salt = Buffer.from(blob.salt, 'base64');
  const iv = Buffer.from(blob.iv, 'base64');
  const authTag = Buffer.from(blob.authTag, 'base64');
  const ciphertext = Buffer.from(blob.data, 'base64');
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Decryption failed — wrong passphrase, or the gist was edited outside Bifrost');
  }
  return JSON.parse(plaintext.toString('utf8'));
}

// --- GitHub Gist API --------------------------------------------------
// The GitHub token is only ever used for the duration of one request; it is
// never written to the database.
async function ghRequest(token, path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function pushToGist({ token, gistId, encryptedBlob }) {
  const body = {
    description: GIST_DESCRIPTION,
    public: false,
    files: { [GIST_FILENAME]: { content: JSON.stringify(encryptedBlob, null, 2) } }
  };
  if (gistId) {
    const updated = await ghRequest(token, `/gists/${gistId}`, { method: 'PATCH', body: JSON.stringify(body) });
    return updated.id;
  }
  const created = await ghRequest(token, '/gists', { method: 'POST', body: JSON.stringify(body) });
  return created.id;
}

async function pullFromGist({ token, gistId }) {
  const gist = await ghRequest(token, `/gists/${gistId}`);
  const file = gist.files[GIST_FILENAME];
  if (!file) throw new Error(`Gist ${gistId} has no ${GIST_FILENAME} file — was it created by Bifrost?`);
  return JSON.parse(file.content);
}

module.exports = { encrypt, decrypt, pushToGist, pullFromGist };
