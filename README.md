# alpaca-api-ts

TypeScript client for the [Alpaca Markets](https://alpaca.markets/) API, with types automatically generated from the official OpenAPI specification.

## Features

- 🚀 Built with [Bun](https://bun.sh/) for fast development
- 📝 TypeScript types generated from official OpenAPI spec
- 🔄 Easy API client with type-safe requests
- 📦 Zero runtime dependencies for the core client
- 🛠️ Dev container support for consistent development environment

## Installation

### Using Bun (recommended)

```bash
bun add alpaca-api-ts
```

### Using npm

```bash
npm install alpaca-api-ts
```

### Using yarn

```bash
yarn add alpaca-api-ts
```

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) runtime (v1.0.0 or higher)
- Alpaca Markets API credentials (get them at [alpaca.markets](https://alpaca.markets/))

### Using Dev Container

This project includes a dev container configuration for a consistent development environment:

1. Open the project in VS Code
2. Install the "Dev Containers" extension
3. Press `F1` and select "Dev Containers: Reopen in Container"
4. The container will build with Debian + Bun pre-installed

### Local Setup

1. Clone the repository:
```bash
git clone https://github.com/yagop/alpaca-api-ts.git
cd alpaca-api-ts
```

2. Install dependencies:
```bash
bun install
```

3. Generate TypeScript types from OpenAPI spec:
```bash
bun run generate
```

This will fetch the latest OpenAPI specifications from Alpaca and generate TypeScript types:
- `src/types/trading-api.ts` - Trading API types
- `src/types/market-data-api.ts` - Market Data API types
- `src/types/broker-api.ts` - Broker API types
- `src/types/authx.ts` - AuthX API types

## Usage

### Basic Example

```typescript
import { AlpacaClient, type AlpacaConfig } from 'alpaca-api-ts';

const config: AlpacaConfig = {
  apiKey: 'YOUR_API_KEY',
  apiSecret: 'YOUR_API_SECRET',
  paper: true, // Use paper trading environment
};

const client = new AlpacaClient(config);

// Get account information
const account = await client.get('/v2/account');
console.log('Account:', account);

// Get positions
const positions = await client.get('/v2/positions');
console.log('Positions:', positions);
```

### Type-Safe Requests

The generated types provide full type safety for all API endpoints:

```typescript
import type { TradingComponents, MarketDataComponents } from 'alpaca-api-ts';

// Use generated types for request/response
type Account = TradingComponents['schemas']['Account'];
type Order = TradingComponents['schemas']['Order'];

// Make type-safe requests
const account: Account = await client.get('/v2/account');
```

You can also use the default `components` export for backward compatibility (maps to Trading API):

```typescript
import type { components } from 'alpaca-api-ts';

type Account = components['schemas']['Account'];
```

## Examples

See the [examples](./examples) directory for complete working examples:

- [`basic-usage.ts`](./examples/basic-usage.ts) - Getting account info and checking positions
- [`place-order.ts`](./examples/place-order.ts) - Placing and managing orders
- [`market-data.ts`](./examples/market-data.ts) - Fetching market data and quotes

To run an example:

```bash
bun run examples/basic-usage.ts
```

## API Reference

### AlpacaClient

The main client class for interacting with the Alpaca API.

#### Constructor

```typescript
new AlpacaClient(config: AlpacaConfig)
```

#### Methods

- `get<T>(path: string): Promise<T>` - Make a GET request
- `post<T>(path: string, body: unknown): Promise<T>` - Make a POST request
- `delete<T>(path: string): Promise<T>` - Make a DELETE request
- `patch<T>(path: string, body: unknown): Promise<T>` - Make a PATCH request

### Configuration

```typescript
interface AlpacaConfig {
  apiKey: string;      // Your Alpaca API key
  apiSecret: string;   // Your Alpaca API secret
  paper?: boolean;     // Use paper trading (default: false)
  baseUrl?: string;    // Custom base URL (optional)
}
```

## Generating Types

The OpenAPI types are generated using [openapi-typescript](https://github.com/drwpow/openapi-typescript). To regenerate types:

```bash
bun run generate
```

This will fetch the latest OpenAPI specifications from Alpaca and generate TypeScript types for all APIs:
- Trading API: `https://docs.alpaca.markets/openapi/trading-api.json`
- Market Data API: `https://docs.alpaca.markets/openapi/market-data-api.json`
- Broker API: `https://docs.alpaca.markets/openapi/broker-api.json`
- AuthX API: `https://docs.alpaca.markets/openapi/authx.yaml`

## Scripts

- `bun run generate` - Generate TypeScript types from all OpenAPI specs
- `bun run build` - Generate types and build the project
- `bun run dev` - Run in development mode with auto-reload

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Resources

- [Alpaca Markets API Documentation](https://docs.alpaca.markets/)
- [Alpaca Markets OpenAPI Specifications](https://docs.alpaca.markets/openapi)
  - [Trading API](https://docs.alpaca.markets/openapi/trading-api.json)
  - [Market Data API](https://docs.alpaca.markets/openapi/market-data-api.json)
  - [Broker API](https://docs.alpaca.markets/openapi/broker-api.json)
  - [AuthX API](https://docs.alpaca.markets/openapi/authx.yaml)
- [Bun Documentation](https://bun.sh/docs)
- [openapi-typescript](https://github.com/drwpow/openapi-typescript)

## Disclaimer

This is an unofficial TypeScript client for Alpaca Markets. Use at your own risk. Always test with paper trading before using real funds.
