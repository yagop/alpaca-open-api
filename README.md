# alpaca-open-api

A TypeScript monorepo for the [Alpaca Markets](https://alpaca.markets/) API, with types and an MCP tool manifest generated from the official OpenAPI specifications — plus a ready-to-run MCP server.

## Packages

| Package | Description |
| --- | --- |
| [`@alpaca-open-api/core`](packages/core) | TypeScript types, a minimal `AlpacaClient`, and the generated MCP tool `manifest` for all four Alpaca APIs (Trading, Market Data, Broker, AuthX). |
| [`@alpaca-open-api/mcp`](packages/mcp) | A [Model Context Protocol](https://modelcontextprotocol.io/) server exposing the entire Alpaca API to AI agents. Installable as the `alpaca-mcp` CLI. |

## MCP server (`@alpaca-open-api/mcp`)

Run it with no install via `npx`:

```bash
npx @alpaca-open-api/mcp
```

It speaks MCP over stdio. Configure it entirely through environment variables:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ALPACA_API_KEY` | ✅ | — | API key |
| `ALPACA_API_SECRET` | ✅ | — | API secret |
| `ALPACA_ENV` | | `paper` | `paper` or `live`. Selects paper/live (trading) and sandbox/production (broker, authx). |
| `ALPACA_MCP_APIS` | | all four | Comma-separated subset of APIs to expose: `trading,data,broker,authx`. Narrows the ~266-tool surface for clients that struggle with large tool lists. |
| `ALPACA_TRADING_URL` / `ALPACA_DATA_URL` / `ALPACA_BROKER_URL` / `ALPACA_AUTHX_URL` | | per-API defaults | Override the base URL for a specific API. |

> ⚠️ The server allows **all verbs across all APIs** — including live order placement when `ALPACA_ENV=live`. It defaults to `paper`. Keep it on paper unless you intend to trade real funds.

### Register with a client

Claude Code:

```bash
claude mcp add alpaca \
  --env ALPACA_API_KEY=your_key \
  --env ALPACA_API_SECRET=your_secret \
  --env ALPACA_ENV=paper \
  -- npx -y @alpaca-open-api/mcp
```

Or via an `.mcp.json` / client config:

```json
{
  "mcpServers": {
    "alpaca": {
      "command": "npx",
      "args": ["-y", "@alpaca-open-api/mcp"],
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

Every Alpaca operation is registered as its own tool, `alpaca_<operationId>` — **266 tools** across all four APIs. Each tool's input schema is generated straight from the OpenAPI spec, with arguments grouped into `path`, `query`, and `body`:

| Tool | Example arguments |
| --- | --- |
| `alpaca_getAccount` | _(none)_ |
| `alpaca_StockLatestQuoteSingle` | `{ "path": { "symbol": "AAPL" }, "query": { "feed": "iex" } }` |
| `alpaca_postOrder` | `{ "body": { "symbol": "AAPL", "side": "buy", "qty": "1", "type": "market", "time_in_force": "day" } }` |

Host and auth are resolved automatically per API. Set `ALPACA_MCP_APIS` (e.g. `trading,data`) to expose only the APIs you need.

## Library (`@alpaca-open-api/core`)

```typescript
import { AlpacaClient, manifest, type components } from '@alpaca-open-api/core';

const client = new AlpacaClient({ apiKey: 'KEY', apiSecret: 'SECRET', paper: true });

// Type-safe requests using the generated OpenAPI types
type Account = components['schemas']['Account'];
const account: Account = await client.get('/v2/account');

// The generated MCP tool manifest — every operation across all four APIs, each
// with a self-contained JSON Schema input. This is what powers the MCP server.
console.log(manifest.tools.length); // 266
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

### Types and the tool manifest

`bun run generate` derives two artifacts from the four OpenAPI specs (both git-ignored and rebuilt on demand):

1. **Types** — [openapi-typescript](https://github.com/drwpow/openapi-typescript) emits `src/types/*.ts`. Compile-time type safety; erased at runtime.
2. **Tool manifest** — `generate-tools.ts` distils every operation (name, route, owning API, and a fully `$ref`-resolved input JSON Schema) into `src/generated/tools.ts`. Because the types are erased at runtime, the manifest is what lets the MCP server register and invoke every endpoint. It is bundled into the CLI, so the server starts offline.

### Scripts

Root:
- `bun run generate` — regenerate core types + the MCP tool manifest from the OpenAPI specs
- `bun run build` — generate types + manifest, then bundle the MCP CLI
- `bun run mcp` — start the MCP server from source

`@alpaca-open-api/mcp`:
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
