# Bifrost

Local AI routing gateway. Puts one OpenAI-compatible endpoint
(`http://localhost:8787/v1`) in front of multiple LLM providers, with
multi-account rotation and rate-limit-aware automatic fallback — when a
key hits a `429`, Bifrost reads the provider's own retry-after signal and
cools that account down for exactly that long before trying it again.
Includes a local dashboard to manage providers, accounts, routes, and
usage/cost logs.

Point any OpenAI-SDK-based tool (Claude Code, Cursor, Cline, your own
scripts) at the gateway instead of a single provider directly.

## Status

Feature-complete against the original roadmap. Working: OpenAI / Anthropic /
Gemini adapters (chat, streaming, non-streaming) with real usage/token
capture on both streaming and non-streaming calls, multi-account fallback,
rate-limit-aware cooldowns (reads each provider's actual `retry-after` /
reset headers instead of guessing), weighted and least-cost routing
strategies, cost-estimate logging, encrypted cloud sync via a private
GitHub Gist, dashboard. Not yet built: provider OAuth login flows (you
paste an API key instead). See [Roadmap](#roadmap).

## Quick start

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:8787` for the dashboard. On first boot the server
generates a **gateway key** (shown in the terminal and in Settings) — this
is a local secret, separate from your provider API keys, that authenticates
requests to your gateway so nothing else on your machine can spend your
credits silently.

1. **Providers tab** — add a provider (OpenAI / Anthropic / Gemini / any
   OpenAI-compatible endpoint), then add one or more accounts (API keys)
   under it.
2. **Routes tab** — build a fallback chain: an ordered list of
   `provider + model` steps. Mark one route as default.
3. Point your tool at `http://localhost:8787/v1` with the gateway key as
   the Bearer token (`Authorization: Bearer bf-xxxx`), same as you'd
   configure an OpenAI base URL.

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer <your-gateway-key>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}],"stream":false}'
```

## How routing works

Each **route** (combo) is an ordered list of steps, plus a **strategy**
that decides what order those steps are actually tried in per-request:

- **ordered** (default) — always tries steps in the order you set them.
  A strict fallback chain: step 2 only gets touched if step 1 is
  fully exhausted.
- **cost** — tries the step with the cheapest modeled price first
  (using the pricing table in Settings), falling back to pricier steps
  only if the cheap one fails.
- **weighted** — each step carries a `weight`; steps are tried in a
  randomized order proportional to those weights, so load spreads across
  providers/accounts instead of always hammering the first one.

Whatever the order, the actual attempt loop is the same: for the current
step's provider, it tries every enabled account (oldest-used first)
before moving to the next step. On a `429`, the account is cooled down
for exactly as long as the provider says to wait — Bifrost reads the
standard `retry-after` header first, then falls back to provider-specific
signals (OpenAI's `x-ratelimit-reset-*` headers, Anthropic's
`anthropic-ratelimit-*-reset` timestamps, Gemini's `RetryInfo.retryDelay`
in the error body), defaulting to 60s only if none of those are present.
A `5xx` gets a short 10s cooldown instead, since it's usually transient
rather than a hard limit. The full response only fails if every account
on every step is exhausted.

## Cloud sync

Bifrost has no server of its own to sync through, so it uses a **private
GitHub Gist you own** instead. From Settings, paste a GitHub token (needs
`gist` scope) and a passphrase, then **Push to cloud**. Your config
(providers, accounts, routes) is AES-256-GCM encrypted locally with that
passphrase *before* it's uploaded — GitHub only ever stores ciphertext, so
even a compromised GitHub account or a leaked gist link doesn't expose
your provider API keys without the passphrase too.

On another machine, use **"pull from an existing gist"** with the gist ID
from the first machine, enter the same token and passphrase, then **Pull
from cloud**. Neither the token nor the passphrase is ever written to
disk — both are supplied fresh each time and used only in memory for that
one request. The per-machine `gateway_key` is deliberately left out of
sync, so pulling config on a second machine won't invalidate whatever's
already authenticating against the first one.

## Data & security notes

- `data/bifrost.sqlite` holds your provider API keys in plaintext. It's
  git-ignored by default — **do not** remove that from `.gitignore` and
  commit it.
- Export (Settings tab) also contains plaintext keys — treat exported
  JSON files the same way as a `.env` file with secrets in it.
- Cloud sync encrypts before upload (see above), but the strength of that
  protection is only as good as your passphrase — use a real one, not
  "1234".
- This gateway has no built-in HTTPS or external auth beyond the gateway
  key. It's designed to run on `localhost`; don't expose port 8787
  directly to the internet without putting a reverse proxy + real auth in
  front of it.

## Roadmap

- [x] Per-provider rate-limit detection (reads real retry-after/reset signals)
- [x] Weighted / least-cost routing strategies
- [x] Streaming usage capture (all three adapters now report real token
      counts for streamed requests, not just non-streaming ones)
- [x] Cloud sync (encrypted, via a private GitHub Gist you own)
- [ ] Provider OAuth login flows (today: paste an API key)

## Stack

Express + better-sqlite3, vanilla JS dashboard (no build step). Node 18+.
