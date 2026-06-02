/**
 * Place Order Example
 * 
 * This example demonstrates how to place and manage orders using the Alpaca API.
 * It includes examples of market orders, limit orders, and order cancellation.
 * 
 * To run this example:
 * 1. Set your API credentials as environment variables:
 *    export ALPACA_API_KEY="your_api_key"
 *    export ALPACA_API_SECRET="your_api_secret"
 * 2. Run: bun run examples/place-order.ts
 * 
 * ⚠️  This example uses paper trading by default. Always test with paper trading first!
 */

import { AlpacaClient, type AlpacaConfig, type components, type TradingOperations } from '../src/index';

// Use types from the generated OpenAPI specification
type Order = components['schemas']['Order'];
// The order-creation payload is defined inline on the `postOrder` operation
// rather than as a named schema.
type OrderRequest = TradingOperations['postOrder']['requestBody']['content']['application/json'];

async function main() {
  // Check for required environment variables
  const apiKey = process.env.ALPACA_API_KEY;
  const apiSecret = process.env.ALPACA_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.error('Error: ALPACA_API_KEY and ALPACA_API_SECRET environment variables are required');
    process.exit(1);
  }

  // Initialize client with paper trading
  const config: AlpacaConfig = {
    apiKey,
    apiSecret,
    paper: true, // IMPORTANT: Use paper trading for safety
  };

  const client = new AlpacaClient(config);

  try {
    console.log('🚀 Alpaca Trading Example (Paper Trading)\n');

    // Example 1: Place a market order
    console.log('📈 Example 1: Placing a market order for AAPL...\n');
    
    const marketOrder: OrderRequest = {
      symbol: 'AAPL',
      qty: '1',
      side: 'buy',
      type: 'market',
      time_in_force: 'day',
    };

    const placedMarketOrder = await client.post<Order>('/v2/orders', marketOrder);
    console.log('Market order placed:');
    console.log(`  Order ID: ${placedMarketOrder.id}`);
    console.log(`  Symbol: ${placedMarketOrder.symbol}`);
    console.log(`  Status: ${placedMarketOrder.status}`);
    console.log();

    // Example 2: Place a limit order
    console.log('📊 Example 2: Placing a limit order for TSLA...\n');
    
    const limitOrder: OrderRequest = {
      symbol: 'TSLA',
      qty: '1',
      side: 'buy',
      type: 'limit',
      time_in_force: 'day',
      limit_price: '200', // Set your desired limit price
    };

    const placedLimitOrder = await client.post<Order>('/v2/orders', limitOrder);
    console.log('Limit order placed:');
    console.log(`  Order ID: ${placedLimitOrder.id}`);
    console.log(`  Symbol: ${placedLimitOrder.symbol}`);
    console.log(`  Limit Price: $${placedLimitOrder.limit_price}`);
    console.log(`  Status: ${placedLimitOrder.status}`);
    console.log();

    // Example 3: Get order status
    console.log('🔍 Example 3: Checking order status...\n');
    
    const orderStatus = await client.get<Order>(`/v2/orders/${placedMarketOrder.id}`);
    console.log('Order status:');
    console.log(`  Order ID: ${orderStatus.id}`);
    console.log(`  Status: ${orderStatus.status}`);
    console.log(`  Filled Quantity: ${orderStatus.filled_qty}`);
    console.log();

    // Example 4: Get all open orders
    console.log('📋 Example 4: Fetching all open orders...\n');
    
    const openOrders = await client.get<Order[]>('/v2/orders?status=open');
    console.log(`Open orders: ${openOrders.length}`);
    
    for (const order of openOrders) {
      console.log(`  - ${order.symbol}: ${order.side} ${order.qty} @ ${order.type}`);
    }
    console.log();

    // Example 5: Cancel the limit order (since it's just an example)
    console.log('❌ Example 5: Canceling the limit order...\n');
    
    if (placedLimitOrder.status === 'accepted' || placedLimitOrder.status === 'pending_new') {
      await client.delete(`/v2/orders/${placedLimitOrder.id}`);
      console.log('Limit order canceled successfully');
    } else {
      console.log('Order already filled or canceled');
    }
    console.log();

    // Example 6: Place a bracket order (advanced)
    console.log('🎯 Example 6: Placing a bracket order with take-profit and stop-loss...\n');

    // Derive bracket prices from SPY's current price so the example works
    // regardless of where the market is trading. Alpaca requires the
    // take-profit limit to be above, and the stop below, the entry price.
    const spyTrade = await client.getData<{ trade?: { p?: number } }>('/v2/stocks/SPY/trades/latest');
    const spyPrice = spyTrade.trade?.p ?? 0;
    const takeProfitPrice = (spyPrice * 1.05).toFixed(2); // +5%
    const stopLossPrice = (spyPrice * 0.95).toFixed(2); // -5%

    const bracketOrder: OrderRequest = {
      symbol: 'SPY',
      qty: '1',
      side: 'buy',
      type: 'market',
      time_in_force: 'day',
      order_class: 'bracket',
      take_profit: {
        limit_price: takeProfitPrice, // Take profit ~5% above current price
      },
      stop_loss: {
        stop_price: stopLossPrice, // Stop loss ~5% below current price
      },
    };

    const placedBracketOrder = await client.post<Order>('/v2/orders', bracketOrder);
    console.log('Bracket order placed:');
    console.log(`  Order ID: ${placedBracketOrder.id}`);
    console.log(`  Symbol: ${placedBracketOrder.symbol}`);
    console.log(`  Status: ${placedBracketOrder.status}`);
    console.log(`  Take Profit: $${bracketOrder.take_profit?.limit_price}`);
    console.log(`  Stop Loss: $${bracketOrder.stop_loss?.stop_price}`);
    console.log();

    console.log('✅ All examples completed successfully!');
    console.log('\n⚠️  Remember: This was paper trading. Review your orders in the Alpaca dashboard.');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Run the example
main();
