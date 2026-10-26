import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadRuntime } from "../src/runtime.js";
import { executeSandbox } from "../src/sandbox.js";

test("JSON bridge preserves null and Unicode and reports size/serialization failures", async () => {
  const values: Record<string, unknown> = {
    empty: undefined,
    unicode: { text: "雪\u2028hello", list: [null, true, 42] },
    large: "x".repeat(1_048_577),
    bigint: 1n,
  };
  const result = await executeSandbox({
    operations: { fixture: Object.keys(values) },
    call: async (_server, name) => values[name],
    code: `const empty = await tools.fixture.empty(); const unicode = await tools.fixture.unicode(); const errors=[]; for (const name of ['large','bigint']) { try { await tools.fixture[name](); } catch (e) { errors.push(e.message); } } return {empty,unicode,errors};`,
  });
  const value = result.value as {
    empty: null;
    unicode: unknown;
    errors: string[];
  };
  assert.equal(value.empty, null);
  assert.deepEqual(value.unicode, values.unicode);
  assert.match(value.errors[0], /exceeds 1 MiB/);
  assert.match(value.errors[1], /BigInt/i);
  assert.deepEqual(
    result.calls.map((call) => call.ok),
    [true, true, false, false],
  );
});

test("operation schemas with reused IDs retain independent local references", async (t) => {
  const { Runtime } = await import("../src/runtime.js");
  const runtime = new Runtime([
    {
      schemaVersion: 1,
      name: "ids",
      backend: { kind: "module", entry: resolve("tests/fixtures/adapter.mjs") },
      operations: ["number", "string"].map((type) => ({
        name: type,
        inputSchema: {
          $id: "https://example.test/common",
          type: "object",
          properties: { value: { $ref: "#/$defs/value" } },
          $defs: { value: { type } },
          required: ["value"],
        },
      })),
    },
  ]);
  t.after(() => runtime.close());
  await runtime.call("ids", "number", { value: 1 });
  await runtime.call("ids", "string", { value: "ok" });
  await assert.rejects(
    runtime.call("ids", "number", { value: "bad" }),
    /Invalid arguments/,
  );
  await assert.rejects(
    runtime.call("ids", "string", { value: 1 }),
    /Invalid arguments/,
  );
});

test("runtime captures an immutable catalog snapshot and preserves paginated search order", async (t) => {
  const { Runtime } = await import("../src/runtime.js");
  const manifests = [
    {
      schemaVersion: 1 as const,
      name: "snapshot",
      backend: {
        kind: "module" as const,
        entry: resolve("tests/fixtures/adapter.mjs"),
      },
      operations: ["one", "two", "three"].map((name) => ({
        name,
        description: "SEARCH match",
        inputSchema: { type: "object" },
      })),
    },
  ];
  const runtime = new Runtime(manifests);
  t.after(() => runtime.close());
  manifests[0].operations[0].name = "changed";
  assert.equal(
    runtime.describe({ server: "snapshot", operation: "one" }).operation,
    "one",
  );
  assert.equal(Object.isFrozen(runtime.manifests[0].operations), true);
  assert.deepEqual(
    runtime
      .search({ query: "search", offset: 1, limit: 1 })
      .map((v) => v.operation),
    ["two"],
  );
  assert.equal(runtime.search({ query: "missing" }).length, 0);
  const result = runtime.search({ query: "one" });
  result[0].description = "mutated result";
  assert.equal(runtime.search({ query: "one" })[0].description, "SEARCH match");
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "cma-runtime-"));
  const operations = ["echo", "fail", "wait"].map((name) => ({
    name,
    inputSchema: {
      type: "object",
      properties: { value: { type: "number" } },
      additionalProperties: false,
    },
  }));
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "fixture",
      backend: { kind: "module", entry: resolve("tests/fixtures/adapter.mjs") },
      operations,
    }),
  );
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({
      schemaVersion: 1,
      harnesses: [{ manifestPath: "manifest.json" }],
    }),
  );
  const runtime = await loadRuntime(join(dir, "config.json"));
  return {
    runtime,
    async close() {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("sandbox awaits parallel calls, catches failures, and preserves emitted content", async () => {
  const f = await fixture();
  try {
    const result = await f.runtime.execute({
      code: `const values = await Promise.all([tools.fixture.echo({value:1}),tools.fixture.echo({value:2})]); try { await tools.fixture.fail({}); } catch(e) { console.log(e.message); } emit({type:'image',data:'YWJj',mimeType:'image/png'}); return values;`,
    });
    assert.deepEqual(result.value, [
      { operation: "echo", value: 1 },
      { operation: "echo", value: 2 },
    ]);
    assert.equal(result.calls.length, 3);
    assert.match(result.logs[0], /fixture failure/);
    assert.equal(result.emitted?.[0].type, "image");
  } finally {
    await f.close();
  }
});
test("sandbox terminates CPU loops and unresolved promises and isolates executions", async () => {
  const f = await fixture();
  try {
    for (const code of [
      "while(true) {}",
      "await new Promise(() => {});",
      "await tools.fixture.wait({});",
    ]) {
      await assert.rejects(
        f.runtime.execute({ code, timeoutMs: 500 }),
        /timed out|deadline/i,
      );
    }
    await f.runtime.execute({ code: "globalThis.secret = 42; return 1;" });
    assert.equal(
      (await f.runtime.execute({ code: "return typeof secret;" })).value,
      "undefined",
    );
    assert.equal(
      (
        await f.runtime.execute({
          code: 'return typeof process + ":" + typeof require + ":" + typeof fetch;',
        })
      ).value,
      "undefined:undefined:undefined",
    );
  } finally {
    await f.close();
  }
});
test("validates arguments before calling adapter and exposes discovery", async () => {
  const f = await fixture();
  try {
    assert.equal(f.runtime.search({ query: "echo" })[0].operation, "echo");
    assert.equal(
      f.runtime.describe({ server: "fixture", operation: "echo" }).inputSchema
        .type,
      "object",
    );
    await assert.rejects(
      f.runtime.call("fixture", "echo", { value: "bad" }),
      /arguments/i,
    );
    await assert.rejects(
      f.runtime.execute({ code: 'return tools.fixture.echo({value:"bad"});' }),
      /arguments/i,
    );
  } finally {
    await f.close();
  }
});
test("enforces call/output limits and validates local schema refs", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.runtime.execute({
        code: "for(let i=0;i<1000;i++){try{await tools.fixture.echo({});}catch(e){}} return 1;",
      }),
      /100 tool calls/,
    );
    await assert.rejects(
      f.runtime.execute({ code: 'console.log("x".repeat(1100000));' }),
      /output exceeds/,
    );
    const { Runtime } = await import("../src/runtime.js");
    const referenced = new Runtime([
      {
        ...f.runtime.manifests[0],
        operations: [
          {
            name: "echo",
            inputSchema: {
              type: "object",
              properties: { value: { $ref: "#/$defs/number" } },
              $defs: { number: { type: "number" } },
            },
          },
        ],
      },
    ]);
    try {
      await assert.rejects(
        referenced.call("fixture", "echo", { value: "wrong" }),
        /Invalid arguments/,
      );
    } finally {
      await referenced.close();
    }
  } finally {
    await f.close();
  }
});
test("gateway exposes only discovery and execute and returns emitted MCP blocks", async () => {
  const f = await fixture();
  const { createGateway } = await import("../src/gateway.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const gateway = createGateway(f.runtime);
  const client = new Client({ name: "test", version: "1" });
  const [host, peer] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([gateway.connect(host), client.connect(peer)]);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      ["describe", "execute", "search"],
    );
    const result = await client.callTool({
      name: "execute",
      arguments: {
        code: 'emit({type:"image",data:"YWJj",mimeType:"image/png"}); return 7;',
      },
    });
    assert.equal((result.content as any[])[1].type, "image");
    assert.equal(JSON.parse((result.content as any[])[0].text).value, 7);
    const error = await client.callTool({
      name: "execute",
      arguments: { code: 'throw new Error("expected failure");' },
    });
    assert.equal(error.isError, true);
  } finally {
    await client.close();
    await gateway.close();
    await f.close();
  }
});
test("manifest validation reports malformed backend fields and accepts safe dotted names", async () => {
  const { loadManifest } = await import("../src/manifest.js");
  const dir = await mkdtemp(join(tmpdir(), "cma-invalid-"));
  const path = join(dir, "manifest.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        name: "1.example",
        backend: { kind: "mcp", transport: { type: "stdio" } },
        operations: [],
      }),
    );
    await assert.rejects(loadManifest(path), /Invalid manifest.*command/s);
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        name: "1.example",
        backend: { kind: "module", entry: "adapter.mjs" },
        operations: [],
      }),
    );
    assert.equal((await loadManifest(path)).name, "1.example");
    process.env.CMA_TEST_CWD = dir;
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        name: "cwd",
        backend: {
          kind: "mcp",
          transport: { type: "stdio", command: "node", cwd: "${CMA_TEST_CWD}" },
        },
        operations: [],
      }),
    );
    const loaded = await loadManifest(path);
    assert.equal(
      loaded.backend.kind === "mcp" &&
        loaded.backend.transport.type === "stdio" &&
        loaded.backend.transport.cwd,
      dir,
    );
    delete process.env.CMA_TEST_CWD;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects malformed emitted MCP content blocks", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.runtime.execute({ code: 'emit({type:"image",data:42});' }),
      /Invalid emitted MCP content/,
    );
  } finally {
    await f.close();
  }
});
test("validates schemas declaring draft 2020-12 including prefixItems", async () => {
  const f = await fixture();
  const { Runtime } = await import("../src/runtime.js");
  try {
    const runtime = new Runtime([
      {
        ...f.runtime.manifests[0],
        operations: [
          {
            name: "echo",
            inputSchema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              properties: {
                value: {
                  type: "array",
                  prefixItems: [{ type: "number" }],
                  items: false,
                },
              },
            },
          },
        ],
      },
    ]);
    try {
      await assert.rejects(
        runtime.call("fixture", "echo", { value: ["bad"] }),
        /Invalid arguments/,
      );
      assert.deepEqual(await runtime.call("fixture", "echo", { value: [1] }), {
        operation: "echo",
        value: [1],
      });
    } finally {
      await runtime.close();
    }
  } finally {
    await f.close();
  }
});
