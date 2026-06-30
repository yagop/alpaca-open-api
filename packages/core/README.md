<h1 align="center">🦙 @alpaca-open-api/core</h1>

<p align="center">Typed TypeScript fetch clients + model types for the <a href="https://alpaca.markets/">Alpaca Markets</a> API (Trading, Market Data, Broker, AuthX), generated from the official OpenAPI specs with <a href="https://orval.dev/">Orval</a>.</p>

<p align="center">
<a href="https://www.npmjs.com/package/@alpaca-open-api/core"><img src="https://img.shields.io/npm/v/@alpaca-open-api/core?logo=npm&color=CB3837" alt="npm"></a>
<a href="https://github.com/yagop/alpaca-open-api/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license: MIT"></a>
</p>

- ⚡ Fully typed request/response types straight from the specs.
- 🛰️ One namespace per API: `tradingApi`, `dataApi`, `brokerApi`, `authxApi`.
- 🔒 Every call routes through one small shared mutator that resolves host + auth per API.
- 📡 Real-time WebSocket streaming: trade updates, plus stock/crypto/option/news market data.

## Install

```bash
npm install @alpaca-open-api/core
```

## Usage

Credentials and environment come from env vars (`ALPACA_API_KEY`, `ALPACA_API_SECRET`, `ALPACA_ENV`; **live by default**), read by the shared mutator.

```ts
import { tradingApi, dataApi, tradingModel } from '@alpaca-open-api/core';

// Each call returns { data, status, headers }; `data` is typed from the spec.
const { data: account } = await tradingApi.getAccount();
console.log(account?.cash);

const { data: quote } = await dataApi.stockLatestQuoteSingle('AAPL', { feed: 'iex' });
console.log(quote?.quote?.ap);

// Place an order (uses the live account unless ALPACA_ENV=paper):
await tradingApi.postOrder({ symbol: 'AAPL', side: 'buy', qty: '1', type: 'market', time_in_force: 'day' });

// Schema types are exported per API as `*Model` namespaces:
type Account = tradingModel.Account;
```

Client namespaces: `tradingApi`, `dataApi`, `brokerApi`, `authxApi`; matching model (schema) types: `tradingModel`, `dataModel`, `brokerModel`, `authxModel`. `makeMutator` and `API_ROUTING` are also exported if you need to customize routing.

## Streaming

Real-time data over WebSocket - hand-written (streaming isn't part of the OpenAPI specs), living alongside the generated REST clients. Same credentials as above (`ALPACA_API_KEY`/`ALPACA_API_SECRET`, `ALPACA_ENV`):

```ts
import { TradingStreamClient, stockDataStream } from '@alpaca-open-api/core';

// Order lifecycle events for your account.
const trading = new TradingStreamClient();
trading.connect();
for await (const event of trading) {
  if (event.type === 'trade_update') console.log(event.update.event, event.update.order.symbol, event.update.price);
}

// Real-time stock trades/quotes/bars (feed defaults to 'iex').
const stocks = stockDataStream();
stocks.subscribe({ trades: ['AAPL'], quotes: ['AAPL'] }); // sent once authenticated; re-sent after any reconnect
stocks.connect();
for await (const event of stocks) {
  if (event.type === 'message' && event.message.T === 't') console.log('trade', event.message.S, event.message.p);
}
```

`cryptoDataStream()`, `optionDataStream()`, `newsDataStream()` are the same shape for the other feeds. Every client is a plain `AsyncIterable` over a typed `{type: ...}` event union (`open`, `authenticated`, `message`/`trade_update`, `error`, `reconnecting`, plus `subscription` for market data) - no `EventEmitter`, so there's no listener to forget to attach; an event you don't care about is just a `case` you don't switch on. Connections auto-reconnect with backoff and re-subscribe automatically; call `.close()` to stop for good, which ends the loop (`done: true`).

**Design decisions:** the native global `WebSocket` (Bun + Node ≥22 - no dependency, hence this package's `engines.node: >=22`); the trading stream's frames are JSON inside *binary-opcode* WebSocket frames by default (confirmed against the real API) - Alpaca's optional MessagePack codec needs a `Content-Type` request header the standard `WebSocket` API can't set, so it's unreachable here unless you supply your own `decode`; a small hand-rolled MessagePack **decoder** (`./streaming/msgpack`, decode-only, no dependency) is still available for that case; the consumer API is `AsyncIterable` only, deliberately not `EventEmitter` - Node's `EventEmitter` throws (crashing the process) on an unhandled `'error'` event, which is exactly the kind of mistake a streaming client shouldn't be able to turn into a crash.

## Configuration

| Variable | Required | Default | Purpose |
| --- | :---: | --- | --- |
| `ALPACA_API_KEY` | ✅ | — | API key (live and paper keys are different) |
| `ALPACA_API_SECRET` | ✅ | — | API secret |
| `ALPACA_ENV` | | `live` | `paper` or `live`. Selects paper/live (trading) and sandbox/production (broker, authx). |

> ⚠️ Defaults to **`live`** (real money/orders). Set `ALPACA_ENV=paper` (with your paper keys) to test safely.

## Documentation

Full docs, the MCP server ([`@alpaca-open-api/mcp`](https://www.npmjs.com/package/@alpaca-open-api/mcp)), and source:
**https://github.com/yagop/alpaca-open-api**

## Disclaimer

Unofficial and **not affiliated with, endorsed by, or sponsored by Alpaca**. Provided "as is", without warranty of any kind. Nothing here is financial, investment, or trading advice. Trading involves substantial risk of loss — always test with paper trading (`ALPACA_ENV=paper`) first.

## License

[MIT](https://github.com/yagop/alpaca-open-api/blob/main/LICENSE)
