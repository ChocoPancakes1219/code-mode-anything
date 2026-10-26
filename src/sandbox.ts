import { Worker } from "node:worker_threads";
import type { ExecuteResult, ExecutionCall } from "./types.js";

export interface SandboxOptions {
  code: string;
  timeoutMs?: number;
  operations: Record<string, string[]>;
  call(
    server: string,
    operation: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export async function executeSandbox(
  options: SandboxOptions,
): Promise<ExecuteResult> {
  const started = Date.now();
  const timeout = Math.min(30_000, Math.max(1, options.timeoutMs ?? 10_000));
  const abort = new AbortController();
  const calls: ExecutionCall[] = [];
  const source = new URL("./sandbox-worker.js", import.meta.url);
  // Source runs through tsx in development; compiled releases run a plain JS worker.
  const worker = source.pathname.endsWith("/src/sandbox-worker.js")
    ? new Worker(
        `import { register } from 'tsx/esm/api'; register(); await import(${JSON.stringify(new URL("./sandbox-worker.ts", import.meta.url).href)});`,
        {
          eval: true,
          type: "module",
          execArgv: [],
          workerData: {
            code: options.code,
            operations: options.operations,
            deadline: started + timeout,
          },
        } as ConstructorParameters<typeof Worker>[1],
      )
    : new Worker(source, {
        // The worker is its own program: caller flags such as --input-type=module
        // are valid for an eval parent but invalid for this file entry point.
        execArgv: [],
        workerData: {
          code: options.code,
          operations: options.operations,
          deadline: started + timeout,
        },
      });
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (
      error?: Error,
      result?: Omit<ExecuteResult, "calls" | "durationMs">,
    ) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      abort.abort();
      void worker.terminate();
      if (error) reject(error);
      else resolve({ ...result!, calls, durationMs: Date.now() - started });
    };
    const timer = setTimeout(
      () => finish(new Error(`Execution timed out after ${timeout}ms`)),
      timeout,
    );
    worker.on("error", (error) => finish(error));
    worker.on("exit", (code) => {
      if (!finished) finish(new Error(`Sandbox worker exited (${code})`));
    });
    worker.on("message", async (message) => {
      if (finished) return;
      if (message.type === "done") return finish(undefined, message.result);
      if (message.type === "error") return finish(new Error(message.error));
      if (message.type !== "call") return;
      if (calls.length >= 100)
        return finish(new Error("Execution exceeds 100 tool calls"));
      const start = Date.now();
      const call: ExecutionCall = {
        server: message.server,
        operation: message.operation,
        durationMs: 0,
        ok: false,
      };
      calls.push(call);
      try {
        const value = await options.call(
          message.server,
          message.operation,
          message.args,
          abort.signal,
        );
        const serialized = JSON.stringify(value ?? null);
        if (Buffer.byteLength(serialized) > 1_048_576)
          throw new Error("Tool result exceeds 1 MiB");
        call.ok = true;
        if (
          value &&
          typeof value === "object" &&
          "isError" in value &&
          value.isError === true
        )
          call.isError = true;
        if (!finished)
          worker.postMessage({
            type: "reply",
            id: message.id,
            json: serialized,
          });
      } catch (error) {
        call.error = error instanceof Error ? error.message : String(error);
        if (!finished)
          worker.postMessage({
            type: "reply",
            id: message.id,
            error: call.error,
          });
      } finally {
        call.durationMs = Date.now() - start;
      }
    });
  });
}
