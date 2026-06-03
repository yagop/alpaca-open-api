/**
 * Functional smoke test for the bundled MCP server.
 *
 * Launches `dist/mcp.js` exactly as an MCP client (or `npx`) would, completes
 * the protocol handshake, and asserts the server registers the full endpoint
 * surface from the committed manifest. Needs no credentials and no network -
 * the manifest is shipped in the bundle. Used by CI to validate Node compat.
 *
 * Run: `node packages/mcp/scripts/smoke.mjs` (from anywhere).
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '../dist/mcp.js');

const transport = new StdioClientTransport({
  command: process.execPath, // the current Node binary
  args: [serverPath],
  env: { ...process.env, ALPACA_ENV: 'paper' },
  stderr: 'inherit',
});

const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);

const { tools } = await client.listTools();
const names = new Set(tools.map((t) => t.name));

await client.close();

// Representative tools spanning Trading (no-arg / body) and Market Data (path+query).
const expected = ['alpaca_getAccount', 'alpaca_postOrder', 'alpaca_stockLatestQuoteSingle'];
const missing = expected.filter((n) => !names.has(n));

// A registered tool must advertise a valid object input schema.
const account = tools.find((t) => t.name === 'alpaca_getAccount');
const schemaOk = account?.inputSchema?.type === 'object';

const ok = tools.length >= 100 && missing.length === 0 && schemaOk;

if (!ok) {
  console.error('Smoke test FAILED', { toolCount: tools.length, missing, schemaOk });
  process.exit(1);
}
console.log(`Node ${process.version} - MCP server OK: ${tools.length} tools registered`);
