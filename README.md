# Truth-Skills

An MCP server that lets unique humans grade Claude skills as good or bad. Claude Code connects to it over OAuth 2.1; signing in takes a World ID proof, so each account is one verified human and each grade is one human's vote.

```
Claude Code ──OAuth 2.1 + PKCE──▶ Truth-Skills ──verify proof──▶ World ID
     │                               ▲    ▲
     └── Bearer token on POST /mcp ──┘    └── sign-in page ◀── World App (phone)
```

- **MCP endpoint**: `POST /mcp`, stateless Streamable HTTP. One tool, `grade_skill`, acting for the account in the access token. The agent grades on its own: the server's instructions tell it to grade every skill used in the conversation (liked when it helped, disliked when the user struggled) without ever asking the user.
- **Authorization server**: our own, in the same process (`/authorize`, `/token`, `/register`, `/revoke`, RFC 8414 / 9728 metadata).
- **Sign-in**: the first time, two scans with World App: a uniqueness proof creates the account, then a World ID session lets us recognise the same human later. Returning humans scan once.

## Setup

Requirements: Node 22+, a [Neon](https://neon.tech) Postgres database, and a World ID app from the [Developer Portal](https://developer.world.org) with its RP signing key.

```bash
npm install
cp .env.example .env     # then fill it in; see the comments in the file
npm run migrate          # creates the tables in Neon (safe to re-run)
npm start                # http://localhost:3000
```

The pooled Neon connection string works for both the server and migrations. A missing or malformed variable stops the server with its name, never its value.

In the Developer Portal, create the action `truth-skills-account-v1` for your app.

| Command | What it does |
|---|---|
| `npm start` / `npm run dev` | Run the server (dev: restart on change) |
| `npm test` | Unit and integration tests (in-process Postgres via PGlite; no network, no Neon) |
| `npm run typecheck` | TypeScript checks |
| `npm run migrate` | Apply pending `migrations/*.sql` |
| `npm run staging:open` / `staging:close` | Open or close the World ID sandbox verification window |

## Testing with the World ID sandbox

Testing without an Orb takes three things:

1. **The "World ID Sandbox" app on the tester's phone.** Developer Portal → World ID Sandbox → submit the tester's Apple or Google account and accept the TestFlight / Play invite. The normal World App cannot answer sandbox requests.
2. **Enrolling the tester, once.** Set `WORLD_INVITE_CODE=true`, sign in once (the app walks through date of birth and a Selfie Check), then set it back to `false`. Without it, World App says *"v4 protocol and credential issuance must both be enabled for this account"*.
3. **A sandbox verification window.** Put a team API key in `.env` as `WORLD_TEAM_API_KEY`, then run `npm run staging:open`. It writes a 24-hour `WORLD_STAGING_TOKEN` to `.env` without printing it; restart the server. Without it, verification fails with `environment_not_allowed`. Run `npm run staging:close` when you stop.

Keep `WORLD_ENVIRONMENT=sandbox` while testing: the server refuses proofs from any other environment.

The team API key has power over the whole World team (it can create apps and rotate keys). Keep it in `.env` only.

## Connecting Claude Code

```bash
claude mcp add --transport http truth-skills http://localhost:3000/mcp
claude                       # from the same folder the MCP was added in
/mcp  →  truth-skills  →  Authenticate
```

The browser opens the sign-in page. It shows which application is asking and which local address it will return to; continue only if you started it from Claude Code. Scan QR 1, scan QR 2, save the recovery link, then click **I saved it, continue**. Back in Claude Code, `/mcp` shows truth-skills connected with `grade_skill`.

Let the agent grade without a permission prompt, since grading is exactly what the user agreed to when connecting. In the project's `.claude/settings.json` (or `~/.claude/settings.json` for every project):

```json
{ "permissions": { "allow": ["mcp__truth-skills__grade_skill"] } }
```

Afterwards Claude Code refreshes its token silently every hour. After 90 days, or on a new machine, it signs in again:

| Situation | What happens | Effort |
|---|---|---|
| Access token expired (hourly) | Refresh token rotation | None |
| Same browser, new sign-in | The page recognises the World ID session cookie | One scan |
| New machine or cleared cookies | Paste the recovery link under "Already have an account?" | Paste + one scan |

A human who loses both the cookie and the recovery link cannot get back in, and cannot create a second account either.

## End-to-end checklist

Run this against the sandbox before a demo.

- [ ] `curl -si -X POST localhost:3000/mcp -H 'content-type: application/json' -d '{}'` → `401` with `WWW-Authenticate: Bearer error="invalid_token", … resource_metadata="…/.well-known/oauth-protected-resource/mcp"`
- [ ] `curl -s localhost:3000/.well-known/oauth-authorization-server` lists `/authorize`, `/token`, `/register`, `/revoke` and `S256`
- [ ] First sign-in from Claude Code: two scans, recovery link shown, back in Claude Code with `grade_skill` listed
- [ ] Use a skill in a conversation (e.g. ask for a .docx); once it is done, Claude grades it on its own, without asking, and mentions it briefly
- [ ] Same browser: `/mcp` → truth-skills → clear authentication → Authenticate → "Welcome back", one scan, same account
- [ ] New machine: open the sign-in URL in a fresh private window (it must say "Step 1 of 2", not "Welcome back"), use the recovery link, one scan, same account
- [ ] Database afterwards:

| Table | Expected |
|---|---|
| `accounts` | One row per human, `world_session_id` set |
| `world_nullifiers` | One row per human, action `truth-skills-account-v1` |
| `oauth_clients` | "Claude Code (truth-skills)" clients (one per authentication is normal) |
| `auth_codes` | Every code has `used_at` set |
| `refresh_tokens` | One active (not revoked) token per account and client |
| `auth_requests` | Finished sign-ins are gone |
| `skill_grades` | One row per human per graded skill (`skill_name`, `liked`); a plugin prefix is dropped, so `anthropic-skills:docx` is stored as `docx` |

### Errors and what they mean

| Where | Message | Cause | Fix |
|---|---|---|---|
| World App | "v4 protocol and credential issuance must both be enabled for this account" | Sandbox tester not enrolled | Enroll once with `WORLD_INVITE_CODE=true` |
| Server log | `World verify: environment_not_allowed` | No sandbox verification window | `npm run staging:open`, restart the server |
| Server log | `World verify: environment_not_allowed — Invalid staging verification token.` | Someone ran `staging:open` again: each run issues a new token and invalidates the previous one | Have one person open the window and share the token, or run `npm run staging:open` again and restart |
| Sign-in page | "You already have a Truth-Skills account, but this browser does not remember it" (World App: `nullifier_replayed`) | A second signup proof for an existing human, from a browser without the session cookie (expected) | Paste the recovery link in the form the page opens: one scan |
| Sign-in page | "This sign-in has expired" | More than 10 minutes since Claude Code opened it | Authenticate again from Claude Code |
| Claude Code | truth-skills missing from `/mcp` | Claude started in another folder than the one the MCP was added in | Start it there, or add the MCP with `--scope user` |
| Private window | "Welcome back" instead of step 1 | Claude Code opened the normal browser, which has the cookie | Copy the URL into a fresh private window |

## Security

Implemented, and covered by tests where noted:

**Tokens and codes**
- [x] PKCE S256 required; the verifier is checked against the stored challenge (tested)
- [x] Authorization codes: 32 random bytes, stored as SHA-256, single use, 60 s (tested)
- [x] Refresh tokens: stored as SHA-256, rotated on every use, revocable, 90 days; a bad scope request does not consume one (tested)
- [x] Access tokens: HS256 `at+jwt` with `iss`, `aud` = our `/mcp` URL, 1 h; other algorithms, types, issuers and audiences refused (tested)
- [x] `resource` checked at `/authorize`, `/token` and refresh: anything but our `/mcp` URL → `invalid_target` (tested)
- [x] Invalid tokens answer 401 with `WWW-Authenticate`, never 500 (tested)
- [x] The account comes from the token only, never from a tool argument; deleted accounts are refused on the next call and refresh (tested)

**Sign-in**
- [x] Login requests expire after 10 min; the browser only holds a random UUID
- [x] One World ID nonce per step, checked and burnt in one statement: a proof cannot be replayed or used for another login request (tested)
- [x] Steps enforced by a state machine (`409 Login step out of order`) (tested)
- [x] Proof environment, action and session checked against configuration and the login request (tested)
- [x] The RP signing key stays on the server; the page only receives signed requests
- [x] Client name and redirect host shown on the page, rendered as text only
- [x] One account per nullifier (database key, on top of World App's refusal) (tested)
- [x] An account whose second scan was abandoned is sent through it again, so it never ends up without a way back (tested)
- [x] Recovery link: session id in the URL fragment, useless without the phone's proof (tested)
- [x] Session cookie `HttpOnly`, `SameSite=Lax`, `Path=/login`, `Secure` over https (tested)
- [x] Sign-in pages: strict CSP (own scripts only, no inline), no framing, no Referer, no caching; IDKit served from our origin (tested)

**Before production**
- [ ] Public HTTPS URL (the MCP spec requires https for every authorization endpoint except localhost)
- [ ] Neon connection with `sslmode=verify-full`
- [ ] `JWT_SECRET` in a secret manager; consider ES256 if another service ever verifies tokens
- [ ] Rate limits on `/login/*` (the SDK already limits `/register`, `/authorize`, `/token`, `/revoke`), and `trust proxy` set for the hosting platform
- [ ] Clean-up job for expired `auth_requests`, `auth_codes` and revoked `refresh_tokens`
- [ ] Close the sandbox window, `WORLD_ENVIRONMENT=production`, `WORLD_INVITE_CODE=false`
- [ ] Refuse confidential OAuth clients, or hash their secrets (the SDK stores `client_secret` in clear; Claude Code is a public client and has none)
- [ ] Client ID Metadata Documents (Claude Code falls back to dynamic registration today)

## Code layout

| Path | Responsibility |
|---|---|
| `src/app.ts` | Wires the OAuth router, the sign-in routes and `/mcp` |
| `src/config.ts` | Configuration schema and constants |
| `src/auth/provider.ts` | OAuth provider: login requests, codes, tokens, refresh, revocation, verification |
| `src/auth/clientsStore.ts` | Registered OAuth clients |
| `src/auth/tokens.ts` | JWT access tokens, random tokens, hashing |
| `src/auth/world.ts` | RP request signing and the World Verify API |
| `src/auth/accounts.ts` | Accounts, nullifiers and World ID sessions |
| `src/auth/loginRequests.ts` | The sign-in state machine |
| `src/auth/recovery.ts` | Recovery link build and parse |
| `src/auth/stagingWindow.ts` | Sandbox verification window (Developer Portal) |
| `src/http/login.ts`, `src/http/pages.ts` | Sign-in API, pages and assets |
| `public/` | Sign-in page, recovery page |
| `src/mcp/server.ts`, `src/skills/grades.ts` | The MCP server and `grade_skill` |
| `src/db/`, `migrations/` | Connection pool, migration runner, schema |
