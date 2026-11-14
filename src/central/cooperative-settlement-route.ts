import { Hono } from "hono";
import { CommandError } from "../data/commands.ts";
import type { CentralAuth } from "./auth.ts";
import type { CooperativeSettlement } from "./data/cooperative-settlement.ts";

const MAX_BODY = 512 * 1024;
const validId = (id: string) => !!id && id.length <= 256 && id.trim() === id && !/[\x00-\x1f\x7f]/.test(id);

async function readJson(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new RangeError();
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { void reader.cancel().catch(() => {}); throw new RangeError(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

function commandId(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split("/");
    if (segments.at(-1) === "") segments.pop();
    const id = decodeURIComponent(segments.at(-3) ?? "");
    return validId(id) ? id : null;
  } catch { return null; }
}

// Mount after authentication and origin middleware. Operator only.
export function createCooperativeSettlementRoute(deps: { auth: CentralAuth; settlement: Pick<CooperativeSettlement, "get" | "settle"> }) {
  const app = new Hono();
  const path = "/api/commands/:id/cooperative/settlement";
  app.get(path, async (c) => {
    const principal = deps.auth.authenticate(c.req.raw);
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    if (principal.role !== "operator") return c.json({ error: "forbidden" }, 403);
    const id = commandId(c.req.url);
    if (!id) return c.json({ error: "invalid settlement parameters" }, 400);
    try {
      const settlement = await deps.settlement.get(principal, id);
      return settlement ? c.json(settlement, 200) : c.json({ error: "not found" }, 404);
    } catch { return c.json({ error: "request failed" }, 500); }
  });
  app.post(path, async (c) => {
    const principal = deps.auth.authenticate(c.req.raw);
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    if (principal.role !== "operator") return c.json({ error: "forbidden" }, 403);
    const id = commandId(c.req.url);
    if (!id) return c.json({ error: "invalid settlement parameters" }, 400);
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "expected JSON" }, 415);
    let input: unknown;
    try { input = await readJson(c.req.raw); }
    catch (error) { return error instanceof RangeError ? c.json({ error: "body too large" }, 413) : c.json({ error: "invalid JSON" }, 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) return c.json({ error: "invalid settlement" }, 400);
    const body = input as Record<string, unknown>;
    const keys = Object.keys(body).sort().join(",");
    if (keys !== "disposition,evidence,expectedSequence,requestId" || typeof body.requestId !== "string" || typeof body.disposition !== "string" || typeof body.evidence !== "string" || (body.expectedSequence !== null && typeof body.expectedSequence !== "string")) {
      return c.json({ error: "invalid settlement" }, 400);
    }
    try {
      const { settlement, created } = await deps.settlement.settle(principal, id, body.requestId, body.disposition as never, body.evidence, body.expectedSequence as string | null);
      return c.json(settlement, created ? 201 : 200);
    } catch (error) {
      if (error instanceof CommandError) return c.json({ error: error.message }, error.kind === "not_found" ? 404 : error.kind === "conflict" ? 409 : 400);
      return c.json({ error: "request failed" }, 500);
    }
  });
  return app;
}
