/**
 * Builds the endpoint {@link Catalog} at runtime by fetching the four Alpaca
 * OpenAPI specs and distilling each operation into a compact, self-describing
 * record (method, path, params, body shape, owning API).
 *
 * This replaces the former build-time `generate-catalog.mjs` step: the catalog
 * is derived on demand (see {@link loadCatalog}) and cached on disk so repeated
 * server launches stay fast and survive brief network outages.
 *
 * The generated OpenAPI *types* are erased at runtime, so this is what makes
 * dynamic endpoint discovery and dispatch possible.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiMeta, AuthStrategy, Catalog, CatalogParameter, CatalogRequestBody, Operation } from './catalog-types';

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

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

// The OpenAPI documents are arbitrary JSON; `any` is the pragmatic type while
// walking them. Everything returned to callers is strongly typed as Catalog.
type SpecDoc = any;

/** Resolves a local `#/...` JSON pointer against the document root. */
function deref(node: any, root: SpecDoc, seen = new Set<string>()): any {
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    if (seen.has(node.$ref)) return {};
    seen.add(node.$ref);
    const target = node.$ref
      .slice(2)
      .split('/')
      .reduce((acc: any, key: string) => acc?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
    return deref(target, root, seen);
  }
  return node;
}

/** Collapses a schema down to {type, enum, description} for compact display. */
function summarizeSchema(schema: any, root: SpecDoc): { type?: string; enum?: Array<string | number | boolean>; description?: string } {
  const s = deref(schema, root);
  if (!s || typeof s !== 'object') return {};
  const type = s.type ?? (s.oneOf || s.anyOf || s.allOf ? 'union' : undefined);
  const out: { type?: string; enum?: Array<string | number | boolean>; description?: string } = {};
  if (type) out.type = Array.isArray(type) ? type.join('|') : type;
  if (s.enum) out.enum = s.enum;
  if (s.description) out.description = String(s.description).split('\n')[0].slice(0, 160);
  return out;
}

function extractParameters(params: any[], root: SpecDoc): CatalogParameter[] {
  return (params ?? [])
    .map((p) => deref(p, root))
    .filter((p) => p && p.in)
    .map((p) => ({ name: p.name, in: p.in, required: Boolean(p.required), ...summarizeSchema(p.schema, root) }));
}

function extractRequestBody(requestBody: any, root: SpecDoc): CatalogRequestBody | undefined {
  const rb = deref(requestBody, root);
  if (!rb?.content) return undefined;
  const [contentType, media] = Object.entries(rb.content)[0] as [string, any];
  const schema = deref(media?.schema, root);
  const properties: CatalogRequestBody['properties'] = {};
  if (schema?.properties) {
    for (const [name, prop] of Object.entries(schema.properties)) {
      properties[name] = summarizeSchema(prop, root);
    }
  }
  return { contentType, required: Boolean(rb.required), requiredFields: schema?.required ?? [], properties };
}

/**
 * Pure transform: given the four parsed OpenAPI documents keyed by API name,
 * produce the full {@link Catalog}.
 */
export function buildCatalog(docs: Record<string, SpecDoc>): Catalog {
  const operations: Operation[] = [];
  const apis: Record<string, ApiMeta> = {};

  for (const [api, source] of Object.entries(SPEC_SOURCES)) {
    const spec = docs[api];
    if (!spec) continue;
    apis[api] = { auth: source.auth, servers: source.servers };

    for (const [path, item] of Object.entries((spec.paths ?? {}) as Record<string, any>)) {
      const sharedParams = item.parameters ?? [];
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!op) continue;
        operations.push({
          api,
          operationId: op.operationId ?? `${method}:${path}`,
          method: method.toUpperCase(),
          path,
          summary: op.summary ?? '',
          tags: op.tags ?? [],
          parameters: extractParameters([...sharedParams, ...(op.parameters ?? [])], spec),
          requestBody: extractRequestBody(op.requestBody, spec),
        });
      }
    }
  }

  operations.sort((a, b) => (a.api + a.path + a.method).localeCompare(b.api + b.path + b.method));
  return { apis, count: operations.length, operations };
}

/** Fetches and parses every spec. All four are valid JSON (authx uses JSON flow style). */
async function fetchDocs(): Promise<Record<string, SpecDoc>> {
  const entries = await Promise.all(
    Object.entries(SPEC_SOURCES).map(async ([api, { url }]) => {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`Failed to fetch ${api} spec (${url}): ${res.status} ${res.statusText}`);
      return [api, JSON.parse(await res.text())] as const;
    })
  );
  return Object.fromEntries(entries);
}

const CACHE_FILE = join(tmpdir(), 'open-alpaca-api-catalog.json');

/**
 * Returns the catalog, deriving it from the live OpenAPI specs.
 *
 * The Alpaca API surface is effectively static, so once the catalog has been
 * built it is cached on disk (in the OS temp dir) and reused indefinitely —
 * subsequent launches never re-fetch. Delete the cache file to rebuild.
 */
export async function loadCatalog(): Promise<Catalog> {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Catalog;
  } catch {
    /* no cache yet — build it from the live specs below */
  }

  const catalog = buildCatalog(await fetchDocs());
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(catalog));
  } catch {
    /* cache is best-effort */
  }
  return catalog;
}
