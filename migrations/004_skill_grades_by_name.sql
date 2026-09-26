-- A skill is identified by its name alone, as in the skills specification: the provider an agent
-- reports is a guess (a plugin prefix, a GitHub org…), and the same skill must not be counted twice.
-- Grades an account gave to one name under several providers collapse into the most recent one.
delete from skill_grades g
using skill_grades newer
where g.account_id = newer.account_id
  and g.skill_name = newer.skill_name
  and (g.updated_at, g.skill_provider) < (newer.updated_at, newer.skill_provider);

alter table skill_grades drop constraint skill_grades_pkey;
drop index skill_grades_skill_idx;
alter table skill_grades drop column skill_provider;
alter table skill_grades add primary key (account_id, skill_name);

create index skill_grades_skill_name_idx on skill_grades (skill_name);
