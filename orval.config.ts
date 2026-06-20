import { defineConfig } from 'orval';

const SPECS: Record<string, string> = {
  trading: 'https://docs.alpaca.markets/openapi/trading-api.json',
  data: 'https://docs.alpaca.markets/openapi/market-data-api.json',
  broker: 'https://docs.alpaca.markets/openapi/broker-api.json',
  authx: 'https://docs.alpaca.markets/openapi/auth.json',
};

/**
 * MCP tool surface (handlers + Zod tool-schemas + fetch client), composed onto one
 * server in `packages/mcp/src/compose.ts`. `target` must be `handlers.ts` (the mcp
 * template hardcodes `./handlers`); `baseUrl: ''` keeps URLs host-less so the
 * mutator supplies host + auth; response Zod is disabled (no outputSchema).
 */
const mcpProject = (api: string) => ({
  input: { target: SPECS[api] },
  output: {
    client: 'mcp' as const,
    target: `packages/mcp/src/generated/${api}/handlers.ts`,
    schemas: `packages/mcp/src/generated/${api}/model`,
    baseUrl: '',
    override: {
      mutator: { path: 'packages/mcp/src/mutator.ts', name: `${api}Mutator` },
      zod: { generate: { response: false } },
    },
  },
});

/** Typed fetch client for `@alpaca-open-api/core` consumers (host + auth via the shared mutator). */
const coreClient = (api: string) => ({
  input: { target: SPECS[api] },
  output: {
    client: 'fetch' as const,
    target: `packages/core/src/generated/${api}/client.ts`,
    schemas: `packages/core/src/generated/${api}/model`,
    baseUrl: '',
    override: { mutator: { path: 'packages/core/src/mutator.ts', name: `${api}Mutator` } },
  },
});

export default defineConfig({
  trading: mcpProject('trading'),
  data: mcpProject('data'),
  broker: mcpProject('broker'),
  authx: mcpProject('authx'),
  'core-trading': coreClient('trading'),
  'core-data': coreClient('data'),
  'core-broker': coreClient('broker'),
  'core-authx': coreClient('authx'),
});
