// Calls one Fleet Control MCP tool: bun mcp-call.ts <url> <tokenFile> <tool> '<json args>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [url, tokenFile, tool, args = "{}"] = process.argv.slice(2);
if (!url || !tokenFile || !tool) throw new Error("usage: mcp-call.ts <url> <tokenFile> <tool> [json]");
const token = (await Bun.file(tokenFile).text()).trim();
const client = new Client({ name: "fleet-control-deploy-test", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
const r = (await client.callTool({ name: tool, arguments: JSON.parse(args) })) as { isError?: boolean; content: { text: string }[] };
console.log(r.content.map((c) => c.text).join("\n"));
await client.close();
process.exit(r.isError ? 2 : 0);
