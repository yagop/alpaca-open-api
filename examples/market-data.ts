/**
 * Market Data Example
 * 
 * This example demonstrates how to fetch market data using the Alpaca API,
 * including stock quotes, bars (OHLCV data), and the market clock.
 * 
 * To run this example:
 * 1. Set your API credentials as environment variables:
 *    export ALPACA_API_KEY="your_api_key"
 *    export ALPACA_API_SECRET="your_api_secret"
 * 2. Run: bun run examples/market-data.ts
 * 
 * Note: Market data access depends on your Alpaca subscription level.
 */

import {
  AlpacaClient,
  type AlpacaConfig,
  type TradingComponents,
  type MarketDataComponents,
} from '../src/index';

// Asset is a Trading API resource; the market-data resources come from the
// Market Data API schema.
type Asset = TradingComponents['schemas']['Assets'];

// NOTE: Alpaca's published OpenAPI spec models `/v2/clock` as a multi-market
// `clock_resp` object, but the live REST endpoint returns this flat shape.
// This is a known spec-vs-response mismatch, so the type is declared locally.
type Clock = {
  timestamp: string;
  is_open: boolean;
  next_open: string;
  next_close: string;
};
type LatestTrade = MarketDataComponents['schemas']['stock_latest_trades_resp_single'];
type LatestQuote = MarketDataComponents['schemas']['stock_latest_quotes_resp_single'];
type Bars = MarketDataComponents['schemas']['stock_bars_resp_single'];
type Snapshot = MarketDataComponents['schemas']['stock_snapshot'];

async function main() {
  // Check for required environment variables
  const apiKey = process.env.ALPACA_API_KEY;
  const apiSecret = process.env.ALPACA_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.error('Error: ALPACA_API_KEY and ALPACA_API_SECRET environment variables are required');
    process.exit(1);
  }

  // Initialize client
  const config: AlpacaConfig = {
    apiKey,
    apiSecret,
    paper: true,
  };

  const client = new AlpacaClient(config);

  try {
    console.log('📊 Alpaca Market Data Example\n');

    // Example 1: Get market clock
    console.log('🕐 Example 1: Checking market clock...\n');
    
    try {
      const clock = await client.get<Clock>('/v2/clock');
      console.log('Market Clock:');
      console.log(`  Current Time: ${clock.timestamp}`);
      console.log(`  Market Open: ${clock.is_open ? 'Yes' : 'No'}`);
      console.log(`  Next Open: ${clock.next_open}`);
      console.log(`  Next Close: ${clock.next_close}`);
      console.log();
    } catch (error) {
      console.log('Market clock: not available (Trading API credentials required)');
      console.log();
    }

    // Example 2: Get latest trade for a symbol
    console.log('📈 Example 2: Getting latest trade for AAPL...\n');
    
    const symbols = ['AAPL', 'TSLA', 'MSFT'];
    
    for (const symbol of symbols) {
      try {
        const trades = await client.getData<LatestTrade>(`/v2/stocks/${symbol}/trades/latest`);
        console.log(`${symbol}:`);
        console.log(`  Price: $${trades.trade?.p || 'N/A'}`);
        console.log(`  Size: ${trades.trade?.s || 'N/A'}`);
        console.log(`  Time: ${trades.trade?.t || 'N/A'}`);
        console.log();
      } catch (error) {
        console.log(`${symbol}: Data not available`);
        console.log();
      }
    }

    // Example 3: Get latest quote
    console.log('💹 Example 3: Getting latest quotes...\n');
    
    for (const symbol of symbols) {
      try {
        const quote = await client.getData<LatestQuote>(`/v2/stocks/${symbol}/quotes/latest`);
        console.log(`${symbol} Quote:`);
        console.log(`  Bid: $${quote.quote?.bp || 'N/A'} x ${quote.quote?.bs || 'N/A'}`);
        console.log(`  Ask: $${quote.quote?.ap || 'N/A'} x ${quote.quote?.as || 'N/A'}`);
        console.log(`  Spread: $${quote.quote?.ap && quote.quote?.bp ? (quote.quote.ap - quote.quote.bp).toFixed(2) : 'N/A'}`);
        console.log();
      } catch (error) {
        console.log(`${symbol}: Quote not available`);
        console.log();
      }
    }

    // Example 4: Get historical bars (OHLCV data)
    console.log('📊 Example 4: Getting historical bars for AAPL...\n');
    
    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7); // Last 7 days

      const bars = await client.getData<Bars>(
        `/v2/stocks/AAPL/bars?start=${startDate.toISOString()}&end=${endDate.toISOString()}&timeframe=1Day`
      );

      console.log('AAPL Daily Bars (Last 7 days):');
      if (bars.bars && Array.isArray(bars.bars)) {
        for (const bar of bars.bars.slice(0, 5)) {
          console.log(`  Date: ${bar.t}`);
          console.log(`    Open: $${bar.o}`);
          console.log(`    High: $${bar.h}`);
          console.log(`    Low: $${bar.l}`);
          console.log(`    Close: $${bar.c}`);
          console.log(`    Volume: ${bar.v}`);
          console.log();
        }
      }
    } catch (error) {
      console.log('Historical bars: Data not available with current subscription');
      console.log();
    }

    // Example 5: Get snapshot (latest data for multiple symbols)
    console.log('📸 Example 5: Getting snapshots for multiple symbols...\n');
    
    try {
      const snapshots = await client.getData<Record<string, Snapshot>>(`/v2/stocks/snapshots?symbols=${symbols.join(',')}`);
      
      for (const symbol of symbols) {
        if (snapshots[symbol]) {
          const snap = snapshots[symbol];
          console.log(`${symbol} Snapshot:`);
          console.log(`  Latest Trade: $${snap.latestTrade?.p || 'N/A'}`);
          console.log(`  Latest Quote: $${snap.latestQuote?.bp || 'N/A'} / $${snap.latestQuote?.ap || 'N/A'}`);
          console.log(`  Previous Close: $${snap.prevDailyBar?.c || 'N/A'}`);
          console.log();
        }
      }
    } catch (error) {
      console.log('Snapshots: Data not available with current subscription');
      console.log();
    }

    // Example 6: Get asset information
    console.log('ℹ️  Example 6: Getting asset information...\n');
    
    for (const symbol of symbols) {
      try {
        const asset = await client.get<Asset>(`/v2/assets/${symbol}`);
        console.log(`${symbol} Asset Info:`);
        console.log(`  Class: ${asset.class}`);
        console.log(`  Exchange: ${asset.exchange}`);
        console.log(`  Tradable: ${asset.tradable ? 'Yes' : 'No'}`);
        console.log(`  Marginable: ${asset.marginable ? 'Yes' : 'No'}`);
        console.log(`  Shortable: ${asset.shortable ? 'Yes' : 'No'}`);
        console.log();
      } catch (error) {
        console.log(`${symbol}: Asset info not available`);
        console.log();
      }
    }

    console.log('✅ Market data examples completed!');
    console.log('\n💡 Note: Some market data features require specific Alpaca subscription levels.');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Run the example
main();
