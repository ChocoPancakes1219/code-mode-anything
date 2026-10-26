import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadRuntime } from "./runtime.js";
import type { Runtime, HarnessManifest } from "./types.js";
import { workflowGuidance } from "./guidance.js";

type GatewayRuntime = Runtime & { manifests: HarnessManifest[] };

export function createGateway(runtime: GatewayRuntime): McpServer {
  const services = runtime.manifests
    .map(
      (manifest) =>
        `${manifest.name}: ${manifest.description ?? "installed operations"}`,
    )
    .join("\n")
    .slice(0, 2048);
  const server = new McpServer(
    { name: "code-mode-anything", version: "0.1.0" },
    {
      instructions: `Use code mode to operate these installed services:\n${services}\n${workflowGuidance} For MCP results check isError, use structuredContent when available, and parse documented text formats explicitly.`,
    },
  );
  const json = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  });
  server.registerTool(
    "search",
    {
      description:
        "Rank operations by task keywords; use server to scope. Top matches include input/output schemas, so skip describe when these suffice. Use includeSchemas:false for names only. Compose the workflow and return its aggregate in one execute call.",
      inputSchema: {
        query: z.string().default(""),
        server: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).default(5),
        offset: z.number().int().min(0).optional(),
        includeSchemas: z.boolean().default(true),
      },
    },
    async (input) =>
      json(
        runtime.search(input).map((result) => ({
          ...result,
          ...(result.description
            ? { description: result.description.slice(0, 160) }
            : {}),
        })),
      ),
  );
  server.registerTool(
    "describe",
    {
      description:
        "Get missing schemas. Use operations:[name,...] to describe several operations together, or operation for one. Skip this tool when search already returned the needed schemas.",
      inputSchema: {
        server: z.string(),
        operation: z.string().min(1).optional(),
        operations: z.array(z.string().min(1)).min(1).max(20).optional(),
      },
    },
    async (input) => {
      if (Boolean(input.operation) === Boolean(input.operations))
        return {
          isError: true,
          ...json({ error: "Choose operation or operations, exclusively." }),
        };
      return json(
        input.operations
          ? input.operations.map((operation) =>
              runtime.describe({ server: input.server, operation }),
            )
          : runtime.describe({
              server: input.server,
              operation: input.operation!,
            }),
      );
    },
  );
  server.registerTool(
    "execute",
    {
      description:
        "Run async JavaScript in an isolated QuickJS sandbox. Call tools[server][operation](args), console.log(), and emit(MCP content blocks). Compose dependent calls and filtering/aggregation in this script. Keep intermediate snapshots, listings, and raw envelopes local; return only the final answer. Results are compact by default; detail:'full' includes call diagnostics. No filesystem, network, or Node globals are available.",
      inputSchema: {
        code: z.string().max(262144),
        timeoutMs: z.number().int().min(1).max(30000).optional(),
        detail: z.enum(["compact", "full"]).default("compact"),
      },
    },
    async (input) => {
      try {
        const result = await runtime.execute(input);
        const { emitted, ...full } = result;
        const failures = result.calls.filter(
          (call) => !call.ok || call.isError,
        );
        const summary =
          input.detail === "full"
            ? full
            : {
                value: result.value,
                ...(result.logs.length ? { logs: result.logs } : {}),
                callCount: result.calls.length,
                failedCalls: failures.length,
                ...(failures.length
                  ? {
                      errors: failures.map((call) => ({
                        server: call.server,
                        operation: call.operation,
                        error:
                          call.error ??
                          (call.isError
                            ? "Backend reported isError: true"
                            : "Call did not complete before execution ended"),
                      })),
                    }
                  : {}),
                durationMs: result.durationMs,
              };
        return {
          content: [...json(summary).content, ...(emitted ?? [])],
        } as Awaited<ReturnType<Parameters<typeof server.registerTool>[2]>>;
      } catch (error) {
        return {
          isError: true,
          ...json({
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    },
  );
  return server;
}
export async function serveGateway(configPath: string): Promise<void> {
  const runtime = await loadRuntime(configPath);
  const server = createGateway(runtime);
  const transport = new StdioServerTransport();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
    await runtime.close();
  };
  transport.onclose = () => {
    void runtime.close();
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
  try {
    await server.connect(transport);
  } catch (error) {
    await close();
    throw error;
  }
}
