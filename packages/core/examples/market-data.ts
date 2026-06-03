/**
 * Market data — latest trade & quote per symbol via the generated Market Data
 * client. (Market Data is served from one host regardless of paper/live.)
 *
 * Credentials come from the environment the mutator reads:
 *   export ALPACA_API_KEY="your_api_key"
 *   export ALPACA_API_SECRET="your_api_secret"
 * Run: bun run examples/market-data.ts
 *
 * Note: market data access depends on your Alpaca subscription level.
 */

import { dataApi } from '../src/index';

async function main() {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_API_SECRET) {
    console.error('Error: set ALPACA_API_KEY and ALPACA_API_SECRET');
    process.exit(1);
  }

  console.log('📊 Latest trade & quote\n');
  for (const symbol of ['AAPL', 'TSLA', 'MSFT']) {
    try {
      const { data: trade } = await dataApi.stockLatestTradeSingle(symbol);
      const { data: quote } = await dataApi.stockLatestQuoteSingle(symbol);
      console.log(
        `${symbol}: last $${trade?.trade?.p ?? 'N/A'}  ` +
          `bid $${quote?.quote?.bp ?? 'N/A'} / ask $${quote?.quote?.ap ?? 'N/A'}`
      );
    } catch (error) {
      console.log(`${symbol}: not available (${error instanceof Error ? error.message : error})`);
    }
  }

  console.log('\n✅ Market data example completed.');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
