import { expect, test } from "bun:test";
import { readBoundedBody, readBoundedJson } from "./http-body.ts";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request("http://central.test/", { method: "POST", body, headers });

// A body sent in pieces, with a record of whether the reader cancelled it.
function streamed(pieces: number[]) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = pieces[state.pulled++];
      if (size === undefined) controller.close();
      else controller.enqueue(new Uint8Array(size).fill(120));
    },
    cancel() { state.cancelled = true; },
  });
  return { state, request: new Request("http://central.test/", { method: "POST", body, duplex: "half" } as RequestInit) };
}

test("a body at the limit is returned whole, in order", async () => {
  const { request } = streamed([3, 0, 5]);
  const body = await readBoundedBody(request, 8);
  expect(body.byteLength).toBe(8);
  expect(new TextDecoder().decode(await readBoundedBody(post("abc"), 3))).toBe("abc");
  const joined = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("ab")); c.enqueue(new TextEncoder().encode("cd")); c.close(); } });
  expect(new TextDecoder().decode(await readBoundedBody(new Request("http://central.test/", { method: "POST", body: joined, duplex: "half" } as RequestInit), 4))).toBe("abcd");
});

test("a request without a body reads as empty", async () => {
  expect((await readBoundedBody(new Request("http://central.test/"), 8)).byteLength).toBe(0);
});

test("a declared size over the limit is refused before the body is read", async () => {
  const { request, state } = streamed([1]);
  request.headers.set("content-length", "9");
  await expect(readBoundedBody(request, 8)).rejects.toBeInstanceOf(RangeError);
  expect(state.pulled).toBeLessThanOrEqual(1);
  expect(request.bodyUsed).toBe(false);
});

// Headers trim surrounding spaces, so " 8" arrives as "8" and is not a case here.
test.each(["-1", "1e2", "8.0", "0x8", "8 8", ""])("a declared size of %p is refused", async (length) => {
  const request = post("abc");
  request.headers.set("content-length", length);
  await expect(readBoundedBody(request, 8)).rejects.toBeInstanceOf(RangeError);
});

test("a body that grows past the limit is cut off and the stream is cancelled", async () => {
  const { request, state } = streamed([4, 4, 1, 4, 4]);
  await expect(readBoundedBody(request, 8)).rejects.toBeInstanceOf(RangeError);
  await Bun.sleep(0);
  expect(state.cancelled).toBe(true);
  expect(state.pulled).toBeLessThan(5);
});

test("a declared size under the limit does not excuse a larger body", async () => {
  const { request } = streamed([6, 6]);
  request.headers.set("content-length", "4");
  await expect(readBoundedBody(request, 8)).rejects.toBeInstanceOf(RangeError);
});

test("JSON is parsed from strict UTF-8, and each failure keeps its own error type", async () => {
  expect(await readBoundedJson(post('{"a":"\u00e9"}'), 64)).toEqual({ a: "\u00e9" });
  await expect(readBoundedJson(post("{"), 64)).rejects.toBeInstanceOf(SyntaxError);
  await expect(readBoundedJson(new Request("http://central.test/"), 64)).rejects.toBeInstanceOf(SyntaxError);
  await expect(readBoundedJson(post(new Uint8Array([0x22, 0xff, 0x22])), 64)).rejects.toBeInstanceOf(TypeError);
  await expect(readBoundedJson(post("[1,2,3]"), 6)).rejects.toBeInstanceOf(RangeError);
});
