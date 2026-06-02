# open-alpaca-api

A TypeScript monorepo for the [Alpaca Markets](https://alpaca.markets/) API, with types and a runtime endpoint catalog generated from the official OpenAPI specifications — plus a ready-to-run MCP server.

## Packages

| Package | Description |
| --- | --- |
| [`@open-alpaca-api/core`](packages/core) | TypeScript types, a minimal `AlpacaClient`, and the generated endpoint `catalog` for all four Alpaca APIs (Trading, Market Data, Broker, AuthX). |
| [`@open-alpaca-api/mcp`](packages/mcp) | A [Model Context Protocol](https://modelcontextprotocol.io/) server exposing the entire Alpaca API to AI agents. Installable as the `alpaca-mcp` CLI. |

## MCP server (`@open-alpaca-api/mcp`)

Run it with no install via `npx`:

```bash
npx @open-alpaca-api/mcp
```

It speaks MCP over stdio. Configure it entirely through environment variables:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ALPACA_API_KEY` | ✅ | — | API key |
| `ALPACA_API_SECRET` | ✅ | — | API secret |
| `ALPACA_ENV` | | `paper` | `paper` or `live`. Selects paper/live (trading) and sandbox/production (broker, authx). |
| `ALPACA_TRADING_URL` / `ALPACA_DATA_URL` / `ALPACA_BROKER_URL` / `ALPACA_AUTHX_URL` | | per-API defaults | Override the base URL for a specific API. |

> ⚠️ The server allows **all verbs across all APIs** — including live order placement when `ALPACA_ENV=live`. It defaults to `paper`. Keep it on paper unless you intend to trade real funds.

### Register with a client

Claude Code:

```bash
claude mcp add alpaca \
  --env ALPACA_API_KEY=your_key \
  --env ALPACA_API_SECRET=your_secret \
  --env ALPACA_ENV=paper \
  -- npx -y @open-alpaca-api/mcp
```

Or via an `.mcp.json` / client config:

```json
{
  "mcpServers": {
    "alpaca": {
      "command": "npx",
      "args": ["-y", "@open-alpaca-api/mcp"],
      "env": {
        "ALPACA_API_KEY": "your_key",
        "ALPACA_API_SECRET": "your_secret",
        "ALPACA_ENV": "paper"
      }
    }
  }
}
```

### Tools

The server uses a **hybrid** design:

- **Curated tools** for the common path, with explicit arguments:
  `alpaca_get_account`, `alpaca_list_positions`, `alpaca_list_orders`, `alpaca_place_order`, `alpaca_cancel_order`, `alpaca_get_clock`, `alpaca_latest_quote`, `alpaca_get_bars`.
- **Gateway tools** that reach *every* catalogued operation (266 across all four APIs):
  - `alpaca_search_endpoints(query, api?, limit?)` — find operations by keyword.
  - `alpaca_describe_endpoint(operationId)` — inspect parameters and request body.
  - `alpaca_call_endpoint(operationId, pathParams?, query?, body?)` — invoke any operation. Host and auth are resolved automatically per API.

## Library (`@open-alpaca-api/core`)

```typescript
import { AlpacaClient, loadCatalog, type components } from '@open-alpaca-api/core';

const client = new AlpacaClient({ apiKey: 'KEY', apiSecret: 'SECRET', paper: true });

// Type-safe requests using the generated OpenAPI types
type Account = components['schemas']['Account'];
const account: Account = await client.get('/v2/account');

// Build the runtime catalog of every operation across all four APIs (fetched
// from the live specs once, then cached on disk and reused).
const catalog = await loadCatalog();
console.log(catalog.count); // 266
```

The client exposes `get` / `post` / `patch` / `delete` (Trading API) and `getData` (Market Data API). Type namespaces are exported per API: `TradingComponents`, `MarketDataComponents`, `BrokerComponents`, `AuthXComponents` (with `components`/`paths` aliased to Trading for convenience).

## Development

### Prerequisites

- [Bun](https://bun.sh/) (v1.0+). A dev container with Bun pre-installed is included (`.devcontainer`).
- Alpaca Markets API credentials ([alpaca.markets](https://alpaca.markets/)).

### Setup

```bash
bun install          # install all workspace dependencies
bun run generate     # fetch the OpenAPI specs -> generate core types
bun run build        # generate types + bundle the MCP CLI to packages/mcp/dist/mcp.js
```

Run the MCP server from source during development:

```bash
bun run mcp          # = bun run src/mcp.ts in packages/mcp
```

### Types vs. the runtime catalog

Two things are derived from the four OpenAPI specs, in two different ways:

1. **Types** (build time) — `bun run generate` runs [openapi-typescript](https://github.com/drwpow/openapi-typescript) into `src/types/*.ts` (git-ignored). These give compile-time type safety and are erased at runtime.
2. **Catalog** (run time) — `loadCatalog()` fetches the live specs and distills each operation (method, path, params, body shape, owning API) into a queryable index. Because types are erased at runtime, the catalog is what lets the MCP server discover and invoke endpoints dynamically. Since the Alpaca API surface doesn't change, it's built once and cached in the OS temp dir, then reused indefinitely (delete the cache file to rebuild).

### Scripts

Root:
- `bun run generate` — regenerate core types from the OpenAPI specs
- `bun run build` — generate types, then bundle the MCP CLI
- `bun run mcp` — start the MCP server from source

`@open-alpaca-api/mcp`:
- `bun run build` — bundle `src/mcp.ts` → `dist/mcp.js` (shebang + `node` target; SDK and zod external)
- `bun run start` / `bun run dev` — run the server (with `--watch` for `dev`)

## Examples

See [`packages/core/examples`](packages/core/examples):

- [`basic-usage.ts`](packages/core/examples/basic-usage.ts) — account info and positions
- [`place-order.ts`](packages/core/examples/place-order.ts) — placing and managing orders
- [`market-data.ts`](packages/core/examples/market-data.ts) — quotes, bars, snapshots

```bash
bun run packages/core/examples/basic-usage.ts
```

## Resources

- [Alpaca Markets API Documentation](https://docs.alpaca.markets/)
- [Alpaca OpenAPI Specifications](https://docs.alpaca.markets/openapi)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Bun Documentation](https://bun.sh/docs)

## Disclaimer

This is an unofficial TypeScript client for Alpaca Markets. Use at your own risk. Always test with paper trading before using real funds.

## License

MIT License — see [LICENSE](LICENSE) for details.
