import { Hono } from "hono";
import type { CentralAuth } from "./auth.ts";
import type { CooperativeReconciliation } from "./data/cooperative-reconciliation.ts";

// Mount after authentication and origin middleware.
export function createCooperativeAssertionsRoute(deps: { auth: CentralAuth; reconciliation: Pick<CooperativeReconciliation, "listBounded"> }) {
  const app = new Hono();
  app.get("/api/commands/:id/cooperative/assertions", async (c) => {
    const principal = deps.auth.authenticate(c.req.raw);
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    if (principal.role !== "operator") return c.json({ error: "forbidden" }, 403);
    let id: string;
    try {
      const segments = new URL(c.req.url).pathname.split("/");
      if (segments.at(-1) === "") segments.pop();
      id = decodeURIComponent(segments.at(-3) ?? "");
    }
    catch { return c.json({ error: "invalid assertion parameters" }, 400); }
    const query = new URL(c.req.url).searchParams;
    const limits = query.getAll("limit");
    const cursors = query.getAll("cursor");
    const limit = limits[0];
    const cursor = cursors[0];
    if (!id || id.length > 256 || id.trim() !== id || /[\x00-\x1f\x7f]/.test(id) ||
        limits.length > 1 || cursors.length > 1 ||
        (limit !== undefined && !/^[1-4]$/.test(limit)) ||
        (cursor !== undefined && !/^(0|[1-9][0-9]{0,999})$/.test(cursor))) {
      return c.json({ error: "invalid assertion parameters" }, 400);
    }
    try {
      const result = await deps.reconciliation.listBounded(principal, id, { limit: limit === undefined ? 4 : Number(limit), ...(cursor !== undefined ? { cursor } : {}) });
      if (!result) return c.json({ error: "not found" }, 404);
      const body = JSON.stringify(result);
      if (Buffer.byteLength(body, "utf8") > 2 * 1024 * 1024) throw new Error("assertion response too large");
      return c.body(body, 200, { "content-type": "application/json; charset=UTF-8" });
    } catch {
      return c.json({ error: "request failed" }, 500);
    }
  });
  return app;
}
