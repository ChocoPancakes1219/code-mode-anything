import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyGateway } from "../src/verify.js";

test("gateway verification uses real stdio initialize, discovery, and sandbox execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cma-verify-"));
  try {
    const config = join(dir, "config.json");
    await writeFile(
      config,
      JSON.stringify({ schemaVersion: 1, harnesses: [] }),
    );
    const result = await verifyGateway(config, resolve("src/cli.ts"));
    assert.equal(result.gatewayVerified, true);
    assert.equal(result.agentVerified, false);
    assert.deepEqual(result.tools, ["search", "describe", "execute"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
