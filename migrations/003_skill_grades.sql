-- One grade per human per skill: a unique World ID account is one vote, and grading again
-- replaces the earlier grade.
create table skill_grades (
  account_id uuid not null references accounts(id),
  skill_name text not null,
  skill_provider text not null,
  liked boolean not null,               -- true: good, false: bad
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, skill_provider, skill_name)
);

create index skill_grades_skill_idx on skill_grades (skill_provider, skill_name);
