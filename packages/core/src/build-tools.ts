/**
 * Builds the MCP tool {@link ToolManifest} from the four Alpaca OpenAPI specs.
 *
 * This is a *build-time* concern: {@link buildTools} distils each operation into
 * a self-contained tool definition (name, route, fully `$ref`-resolved input
 * JSON Schema), and `generate-tools.ts` writes the result to
 * `generated/tools.ts`. The MCP server then imports that committed manifest and
 * never touches this module — so the spec-walking code below is kept out of the
 * server bundle.
 */

import type { ApiMeta, AuthStrategy, JsonSchema, ToolDef, ToolInputSchema, ToolManifest } from './manifest-types';

/** Per-API spec URL plus the routing metadata callers need (host + auth). */
export const SPEC_SOURCES: Record<string, { url: string; auth: AuthStrategy; servers: Record<string, string> }> = {
  trading: {
    url: 'https://docs.alpaca.markets/openapi/trading-api.json',
    auth: 'apca',
    servers: { live: 'https://api.alpaca.markets', paper: 'https://paper-api.alpaca.markets' },
  },
  data: {
    url: 'https://docs.alpaca.markets/openapi/market-data-api.json',
    auth: 'apca',
    servers: { live: 'https://data.alpaca.markets', sandbox: 'https://data.sandbox.alpaca.markets' },
  },
  broker: {
    url: 'https://docs.alpaca.markets/openapi/broker-api.json',
    auth: 'basic',
    servers: { live: 'https://broker-api.alpaca.markets', sandbox: 'https://broker-api.sandbox.alpaca.markets' },
  },
  authx: {
    url: 'https://docs.alpaca.markets/openapi/authx.yaml',
    auth: 'form',
    servers: { live: 'https://authx.alpaca.markets/v1', sandbox: 'https://authx.sandbox.alpaca.markets/v1' },
  },
};

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;

/** How deep to inline nested schemas before truncating (keeps the manifest bounded). */
const MAX_DEPTH = 6;

// The OpenAPI documents are arbitrary JSON; `any` is the pragmatic type while
// walking them. Everything returned to callers is strongly typed as ToolManifest.
type SpecDoc = any;

/** Collapses whitespace and trims a (possibly multi-line) string to `max` chars. */
function oneLine(text: any, max = 160): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Follows a chain of local `#/...` JSON pointers to the underlying node. */
function deref(node: any, root: SpecDoc): any {
  let cur = node;
  let guard = 0;
  while (cur && typeof cur === 'object' && typeof cur.$ref === 'string' && cur.$ref.startsWith('#/') && guard++ < 100) {
    cur = cur.$ref
      .slice(2)
      .split('/')
      .reduce((acc: any, key: string) => acc?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
  }
  return cur;
}

/** Resolves a child schema, breaking `$ref` cycles along the current path. */
function resolveChild(node: any, root: SpecDoc, seen: Set<string>, depth: number): JsonSchema {
  const ref = node && typeof node === 'object' && typeof node.$ref === 'string' ? (node.$ref as string) : undefined;
  if (ref) {
    if (seen.has(ref)) return { type: 'object', description: `(recursive ${ref.split('/').pop()})` };
    const next = new Set(seen);
    next.add(ref);
    return resolveSchema(node, root, next, depth + 1);
  }
  return resolveSchema(node, root, seen, depth + 1);
}

/**
 * Deep-resolves an OpenAPI schema into a self-contained JSON Schema: every
 * `$ref` is inlined (with cycle and depth guards) and only tool-relevant
 * keywords are retained.
 */
export function resolveSchema(node: any, root: SpecDoc, seen: Set<string> = new Set(), depth = 0): JsonSchema {
  const s = deref(node, root);
  if (!s || typeof s !== 'object') return {};

  const out: JsonSchema = {};
  if (s.type) out.type = s.type;
  if (s.description) out.description = oneLine(s.description, 200);
  if (s.format) out.format = String(s.format);
  if (Array.isArray(s.enum)) out.enum = s.enum;
  if (s.nullable) out.nullable = true;
  for (const k of ['minimum', 'maximum', 'minLength', 'maxLength'] as const) {
    if (typeof s[k] === 'number') out[k] = s[k];
  }
  if (typeof s.pattern === 'string') out.pattern = s.pattern;

  if (depth >= MAX_DEPTH) return out;

  if (s.properties && typeof s.properties === 'object') {
    out.type ??= 'object';
    out.properties = {};
    for (const [name, prop] of Object.entries(s.properties)) {
      out.properties[name] = resolveChild(prop, root, seen, depth);
    }
    if (Array.isArray(s.required) && s.required.length) out.required = s.required;
  }
  if (s.additionalProperties === false) out.additionalProperties = false;
  else if (s.additionalProperties && typeof s.additionalProperties === 'object') {
    out.additionalProperties = resolveChild(s.additionalProperties, root, seen, depth);
  }
  if (s.items) {
    out.type ??= 'array';
    out.items = resolveChild(s.items, root, seen, depth);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(s[key])) out[key] = s[key].map((m: any) => resolveChild(m, root, seen, depth));
  }
  return out;
}

/** Builds an object sub-schema from a group of path or query parameters. */
function groupSchema(params: any[], root: SpecDoc): JsonSchema | undefined {
  if (!params.length) return undefined;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const p of params) {
    const schema = resolveSchema(p.schema ?? {}, root);
    if (p.description) schema.description = oneLine(p.description, 200);
    properties[p.name] = schema;
    if (p.required || p.in === 'path') required.push(p.name);
  }
  const obj: JsonSchema = { type: 'object', properties };
  if (required.length) obj.required = required;
  return obj;
}

/** Assembles the `{ path?, query?, body? }` input schema for one operation. */
function buildInputSchema(params: any[], requestBody: any, root: SpecDoc): ToolInputSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  const path = groupSchema(params.filter((p) => p.in === 'path'), root);
  if (path) {
    properties.path = path;
    required.push('path');
  }
  const query = groupSchema(params.filter((p) => p.in === 'query'), root);
  if (query) {
    properties.query = query;
    if (query.required?.length) required.push('query');
  }

  const rb = deref(requestBody, root);
  const media =
    rb?.content?.['application/json'] ??
    rb?.content?.['application/x-www-form-urlencoded'] ??
    (rb?.content ? (Object.values(rb.content)[0] as any) : undefined);
  if (media?.schema) {
    properties.body = resolveSchema(media.schema, root);
    if (rb.required) required.push('body');
  }

  const schema: ToolInputSchema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

/** MCP tool names allow `[A-Za-z0-9_-]`; cap at 64 chars. */
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** Derives a unique `alpaca_…` tool name, disambiguating cross-API collisions. */
function uniqueName(api: string, operationId: string, used: Set<string>): string {
  const candidates = [`alpaca_${operationId}`, `alpaca_${api}_${operationId}`];
  for (const candidate of candidates) {
    const name = sanitize(candidate);
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  let i = 2;
  let name = sanitize(`alpaca_${api}_${operationId}_${i}`);
  while (used.has(name)) name = sanitize(`alpaca_${api}_${operationId}_${++i}`);
  used.add(name);
  return name;
}

/**
 * Pure transform: given the four parsed OpenAPI documents keyed by API name,
 * produce the full {@link ToolManifest}.
 */
export function buildTools(docs: Record<string, SpecDoc>): ToolManifest {
  const apis: Record<string, ApiMeta> = {};
  const tools: ToolDef[] = [];
  const used = new Set<string>();

  for (const [api, source] of Object.entries(SPEC_SOURCES)) {
    const spec = docs[api];
    if (!spec) continue;
    apis[api] = { auth: source.auth, servers: source.servers };

    for (const [path, item] of Object.entries((spec.paths ?? {}) as Record<string, any>)) {
      const shared = item.parameters ?? [];
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!op) continue;
        const operationId: string = op.operationId ?? `${method}_${path}`;
        const params = [...shared, ...(op.parameters ?? [])].map((p) => deref(p, spec)).filter((p) => p && p.in);
        tools.push({
          name: uniqueName(api, operationId, used),
          api,
          operationId,
          method: method.toUpperCase(),
          path,
          summary: oneLine(op.summary, 200),
          description: oneLine(op.description, 400),
          inputSchema: buildInputSchema(params, op.requestBody, spec),
        });
      }
    }
  }

  tools.sort((a, b) => a.name.localeCompare(b.name));
  return { apis, tools };
}
