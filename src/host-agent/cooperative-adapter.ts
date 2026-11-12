import { createHash, timingSafeEqual } from "node:crypto";

// This is an in-memory handler, not a listener or a deployment boundary. Processes
// under the same UID may inspect its memory or obtain the local token. The agent
// must be trusted; neither token protects against a hostile same-UID process.
export interface CooperativeAdapterOptions {
  centralUrl: string;
  localToken: string;
  supervisorToken: string;
  incarnationId: string;
  incarnationToken: string;
  centralFetch: (input: string, init: RequestInit) => Promise<Response>;
  allowLoopbackHttpForTests?: boolean;
  requestTimeoutMs?: number;
  maxConcurrentRequests?: number;
}

// Central accepts 512 KiB MCP requests, including maximum escaped report detail.
const requestLimit = 512 * 1024;
// MCP puts JSON.stringify({ command/event }) inside a JSON-RPC text response.
// A control character takes 6 bytes in the inner JSON and 7 in the outer JSON.
// Allow the full request limit again for the echoed JSON-RPC id, plus 7 bytes
// per unit of 65536 detail, 4000 command text and bounded 256-unit metadata,
// with envelope headroom. This remains a transport cap, not a delivery guarantee.
const responseLimit = 2 * 1024 * 1024;
const loopbacks = new Set(["localhost", "127.0.0.1", "[::1]"]);
const digest = (value: string) => createHash("sha256").update(value).digest();
const error = (status: number, message: string) => Response.json({ error: message }, { status });

function cancel(body: ReadableStream<Uint8Array> | null, track: (promise: Promise<unknown>) => void): void {
  if (!body) return;
  try { track(body.cancel()); } catch { /* Cancellation is best effort. */ }
}

async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal, track: (promise: Promise<unknown>) => void): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const stop = () => { try { track(reader.cancel()); } catch { /* Best effort. */ } };
  signal.addEventListener("abort", stop, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (signal.aborted) throw new Error("aborted");
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("aborted");
      if (done) break;
      length += value.byteLength;
      if (length > limit) { stop(); throw new RangeError(); }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", stop);
    try { reader.releaseLock(); } catch { /* A pending read may retain the lock. */ }
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export function createCooperativeAdapter(options: CooperativeAdapterOptions): (request: Request) => Promise<Response> {
  let central: URL;
  try { central = new URL(options.centralUrl); } catch { throw new Error("invalid adapter configuration"); }
  const { localToken, supervisorToken, incarnationId, incarnationToken, centralFetch } = options;
  const timeout = options.requestTimeoutMs ?? 30_000;
  const maxConcurrent = options.maxConcurrentRequests ?? 16;
  if (!(central.protocol === "https:" || (central.protocol === "http:" && options.allowLoopbackHttpForTests === true && loopbacks.has(central.hostname))) ||
      central.username || central.password || central.pathname !== "/mcp" || central.search || central.hash ||
      !/^[A-Za-z0-9_-]{43}$/.test(localToken) || !/^[A-Za-z0-9_-]{43}$/.test(incarnationToken) ||
      !/^[\x21-\x7e]{32,512}$/.test(supervisorToken) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(incarnationId) ||
      new Set([localToken, supervisorToken, incarnationToken]).size !== 3 || typeof centralFetch !== "function" ||
      !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647 ||
      !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 1024) throw new Error("invalid adapter configuration");
  const endpoint = central.toString();
  const localHash = digest(`Bearer ${localToken}`);
  const secrets = [localToken, supervisorToken, incarnationToken, incarnationId];
  const containsEncodedSecret = (json: string): boolean => {
    for (const match of json.matchAll(/"(?:\\.|[^"\\])*"/g)) {
      const value: string = JSON.parse(match[0]);
      if (secrets.some((secret) => value.includes(secret))) return true;
    }
    return false;
  };
  const containsSecret = (value: unknown): boolean => {
    const pending = [value];
    while (pending.length) {
      const item = pending.pop();
      if (typeof item === "string") {
        if (secrets.some((secret) => item.includes(secret))) return true;
      } else if (item && typeof item === "object") {
        for (const [key, child] of Object.entries(item)) {
          if (secrets.some((secret) => key.includes(secret))) return true;
          pending.push(child);
        }
      }
    }
    return false;
  };
  if (secrets.some((secret) => endpoint.includes(secret))) throw new Error("invalid adapter configuration");
  let active = 0;
  let earlyCancellations = 0;
  const maxEarlyCancellations = 16;
  const rejectEarly = (request: Request, status: number, message: string): Response => {
    const body = request.body;
    if (body && !body.locked && earlyCancellations < maxEarlyCancellations) {
      earlyCancellations++;
      try {
        void body.cancel().then(() => { earlyCancellations--; }, () => { earlyCancellations--; });
      } catch { earlyCancellations--; }
    }
    return error(status, message);
  };

  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.protocol !== "http:" || !loopbacks.has(url.hostname) || url.username || url.password || url.pathname !== "/mcp" || url.search || url.hash) return rejectEarly(request, 404, "not found");
      if (request.method !== "POST") return rejectEarly(request, 405, "method not allowed");
      if (request.headers.has("origin")) return rejectEarly(request, 403, "origin not allowed");
      const supplied = request.headers.get("authorization") ?? "";
      if (!timingSafeEqual(digest(supplied), localHash)) return rejectEarly(request, 401, "unauthorized");
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return rejectEarly(request, 415, "expected JSON");
      if (request.signal.aborted) return rejectEarly(request, 499, "client aborted");
      if (active >= maxConcurrent) return rejectEarly(request, 503, "adapter busy");
      active++;
      let pending = 1;
      const track = (promise: Promise<unknown>) => {
        pending++;
        void promise.then(() => { if (--pending === 0) active--; }, () => { if (--pending === 0) active--; });
      };
      const controller = new AbortController();
      let forwarded = false;
      let finish!: (response: Response) => void;
      const interrupted = new Promise<Response>((resolve) => { finish = resolve; });
      const unknown = (status: number) => error(status, "outcome unknown; no automatic retry; retry only the exact request ID and payload with the same incarnation");
      const abort = (client: boolean) => {
        controller.abort();
        finish(forwarded ? unknown(client ? 499 : 504) : error(client ? 499 : 504, client ? "client aborted" : "request timeout before forwarding"));
      };
      const onAbort = () => abort(true);
      request.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => abort(false), timeout);
      if (request.signal.aborted) onAbort();
      const work = (async (): Promise<Response> => {
        try {
          let bytes: Uint8Array;
          try { bytes = await readLimited(request.body, requestLimit, controller.signal, track); }
          catch (cause) { if (controller.signal.aborted) throw cause; return error(cause instanceof RangeError ? 413 : 400, cause instanceof RangeError ? "body too large" : "invalid request body"); }
          let raw: string;
          try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return error(400, "invalid JSON"); }
          let input: unknown;
          try { input = JSON.parse(raw); } catch { return error(400, "invalid JSON"); }
          if (!input || typeof input !== "object" || Array.isArray(input) || (input as Record<string, unknown>).jsonrpc !== "2.0" || typeof (input as Record<string, unknown>).method !== "string") return error(400, "invalid MCP request");
          const hasId = Object.hasOwn(input, "id");
          const requestId = (input as Record<string, unknown>).id;
          if (hasId && !((typeof requestId === "string" && requestId.length <= 256) || (typeof requestId === "number" && Number.isSafeInteger(requestId)))) return error(400, "invalid MCP request");
          if (containsEncodedSecret(raw) || secrets.some((secret) => raw.includes(secret) || JSON.stringify(input).includes(secret))) return error(400, "invalid MCP request");
          if (controller.signal.aborted) throw new Error("aborted");
          forwarded = true;
          const upstream = await centralFetch(endpoint, { method: "POST", redirect: "error", signal: controller.signal, headers: { authorization: `Bearer ${supervisorToken}`, "x-fleet-incarnation-id": incarnationId, "x-fleet-incarnation-token": incarnationToken, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: raw });
          if (controller.signal.aborted) { cancel(upstream.body, track); throw new Error("aborted"); }
          if (!upstream.ok) { cancel(upstream.body, track); return unknown(502); }
          if (upstream.status === 202 || upstream.status === 204) {
            if (hasId) { cancel(upstream.body, track); return unknown(502); }
            const acknowledgement = await readLimited(upstream.body, responseLimit, controller.signal, track);
            return acknowledgement.length === 0 ? new Response(null, { status: upstream.status }) : unknown(502);
          }
          if (!hasId || !/^application\/json(?:\s*;|$)/i.test(upstream.headers.get("content-type") ?? "")) { cancel(upstream.body, track); return unknown(502); }
          const text = new TextDecoder("utf-8", { fatal: true }).decode(await readLimited(upstream.body, responseLimit, controller.signal, track));
          const parsed: unknown = JSON.parse(text);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unknown(502);
          const response = parsed as Record<string, unknown>;
          const hasResult = Object.hasOwn(response, "result");
          const hasError = Object.hasOwn(response, "error");
          if (response.jsonrpc !== "2.0" || !Object.hasOwn(response, "id") || response.id !== requestId || hasResult === hasError) return unknown(502);
          if (hasError && (!response.error || typeof response.error !== "object" || Array.isArray(response.error) || !Number.isInteger((response.error as Record<string, unknown>).code) || typeof (response.error as Record<string, unknown>).message !== "string")) return unknown(502);
          const normalized = JSON.stringify(parsed);
          // Inspect one JSON layer in MCP text blocks, retaining duplicate keys.
          // The response byte cap bounds parsing and token scanning. Non-JSON text
          // and JSON encoded inside a string token are not recursively decoded.
          const result = response.result;
          const content = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>).content : undefined;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") continue;
              try { JSON.parse(block.text); } catch { continue; }
              if (containsEncodedSecret(block.text)) return unknown(502);
            }
          }
          if (containsSecret(parsed) || secrets.some((secret) => text.includes(secret) || normalized.includes(secret))) return unknown(502);
          return new Response(normalized, { status: upstream.status, headers: { "content-type": "application/json" } });
        } catch { return forwarded ? unknown(502) : error(502, "adapter request failed"); }
      })();
      // A slot remains occupied while an uncooperative operation is still pending.
      void work.then(() => { if (--pending === 0) active--; }, () => { if (--pending === 0) active--; });
      try { return await Promise.race([work, interrupted]); }
      finally { clearTimeout(timer); request.signal.removeEventListener("abort", onAbort); }
    } catch { return error(502, "adapter request failed"); }
  };
}
