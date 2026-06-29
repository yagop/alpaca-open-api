# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **Bun** TypeScript monorepo for the Alpaca Markets API, generated from the four official OpenAPI specs (Trading, Market Data, Broker, AuthX) with **Orval**. Two published packages:

- `@alpaca-open-api/core` - typed fetch clients + model types (one namespace per API).
- `@alpaca-open-api/mcp` - an MCP (stdio) server exposing every Alpaca operation as a tool; ships as the `alpaca-mcp` CLI (`packages/mcp/src/mcp.ts`).

The toolchain is Bun, not npm/node - use `bun` for everything. Orval itself is run as `bunx --bun orval` because its CLI needs APIs missing from older Node.

## Commands

```bash
bun install                              # install workspace deps
bun run generate                         # Orval -> packages/*/src/generated/ , then postgen.ts
bun run build                            # generate, then build both packages to dist/
bun run mcp                              # run the MCP server from source (packages/mcp/src/mcp.ts)
bun test                                 # all unit tests
bun test packages/mcp/src/compose.test.ts   # a single test file
bun test -t "registers trading and data"    # tests matching a name
bunx tsc -p packages/mcp/tsconfig.json --noEmit   # typecheck (no root lint/typecheck script exists)
```

There is **no lint step** and no root typecheck script; `@alpaca-open-api/core`'s `build` runs `tsc`, `@alpaca-open-api/mcp`'s `build` is a `bun build` bundle only. Typecheck packages individually with `tsc --noEmit` as above.

## Architecture: generated-first

Almost all code is generated. `packages/core/src/generated/` and `packages/mcp/src/generated/` are **git-ignored and rebuilt on demand** - treat them as build artifacts.

- **Never hand-edit anything under `src/generated/`** (the files even say "Do not edit manually"). To change output, change the source: the OpenAPI spec, `orval.config.ts`, or the post-gen step `packages/mcp/scripts/postgen.ts` - then `bun run generate`.
- `orval.config.ts` defines one Orval project per API x two clients: `client: 'mcp'` (-> `packages/mcp/src/generated/<api>/`) and `client: 'fetch'` (-> `packages/core/src/generated/<api>/`). Specs are fetched from remote `docs.alpaca.markets` URLs at generate time. Response Zod is disabled for the MCP client (no `outputSchema`).
- After a fresh clone, `compose.ts` and the core index import from `generated/` that does not exist yet - run `bun run generate` (or `bun run build`) first.

### The HTTP seam (the only hand-written HTTP)

Every call - MCP tools and core clients alike - routes through a tiny mutator that resolves host + auth per API:

- `packages/core/src/api-routing.ts` - `API_ROUTING`: per-API `{ live, paper|sandbox }` base URLs + auth strategy.
- `packages/core/src/mutator.ts` (and `packages/mcp/src/mutator.ts`) - resolves credentials per call via `currentCreds()`, then picks the host (`resolveHost`) and sets `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY` (`authHeaders`). Exported as `tradingMutator`/`dataMutator`/`brokerMutator`/`authxMutator` and `makeMutator`. `mutator.test.ts` covers it.
- `packages/core/src/request-context.ts` - `reqCtx`, an `AsyncLocalStorage<Creds>`. `currentCreds()` reads it when set (remote/http mode), else falls back to `ALPACA_API_KEY`/`ALPACA_API_SECRET`/`ALPACA_ENV` (stdio mode). **No env fallback inside a request** - a credential-less http request is rejected at the transport, never served with the server's keys.

`ALPACA_ENV` defaults to **`live`** (real money/orders). Live and paper API keys differ. See README for the full env table (`ALPACA_API_KEY`, `ALPACA_API_SECRET`, `ALPACA_ENV`, `ALPACA_TOOLSETS`, `ALPACA_TRANSPORT`, per-API `*_URL` overrides).

### Transports: stdio (default) and streamable-http

`packages/mcp/src/mcp.ts` selects the transport from `--transport` / `ALPACA_TRANSPORT` (default `stdio`):

- **stdio** - single-tenant; credentials come from the process env (the OS process boundary is the trust boundary).
- **streamable-http** (`--transport http`) - `packages/mcp/src/http.ts`. Multi-tenant pass-through proxy: a fresh stateless `buildServer` + `StreamableHTTPServerTransport` per request, each handled inside `reqCtx.run(creds, ...)` with `creds` read from the `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY` / `X-Alpaca-Env` headers. Credential-less requests get 401 (no env fallback); auth headers are never logged. `http.test.ts` drives it over real HTTP with raw `fetch` (the SDK client mis-handles the 202 notification under Bun).

## How MCP tools (methods) are registered

This is the central flow of `@alpaca-open-api/mcp`. Tools are **not** registered by hand or by runtime reflection - they are generated as static, typed code:

1. **Orval** (`client: 'mcp'`) emits per API into `packages/mcp/src/generated/<api>/`:
   - `handlers.ts` - `<op>Handler(args, options?)` functions that validate args -> call the fetch client -> return an MCP result. Args are grouped as `{ pathParams?, queryParams?, bodyParams? }`. No-input ops are `(options?)`.
   - `tool-schemas.zod.ts` - the Zod input schemas `<Op>Params` / `<Op>QueryParams` / `<Op>Body` (plus some `<...>Default` constants).
   - `http-client.ts` - the fetch client (calls the mutator).

2. **postgen** (`packages/mcp/scripts/postgen.ts`, runs right after Orval) does three fix-ups per API:
   - injects the `<api>Mutator` import into `http-client.ts`;
   - deletes the standalone generated `server.ts` (we compose onto one server instead);
   - **generates `generated/<api>/register.ts`**: a statically-typed `register<Api>Tools(server, ctx)` with one `server.registerTool(...)` call per operation, referencing the concrete `handlers.<op>Handler` + `schemas.<Op>...` by name. This is the registration list - regenerated every build, so it always matches the specs.

3. **`packages/mcp/src/compose.ts`** - `buildServer(enabledToolsets)` creates one `McpServer` and, for each enabled toolset, calls the generated `register<Api>Tools(server, ctx)`. It supplies a `RegisterContext` (`packages/mcp/src/registry.ts`) carrying the cross-cutting, non-type-bearing concerns:
   - `tool(op)` -> tool name `alpaca_<op>`, disambiguated to `alpaca_<api>_<op>` on cross-API collisions; also counts tools.
   - `describe(op)` -> the tool description.
   - `strip(result)` -> removes `structuredContent` (our tools declare no `outputSchema`).

4. **`packages/mcp/src/mcp.ts`** (the bin) - reads env (`ALPACA_TOOLSETS`, default `trading,data`), calls `buildServer`, and connects `StdioServerTransport`.

So to add/rename/change a tool: change the OpenAPI spec or `orval.config.ts` and `bun run generate` - never edit a generated `register.ts`/`handlers.ts`. The default toolset (`trading,data`) is ~114 tools; all four (`trading,data,broker,authx`) is ~269. `compose.test.ts` pins those counts, the `alpaca_*` naming, argument ordering, and Zod rejection - keep it green when touching the pipeline.

### Design note: why generated static registration

The registration intentionally avoids reflecting over module exports (which erases each handler's per-op types and forces `any`/casts). Generating one concrete `server.registerTool` call per op keeps every registration type-checked. The only cast in the whole generated surface is a single documented `as unknown as` for `issueTokens` (form-encoded body with no generated Zod). `compose.ts` and `registry.ts` are hand-written and must stay free of `any`/casts.

## @orval/mcp argument order (fixed upstream)

`@orval/mcp` once emitted MCP handler query/body arguments in the wrong **order** and typed optional request bodies as required. We carried orval PR #3600 as a local patch against `@orval/mcp@8.17.0`; that fix shipped in **orval 8.18.0**, so the patch and its `patchedDependencies` entry are gone and we depend on `orval@^8.18.0` directly.

Because the fix is upstream, `postgen.ts` does **not** swap argument order - do not reintroduce that swap.
