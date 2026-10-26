import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
const exec = promisify(execFile);
const root = process.cwd();
const temporary = await mkdtemp(join(tmpdir(), "cma-package-smoke-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = async (command, args, options = {}) =>
  exec(command, args, { maxBuffer: 4 * 1024 * 1024, ...options });
try {
  const pack = await run(
    npm,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
    { cwd: root },
  );
  const [{ filename, files: packedFiles }] = JSON.parse(pack.stdout);
  assert.ok(
    !packedFiles.some((file) =>
      /(^benchmarks\/|^dist\/(schema-)?benchmark\.)/.test(file.path),
    ),
  );
  const prefix = join(temporary, "installation");
  await run(npm, [
    "install",
    "--prefix",
    prefix,
    join(temporary, filename),
    "--ignore-scripts",
    ...(process.env.CMA_NPM_CACHE
      ? ["--cache", process.env.CMA_NPM_CACHE]
      : []),
    ...(process.env.CMA_NPM_OFFLINE === "1" ? ["--offline"] : []),
  ]);
  const cli = join(
    prefix,
    "node_modules",
    "code-mode-anything",
    "dist",
    "cli.js",
  );
  const command = (...args) => run(process.execPath, [cli, ...args]);
  assert.match((await command("--help")).stdout, /code-mode/i);
  const catalog = JSON.parse(
    (await command("catalog", "list", "--json")).stdout,
  );
  assert.equal(catalog.length, 5);
  for (const entry of catalog) await access(entry.manifest);
  const harness = join(temporary, "harness");
  await command("scaffold", "fixture", "--output", harness, "--json");
  await writeFile(
    join(harness, "adapter.mjs"),
    'export function createAdapter(){return {async call(name,args){if(name!=="sum")throw new Error("unknown");return {answer:args.a+args.b};}};}',
  );
  await writeFile(
    join(harness, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "fixture",
      backend: { kind: "module", entry: "./adapter.mjs" },
      operations: [
        {
          name: "sum",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
            additionalProperties: false,
          },
        },
      ],
    }),
  );
  const validation = JSON.parse(
    (await command("validate", harness, "--json")).stdout,
  );
  assert.equal(validation.valid, true);
  // Install the generated harness package itself, outside its source directory.
  const generatedPack = await run(
    npm,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
    { cwd: harness },
  );
  const generatedFilename = JSON.parse(generatedPack.stdout)[0].filename;
  const backendPrefix = join(temporary, "backend");
  await run(npm, [
    "install",
    "--prefix",
    backendPrefix,
    join(temporary, generatedFilename),
    "--ignore-scripts",
    "--offline",
  ]);
  const installedManifest = join(
    backendPrefix,
    "node_modules",
    "codemode-fixture",
    "manifest.json",
  );
  await rm(harness, { recursive: true, force: true });
  const project = join(temporary, "project"),
    home = join(temporary, "home");
  await mkdir(project);
  await mkdir(home);
  const common = ["--agent", "codex", "--project", project, "--home-dir", home];
  const installed = JSON.parse(
    (
      await command(
        "install",
        ...common,
        "--manifest",
        installedManifest,
        "--non-interactive",
        "--json",
      )
    ).stdout,
  );
  assert.equal(installed.runtimeVerified, true);
  const verified = JSON.parse(
    (await command("verify", ...common, "--json")).stdout,
  );
  assert.equal(verified.gatewayVerified, true);
  assert.equal(verified.agentVerified, false);
  const result = JSON.parse(
    (
      await command(
        "run",
        "--config",
        join(project, ".codemode", "config.json"),
        "--code",
        "return await tools.fixture.sum({a:20,b:22});",
        "--json",
      )
    ).stdout,
  );
  assert.deepEqual(result.value, { answer: 42 });
  const libraryEntry = join(
    prefix,
    "node_modules",
    "code-mode-anything",
    "dist",
    "index.js",
  );
  const evaluated = await run(process.execPath, [
    "--input-type=module",
    "--eval",
    `import {loadRuntime} from ${JSON.stringify(libraryEntry)}; const runtime=await loadRuntime(${JSON.stringify(join(project, ".codemode", "config.json"))}); try { console.log(JSON.stringify((await runtime.execute({code:'return 42;'})).value)); } finally { await runtime.close(); }`,
  ]);
  assert.equal(JSON.parse(evaluated.stdout), 42);
  await command("restore", ...common, "--json");
  await assert.rejects(access(join(project, ".codex", "config.toml")));
  await command("skill", "install", ...common, "--json");
  await access(
    join(
      project,
      ".agents",
      "skills",
      "cma-setup",
      "references",
      "workflow.md",
    ),
  );
  const docs = await readFile(
    join(project, ".agents", "skills", "cma-use", "SKILL.md"),
    "utf8",
  );
  assert.match(docs, /tools\[server\]\[operation\]/);
  console.log(
    JSON.stringify(
      {
        package: filename,
        installedOutsideCheckout: true,
        catalogEntries: catalog.length,
        gatewayVerified: true,
        adapterResult: result.value,
        restoreVerified: true,
        packagedSkillsVerified: true,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
