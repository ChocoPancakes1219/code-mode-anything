import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { BackendPool } from "../src/backends.js";
import type { HarnessManifest } from "../src/types.js";

test("persistent MCP adapter preserves rich results and uses one connection", async () => {
  const manifest: HarnessManifest = {
    schemaVersion: 1,
    name: "fixture",
    backend: {
      kind: "mcp",
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [resolve("tests/fixtures/mcp-server.mjs")],
      },
    },
    operations: [{ name: "echo", inputSchema: { type: "object" } }],
  };
  const pool = new BackendPool();
  try {
    const [first, second] = await Promise.all([
      pool.get(manifest),
      pool.get(manifest),
    ]);
    assert.equal(first, second);
    const a = (await first.call("echo", { value: "hello" })) as any;
    const b = (await second.call("echo", { value: "again" })) as any;
    assert.equal(a.content[1].type, "image");
    assert.equal(b.structuredContent.calls, 2);
  } finally {
    await pool.close();
  }
});
test("REST adapter maps encoded path/query/headers and JSON bodies", async () => {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        url: req.url,
        auth: req.headers.authorization,
        body: JSON.parse(body),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.CMA_TEST_TOKEN = "secret";
  const manifest: HarnessManifest = {
    schemaVersion: 1,
    name: "api",
    backend: {
      kind: "openapi",
      baseUrl: `http://127.0.0.1:${address.port}/v1?fixed=1`,
      headers: { authorization: "Bearer ${CMA_TEST_TOKEN}" },
    },
    operations: [
      {
        name: "save",
        inputSchema: { type: "object" },
        binding: {
          method: "POST",
          path: "/items/{id}",
          parameters: [
            { name: "id", in: "path", required: true },
            { name: "q", in: "query" },
          ],
          requestBody: {},
        },
      },
    ],
  };
  const pool = new BackendPool();
  try {
    const adapter = await pool.get(manifest);
    assert.deepEqual(
      await adapter.call("save", {
        id: "a/b",
        q: "one two",
        body: { ok: true },
      }),
      {
        url: "/v1/items/a%2Fb?fixed=1&q=one+two",
        auth: "Bearer secret",
        body: { ok: true },
      },
    );
    delete process.env.CMA_TEST_TOKEN;
    await assert.rejects(
      adapter.call("save", { id: "1", body: {} }),
      /Missing environment/,
    );
  } finally {
    await pool.close();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    delete process.env.CMA_TEST_TOKEN;
  }
});
test("evicts failed adapter connections so later attempts can recover", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "cma-adapter-"));
  const entry = join(dir, "adapter.mjs");
  const manifest: HarnessManifest = {
    schemaVersion: 1,
    name: "recover",
    backend: { kind: "module", entry },
    operations: [],
  };
  const pool = new BackendPool();
  try {
    await assert.rejects(pool.get(manifest), /Cannot find module/);
    await writeFile(
      entry,
      "export const createAdapter = () => ({call: async () => 42});",
    );
    assert.equal(await (await pool.get(manifest)).call("any", {}), 42);
    await pool.close();
    await assert.rejects(pool.get(manifest), /closed/);
  } finally {
    await pool.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("closing does not wait for an adapter factory that never resolves", async () => {
  const manifest: HarnessManifest = {
    schemaVersion: 1,
    name: "hanging",
    backend: {
      kind: "module",
      entry: resolve("tests/fixtures/hanging-adapter.mjs"),
    },
    operations: [],
  };
  const pool = new BackendPool();
  void pool.get(manifest).catch(() => {});
  const closed = await Promise.race([
    pool.close().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  assert.equal(closed, true);
});
