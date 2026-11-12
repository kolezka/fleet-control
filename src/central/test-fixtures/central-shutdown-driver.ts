// Test-only child driver: starts the real cooperative-main under the fake preload, posts one
// command and calls stop() once the fake transaction has begun. Prints "[driver] <event>" lines to stderr.
// Usage: bun --preload ./central-shutdown-preload.ts central-shutdown-driver.ts [graceMs]
import { startCooperative } from "../cooperative-main.ts";

const log = (event: string) => { process.stderr.write(`[driver] ${event}\n`); };
const grace = process.argv[2] ? Number(process.argv[2]) : undefined;
const fake = globalThis as { __centralFakeLog?: (event: string) => void };
const original = fake.__centralFakeLog!;
const begun = Promise.withResolvers<void>();
fake.__centralFakeLog = (event) => { original(event); if (event === "tx begin k-stop") begun.resolve(); };
const running = await startCooperative(process.env, grace === undefined ? {} : { shutdownGraceMs: grace });
const response = fetch(`http://127.0.0.1:${running.server.port}/api/commands`, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.FAKE_OPERATOR_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ hostId: "h1", target: "t", text: "echo hi", idempotencyKey: "k-stop" }),
}).then((r) => log(`client status ${r.status}`), (error: unknown) => log(`client error ${(error as { code?: string })?.code ?? "unknown"}`));
const beginTimer = setTimeout(() => begun.reject(new Error("transaction never began")), 5_000);
await begun.promise;
clearTimeout(beginTimer);
log("stop called");
await running.stop();
log("stop resolved");
await response;
