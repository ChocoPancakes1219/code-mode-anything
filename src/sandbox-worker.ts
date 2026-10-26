import { parentPort, workerData } from "node:worker_threads";
import { getQuickJS, type QuickJSDeferredPromise } from "quickjs-emscripten";
import { ContentBlockSchema } from "@modelcontextprotocol/sdk/types.js";

const port = parentPort!;
const { code, operations, deadline } = workerData as {
  code: string;
  operations: Record<string, string[]>;
  deadline: number;
};
const QuickJS = await getQuickJS();
const runtime = QuickJS.newRuntime();
runtime.setMemoryLimit(32 * 1024 * 1024);
runtime.setMaxStackSize(1024 * 1024);
runtime.setInterruptHandler(() => Date.now() > deadline);
const vm = runtime.newContext();
const pending = new Map<number, QuickJSDeferredPromise>();
let sequence = 0;
let disposed = false;
let outputBytes = 0;
const logs: string[] = [];
const emitted: Record<string, unknown>[] = [];
function account(value: unknown) {
  outputBytes += Buffer.byteLength(JSON.stringify(value) ?? "null");
  if (outputBytes > 1_048_576)
    throw new Error("Execution output exceeds 1 MiB");
}
function pump() {
  if (disposed) return;
  const result = runtime.executePendingJobs();
  if (result.error) {
    const error = vm.dump(result.error);
    result.error.dispose();
    fail(error);
  }
}
function fail(error: unknown) {
  if (Date.now() >= deadline) error = new Error("Execution deadline exceeded");
  if (!disposed)
    port.postMessage({
      type: "error",
      error:
        typeof error === "object" && error && "message" in error
          ? String(error.message)
          : String(error),
    });
}
const bridge = vm.newFunction("__call", (server, operation, args) => {
  const deferred = vm.newPromise();
  const id = ++sequence;
  pending.set(id, deferred);
  port.postMessage({
    type: "call",
    id,
    server: vm.dump(server),
    operation: vm.dump(operation),
    args: vm.dump(args),
  });
  return deferred.handle;
});
vm.setProp(vm.global, "__call", bridge);
bridge.dispose();
const log = vm.newFunction("__log", (...args) => {
  const text = args
    .map((arg) => {
      const value = vm.dump(arg);
      return typeof value === "string" ? value : JSON.stringify(value);
    })
    .join(" ");
  account(text);
  logs.push(text);
});
vm.setProp(vm.global, "__log", log);
log.dispose();
const emit = vm.newFunction("emit", (arg) => {
  const value = vm.dump(arg);
  const blocks = Array.isArray(value)
    ? value
    : value?.content && Array.isArray(value.content)
      ? value.content
      : [value];
  for (const block of blocks) {
    const parsed = ContentBlockSchema.safeParse(block);
    if (!parsed.success)
      throw new Error("Invalid emitted MCP content: " + parsed.error.message);
    account(parsed.data);
    emitted.push(parsed.data);
  }
});
vm.setProp(vm.global, "emit", emit);
emit.dispose();
const setup = vm.evalCode(
  `globalThis.console = { log: __log, info: __log, warn: __log, error: __log }; globalThis.tools = Object.create(null); for (const [server, operations] of Object.entries(${JSON.stringify(operations)})) { const target = Object.create(null); for(const operation of operations) target[operation] = (args = {}) => __call(server,operation,args); tools[server] = Object.freeze(target); } Object.freeze(tools);`,
);
if (setup.error) {
  fail(vm.dump(setup.error));
  setup.error.dispose();
} else setup.value.dispose();
port.on("message", (message) => {
  if (disposed || message.type !== "reply") return;
  const deferred = pending.get(message.id);
  if (!deferred) return;
  pending.delete(message.id);
  if (message.error) {
    const error = vm.newError(message.error);
    deferred.reject(error);
    error.dispose();
  } else {
    const result = vm.evalCode(`JSON.parse(${JSON.stringify(message.json)})`);
    if (result.error) {
      deferred.reject(result.error);
      result.error.dispose();
    } else {
      deferred.resolve(result.value);
      result.value.dispose();
    }
  }
  deferred.dispose();
  pump();
});
const result = vm.evalCode(`(async () => { ${code}\n })()`, "execution.js");
if (result.error) {
  fail(vm.dump(result.error));
  result.error.dispose();
} else {
  const completion = vm.resolvePromise(result.value);
  result.value.dispose();
  completion
    .then((outcome) => {
      if (disposed) return;
      if (outcome.error) {
        fail(vm.dump(outcome.error));
        outcome.error.dispose();
      } else {
        try {
          const value = vm.dump(outcome.value);
          account(value);
          port.postMessage({
            type: "done",
            result: { value, logs, ...(emitted.length ? { emitted } : {}) },
          });
        } catch (error) {
          fail(error);
        } finally {
          outcome.value.dispose();
        }
      }
      disposed = true;
      for (const deferred of pending.values()) deferred.dispose();
      pending.clear();
      vm.dispose();
      runtime.dispose();
      port.close();
    })
    .catch(fail);
  pump();
}
