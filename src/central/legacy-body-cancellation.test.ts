import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import type { CentralCommandStore } from "./application/commands.ts";
import { createCentralApp } from "./server.ts";

const cancellationError = new Error("synthetic cancellation failure");

function oversizedStream() {
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(32 * 1024 + 1)); },
    cancel() { cancellations++; return Promise.reject(cancellationError); },
  });
  return { body, cancellations: () => cancellations };
}

test("synthetic cancellation control rejects and records cancellation", async () => {
  const stream = oversizedStream();
  const reader = stream.body.getReader();
  await reader.read();
  await expect(reader.cancel()).rejects.toBe(cancellationError);
  expect(stream.cancellations()).toBe(1);
  reader.releaseLock();
});

test("legacy REST and MCP consume rejected oversized body cancellations", async () => {
  const auth = new CentralAuth([{ tokenHash: createHash("sha256").update("operator").digest("hex"), principal: { name: "operator", role: "operator" } }]);
  const commands: CentralCommandStore = {
    async submit() { throw new Error("unexpected submit"); },
    async get() { throw new Error("unexpected get"); },
    async list() { throw new Error("unexpected list"); },
    async transition() { throw new Error("unexpected transition"); },
  };
  const app = createCentralApp({ auth, commands, identities: { async matches() { throw new Error("unexpected identity lookup"); } } });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const path of ["/api/commands", "/mcp"]) {
      const stream = oversizedStream();
      const request = new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { authorization: "Bearer operator", "content-type": "application/json" },
        body: stream.body,
        duplex: "half",
      } as RequestInit);
      const response = await app.fetch(request);
      expect(response.status).toBe(413);
      expect(stream.cancellations()).toBe(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
