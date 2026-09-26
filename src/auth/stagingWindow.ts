import { z } from "zod";

// World's Developer Portal MCP server: the only place a sandbox verification window can be
// opened. The team API key it needs has power over the whole World team; it stays in .env.
export const DEVELOPER_PORTAL_MCP = "https://developer.world.org/api/mcp";

const RpcResponse = z.object({
  result: z
    .object({
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
      isError: z.boolean().optional(),
    })
    .optional(),
  error: z.object({ message: z.string() }).optional(),
});

const OpenedWindow = z.object({
  staging_verification_token: z.string().min(1),
  staging_verification_expires_at: z.string(),
});

// The portal may answer as JSON or as a one-event SSE stream; returns the JSON-RPC message.
const readRpcBody = (body: string) => {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as unknown;
  const data = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  return JSON.parse(data) as unknown;
};

// Calls set_world_id_staging_verification. Errors never include the API key or the token.
export const setStagingWindow = async (
  { apiKey, appId, enabled }: { apiKey: string; appId: string; enabled: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<{ token: string; expiresAt: string } | null> => {
  const response = await fetchImpl(DEVELOPER_PORTAL_MCP, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "set_world_id_staging_verification", arguments: { app_id: appId, enabled } },
    }),
  });
  if (!response.ok) throw new Error(`Developer Portal answered HTTP ${response.status}`);

  const message = RpcResponse.parse(readRpcBody(await response.text()));
  const text = message.result?.content.find((item) => item.type === "text")?.text;
  if (message.error || message.result?.isError || text === undefined) {
    throw new Error(`Developer Portal refused: ${message.error?.message ?? text ?? "no result"}`);
  }
  if (!enabled) return null;
  const opened = OpenedWindow.parse(JSON.parse(text));
  return { token: opened.staging_verification_token, expiresAt: opened.staging_verification_expires_at };
};

// Sets KEY=value in .env content, replacing the existing line or appending one.
export const upsertEnv = (content: string, key: string, value: string) => {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) return content.replace(pattern, line);
  return `${content}${content === "" || content.endsWith("\n") ? "" : "\n"}${line}\n`;
};
