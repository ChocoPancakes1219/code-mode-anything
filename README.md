# Code Mode Anything

Generate installable **code-mode harnesses** for existing MCP servers, OpenAPI
APIs, and software with a CLI or SDK. Agents discover operations, write JavaScript
to compose them, and return the data they need.

```text
Coding agent → generator skill → adapter + schemas + types + usage skill
Agent → search / describe / execute → sandbox → real MCP / API / software
```

The first release is a lean implementation. MCP tool conversion is automatic;
OpenAPI supports a documented subset; software/SDK integrations use the coding
agent to implement a real adapter from a scaffold.

## Install from this checkout

Requires Node.js 22+ and npm on macOS or Linux. Backend software may require a
newer Node version: Filesystem MCP 2.0.1 requires Node 24.

```bash
npm ci
npm run check
npm pack
npm install --global ./code-mode-anything-0.1.0.tgz

cma --help
cma skill install --agent codex
```

Use `--agent claude` or `--agent opencode` for the other tested configuration
adapters. Reload the agent to discover installed skills. The package and skills
work without the source checkout. This repository has not been published to npm;
the tarball above is the installable artifact.

## Convert an existing MCP

Interactive installation asks which servers to convert and whether to keep,
disable, or remove their original direct registrations:

```bash
cma install --agent codex
# or:
cma install --agent claude
cma install --agent opencode
```

For agent-controlled or scripted setup, preview and supply explicit choices:

```bash
cma install --agent codex --server github \
  --original disable --dry-run --non-interactive --json

cma install --agent codex --server github \
  --original disable --non-interactive

cma verify --agent codex
```

`disable` is recommended. `remove-registration` deletes only the agent's direct
registration; the backend executable/account is still required. `keep` leaves
both routes active and is labeled **coexistence**. Repeat `--server` to convert
several servers in one installation. Add `--oauth` for remote OAuth connections.

Installation preserves private restoration snapshots, registers the gateway,
installs a usage skill, and adds a managed `AGENTS.md` or `CLAUDE.md` block directing
the agent to code mode for those services. Reload/restart the agent afterward.
Run a normal service task and inspect its tool trace: it should use the gateway's
`search`, `describe`, and `execute`. Disabling/removing the direct registration
prevents that route from appearing after reload.

Verification reports distinct evidence: installation integrity, direct runtime
readiness, actual MCP gateway initialization/discovery/execution, and agent
adoption. `cma verify` checks the gateway over stdio and leaves `agentVerified:false`;
it cannot establish model adoption by reading configuration alone.

Tool-schema measurements appear below.

```bash
cma status --agent codex
cma doctor --agent codex
cma refresh --config .codemode/config.json
cma restore --agent codex
# cma uninstall --agent codex is an alias for restore
```

Refresh rediscovers MCP schemas and preserves managed restoration snapshots.
Restart the gateway to load changes. Restore stops on conflicting user edits.
One agent installation owns a runtime directory at a time; use separate projects
or restore it before installing another owner. `--scope user` selects user scope;
use the same project/scope for subsequent status and restoration commands.

The CLI refuses source settings it cannot preserve, including tool filters,
some custom credential forwarding/OAuth objects, explicit source timeouts, and
unsupported TOML layouts. It reports the setting instead of bypassing it.
Unknown managed/plugin registrations require manual configuration; use coexistence
until the original route can be disabled correctly.

## Examples

The catalog contains the requested official servers:

```bash
cma catalog list
cma catalog info playwright
cma install --agent codex --catalog playwright --non-interactive
```

| Harness                                                        | Backend / prerequisites                                                | Example ordinary task                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Atlassian](https://github.com/atlassian/atlassian-mcp-server) | Official remote endpoint; Atlassian tenant and browser OAuth           | “Summarize the open issues in my test Jira project and their related Confluence information.” |
| [Playwright](https://github.com/microsoft/playwright-mcp)      | Pinned official stdio server; Playwright browser binaries/dependencies | “Open my local inventory page and list the in-stock products.”                                |
| [GitHub](https://github.com/github/github-mcp-server)          | Official remote endpoint; `GITHUB_TOKEN`                               | “Summarize the open fixture issues in my test repository.”                                    |
| GitHub REST                                                    | Small public REST/OpenAPI adapter; API rate limits apply               | “Read metadata for the microsoft/playwright-mcp repository.”                                  |
| Inkscape                                                       | Local Inkscape binary or `INKSCAPE_BIN`                                | “Render this SVG as a new 640-pixel-wide PNG.”                                                |

The GitHub REST reference was exercised against public repository metadata
through code mode and returned `microsoft/playwright-mcp`. This verifies that
small API adapter; it does not establish authenticated GitHub MCP behavior.

Authenticate before testing the services. Catalog MCP entries discover actual
tools at installation; they do not contain invented operation schemas. GitHub
uses an environment reference, and Atlassian uses the pinned `mcp-remote` helper's
normal login. Existing agent OAuth sessions are not extracted or copied.

### Generate an MCP package

```bash
cma import mcp --name playwright \
  --command npx --arg=-y --arg=@playwright/mcp@0.0.83 \
  --arg=--headless --arg=--isolated --output ./harness-playwright

cma install --agent codex \
  --manifest ./harness-playwright/manifest.json --non-interactive
```

The generated directory contains `manifest.json`, `tools.d.ts`, `package.json`,
`skills/SKILL.md`, README, and a test-plan record. Review credentials before
packing or sharing a harness. Discovery proves that the server advertised tools;
it does not prove every business operation works.

### Generate an API or software adapter

```bash
cma import openapi --name github-rest \
  --file examples/github-rest/openapi.json --output ./harness-github-rest

cma scaffold my-software --source /path/to/source --output ./harness-my-software
cma validate ./harness-my-software
```

Use the `cma-setup` skill to build/refine/test/validate the scaffold. Implement
`createAdapter(manifest)` returning `call(operation,args,signal)` and optional
`close()`. Describe operations in the manifest and test the actual backend.
Scaffolding reports `implemented:false`; structural validation does not turn it
into a finished integration. Packaging uses `npm pack` in the generated directory.

OpenAPI accepts 3.0/3.1 JSON documents, local acyclic references, primitive
path/query/header parameters, and JSON request bodies. External/circular refs,
complex parameter serialization, cookie parameters, and non-JSON request bodies
need a custom adapter. Per-operation/server overrides require an explicit base
URL. Configure authentication headers with `${ENV_VAR}` references in the manifest.

The Inkscape reference exposes version inspection and SVG-to-PNG export with PNG
header/dimension checks. It requires the real renderer and refuses an existing
output. Its module path is linked to the installed/source package; retain that
package while using the harness. A real render remains unverified in this
environment because Inkscape is unavailable.

## Use code mode

The gateway exposes three tools regardless of the backend catalog size:

| Tool       | Input                                                           | Result                                                                 |
| ---------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `search`   | `query`, optional `server`, `limit`, `offset`, `includeSchemas` | Ranked matches; five by default, with schemas and concise descriptions |
| `describe` | `server`, either `operation` or `operations`                    | One schema/example or a batch of them                                  |
| `execute`  | JavaScript body, optional `timeoutMs`, `detail`                 | Final value, call/failure counts, errors, logs, and emitted content    |

Use search's schemas directly when sufficient. Batch missing schemas with `describe({server, operations: [...]})`. Compose dependent calls, filtering, and aggregation in one execution; keep intermediate listings and snapshots inside the script and return only the requested answer.

Gateway execution defaults to compact results. Set `detail: "full"` to include individual call diagnostics. The library and `cma run` continue returning full call records. Compact results preserve explicit logs and report transport and MCP business failures.

```js
// Use real names and arguments returned by search/describe.
const result = await tools["service"]["operation"]({
  /* described arguments */
});
if (result.isError) throw new Error("Service operation failed");
return result.structuredContent ?? result.content;
```

MCP results retain their envelopes; text JSON parsing is explicit. Plain API and
module adapters return their documented values. `emit(block)` forwards valid
image/audio/resource content, and `console.log` captures diagnostics.

CLI equivalents support local scripts and diagnostics:

```bash
cma search 'issues' --config .codemode/config.json
cma describe github operation_name --config .codemode/config.json
cma run --file workflow.js --config .codemode/config.json
```

Each script gets fresh QuickJS state. Backend sessions persist for the running
gateway; separate CLI runs start separate sessions. Runtime captures an immutable
snapshot of the supplied manifests; reload it after catalog changes. Generated JavaScript has no
Node globals or direct filesystem/network access. Trusted adapters access their
actual backends. Default execution deadline is 10 seconds (maximum 30), with a
32 MiB guest memory cap, 100 calls, and 1 MiB tool/output limits. These are guest
and bridge limits, not a whole-process memory limit for trusted backends.

Agent approval applies to the submitted script as a whole; backend credentials
and service permissions still apply. Individual underlying calls do not get a
new approval dialog. Scripts are never automatically replayed after failures;
completed side effects cannot be rolled back by the sandbox.

V1 converts **tools**. It does not proxy MCP prompts, resource catalogs, sampling,
elicitation, MCP Apps interfaces, or task extensions. Select coexistence when
those capabilities are required. OAuth/legacy remote transport can use
`mcp-remote`; automatic import of explicit legacy SSE registrations is refused.

## Tool-schema token results

| Task       | Direct MCP tokens | CMA tokens | Tokens reduced | Reduction |
| ---------- | ----------------: | ---------: | -------------: | --------: |
| Filesystem |             2,739 |        451 |          2,288 |     83.5% |
| Browser    |             4,396 |        451 |          3,945 |     89.7% |
| Git        |             1,475 |        451 |          1,024 |     69.4% |

These measurements cover tool schemas only. Initialization instructions, discovery responses, execution output, and conversation history are excluded. Schema-token reductions do not establish total task-token or billing savings.

## Development and verification

```bash
npm ci
npm run check
npm run test:package
npm pack --dry-run
```

Tests exercise real SDK MCP stdio connections, a local HTTP backend, the sandbox,
installer round trips/conflicts, generated packages, and file recovery.
Fixture responses in unit tests verify protocol behavior; the schema measurements
above come from actual MCP tool discovery. The supported backend set and
real-service verification status are documented above.

MIT licensed. External MCP servers and backend software retain their licenses.
