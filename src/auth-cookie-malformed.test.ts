import { expect, spyOn, test } from "bun:test";
import { Auth, COOKIE, parseTokens, tokenLine } from "./auth.ts";
import { serve } from "./server.ts";
import type { Store } from "./data/store.ts";

const token = "valid/token";
const auth = new Auth(parseTokens(tokenLine("operator", token)));
const request = (cookie: string, authorization?: string) => new Request("http://localhost/api/whoami", {
  headers: { cookie: `${COOKIE}=${cookie}`, ...(authorization ? { authorization } : {}) },
});

function hostGuard() {
  let handler: ((req: Request, server: unknown) => Response | Promise<Response>) | undefined;
  const spy = spyOn(Bun, "serve").mockImplementation(((options: any) => {
    handler = options.routes["/api/whoami"].GET;
    return {};
  }) as typeof Bun.serve);
  try {
    serve({ fleet: { screen: async () => "", status: async () => ({ raw: "", sessions: [] }) }, store: {} as Store }, 0, { auth });
  } finally {
    spy.mockRestore();
  }
  if (!handler) throw new Error("host guard was not captured");
  return handler;
}

for (const malformed of ["%", "%FF"]) {
  test(`${malformed} malformed cookie has no principal`, () => {
    expect(auth.principal(request(malformed))).toBeNull();
  });
  test(`${malformed} malformed cookie is rejected by the host guard`, async () => {
    const response = await hostGuard()(request(malformed), {});
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({ error: { kind: "unauthorized", message: "missing or invalid token" } });
  });
}

test("encoded cookie authenticates through principal and host guard", async () => {
  const req = request(encodeURIComponent(token));
  expect(auth.principal(req)).toEqual({ name: "operator" });
  const response = await hostGuard()(req, {});
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ principal: "operator", auth: true });
});

test("valid bearer ignores a malformed cookie", async () => {
  const req = request("%FF", `Bearer ${token}`);
  expect(auth.principal(req)).toEqual({ name: "operator" });
  const response = await hostGuard()(req, {});
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ principal: "operator", auth: true });
});

test("invalid bearer does not fall back to a valid cookie", async () => {
  const req = request(encodeURIComponent(token), "Bearer invalid");
  expect(auth.principal(req)).toBeNull();
  const response = await hostGuard()(req, {});
  expect(response.status).toBe(401);
});
