import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { StdioTransport, HttpTransport } from "./types.js";
import { expandEnv } from "./manifest.js";

export const expandHeaders = (headers: Record<string, string> = {}) =>
  Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, expandEnv(value)]),
  );

export function remoteTransport(
  transport: HttpTransport,
): StdioClientTransport {
  const packagePath = createRequire(import.meta.url).resolve(
    "mcp-remote/package.json",
  );
  const metadata = JSON.parse(readFileSync(packagePath, "utf8")) as {
    bin: string | Record<string, string>;
  };
  const bin =
    typeof metadata.bin === "string"
      ? metadata.bin
      : metadata.bin["mcp-remote"];
  if (!bin) throw new Error("Installed mcp-remote package has no executable");
  const args = [
    resolve(dirname(packagePath), bin),
    expandEnv(transport.url),
    ...Object.entries(expandHeaders(transport.headers)).flatMap(([k, v]) => [
      "--header",
      `${k}: ${v}`,
    ]),
  ];
  return new StdioClientTransport({
    command: process.execPath,
    args,
    stderr: "inherit",
  });
}

export function createMcpTransport(transport: StdioTransport | HttpTransport) {
  if (transport.type === "stdio")
    return new StdioClientTransport({
      command: expandEnv(transport.command),
      args: transport.args?.map(expandEnv),
      cwd: transport.cwd ? resolve(expandEnv(transport.cwd)) : undefined,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        ...expandHeaders(transport.env),
      },
      stderr: "inherit",
    });
  if (transport.oauth) return remoteTransport(transport);
  return new StreamableHTTPClientTransport(new URL(expandEnv(transport.url)), {
    requestInit: { headers: expandHeaders(transport.headers) },
  });
}
