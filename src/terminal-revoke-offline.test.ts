import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, COOKIE, newToken, tokenLine } from "./auth.ts";
import { reloadTokens } from "./config.ts";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";

// Requests check the token each time, but a terminal socket is checked once, at the upgrade.
// A token reload must therefore close the sockets whose token was revoked or rotated, and only those.
const fleet = { screen: async () => "", status: async () => ({ sessions: [] }) } as never;
const alice = newToken(), bob = newToken(), alice2 = newToken();
let dir: string, tokens: string, auth: Auth;
let server: ReturnType<typeof serve>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "viewer-revoke-"));
  const bin = join(dir, "fleet");
  await writeFile(bin, '#!/bin/sh\n[ "$1" = help ] && { echo "fleet attach [--read-only] <session>"; exit 0; }\necho attached; exec sleep 30\n');
  await chmod(bin, 0o700);
  tokens = join(dir, "tokens");
  await writeFile(tokens, `${tokenLine("alice", alice)}\n${tokenLine("bob", bob)}\n`);
  auth = await Auth.fromFile(tokens);
  server = serve({ fleet, store: new Store(":memory:"), terminal: { fleetBin: bin, confPath: join(dir, "fleet.conf") } }, 0, { auth });
});
afterAll(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

const open = (token: string) => {
  const ws = new WebSocket(`ws://${new URL(server.url).host}/api/sessions/probe/terminal?cols=80&rows=24`, { headers: { origin: server.url.origin, cookie: `${COOKIE}=${token}` } } as never);
  const opened = new Promise<boolean>((resolve) => { ws.onopen = () => resolve(true); ws.onerror = () => resolve(false); });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => { ws.onclose = (e) => resolve({ code: e.code, reason: e.reason }); });
  return { ws, opened, closed };
};
const stillOpen = (v: ReturnType<typeof open>) => Promise.race([v.closed.then(() => false), Bun.sleep(300).then(() => true)]);

test("a reload closes terminals opened with a revoked or rotated token and keeps the others", async () => {
  const a = open(alice), b = open(bob);
  expect([await a.opened, await b.opened]).toEqual([true, true]);

  // A reload that changes nothing closes nothing.
  expect(await reloadTokens(auth, tokens, () => {})).toBe(true);
  expect(await stillOpen(a)).toBe(true);

  // Rotate alice, revoke nobody else.
  await writeFile(tokens, `${tokenLine("alice", alice2)}\n${tokenLine("bob", bob)}\n`);
  expect(await reloadTokens(auth, tokens, () => {})).toBe(true);
  expect(await a.closed).toEqual({ code: 1008, reason: "token revoked" });
  expect(await stillOpen(b)).toBe(true);

  // A refused reload keeps everything, then revoking bob closes his socket.
  await writeFile(tokens, "bob not-a-hash\n");
  expect(await reloadTokens(auth, tokens, () => {})).toBe(false);
  expect(await stillOpen(b)).toBe(true);
  await writeFile(tokens, `${tokenLine("alice", alice2)}\n`);
  expect(await reloadTokens(auth, tokens, () => {})).toBe(true);
  expect(await b.closed).toEqual({ code: 1008, reason: "token revoked" });

  // The new token opens a terminal; the old one is refused.
  const fresh = open(alice2);
  expect(await fresh.opened).toBe(true);
  expect(await open(alice).opened).toBe(false);
  fresh.ws.close();
  await fresh.closed;
});
