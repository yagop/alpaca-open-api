/**
 * Types for the generated MCP tool {@link ToolManifest} (see `generated/tools.ts`).
 *
 * The manifest is a compact, runtime-available index of every Alpaca operation
 * across the four OpenAPI specs, each carrying a self-contained JSON Schema for
 * its input. It is what the spec-generated *types* cannot provide at runtime,
 * since types are erased. The MCP server imports it and registers one tool per
 * operation, handing each `inputSchema` straight to the client.
 */

/** How an API authenticates requests. */
export type AuthStrategy = 'apca' | 'basic' | 'form';

/** Per-API metadata: auth strategy and the base URLs that back it. */
export type ApiMeta = {
  auth: AuthStrategy;
  servers: Record<string, string>;
};

/**
 * A plain JSON Schema (Draft-07 subset), fully `$ref`-resolved so MCP clients
 * that don't dereference can still render the shape. Only the keywords useful
 * for tool-calling are retained.
 */
export type JsonSchema = {
  type?: string | string[];
  description?: string;
  format?: string;
  enum?: Array<string | number | boolean | null>;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};

/**
 * The input schema for one tool: a top-level object whose properties group the
 * operation's `path` params, `query` params, and request `body` (each present
 * only when the operation has them).
 */
export type ToolInputSchema = {
  type: 'object';
  properties: Record<string, JsonSchema>;
  required?: string[];
};

/** One catalogued operation, ready to register as an MCP tool. */
export type ToolDef = {
  /** Tool name exposed to clients, e.g. `alpaca_getAccount`. */
  name: string;
  api: string;
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  inputSchema: ToolInputSchema;
};

/** The full manifest: per-API routing metadata plus every tool. */
export type ToolManifest = {
  apis: Record<string, ApiMeta>;
  tools: ToolDef[];
};
