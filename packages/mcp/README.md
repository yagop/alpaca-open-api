<h1 align="center">🦙 @alpaca-open-api/mcp</h1>

<p align="center">A <a href="https://modelcontextprotocol.io/">Model Context Protocol</a> server that exposes the entire <a href="https://alpaca.markets/">Alpaca Markets</a> API to AI agents — every endpoint as an <code>alpaca_&lt;operationId&gt;</code> tool.</p>

<p align="center">
<a href="https://www.npmjs.com/package/@alpaca-open-api/mcp"><img src="https://img.shields.io/npm/v/@alpaca-open-api/mcp?logo=npm&color=CB3837" alt="npm"></a>
<a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-ready-6E56CF" alt="MCP ready"></a>
<img src="https://img.shields.io/badge/tools-269-22C55E" alt="tools">
<a href="https://github.com/yagop/alpaca-open-api/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license: MIT"></a>
</p>

- 🤖 Every Alpaca endpoint as an `alpaca_<operationId>` MCP tool, via one `npx`.
- 🛰️ Trading, Market Data, Broker, AuthX — up to **269 tools**.
- 🔒 Host + auth resolved per API; inputs validated by Zod schemas generated from the OpenAPI specs.

## Install

Run with no install, straight over stdio:

```bash
npx -y @alpaca-open-api/mcp
```

### Add it to your AI agent

**Claude Code**

```bash
claude mcp add alpaca \
  --env ALPACA_API_KEY=your_paper_key \
  --env ALPACA_API_SECRET=your_paper_secret \
  --env ALPACA_ENV=paper \
  -- npx -y @alpaca-open-api/mcp
```

**Claude Desktop / Cursor / any MCP client** — add to your MCP config:

```json
{
  "mcpServers": {
    "alpaca": {
      "command": "npx",
      "args": ["-y", "@alpaca-open-api/mcp"],
      "env": {
        "ALPACA_API_KEY": "your_paper_key",
        "ALPACA_API_SECRET": "your_paper_secret",
        "ALPACA_ENV": "paper"
      }
    }
  }
}
```

## Configuration

| Variable | Required | Default | Purpose |
| --- | :---: | --- | --- |
| `ALPACA_API_KEY` | ✅ | — | API key (live and paper keys are different) |
| `ALPACA_API_SECRET` | ✅ | — | API secret |
| `ALPACA_ENV` | | `live` | `paper` or `live` |
| `ALPACA_TOOLSETS` | | `trading,data` | Comma-separated subset to expose: `trading,data,broker,authx` (all four = ~269 tools) |

> ⚠️ The server **defaults to `live`** and allows order placement in the default `trading` toolset. Use `ALPACA_ENV=paper` with your paper keys while you experiment. Live and paper API keys differ.

## Documentation

Full docs, the typed library client ([`@alpaca-open-api/core`](https://www.npmjs.com/package/@alpaca-open-api/core)), and source:
**https://github.com/yagop/alpaca-open-api**

## Disclaimer

Unofficial and **not affiliated with, endorsed by, or sponsored by Alpaca**. Provided "as is", without warranty of any kind. Nothing here is financial, investment, or trading advice. Trading involves substantial risk of loss — always test with paper trading (`ALPACA_ENV=paper`) first.

## License

[MIT](https://github.com/yagop/alpaca-open-api/blob/main/LICENSE)
