import { expect, spyOn, test } from "bun:test";
import { Auth, parseTokens, tokenLine } from "./auth.ts";
import { serve } from "./server.ts";

test.each([
  ["normal token", "token-value"],
  ["padded token", "  token-value  "],
])("login cookie authenticates the principal for %s", async (_label, input) => {
  const auth = new Auth(parseTokens(tokenLine("web", "token-value")));
  let routes: any;
  const fakeServe = spyOn(Bun, "serve").mockImplementation(((options: any) => {
    routes = options.routes;
    return { port: 0 };
  }) as typeof Bun.serve);
  try {
    serve({ fleet: {} as any, store: {} as any }, 0, { auth });
    const body = new FormData();
    body.set("token", input);
    const login = await routes["/api/login"].POST(new Request("http://host.test/api/login", {
      method: "POST", headers: { origin: "http://host.test" }, body,
    }));
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/");
    const cookie = login.headers.get("set-cookie");
    expect(cookie).not.toBeNull();
    const who = await routes["/api/whoami"].GET(new Request("http://host.test/api/whoami", {
      headers: { cookie: cookie!.split(";")[0]! },
    }), {});
    expect(who.status).toBe(200);
    expect(await who.json()).toEqual({ principal: "web", auth: true });
  } finally {
    fakeServe.mockRestore();
  }
});
