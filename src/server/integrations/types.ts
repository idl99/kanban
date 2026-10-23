/**
 * Shapes shared by the board's own passes (passes.ts), the sign-in (oauth.ts) and the automations that use them
 * (loops.ts). Nothing here knows a service: every service is reached the same way.
 */

/** What the pass code gets to call a service: the clock and fetch are injected so tests need no network. */
export interface Deps {
  fetch: typeof fetch;
  now: () => Date;
}

export interface Tokens {
  access: string;
  refresh?: string;
  /** ISO time the access token stops working; missing: it doesn't expire. */
  expiresAt?: string;
}

/** The service refused our credentials: the pass needs to be connected again. */
export class AuthError extends Error {}

/** The service is rate limiting us: wait this long before the next call. */
export class RateLimitError extends Error {
  constructor(message: string, public retryAfterMs: number) {
    super(message);
  }
}

/** A tool server the board talks to: an online MCP server (McpClient) or a program on this computer (StdioMcpClient). */
export interface ToolClient {
  listTools(): Promise<{ name: string; description?: string; inputSchema?: unknown }[]>;
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
