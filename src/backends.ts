import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  HarnessAdapter,
  HarnessManifest,
  AdapterFactory,
} from "./types.js";
import { expandEnv } from "./manifest.js";
import { createMcpTransport, expandHeaders } from "./transports.js";
export { remoteTransport } from "./transports.js";

export class BackendPool {
  private connections = new Map<string, Promise<HarnessAdapter>>();
  private closed = false;
  private adapters = new Set<HarnessAdapter>();
  private opening = new Set<() => Promise<void>>();
  async get(manifest: HarnessManifest): Promise<HarnessAdapter> {
    if (this.closed) throw new Error("Backend pool is closed");
    let pending = this.connections.get(manifest.name);
    if (!pending) {
      pending = this.connect(manifest)
        .then(async (adapter) => {
          if (this.closed) {
            await adapter.close?.();
            throw new Error("Backend pool is closed");
          }
          this.adapters.add(adapter);
          return adapter;
        })
        .catch((error) => {
          this.connections.delete(manifest.name);
          throw error;
        });
      this.connections.set(manifest.name, pending);
    }
    return pending;
  }
  private async connect(manifest: HarnessManifest): Promise<HarnessAdapter> {
    const backend = manifest.backend;
    if (backend.kind === "module") {
      const module = (await import(pathToFileURL(backend.entry).href)) as {
        createAdapter?: AdapterFactory;
      };
      if (typeof module.createAdapter !== "function")
        throw new Error("Module backend must export createAdapter(manifest)");
      const adapter = await module.createAdapter(manifest);
      if (typeof adapter.call !== "function")
        throw new Error(
          "Module adapter must expose call(operation, args, signal)",
        );
      return adapter;
    }
    if (backend.kind === "openapi")
      return {
        async call(name, args, signal) {
          const operation = manifest.operations.find((o) => o.name === name);
          const binding = operation?.binding;
          if (!binding) throw new Error(`Missing REST binding for ${name}`);
          let path = binding.path;
          const headers = expandHeaders(backend.headers);
          const query = new URLSearchParams();
          for (const parameter of binding.parameters ?? []) {
            const value = args[parameter.name];
            if (value === undefined) {
              if (parameter.required)
                throw new Error(`Missing parameter: ${parameter.name}`);
              continue;
            }
            if (parameter.in === "path")
              path = path.replaceAll(
                `{${parameter.name}}`,
                encodeURIComponent(String(value)),
              );
            if (parameter.in === "query")
              for (const item of Array.isArray(value) ? value : [value])
                query.append(parameter.name, String(item));
            if (parameter.in === "header")
              headers[parameter.name] = String(value);
          }
          if (/\{[^}]+\}/.test(path))
            throw new Error(`Unresolved path parameters: ${path}`);
          const url = new URL(expandEnv(backend.baseUrl));
          url.pathname =
            url.pathname.replace(/\/$/, "") + "/" + path.replace(/^\//, "");
          for (const [key, value] of query) url.searchParams.append(key, value);
          const body = binding.requestBody
            ? args[binding.requestBody.argument ?? "body"]
            : undefined;
          if (binding.requestBody?.required && body === undefined)
            throw new Error("Missing request body");
          if (body !== undefined) headers["content-type"] = "application/json";
          const response = await fetch(url, {
            method: binding.method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
          });
          const text = await response.text();
          if (!response.ok)
            throw new Error(`HTTP ${response.status}: ${text.slice(0, 4096)}`);
          if (!text) return null;
          return response.headers.get("content-type")?.includes("json")
            ? JSON.parse(text)
            : text;
        },
      };
    const connection = createMcpTransport(backend.transport);
    const client = new Client({ name: "code-mode-anything", version: "0.1.0" });
    const cancel = () => client.close();
    this.opening.add(cancel);
    try {
      if (this.closed) throw new Error("Backend pool is closed");
      await client.connect(connection);
    } catch (error) {
      await connection.close().catch(() => {});
      throw error;
    } finally {
      this.opening.delete(cancel);
    }
    return {
      async call(name, args, signal) {
        return client.callTool({ name, arguments: args }, undefined, {
          signal,
        });
      },
      async close() {
        await client.close();
      },
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    this.connections.clear();
    const closing = [...this.opening].map((close) => close());
    this.opening.clear();
    closing.push(
      ...[...this.adapters].map((adapter) =>
        Promise.resolve(adapter.close?.()),
      ),
    );
    this.adapters.clear();
    await Promise.allSettled(closing);
  }
}
