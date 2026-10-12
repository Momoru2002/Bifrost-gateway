# Bifrost — Project Handoff / Continuation Brief (updated at v4.2.0)

Paste this whole document as the first message in a new chat to pick up
exactly where the last session left off. It supersedes the earlier v4.0.0
brief. It lives in the repo as `HANDOFF.md`; if the repo is public, this
file is public too, so it contains no secrets.

## What this is

**Bifrost** — a local, self-hosted AI routing gateway (a "9Router"-style
tool). Repo: `github.com/Momoru2002/Bifrost-gateway`, current version
**v4.2.0** (see the README's Changelog for full version history).

It puts one OpenAI-compatible endpoint (`/v1/chat/completions`) and one
Anthropic-compatible endpoint (`/v1/messages`, for Claude Code) in front
of multiple LLM providers (OpenAI, Anthropic, Gemini, or any
OpenAI-compatible custom endpoint), with multi-account rotation,
rate-limit-aware fallback, and a circuit breaker. It has a local
dashboard (Node/Express backend + vanilla JS frontend, no build step) to
manage providers/accounts/routes and see usage.

## How the user wants to work

- Language: casual **Indonesian mixed with English** ("lu/gue" register).
  The user asked for this explicitly; keep it up.
- Terse messages ("gas", "lanjut") mean "go ahead". When a "lanjut" is
  ambiguous between several real options, ask once (single-select) rather
  than guessing.
- Honest assessment is wanted. The user said the redesign looked "meh" and
  was right; say plainly what is weak and fix it.

## What happened in the last session (v4.0.0 → v4.2.0)

The session started from real browser screenshots of the v4.0.0 redesign
and found real bugs, then grew into features. Commits, oldest first:

| Version | Commit | What |
|---|---|---|
| 4.0.1 | `e2a3dd3` | **Fix:** `/api/quick-connect` saved provider+account+route without testing the key, so a bad key still showed "Provider terhubung". It now calls `testAccount()` first and rejects with the provider's real error, leaving nothing in the DB. **Fix:** Logs tab never rendered `request_logs.error`, so failures showed only `- - error 0/0`; the (escaped) message now shows under the status. **Fix:** `package-lock.json` was stuck at version 0.1.0. New `test/quick-connect.test.js`. |
| 4.0.2 | `542f7da` | Visual polish: second accent `--aurora` (violet-blue) beside ember; SVG bridge-arc brand glyph replacing the "bf⁄" text; shared `emptyState()` helper (icon + next-step line) used at all empty states; tabular-nums on stats; `:focus-visible` outlines; `prefers-reduced-motion`. |
| 4.1.0 | `aa8a353` | 4 themes (Gelap / Terang / Hangat / Aurora) via `:root[data-theme=…]`, picked in Settings > Tampilan, saved in `localStorage['bifrost-theme']`, applied by an inline script in `index.html` before first paint. 5 idle-animated sidebar mascots (Robot, Kucing, Anjing, Ular, Orang), `localStorage['bifrost-mascot']`. Purely client-side. |
| 4.2.0 | `2e56008` | **Analytics tab** + `GET /api/stats/analytics?days=7\|14\|30\|90` (clamped 1–90): latency p50/p95 per provider (successful requests only), cost + tokens per model, daily success-rate trend (y axis auto-zoomed), per-route comparison. Pure logic in `lib/analytics.js`; `test/analytics.test.js` (23 assertions). Also fixed what real screenshots exposed: squashed chart axis, low-contrast bar labels, wrapping log timestamp, and redrew the Dog and Snake mascots. |

`npm test` runs 4 suites, 45 assertions, all passing at 4.2.0
(translation, compression, quick-connect = 10, analytics = 23). CI
(`.github/workflows/ci.yml`) runs it on every push.

## Architecture at a glance

- `server.js` — Express app, all routes
- `lib/db.js` — `node:sqlite` wrapper (`undefined`→`null` sanitization and a
  `.transaction()` helper). **DB path is hardcoded to `data/bifrost.sqlite`**
  (not env-configurable — see "Small improvements" below).
- `lib/router.js` — fallback-chain engine (`attemptChain`, `attemptEmbeddings`,
  `testAccount`, circuit breaker, timeouts, cost estimation)
- `lib/providers/{openai,anthropic,gemini}.js` — one adapter per provider kind
- `lib/anthropic_frontend.js` — translates the incoming Anthropic Messages
  protocol (what Claude Code speaks) to/from the internal OpenAI shape
- `lib/analytics.js` — percentile / aggregation helpers (pure, unit-tested)
- `lib/compression.js`, `lib/sync.js`, `lib/auth.js` — single-purpose modules
- `public/{index.html,app.js,style.css}` — dashboard; no framework, no build
  step; `render(tab)` dispatches to `renderOverview / renderProviders /
  renderCombos / renderAnalytics / renderLogs / renderSettings`
- `test/*.test.js`, `scripts/reset-password.js`
- Useful route names: `/api/auth/setup`, `/api/auth/login`,
  `/api/gateway-key`, `/api/quick-connect`, `/api/providers`, `/api/combos`
  (routes are called "combos" in the API/DB and "Routes" in the UI),
  `/api/logs`, `/api/stats`, `/api/stats/daily`, `/api/stats/analytics`.
  Provider kind for custom endpoints is `openai_compatible`.

## Visual QA status (this is now possible — read this)

**The old note "no headless browser available" is wrong.** A real headless
Chromium runs in the sandbox through npm, no system browser needed:

```bash
npm i puppeteer-core @sparticuz/chromium      # in a scratch dir, NOT the repo
```
```js
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  args: [...chromium.args, '--no-sandbox'],
  executablePath: await chromium.executablePath(),
  headless: 'shell'
});
```

Recipe that worked: start `server.js` with `PORT=<spare>` after deleting
`data/bifrost.sqlite*`; `POST /api/auth/setup` then `/api/auth/login` over
HTTP; reuse the session cookie via `page.setCookie({name, value, url})`
(**split the Set-Cookie on the first `=` only** — splitting on every `=`
produced a bogus 403 on every request once); seed `request_logs` by opening
`data/bifrost.sqlite` with `node:sqlite`'s `DatabaseSync`; create providers
with `/api/quick-connect` pointed at a tiny local mock HTTP server (it now
verifies keys, so a mock that returns a valid chat completion is required);
set the theme with `page.evaluateOnNewDocument` writing
`localStorage['bifrost-theme']`; watch `page.on('response')` for status ≥ 400
and `page.on('pageerror')`. `fullPage: true` screenshots, then view them.

**Actually looked at in a real browser:** Dashboard (dark, with data),
Providers (dark), Logs (dark, incl. error text and timestamp fix),
Settings (dark, theme + mascot pickers), Analytics (all 4 themes), all 5
mascots enlarged.

**NOT yet looked at (do these before calling the UI verified):**
Routes tab render; Dashboard/Providers/Logs/Settings in Terang, Hangat,
Aurora; the empty-state screens (fresh install, zero providers) as
rendered; login and setup screens; narrow/mobile layout (<860px, the
sidebar becomes a top bar); mascot animations in motion; keyboard focus
rings.

**Small visual nits already spotted, not fixed:** the "Tokens in / out" stat
uses a smaller font than the other stat cards and numbers have no thousands
separators; the Dashboard bar chart has no value labels or y axis; the snake
mascot's head has a hairline gap at the neck.

## Known gaps / limitations (documented, not oversights)

- **Docker image never build-tested** — no Docker in the sandbox. Needs a
  real `docker compose up` on a machine that has Docker.
- **Provider OAuth login**: not generically buildable (needs Bifrost
  registered as an OAuth app with each provider by the account owner). Not
  planned.
- **Image generation / audio-TTS endpoints**: out of scope.
- Inline image content blocks (Anthropic protocol) aren't translated across
  providers.
- Gemini 3's thought-signature requirement for multi-turn tool use doesn't
  survive the round trip through the internal shape.
- `message_start`'s `input_tokens` is 0 in Anthropic-shape streaming
  responses (cosmetic; the real count isn't known until the stream ends).
- Analytics cost numbers are only as good as the existing per-model cost
  estimates; they are estimates, not billing.

## Next priorities (not started) — ask the user which first, don't assume

1. **Multiple gateway keys.** Today there is exactly one shared gateway key
   (`gateway_key` setting), so a leak means regenerating it and breaking
   every connected tool. Suggested shape: a `gateway_keys` table (id, name,
   key stored hashed or shown once, created_at, last_used_at, revoked_at),
   auth middleware that accepts any non-revoked key, migrate the existing
   single key as the first row, Settings UI to create / name / revoke, and a
   `key_id` column on `request_logs` so Analytics can later break usage down
   per tool. Needs a test that a revoked key is rejected and others still work.
2. **Deeper testing.** Commit a real browser smoke test into the repo:
   screenshot every tab × every theme and fail on console errors or 4xx
   responses (GitHub Actions runners have Chrome; locally use the
   `@sparticuz/chromium` recipe above, as devDependencies). Plus load testing
   of multi-account fallback at higher concurrency.
3. **Finish the visual QA list** above and fix the small nits.
4. **Docker build check** (needs a machine with Docker).
5. **Small improvement worth doing first if tests are touched:** make the DB
   path configurable (e.g. `BIFROST_DB_PATH`). Every integration test
   currently deletes and reuses the one hardcoded `data/bifrost.sqlite`, so
   tests can't safely run in parallel or next to a real dev database.

## Operating conventions (keep following these)

- **Sandbox warning — important.** The sandbox filesystem can be wiped
  between turns (it happened mid-session and cost one uncommitted feature,
  which had to be rebuilt). Anything not pushed to GitHub is at risk. After
  each meaningful chunk: `git commit` locally right away, and push as soon
  as the user supplies a token. If the repo directory is missing, re-clone
  and `npm install`.
- **Git workflow.** The container can reach `github.com`. To push, the user
  pastes a GitHub personal access token (fine-grained, this repo only,
  `Contents: Read and write`, short expiry). Set it into the remote URL,
  push, then **immediately reset the remote URL to the plain
  `https://github.com/Momoru2002/Bifrost-gateway.git`** and verify with
  `grep -c ghp_ .git/config` (must be 0). Ask for a fresh token each push;
  if the user pastes one that was already used, flag it (they have chosen to
  reuse once — their call, but say it). Tokens pasted in chat remain visible
  in the transcript, so suggest revoking them afterwards. Never write a token
  into any file, commit message, or this document. Commit identity:
  `Momoru2002 <monarchlinux77@gmail.com>` (set `git config user.name/email`
  in a fresh clone).
- **Testing discipline.** Verify end-to-end before calling anything done:
  real APIs where the sandbox allows (`api.anthropic.com` is reachable; most
  other provider domains are not), otherwise purpose-built local mock HTTP
  servers. Background processes need `setsid nohup … &`. For UI work, use
  the headless-Chromium recipe and actually look at the screenshots.
- **README discipline.** Every feature gets a README update: version header,
  the relevant section, Roadmap checklist, and a new Changelog entry at the
  top of the Changelog list.
- **Versioning.** major = structural/breaking or a large multi-feature batch;
  minor = a new capability; patch = a fix or small tweak. Bump
  `package.json` and the README header together.
- **Commit messages.** Detailed: what changed, why, and what was actually
  verified (not "should work"). They have caught regressions before.
- **Design.** Existing identity: deep violet-black + warm ember accent, plus
  the `--aurora` violet-blue secondary; Fraunces (serif headings/stat
  numbers) + Inter (UI). Everything uses CSS variable tokens so all four
  themes work; never hardcode colors in new UI. Escape any user- or
  upstream-controlled text with `escapeHtml()` before putting it in
  `innerHTML`.

## Instructions for the next session

1. Read this whole brief before doing anything.
2. `git clone` the repo, `npm install`, run `npm test` (expect 45 passing).
3. Ask the user which "Next priority" to take first (or something else).
4. Follow the conventions above: test before done, commit locally early,
   README + Changelog + version bump per feature, fresh token per push and
   strip it afterwards.
