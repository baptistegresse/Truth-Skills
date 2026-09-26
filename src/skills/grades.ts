import type { Queryable } from "../db/pool.js";

export interface SkillRef {
  name: string;
  provider: string;
}

export interface SkillSummary {
  skill_name: string;
  skill_provider: string;
  likes: number;
  dislikes: number;
}

// Records whether this account liked a skill, replacing any earlier grade, and returns the
// skill's totals. Deleted accounts no longer count.
export const gradeSkill = async (
  db: Queryable,
  accountId: string,
  skill: SkillRef,
  liked: boolean,
): Promise<SkillSummary> => {
  await db.query(
    `insert into skill_grades (account_id, skill_name, skill_provider, liked) values ($1, $2, $3, $4)
     on conflict (account_id, skill_provider, skill_name) do update
       set liked = excluded.liked, updated_at = now()`,
    [accountId, skill.name, skill.provider, liked],
  );
  const { rows } = await db.query<{ likes: number; dislikes: number }>(
    `select count(*) filter (where g.liked)::int as likes, count(*) filter (where not g.liked)::int as dislikes
     from skill_grades g join accounts a on a.id = g.account_id
     where g.skill_provider = $1 and g.skill_name = $2 and a.deleted_at is null`,
    [skill.provider, skill.name],
  );
  return { skill_name: skill.name, skill_provider: skill.provider, likes: rows[0]!.likes, dislikes: rows[0]!.dislikes };
};
