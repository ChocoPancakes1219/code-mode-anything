import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Checks the installed protocol surface, without invoking any business operation. */
export async function verifyGateway(
  configPath: string,
  cliPath = fileURLToPath(new URL("./cli.js", import.meta.url)),
): Promise<{ gatewayVerified: true; agentVerified: false; tools: string[] }> {
  const args = [
    ...(cliPath.endsWith(".ts") ? ["--import", "tsx"] : []),
    resolve(cliPath),
    "serve",
    "--config",
    resolve(configPath),
  ];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    stderr: "inherit",
  });
  const client = new Client({
    name: "cma-gateway-verification",
    version: "0.1.0",
  });
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport, { signal: controller.signal });
        const tools = (
          await client.listTools({}, { signal: controller.signal })
        ).tools.map((tool) => tool.name);
        if (
          tools.length !== 3 ||
          !["search", "describe", "execute"].every((name) =>
            tools.includes(name),
          )
        )
          throw new Error("Gateway did not expose the expected three tools.");
        const result = await client.callTool(
          { name: "execute", arguments: { code: "return { ready: true };" } },
          undefined,
          { signal: controller.signal },
        );
        const text = (
          result.content as Array<{ type: string; text?: string }>
        ).find((block) => block.type === "text")?.text;
        if (result.isError || !text || JSON.parse(text).value?.ready !== true)
          throw new Error("Gateway sandbox verification failed.");
        return {
          gatewayVerified: true as const,
          agentVerified: false as const,
          tools,
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Gateway verification timed out after 15 seconds."));
        }, 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}
