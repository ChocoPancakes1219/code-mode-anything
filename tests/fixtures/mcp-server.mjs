import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "fixture", version: "1" });
let calls = 0;
server.registerTool(
  "echo",
  { inputSchema: { value: z.string() } },
  async ({ value }) => ({
    content: [
      { type: "text", text: value },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ],
    structuredContent: { calls: ++calls },
  }),
);
await server.connect(new StdioServerTransport());
