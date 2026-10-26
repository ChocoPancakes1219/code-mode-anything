import { readFile, unlink, lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  parse as parseJsonc,
  modify,
  applyEdits,
  type ParseError,
} from "jsonc-parser";
import TOML from "@iarna/toml";
import { CmaError } from "./errors.js";
import { atomicWrite } from "./files.js";
import { generateDeclarations } from "./generate.js";
import { workflowGuidance } from "./guidance.js";
import type { Backend, HarnessManifest } from "./types.js";

export type Agent = "claude" | "codex" | "opencode";
export interface InstallOptions {
  agent: Agent;
  oauth?: boolean;
  projectDir: string;
  scope: "project" | "user";
  homeDir?: string;
  manifestOnly?: boolean;
  servers: string[];
  original: "keep" | "disable" | "remove-registration";
  configPath?: string;
  cliPath?: string;
}
export interface SourceRegistration {
  name: string;
  backend: Backend;
  registration: Record<string, any>;
}
export interface AgentInspection {
  agent: Agent;
  configPath: string;
  servers: SourceRegistration[];
}
export interface InstallPlan {
  agent: Agent;
  scope: "project" | "user";
  servers: string[];
  original: InstallOptions["original"];
  changes: { path: string; action: "create" | "update" }[];
  status: "reload-required" | "coexistence";
  warnings: string[];
}
export interface InstallResult {
  installed: boolean;
  status: "reload-required" | "coexistence" | "restored";
  transactionPath: string;
}
export interface InstallStatus {
  installed: boolean;
  status: "reload-required" | "coexistence" | "not-installed" | "conflict";
  conflicts: string[];
  transactionPath: string;
}
interface Change {
  path: string;
  before: string | null;
  after: string;
  beforeMode: number;
}
interface Transaction {
  version: 1;
  phase?: "applying" | "installed" | "restoring" | "refreshing";
  manifestOnly?: boolean;
  agent: Agent;
  original: InstallOptions["original"];
  changes: {
    path: string;
    before: string | null;
    beforeMode: number;
    afterHash: string;
    recoveryHash?: string;
  }[];
}
const plans = new WeakMap<
  InstallPlan,
  { options: InstallOptions; changes: Change[]; transactionPath: string }
>();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const fail = (message: string): never => {
  throw new CmaError("INSTALL_ERROR", message);
};
const home = (o: InstallOptions) => resolve(o.homeDir ?? homedir());
const base = (o: InstallOptions) =>
  o.scope === "user" ? home(o) : resolve(o.projectDir);
const transactionPath = (o: InstallOptions) =>
  join(base(o), ".codemode", `install-${o.agent}.json`);
async function read(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function configPath(o: InstallOptions): Promise<string> {
  if (o.configPath) return resolve(o.configPath);
  if (o.agent === "claude")
    return join(base(o), o.scope === "project" ? ".mcp.json" : ".claude.json");
  if (o.agent === "codex") return join(base(o), ".codex", "config.toml");
  const dir =
    o.scope === "user" ? join(home(o), ".config", "opencode") : base(o);
  return (await read(join(dir, "opencode.jsonc"))) !== null
    ? join(dir, "opencode.jsonc")
    : join(dir, "opencode.json");
}
function parse(text: string | null, toml = false): any {
  if (text === null) return {};
  try {
    if (toml) return TOML.parse(text);
    const errors: ParseError[] = [];
    const value = parseJsonc(text, errors, { allowTrailingComma: true });
    if (
      errors.length ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    )
      fail("Invalid agent JSON configuration");
    return value;
  } catch (error) {
    if (error instanceof CmaError) throw error;
    return fail("Invalid agent configuration");
  }
}
function edit(text: string, path: (string | number)[], value: any): string {
  return applyEdits(text, modify(text, path, value, {}));
}
function openCodeReferences(value: any): any {
  if (typeof value === "string") {
    if (value.includes("{file:"))
      fail("OpenCode file references require explicit conversion");
    return value.replace(
      /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_, name) => "${" + name + "}",
    );
  }
  if (Array.isArray(value)) return value.map(openCodeReferences);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        openCodeReferences(item),
      ]),
    );
  return value;
}
function normalize(
  agent: Agent,
  reg: any,
  name: string,
  projectDir: string,
): Backend {
  if (agent === "opencode") reg = openCodeReferences(reg);
  if (!reg || typeof reg !== "object")
    return fail(`Invalid registration for ${name}`);
  if (
    [
      "timeout",
      "startup_timeout_sec",
      "startup_timeout_ms",
      "tool_timeout_sec",
    ].some((key) => reg[key] !== undefined)
  )
    fail(`Explicit timeout settings for ${name} require manual conversion`);
  if (reg.enabled === false) fail(`Source registration is disabled: ${name}`);
  const accepted =
    agent === "claude"
      ? ["type", "command", "args", "env", "url", "headers", "cwd"]
      : agent === "codex"
        ? [
            "command",
            "args",
            "env",
            "cwd",
            "url",
            "http_headers",
            "env_http_headers",
            "bearer_token_env_var",
            "enabled",
            "startup_timeout_sec",
            "startup_timeout_ms",
            "tool_timeout_sec",
            "env_vars",
          ]
        : [
            "type",
            "command",
            "environment",
            "url",
            "headers",
            "enabled",
            "timeout",
            "oauth",
            "cwd",
          ];
  const unknown = Object.keys(reg).filter((k) => !accepted.includes(k));
  if (unknown.length)
    fail(
      `Unsupported registration fields or restrictions for ${name}: ${unknown.join(", ")}`,
    );
  if (agent === "codex" && (reg.env_vars || reg.env_http_headers))
    fail(
      `Environment credential forwarding for ${name} requires explicit conversion; installation refused`,
    );
  if (agent === "opencode" && reg.oauth && reg.oauth !== true)
    fail(
      `OAuth configuration for ${name} requires explicit conversion; installation refused`,
    );
  const env = agent === "opencode" ? reg.environment : reg.env;
  if (
    env &&
    (typeof env !== "object" ||
      Object.values(env).some((x) => typeof x !== "string"))
  )
    fail(`Invalid environment for ${name}`);
  if (reg.url) {
    if (typeof reg.url !== "string") fail(`Invalid URL for ${name}`);
    if (reg.type === "sse")
      fail(`Legacy SSE transport for ${name} cannot be translated`);
    const headers = { ...(reg.headers ?? reg.http_headers ?? {}) };
    if (reg.bearer_token_env_var) {
      if (
        typeof reg.bearer_token_env_var !== "string" ||
        !/^[_A-Za-z][_A-Za-z0-9]*$/.test(reg.bearer_token_env_var)
      )
        fail(`Invalid bearer token environment variable for ${name}`);
      if (
        Object.keys(headers).some(
          (key) => key.toLowerCase() === "authorization",
        )
      )
        fail(`Conflicting Authorization configuration for ${name}`);
      headers.Authorization = "Bearer ${" + reg.bearer_token_env_var + "}";
    }
    return {
      kind: "mcp",
      transport: {
        type: "http",
        url: reg.url,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(agent === "opencode" && reg.oauth === true
          ? { oauth: "mcp-remote" as const }
          : {}),
      },
    };
  }
  const command = agent === "opencode" ? reg.command?.[0] : reg.command;
  const args = agent === "opencode" ? reg.command?.slice(1) : reg.args;
  if (
    typeof command !== "string" ||
    !command ||
    (args &&
      (!Array.isArray(args) || args.some((a: any) => typeof a !== "string")))
  )
    fail(`Invalid command for ${name}`);
  return {
    kind: "mcp",
    transport: {
      type: "stdio",
      command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      cwd: resolve(projectDir, reg.cwd ?? "."),
    },
  };
}
export async function inspectAgent(
  options: InstallOptions,
): Promise<AgentInspection> {
  const path = await configPath(options);
  const data = parse(await read(path), options.agent === "codex");
  const registrations =
    data[
      options.agent === "claude"
        ? "mcpServers"
        : options.agent === "codex"
          ? "mcp_servers"
          : "mcp"
    ] ?? {};
  const servers: SourceRegistration[] = [];
  const claudeUser =
    options.agent === "claude"
      ? parse(await read(join(home(options), ".claude.json")))
      : {};
  const disabled =
    claudeUser.projects?.[resolve(options.projectDir)]?.disabledMcpServers ??
    [];
  for (const [name, registration] of Object.entries(registrations)) {
    if (
      name === "codemode" ||
      (options.servers.length && !options.servers.includes(name))
    )
      continue;
    if (disabled.includes(name))
      fail(`Source registration is disabled: ${name}`);
    const backend = normalize(
      options.agent,
      registration,
      name,
      resolve(options.projectDir),
    );
    if (
      options.oauth &&
      backend.kind === "mcp" &&
      backend.transport.type === "http"
    )
      backend.transport.oauth = "mcp-remote";
    servers.push({ name, registration: registration as any, backend });
  }
  for (const name of options.servers)
    if (!servers.some((s) => s.name === name))
      fail(`MCP registration not found: ${name}`);
  return { agent: options.agent, configPath: path, servers };
}
/** Edit only the selected TOML table range, retaining unrelated tables and comments. */
function tomlEntry(
  text: string,
  name: string,
  value: any | undefined,
  disable = false,
): string {
  const lines = text.split(/(?<=\n)/);
  const table = /^\s*\[([^\]]+)\]\s*(?:#.*)?(?:\r?\n)?$/;
  const section = (line: string) => {
    const match = line.match(table);
    if (!match) return undefined;
    try {
      const obj = TOML.parse(`${line.trim()}\n__cma_marker = true`);
      return Object.keys((obj as any).mcp_servers ?? {})[0];
    } catch {
      return undefined;
    }
  };
  const direct = (line: string) => {
    const match = line.match(table);
    if (!match) return false;
    try {
      const obj = TOML.parse(`${line.trim()}\n__cma_marker = true`) as any;
      return obj.mcp_servers?.[name]?.__cma_marker === true;
    } catch {
      return false;
    }
  };
  const hasDirect = lines.some(direct);
  if (
    (disable || value === undefined) &&
    !hasDirect &&
    parse(text, true).mcp_servers?.[name]
  )
    fail(
      `Unsupported TOML registration layout for ${name}; use explicit [mcp_servers.NAME] tables`,
    );
  let inTarget = false;
  let inDirect = false;
  let found = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (table.test(line)) {
      inTarget = section(line) === name;
      inDirect = direct(line);
      if (inTarget) found = true;
    }
    if (!inTarget) kept.push(line);
    else if (disable) {
      if (inDirect && /^\s*enabled\s*=/.test(line)) continue;
      kept.push(line);
      if (direct(line)) kept.push("enabled = false\n");
    }
  }
  if (disable && found) return kept.join("");
  let output = kept.join("");
  if (value !== undefined) {
    if (output && !output.endsWith("\n")) output += "\n";
    output += "\n" + TOML.stringify({ mcp_servers: { [name]: value } } as any);
  }
  return output;
}
async function safeTarget(path: string): Promise<void> {
  // Refuse symlinks at every existing component; replacement must not escape a managed path.
  let current = resolve(path);
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        fail(`Refusing symlink target: ${path}`);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export async function planInstall(
  options: InstallOptions & { manifests: HarnessManifest[] },
): Promise<InstallPlan> {
  const txPath = transactionPath(options);
  if ((await read(txPath)) !== null)
    fail("Agent already installed; restore it before reinstalling");
  const existingTransactions = await readdir(dirname(txPath)).catch(
    (error: any) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  if (
    existingTransactions.some((name) =>
      /^install-(claude|codex|opencode)\.json$/.test(name),
    )
  )
    fail(
      "Another agent installation owns the shared code-mode files; restore it first",
    );
  if (!options.servers.length) fail("Select at least one MCP server");
  if (new Set(options.servers).size !== options.servers.length)
    fail("Duplicate server selections");
  const inspection: AgentInspection = options.manifestOnly
    ? {
        agent: options.agent,
        configPath: await configPath(options),
        servers: options.servers.map((name) => {
          const manifest = options.manifests.find((m) => m.name === name);
          if (!manifest) fail(`Missing manifest for ${name}`);
          return { name, backend: manifest!.backend, registration: {} };
        }),
      }
    : await inspectAgent(options);
  const changes: Change[] = [];
  const add = async (path: string, after: string) => {
    await safeTarget(path);
    const before = await read(path);
    if (before !== after)
      changes.push({
        path,
        before,
        after,
        beforeMode: before === null ? 0o600 : (await lstat(path)).mode & 0o777,
      });
  };
  const root = base(options);
  const runtimePath = join(root, ".codemode", "config.json");
  const priorRuntime = parse(await read(runtimePath));
  if (
    priorRuntime.schemaVersion !== undefined &&
    priorRuntime.schemaVersion !== 1
  )
    fail("Unsupported existing code-mode config");
  if (
    priorRuntime.harnesses !== undefined &&
    !Array.isArray(priorRuntime.harnesses)
  )
    fail("Invalid existing harness configuration");
  const harnesses = [...(priorRuntime.harnesses ?? [])];
  for (const harness of harnesses) {
    if (!harness || typeof harness.manifestPath !== "string")
      fail("Invalid existing harness configuration");
    if (harness.enabled === false) continue;
    const existing = await read(
      resolve(dirname(runtimePath), harness.manifestPath),
    );
    if (existing !== null && options.servers.includes(parse(existing).name))
      fail("An existing harness already uses a selected service name");
  }
  for (const source of inspection.servers) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source.name))
      fail(`Unsafe server name: ${source.name}`);
    const manifest = options.manifests.find((m) => m.name === source.name);
    if (
      !manifest ||
      (!options.manifestOnly && manifest.backend.kind !== "mcp") ||
      JSON.stringify(manifest.backend) !== JSON.stringify(source.backend)
    )
      fail(`Missing or mismatched discovered manifest for ${source.name}`);
    if (!manifest!.operations.length)
      fail(`No discovered tools for ${source.name}`);
    const path = join(
      root,
      ".codemode",
      "harnesses",
      source.name,
      "manifest.json",
    );
    if ((await read(path)) !== null)
      fail(`Harness already exists: ${source.name}`);
    await add(path, JSON.stringify(manifest, null, 2) + "\n");
    if (
      !harnesses.some(
        (h) => resolve(dirname(runtimePath), h.manifestPath) === path,
      )
    )
      harnesses.push({ manifestPath: path });
  }
  await add(
    runtimePath,
    JSON.stringify({ ...priorRuntime, schemaVersion: 1, harnesses }, null, 2) +
      "\n",
  );
  let text =
    (await read(inspection.configPath)) ??
    (options.agent === "codex" ? "" : "{}\n");
  const key =
    options.agent === "claude"
      ? "mcpServers"
      : options.agent === "codex"
        ? "mcp_servers"
        : "mcp";
  const data = parse(text, options.agent === "codex");
  if (data[key]?.codemode)
    fail("An unmanaged codemode gateway registration already exists");
  const cli = resolve(
    options.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url)),
  );
  const args = [cli, "serve", "--config", runtimePath];
  const registration =
    options.agent === "opencode"
      ? { type: "local", command: [process.execPath, ...args], enabled: true }
      : { command: process.execPath, args };
  for (const name of options.manifestOnly ? [] : options.servers) {
    if (options.original === "remove-registration")
      text =
        options.agent === "codex"
          ? tomlEntry(text, name, undefined)
          : edit(text, [key, name], undefined);
    if (options.original === "disable" && options.agent !== "claude")
      text =
        options.agent === "codex"
          ? tomlEntry(text, name, undefined, true)
          : edit(text, [key, name, "enabled"], false);
  }
  text =
    options.agent === "codex"
      ? tomlEntry(text, "codemode", registration)
      : edit(text, [key, "codemode"], registration);
  if (options.agent === "codex" && !options.manifestOnly) {
    const result = parse(text, true);
    for (const name of options.servers) {
      if (
        options.original === "disable" &&
        result.mcp_servers?.[name]?.enabled !== false
      )
        fail(`Could not disable TOML registration ${name}`);
      if (
        options.original === "remove-registration" &&
        result.mcp_servers?.[name] !== undefined
      )
        fail(`Could not remove TOML registration ${name}`);
    }
  }
  await add(inspection.configPath, text);
  if (
    !options.manifestOnly &&
    options.agent === "claude" &&
    options.original === "disable"
  ) {
    const path = join(home(options), ".claude.json");
    let original = (await read(path)) ?? "{}\n";
    // User-scope registrations share this file with the gateway.
    const existing = changes.find((c) => c.path === path);
    if (existing) original = existing.after;
    const config = parse(original);
    const project = resolve(options.projectDir);
    const disabled = [
      ...new Set([
        ...(config.projects?.[project]?.disabledMcpServers ?? []),
        ...options.servers,
      ]),
    ];
    const updated = edit(
      original,
      ["projects", project, "disabledMcpServers"],
      disabled,
    );
    if (existing) existing.after = updated;
    else await add(path, updated);
  }
  const usage = `<!-- codemode:${options.agent}:start -->\nUse the codemode MCP search, describe, and execute tools for these services: ${options.servers.join(", ")}. ${workflowGuidance}\n<!-- codemode:${options.agent}:end -->`;
  const usageRoot =
    options.scope === "project"
      ? root
      : options.agent === "claude"
        ? join(home(options), ".claude")
        : options.agent === "codex"
          ? join(home(options), ".codex")
          : join(home(options), ".config", "opencode");
  const instructionPath = join(
    usageRoot,
    options.agent === "claude" ? "CLAUDE.md" : "AGENTS.md",
  );
  const instructions = (await read(instructionPath)) ?? "";
  if (instructions.includes(`<!-- codemode:${options.agent}:start -->`))
    fail("An unmanaged code-mode usage block already exists");
  await add(
    instructionPath,
    instructions +
      (instructions.endsWith("\n") || !instructions ? "" : "\n") +
      "\n" +
      usage +
      "\n",
  );
  const skillDir =
    options.agent === "claude"
      ? ".claude/skills"
      : options.agent === "codex"
        ? ".agents/skills"
        : ".opencode/skills";
  const skillPath =
    options.scope === "user" && options.agent === "opencode"
      ? join(
          home(options),
          ".config",
          "opencode",
          "skills",
          "codemode",
          "SKILL.md",
        )
      : join(root, skillDir, "codemode", "SKILL.md");
  if ((await read(skillPath)) !== null)
    fail("An unmanaged codemode usage skill already exists");
  await add(
    skillPath,
    `---\nname: codemode\ndescription: Discover and call installed service operations through code-mode.\n---\n\n${workflowGuidance} Keep credentials in environment variables.\n`,
  );
  const plan: InstallPlan = {
    agent: options.agent,
    scope: options.scope,
    servers: [...options.servers],
    original: options.original,
    changes: changes.map((c) => ({
      path: c.path,
      action: c.before === null ? "create" : "update",
    })),
    status:
      !options.manifestOnly && options.original === "keep"
        ? "coexistence"
        : "reload-required",
    warnings:
      !options.manifestOnly && options.original === "keep"
        ? ["Original registrations remain available alongside codemode."]
        : [],
  };
  plans.set(plan, { options, changes, transactionPath: txPath });
  return plan;
}
async function atomic(
  path: string,
  contents: string,
  mode = 0o600,
): Promise<void> {
  await safeTarget(path);
  await atomicWrite(path, contents, mode);
}
async function put(
  path: string,
  contents: string | null,
  mode = 0o600,
): Promise<void> {
  if (contents === null) {
    await unlink(path).catch((e: any) => {
      if (e.code !== "ENOENT") throw e;
    });
  } else await atomic(path, contents, mode);
}
export async function applyInstall(plan: InstallPlan): Promise<InstallResult> {
  const internal = plans.get(plan);
  if (!internal)
    fail(
      "Install plan is unavailable or was already applied; create a fresh plan",
    );
  const { changes, options, transactionPath: txPath } = internal!;
  if ((await read(txPath)) !== null) fail("Agent already installed");
  for (const c of changes) {
    await safeTarget(c.path);
    if ((await read(c.path)) !== c.before) fail(`Install conflict: ${c.path}`);
  }
  const tx: Transaction = {
    version: 1,
    phase: "applying",
    manifestOnly: options.manifestOnly,
    agent: options.agent,
    original: options.original,
    changes: changes.map((c) => ({
      path: c.path,
      before: c.before,
      beforeMode: c.beforeMode,
      afterHash: hash(c.after),
    })),
  };
  // The transaction itself is the private byte-for-byte backup and recovery record.
  await atomic(txPath, JSON.stringify(tx));
  const applied: Change[] = [];
  try {
    for (const change of changes) {
      await atomic(change.path, change.after, change.beforeMode);
      applied.push(change);
    }
    tx.phase = "installed";
    await atomic(txPath, JSON.stringify(tx));
  } catch (error) {
    let rollbackFailed = false;
    for (const c of applied.reverse()) {
      try {
        await put(c.path, c.before, c.beforeMode);
      } catch {
        rollbackFailed = true;
      }
    }
    if (!rollbackFailed) await unlink(txPath);
    throw error;
  }
  plans.delete(plan);
  return {
    installed: true,
    status:
      !options.manifestOnly && options.original === "keep"
        ? "coexistence"
        : "reload-required",
    transactionPath: txPath,
  };
}
async function transaction(
  options: InstallOptions,
): Promise<Transaction | null> {
  const text = await read(transactionPath(options));
  if (text === null) return null;
  try {
    const data = JSON.parse(text);
    if (
      data.version !== 1 ||
      !Array.isArray(data.changes) ||
      data.agent !== options.agent ||
      (data.phase !== undefined &&
        !["applying", "installed", "restoring", "refreshing"].includes(
          data.phase,
        ))
    )
      fail("Invalid install transaction");
    return data;
  } catch (error) {
    if (error instanceof CmaError) throw error;
    return fail("Invalid install transaction");
  }
}
export async function statusInstall(
  options: InstallOptions,
): Promise<InstallStatus> {
  const tx = await transaction(options);
  const conflicts: string[] = [];
  if (tx)
    for (const c of tx.changes) {
      const current = await read(c.path);
      if (current === null || hash(current) !== c.afterHash)
        conflicts.push(c.path);
    }
  return {
    installed: !!tx,
    status: !tx
      ? "not-installed"
      : conflicts.length
        ? "conflict"
        : !tx.manifestOnly && tx.original === "keep"
          ? "coexistence"
          : "reload-required",
    conflicts,
    transactionPath: transactionPath(options),
  };
}
export async function restoreInstall(
  options: InstallOptions,
): Promise<InstallResult> {
  const tx = await transaction(options);
  if (!tx) fail("No installation to restore");
  const contents = new Map<string, string | null>();
  for (const c of tx!.changes) {
    await safeTarget(c.path);
    const current = await read(c.path);
    const matchesAfter = current !== null && hash(current) === c.afterHash;
    const recovering = tx!.phase !== undefined && tx!.phase !== "installed";
    const matchesKnown =
      current === c.before ||
      (current !== null && c.recoveryHash === hash(current));
    if (!matchesAfter && !(recovering && matchesKnown))
      fail(`Restore conflict: ${c.path}`);
    contents.set(c.path, current);
  }
  const snapshot = JSON.stringify(tx);
  tx!.phase = "restoring";
  await atomic(transactionPath(options), JSON.stringify(tx));
  const restored: Transaction["changes"] = [];
  try {
    for (const c of [...tx!.changes].reverse()) {
      await put(c.path, c.before, c.beforeMode);
      restored.push(c);
    }
  } catch (error) {
    for (const c of restored.reverse())
      await put(c.path, contents.get(c.path)!, c.beforeMode);
    await atomic(transactionPath(options), snapshot);
    throw error;
  }
  await unlink(transactionPath(options));
  return {
    installed: false,
    status: "restored",
    transactionPath: transactionPath(options),
  };
}
export const verifyInstall = statusInstall;

/** Refresh an installed manifest while retaining its original restore snapshot.
 * Returns false without writing if the manifest has no installation owner.
 */
export async function updateManagedManifest(
  configPath: string,
  manifestPath: string,
  manifest: HarnessManifest,
): Promise<boolean> {
  const directory = dirname(resolve(configPath));
  const target = resolve(manifestPath);
  const prefix = join(directory, "harnesses");
  const child = relative(prefix, target);
  if (
    child.startsWith("..") ||
    isAbsolute(child) ||
    !child.endsWith("/manifest.json")
  )
    return false;
  const entries = await readdir(directory).catch((error: any) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const owners: { path: string; before: string; tx: Transaction }[] = [];
  for (const name of entries) {
    if (!/^install-(claude|codex|opencode)\.json$/.test(name)) continue;
    const path = join(directory, name);
    await safeTarget(path);
    const before = await read(path);
    if (before === null) continue;
    let tx: Transaction;
    try {
      tx = JSON.parse(before);
    } catch {
      fail("Invalid install transaction");
    }
    if (tx!.version !== 1 || !Array.isArray(tx!.changes))
      fail("Invalid install transaction");
    if (tx!.changes.some((change) => resolve(change.path) === target))
      owners.push({ path, before, tx: tx! });
  }
  if (!owners.length) return false;
  await safeTarget(target);
  for (const owner of owners)
    for (const change of owner.tx.changes) {
      await safeTarget(change.path);
      const current = await read(change.path);
      if (current === null || hash(current) !== change.afterHash)
        fail(`Refresh conflict: ${change.path}`);
    }
  const before = await read(target);
  if (before === null) fail(`Refresh conflict: ${target}`);
  const original = parse(before);
  if (manifest.name !== original.name)
    fail("A managed refresh cannot rename the service");
  const declarationPath = join(dirname(target), "tools.d.ts");
  await safeTarget(declarationPath);
  const declarationBefore = await read(declarationPath);
  const edits: Change[] = [
    {
      path: target,
      before,
      after: JSON.stringify(manifest, null, 2) + "\n",
      beforeMode: (await lstat(target)).mode & 0o777,
    },
    {
      path: declarationPath,
      before: declarationBefore,
      after: generateDeclarations(manifest),
      beforeMode:
        declarationBefore === null
          ? 0o600
          : (await lstat(declarationPath)).mode & 0o777,
    },
  ];
  const journaled: typeof owners = [];
  const applied: Change[] = [];
  try {
    // Publish a recovery record before touching either managed file.
    for (const owner of owners) {
      owner.tx.phase = "refreshing";
      for (const edit of edits) {
        const existing = owner.tx.changes.find(
          (change) => resolve(change.path) === edit.path,
        );
        if (existing) {
          existing.recoveryHash =
            edit.before === null ? undefined : hash(edit.before);
          existing.afterHash = hash(edit.after);
        } else
          owner.tx.changes.push({
            path: edit.path,
            before: edit.before,
            beforeMode: edit.beforeMode,
            afterHash: hash(edit.after),
          });
      }
      await atomic(owner.path, JSON.stringify(owner.tx));
      journaled.push(owner);
    }
    for (const edit of edits) {
      await atomic(edit.path, edit.after, edit.beforeMode);
      applied.push(edit);
    }
    for (const owner of owners) {
      owner.tx.phase = "installed";
      for (const change of owner.tx.changes) delete change.recoveryHash;
      await atomic(owner.path, JSON.stringify(owner.tx));
    }
  } catch (error) {
    // If rollback fails, keep the recovery journal rather than claiming a clean state.
    for (const edit of applied.reverse())
      await put(edit.path, edit.before, edit.beforeMode);
    for (const owner of journaled.reverse())
      await atomic(owner.path, owner.before);
    throw error;
  }
  return true;
}
