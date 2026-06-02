/**
 * Types describing the generated endpoint {@link Catalog} (see `catalog.ts`).
 *
 * The catalog is a compact, runtime-available index of every Alpaca operation
 * across the four OpenAPI specs — what the spec-generated *types* cannot provide
 * at runtime, since types are erased. Consumers like the MCP server use it to
 * discover and invoke endpoints dynamically.
 */

/** How an API authenticates requests. */
export type AuthStrategy = 'apca' | 'basic' | 'form';

/** Per-API metadata: auth strategy and the base URLs that back it. */
export type ApiMeta = {
  auth: AuthStrategy;
  servers: Record<string, string>;
};

/** A single parameter (path or query) distilled from the spec. */
export type CatalogParameter = {
  name: string;
  in: string;
  required: boolean;
  type?: string;
  enum?: Array<string | number | boolean>;
  description?: string;
};

/** The shape of an operation's request body, flattened to its top level. */
export type CatalogRequestBody = {
  contentType: string;
  required: boolean;
  requiredFields: string[];
  properties: Record<string, { type?: string; enum?: Array<string | number | boolean>; description?: string }>;
};

/** One catalogued operation. */
export type Operation = {
  api: string;
  operationId: string;
  method: string;
  path: string;
  summary: string;
  tags: string[];
  parameters: CatalogParameter[];
  requestBody?: CatalogRequestBody;
};

/** The full catalog: API metadata plus every operation. */
export type Catalog = {
  apis: Record<string, ApiMeta>;
  count: number;
  operations: Operation[];
};
