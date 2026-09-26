import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Response } from "express";

const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));
const require = createRequire(import.meta.url);
// The browser build is not an export of the package, so it is located by path. Written as a
// literal new URL(…, import.meta.url), which Vercel's file tracing follows into the function bundle.
const IDKIT_BROWSER_BUILD = fileURLToPath(
  new URL("../../node_modules/@worldcoin/idkit-core/dist/idkit.global.js", import.meta.url),
);
const IDKIT_DIR = dirname(require.resolve("@worldcoin/idkit-core")); // dist/, holds the wasm
const QRCODE_FILE = require.resolve("qrcode-generator");

// Served from our origin rather than a CDN, so the page can forbid every third-party script.
const ASSETS: Record<string, string> = {
  "login.js": join(PUBLIC_DIR, "login.js"),
  "login.css": join(PUBLIC_DIR, "login.css"),
  "idkit.global.js": IDKIT_BROWSER_BUILD,
  "idkit_wasm_bg.wasm": join(IDKIT_DIR, "idkit_wasm_bg.wasm"), // fetched by idkit.global.js, same folder
  "qrcode.js": QRCODE_FILE,
};

// The sign-in page handles who gets a token: no framing (clickjacking), no inline or foreign
// scripts, and the login request id in its URL is never sent on as a Referer. IDKit needs
// WebAssembly, and polls World's bridge over https.
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const sendPage = (res: Response, file: string) => {
  res.set({
    "content-security-policy": PAGE_CSP,
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.sendFile(join(PUBLIC_DIR, file));
};

export const createPagesRouter = () => {
  const router = express.Router();

  router.get("/login", (_req, res) => sendPage(res, "login.html"));
  // Opened from a recovery link: the session id stays in the fragment, which never reaches us.
  router.get("/login/recover", (_req, res) => sendPage(res, "recover.html"));

  router.get("/login/assets/:name", (req, res, next) => {
    const file = ASSETS[req.params.name];
    if (!file) return next();
    res.set({ "x-content-type-options": "nosniff", "cache-control": "no-cache" });
    res.sendFile(file);
  });

  return router;
};
