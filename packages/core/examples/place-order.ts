/**
 * Place, inspect, and cancel an order via the generated Trading client.
 *
 * Credentials come from the environment the mutator reads:
 *   export ALPACA_API_KEY="your_api_key"
 *   export ALPACA_API_SECRET="your_api_secret"
 *   export ALPACA_ENV=paper   # strongly recommended for this example (uses paper keys)
 * Run: bun run examples/place-order.ts
 *
 * ⚠️  LIVE by default: without ALPACA_ENV=paper this submits a REAL order with real money.
 */

import { tradingApi } from '../src/index';

async function main() {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_API_SECRET) {
    console.error('Error: set ALPACA_API_KEY and ALPACA_API_SECRET');
    process.exit(1);
  }
  if ((process.env.ALPACA_ENV ?? '').toLowerCase() !== 'paper') {
    console.warn('⚠️  ALPACA_ENV is not "paper" - this will place a REAL order on your live account.');
  }

  console.log('🚀 Placing a market order for AAPL...');
  const { data: order } = await tradingApi.postOrder({
    symbol: 'AAPL',
    qty: '1',
    side: 'buy',
    type: 'market',
    time_in_force: 'day',
  });
  if (!order) {
    console.error('Order was not placed');
    process.exit(1);
  }
  console.log(`  id=${order.id} symbol=${order.symbol} status=${order.status}`);

  console.log('\n🔍 Fetching order status...');
  const { data: fetched } = await tradingApi.getOrderByOrderID(order.id!);
  if (fetched) {
    console.log(`  status=${fetched.status} filled_qty=${fetched.filled_qty}`);
    if (fetched.status === 'new' || fetched.status === 'accepted' || fetched.status === 'pending_new') {
      console.log('\n❌ Canceling the (unfilled) order...');
      await tradingApi.deleteOrderByOrderID(order.id!);
      console.log('  canceled');
    }
  }

  console.log('\n✅ Done (LIVE unless ALPACA_ENV=paper).');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
