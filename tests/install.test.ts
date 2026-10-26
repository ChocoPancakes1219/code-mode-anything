import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectAgent,
  planInstall,
  applyInstall,
  restoreInstall,
  statusInstall,
  updateManagedManifest,
} from "../src/install.js";

async function fixture(
  t: TestContext,
  agent: "claude" | "codex" | "opencode" = "opencode",
) {
  const dir = await mkdtemp(join(tmpdir(), "cma-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  await mkdir(home);
  const options = {
    agent,
    projectDir: dir,
    homeDir: home,
    scope: "project" as const,
    servers: ["demo"],
    original: "disable" as const,
  };
  return { dir, home, options };
}
async function plan(options: any) {
  const inspected = await inspectAgent(options);
  return planInstall({
    ...options,
    manifests: inspected.servers
      .filter((s) => options.servers.includes(s.name))
      .map((s) => ({
        schemaVersion: 1 as const,
        name: s.name,
        backend: s.backend,
        operations: [{ name: "ping", inputSchema: { type: "object" } }],
      })),
  });
}
test("disabling a TOML registration preserves nested enabled environment values", async (t) => {
  const { dir, options } = await fixture(t, "codex");
  await mkdir(join(dir, ".codex"));
  const path = join(dir, ".codex/config.toml");
  await writeFile(
    path,
    '[mcp_servers.demo]\ncommand = "node"\n[mcp_servers.demo.env]\nenabled = "keep-me"\n',
  );
  await applyInstall(await plan(options));
  assert.match(await readFile(path, "utf8"), /enabled = "keep-me"/);
  await restoreInstall(options);
});
test("JSONC installation preserves comments, redacts secrets, and restores exact bytes", async (t) => {
  const { dir, options } = await fixture(t);
  const path = join(dir, "opencode.jsonc");
  const before =
    '// user comment\n{ "mcp": {"demo":{"type":"local","command":["node","demo.js"],"environment":{"TOKEN":"top-secret"}}}, "theme":"dark" }\n';
  await writeFile(path, before);
  const proposal = await plan(options);
  assert.ok(!JSON.stringify(proposal).includes("top-secret"));
  await applyInstall(proposal);
  const after = await readFile(path, "utf8");
  assert.match(after, /user comment/);
  assert.match(after, /"theme":"dark"/);
  assert.equal((await statusInstall(options)).installed, true);
  await assert.rejects(
    planInstall({ ...options, manifests: [] }),
    /already installed/i,
  );
  await restoreInstall(options);
  assert.equal(await readFile(path, "utf8"), before);
});
test("Claude disable uses user project disabledMcpServers and restores it", async (t) => {
  const { dir, home, options } = await fixture(t, "claude");
  await writeFile(
    join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: { demo: { command: "node", args: ["demo.js"] } },
    }),
  );
  await applyInstall(await plan(options));
  const config = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
  assert.deepEqual(config.projects[dir].disabledMcpServers, ["demo"]);
  assert.equal(
    JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8")).mcpServers.demo
      .enabled,
    undefined,
  );
  await restoreInstall(options);
});
test("restore preflights all files and refuses user edits", async (t) => {
  const { dir, options } = await fixture(t);
  const path = join(dir, "opencode.json");
  await writeFile(
    path,
    JSON.stringify({
      mcp: { demo: { type: "local", command: ["node", "demo.js"] } },
    }),
  );
  await applyInstall(await plan(options));
  await writeFile(join(dir, "AGENTS.md"), "my edit");
  const installed = await readFile(path, "utf8");
  await assert.rejects(restoreInstall(options), /conflict/i);
  assert.equal(await readFile(path, "utf8"), installed);
});
test("Codex TOML edits preserve unrelated comments and env references", async (t) => {
  const { dir, options } = await fixture(t, "codex");
  await mkdir(join(dir, ".codex"));
  const source =
    '# keep\nmodel = "example"\n[mcp_servers.demo]\ncommand = "node"\nargs = ["demo.js"]\n[mcp_servers.demo.env]\nTOKEN = "${TOKEN}"\n';
  const path = join(dir, ".codex/config.toml");
  await writeFile(path, source);
  const inspected = await inspectAgent(options);
  assert.equal(
    (inspected.servers[0].backend as any).transport.env.TOKEN,
    "${TOKEN}",
  );
  await applyInstall(await plan(options));
  const after = await readFile(path, "utf8");
  assert.match(after, /# keep/);
  assert.match(after, /enabled = false/);
  await restoreInstall(options);
  assert.equal(await readFile(path, "utf8"), source);
});
test("untranslatable tool restrictions fail before any mutation", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({
      mcp: {
        demo: { type: "local", command: ["node"], denied_tools: ["danger"] },
      },
    }),
  );
  await assert.rejects(inspectAgent(options), /restric|unsupported/i);
});
test("remove-registration keeps unrelated services and a pre-existing runtime harness", async (t) => {
  const { dir, options } = await fixture(t);
  options.original = "remove-registration" as any;
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({
      mcp: {
        demo: { type: "local", command: ["node"] },
        other: { type: "local", command: ["python"] },
      },
    }),
  );
  await mkdir(join(dir, ".codemode"));
  await writeFile(
    join(dir, ".codemode/config.json"),
    JSON.stringify({
      schemaVersion: 1,
      harnesses: [{ manifestPath: "/existing/manifest.json" }],
    }),
  );
  await applyInstall(await plan(options));
  const config = JSON.parse(await readFile(join(dir, "opencode.json"), "utf8"));
  assert.equal(config.mcp.demo, undefined);
  assert.ok(config.mcp.other);
  const runtime = JSON.parse(
    await readFile(join(dir, ".codemode/config.json"), "utf8"),
  );
  assert.equal(runtime.harnesses[0].manifestPath, "/existing/manifest.json");
  await restoreInstall(options);
});
test("an edited file between preview and apply produces no partial writes", async (t) => {
  const { dir, options } = await fixture(t);
  const path = join(dir, "opencode.json");
  await writeFile(
    path,
    JSON.stringify({ mcp: { demo: { type: "local", command: ["node"] } } }),
  );
  const proposal = await plan(options);
  await writeFile(path, "{}");
  await assert.rejects(applyInstall(proposal), /conflict/i);
  await assert.rejects(readFile(join(dir, ".codemode/config.json")), {
    code: "ENOENT",
  });
});
test("keep mode reports coexistence without modifying original registration", async (t) => {
  const { dir, options } = await fixture(t);
  options.original = "keep" as any;
  const registration = { type: "local", command: ["node"] };
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({ mcp: { demo: registration } }),
  );
  const result = await applyInstall(await plan(options));
  assert.equal(result.status, "coexistence");
  assert.deepEqual(
    JSON.parse(await readFile(join(dir, "opencode.json"), "utf8")).mcp.demo,
    registration,
  );
});
test("existing unmanaged gateway and usage skill cannot be overwritten", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({
      mcp: {
        demo: { type: "local", command: ["node"] },
        codemode: { type: "local", command: ["custom"] },
      },
    }),
  );
  await assert.rejects(plan(options), /unmanaged/);
});
test("install refuses disabled source registrations instead of enabling them through gateway", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({
      mcp: { demo: { type: "local", command: ["node"], enabled: false } },
    }),
  );
  await assert.rejects(inspectAgent(options), /disabled/);
});
test("TOML removal handles quoted server names and preserves other tables", async (t) => {
  const { dir, options } = await fixture(t, "codex");
  options.servers = ["demo.dot"];
  options.original = "remove-registration" as any;
  await mkdir(join(dir, ".codex"));
  const path = join(dir, ".codex/config.toml");
  const before =
    '# untouched\n[mcp_servers."demo.dot"]\ncommand="node"\n[mcp_servers."demo.dot".env]\nA="${A}"\n[mcp_servers.other]\ncommand="python"\n';
  await writeFile(path, before);
  await applyInstall(await plan(options));
  const after = await readFile(path, "utf8");
  assert.ok(!after.includes("demo.dot"));
  assert.match(after, /command="python"/);
  await restoreInstall(options);
  assert.equal(await readFile(path, "utf8"), before);
});
test("OpenCode env references normalize without reading secrets and stdio keeps project cwd", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({
      mcp: {
        demo: {
          type: "local",
          command: ["node", "{env:SCRIPT}"],
          environment: { TOKEN: "{env:TOKEN}" },
        },
      },
    }),
  );
  const source = (await inspectAgent(options)).servers[0].backend as any;
  assert.equal(source.transport.env.TOKEN, "${TOKEN}");
  assert.equal(source.transport.args[0], "${SCRIPT}");
  assert.equal(source.transport.cwd, dir);
});
test("OpenCode file references fail translation before reading external files", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({
      mcp: {
        demo: {
          type: "remote",
          url: "http://localhost",
          headers: { Authorization: "{file:./private-token}" },
        },
      },
    }),
  );
  await assert.rejects(inspectAgent(options), /file reference/i);
});
test("install and restore retain existing config permissions and keep backups private", async (t) => {
  const { dir, options } = await fixture(t);
  const path = join(dir, "opencode.json");
  const { chmod, stat } = await import("node:fs/promises");
  await writeFile(
    path,
    JSON.stringify({ mcp: { demo: { type: "local", command: ["node"] } } }),
  );
  await chmod(path, 0o640);
  const result = await applyInstall(await plan(options));
  assert.equal((await stat(path)).mode & 0o777, 0o640);
  assert.equal((await stat(result.transactionPath)).mode & 0o777, 0o600);
  await restoreInstall(options);
  assert.equal((await stat(path)).mode & 0o777, 0o640);
});
test("existing harness names cannot collide with imported service names", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({ mcp: { demo: { type: "local", command: ["node"] } } }),
  );
  await mkdir(join(dir, ".codemode"));
  await writeFile(
    join(dir, ".codemode/other.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "demo",
      backend: { kind: "module", entry: "custom.js" },
      operations: [],
    }),
  );
  await writeFile(
    join(dir, ".codemode/config.json"),
    JSON.stringify({
      schemaVersion: 1,
      harnesses: [{ manifestPath: "other.json" }],
    }),
  );
  await assert.rejects(plan(options), /already|colli/i);
});
test("manifest-only installation registers module gateway without an original MCP source and restores", async (t) => {
  const { dir, options } = await fixture(t);
  options.original = "keep" as any;
  const manifest = {
    schemaVersion: 1 as const,
    name: "demo",
    backend: { kind: "module" as const, entry: "/package/adapter.js" },
    operations: [{ name: "run", inputSchema: { type: "object" } }],
  };
  const proposal = await planInstall({
    ...options,
    manifestOnly: true,
    manifests: [manifest],
  });
  assert.equal(proposal.status, "reload-required");
  await applyInstall(proposal);
  const config = JSON.parse(await readFile(join(dir, "opencode.json"), "utf8"));
  assert.ok(config.mcp.codemode);
  assert.equal(config.mcp.demo, undefined);
  assert.equal((await statusInstall(options)).status, "reload-required");
  await restoreInstall(options);
  await assert.rejects(readFile(join(dir, "opencode.json")), {
    code: "ENOENT",
  });
});
test("Codex bearer token env var maps to referenced Authorization header", async (t) => {
  const { dir, options } = await fixture(t, "codex");
  await mkdir(join(dir, ".codex"));
  await writeFile(
    join(dir, ".codex/config.toml"),
    '[mcp_servers.demo]\nurl="https://example.test/mcp"\nbearer_token_env_var="TOKEN"\n',
  );
  const backend = (await inspectAgent(options)).servers[0].backend as any;
  assert.equal(backend.transport.headers.Authorization, "Bearer ${TOKEN}");
});
test("OpenCode explicit OAuth true selects local mcp-remote authorization", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({
      mcp: {
        demo: { type: "remote", url: "https://example.test/mcp", oauth: true },
      },
    }),
  );
  const backend = (await inspectAgent(options)).servers[0].backend as any;
  assert.equal(backend.transport.oauth, "mcp-remote");
});
test("explicit oauth option normalizes HTTP source transport before generation", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({
      mcp: { demo: { type: "remote", url: "https://example.test/mcp" } },
    }),
  );
  assert.equal(
    (
      (await inspectAgent({ ...options, oauth: true })).servers[0]
        .backend as any
    ).transport.oauth,
    "mcp-remote",
  );
});
test("Codex inline registration editing fails explicitly without modifying files", async (t) => {
  const { dir, options } = await fixture(t, "codex");
  await mkdir(join(dir, ".codex"));
  const path = join(dir, ".codex/config.toml");
  const source = '[mcp_servers]\ndemo={command="node"}\n';
  await writeFile(path, source);
  await assert.rejects(plan(options), /unsupported.*TOML|TOML.*unsupported/i);
  assert.equal(await readFile(path, "utf8"), source);
});
test("Codex disabling does not insert enabled inside HTTP headers", async (t) => {
  const { dir, options } = await fixture(t, "codex");
  await mkdir(join(dir, ".codex"));
  const path = join(dir, ".codex/config.toml");
  await writeFile(
    path,
    '[mcp_servers.demo]\nurl="https://example.test/mcp"\n[mcp_servers.demo.http_headers]\nX="value"\n',
  );
  await applyInstall(await plan(options));
  const TOML = (await import("@iarna/toml")).default;
  const data = TOML.parse(await readFile(path, "utf8")) as any;
  assert.equal(data.mcp_servers.demo.enabled, false);
  assert.equal(data.mcp_servers.demo.http_headers.enabled, undefined);
});
test("user usage instructions use each agent native directory", async (t) => {
  for (const agent of ["claude", "codex", "opencode"] as const) {
    const { dir, home, options } = await fixture(t, agent);
    const result = await planInstall({
      ...options,
      scope: "user",
      manifestOnly: true,
      manifests: [
        {
          schemaVersion: 1,
          name: "demo",
          backend: { kind: "module", entry: "/package/adapter.js" },
          operations: [{ name: "run", inputSchema: {} }],
        },
      ],
    });
    const expected = join(
      home,
      agent === "claude"
        ? ".claude/CLAUDE.md"
        : agent === "codex"
          ? ".codex/AGENTS.md"
          : ".config/opencode/AGENTS.md",
    );
    assert.ok(result.changes.some((c) => c.path === expected));
  }
});
test("explicit source timeouts fail translation rather than being silently dropped", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({
      mcp: { demo: { type: "local", command: ["node"], timeout: 900 } },
    }),
  );
  await assert.rejects(inspectAgent(options), /timeout/i);
});
test("refresh updates managed hashes and preserves original restore snapshots", async (t) => {
  const { dir, options } = await fixture(t);
  const path = join(dir, "opencode.json");
  const original = JSON.stringify({
    mcp: { demo: { type: "local", command: ["node"] } },
  });
  await writeFile(path, original);
  await applyInstall(await plan(options));
  const manifestPath = join(dir, ".codemode/harnesses/demo/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.operations.push({ name: "newTool", inputSchema: {} });
  assert.equal(
    await updateManagedManifest(
      join(dir, ".codemode/config.json"),
      manifestPath,
      manifest,
    ),
    true,
  );
  assert.equal((await statusInstall(options)).status, "reload-required");
  await restoreInstall(options);
  assert.equal(await readFile(path, "utf8"), original);
  await assert.rejects(readFile(manifestPath), { code: "ENOENT" });
});
test("refresh preflights every owned file and refuses conflict without writes", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({ mcp: { demo: { type: "local", command: ["node"] } } }),
  );
  await applyInstall(await plan(options));
  const path = join(dir, ".codemode/harnesses/demo/manifest.json");
  const original = await readFile(path, "utf8");
  await writeFile(join(dir, "AGENTS.md"), "user edit");
  await assert.rejects(
    updateManagedManifest(
      join(dir, ".codemode/config.json"),
      path,
      JSON.parse(original),
    ),
    /conflict/i,
  );
  assert.equal(await readFile(path, "utf8"), original);
});
test("second agent install refuses shared ownership before invalidating first restore", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({ mcp: { demo: { type: "local", command: ["node"] } } }),
  );
  await applyInstall(await plan(options));
  await assert.rejects(
    planInstall({
      ...options,
      agent: "claude",
      manifestOnly: true,
      servers: ["other"],
      manifests: [
        {
          schemaVersion: 1,
          name: "other",
          backend: { kind: "module", entry: "/package/adapter.js" },
          operations: [{ name: "run", inputSchema: {} }],
        },
      ],
    }),
    /another agent|shared.*ownership/i,
  );
  await restoreInstall(options);
});

test("refresh restores both newly created and previously existing declarations", async (t) => {
  for (const existing of [false, true]) {
    const { dir, options } = await fixture(t);
    await writeFile(
      join(dir, "opencode.json"),
      JSON.stringify({ mcp: { demo: { type: "local", command: ["node"] } } }),
    );
    await applyInstall(await plan(options));
    const manifestPath = join(dir, ".codemode/harnesses/demo/manifest.json");
    const declaration = join(dir, ".codemode/harnesses/demo/tools.d.ts");
    if (existing)
      await writeFile(declaration, "// original types\n", { mode: 0o640 });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await updateManagedManifest(
      join(dir, ".codemode/config.json"),
      manifestPath,
      manifest,
    );
    assert.match(await readFile(declaration, "utf8"), /HarnessTools/);
    await restoreInstall(options);
    if (existing) {
      assert.equal(await readFile(declaration, "utf8"), "// original types\n");
      const { stat } = await import("node:fs/promises");
      assert.equal((await stat(declaration)).mode & 0o777, 0o640);
    } else await assert.rejects(readFile(declaration), { code: "ENOENT" });
  }
});

test("restore recovers interrupted install states while refusing unknown edits", async (t) => {
  for (const written of [0, 1]) {
    const { dir, options } = await fixture(t);
    await writeFile(
      join(dir, "opencode.json"),
      JSON.stringify({ mcp: { demo: { type: "local", command: ["node"] } } }),
    );
    const installed = await applyInstall(await plan(options));
    const tx = JSON.parse(await readFile(installed.transactionPath, "utf8"));
    tx.phase = "applying";
    for (const change of tx.changes.slice(written)) {
      if (change.before === null) await rm(change.path, { force: true });
      else await writeFile(change.path, change.before);
    }
    await writeFile(installed.transactionPath, JSON.stringify(tx));
    await restoreInstall(options);
    await assert.rejects(readFile(installed.transactionPath), {
      code: "ENOENT",
    });
  }
});

test("refresh failure before publishing declarations leaves installed manifest intact", async (t) => {
  const { dir, options } = await fixture(t);
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({ mcp: { demo: { type: "local", command: ["node"] } } }),
  );
  await applyInstall(await plan(options));
  const path = join(dir, ".codemode/harnesses/demo/manifest.json");
  const original = await readFile(path, "utf8");
  await mkdir(join(dir, ".codemode/harnesses/demo/tools.d.ts"));
  const manifest = JSON.parse(original);
  manifest.operations.push({ name: "added", inputSchema: {} });
  await assert.rejects(
    updateManagedManifest(join(dir, ".codemode/config.json"), path, manifest),
  );
  assert.equal(await readFile(path, "utf8"), original);
});

test("restore recovers each interrupted refresh boundary and refuses unknown edits", async (t) => {
  const { createHash } = await import("node:crypto");
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  for (const boundary of [0, 1, 2]) {
    const { dir, options } = await fixture(t);
    await writeFile(
      join(dir, "opencode.json"),
      JSON.stringify({ mcp: { demo: { type: "local", command: ["node"] } } }),
    );
    const installed = await applyInstall(await plan(options));
    const tx = JSON.parse(await readFile(installed.transactionPath, "utf8"));
    const manifestPath = join(dir, ".codemode/harnesses/demo/manifest.json");
    const declaration = join(dir, ".codemode/harnesses/demo/tools.d.ts");
    const before = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(before);
    manifest.operations.push({ name: "new", inputSchema: {} });
    const after = JSON.stringify(manifest);
    const change = tx.changes.find((c: any) => c.path === manifestPath);
    change.recoveryHash = digest(before);
    change.afterHash = digest(after);
    tx.phase = "refreshing";
    tx.changes.push({
      path: declaration,
      before: null,
      beforeMode: 0o600,
      afterHash: digest("new types"),
    });
    await writeFile(installed.transactionPath, JSON.stringify(tx));
    if (boundary >= 1) await writeFile(manifestPath, after);
    if (boundary >= 2) await writeFile(declaration, "new types");
    if (boundary === 1) {
      await writeFile(declaration, "unrelated user edit");
      await assert.rejects(restoreInstall(options), /conflict/i);
      assert.equal(await readFile(manifestPath, "utf8"), after);
      await rm(declaration);
    }
    await restoreInstall(options);
    await assert.rejects(readFile(manifestPath), { code: "ENOENT" });
    await assert.rejects(readFile(declaration), { code: "ENOENT" });
  }
});

test("restore resumes after interruption without accepting unknown file contents", async (t) => {
  const { dir, options } = await fixture(t);
  const original = JSON.stringify({
    mcp: { demo: { type: "local", command: ["node"] } },
  });
  await writeFile(join(dir, "opencode.json"), original);
  const installed = await applyInstall(await plan(options));
  const tx = JSON.parse(await readFile(installed.transactionPath, "utf8"));
  tx.phase = "restoring";
  const change = tx.changes.at(-1);
  if (change.before === null) await rm(change.path);
  else await writeFile(change.path, change.before);
  await writeFile(installed.transactionPath, JSON.stringify(tx));
  const first = tx.changes[0];
  const after = await readFile(first.path, "utf8");
  await writeFile(first.path, "unrelated edit");
  await assert.rejects(restoreInstall(options), /conflict/i);
  await writeFile(first.path, after);
  await restoreInstall(options);
  assert.equal(await readFile(join(dir, "opencode.json"), "utf8"), original);
});
