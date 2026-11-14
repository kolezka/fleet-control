// Reads a request body up to a byte limit. Every central HTTP app uses this one reader,
// so an oversized body is refused the same way everywhere.

// Throws RangeError when the declared or the received size is over the limit. The declared size is
// checked before anything is read; a body that lies about its size is cut off at the limit.
export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new RangeError("body too large");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { void reader.cancel().catch(() => {}); throw new RangeError("body too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

// Strict UTF-8, then JSON. Throws RangeError for size, and TypeError or SyntaxError for content.
export async function readBoundedJson(request: Request, limit: number): Promise<unknown> {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBody(request, limit)));
}
