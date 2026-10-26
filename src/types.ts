/** JSON-only values crossing the sandbox boundary. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;

export interface StdioTransport {
  type: "stdio";
  command: string;
  args?: string[];
  /** Values may contain ${ENV_VAR}; secrets should remain references on disk. */
  env?: Record<string, string>;
  cwd?: string;
}
export interface HttpTransport {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  oauth?: "mcp-remote";
}
export type Backend =
  | { kind: "mcp"; transport: StdioTransport | HttpTransport }
  | { kind: "openapi"; baseUrl: string; headers?: Record<string, string> }
  | { kind: "module"; entry: string };

export interface RestParameter {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
}
export interface RestBinding {
  method: string;
  path: string;
  parameters?: RestParameter[];
  /** Arguments property used for the JSON request body; defaults to body. */
  requestBody?: { argument?: string; required?: boolean };
}
export interface Operation {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  binding?: RestBinding;
}
export interface HarnessManifest {
  schemaVersion: 1;
  name: string;
  description?: string;
  backend: Backend;
  operations: Operation[];
}
export interface RuntimeConfig {
  schemaVersion: 1;
  harnesses: Array<{ manifestPath: string; enabled?: boolean }>;
}

/** Modules are trusted host adapters; only generated JS runs in QuickJS. */
export interface HarnessAdapter {
  call(
    operation: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  close?(): Promise<void>;
}
export interface HarnessRuntime extends HarnessAdapter {
  manifest: HarnessManifest;
  close(): Promise<void>;
}
/** A module backend exports createAdapter(manifest) returning this interface. */
export type AdapterFactory = (
  manifest: HarnessManifest,
) => HarnessAdapter | Promise<HarnessAdapter>;

export interface SearchInput {
  query: string;
  server?: string;
  limit?: number;
  offset?: number;
  includeSchemas?: boolean;
}
export interface SearchResult {
  server: string;
  operation: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
}
export interface DescribeInput {
  server: string;
  operation: string;
}
export interface DescribeResult extends SearchResult {
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  example: string;
}
export interface ExecuteInput {
  code: string;
  timeoutMs?: number;
}
export interface ExecutionCall {
  server: string;
  operation: string;
  durationMs: number;
  /** Successful transport invocation, not a claim of business-level success. */
  ok: boolean;
  /** A backend reported a business error despite successful transport. */
  isError?: boolean;
  error?: string;
}
/** Optional explicitly emitted MCP blocks, including image/resource results. */
export interface EmittedContent {
  type: string;
  [key: string]: unknown;
}
export interface ExecuteResult {
  value: unknown;
  logs: string[];
  calls: ExecutionCall[];
  durationMs: number;
  emitted?: EmittedContent[];
}
export interface Runtime {
  search(input: SearchInput): SearchResult[];
  describe(input: DescribeInput): DescribeResult;
  execute(input: ExecuteInput): Promise<ExecuteResult>;
  close(): Promise<void>;
}
