import { describe, expect, spyOn, test } from "bun:test";
import { serve } from "./server.ts";

function fixture() {
  let routes: any;
  const submitCalls: unknown[] = [];
  const resolveCalls: unknown[] = [];
  let deliveryCalls = 0;
  const serveSpy = spyOn(Bun, "serve").mockImplementation(((options: any) => {
    routes = options.routes;
    return { port: 0 };
  }) as typeof Bun.serve);
  try {
    serve({
      fleet: {} as any,
      store: {} as any,
      control: {
        commands: {
          submit(input: unknown) {
            submitCalls.push(input);
            return { command: { id: "existing" }, created: false };
          },
          events() { return []; },
        } as any,
        requests: {
          resolve(input: unknown) {
            resolveCalls.push(input);
            return { id: "request" };
          },
        } as any,
        deliverer: {
          deliver() {
            deliveryCalls++;
            throw new Error("delivery must not be invoked");
          },
        } as any,
      },
    });
  } finally {
    serveSpy.mockRestore();
  }
  async function post(path: string, body: unknown) {
    const isResolve = path.includes("resolve");
    const req = new Request(
      isResolve ? "http://localhost/api/requests/request/resolve" : "http://localhost/api/commands",
      { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(body) },
    );
    if (isResolve) Object.assign(req, { params: { id: "request" } });
    return await routes[path].POST(req, {});
  }
  return { post, submitCalls, resolveCalls, deliveryCalls: () => deliveryCalls };
}

describe("host JSON object shape", () => {
  for (const [name, body] of [["null", null], ["array", []], ["string", "value"], ["number", 42], ["boolean", false]] as const) {
    test(`commands reject ${name} before calling control`, async () => {
      const f = fixture();
      const response = await f.post("/api/commands", body);
      expect(f.deliveryCalls()).toBe(0);
      expect(response.status).toBe(400);
      expect(f.submitCalls).toEqual([]);
    });

    test(`resolution rejects ${name} before calling control`, async () => {
      const f = fixture();
      const response = await f.post("/api/requests/:id/resolve", body);
      expect(f.deliveryCalls()).toBe(0);
      expect(response.status).toBe(400);
      expect(f.resolveCalls).toEqual([]);
    });
  }

  test("valid command reaches control without delivery for an existing command", async () => {
    const f = fixture();
    const body = { idempotencyKey: "key", target: "session", text: "synthetic", actor: "operator" };
    const response = await f.post("/api/commands", body);
    expect(response.status).toBe(200);
    expect(f.submitCalls).toEqual([body]);
    expect(f.deliveryCalls()).toBe(0);
  });

  test("valid resolution reaches control", async () => {
    const f = fixture();
    const response = await f.post("/api/requests/:id/resolve", { response: "approve", expectedRevision: 1, note: "synthetic" });
    expect(response.status).toBe(200);
    expect(f.resolveCalls).toEqual([{ requestId: "request", response: "approve", actor: "web-ui", expectedRevision: 1, note: "synthetic" }]);
    expect(f.deliveryCalls()).toBe(0);
  });
});
