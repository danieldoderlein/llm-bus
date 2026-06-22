import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Drive a real MCP round-trip against a running server (local or the deployed
// public endpoint). Usage:
//   YOLO_URL=https://yolo.doderlein.com/mcp YOLO_TOKEN=<token> npm run live-check
//   npm run live-check -- https://yolo.doderlein.com/mcp <token>
function parse(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: { text: string }[] }).content[0].text);
}

async function main(): Promise<void> {
  const url = process.env.YOLO_URL ?? process.argv[2];
  const token = process.env.YOLO_TOKEN ?? process.argv[3];
  if (!url || !token) {
    console.error("usage: YOLO_URL=https://host/mcp YOLO_TOKEN=... npm run live-check");
    process.exit(2);
  }

  const client = new Client({ name: "live-check", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  console.log("connected:", url);

  const reg = parse(await client.callTool({ name: "register", arguments: { lane: "live-check" } }));
  console.log("register      ->", JSON.stringify(reg));
  const claim = parse(await client.callTool({ name: "claim", arguments: { sequence: "adr" } }));
  console.log("claim(adr)    ->", JSON.stringify(claim));
  const active = parse(await client.callTool({ name: "who_is_active", arguments: {} }));
  console.log("who_is_active ->", JSON.stringify(active));
  const q = parse(await client.callTool({ name: "query_events", arguments: { type: "claim", limit: 3 } }));
  console.log("query_events  ->", JSON.stringify(q));

  await client.close();
  console.log(`OK live-check: full MCP round-trip succeeded against ${url}`);
}

main().catch((err) => {
  console.error("live-check failed:", err);
  process.exit(1);
});
