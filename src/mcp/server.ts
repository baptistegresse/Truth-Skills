import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const SERVER_INFO = { name: "truth-skills", version: "0.1.0" };

// A fresh server per request (the endpoint is stateless). Tools are registered in a later branch;
// they will read the caller's account from extra.authInfo, never from a tool argument.
export const createMcpServer = () => new McpServer(SERVER_INFO);
