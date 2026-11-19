// The tailnet listener: refused unless it has auth and a certificate for the name clients dial.
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, parseTokens, tokenLine } from "./auth.ts";
import { tailnetOptionsFromEnv } from "./config.ts";

// Certificates made with openssl at test time; nothing here is a real host certificate.
const dir = await mkdtemp(join(tmpdir(), "config-tailnet-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
async function pair(name: string, san: string) {
  const cert = join(dir, `${name}.pem`), key = join(dir, `${name}-key.pem`);
  const p = Bun.spawn(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", "/CN=test",
    "-addext", `subjectAltName=${san}`, "-days", "30", "-keyout", key, "-out", cert], { stdout: "ignore", stderr: "ignore" });
  expect(await p.exited).toBe(0);
  return { cert, key };
}
const named = await pair("named", "DNS:box.tail.ts.net");
const other = await pair("other", "DNS:other.tail.ts.net");
const auth = new Auth(parseTokens(tokenLine("gw", "t")));
const base = { hostname: "192.168.50.4", auth, allowedHosts: ["lan:4871"] };
const env = (over: Record<string, string | undefined> = {}) => ({
  FLEET_CONTROL_TAILNET_HOST: "100.64.0.6", FLEET_CONTROL_TAILNET_NAME: "box.tail.ts.net",
  FLEET_CONTROL_TAILNET_TLS_CERT: named.cert, FLEET_CONTROL_TAILNET_TLS_KEY: named.key, ...over,
});
const quiet = () => {};

test("no tailnet variables means no second listener", async () => {
  expect(await tailnetOptionsFromEnv({}, base, 4871)).toBeUndefined();
});

test("a complete setting binds the tailnet IP with its own certificate, the same auth and the name for MCP", async () => {
  const opts = (await tailnetOptionsFromEnv(env(), base, 4871, undefined, new Date(), quiet))!;
  expect(opts.hostname).toBe("100.64.0.6");
  expect(opts.auth).toBe(auth);
  expect(opts.tls!.cert).toBe(await Bun.file(named.cert).text());
  expect(opts.allowedHosts).toEqual(["lan:4871", "box.tail.ts.net:4871"]);
});

test("a partial, unauthenticated or mismatched setting is refused before anything binds", async () => {
  const run = (e: Record<string, string | undefined>, b: object = base) => tailnetOptionsFromEnv(e, b, 4871, undefined, new Date(), quiet);
  await expect(run(env({ FLEET_CONTROL_TAILNET_HOST: undefined }))).rejects.toThrow("FLEET_CONTROL_TAILNET_HOST is required");
  await expect(run(env({ FLEET_CONTROL_TAILNET_NAME: undefined }))).rejects.toThrow("MagicDNS name");
  await expect(run(env(), { ...base, auth: undefined })).rejects.toThrow("needs FLEET_CONTROL_TOKENS");
  await expect(run(env({ FLEET_CONTROL_TAILNET_TLS_KEY: undefined }))).rejects.toThrow("needs FLEET_CONTROL_TAILNET_TLS_CERT");
  await expect(run(env({ FLEET_CONTROL_TAILNET_TLS_CERT: other.cert, FLEET_CONTROL_TAILNET_TLS_KEY: other.key }))).rejects.toThrow("does not name box.tail.ts.net");
  await expect(run(env({ FLEET_CONTROL_TAILNET_TLS_KEY: other.key }))).rejects.toThrow("does not match");
  await expect(run(env({ FLEET_CONTROL_TAILNET_HOST: "192.168.50.4" }))).rejects.toThrow("must differ");
});
