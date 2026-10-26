import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { CmaError } from "./errors.js";
import type { HarnessManifest } from "./types.js";

const textMap = z.record(z.string(), z.string());
const schema = z.record(z.string(), z.unknown());
const transportSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: textMap.optional(),
    cwd: z.string().optional(),
  }),
  z.object({
    type: z.literal("http"),
    url: z.string().min(1),
    headers: textMap.optional(),
    oauth: z.literal("mcp-remote").optional(),
  }),
]);
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/),
  description: z.string().optional(),
  backend: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("mcp"), transport: transportSchema }),
    z.object({
      kind: z.literal("openapi"),
      baseUrl: z.string().min(1),
      headers: textMap.optional(),
    }),
    z.object({ kind: z.literal("module"), entry: z.string().min(1) }),
  ]),
  operations: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      inputSchema: schema,
      outputSchema: schema.optional(),
      binding: z
        .object({
          method: z.string().regex(/^[A-Za-z]+$/),
          path: z.string(),
          parameters: z
            .array(
              z.object({
                name: z.string().min(1),
                in: z.enum(["path", "query", "header"]),
                required: z.boolean().optional(),
              }),
            )
            .optional(),
          requestBody: z
            .object({
              argument: z.string().optional(),
              required: z.boolean().optional(),
            })
            .optional(),
        })
        .optional(),
    }),
  ),
});
const configSchema = z.object({
  schemaVersion: z.literal(1),
  harnesses: z.array(
    z.object({
      manifestPath: z.string().min(1),
      enabled: z.boolean().optional(),
    }),
  ),
});

export function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
    const result = process.env[key];
    if (result === undefined)
      throw new CmaError("MISSING_ENV", `Missing environment variable: ${key}`);
    return result;
  });
}
export async function loadManifest(path: string): Promise<HarnessManifest> {
  const result = manifestSchema.safeParse(
    JSON.parse(await readFile(path, "utf8")),
  );
  if (!result.success)
    throw new Error(`Invalid manifest ${path}: ${result.error.message}`);
  const manifest = result.data;
  const names = new Set<string>();
  for (const operation of manifest.operations) {
    if (names.has(operation.name))
      throw new Error(`Duplicate operation ${operation.name} in ${path}`);
    if (manifest.backend.kind === "openapi" && !operation.binding)
      throw new Error(`Missing REST binding for ${operation.name} in ${path}`);
    names.add(operation.name);
  }
  if (manifest.backend.kind === "module")
    manifest.backend.entry = resolve(dirname(path), manifest.backend.entry);
  if (
    manifest.backend.kind === "mcp" &&
    manifest.backend.transport.type === "stdio" &&
    manifest.backend.transport.cwd
  )
    manifest.backend.transport.cwd = resolve(
      dirname(path),
      expandEnv(manifest.backend.transport.cwd),
    );
  return manifest;
}
export async function loadConfig(path: string): Promise<HarnessManifest[]> {
  const result = configSchema.safeParse(
    JSON.parse(await readFile(path, "utf8")),
  );
  if (!result.success)
    throw new Error(
      `Invalid runtime configuration ${path}: ${result.error.message}`,
    );
  const manifests = await Promise.all(
    result.data.harnesses
      .filter((h) => h.enabled !== false)
      .map((h) => loadManifest(resolve(dirname(path), h.manifestPath))),
  );
  if (new Set(manifests.map((m) => m.name)).size !== manifests.length)
    throw new Error("Duplicate harness name in configuration");
  return manifests;
}
