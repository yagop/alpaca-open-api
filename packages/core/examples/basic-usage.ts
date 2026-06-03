/**
 * Basic usage — read account, positions, and recent orders via the generated
 * Trading client.
 *
 * Credentials come from the environment the mutator reads. Live by default —
 * use your live API keys (paper keys are different):
 *   export ALPACA_API_KEY="your_api_key"
 *   export ALPACA_API_SECRET="your_api_secret"
 *   # export ALPACA_ENV=paper   # use the paper account instead (with paper keys)
 * Run: bun run examples/basic-usage.ts
 */

import { tradingApi } from '../src/index';

async function main() {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_API_SECRET) {
    console.error('Error: set ALPACA_API_KEY and ALPACA_API_SECRET');
    process.exit(1);
  }

  console.log('📊 Account');
  const { data: account } = await tradingApi.getAccount();
  if (account) {
    console.log(`  status=${account.status} cash=${account.cash} buying_power=${account.buying_power}`);
  }

  const { data: positions } = await tradingApi.getAllOpenPositions();
  console.log(`\n📈 Open positions: ${positions?.length ?? 0}`);
  for (const p of positions ?? []) {
    console.log(`  ${p.symbol}: ${p.qty} @ $${p.current_price} — P&L $${p.unrealized_pl}`);
  }

  const { data: orders } = await tradingApi.getAllOrders();
  console.log(`\n📋 Recent orders: ${orders?.length ?? 0}`);
  for (const o of (orders ?? []).slice(0, 5)) {
    console.log(`  ${o.symbol} ${o.side} ${o.qty} ${o.type} — ${o.status}`);
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
