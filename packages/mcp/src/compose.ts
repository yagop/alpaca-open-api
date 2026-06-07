/**
 * Composes the four Orval-generated tool surfaces onto one MCP server.
 *
 * For each API, Orval emits a `handlers` module (`<op>Handler` functions that
 * adapt validated args -> the fetch client -> an MCP result) and a
 * `tool-schemas.zod` module (`<Op>Params` / `<Op>QueryParams` / `<Op>Body` Zod
 * input schemas). This walks every handler, pairs it with its Zod input by
 * Orval's naming convention, and registers it via `registerTool` - so argument
 * validation, JSON-Schema advertisement, and dispatch are all generated. No
 * transport is attached; the bin (`mcp.ts`) connects stdio and tests connect an
 * in-memory transport.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import * as tradingHandlers from './generated/trading/handlers';
import * as tradingZod from './generated/trading/tool-schemas.zod';
import * as dataHandlers from './generated/data/handlers';
import * as dataZod from './generated/data/tool-schemas.zod';
import * as brokerHandlers from './generated/broker/handlers';
import * as brokerZod from './generated/broker/tool-schemas.zod';
import * as authxHandlers from './generated/authx/handlers';
import * as authxZod from './generated/authx/tool-schemas.zod';

type Mod = { handlers: Record<string, any>; zod: Record<string, any> };

const APIS: Record<string, Mod> = {
  trading: { handlers: tradingHandlers, zod: tradingZod },
  data: { handlers: dataHandlers, zod: dataZod },
  broker: { handlers: brokerHandlers, zod: brokerZod },
  authx: { handlers: authxHandlers, zod: authxZod },
};

const DEFAULT_TOOLSETS = ['trading', 'data'];

const pascal = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Builds a registered {@link McpServer} (no transport connected). By default,
 * the trading and data toolsets are registered; pass an explicit list to expose
 * a different subset, such as broker/authx.
 */
export function buildServer(enabledToolsets: string[] = DEFAULT_TOOLSETS): { server: McpServer; count: number } {
  const server = new McpServer({ name: 'alpaca-api', version: '0.1.0' }, { capabilities: { tools: {} } });
  const allowed = new Set(enabledToolsets);
  const used = new Set<string>();
  let count = 0;

  for (const [api, mod] of Object.entries(APIS)) {
    if (!allowed.has(api)) continue;

    for (const [exportName, handler] of Object.entries(mod.handlers)) {
      if (typeof handler !== 'function' || !exportName.endsWith('Handler')) continue;
      const op = exportName.slice(0, -'Handler'.length);
      const P = pascal(op);

      // Group the generated Zod exactly as the handler reads it.
      const shape: Record<string, z.ZodTypeAny> = {};
      if (mod.zod[`${P}Params`]) shape.pathParams = mod.zod[`${P}Params`];
      if (mod.zod[`${P}QueryParams`]) shape.queryParams = mod.zod[`${P}QueryParams`];
      if (mod.zod[`${P}Body`]) shape.bodyParams = mod.zod[`${P}Body`];

      // Operations with a body but no generated Zod (form-encoded, e.g. AuthX
      // token issuance) stay callable with a permissive body shape. Generated
      // handlers are `(options?)` for no-input ops (Function.length 1) and
      // `(args, options?)` when they need args (length 2).
      if (handler.length >= 2 && Object.keys(shape).length === 0) {
        shape.bodyParams = z.record(z.string(), z.string());
      }

      let name = `alpaca_${op}`;
      if (used.has(name)) name = `alpaca_${api}_${op}`;
      used.add(name);

      const hasInput = Object.keys(shape).length > 0;
      const invoke = hasInput ? (args: any) => handler(args) : () => handler();
      server.registerTool(
        name,
        { description: `${api} - ${op}`, ...(hasInput ? { inputSchema: shape } : {}) },
        (async (args: any) => {
          // Generated handlers always include `structuredContent`, but our tools
          // declare no outputSchema - strip it so the SDK accepts the result.
          const { structuredContent: _omit, ...result } = await invoke(args);
          return result;
        }) as any
      );
      count++;
    }
  }

  return { server, count };
}
