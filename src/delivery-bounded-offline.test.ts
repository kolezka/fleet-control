import { afterAll, expect, test } from "bun:test";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetSender } from "./delivery.ts";
import { classify } from "./domain/delivery.ts";

const dir = await mkdtemp(join(tmpdir(), "sender-test-"));
const fixture = join(dir, "fixture");
await Bun.write(fixture, `#!${process.execPath}
const target = process.argv[3], mode = process.argv[4];
const out = process.stdout, err = process.stderr;
if (mode === "overflow-out") out.write(target + ": delivered" + "x".repeat(100000));
else if (mode === "overflow-err") { out.write(target + ": delivered"); err.write("x".repeat(100000)); }
else if (mode === "invalid-out") out.write(Buffer.concat([Buffer.from(target + ": delivered"), Buffer.from([255])]));
else if (mode === "invalid-err") { out.write(target + ": delivered"); err.write(Buffer.from([255])); }
else if (mode === "both") { out.write("x".repeat(200000)); err.write("y".repeat(200000)); }
else if (mode === "limit") { out.write(target + ": delivered"); err.write("x".repeat(65536)); }
else if (mode === "limit-plus") { out.write(target + ": delivered"); err.write("x".repeat(65537)); }
else { out.write(target + ": delivered\\n"); err.write("  warning  "); }
`);
await chmod(fixture, 0o700);
afterAll(() => rm(dir, { recursive: true, force: true }));
const send = fleetSender(fixture, "unused");

test("exact valid success and stderr trimming stay compatible", async () => {
  const result = await send("alpha", "success");
  expect(result).toEqual({ exitCode: 0, stdout: "alpha: delivered\n", stderr: "warning" });
  expect(classify(result, "alpha").status).toBe("delivered");
});

test.each(["overflow-out", "overflow-err", "invalid-out", "invalid-err"])("%s is unconfirmed and bounded", async (mode) => {
  const result = await send("alpha", mode);
  expect(classify(result, "alpha").status).toBe("delivery_unknown");
  expect(new TextEncoder().encode(result.stdout).length).toBeLessThanOrEqual(65536);
  expect(new TextEncoder().encode(result.stderr).length).toBeLessThanOrEqual(65536);
});

test("the byte limit is inclusive on stderr", async () => {
  const atLimit = await send("alpha", "limit");
  expect(atLimit.stderr.length).toBe(65536);
  expect(classify(atLimit, "alpha").status).toBe("delivered");
  const aboveLimit = await send("alpha", "limit-plus");
  expect(classify(aboveLimit, "alpha").status).toBe("delivery_unknown");
});

test("both pipes are drained after overflow", async () => {
  const result = await send("alpha", "both");
  expect(classify(result, "alpha").status).toBe("delivery_unknown");
  expect(result.stdout.length).toBeLessThanOrEqual(65536);
  expect(result.stderr.length).toBeLessThanOrEqual(65536);
});

test("BOM-prefixed output cannot become a false success", async () => {
  const stream = (bytes: number[]) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } });
  const bytes = [...new TextEncoder().encode("alpha: delivered")];
  const sender = fleetSender("unused", "unused", () => ({ stdout: stream([239, 187, 191, ...bytes]), stderr: stream([]), exited: Promise.resolve(0) }));
  const result = await sender("alpha", "unused");
  expect(result.stdout).toBe("\uFEFFalpha: delivered");
  expect(classify(result, "alpha").status).toBe("delivery_unknown");
});

test.each(["stdout", "stderr"] as const)("%s reader failure waits for child exit and is unknown", async (failed) => {
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { finish = resolve; });
  const stream = (failure: boolean, text: string) => new ReadableStream<Uint8Array>({ start(c) { if (failure) c.error(new Error("read failed")); else { c.enqueue(new TextEncoder().encode(text)); c.close(); } } });
  const sender = fleetSender("unused", "unused", () => ({ stdout: stream(failed === "stdout", "alpha: delivered"), stderr: stream(failed === "stderr", ""), exited }));
  let settled = false;
  const pending = sender("alpha", "unused").then((r) => { settled = true; return r; }, () => { settled = true; throw new Error("sender rejected"); });
  await Bun.sleep(10);
  expect(settled).toBe(false);
  finish(0);
  expect(classify(await pending, "alpha").status).toBe("delivery_unknown");
});

test("split multibyte chunks decode intact", async () => {
  const parts = [[0x61, 0xc3], [0xa9]];
  const stdout = new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(new Uint8Array(p)); c.close(); } });
  const stderr = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
  const sender = fleetSender("unused", "unused", () => ({ stdout, stderr, exited: Promise.resolve(0) }));
  expect((await sender("alpha", "unused")).stdout).toBe("aé");
});

test("stdout byte limit and overflow sentinel use the same target", async () => {
  const target = "a".repeat(65536 - ": delivered".length);
  const exact = await send(target, "success");
  // The fixture adds LF, so the sentinel is the first byte beyond the cap.
  expect(classify(exact, target).status).toBe("delivery_unknown");
  const make = (suffix: string) => fleetSender("unused", "unused", () => ({
    stdout: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(target + ": delivered" + suffix)); c.close(); } }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    exited: Promise.resolve(0),
  }));
  const atLimit = await make("")(target, "unused");
  expect(atLimit.stdout.length).toBe(65536);
  expect(classify(atLimit, target).status).toBe("delivered");
  const overflow = await make("x")(target, "unused");
  expect(overflow.stdout).toBe("");
  expect(classify(overflow, target).status).toBe("delivery_unknown");
});

test("fake subprocess positive control confirms exact success", async () => {
  const stream = (text: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
  const sender = fleetSender("unused", "unused", () => ({ stdout: stream("alpha: delivered"), stderr: stream(""), exited: Promise.resolve(0) }));
  expect(classify(await sender("alpha", "unused"), "alpha").status).toBe("delivered");
});
