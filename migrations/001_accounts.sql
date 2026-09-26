-- One row per human. world_session_id is the World ID session used to recognise them later.
create table accounts (
  id uuid primary key default gen_random_uuid(),
  world_session_id text unique,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- The nullifier of the signup proof. Unique: a second account for the same human is impossible.
create table world_nullifiers (
  nullifier text primary key,
  action text not null,                 -- truth-skills-account-v1
  account_id uuid not null references accounts(id),
  created_at timestamptz not null default now()
);

create index world_nullifiers_account_id_idx on world_nullifiers (account_id);
