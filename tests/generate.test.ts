import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  readdir,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateOpenApiManifest,
  generateDeclarations,
  writeHarness,
  validateHarness,
  generateModuleScaffold,
} from "../src/generate.js";

test("invalid module entry leaves output untouched and permits a valid retry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cma-generation-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = generateModuleScaffold("example");
  await assert.rejects(
    writeHarness(
      { ...manifest, backend: { kind: "module", entry: "./wrong.mjs" } },
      root,
    ),
    /module entry/i,
  );
  assert.deepEqual(await readdir(root), []);
  await writeHarness(manifest, root);
  assert.equal((await validateHarness(root)).valid, true);
});

test("failed generation preserves existing content without publishing partial files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cma-generation-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "keep.txt"), "user content");
  await mkdir(join(root, "package.json"));
  await assert.rejects(writeHarness(generateModuleScaffold("example"), root));
  assert.deepEqual((await readdir(root)).sort(), ["keep.txt", "package.json"]);
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "user content");
});

test("declarations include nullable values without broadening enums", () => {
  const manifest = generateModuleScaffold("nullable");
  manifest.operations[0].inputSchema = {
    type: "object",
    properties: {
      value: { type: "string", nullable: true },
      nested: {
        type: "object",
        properties: { count: { type: "number", nullable: true } },
      },
      choice: { type: "string", nullable: true, enum: ["yes"] },
      optionalChoice: { type: "string", nullable: true, enum: ["yes", null] },
    },
  };
  const types = generateDeclarations(manifest);
  assert.match(types, /"value"\?: string \| null/);
  assert.match(types, /"count"\?: number \| null/);
  assert.match(types, /"choice"\?: "yes";/);
  assert.match(types, /"optionalChoice"\?: "yes" \| null/);
});

test("staged overwrite preserves implemented adapters and unrelated user files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cma-generation-overwrite-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = generateModuleScaffold("example");
  await writeHarness(manifest, root);
  await writeFile(
    join(root, "adapter.mjs"),
    "export const createAdapter = () => ({ call: async () => 42 });\n",
  );
  await writeFile(join(root, "notes.txt"), "keep notes");
  manifest.operations.push({ name: "added", inputSchema: {} });
  await writeHarness(manifest, root, { overwrite: true });
  assert.match(
    await readFile(join(root, "adapter.mjs"), "utf8"),
    /async \(\) => 42/,
  );
  assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "keep notes");
  assert.match(await readFile(join(root, "tools.d.ts"), "utf8"), /"added"/);
});

test("OpenAPI generation retains parameter/body schemas and resolves local references", () => {
  const manifest = generateOpenApiManifest({
    name: "example",
    document: {
      openapi: "3.0.3",
      servers: [{ url: "https://example.test/api" }],
      components: {
        schemas: {
          Item: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
      },
      paths: {
        "/items/{id}": {
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
            },
          ],
          patch: {
            operationId: "update-item",
            parameters: [
              { in: "query", name: "expand", schema: { type: "boolean" } },
            ],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Item" },
                },
              },
            },
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Item" },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  assert.equal(manifest.backend.kind, "openapi");
  assert.equal(manifest.operations[0].name, "update-item");
  assert.deepEqual(manifest.operations[0].inputSchema.required, ["id", "body"]);
  assert.equal(manifest.operations[0].binding?.path, "/items/{id}");
  assert.match(generateDeclarations(manifest), /"update-item"/);
  assert.match(generateDeclarations(manifest), /"title": string/);
});

test("unsupported OpenAPI references and duplicate operation names fail explicitly", () => {
  assert.throws(
    () =>
      generateOpenApiManifest({
        name: "api",
        document: {
          openapi: "3.0.0",
          servers: [{ url: "https://example.test" }],
          paths: {
            "/x": {
              get: {
                parameters: [{ $ref: "https://untrusted.test/param.json" }],
                responses: {},
              },
            },
          },
        },
      }),
    /external|local/i,
  );
  assert.throws(
    () =>
      generateOpenApiManifest({
        name: "api",
        document: {
          openapi: "3.0.0",
          servers: [{ url: "https://example.test" }],
          paths: {
            "/x": { get: { operationId: "same" } },
            "/y": { get: { operationId: "same" } },
          },
        },
      }),
    /duplicate/i,
  );
});

test("generated harness ships skill, declarations and package metadata without secret values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cma-generation-"));
  try {
    const manifest = generateModuleScaffold("example");
    await writeHarness(manifest, dir);
    const result = await validateHarness(dir);
    assert.equal(result.valid, true);
    assert.match(
      await readFile(join(dir, "skills", "SKILL.md"), "utf8"),
      /search|describe/,
    );
    assert.equal(
      JSON.parse(await readFile(join(dir, "package.json"), "utf8")).type,
      "module",
    );
    assert.ok(
      (await readFile(join(dir, "tools.d.ts"), "utf8")).includes(
        "HarnessTools",
      ),
    );
    await assert.rejects(() => writeHarness(manifest, dir), /exist|overwrite/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generation rejects path-traversal service names", () => {
  assert.throws(() => generateModuleScaffold("../escape"), /name/i);
});

test("OpenAPI generation refuses host overrides and nonprimitive parameter serialization", () => {
  const document = {
    openapi: "3.0.3",
    servers: [{ url: "https://default.test" }],
    paths: {
      "/x": {
        get: { servers: [{ url: "https://override.test" }], responses: {} },
      },
    },
  };
  assert.throws(
    () => generateOpenApiManifest({ name: "api", document }),
    /server.*override|base-url/i,
  );
  assert.equal(
    generateOpenApiManifest({
      name: "api",
      document,
      baseUrl: "https://explicit.test",
    }).operations.length,
    1,
  );
  assert.throws(
    () =>
      generateOpenApiManifest({
        name: "api",
        document: {
          openapi: "3.0.3",
          servers: [{ url: "https://default.test" }],
          paths: {
            "/x": {
              get: {
                parameters: [
                  {
                    name: "nested",
                    in: "query",
                    schema: { properties: { key: { type: "string" } } },
                  },
                ],
              },
            },
          },
        },
      }),
    /primitive|complex/i,
  );
});
