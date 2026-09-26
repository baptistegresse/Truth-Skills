-- OAuth clients created by dynamic registration (Claude Code registers itself).
create table oauth_clients (
  client_id text primary key,
  info jsonb not null,                  -- full registration: client_name, redirect_uris, …
  created_at timestamptz not null default now()
);

-- A sign-in in progress, from /authorize until the code is issued.
create table auth_requests (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references oauth_clients(client_id),
  redirect_uri text not null,
  code_challenge text not null,         -- PKCE S256 challenge
  state text,
  scopes text[] not null,
  resource text,                        -- canonical MCP URL (RFC 8707)
  account_id uuid references accounts(id),
  step text not null default 'start'
    check (step in ('start', 'account', 'awaiting_session', 'session', 'prove')),
  expected_nonce text,                  -- nonce of the World ID request currently shown
  expected_session_id text,             -- session a "prove" step must match
  created_at timestamptz not null default now(),
  expires_at timestamptz not null       -- now() + 10 min
);

-- Authorization codes, stored hashed, usable once, 60 s.
create table auth_codes (
  code_hash text primary key,
  client_id text not null references oauth_clients(client_id),
  account_id uuid not null references accounts(id),
  redirect_uri text not null,
  code_challenge text not null,
  scopes text[] not null,
  resource text,
  expires_at timestamptz not null,
  used_at timestamptz
);

-- Refresh tokens, stored hashed, rotated on every use, 90 days.
create table refresh_tokens (
  token_hash text primary key,
  account_id uuid not null references accounts(id),
  client_id text not null references oauth_clients(client_id),
  scopes text[] not null,
  resource text,
  expires_at timestamptz not null,
  revoked_at timestamptz
);

-- Clean-up jobs sweep by expiry; revocation looks tokens up by account.
create index auth_requests_expires_at_idx on auth_requests (expires_at);
create index auth_codes_expires_at_idx on auth_codes (expires_at);
create index refresh_tokens_account_id_idx on refresh_tokens (account_id);
