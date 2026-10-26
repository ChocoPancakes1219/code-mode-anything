import {
  mkdir,
  readFile,
  writeFile,
  access,
  rm,
  mkdtemp,
} from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { publishStagedFiles } from "./files.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CmaError } from "./errors.js";
import { createMcpTransport } from "./transports.js";
import { workflowGuidance } from "./guidance.js";
import type {
  Backend,
  HarnessManifest,
  JsonSchema,
  Operation,
  RestParameter,
} from "./types.js";

export function assertHarnessName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(name))
    throw new CmaError(
      "INVALID_NAME",
      "Harness name must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens (up to 96 characters).",
    );
}

export async function generateMcpManifest(options: {
  name: string;
  backend: Extract<Backend, { kind: "mcp" }>;
  description?: string;
}): Promise<HarnessManifest> {
  assertHarnessName(options.name);
  const client = new Client({
    name: "code-mode-anything-generator",
    version: "0.1.0",
  });
  const connection = createMcpTransport(options.backend.transport);
  try {
    await client.connect(connection);
    const operations: Operation[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const tool of page.tools) {
        if (names.has(tool.name))
          throw new CmaError(
            "DUPLICATE_OPERATION",
            `Server returned duplicate tool ${tool.name}.`,
          );
        names.add(tool.name);
        operations.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as JsonSchema,
          ...(tool.outputSchema
            ? { outputSchema: tool.outputSchema as JsonSchema }
            : {}),
        });
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor))
        throw new CmaError(
          "INVALID_PAGINATION",
          "Server repeated its tools/list cursor.",
        );
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return {
      schemaVersion: 1,
      name: options.name,
      description:
        options.description ?? `Code-mode access to ${options.name}.`,
      backend: options.backend,
      operations,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CmaError("INVALID_OPENAPI", `${label} must be an object.`);
  return value as Record<string, any>;
}

/** Resolve local references only. Never fetch references supplied by an untrusted spec. */
function dereference(value: any, root: any, stack: string[] = []): any {
  if (Array.isArray(value))
    return value.map((item) => dereference(item, root, stack));
  if (!value || typeof value !== "object") return value;
  if (value.$ref) {
    const ref = String(value.$ref);
    if (!ref.startsWith("#/"))
      throw new CmaError(
        "UNSUPPORTED_REFERENCE",
        `Only local OpenAPI references are supported: ${ref}`,
      );
    if (stack.includes(ref))
      throw new CmaError(
        "UNSUPPORTED_REFERENCE",
        `Circular OpenAPI reference needs a custom adapter: ${ref}`,
      );
    const target = ref
      .slice(2)
      .split("/")
      .reduce(
        (node: any, key: string) =>
          node?.[
            decodeURIComponent(key).replace(/~1/g, "/").replace(/~0/g, "~")
          ],
        root,
      );
    if (target === undefined)
      throw new CmaError(
        "UNSUPPORTED_REFERENCE",
        `Missing local OpenAPI reference: ${ref}`,
      );
    return dereference(
      {
        ...target,
        ...Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== "$ref"),
        ),
      },
      root,
      [...stack, ref],
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      dereference(item, root, stack),
    ]),
  );
}

export function generateOpenApiManifest(options: {
  name: string;
  document: unknown;
  baseUrl?: string;
  headers?: Record<string, string>;
}): HarnessManifest {
  assertHarnessName(options.name);
  const root = record(options.document, "OpenAPI document");
  if (!/^3\.[01](?:\.|$)/.test(root.openapi ?? ""))
    throw new CmaError(
      "INVALID_OPENAPI",
      "An OpenAPI 3.0 or 3.1 JSON document is required.",
    );
  let baseUrl = options.baseUrl ?? root.servers?.[0]?.url;
  if (!baseUrl)
    throw new CmaError(
      "INVALID_OPENAPI",
      "Provide --base-url or an OpenAPI servers URL.",
    );
  if (!options.baseUrl)
    baseUrl = String(baseUrl).replace(/\{([^}]+)\}/g, (_, key: string) => {
      const fallback = root.servers[0].variables?.[key]?.default;
      if (fallback === undefined)
        throw new CmaError(
          "INVALID_OPENAPI",
          `Server variable ${key} needs --base-url.`,
        );
      return String(fallback);
    });
  if (!/^https?:\/\//.test(baseUrl))
    throw new CmaError(
      "INVALID_OPENAPI",
      "API base URL must use HTTP or HTTPS.",
    );
  const operations: Operation[] = [];
  const names = new Set<string>();
  for (const [path, rawItem] of Object.entries(
    record(root.paths, "OpenAPI paths"),
  )) {
    const item = dereference(rawItem, root);
    if (item.servers?.length && !options.baseUrl)
      throw new CmaError(
        "UNSUPPORTED_OPENAPI",
        "Path server overrides require an explicit --base-url.",
      );
    for (const method of [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "head",
      "options",
    ]) {
      if (!item[method]) continue;
      const operation = record(item[method], `Operation ${method} ${path}`);
      if (operation.servers?.length && !options.baseUrl)
        throw new CmaError(
          "UNSUPPORTED_OPENAPI",
          "Operation server overrides require an explicit --base-url.",
        );
      const name =
        operation.operationId ??
        `${method}_${path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
      if (names.has(name))
        throw new CmaError(
          "DUPLICATE_OPERATION",
          `Duplicate OpenAPI operationId: ${name}`,
        );
      names.add(name);
      const merged = new Map<string, any>();
      for (const parameter of [
        ...(item.parameters ?? []),
        ...(operation.parameters ?? []),
      ])
        merged.set(`${parameter.in}:${parameter.name}`, parameter);
      const parameters: RestParameter[] = [];
      const properties: Record<string, unknown> = Object.create(null);
      const required: string[] = [];
      for (const parameter of merged.values()) {
        if (!["path", "query", "header"].includes(parameter.in))
          throw new CmaError(
            "UNSUPPORTED_OPENAPI",
            `Parameter location ${parameter.in} needs a custom adapter.`,
          );
        if (properties[parameter.name])
          throw new CmaError(
            "UNSUPPORTED_OPENAPI",
            `Parameter ${parameter.name} appears in multiple locations; use a custom adapter.`,
          );
        const expectedStyle = parameter.in === "query" ? "form" : "simple";
        if (parameter.style && parameter.style !== expectedStyle)
          throw new CmaError(
            "UNSUPPORTED_OPENAPI",
            `Parameter style ${parameter.style} needs a custom adapter.`,
          );
        const schema = parameter.schema ?? {};
        if (
          !["string", "number", "integer", "boolean"].includes(schema.type) ||
          schema.properties ||
          schema.items ||
          schema.oneOf ||
          schema.anyOf ||
          schema.allOf
        )
          throw new CmaError(
            "UNSUPPORTED_OPENAPI",
            `Only primitive parameter schemas are supported; complex parameter ${parameter.name} needs a custom adapter.`,
          );
        properties[parameter.name] = schema;
        parameters.push({
          name: parameter.name,
          in: parameter.in,
          required: parameter.required === true || parameter.in === "path",
        });
        if (parameter.required || parameter.in === "path")
          required.push(parameter.name);
      }
      let requestBody: { argument: string; required: boolean } | undefined;
      if (operation.requestBody) {
        const body = operation.requestBody.content?.["application/json"];
        if (!body)
          throw new CmaError(
            "UNSUPPORTED_OPENAPI",
            `${name} requires a non-JSON request body; use a custom adapter.`,
          );
        if ("body" in properties)
          throw new CmaError(
            "UNSUPPORTED_OPENAPI",
            `${name} has a parameter named body; use a custom adapter.`,
          );
        properties.body = body.schema ?? {};
        requestBody = {
          argument: "body",
          required: operation.requestBody.required === true,
        };
        if (requestBody.required) required.push("body");
      }
      const responses = operation.responses ?? {};
      const response =
        responses[
          Object.keys(responses).find((status) => /^2\d\d$/.test(status)) ??
            "default"
        ];
      const outputSchema = response?.content?.["application/json"]?.schema;
      operations.push({
        name,
        description: operation.summary ?? operation.description,
        inputSchema: {
          ...(root.openapi.startsWith("3.1")
            ? { $schema: "https://json-schema.org/draft/2020-12/schema" }
            : {}),
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
        ...(outputSchema ? { outputSchema } : {}),
        binding: {
          method: method.toUpperCase(),
          path,
          parameters,
          ...(requestBody ? { requestBody } : {}),
        },
      });
    }
  }
  return {
    schemaVersion: 1,
    name: options.name,
    description:
      root.info?.description ??
      root.info?.title ??
      `API access to ${options.name}.`,
    backend: { kind: "openapi", baseUrl, headers: options.headers },
    operations,
  };
}

function schemaType(schema: any, depth = 0): string {
  if (!schema || depth > 10 || typeof schema !== "object") return "unknown";
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum))
    return (
      schema.enum.map((value: unknown) => JSON.stringify(value)).join(" | ") ||
      "never"
    );
  if (
    schema.nullable === true &&
    schema.type &&
    !Array.isArray(schema.type) &&
    schema.type !== "null"
  )
    return `${schemaType({ ...schema, nullable: false }, depth + 1)} | null`;
  for (const [key, separator] of [
    ["anyOf", " | "],
    ["oneOf", " | "],
    ["allOf", " & "],
  ]) {
    if (Array.isArray(schema[key]))
      return `(${schema[key].map((item: any) => schemaType(item, depth + 1)).join(separator)})`;
  }
  if (Array.isArray(schema.type))
    return schema.type
      .map((type: string) => schemaType({ ...schema, type }, depth + 1))
      .join(" | ");
  if (schema.$ref) return "unknown";
  if (schema.type === "string") return "string";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  if (schema.type === "array")
    return `Array<${schemaType(schema.items, depth + 1)}>`;
  if (schema.type === "object" || schema.properties) {
    const required = schema.required ?? [];
    const fields = Object.entries(schema.properties ?? {}).map(
      ([key, value]) =>
        `${JSON.stringify(key)}${required.includes(key) ? "" : "?"}: ${schemaType(value, depth + 1)}`,
    );
    if (schema.additionalProperties !== false)
      fields.push("[key: string]: unknown");
    return `{ ${fields.join("; ")} }`;
  }
  return "unknown";
}

export function generateDeclarations(manifest: HarnessManifest): string {
  const rawMcp =
    "{ content: Array<{ type: string; [key: string]: unknown }>; structuredContent?: unknown; isError?: boolean; [key: string]: unknown }";
  return `/** Generated from operation schemas. Runtime JSON Schema validation is authoritative. */\nexport interface HarnessTools {\n  ${JSON.stringify(manifest.name)}: {\n${manifest.operations.map((operation) => `    ${JSON.stringify(operation.name)}: (args: ${schemaType(operation.inputSchema)}) => Promise<${manifest.backend.kind === "mcp" ? rawMcp : schemaType(operation.outputSchema)}>;`).join("\n")}\n  };\n}\ndeclare const tools: HarnessTools;\n`;
}

export function generateModuleScaffold(name: string): HarnessManifest {
  assertHarnessName(name);
  return {
    schemaVersion: 1,
    name,
    description: `Code-mode adapter for ${name}; refine the generated adapter before use.`,
    backend: { kind: "module", entry: "./adapter.mjs" },
    operations: [
      {
        name: "info",
        description: "Inspect backend prerequisites and integration status.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        outputSchema: { type: "object" },
      },
    ],
  };
}

export async function writeHarness(
  manifest: HarnessManifest,
  directory: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  assertHarnessName(manifest.name);
  const dir = resolve(directory);
  if (
    manifest.backend.kind === "module" &&
    resolve(dir, manifest.backend.entry) !== join(dir, "adapter.mjs")
  )
    throw new CmaError(
      "INVALID_MODULE",
      "Generated module entry must be ./adapter.mjs.",
    );
  try {
    await access(join(dir, "manifest.json"));
    if (!options.overwrite)
      throw new CmaError(
        "ALREADY_EXISTS",
        `Harness already exists at ${dir}; use refresh instead of overwriting.`,
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(dir), { recursive: true });
  const stage = await mkdtemp(join(dirname(dir), ".cma-harness-"));
  try {
    await writeHarnessContents(manifest, stage, dir);
    // Keep implemented adapters when refreshing a scaffold.
    if (manifest.backend.kind === "module") {
      try {
        await writeFile(
          join(stage, "adapter.mjs"),
          await readFile(join(dir, "adapter.mjs")),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const validation = await validateHarness(stage);
    if (!validation.valid)
      throw new CmaError("INVALID_HARNESS", validation.errors.join("; "));
    await publishStagedFiles(stage, dir);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function writeHarnessContents(
  manifest: HarnessManifest,
  dir: string,
  finalDirectory: string,
): Promise<void> {
  await mkdir(join(dir, "skills"), { recursive: true });
  const runtimeGuide = `---\nname: codemode-${manifest.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}\ndescription: Use code mode to operate ${manifest.name}.\n---\n\n# ${manifest.name}\n\n${workflowGuidance}\nUse tools[${JSON.stringify(manifest.name)}][\"operation-name\"](arguments). Return only relevant results.\nRead tools.d.ts for generated argument types; use describe for current schemas.\n${manifest.backend.kind === "mcp" ? "\nMCP calls return their original envelopes: prefer structuredContent when present; parse text JSON explicitly only when appropriate. Forward image/content blocks with emit(block).\n" : ""}\nCredentials are configured by the backend and must never be printed. Install prerequisites listed in README.md.\n`;
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(join(dir, "tools.d.ts"), generateDeclarations(manifest));
  await writeFile(join(dir, "skills", "SKILL.md"), runtimeGuide);
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify({ name: `codemode-${manifest.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`, version: "0.1.0", type: "module", license: "MIT", files: ["manifest.json", "tools.d.ts", "adapter.mjs", "skills", "README.md", "TEST.md"], exports: { "./manifest": "./manifest.json", "./types": "./tools.d.ts" } }, null, 2)}\n`,
  );
  await writeFile(
    join(dir, "README.md"),
    `# ${manifest.name}\n\nInstall with \`cma install --manifest ./manifest.json --agent codex\`.\n\nThis harness invokes the actual backend. Credentials and required software must be configured before execution.\n\n## Operations\n\n${manifest.operations.map((op) => `- \`${op.name}\``).join("\n")}\n\nSearch includes focused schemas. Batch any missing descriptions, compose dependent calls in one execution, and return only the final aggregate. Run \`cma validate ${finalDirectory}\` to check package structure.\n`,
  );
  await writeFile(
    join(dir, "TEST.md"),
    "# Test plan and results\n\n## Plan\n\nValidate argument schemas, real backend calls, failures, and installed-package use outside the checkout.\n\n## Results\n\nNot run. Generation is not proof of backend functionality.\n",
  );
  if (manifest.backend.kind === "module") {
    const entry = resolve(dir, manifest.backend.entry);
    if (entry !== join(dir, "adapter.mjs"))
      throw new CmaError(
        "INVALID_MODULE",
        "Generated module entry must be ./adapter.mjs.",
      );
    try {
      await access(entry);
    } catch {
      await writeFile(
        entry,
        `export function createAdapter() {\n  return { async call(operation) {\n    if (operation === 'info') return { implemented: false, backend: ${JSON.stringify(manifest.name)}, next: 'Use the codemode-setup skill to implement and test the real backend.' };\n    throw new Error('Operation not implemented: ' + operation);\n  }};\n}\n`,
      );
    }
  }
}

export async function validateHarness(
  directory: string,
): Promise<{ valid: boolean; checks: string[]; errors: string[] }> {
  const dir = resolve(directory),
    checks: string[] = [],
    errors: string[] = [];
  for (const file of [
    "manifest.json",
    "tools.d.ts",
    "package.json",
    "skills/SKILL.md",
    "README.md",
    "TEST.md",
  ]) {
    try {
      await access(join(dir, file));
      checks.push(file);
    } catch {
      errors.push(`Missing ${file}`);
    }
  }
  if (!errors.length) {
    try {
      const { loadManifest } = await import("./manifest.js");
      const manifest = await loadManifest(join(dir, "manifest.json"));
      if (manifest.backend.kind === "module")
        await access(resolve(dir, manifest.backend.entry));
      checks.push("manifest schema");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { valid: errors.length === 0, checks, errors };
}
