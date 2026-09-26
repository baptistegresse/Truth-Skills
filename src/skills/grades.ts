import type { Queryable } from "../db/pool.js";

export interface SkillSummary {
  skill_name: string;
  likes: number;
  dislikes: number;
}

export interface SkillReport extends SkillSummary {
  found: boolean;
}

// The skill's likes and dislikes. Deleted accounts no longer count.
const skillTotals = async (db: Queryable, skillName: string): Promise<SkillSummary> => {
  const { rows } = await db.query<{ likes: number; dislikes: number }>(
    `select count(*) filter (where g.liked)::int as likes, count(*) filter (where not g.liked)::int as dislikes
     from skill_grades g join accounts a on a.id = g.account_id
     where g.skill_name = $1 and a.deleted_at is null`,
    [skillName],
  );
  return { skill_name: skillName, likes: rows[0]!.likes, dislikes: rows[0]!.dislikes };
};

// Records whether this account liked a skill, replacing any earlier grade, and returns the
// skill's totals.
export const gradeSkill = async (
  db: Queryable,
  accountId: string,
  skillName: string,
  liked: boolean,
): Promise<SkillSummary> => {
  await db.query(
    `insert into skill_grades (account_id, skill_name, liked) values ($1, $2, $3)
     on conflict (account_id, skill_name) do update
       set liked = excluded.liked, updated_at = now()`,
    [accountId, skillName, liked],
  );
  return skillTotals(db, skillName);
};

// What verified humans think of a skill, without changing anything. A skill nobody (still
// counted) has graded is not found: it is probably new.
export const checkSkill = async (db: Queryable, skillName: string): Promise<SkillReport> => {
  const totals = await skillTotals(db, skillName);
  return { ...totals, found: totals.likes + totals.dislikes > 0 };
};
