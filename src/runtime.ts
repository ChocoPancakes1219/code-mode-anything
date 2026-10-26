import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Ajv2019 } from "ajv/dist/2019.js";
import type {
  HarnessManifest,
  ExecuteInput,
  SearchInput,
  DescribeInput,
  SearchResult,
  Operation,
} from "./types.js";
import { loadConfig } from "./manifest.js";
import { BackendPool } from "./backends.js";
import { executeSandbox } from "./sandbox.js";

function freezeCatalog(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const item of Object.values(value)) freezeCatalog(item);
}

export class Runtime {
  private pool = new BackendPool();
  private validators = new Map<string, ValidateFunction>();
  public readonly manifests: HarnessManifest[];
  private manifestIndex = new Map<string, HarnessManifest>();
  private operationIndex = new Map<string, Operation>();
  private catalog: Array<{ result: SearchResult; text: string }> = [];
  private operations: Record<string, string[]>;
  constructor(manifests: HarnessManifest[]) {
    this.manifests = structuredClone(manifests);
    this.operations = Object.fromEntries(
      this.manifests.map((manifest) => [
        manifest.name,
        manifest.operations.map((operation) => operation.name),
      ]),
    );
    for (const manifest of this.manifests) {
      this.manifestIndex.set(manifest.name, manifest);
      for (const operation of manifest.operations) {
        this.operationIndex.set(
          `${manifest.name}/${operation.name}`,
          operation,
        );
        const result: SearchResult = {
          server: manifest.name,
          operation: operation.name,
          ...(operation.description
            ? { description: operation.description }
            : {}),
        };
        this.catalog.push({
          result,
          text: `${result.server} ${result.operation} ${result.description ?? ""}`.toLowerCase(),
        });
      }
    }
    const compilers = new Map<string, Ajv | Ajv2020 | Ajv2019>();
    for (const manifest of this.manifests)
      for (const operation of manifest.operations) {
        const dialect = String(operation.inputSchema.$schema ?? "draft-07");
        let compiler = compilers.get(dialect);
        if (!compiler) {
          // Each operation owns its schema IDs; local references still resolve in its compilation environment.
          const options = {
            strict: false,
            allErrors: true,
            addUsedSchema: false,
          };
          compiler = dialect.includes("2020-12")
            ? new Ajv2020(options)
            : dialect.includes("2019-09")
              ? new Ajv2019(options)
              : new Ajv(options);
          compilers.set(dialect, compiler);
        }
        this.validators.set(
          `${manifest.name}/${operation.name}`,
          compiler.compile(operation.inputSchema),
        );
      }
    freezeCatalog(this.manifests);
  }
  search(input: SearchInput = { query: "" }) {
    const words = (input.query ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const inferred = input.server
      ? []
      : this.manifests
          .filter((manifest) => words.includes(manifest.name.toLowerCase()))
          .map((manifest) => manifest.name.toLowerCase());
    const servers = input.server ? [input.server.toLowerCase()] : inferred;
    const terms = [
      ...new Set(
        words
          .filter((word) => !servers.includes(word))
          .flatMap((word) => word.split(/[^\p{L}\p{N}]+/u))
          .filter(Boolean)
          .map((term) =>
            term.length > 3 && term.endsWith("s") ? term.slice(0, -1) : term,
          ),
      ),
    ];
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 50), 200));
    const ranked: Array<{ result: SearchResult; score: number }> = [];
    for (const item of this.catalog) {
      if (servers.length && !servers.includes(item.result.server.toLowerCase()))
        continue;
      const name = item.result.operation.toLowerCase();
      const scores = terms.map((term) =>
        name.includes(term) ? 10 : item.text.includes(term) ? 1 : 0,
      );
      if (terms.length && !scores.some(Boolean)) continue;
      const exact = words.includes(name);
      const score =
        scores.reduce<number>((sum, value) => sum + value, 0) +
        (exact
          ? 100
          : /deprecated/i.test(item.result.description ?? "")
            ? -50
            : 0);
      ranked.push({ result: item.result, score });
    }
    return ranked
      .sort((a, b) => b.score - a.score)
      .slice(offset, offset + limit)
      .map(({ result }) => {
        const operation = this.operationIndex.get(
          `${result.server}/${result.operation}`,
        )!;
        return {
          ...result,
          ...(input.includeSchemas
            ? {
                inputSchema: operation.inputSchema,
                ...(operation.outputSchema
                  ? { outputSchema: operation.outputSchema }
                  : {}),
              }
            : {}),
        };
      });
  }
  describe(input: DescribeInput) {
    const manifest = this.manifestIndex.get(input.server);
    const operation = this.operationIndex.get(
      `${input.server}/${input.operation}`,
    );
    if (!manifest || !operation)
      throw new Error(`Unknown operation: ${input.server}/${input.operation}`);
    return {
      server: manifest.name,
      operation: operation.name,
      description: operation.description,
      inputSchema: operation.inputSchema,
      outputSchema: operation.outputSchema,
      example: `await tools[${JSON.stringify(manifest.name)}][${JSON.stringify(operation.name)}]({})`,
    };
  }
  async call(
    server: string,
    operation: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error("Execution deadline exceeded");
    const manifest = this.manifestIndex.get(server);
    const validator = this.validators.get(`${server}/${operation}`);
    if (!manifest || !validator)
      throw new Error(`Unknown operation: ${server}/${operation}`);
    if (!validator(args))
      throw new Error(
        `Invalid arguments for ${server}/${operation}: ${JSON.stringify(validator.errors)}`,
      );
    const adapter = await this.pool.get(manifest);
    if (signal?.aborted) throw new Error("Execution deadline exceeded");
    return adapter.call(operation, args, signal);
  }
  execute(input: ExecuteInput) {
    return executeSandbox({
      ...input,
      operations: this.operations,
      call: this.call.bind(this),
    });
  }
  close() {
    return this.pool.close();
  }
}
export async function loadRuntime(configPath: string): Promise<Runtime> {
  return new Runtime(await loadConfig(configPath));
}
