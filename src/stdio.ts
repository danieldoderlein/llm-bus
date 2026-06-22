import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./mcp.js";
import { authenticate } from "./auth.js";
import type { Ctx } from "./context.js";

// stdio MCP entrypoint. Most clients use the Streamable-HTTP server (src/server.ts), but some MCP
// hosts and directory build-tests (e.g. Glama's mcp-proxy) spawn a child and speak MCP over
// stdin/stdout. This exposes the same tool surface over stdio so those harnesses can connect and
// introspect. JSON-RPC goes on stdout; all logging goes on stderr so it never corrupts the stream.
//
// With LLM_BUS_TOKEN set, the stdio session acts as that identity (full tool calls). Without it, the
// server still starts and lists its tools (introspection); tool CALLS then error for lack of an
// identity. A placeholder DATABASE_URL lets config load for the introspection path - it is never
// connected unless a real tool call runs.
process.env.DATABASE_URL ??= "postgres://stdio-introspection@127.0.0.1:5432/llm_bus";

const INTROSPECTION_CTX: Ctx = {
  project: { id: 0, slug: "stdio", name: "stdio", livenessWindowSec: 60, ownerId: 0 },
  participant: { id: 0, name: "stdio", kind: "agent", ownerId: 0, handle: null },
  participation: { id: 0, isAdmin: false, lane: null },
  owner: { id: 0, email: "" },
  actor: "stdio",
};

async function main(): Promise<void> {
  let ctx: Ctx = INTROSPECTION_CTX;
  const token = process.env.LLM_BUS_TOKEN;
  if (token) {
    try {
      const resolved = await authenticate(`Bearer ${token}`);
      if (resolved) ctx = resolved;
      else console.error("[llm-bus] stdio: token did not resolve; introspection-only mode");
    } catch (e) {
      console.error("[llm-bus] stdio: token auth failed; introspection-only mode:", (e as Error).message);
    }
  }
  const server = buildServer(ctx);
  await server.connect(new StdioServerTransport());
  console.error("[llm-bus] stdio MCP server ready");
}

main().catch((e) => {
  console.error("[llm-bus] stdio start failed:", e);
  process.exit(1);
});
