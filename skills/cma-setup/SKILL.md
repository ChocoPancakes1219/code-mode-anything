---
name: cma-setup
description: Build, refine, test, validate, list, or install code-mode harnesses for MCP servers, OpenAPI APIs, software source, and SDKs using the current coding agent.
---

Use the installed `cma` CLI to create a reusable harness package and connect its gateway to Claude Code, Codex, or OpenCode. This skill guides the current coding agent; it does not start another model or require an agent orchestration service.

Read [references/workflow.md](references/workflow.md) for the selected build, refine, test, validate, list, or installation workflow. Use `cma --help` and command-specific help when the installed version differs from the examples. If `cma` is unavailable, use the actual checkout's documented build or package installation instructions; do not invent a published package or download URL.

Choose the narrowest source interface that covers the user's task:

- Existing MCP: deterministic `tools/list` discovery generates schemas and reuses the real server connection. Discovery does not prove that business operations work.
- OpenAPI: import the supported OpenAPI 3.x JSON subset. Unsupported request formats or parameter styles need an implemented adapter.
- Source or SDK: scaffold a module package, then inspect the target and implement a real backend adapter. A generated scaffold is unfinished.

Write the test plan in the generated package's `TEST.md` before executing integration tests. Record actual commands, prerequisites, observed output, failures, and skipped checks afterward. Distinguish structural validation, discovery, real backend calls, gateway readiness, and observed agent adoption. Never invent test results, token measurements, or success percentages.

For MCP conversion, inspect the source configuration and obtain an installation preview. Preserve the user's existing choices. If the user has not chosen what happens to the original registrations, ask them to select `keep`, `disable`, or `remove-registration`; explain that `keep` exposes both routes, `disable` retains the source registration, and removal deletes only that registration. Then invoke explicit arguments with `--non-interactive`. Removing a registration never authorizes deleting its backend binary, package, credentials, or remote service.

After installation, reload the agent and verify an ordinary service task through its actual tool-call trace. `cma verify` reports configuration/gateway readiness; it does not prove that the agent has adopted the gateway.
