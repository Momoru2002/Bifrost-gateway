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

MVP+. Working: OpenAI / Anthropic / Gemini adapters (chat, streaming,
non-streaming), multi-account fallback, rate-limit-aware cooldowns (reads
each provider's actual `retry-after` / reset headers instead of guessing),
cost-estimate logging, dashboard. Not yet built: true cloud sync
(multi-device), OAuth-based provider login, weighted/least-cost routing.
See [Roadmap](#roadmap).

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
(oldest-used first) before moving to the next step. On a `429`, the
account is cooled down for exactly as long as the provider says to wait —
Bifrost reads the standard `retry-after` header first, then falls back to
provider-specific signals (OpenAI's `x-ratelimit-reset-*` headers,
Anthropic's `anthropic-ratelimit-*-reset` timestamps, Gemini's
`RetryInfo.retryDelay` in the error body), defaulting to 60s only if none
of those are present. A `5xx` gets a short 10s cooldown instead, since
it's usually transient rather than a hard limit. The full response only
fails if every account on every step is exhausted.

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

- [x] Per-provider rate-limit detection (reads real retry-after/reset signals)
- [ ] Streaming usage capture for OpenAI-kind providers (currently best
      effort; Anthropic/Gemini streams already report usage)
- [ ] True multi-device cloud sync (today: manual export/import JSON)
- [ ] Provider OAuth login flows (today: paste an API key)
- [ ] Weighted / least-cost routing strategies (today: ordered fallback only)

## Stack

Express + better-sqlite3, vanilla JS dashboard (no build step). Node 18+.
