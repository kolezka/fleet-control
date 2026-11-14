// Loopback installer API for the client gateway. It reuses the CLI planner and executor.
// Plan and doctor are open to any local caller, like the rest of the gateway. Apply is not:
// the gateway has no login, so apply needs a per-process code kept in a private file.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { InstallerHandler } from "../client-gateway.ts";
import { doctor, execute } from "./execute.ts";
import { InstallError, parse, plan, prerequisites, type Context, type Plan, type Role } from "./plan.ts";

export type Job = { state: "idle" } | { state: "running" | "succeeded" | "failed"; role: Role; digest: string; startedAt: string; finishedAt?: string; message?: string };
export const localContext = (): Context => ({ code: realpathSync(resolve(import.meta.dir, "../..")), bun: process.execPath, home: homedir(), platform: process.platform, uid: process.getuid!() });

class Refusal extends Error {
  constructor(readonly status: number, readonly kind: string, message: string) { super(message); }
}
const refuse = (status: number, kind: string, message: string): never => { throw new Refusal(status, kind, message); };
const sha = (text: string) => createHash("sha256").update(text).digest();
const suppressed = "install prerequisite or configuration check failed; details suppressed";
const reason = (error: unknown) => error instanceof InstallError ? error.message : suppressed;
const fields = [["config", "--config"], ["state", "--state"], ["hostId", "--host-id"]] as const;

export async function createInstaller(context: Context, run: (proposed: Plan) => Promise<string> = proposed => execute(proposed)) {
  const dir = await mkdtemp(join(tmpdir(), "fleet-control-installer-"));
  const codePath = join(dir, "apply-code");
  const code = randomBytes(32).toString("hex");
  try {
    const file = await open(codePath, "wx", 0o600);
    try { await file.writeFile(code + "\n"); } finally { await file.close(); }
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const expected = sha(code);
  let job: Job = { state: "idle" };
  let pending: Promise<void> = Promise.resolve();

  // Only these fields reach the CLI parser: no SSH target and no other checkout or runtime.
  function build(input: Record<string, unknown>, apply: boolean): Plan {
    for (const key of Object.keys(input)) if (!["role", "config", "state", "hostId", "port"].includes(key)) refuse(400, "invalid", "unknown field");
    if (typeof input.role !== "string") refuse(400, "invalid", "role is required");
    const args = ["install", input.role as string, apply ? "--apply" : "--plan"];
    for (const [key, flag] of fields) {
      const value = input[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.length > 4096) refuse(400, "invalid", key + " must be a string");
      args.push(flag, value as string);
    }
    if (input.port !== undefined) {
      if (!Number.isInteger(input.port)) refuse(400, "invalid", "port must be an integer");
      args.push("--port", String(input.port));
    }
    return plan(parse(args, context), context);
  }
  // The digest covers the plan that would run, so apply cannot differ from the preview.
  const digestOf = (input: Record<string, unknown>) => sha(JSON.stringify(build(input, true))).toString("hex");
  function decode(bytes: Uint8Array | null): Record<string, unknown> {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes ?? new Uint8Array())); } catch { refuse(400, "invalid", "invalid JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) refuse(400, "invalid", "request must be a JSON object");
    return value as Record<string, unknown>;
  }

  const handle: InstallerHandler = async (method, path, bytes) => {
    try {
      if (method === "GET" && path === "") return { status: 200, body: { installer: { platform: context.platform, code: context.code, bun: context.bun, prerequisites }, job } };
      if (method === "GET" && path === "/job") return { status: 200, body: { job } };
      if (method !== "POST" || !["/plan", "/doctor", "/apply"].includes(path)) refuse(404, "not_found", "not found");
      const input = decode(bytes);
      if (path === "/doctor") {
        if (Object.keys(input).length) refuse(400, "invalid", "unknown field");
        try { return { status: 200, body: { ok: true, message: await doctor(plan(parse(["doctor"], context), context)) } }; }
        catch (error) { return { status: 200, body: { ok: false, message: reason(error) } }; }
      }
      if (path === "/plan") return { status: 200, body: { plan: build(input, false), digest: digestOf(input) } };
      const { code: given, digest, ...options } = input;
      if (typeof given !== "string" || !timingSafeEqual(sha(given), expected)) refuse(403, "forbidden", "apply code required; read it from the private file named when this gateway started");
      if (typeof digest !== "string" || digestOf(options) !== digest) refuse(409, "plan_changed", "plan differs from the preview; preview again");
      // One apply at a time, never retried here. The executor itself refuses existing artifacts.
      if (job.state === "running") refuse(409, "busy", "an apply is already running");
      const proposed = build(options, true);
      const started = { role: proposed.options.role!, digest: digest as string, startedAt: new Date().toISOString() };
      job = { state: "running", ...started };
      pending = run(proposed).then(
        message => { job = { state: "succeeded", ...started, finishedAt: new Date().toISOString(), message }; },
        error => { job = { state: "failed", ...started, finishedAt: new Date().toISOString(), message: reason(error) }; },
      );
      return { status: 202, body: { job } };
    } catch (error) {
      if (error instanceof Refusal) return { status: error.status, body: { error: { kind: error.kind, message: error.message } } };
      const known = error instanceof InstallError;
      return { status: known ? 400 : 500, body: { error: { kind: known ? "invalid" : "failed", message: reason(error) } } };
    }
  };
  return { handle, codePath, settled: () => pending, dispose: () => rm(dir, { recursive: true, force: true }) };
}
