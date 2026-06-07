/**
 * Single source of truth for per-API routing: which host backs each Alpaca API
 * and how it authenticates. Pure data, consumed by the MCP server's mutator
 * (`packages/mcp/src/mutator.ts`) to resolve host + auth per API.
 */

/** How an API authenticates requests. */
export type AuthStrategy = 'apca' | 'basic' | 'form';

/** Per-API metadata: auth strategy and the base URLs that back it. */
export type ApiMeta = {
  auth: AuthStrategy;
  servers: Record<string, string>;
};

export const API_ROUTING: Record<string, ApiMeta> = {
  trading: {
    auth: 'apca',
    servers: {
      live: 'https://api.alpaca.markets',
      paper: 'https://paper-api.alpaca.markets',
    }
  },
  data: {
    auth: 'apca',
    servers: {
      live: 'https://data.alpaca.markets',
      sandbox: 'https://data.sandbox.alpaca.markets',
    }
  },
  broker: {
    auth: 'basic',
    servers: {
      live: 'https://broker-api.alpaca.markets',
      sandbox: 'https://broker-api.sandbox.alpaca.markets',
    },
  },
  authx: {
    auth: 'form',
    servers: {
      live:'https://authx.alpaca.markets/v1',
      sandbox: 'https://authx.sandbox.alpaca.markets/v1',
    },
  },
};
