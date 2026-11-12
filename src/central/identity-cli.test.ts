import { describe, expect, test } from "bun:test";
import { runIdentityCli } from "./identity-cli";

const args = ["--principal-id", "id-1", "--name", "supervisor", "--host-id", "host-1", "--session", "session-1"];
const identity = { principalId: "id-1", name: "supervisor", hostId: "host-1", session: "session-1" };

function fixture(failAt?: string) {
  const calls: unknown[] = [];
  const output: string[] = [];
  const step = (name: string, value?: unknown) => {
    calls.push(value === undefined ? name : [name, value]);
    if (failAt === name) throw new Error("secret database password or token");
  };
  return {
    calls, output,
    deps: {
      open(url: string) {
        step("open", url);
        return {
          registry: {
            async initialize() { step("initialize"); },
            async enroll(value: typeof identity) { step("enroll", value); },
            async retire(value: typeof identity) { step("retire", value); },
          },
          async close() { step("close"); },
        };
      },
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => output.push(message),
    },
  };
}

describe("identity CLI", () => {
  for (const action of ["enroll", "retire"] as const) {
    test(`${action} requires an explicit binding and initializes first`, async () => {
      const f = fixture();
      expect(await runIdentityCli([action, ...args], { DATABASE_URL: "postgres://secret" }, f.deps)).toBe(0);
      expect(f.calls).toEqual([["open", "postgres://secret"], "initialize", [action, identity], "close"]);
      expect(f.output.join(" ")).not.toContain("secret");
    });
  }

  test("rejects missing env and invalid or implicit operations before opening the database", async () => {
    const cases: [string[], { DATABASE_URL?: string }][] = [
      [["enroll", ...args], {}], [["enroll", ...args], { DATABASE_URL: "  " }],
      [args, { DATABASE_URL: "db" }], [[], { DATABASE_URL: "db" }],
      [["unknown", ...args], { DATABASE_URL: "db" }],
      [["enroll", ...args.slice(0, -2)], { DATABASE_URL: "db" }],
      [["enroll", ...args, "--token", "secret"], { DATABASE_URL: "db" }],
      [["enroll", "--principal-id", "id", "--principal-id", "id", "--host-id", "h", "--session", "s"], { DATABASE_URL: "db" }],
      [["enroll", "--principal-id", "id", "--name", " ", "--host-id", "h", "--session", "s"], { DATABASE_URL: "db" }],
      [["retire", "--principal-id", "id", "--name", "n\nx", "--host-id", "h", "--session", "s"], { DATABASE_URL: "db" }],
      [["enroll", "--principal-id", "x".repeat(257), ...args.slice(2)], { DATABASE_URL: "db" }],
    ];
    for (const [input, env] of cases) {
      const f = fixture();
      expect(await runIdentityCli(input, env, f.deps)).toBe(1);
      expect(f.calls).toEqual([]);
      expect(f.output.join(" ")).not.toContain("secret");
    }
  });

  test("reports retirement errors without leaking details", async () => {
    const f = fixture("retire");
    expect(await runIdentityCli(["retire", ...args], { DATABASE_URL: "postgres://secret" }, f.deps)).toBe(1);
    expect(f.output.join(" ")).not.toContain("secret");
    expect(f.calls.at(-1)).toBe("close");
  });

  for (const failAt of ["open", "initialize", "enroll", "close"]) {
    test(`sanitizes ${failAt} errors and never reports success`, async () => {
      const f = fixture(failAt);
      expect(await runIdentityCli(["enroll", ...args], { DATABASE_URL: "postgres://secret" }, f.deps)).toBe(1);
      expect(f.output.join(" ")).not.toContain("secret");
      expect(f.output.join(" ")).not.toContain("enrolled");
      if (failAt !== "open") expect(f.calls.at(-1)).toBe("close");
      if (failAt === "initialize") expect(f.calls).not.toContainEqual(["enroll", identity]);
    });
  }
});
