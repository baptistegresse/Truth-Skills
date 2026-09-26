// Vercel entrypoint. The Express preset serves the default export of the first of app, index,
// server, src/app, src/index, src/server that imports "express"; this root file comes before
// src/app.ts, which only exports the createApp factory. Locally, `npm start` runs src/index.ts.
import type { Express } from "express";
import { createApp } from "./src/app.js";
import { loadConfig } from "./src/config.js";
import { createPool } from "./src/db/pool.js";

const config = loadConfig();
const app: Express = createApp({ config, db: createPool(config.DATABASE_URL) });

export default app;
