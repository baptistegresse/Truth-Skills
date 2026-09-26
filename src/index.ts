import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";

const main = () => {
  const config = loadConfig();
  // The sign-in routes are wired in a later branch.
  const app = createApp({ config, db: createPool(config.DATABASE_URL) });
  app.listen(config.PORT, () => {
    console.log(`Truth-Skills listening on ${config.PUBLIC_URL} (${config.WORLD_ENVIRONMENT})`);
  });
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
