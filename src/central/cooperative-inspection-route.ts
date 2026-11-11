import { Hono } from "hono";
import type { CentralAuth } from "./auth.ts";
import type { CooperativeInspection } from "./cooperative-inspection.ts";

// Mount after the server's authentication and origin middleware.
export function createCooperativeInspectionRoute(deps: {
  auth: CentralAuth;
  inspection: Pick<CooperativeInspection, "inspect">;
}) {
  const app = new Hono();
  app.get("/api/commands/:id/cooperative", async (c) => {
    const principal = deps.auth.authenticate(c.req.raw);
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    if (principal.role !== "operator") return c.json({ error: "forbidden" }, 403);
    const id = c.req.param("id");
    const query = new URL(c.req.url).searchParams;
    const limits = query.getAll("limit");
    const cursors = query.getAll("cursor");
    const limit = limits[0];
    const cursor = cursors[0];
    if (!id || id.length > 256 || id.trim() !== id || /[\x00-\x1f\x7f]/.test(id) ||
        limits.length > 1 || cursors.length > 1 ||
        (limit !== undefined && (!/^[1-9][0-9]*$/.test(limit) || Number(limit) > 1000)) ||
        (cursor !== undefined && (!/^(0|[1-9][0-9]{0,18})$/.test(cursor) || BigInt(cursor) > 9223372036854775807n))) {
      return c.json({ error: "invalid inspection parameters" }, 400);
    }
    try {
      const result = await deps.inspection.inspect(id, { ...(limit !== undefined ? { limit: Number(limit) } : {}), ...(cursor !== undefined ? { cursor } : {}) });
      return result ? c.json(result) : c.json({ error: "not found" }, 404);
    } catch {
      return c.json({ error: "request failed" }, 500);
    }
  });
  return app;
}
