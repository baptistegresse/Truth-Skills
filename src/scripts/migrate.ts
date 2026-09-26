// npm run migrate — applies pending migrations to DATABASE_URL.
import { z } from "zod";
import { createPool } from "../db/pool.js";
import { runMigrations } from "../db/migrate.js";

// Only the database is needed here, so the World ID and JWT settings are not required.
const env = z.object({ DATABASE_URL: z.string().startsWith("postgres") }).safeParse(process.env);
if (!env.success) {
  console.error("Invalid or missing configuration: DATABASE_URL");
  process.exit(1);
}

const pool = createPool(env.data.DATABASE_URL, 1);
try {
  const applied = await runMigrations(pool);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
