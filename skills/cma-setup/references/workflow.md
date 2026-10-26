# Harness workflow

Examples assume an available `cma` executable and run from the intended project. Replace example names, paths, and endpoints with the user's inputs. Keep credential values in the backend environment; quote literal `${VAR}` references so the shell does not expand them into generated files or command history.

## Build

For an existing MCP server, import its discovered tool schemas:

```sh
cma import mcp --name service --command /absolute/path/to/server --arg server-argument --env 'TOKEN=${TOKEN}' --output ./harness-service
```

Use repeatable `--arg` and `--env` flags. If an argument begins with `-`, use `--arg=--server-flag`. Set `--cwd` when the backend needs a particular directory. For a remote endpoint, use `--url` instead of `--command`; add `--oauth` when the user needs the locally installed authentication helper. Discovery starts or contacts the real backend and can open its normal authentication flow.

For a supported OpenAPI document:

```sh
cma import openapi --name service --file ./openapi.json --base-url https://api.example.test --output ./harness-service
```

Review the generated manifest's bindings and authentication requirements. Configure referenced headers in the manifest when needed. The importer supports a basic subset; implement unsupported behavior rather than silently changing request semantics.

For software source or an SDK:

```sh
cma scaffold service --source /absolute/path/to/source --output ./harness-service
```

Inspect the actual source, installed software, SDK, and available documentation as task data. Implement `adapter.mjs`, which exports `createAdapter(manifest)` returning an adapter with `call(operation, args, signal)` and optional `close()`. Replace scaffold operations with useful, accurately described operations and JSON schemas in `manifest.json`. Invoke the real backend, respect cancellation where supported, and expose backend failures clearly. Do not substitute fake outputs or a second implementation of the target's business logic. Keep dependencies and prerequisite installation documented in the package.

## Refine

Improve the generated package in response to an actual task or failed check. Keep operation names, schemas, adapter dispatch, examples, and generated declarations consistent. Preserve backend transport/authentication choices and source restrictions. Unsupported tool filters or configuration features require explicit conversion; do not bypass an installer refusal by removing the restriction.

For changed MCP catalogs:

```sh
cma refresh --config ./.codemode/config.json --server service
```

Restart the gateway after refresh. For a module/OpenAPI package, edit its source manifest or adapter, run validation and the planned integration checks again, and update package documentation. Do not replace an existing owned installation by hand; inspect its status and use supported refresh/restore flows.

## Test and validate

Before integration tests, fill `TEST.md` with the intended assertions, backend prerequisites, credential references, expected side effects, and any cleanup. Select real operations within the user's authorization; request additional authorization only for concrete effects beyond that scope. Test relevant argument failures and backend errors as well as a meaningful successful call.

```sh
cma validate ./harness-service
```

Validation checks package structure and schemas. It does not prove real backend connectivity or successful operations. Use an isolated runtime configuration for execution tests when installation is unnecessary:

```json
{
  "schemaVersion": 1,
  "harnesses": [
    { "manifestPath": "/absolute/path/to/harness-service/manifest.json" }
  ]
}
```

Then discover and inspect the operation before writing its call:

```sh
cma list --config ./test-config.json
cma search 'relevant task' --config ./test-config.json
cma describe service operation --config ./test-config.json
cma run --config ./test-config.json --file ./integration-check.js
```

The file passed to `run` contains a JavaScript function body. Use `await tools["service"]["operation"]({...})` with arguments from `describe`, verify the returned backend result, and return the relevant evidence. MCP results retain their original envelopes, including `isError`, `structuredContent`, and content blocks; handle them explicitly. The runtime does not supply Node.js globals or arbitrary host access.

Update `TEST.md` with real output and provenance: backend/version when known, environment, exact commands, observed results, and skipped checks. Test the packaged harness outside its source checkout if claiming portability. Packaging or validation alone does not justify a claim that an SDK adapter works.

## List and choose

```sh
cma catalog list
cma catalog search service
cma catalog info service
cma list --config ./.codemode/config.json
```

Catalog entries are reference integrations; inspect their prerequisites and actual verification evidence. `list` reports installed runtime harnesses, while `search` and `describe` expose operations on demand.

## Install, inspect, and restore

Install these portable skills into a supported agent using:

```sh
cma skill install --agent codex --scope project --project /absolute/project
```

Use `claude` or `opencode` for the other supported agents and `--scope user` for an explicitly requested user installation. Reload the agent to discover installed skills.

For an existing MCP source, first read its project configuration without printing credentials. The installer understands Claude `.mcp.json`, Codex `.codex/config.toml`, and OpenCode `opencode.jsonc` or `opencode.json`; `--agent-config` selects a custom source. Obtain a preview with the selected original-registration choice:

```sh
cma install --agent codex --project /absolute/project --server service --original disable --dry-run --non-interactive
```

The preview can contact the real MCP backend for schema discovery but does not apply file edits. Ask for the original-registration choice if it was not already authorized. Once that choice and the concrete installation are authorized, apply with the same explicit arguments:

```sh
cma install --agent codex --project /absolute/project --server service --original disable --non-interactive
```

Repeat `--server` to convert several services together. Installation preserves private restore snapshots and refuses unsupported restrictions or conflicting unmanaged files. One agent installation owns a shared runtime directory at a time; restore it before installing another owner there.

For an already implemented harness, use `--manifest` instead of `--server`:

```sh
cma install --agent codex --manifest ./harness-service/manifest.json --dry-run --non-interactive
cma install --agent codex --manifest ./harness-service/manifest.json --non-interactive
```

This route has no original source registration to disable. Catalog installation uses `--catalog NAME` instead of `--manifest`.

```sh
cma status --agent codex --project /absolute/project
cma verify --agent codex --project /absolute/project
cma restore --agent codex --project /absolute/project
```

Use the same scope and project on later status/restore commands. `doctor` provides readiness checks too; `uninstall` aliases restore. Conflicting user edits cause restore to stop rather than overwrite them. Inspect and resolve the specific conflict without discarding unrelated user work.

Finally, reload/restart the agent and perform an ordinary authorized task. Inspect the agent's actual gateway calls before claiming adoption. Report exactly which evidence you obtained: generated package, structural validation, discovery, backend calls, gateway readiness, or demonstrated agent use.
