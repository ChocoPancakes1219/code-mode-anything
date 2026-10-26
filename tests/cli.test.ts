import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const exec = promisify(execFile);
const cli = (...args: string[]) =>
  exec(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), ...args], {
    cwd: process.cwd(),
  });

test("CLI help exposes supported management and generator workflows", async () => {
  const result = await cli("--help");
  for (const command of ["install", "serve", "import", "scaffold", "verify"])
    assert.match(result.stdout, new RegExp(command));
});
test("CLI scaffolds and validates an installable module harness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cma-cli-"));
  try {
    const output = join(dir, "harness");
    const result = JSON.parse(
      (await cli("scaffold", "example", "--output", output, "--json")).stdout,
    );
    assert.equal(result.backendVerified, false);
    const validation = JSON.parse(
      (await cli("validate", output, "--json")).stdout,
    );
    assert.equal(validation.valid, true);
    assert.equal(validation.backendVerified, false);
    assert.ok(await readFile(join(output, "skills", "SKILL.md"), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("CLI executes a local adapter and reports unknown operation as failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cma-cli-run-"));
  try {
    await writeFile(
      join(dir, "adapter.mjs"),
      "export const createAdapter=()=>({call:async(_name,args)=>({answer:args.value*2})});",
    );
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "local",
        backend: { kind: "module", entry: "./adapter.mjs" },
        operations: [
          {
            name: "double",
            inputSchema: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            },
          },
        ],
      }),
    );
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        harnesses: [{ manifestPath: "./manifest.json" }],
      }),
    );
    const result = JSON.parse(
      (
        await cli(
          "run",
          "--config",
          join(dir, "config.json"),
          "--code",
          "return await tools.local.double({value:21});",
          "--json",
        )
      ).stdout,
    );
    assert.deepEqual(result.value, { answer: 42 });
    await assert.rejects(() =>
      cli(
        "run",
        "--config",
        join(dir, "config.json"),
        "--code",
        "return await tools.local.missing({});",
        "--json",
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("noninteractive install requires explicit original choice before discovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cma-cli-install-"));
  try {
    await assert.rejects(
      () =>
        cli(
          "install",
          "--agent",
          "codex",
          "--project",
          dir,
          "--server",
          "example",
          "--non-interactive",
          "--json",
        ),
      (error: any) => {
        assert.match(error.stderr, /original/i);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
