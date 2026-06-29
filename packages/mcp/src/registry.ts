/**
 * Shared types for the generated `register<Api>Tools` functions (one per API,
 * emitted by `scripts/postgen.ts`) and their consumer in `compose.ts`.
 *
 * Each generated function makes one statically-typed `server.registerTool` call
 * per operation, passing the concrete `<op>Handler` and its Zod input schemas by
 * value - so every registration is type-checked, with no reflection over module
 * exports and no casts. The cross-cutting, non-type-bearing concerns (tool naming,
 * description, `structuredContent` stripping) come from {@link RegisterContext},
 * which `compose.ts` supplies.
 */
export type HandlerResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: unknown;
};

export type RegisterContext = {
  /** Returns the (collision-disambiguated) tool name for an operation. */
  tool: (op: string) => string;
  /** Returns the tool description for an operation. */
  describe: (op: string) => string;
  /**
   * Drops `structuredContent` so the SDK accepts the result (no outputSchema),
   * and wraps untrusted free-text tool output (keyed by `op`) in a trust-boundary
   * envelope - see `compose.ts`.
   */
  strip: (
    op: string,
    result: HandlerResult,
  ) => Omit<HandlerResult, 'structuredContent'>;
};
