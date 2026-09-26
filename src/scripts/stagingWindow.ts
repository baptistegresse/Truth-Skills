// npm run staging:open | staging:close — opens or closes the World ID sandbox verification window.
// Opening writes the 24-hour token to .env as WORLD_STAGING_TOKEN (never printed); restart the
// server afterwards. Close the window when you stop testing.
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { setStagingWindow, upsertEnv } from "../auth/stagingWindow.js";

const ENV_FILE = ".env";

const action = process.argv[2];
if (action !== "open" && action !== "close") {
  console.error("Usage: stagingWindow.ts open|close");
  process.exit(1);
}
const apiKey = process.env.WORLD_TEAM_API_KEY;
const appId = process.env.WORLD_APP_ID;
if (!apiKey || !appId) {
  console.error("Invalid or missing configuration: WORLD_TEAM_API_KEY, WORLD_APP_ID");
  process.exit(1);
}

// Written next to .env then renamed, so a crash never leaves a half-written file. Owner-only.
const writeToken = async (token: string) => {
  const content = await readFile(ENV_FILE, "utf8").catch(() => "");
  await writeFile(`${ENV_FILE}.tmp`, upsertEnv(content, "WORLD_STAGING_TOKEN", token), { mode: 0o600 });
  await rename(`${ENV_FILE}.tmp`, ENV_FILE);
  await chmod(ENV_FILE, 0o600);
};

try {
  const opened = await setStagingWindow({ apiKey, appId, enabled: action === "open" });
  await writeToken(opened?.token ?? "");
  console.log(
    opened
      ? `Sandbox verification window open until ${opened.expiresAt}. Token saved to .env; restart the server.`
      : "Sandbox verification window closed. Token removed from .env.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
