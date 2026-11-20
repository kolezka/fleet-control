import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { checkEnrollRequest, EnrollError, enrolledAs, pasteCommand, shellWord } from "../domain/enrollment.ts";
import { enrollUseCases, type EnrollDeps } from "./enrollment.ts";

const TOKEN = "T".repeat(43);
const MISSING = "This service folder has no scripts/enroll.ts. Update the host to a release that has it, then run this again.";
const HASH = createHash("sha256").update(TOKEN).digest("hex");
const connect = { id: "mini", name: "Mac mini", url: "https://mini.tail.ts.net:4871", mode: "connect", principal: "macbook-gateway", dir: "~/Development/fleet-control-service" };
const fresh = { ...connect, id: "arch", url: "https://arch.tail.ts.net:4872", mode: "fresh", dir: "~/fc scratch", ref: "main", port: 4872, label: "fc-scratch", fleet: "scratch", tlsCert: "~/.config/fleet-control/tailnet-tls/cert.pem", tlsKey: "~/.config/fleet-control/tailnet-tls/key.pem" };

function fakeDeps(over: Partial<EnrollDeps> = {}) {
  const files = new Map<string, string>();
  const added: { host: unknown; token: string }[] = [];
  const known = ["existing"];
  let answer: { status: number; body: unknown } = { status: 401, body: null };
  const deps: EnrollDeps = {
    newToken: () => TOKEN,
    knownIds: () => known,
    writeToken: async (id, token) => {
      const f = `/cfg/token-${id}`;
      if (files.has(f)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      files.set(f, token);
      return f;
    },
    removeToken: async (f) => { files.delete(f); },
    whoami: async () => answer,
    addHost: async (host, token) => { added.push({ host, token }); known.push((host as { id: string }).id); },
    ssh: async (_t, _p, command) => ({ code: 0, output: `ran ${command.length} chars; echo ${TOKEN}` }),
    now: () => new Date("2026-11-20T12:00:00Z"),
    ...over,
  };
  return { deps, files, added, set answer(a: { status: number; body: unknown }) { answer = a; } };
}

test("the request is checked field by field; unknown and wrong-mode fields are refused", () => {
  expect(checkEnrollRequest(connect).dir).toBe("~/Development/fleet-control-service");
  expect(checkEnrollRequest({ ...connect, url: "https://mini.tail.ts.net:4871/" }).url).toBe("https://mini.tail.ts.net:4871");
  expect(checkEnrollRequest(fresh).port).toBe(4872);
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ ...connect, extra: 1 }, /unknown field extra/],
    [{ ...connect, id: "Mini" }, /host id/],
    [{ ...connect, url: "http://mini.tail.ts.net:4871" }, /https/],
    [{ ...connect, url: "https://u:p@mini.tail.ts.net:4871" }, /https/],
    [{ ...connect, url: "https://mini.tail.ts.net:4871/api" }, /https/],
    [{ ...connect, dir: "relative/path" }, /folder/],
    [{ ...connect, dir: "~/a/../b" }, /\.\./],
    [{ ...connect, dir: "/tmp/$(id)" }, /folder/],
    [{ ...connect, dir: "/tmp/'x" }, /folder/],
    [{ ...connect, principal: "a b" }, /principal/],
    [{ ...connect, port: 4871 }, /only for a fresh install/],
    [{ ...connect, sshPort: 22 }, /SSH port needs/],
    [{ ...connect, ssh: "me@host;rm" }, /SSH target/],
    [{ ...connect, ssh: "-oProxyCommand=x@h" }, /SSH target/],
    [{ ...fresh, port: 4873 }, /URL port/],
    [{ ...fresh, ref: "--upload-pack=x" }, /git ref/],
    [{ ...fresh, ref: "a..b" }, /git ref/],
    [{ ...fresh, label: undefined }, /service name/],
    [{ ...fresh, tlsKey: "key.pem" }, /key path/],
  ];
  for (const [input, msg] of bad) expect(() => checkEnrollRequest(input), JSON.stringify(input)).toThrow(msg);
});

test("the paste command carries the hash, never the token, and quotes every value", () => {
  const c = pasteCommand(checkEnrollRequest(connect), HASH);
  expect(c).toBe(`cd "$HOME"/Development/fleet-control-service && if [ -f scripts/enroll.ts ]; then bun scripts/enroll.ts connect --principal macbook-gateway --hash ${HASH} --role operator; else echo "${MISSING}" >&2; false; fi`);
  const f = pasteCommand(checkEnrollRequest(fresh), HASH);
  expect(f).toStartWith(`git clone --quiet https://github.com/kolezka/fleet-control.git "$HOME"/'fc scratch' && cd "$HOME"/'fc scratch' && git checkout --quiet main && `);
  expect(f).toContain("--tailnet-name arch.tail.ts.net --tls-cert \"$HOME\"/.config/fleet-control/tailnet-tls/cert.pem");
  for (const cmd of [c, f]) expect(cmd).not.toContain(TOKEN);
  expect(shellWord("it's")).toBe(`'it'\\''s'`);
  expect(() => pasteCommand(checkEnrollRequest(connect), TOKEN)).toThrow(EnrollError);
});

test("the host is accepted only with tokens on, this principal and the operator role", () => {
  expect(enrolledAs({ principal: "macbook-gateway", role: "operator", auth: true }, "macbook-gateway")).toBeNull();
  expect(enrolledAs({ principal: "macbook-gateway", role: "agent", auth: true }, "macbook-gateway")).toMatch(/role agent/);
  expect(enrolledAs({ principal: "web-mariusz", role: "operator", auth: true }, "macbook-gateway")).toMatch(/as web-mariusz/);
  expect(enrolledAs({ principal: "anonymous", role: "operator", auth: false }, "macbook-gateway")).toMatch(/without tokens/);
  expect(enrolledAs(null, "x")).toMatch(/no identity/);
});

test("begin keeps the token out of every answer; check adds the host only after the right identity", async () => {
  const f = fakeDeps();
  const use = enrollUseCases(f.deps);
  const view = await use.begin(connect);
  expect(view).toEqual({ id: "mini", name: "Mac mini", url: "https://mini.tail.ts.net:4871", mode: "connect", principal: "macbook-gateway", command: expect.stringContaining(HASH), ssh: null, createdAt: "2026-11-20T12:00:00.000Z" });
  expect(JSON.stringify([view, use.list()])).not.toContain(TOKEN);
  expect(f.files.get("/cfg/token-mini")).toBe(TOKEN);

  expect(await use.check("mini")).toEqual({ added: false, reason: "the host does not know this token yet; run the command there first" });
  f.answer = { status: 200, body: { principal: "macbook-gateway", role: "agent", auth: true } };
  expect((await use.check("mini")).reason).toMatch(/role agent/);
  f.answer = { status: 503, body: null };
  expect((await use.check("mini")).reason).toBe("the host answered 503");
  expect(f.added).toEqual([]);

  f.answer = { status: 200, body: { principal: "macbook-gateway", role: "operator", auth: true } };
  expect(await use.check("mini")).toEqual({ added: true, reason: null });
  expect(f.added).toEqual([{ host: { id: "mini", name: "Mac mini", url: "https://mini.tail.ts.net:4871", tokenFile: "/cfg/token-mini" }, token: TOKEN }]);
  expect(use.list()).toEqual([]);
  await expect(use.check("mini")).rejects.toThrow(/no host mini/);
});

test("an id in use is refused before a token is made; cancel removes the token file", async () => {
  const f = fakeDeps();
  const use = enrollUseCases(f.deps);
  await expect(use.begin({ ...connect, id: "existing" })).rejects.toThrow(/already in use/);
  await use.begin(connect);
  await expect(use.begin(connect)).rejects.toThrow(/already in use/);
  expect([...f.files.keys()]).toEqual(["/cfg/token-mini"]);
  expect(await use.cancel("mini")).toEqual({ cancelled: "mini" });
  expect(f.files.size).toBe(0);
  expect(use.list()).toEqual([]);
});

test("review fixes: home folder, a host on 443, the release check in the connect command", () => {
  // "~/" must mean the home folder, never a literal folder named ~.
  const home = pasteCommand(checkEnrollRequest({ ...connect, dir: "~/" }), HASH);
  expect(home).toStartWith(`cd "$HOME" && `);
  expect(home).not.toContain("'~'");
  expect(shellWord("~")).toBe(`"$HOME"`);
  // https without a port is 443 and can be added; an explicit :443 means the same.
  expect(checkEnrollRequest({ ...connect, url: "https://mini.tail.ts.net" }).url).toBe("https://mini.tail.ts.net");
  expect(checkEnrollRequest({ ...connect, url: "https://mini.tail.ts.net:443" }).url).toBe("https://mini.tail.ts.net");
  expect(checkEnrollRequest({ ...fresh, url: "https://arch.tail.ts.net", port: 443 }).port).toBe(443);
  // A host on a release without the enroll script gets a clear message, not a Bun stack trace.
  // It must not use exit: a pasted exit would close the operator's own terminal.
  expect(home).toContain(`if [ -f scripts/enroll.ts ]; then bun scripts/enroll.ts connect `);
  expect(home).toEndWith(`; else echo "${MISSING}" >&2; false; fi`);
  expect(home).not.toContain("exit");
});

test("an unreachable host is a reason, not an error, and adds nothing", async () => {
  const f = fakeDeps({ whoami: async () => { throw new Error("certificate has expired"); } });
  const use = enrollUseCases(f.deps);
  await use.begin(connect);
  expect(await use.check("mini")).toEqual({ added: false, reason: "cannot reach https://mini.tail.ts.net:4871: certificate has expired" });
  expect(f.added).toEqual([]);
});

test("SSH runs the same command and its output never shows the token", async () => {
  const runs: unknown[] = [];
  const f = fakeDeps({ ssh: async (target, port, command) => { runs.push({ target, port, command }); return { code: 0, output: `done ${TOKEN}` }; } });
  const use = enrollUseCases(f.deps);
  const view = await use.begin({ ...connect, ssh: "me@mini", sshPort: 27022 });
  expect(await use.runSsh("mini")).toEqual({ code: 0, output: "done <token>" });
  expect(runs).toEqual([{ target: "me@mini", port: 27022, command: view.command }]);
  await use.begin({ ...connect, id: "nossh" });
  await expect(use.runSsh("nossh")).rejects.toThrow(/no SSH target/);
  const without = enrollUseCases(fakeDeps({ ssh: undefined }).deps);
  await expect(without.begin({ ...connect, ssh: "me@mini" })).rejects.toThrow(/cannot run SSH/);
});
