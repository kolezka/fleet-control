import { expect, test } from "bun:test";
import { Auth, AuthConfigError, parseTokens, tokenLine } from "./auth.ts";

const token = "synthetic-shared-token";
const hash = tokenLine("alice", token).split(" ")[1]!;

function expectSafeConfigError(action: () => unknown) {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(AuthConfigError);
  const message = String(error);
  expect(message).not.toContain(hash);
  expect(message).not.toContain(token);
}

for (const names of [["alice", "bob"], ["bob", "alice"]]) {
  test(`parseTokens rejects a shared hash in ${names.join(", ")} order`, () => {
    expectSafeConfigError(() => parseTokens(names.map((name) => `${name} ${hash}`).join("\n")));
  });

  test(`Auth constructor rejects a shared hash in ${names.join(", ")} order`, () => {
    expectSafeConfigError(() => new Auth(new Map(names.map((name) => [name, Buffer.from(hash, "hex")]))));
  });
}

test("constructor rejects malformed hashes before authentication", () => {
  expect(() => new Auth(new Map([["alice", Buffer.alloc(31)]]))).toThrow(AuthConfigError);
  expect(() => new Auth(new Map([["alice", "invalid" as unknown as Buffer]]))).toThrow(AuthConfigError);
});

test("constructor snapshots the map and hash bytes", () => {
  const bytes = Buffer.from(hash, "hex");
  const hashes = new Map([["alice", bytes]]);
  const auth = new Auth(hashes);
  bytes.fill(0);
  hashes.set("bob", Buffer.from(hash, "hex"));
  hashes.delete("alice");
  expect(auth.check(token)).toEqual({ name: "alice" });
});

test("distinct hashes authenticate their own principals", () => {
  const auth = new Auth(parseTokens(`${tokenLine("alice", token)}\n${tokenLine("bob", "synthetic-other-token")}`));
  expect(auth.check(token)).toEqual({ name: "alice" });
  expect(auth.check("synthetic-other-token")).toEqual({ name: "bob" });
  expect(auth.check("unknown-token")).toBeNull();
});
