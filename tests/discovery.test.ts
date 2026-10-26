import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Runtime } from "../src/runtime.js";
import { createGateway } from "../src/gateway.js";
import type { HarnessManifest } from "../src/types.js";

function manifests(): HarnessManifest[] {
  return ["filesystem", "other"].map((name) => ({
    schemaVersion: 1,
    name,
    backend: { kind: "module", entry: resolve("tests/fixtures/adapter.mjs") },
    operations: [
      {
        name: "read_file",
        description: "DEPRECATED: Read files; use read_text_file.",
      },
      {
        name: "read_text_file",
        description: "Read a file as text. ".repeat(20),
      },
      { name: "list_directory", description: "List files in a directory." },
      { name: "fail", description: "Fail a call." },
      { name: "businessFail", description: "Return a business error." },
    ].map((operation) => ({
      ...operation,
      inputSchema: { type: "object", properties: {} },
    })),
  }));
}

test("ranked discovery handles multiple intents and scopes to the named server", async (t) => {
  const runtime = new Runtime(manifests());
  t.after(() => runtime.close());
  const results = runtime.search({ query: "filesystem list read files" });
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.server === "filesystem"));
  assert.ok(results.some((r) => r.operation === "list_directory"));
  assert.ok(results.some((r) => r.operation === "read_text_file"));
  assert.notEqual(results[0].operation, "read_file");
  assert.deepEqual(runtime.search({ query: "missing_unique_term" }), []);
  assert.deepEqual(runtime.search({ query: "read", server: "missing" }), []);
  const ranked = runtime.search({ query: "read files", server: "other" });
  assert.ok(ranked.every((r) => r.server === "other"));
  assert.deepEqual(
    runtime.search({
      query: "read files",
      server: "other",
      offset: 1,
      limit: 1,
    }),
    ranked.slice(1, 2),
  );
});

test("ranked discovery preserves non-Latin description queries", async (t) => {
  const catalog = manifests();
  catalog[0].operations[1].description = "读取文件";
  const runtime = new Runtime(catalog);
  t.after(() => runtime.close());
  assert.deepEqual(
    runtime.search({ query: "读取" }).map((r) => r.operation),
    ["read_text_file"],
  );
});

async function connection(t: { after(fn: () => Promise<void>): void }) {
  const runtime = new Runtime(manifests());
  const gateway = createGateway(runtime);
  const client = new Client({ name: "discovery-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await gateway.close();
    await runtime.close();
  });
  await gateway.connect(a);
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (
      result.content as Array<{ type: string; text?: string }>
    ).find((b) => b.type === "text")?.text;
    let value;
    try {
      value = JSON.parse(text!);
    } catch {
      value = { error: text };
    }
    return { envelope: result, value };
  };
  return { runtime, call };
}

test("gateway discovery returns focused schemas without full descriptions", async (t) => {
  const { call } = await connection(t);
  const { value } = await call("search", {
    query: "read",
    server: "filesystem",
  });
  assert.ok(value.length > 0 && value.length <= 5);
  assert.ok(value.every((v: any) => v.inputSchema?.type === "object"));
  assert.ok(
    value.every((v: any) => !v.description || v.description.length <= 160),
  );
  const plain = await call("search", {
    query: "read",
    server: "filesystem",
    includeSchemas: false,
  });
  assert.ok(plain.value.every((v: any) => v.inputSchema === undefined));
});

test("describe supports a batch and preserves single-operation compatibility", async (t) => {
  const { call } = await connection(t);
  const batch = await call("describe", {
    server: "filesystem",
    operations: ["read_text_file", "list_directory"],
  });
  assert.deepEqual(
    batch.value.map((v: any) => v.operation),
    ["read_text_file", "list_directory"],
  );
  assert.ok(batch.value.every((v: any) => v.inputSchema?.type === "object"));
  const single = await call("describe", {
    server: "filesystem",
    operation: "read_text_file",
  });
  assert.equal(single.value.operation, "read_text_file");
  const invalid = await call("describe", {
    server: "filesystem",
    operation: "fail",
    operations: ["fail"],
  });
  assert.equal(invalid.envelope.isError, true);
});

test("gateway returns compact execution results with opt-in full diagnostics", async (t) => {
  const { runtime, call } = await connection(t);
  const code =
    "for(let i=0;i<10;i++) await tools.filesystem.read_text_file({}); return {count:10};";
  const compact = (await call("execute", { code })).value;
  assert.deepEqual(compact.value, { count: 10 });
  assert.equal(compact.callCount, 10);
  assert.equal(compact.failedCalls, 0);
  assert.equal(compact.calls, undefined);
  const full = (await call("execute", { code, detail: "full" })).value;
  assert.equal(full.calls.length, 10);
  assert.deepEqual(full.logs, []);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length / 2);
  assert.equal((await runtime.execute({ code })).calls.length, 10);
});

test("compact results preserve logs, failed calls and discarded business errors", async (t) => {
  const { call } = await connection(t);
  const value = (
    await call("execute", {
      code: 'console.log("diagnostic"); try { await tools.filesystem.fail({}); } catch {} await tools.filesystem.businessFail({}); return 42;',
    })
  ).value;
  assert.equal(value.value, 42);
  assert.deepEqual(value.logs, ["diagnostic"]);
  assert.equal(value.callCount, 2);
  assert.equal(value.failedCalls, 2);
  assert.equal(value.errors.length, 2);
  assert.match(value.errors[0].error, /fixture failure/);
  assert.match(value.errors[1].error, /isError/);
});
