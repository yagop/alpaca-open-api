/**
 * Composes the four Orval-generated tool surfaces onto one MCP server.
 *
 * Each API has a generated `register<Api>Tools` function (emitted by
 * `scripts/postgen.ts`) that makes one statically-typed `server.registerTool`
 * call per operation, pairing the concrete `<op>Handler` with its Zod input
 * schemas. This module supplies the {@link RegisterContext} those calls use -
 * tool naming (`alpaca_<op>`, disambiguated to `alpaca_<api>_<op>` on cross-API
 * collisions), description, and `structuredContent` stripping - and invokes each
 * API's function for the enabled toolsets. No transport is attached; the bin
 * (`mcp.ts`) connects stdio and tests connect an in-memory transport.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { RegisterContext } from './registry';
import { registerTradingTools } from './generated/trading/register';
import { registerDataTools } from './generated/data/register';
import { registerBrokerTools } from './generated/broker/register';
import { registerAuthxTools } from './generated/authx/register';

type RegisterTools = (server: McpServer, ctx: RegisterContext) => void;

const REGISTER: Record<string, RegisterTools> = {
  trading: registerTradingTools,
  data: registerDataTools,
  broker: registerBrokerTools,
  authx: registerAuthxTools,
};

const DEFAULT_TOOLSETS = ['trading', 'data'];

/**
 * Builds a registered {@link McpServer} (no transport connected). By default,
 * the trading and data toolsets are registered; pass an explicit list to expose
 * a different subset, such as broker/authx.
 */
export function buildServer(
  enabledToolsets: string[] = DEFAULT_TOOLSETS,
): { server: McpServer; count: number } {
  const server = new McpServer(
    { name: 'alpaca-api', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  const used = new Set<string>();
  let count = 0;

  for (const [api, register] of Object.entries(REGISTER)) {
    if (!enabledToolsets.includes(api)) continue;

    const ctx: RegisterContext = {
      tool: (op) => {
        let name = `alpaca_${op}`;
        if (used.has(name)) name = `alpaca_${api}_${op}`;
        used.add(name);
        count++;
        return name;
      },
      describe: (op) => `${api} - ${op}`,
      // Generated handlers always include `structuredContent`, but our tools
      // declare no outputSchema - strip it so the SDK accepts the result.
      strip: ({ structuredContent: _omit, ...result }) => result,
    };

    register(server, ctx);
  }

  return { server, count };
}
