# Bifrost

Local AI routing gateway. Puts two protocol-compatible endpoints
(`http://localhost:8787/v1`) in front of multiple LLM providers, with
multi-account rotation and rate-limit-aware automatic fallback — when a
key hits a `429`, Bifrost reads the provider's own retry-after signal and
cools that account down for exactly that long before trying it again.
Includes a local dashboard (sidebar-based, one-form provider setup) to
manage providers, accounts, routes, and usage/cost logs.

Point any OpenAI-SDK-based tool (Cursor, Cline, your own scripts) at
`/v1/chat/completions`, or any Anthropic-SDK-based tool (**Claude Code**)
at `/v1/messages` — including tool-calling — instead of a single provider
directly. A Claude Code session can transparently be served by Gemini or
OpenAI behind the scenes; see [Talking to Claude Code](#talking-to-claude-code).

## Status

Feature-complete against the original roadmap, plus native Anthropic
protocol support. Working: OpenAI / Anthropic / Gemini adapters (chat,
streaming, non-streaming, tool-calling) with real usage/token capture,
multi-account fallback, rate-limit-aware cooldowns (reads each provider's
actual `retry-after` / reset headers instead of guessing), weighted and
least-cost routing strategies, cost-estimate logging, encrypted cloud
sync via a private GitHub Gist, dashboard auth, a native `/v1/messages`
endpoint for Anthropic-protocol tools (Claude Code) with tool-call
translation across providers, and a per-account "Test connection" button.
Not yet built: provider OAuth login flows (you paste an API key instead).
See [Roadmap](#roadmap).

## Quick start

```bash
npm install
cp .env.example .env
npm start
```

Requires **Node 22.5+** (24+ recommended). No native/build toolchain
needed — `data/bifrost.sqlite` runs on Node's built-in `node:sqlite`, not
a compiled dependency, so `npm install` works out of the box on Windows,
macOS, and Linux without Visual Studio Build Tools or similar.

Open `http://localhost:8787` for the dashboard. **First time you open it,
you'll be asked to set a dashboard password** — this protects the
management API (`/api/*`), which can read every provider API key you add.
Forgot it? `npm run reset-password` clears it without touching your
providers/routes/logs.

Separately, on first server boot the process also generates a **gateway
key** (shown in the terminal and in Settings once you're logged in) — a
local secret, distinct from your provider API keys *and* from the
dashboard password, that authenticates requests to the gateway itself
(`/v1/*`) so nothing else on your machine can spend your credits silently.

1. **Dashboard tab** — the first thing you see is a "Connect a
   provider" form: pick a type, name it, paste an API key, name a
   model. One submit creates the provider, an account under it, and a
   default route, all at once. Add a second provider the same way and
   it becomes a fallback step on that same route — no separate
   provider/account/route setup needed to get going. (The Providers and
   Routes tabs are still there for managing multiple accounts per
   provider, building weighted/least-cost fallback chains, etc.)
2. Point your tool at `http://localhost:8787/v1` with the gateway key as
   the Bearer token (`Authorization: Bearer bf-xxxx`), same as you'd
   configure an OpenAI base URL.

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer <your-gateway-key>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}],"stream":false}'
```

`/v1/embeddings` works the same way (OpenAI and Gemini routes only —
Anthropic doesn't offer an embeddings API, so a route pointed only at
Anthropic will return a clear error rather than a result):

```bash
curl http://localhost:8787/v1/embeddings \
  -H "Authorization: Bearer <your-gateway-key>" \
  -H "Content-Type: application/json" \
  -d '{"input":"hello world"}'
```

## Running with Docker

```bash
docker compose up
```

Builds and runs the gateway on port 8787 with a named volume for
`data/bifrost.sqlite`, so your providers/accounts/routes survive a
container rebuild. First run still walks you through the same dashboard
password setup as running locally. Note: the image is built on
`node:24-alpine`; if you're deploying somewhere with an older Node
runtime already baked in, `npm install` needs 22.5+ regardless of how
you run it, per the requirement above.

## Talking to Claude Code

Claude Code speaks the Anthropic Messages API natively (`/v1/messages`,
with its own tool-calling format) — not the OpenAI-compatible surface
above. Bifrost translates that on the fly, so a route can point Claude
Code at Gemini or OpenAI just as easily as at a real Claude account, tool
calls included:

```bash
export ANTHROPIC_BASE_URL="http://localhost:8787"
export ANTHROPIC_API_KEY="<your-gateway-key>"
claude
```

(Claude Code accepts the gateway key as either `ANTHROPIC_API_KEY` or
`ANTHROPIC_AUTH_TOKEN` — Bifrost accepts both `x-api-key` and
`Authorization: Bearer`, whichever your tool sends.) The route Claude
Code hits is still whatever combo is marked default (or picked via
`x-bifrost-combo`) — the `model` Claude Code sends is not used to choose
the provider, same as `/v1/chat/completions`.

Known limitations of this translation layer (see `lib/anthropic_frontend.js`
for detail): inline image content blocks aren't translated across
providers yet; Gemini 3's thought-signature requirement for multi-turn
tool use doesn't survive the round trip through Bifrost's internal
OpenAI-shape representation, since that schema has no field for it.

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

Cooldowns handle a single bad moment; a **circuit breaker** handles an
account that's just broken. Every failure (of any kind) also increments a
per-account counter that resets on any success. After 5 consecutive
failures, the account trips — instead of the normal cooldown above, it
gets sidelined for 15 minutes, and shows up in the dashboard as "circuit
breaker OPEN" rather than a regular cooldown, so a dead key reads as
*broken*, not just *busy*.

## Token compression

Long tool-heavy sessions (Claude Code especially) resend the *entire*
conversation history on every turn, including old tool outputs the model
has usually already moved past. By default, Bifrost truncates tool-result
content older than the last 6 messages once it exceeds 4000 characters —
middle-cut, both ends kept, with a marker noting how much was removed.
This is a predictable size-based heuristic, not semantic caching or
diffing — it trades a little old context fidelity for real token savings
on long sessions. Toggle it off, or tune the thresholds, from the
Settings tab.

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

## Running it long-term

A few things that only matter once this stays up for a while (Docker, a
VPS, whatever):

- **`GET /health`** — unauthenticated liveness check (`{status, uptime_seconds}`),
  for a Docker healthcheck or uptime monitor.
- **Request timeouts** — every provider attempt gets 120s by default
  before Bifrost gives up on it and falls through to the next
  account/step, same as any other failure. Configurable via the
  `request_timeout_ms` setting if a provider is just slow.
- **Log retention** — `request_logs` is pruned automatically (default:
  30 days, on boot and every 6 hours). Change it, or clear everything
  immediately, from the Logs tab.

## Data & security notes

- `data/bifrost.sqlite` holds your provider API keys in plaintext. It's
  git-ignored by default — **do not** remove that from `.gitignore` and
  commit it.
- The dashboard (`/api/*`) is behind a password (set on first run) —
  without it, anyone who can reach port 8787 could read every provider
  key you've added. Sessions are signed cookies with a 7-day expiry.
  Login, setup, and change-password are rate-limited (10 attempts / 15
  min per IP) against brute-forcing that password.
- Provider API keys are never sent back to the dashboard once saved —
  the accounts listing only includes a `key_preview` (last 4 characters)
  so accounts stay distinguishable in the UI.
- Export (Settings tab) also contains plaintext keys — treat exported
  JSON files the same way as a `.env` file with secrets in it.
- Cloud sync encrypts before upload (see above), but the strength of that
  protection is only as good as your passphrase — use a real one, not
  "1234".
- This gateway has no built-in HTTPS. It's designed to run on
  `localhost`; don't expose port 8787 directly to the internet without
  putting a reverse proxy + TLS in front of it — the dashboard password
  protects against casual access, not against being placed on the open
  internet unencrypted.

## Roadmap

- [x] Per-provider rate-limit detection (reads real retry-after/reset signals)
- [x] Weighted / least-cost routing strategies
- [x] Streaming usage capture (all three adapters now report real token
      counts for streamed requests, not just non-streaming ones)
- [x] Cloud sync (encrypted, via a private GitHub Gist you own)
- [x] Dashboard authentication (password + session, protects `/api/*`)
- [x] Native Anthropic `/v1/messages` endpoint (Claude Code and other
      Anthropic-protocol tools, including tool-call translation across
      whichever provider a route points at)
- [x] "Test connection" button per account
- [x] Circuit breaker (accounts that fail repeatedly get a long cooldown,
      not just the normal per-request one)
- [x] Model dropdown (live model list per provider, Routes tab)
- [x] Provider catalog/presets for common OpenAI-compatible providers
- [x] Live-refreshing Logs tab, daily usage chart on Overview
- [x] Rate-limited dashboard login, key preview, basic security headers
- [x] `/v1/embeddings` (OpenAI + Gemini — Anthropic has no embeddings API)
- [x] Token/prompt compression for long tool-heavy sessions (truncates old,
      oversized tool_result content — not semantic caching, a predictable
      heuristic; on by default, tunable in Settings)
- [x] Docker support (`docker compose up`)
- [x] LICENSE (MIT)
- [x] Request timeouts, automatic log retention, `/health` endpoint, CI
      (GitHub Actions runs the test suite on every push)
- [ ] Provider OAuth login flows — **not generically buildable**: this
      needs Bifrost registered as an OAuth app with each provider
      individually via that provider's own developer console, which only
      the account owner can do. Documented gap, not planned.
- [ ] Image generation / audio-TTS endpoints (out of scope for a
      coding-tool-facing gateway; embeddings covered the realistic part
      of "multi-modal")
- [ ] Provider catalog/presets for common OpenAI-compatible providers
      (Groq, Together, DeepSeek, etc. — today you type the base URL by hand)
- [ ] Circuit breaker (today: per-account cooldown only, not a
      whole-provider trip after repeated failures)

## Stack

Express + Node's built-in `node:sqlite`, vanilla JS dashboard (no build
step). Node 22.5+ (24+ recommended). `npm test` runs the regression
suite (protocol translation + compression); CI runs it on every push.
