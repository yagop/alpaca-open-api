/**
 * Functional smoke test for the bundled MCP server.
 *
 * Launches `dist/mcp.js` exactly as an MCP client (or `npx`) would, completes
 * the protocol handshake, and exercises the tools that need no credentials:
 * the server must build its endpoint catalog (live fetch + on-disk cache) and
 * expose the expected tools. Used by CI to validate Node compatibility.
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
const toolNames = tools.map((t) => t.name);

// No-auth tool: searches the freshly built catalog.
const search = await client.callTool({
  name: 'alpaca_search_endpoints',
  arguments: { query: 'latest quote', api: 'data', limit: 1 },
});
const result = JSON.parse(search.content[0].text);

await client.close();

const ok =
  tools.length >= 11 &&
  toolNames.includes('alpaca_call_endpoint') &&
  toolNames.includes('alpaca_place_order') &&
  result.count >= 1;

if (!ok) {
  console.error('Smoke test FAILED', { toolCount: tools.length, searchCount: result?.count });
  process.exit(1);
}
console.log(`Node ${process.version} — MCP server OK: ${tools.length} tools, catalog search returned ${result.count} match`);
