# Bifrost

Local AI routing gateway. Puts one OpenAI-compatible endpoint
(`http://localhost:8787/v1`) in front of multiple LLM providers, with
multi-account rotation and automatic fallback when a key hits a rate limit
or errors out. Includes a local dashboard to manage providers, accounts,
routes, and usage/cost logs.

Point any OpenAI-SDK-based tool (Claude Code, Cursor, Cline, your own
scripts) at the gateway instead of a single provider directly.

## Status

MVP. Working: OpenAI / Anthropic / Gemini adapters (chat, streaming,
non-streaming), multi-account fallback, cost-estimate logging, dashboard.
Not yet built: true cloud sync (multi-device), OAuth-based provider login,
per-model rate-limit auto-detection beyond a flat cooldown. See
[Roadmap](#roadmap).

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
   the Bearer token (`Authorization: Bearer nr-xxxx`), same as you'd
   configure an OpenAI base URL.

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer <your-gateway-key>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}],"stream":false}'
```

## How routing works

Each **route** (combo) is an ordered list of steps. A request walks the
list: for the current step's provider, it tries every enabled account
(oldest-used first) before moving to the next step. A `429` puts that
account on a 60s cooldown and moves on; other errors are logged and also
fall through. The full response only fails if every account on every step
is exhausted.

## Data & security notes

- `data/bifrost.sqlite` holds your provider API keys in plaintext. It's
  git-ignored by default — **do not** remove that from `.gitignore` and
  commit it.
- Export (Settings tab) also contains plaintext keys — treat exported
  JSON files the same way as a `.env` file with secrets in it.
- This gateway has no built-in HTTPS or external auth beyond the gateway
  key. It's designed to run on `localhost`; don't expose port 8787
  directly to the internet without putting a reverse proxy + real auth in
  front of it.

## Roadmap

- [ ] Streaming usage capture for OpenAI-kind providers (currently best
      effort; Anthropic/Gemini streams already report usage)
  - [ ] Per-model auto rate-limit detection (currently a flat 60s cooldown after 429)
- [ ] True multi-device cloud sync (today: manual export/import JSON)
- [ ] Provider OAuth login flows (today: paste an API key)
- [ ] Weighted / least-cost routing strategies (today: ordered fallback only)

## Stack

Express + better-sqlite3, vanilla JS dashboard (no build step). Node 18+.
