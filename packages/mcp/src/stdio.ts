/**
 * stdio transport runner - the default, single-tenant CLI mode.
 *
 * Connects the composed MCP server (see `./compose.ts`) to the MCP SDK's stdio
 * transport. Credentials come from the process environment (the OS process boundary
 * is the trust boundary); for the multi-tenant, per-request alternative see
 * `./http.ts`. Kept here so `./mcp.ts` stays a thin transport dispatcher.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './compose';

export type StdioServerOptions = {
  /** Toolsets to register (forwarded to {@link buildServer}); default is buildServer's own. */
  toolsets?: string[];
};

/** Connects the composed server to stdio and writes a readiness banner to stderr. */
export async function runStdioServer(opts: StdioServerOptions = {}): Promise<void> {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_API_SECRET) {
    process.stderr.write(
      'Warning: ALPACA_API_KEY / ALPACA_API_SECRET are not set; calls will fail auth. ' +
        'Defaulting to live - set ALPACA_ENV=paper for paper (keys differ between live and paper).\n'
    );
  }
  const { server, count } = buildServer(opts.toolsets);
  await server.connect(new StdioServerTransport());
  const toolsetsNote = opts.toolsets?.length ? ` (toolsets: ${opts.toolsets.join(', ')})` : '';
  process.stderr.write(`alpaca-api MCP server ready - ${count} tools registered${toolsetsNote}.\n`);
}
