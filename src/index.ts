import { loadConfig } from "./config.js";

const main = () => {
  const config = loadConfig();
  // The Express app (OAuth router, sign-in routes, /mcp) is wired in later branches.
  console.log(`Truth-Skills configured for ${config.PUBLIC_URL} (${config.WORLD_ENVIRONMENT})`);
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
