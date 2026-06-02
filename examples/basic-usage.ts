/**
 * Basic Usage Example
 * 
 * This example demonstrates basic usage of the Alpaca API client,
 * including getting account information and checking positions.
 * 
 * To run this example:
 * 1. Set your API credentials as environment variables:
 *    export ALPACA_API_KEY="your_api_key"
 *    export ALPACA_API_SECRET="your_api_secret"
 * 2. Run: bun run examples/basic-usage.ts
 */

import { AlpacaClient, type AlpacaConfig, type components } from '../src/index';

// Use types from the generated OpenAPI specification
type Account = components['schemas']['Account'];
type Position = components['schemas']['Position'];
type Order = components['schemas']['Order'];

async function main() {
  // Check for required environment variables
  const apiKey = process.env.ALPACA_API_KEY;
  const apiSecret = process.env.ALPACA_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.error('Error: ALPACA_API_KEY and ALPACA_API_SECRET environment variables are required');
    console.error('Set them with:');
    console.error('  export ALPACA_API_KEY="your_api_key"');
    console.error('  export ALPACA_API_SECRET="your_api_secret"');
    process.exit(1);
  }

  // Initialize client with paper trading
  const config: AlpacaConfig = {
    apiKey,
    apiSecret,
    paper: true, // Use paper trading environment for safety
  };

  const client = new AlpacaClient(config);

  try {
    // Get account information
    console.log('📊 Fetching account information...\n');
    const account = await client.get<Account>('/v2/account');
    
    console.log('Account Status:', account.status);
    console.log('Account Number:', account.account_number);
    console.log('Cash:', account.cash);
    console.log('Portfolio Value:', account.portfolio_value);
    console.log('Buying Power:', account.buying_power);
    console.log('Pattern Day Trader:', account.pattern_day_trader);
    console.log();

    // Get all positions
    console.log('📈 Fetching current positions...\n');
    const positions = await client.get<Position[]>('/v2/positions');
    
    if (Array.isArray(positions) && positions.length > 0) {
      console.log(`You have ${positions.length} open position(s):\n`);
      
      for (const position of positions) {
        console.log(`Symbol: ${position.symbol}`);
        console.log(`  Quantity: ${position.qty}`);
        console.log(`  Market Value: $${position.market_value}`);
        console.log(`  Current Price: $${position.current_price}`);
        console.log(`  P&L: $${position.unrealized_pl} (${position.unrealized_plpc}%)`);
        console.log();
      }
    } else {
      console.log('No open positions');
    }

    // Get recent orders
    console.log('📋 Fetching recent orders...\n');
    const orders = await client.get<Order[]>('/v2/orders?limit=5&status=all');
    
    if (Array.isArray(orders) && orders.length > 0) {
      console.log(`Last ${orders.length} order(s):\n`);
      
      for (const order of orders) {
        console.log(`Order ID: ${order.id}`);
        console.log(`  Symbol: ${order.symbol}`);
        console.log(`  Side: ${order.side}`);
        console.log(`  Quantity: ${order.qty}`);
        console.log(`  Type: ${order.type}`);
        console.log(`  Status: ${order.status}`);
        console.log(`  Created: ${order.created_at}`);
        console.log();
      }
    } else {
      console.log('No orders found');
    }

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Run the example
main();
