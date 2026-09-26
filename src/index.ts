import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const main = () => {
  const config = loadConfig();
  // The OAuth router and sign-in routes are wired in later branches.
  const app = createApp({ config });
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
