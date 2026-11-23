// MacBook client gateway. A loopback-only Bun service that serves the web page and relays an
// allowlisted set of API routes to independent host services. It holds each host's bearer token
// server-side and keeps no host state: no queue, no command execution, no database.
//
// Trust model: the gateway has no login of its own. It is reachable only on 127.0.0.1, defends
// against DNS rebinding with an exact Host check, and refuses browser requests from other origins.
// Local processes, including other local users, can call it despite token file permissions.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const frameHeaders = { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" };
let pageBuild: Promise<Map<string, Response>> | undefined;

// Explicit asset responses let the approval page carry frame protection too.
function buildPage() {
  return pageBuild ??= Bun.build({
    entrypoints: ["index.html", "install.html", "add-host.html"].map((name) => resolve(import.meta.dir, "../web", name)), target: "browser", publicPath: "/",
  }).then((result) => {
    if (!result.success) throw new Error("client page build failed");
    return new Map(result.outputs.map((output) => {
      const name = output.path.split("/").at(-1)!;
      const path = output.kind === "entry-point" && name.endsWith(".html")
        ? (name === "install.html" ? "/install" : name === "add-host.html" ? "/add-host" : "/") : `/${name}`;
      return [path, new Response(output, { headers: { ...frameHeaders, "content-type": output.type } })];
    }));
  });
}

export class GatewayConfigError extends Error {}

export type SupervisorMapping = { hostId: string; session: string };
export type HostInfo = { id: string; name: string; origin: string; supervisor?: SupervisorMapping };

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const TOKEN = /^[A-Za-z0-9._~+\/=-]{1,512}$/;
const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/; // session names, command ids, request ids
const KEYS = new Set(["id", "name", "url", "tokenFile", "supervisor"]);

// Holds the tokens so they cannot end up in JSON output or logs by accident.
export class Credentials {
  readonly #tokens: Map<string, string>;
  constructor(tokens: Map<string, string>) {
    this.#tokens = tokens;
  }
  bearer(id: string): string | undefined {
    return this.#tokens.get(id);
  }
  // A host added from the page. An id or token already in use is refused, as at load.
  add(id: string, token: string) {
    if (this.#tokens.has(id)) throw new GatewayConfigError(`host id ${id} already has a token`);
    if (!TOKEN.test(token) || [...this.#tokens.values()].includes(token)) throw new GatewayConfigError(`host "${id}": token is malformed or shared`);
    this.#tokens.set(id, token);
  }
  // A rotated token for a host already here. The new token may not be another host's.
  replace(id: string, token: string) {
    if (!this.#tokens.has(id)) throw new GatewayConfigError(`no host ${id} in this gateway`);
    if (!TOKEN.test(token) || [...this.#tokens].some(([other, t]) => other !== id && t === token)) throw new GatewayConfigError(`host "${id}": token is malformed or shared`);
    this.#tokens.set(id, token);
  }
  // Undoes add when the config file could not be written, and forgets a removed host.
  remove(id: string) {
    this.#tokens.delete(id);
    for (const fn of this.#removed) fn(id);
  }
  // Told when a host's credential goes, so open terminal relays to it can close.
  readonly #removed = new Set<(id: string) => void>();
  onRemove(fn: (id: string) => void): () => void {
    this.#removed.add(fn);
    return () => this.#removed.delete(fn);
  }
  toJSON() {
    return {};
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return "Credentials {}";
  }
}

export type GatewayConfig = { hosts: HostInfo[]; credentials: Credentials; central?: { origin: string; credentials: Credentials } };
export type RawHost = HostInfo & { tokenFile: string };

function isLoopbackHostname(h: string): boolean {
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
}

function parseOrigin(url: unknown, at: string): string {
  if (typeof url !== "string") throw new GatewayConfigError(`${at}: url must be a string`);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new GatewayConfigError(`${at}: url is not a valid URL`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHostname(u.hostname))) {
    throw new GatewayConfigError(`${at}: url must be https (http is allowed only for loopback)`);
  }
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/" || url !== u.href && url !== u.origin) {
    throw new GatewayConfigError(`${at}: url must be an origin only (scheme, host, port)`);
  }
  return u.origin;
}

function parseSupervisor(raw: unknown): SupervisorMapping {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new GatewayConfigError("supervisor must be an object");
  const mapping = raw as Record<string, unknown>;
  if (Object.keys(mapping).some((key) => key !== "hostId" && key !== "session")) throw new GatewayConfigError("supervisor: unknown key");
  for (const key of ["hostId", "session"]) {
    const value = mapping[key];
    if (typeof value !== "string" || !value.isWellFormed() || !value.length || value.length > 256 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) throw new GatewayConfigError("supervisor: invalid hostId or session");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(mapping.session as string)) throw new GatewayConfigError("supervisor: invalid session");
  return { hostId: mapping.hostId as string, session: mapping.session as string };
}

export function parseGatewayCentralConfig(input: unknown, baseDir: string): { origin: string; tokenFile: string } | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new GatewayConfigError("config must be a JSON object");
  const raw = (input as Record<string, unknown>).central;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new GatewayConfigError("central must be an object");
  const central = raw as Record<string, unknown>;
  if (Object.keys(central).some((key) => key !== "url" && key !== "tokenFile")) throw new GatewayConfigError("central: unknown key");
  const origin = parseOrigin(central.url, "central");
  if (typeof central.tokenFile !== "string" || !central.tokenFile.trim()) throw new GatewayConfigError("central: tokenFile must be a non-empty string");
  return { origin, tokenFile: resolve(baseDir, central.tokenFile) };
}

async function readCentralToken(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.size > 1024) throw new Error();
    const token = (await file.readFile("utf8")).trim();
    if (!TOKEN.test(token)) throw new Error();
    return token;
  } catch {
    throw new GatewayConfigError("central: tokenFile must be an owned private regular nonsymlink 0600 file holding one valid token");
  } finally {
    await file?.close();
  }
}

// Pure validation. Token files are read separately so this can be tested without a disk.
// An empty host list is allowed only when the caller can add hosts later (FLEET_CONTROL_ENROLL=1).
export type GatewayConfigRules = { allowNoHosts?: boolean };

export function parseGatewayConfig(input: unknown, baseDir: string, rules: GatewayConfigRules = {}): RawHost[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new GatewayConfigError("config must be a JSON object");
  const top = input as Record<string, unknown>;
  for (const k of Object.keys(top)) if (k !== "hosts" && k !== "central") throw new GatewayConfigError(`config: unknown key "${k}"`);
  if (!Array.isArray(top.hosts)) throw new GatewayConfigError("config: hosts must be an array");
  if (top.hosts.length === 0 && !rules.allowNoHosts) {
    throw new GatewayConfigError("config: hosts must be a non-empty array (an empty list needs FLEET_CONTROL_ENROLL=1, to add the first host from the page)");
  }
  const central = parseGatewayCentralConfig(input, baseDir);
  const seen = new Set<string>();
  return top.hosts.map((raw, i): RawHost => {
    const at = `hosts[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new GatewayConfigError(`${at}: must be an object`);
    const h = raw as Record<string, unknown>;
    for (const k of Object.keys(h)) if (!KEYS.has(k)) throw new GatewayConfigError(`${at}: unknown key "${k}"`);
    if (typeof h.id !== "string" || !ID.test(h.id)) throw new GatewayConfigError(`${at}: id must match ${ID}`);
    if (seen.has(h.id)) throw new GatewayConfigError(`${at}: duplicate id "${h.id}"`);
    seen.add(h.id);
    // eslint-disable-next-line no-control-regex
    if (typeof h.name !== "string" || h.name.trim().length === 0 || h.name.length > 80 || /[\u0000-\u001f\u007f]/.test(h.name)) {
      throw new GatewayConfigError(`${at}: name must be 1-80 printable characters`);
    }
    const origin = parseOrigin(h.url, at);
    if (typeof h.tokenFile !== "string" || h.tokenFile.length === 0) throw new GatewayConfigError(`${at}: tokenFile must be a non-empty string`);
    const tokenFile = isAbsolute(h.tokenFile) ? h.tokenFile : resolve(baseDir, h.tokenFile);
    const supervisor = h.supervisor === undefined ? undefined : parseSupervisor(h.supervisor);
    if (supervisor && !central) throw new GatewayConfigError(`${at}: supervisor requires central`);
    return { id: h.id, name: h.name.trim(), origin, tokenFile, ...(supervisor ? { supervisor } : {}) };
  });
}

export async function loadGatewayConfig(path: string, rules: GatewayConfigRules = {}): Promise<GatewayConfig> {
  const abs = resolve(path);
  let json: unknown;
  try {
    json = JSON.parse(await Bun.file(abs).text());
  } catch (e) {
    throw new GatewayConfigError(`cannot read config ${abs}: ${e instanceof SyntaxError ? "not valid JSON" : "unreadable"}`);
  }
  const raw = parseGatewayConfig(json, dirname(abs), rules);
  const tokens = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const h of raw) {
    let text: string;
    try {
      text = await Bun.file(h.tokenFile).text();
    } catch {
      throw new GatewayConfigError(`host "${h.id}": cannot read tokenFile ${h.tokenFile}`);
    }
    const token = text.trim();
    // Never echo token content, only the fact that it is malformed.
    if (!TOKEN.test(token)) throw new GatewayConfigError(`host "${h.id}": tokenFile must hold one token without spaces or line breaks`);
    const other = owners.get(token);
    if (other) throw new GatewayConfigError(`hosts "${other}" and "${h.id}" share one token; use a separate token per host`);
    owners.set(token, h.id);
    tokens.set(h.id, token);
  }
  const central = parseGatewayCentralConfig(json, dirname(abs));
  let centralConfig: GatewayConfig["central"];
  if (central) {
    const token = await readCentralToken(central.tokenFile);
    if (owners.has(token)) throw new GatewayConfigError("central and host credentials must not share one token");
    centralConfig = { origin: central.origin, credentials: new Credentials(new Map([["operator", token]])) };
  }
  return { hosts: raw.map(({ tokenFile, ...host }) => host), credentials: new Credentials(tokens), ...(centralConfig ? { central: centralConfig } : {}) };
}

// ---------------------------------------------------------------------------------------------

export type GatewayOptions = {
  port?: number; // default 4870; 0 picks a free port
  timeoutMs?: number; // per upstream request, default 10 s
  maxRequestBytes?: number; // default 64 KiB (MCP gets 4x)
  maxResponseBytes?: number; // default 8 MiB
  maxPreOpenBytes?: number; // terminal bytes held while the browser socket opens, default 1 MiB
  maxFrameBytes?: number; // one terminal frame, default 1 MiB
  log?: (line: string) => void;
  installer?: InstallerHandler; // local installer API and page; off unless supplied
  enroll?: EnrollHandler; // adding hosts from the page; off unless supplied
  manage?: EnrollHandler; // rotating this gateway's token for a host and removing hosts; off unless supplied
};
// Handles /api/enroll after the same Host, Origin and body checks as the installer.
export type EnrollHandler = (method: string, path: string, body: Uint8Array | null) => Promise<{ status: number; body: unknown }>;
// Handles /api/install after the gateway's Host, Origin and body checks. path is the part after /api/install.
export type InstallerHandler = (method: string, path: string, body: Uint8Array | null) => Promise<{ status: number; body: unknown }>;

type Target =
  | { kind: "http"; upstream: string; methods: string[]; query: Record<string, RegExp>; timeoutMs?: number }
  | { kind: "ws"; upstream: string; query: Record<string, RegExp> }
  | { kind: "mcp" };

const NUM = /^[0-9]{1,4}$/;
// fleet start waits up to 90 s for an agent's UI, after which the host answers; leave room above that.
export const RESTART_TIMEOUT_MS = 180_000;
// Keyset paging on the host lists: the host checks the range and the cursor itself.
const PAGE_QUERY = { limit: NUM, cursor: /^[A-Za-z0-9_-]{1,4096}$/ };

// The allowlist. Anything not matched here is a 404; nothing else is forwarded.
function matchRoute(seg: string[]): Target | null {
  const [a, b, c] = seg;
  const ok = (s: string | undefined): s is string => s !== undefined && SEGMENT.test(s) && !/^\.+$/.test(s);
  const http = (upstream: string, methods: string[], query: Record<string, RegExp> = {}): Extract<Target, { kind: "http" }> => ({
    kind: "http", upstream, methods, query,
  });
  if (seg.length === 1 && a === "sessions") return http("/api/sessions", ["GET"]);
  if (seg.length === 3 && a === "sessions" && ok(b) && c === "screen") return http(`/api/sessions/${b}/screen`, ["GET"], { lines: NUM });
  if (seg.length === 3 && a === "sessions" && ok(b) && c === "terminal") return { kind: "ws", upstream: `/api/sessions/${b}/terminal`, query: { cols: NUM, rows: NUM } };
  if (seg.length === 3 && a === "sessions" && ok(b) && c === "lease") return http(`/api/sessions/${b}/lease`, ["POST", "DELETE"], { reason: /^[^\x00-\x1f\x7f]{1,200}$/ });
  if (seg.length === 1 && a === "leases") return http("/api/leases", ["GET"]);
  if (seg.length === 1 && a === "commands") return http("/api/commands", ["GET", "POST"], { ...PAGE_QUERY, latest: NUM });
  if (seg.length === 3 && a === "commands" && ok(b) && c === "cooperative") return http(`/api/commands/${b}/cooperative`, ["GET"]);
  if (seg.length === 2 && a === "commands" && ok(b)) return http(`/api/commands/${b}`, ["GET"]);
  if (seg.length === 1 && a === "requests") return http("/api/requests", ["GET"], { ...PAGE_QUERY, view: /^current$/ });
  if (seg.length === 3 && a === "requests" && ok(b) && c === "resolve") return http(`/api/requests/${b}/resolve`, ["POST"]);
  if (seg.length === 1 && a === "agents") return http("/api/agents", ["GET", "POST"]);
  if (seg.length === 3 && a === "agents" && ok(b) && c === "stop") return http(`/api/agents/${b}/stop`, ["POST"]);
  if (seg.length === 2 && a === "fleet" && b === "conf") return http("/api/fleet/conf", ["GET", "PUT"]);
  if (seg.length === 2 && a === "fleet" && b === "sessions") return http("/api/fleet/sessions", ["GET"]);
  if (seg.length === 3 && a === "sessions" && ok(b) && c === "start") return http(`/api/sessions/${b}/start`, ["PUT", "DELETE"], { confirm: /^[A-Za-z0-9._-]{1,64}$/ });
  if (seg.length === 2 && a === "fleet" && b === "logs") return http("/api/fleet/logs", ["GET"], { source: /^[a-z]{1,16}$/, lines: NUM });
  // A restart waits for the session to start again, which for an agent can take minutes.
  if (seg.length === 3 && a === "sessions" && ok(b) && c === "restart") return { ...http(`/api/sessions/${b}/restart`, ["POST"]), timeoutMs: RESTART_TIMEOUT_MS };
  // The host's tokens file. The gateway's own line changes only through /api/manage, never from here.
  if (seg.length === 1 && a === "tokens") return http("/api/tokens", ["GET"]);
  if (seg.length === 3 && a === "tokens" && ok(b) && (c === "rotate" || c === "revoke")) return http(`/api/tokens/${b}/${c}`, ["POST"]);
  if (seg.length === 1 && a === "mcp") return { kind: "mcp" };
  return null;
}

type ErrExtra = { host?: string; outcome?: "unknown"; upstreamStatus?: number };
function fail(status: number, kind: string, message: string, extra: ErrExtra = {}, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { kind, message, ...extra } }, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers } });
}

async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n) + "…" : s);
const PASS_STATUS = new Set([400, 404, 409, 413, 422, 429]);
const HEADER_VALUE = /^[\x20-\x7e]{1,200}$/;

type Relay = {
  host: string;
  up: WebSocket;
  client: Bun.ServerWebSocket<Relay> | null;
  queue: (string | ArrayBuffer)[];
  queued: number;
  upClosed: { code: number; reason: string } | null;
  done: boolean;
};

const closeCode = (c: number) => ([1000, 1001, 1008, 1009, 1011, 1012, 1013].includes(c) ? c : 1011);
// The host's close reason (e.g. "token revoked") tells the page why; only short printable text passes.
const closeReason = (r: string) => (/^[\x20-\x7e]{1,120}$/.test(r) ? r : "upstream closed");

export function startGateway(config: GatewayConfig, opts: GatewayOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  // Open terminal relays, so a host removed from the page loses them at once.
  const relays = new Set<Relay>();
  const offRemove = config.credentials.onRemove((id) => { for (const r of [...relays]) if (r.host === id) teardown(r, 1001, "host removed from the gateway"); });
  const maxReq = opts.maxRequestBytes ?? 64 * 1024;
  const maxRes = opts.maxResponseBytes ?? 8 * 1024 * 1024;
  const maxPre = opts.maxPreOpenBytes ?? 1024 * 1024;
  const maxFrame = opts.maxFrameBytes ?? 1024 * 1024;
  const log = opts.log ?? (() => {});
  // Hosts added from the page land in config.hosts, so look them up there each time.
  const hosts = { get: (id: string) => config.hosts.find((h) => h.id === id) };
  let allowedHosts = new Set<string>();

  // Every outcome here is for one request on one host; nothing is shared between hosts.
  async function proxyHttp(req: Request, host: HostInfo, route: Extract<Target, { kind: "http" }> | { kind: "mcp" }, url: URL, central = false): Promise<Response> {
    const write = req.method !== "GET";
    const mcp = route.kind === "mcp";
    const upstreamOrigin = central ? config.central?.origin : host.origin;
    const token = central ? config.central?.credentials.bearer("operator") : config.credentials.bearer(host.id);
    if (!token || !upstreamOrigin) return fail(502, "upstream_unconfigured", "host has no credentials", { host: host.id });

    // Build the upstream URL from validated parts only.
    let path = mcp ? "/mcp" : route.upstream;
    if (!mcp) {
      const q = new URLSearchParams();
      for (const [k, re] of Object.entries(route.query)) {
        const v = url.searchParams.get(k);
        if (v === null) continue;
        if (!re.test(v)) return fail(400, "invalid", `bad query parameter ${k}`);
        q.set(k, v);
      }
      if (q.size) path += `?${q}`;
    }

    const headers = new Headers({ authorization: `Bearer ${token}`, ...(!central ? { origin: host.origin } : {}) });
    let body: Uint8Array | undefined;
    // A DELETE carries no body, so it needs no content type; one that sends a body is refused.
    if (write && req.method === "DELETE") {
      if (req.body !== null || Number(req.headers.get("content-length") ?? 0) > 0) return fail(400, "invalid", "a DELETE takes no body");
    } else if (write) {
      const ctype = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (ctype !== "application/json") return fail(415, "unsupported_media_type", "content-type must be application/json");
      const limit = mcp ? maxReq * 4 : maxReq;
      const declared = Number(req.headers.get("content-length") ?? 0);
      if (declared > limit) return fail(413, "too_large", "request body too large");
      const read = await readBounded(req.body, limit);
      if (!read) return fail(413, "too_large", "request body too large");
      body = read;
      headers.set("content-type", "application/json");
    }
    headers.set("accept", mcp ? "application/json, text/event-stream" : "application/json");
    if (mcp) {
      for (const k of ["accept", "mcp-protocol-version", "mcp-session-id"]) {
        const v = req.headers.get(k);
        if (v && HEADER_VALUE.test(v)) headers.set(k, v);
      }
    }

    let res: Response;
    let bytes: Uint8Array | null;
    try {
      res = await fetch(upstreamOrigin + path, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(!mcp && route.timeoutMs ? route.timeoutMs : timeoutMs),
        // A write must never be replayed by the HTTP client on a stale pooled connection.
        ...(write ? { keepalive: false } : {}),
        ...(upstreamOrigin.startsWith("https:") ? { tls: { rejectUnauthorized: true } } : {}),
      } as RequestInit);
      bytes = await readBounded(res.body, maxRes);
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      log(`host ${host.id}: upstream ${timedOut ? "timeout" : "unreachable"} (${req.method} ${mcp ? "mcp" : route.upstream.replace(/\/[^/]+$/, "/…")})`);
      // For a write the request may have reached the host, so the outcome is not known.
      const extra: ErrExtra = { host: host.id, ...(write ? { outcome: "unknown" as const } : {}) };
      return timedOut
        ? fail(504, "upstream_timeout", write ? "host did not answer in time; the write may or may not have been applied" : "host did not answer in time", extra)
        : fail(502, "upstream_unreachable", write ? "host unreachable; the write may or may not have been applied" : "host unreachable", extra);
    }
    if (!bytes) return fail(502, "upstream_too_large", "host response too large", { host: host.id, ...(write ? { outcome: "unknown" as const } : {}) });

    if (central) {
      const text = new TextDecoder().decode(bytes);
      let decoded = "";
      try { decoded = JSON.stringify(JSON.parse(text)); } catch {
        if (res.ok) return fail(502, "upstream_malformed", "invalid central JSON", { host: host.id, ...(write ? { outcome: "unknown" as const } : {}) });
      }
      const secrets = [token, ...config.hosts.map((h) => config.credentials.bearer(h.id)).filter((value): value is string => !!value)];
      if (secrets.some((secret) => text.includes(secret) || decoded.includes(secret))) return fail(502, "upstream_malformed", "unsafe central response", { host: host.id, ...(write ? { outcome: "unknown" as const } : {}) });
    }
    const st = res.status;
    const ctype = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const unknownIfWrite: ErrExtra = { host: host.id, upstreamStatus: st, ...(write ? { outcome: "unknown" as const } : {}) };
    if (st >= 300 && st < 400) return fail(502, "upstream_redirect", "host answered with a redirect; not followed", unknownIfWrite);
    if (st === 401) return fail(502, "upstream_unauthorized", "host rejected the gateway credentials", { host: host.id, upstreamStatus: st });
    if (st === 403) return fail(502, "upstream_forbidden", "host refused the request", { host: host.id, upstreamStatus: st });
    if (st >= 500) return fail(502, "upstream_error", "host reported an internal error", unknownIfWrite);

    const out = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } as Record<string, string>;
    if (st >= 200 && st < 300) {
      if (bytes.byteLength === 0 && mcp && (st === 202 || st === 204)) return new Response(null, { status: st, headers: out });
      if (ctype !== "application/json") return fail(502, "upstream_malformed", "host answered with an unexpected content type", unknownIfWrite);
      const sid = res.headers.get("mcp-session-id");
      if (mcp && sid && HEADER_VALUE.test(sid)) out["mcp-session-id"] = sid;
      return new Response(bytes as unknown as BodyInit, { status: st, headers: out });
    }
    if (central) return fail(PASS_STATUS.has(st) ? st : 502, "upstream_rejected", "central rejected the request", { host: host.id, upstreamStatus: st });

    // 4xx the host meant for the caller: keep the status and the error kind, drop everything else.
    if (PASS_STATUS.has(st) && ctype === "application/json") {
      try {
        const j = JSON.parse(new TextDecoder().decode(bytes)) as any;
        if (mcp && typeof j?.error?.code === "number") {
          return Response.json({ jsonrpc: "2.0", id: j.id ?? null, error: { code: j.error.code, message: clip(String(j.error.message ?? "")) } }, { status: st, headers: out });
        }
        if (typeof j?.error?.kind === "string" && typeof j.error.message === "string") {
          return fail(st, clip(j.error.kind, 64), clip(j.error.message), { host: host.id });
        }
      } catch {
        // fall through to the generic answer
      }
    }
    return fail(502, "upstream_rejected", "host rejected the request", { host: host.id, upstreamStatus: st });
  }

  async function proxyCentral(req: Request, host: HostInfo, route: Extract<Target, { kind: "http" }>, url: URL): Promise<Response> {
    const mapping = host.supervisor!;
    const list = route.upstream === "/api/commands" && req.method === "GET";
    const inspection = route.upstream.endsWith("/cooperative");
    const query = new URLSearchParams();
    for (const [key, value] of url.searchParams) {
      if ((!list && !inspection) || (key !== "limit" && key !== "cursor") || url.searchParams.getAll(key).length !== 1) return fail(400, "invalid", "unknown or duplicate query parameter");
      if (key === "limit" && !/^[1-4]$/.test(value) || key === "cursor" && (!value.length || value.length > 8192)) return fail(400, "invalid", "invalid query parameter");
      if (inspection && key === "cursor" && (!/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n)) return fail(400, "invalid", "invalid inspection cursor");
      query.set(key, value);
    }
    if (list) {
      query.set("hostId", mapping.hostId);
      query.set("target", mapping.session);
      if (!query.has("limit")) query.set("limit", "4");
    }
    let forwarded = req;
    let submitted: { text: string; idempotencyKey: string } | undefined;
    if (req.method === "POST") {
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") ?? "")) return fail(415, "unsupported_media_type", "content-type must be application/json");
      if (Number(req.headers.get("content-length") ?? 0) > maxReq) return fail(413, "too_large", "request body too large");
      const bytes = await readBounded(req.body, maxReq);
      if (!bytes) return fail(413, "too_large", "request body too large");
      let input: unknown;
      try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { return fail(400, "invalid", "invalid command JSON"); }
      if (!input || typeof input !== "object" || Array.isArray(input)) return fail(400, "invalid", "invalid command");
      const body = input as Record<string, unknown>;
      if (Object.keys(body).some((key) => !["target", "text", "idempotencyKey"].includes(key)) || body.target !== mapping.session || typeof body.text !== "string" || !body.text.trim() || body.text.length > 4000 || typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 200) return fail(400, "invalid", "invalid command");
      submitted = { text: body.text, idempotencyKey: body.idempotencyKey };
      forwarded = new Request(req.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, hostId: mapping.hostId }) });
    }
    const centralUrl = new URL(url);
    centralUrl.search = query.toString();
    const centralRoute = { ...route, query: Object.fromEntries([...query.keys()].map((key) => [key, /^[\s\S]*$/])) };
    const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
    const scoped = (command: unknown): command is Record<string, unknown> => record(command) && command.hostId === mapping.hostId && command.target === mapping.session;
    const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value.isWellFormed() && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
    const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
    const timestamp = (value: unknown): boolean => typeof value === "string" && value.length <= 32 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
    const commandId = route.upstream.replace(/\/cooperative$/, "").split("/").at(-1);
    if (inspection || route.upstream !== "/api/commands") {
      // The ownership read is not an event page and must not receive its cursor.
      const getRoute = { ...centralRoute, upstream: route.upstream.replace(/\/cooperative$/, ""), query: {} };
      const ownershipUrl = new URL(centralUrl);
      ownershipUrl.search = "";
      const response = await proxyHttp(new Request(req.url), host, getRoute, ownershipUrl, true);
      if (!response.ok) return response;
      let body: unknown;
      try { body = await response.clone().json(); } catch { return fail(502, "upstream_malformed", "invalid central command"); }
      if (!body || typeof body !== "object" || !scoped((body as Record<string, unknown>).command)) return fail(403, "forbidden", "command is outside configured supervisor scope");
      const command = (body as Record<string, unknown>).command as Record<string, unknown>;
      if (command.id !== commandId) return fail(502, "upstream_malformed", "central command ID mismatch", { host: host.id });
      if (!inspection) return response;
    }
    const response = await proxyHttp(forwarded, host, centralRoute, centralUrl, true);
    if (response.ok) {
      const body = await response.clone().json();
      const malformed = () => fail(502, "upstream_malformed", "invalid central response", { host: host.id, ...(submitted ? { outcome: "unknown" as const } : {}) });
      if (list) {
        if (!Array.isArray(body?.commands) || body.commands.length > Number(query.get("limit")) || !body.commands.every(scoped) || !(body.nextCursor === null || typeof body.nextCursor === "string" && body.nextCursor.length <= 8192)) return malformed();
      } else {
        if (!scoped(body?.command) || !validId(body.command.id)) return malformed();
        if (submitted && (body.command.text !== submitted.text || body.command.idempotencyKey !== submitted.idempotencyKey)) return malformed();
        if (inspection) {
          if (body.command.id !== commandId || !Array.isArray(body.events) || body.events.length > Number(query.get("limit") ?? 4)) return malformed();
          const claim = body.claim;
          if (claim !== null && (!record(claim) || !validId(claim.incarnationId) || !validId(claim.requestId) || typeof claim.incarnationActive !== "boolean" || typeof claim.settled !== "boolean" || !timestamp(claim.createdAt))) return malformed();
          let previous = BigInt(query.get("cursor") ?? "0");
          for (const event of body.events) {
            if (!record(event) || !decimal(event.seq) || BigInt(event.seq) <= previous || !validId(event.requestId) || !["accepted", "rejected", "running", "completed", "failed"].includes(event.status as string) || typeof event.detail !== "string" || event.detail.length > 65536 || !event.detail.isWellFormed() || event.detail.includes("\0") || !timestamp(event.at)) return malformed();
            previous = BigInt(event.seq);
          }
          if (body.nextCursor !== null && (!decimal(body.nextCursor) || body.events.length !== Number(query.get("limit") ?? 4) || body.nextCursor !== body.events.at(-1)?.seq)) return malformed();
        }
      }
    }
    return response;
  }

  // Opens the upstream terminal socket. Resolves null on any failure; never throws.
  function connectUpstream(host: HostInfo, token: string, path: string): Promise<Relay | null> {
    return new Promise((done) => {
      const relay: Relay = { host: host.id, up: undefined as never, client: null, queue: [], queued: 0, upClosed: null, done: false };
      let opened = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(host.origin.replace(/^http/, "ws") + path, { headers: { authorization: `Bearer ${token}`, origin: host.origin } } as never);
      } catch {
        return done(null);
      }
      relay.up = ws;
      ws.binaryType = "arraybuffer";
      const timer = setTimeout(() => {
        if (opened) return;
        ws.close();
        done(null);
      }, timeoutMs);
      // Handlers go on before open resolves so frames that follow the handshake are never lost.
      ws.onmessage = (e) => {
        const data = e.data as string | ArrayBuffer;
        const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
        if (size > maxFrame) return teardown(relay, 1009, "frame too large");
        const c = relay.client;
        if (c) return forward(relay, c, data);
        relay.queued += size;
        if (relay.queued > maxPre) return teardown(relay, 1013, "client not ready");
        relay.queue.push(data);
      };
      ws.onopen = () => {
        opened = true;
        relays.add(relay);
        clearTimeout(timer);
        done(relay);
      };
      ws.onerror = () => {};
      ws.onclose = (e) => {
        clearTimeout(timer);
        // The host revoked the gateway's own token, not the browser's, so signing in again would not help.
        const reason = e.code === 1008 && e.reason === "token revoked" ? "gateway token revoked" : closeReason(e.reason);
        relay.upClosed = { code: e.code, reason };
        relays.delete(relay);
        if (!opened) return done(null);
        relay.client?.close(closeCode(e.code), relay.upClosed.reason);
      };
    });
  }

  function forward(relay: Relay, client: Bun.ServerWebSocket<Relay>, data: string | ArrayBuffer) {
    // -1 means queued behind a slow reader; Bun closes the socket at backpressureLimit.
    const sent = typeof data === "string" ? client.sendText(data) : client.sendBinary(new Uint8Array(data));
    if (sent === 0) teardown(relay, 1011, "client connection lost");
  }

  function teardown(relay: Relay, code: number, reason: string) {
    relays.delete(relay);
    if (relay.done) return;
    relay.done = true;
    try { relay.up.close(1000); } catch { /* already closed */ }
    try { relay.client?.close(code, reason); } catch { /* already closed */ }
  }

  const server = Bun.serve<Relay, "/">({
    hostname: "127.0.0.1",
    port: opts.port ?? 4870,
    // The static page holds no secret. Every /api call below is Host- and Origin-checked.
    websocket: {
      // Room for one 4 KiB input message; the host refuses anything bigger and anything without a lease.
      maxPayloadLength: 4096,
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(ws) {
        const relay = ws.data;
        relay.client = ws;
        for (const m of relay.queue.splice(0)) forward(relay, ws, m);
        relay.queued = 0;
        if (relay.upClosed) ws.close(closeCode(relay.upClosed.code), relay.upClosed.reason);
      },
      // Keys go to the host, which types them only for the socket holding the input lease and closes any other.
      // Text frames are never input, so they still end the socket here.
      message(ws, message) {
        const relay = ws.data;
        if (typeof message === "string") return teardown(relay, 1008, "read-only terminal: client messages are not accepted");
        if (relay.up.readyState !== WebSocket.OPEN) return teardown(relay, 1011, "host connection lost");
        relay.up.send(message);
      },
      close(ws) {
        ws.data.client = null;
        teardown(ws.data, 1000, "client closed");
      },
    },
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "method_not_allowed", "method not allowed");
        const off = (url.pathname === "/install" && !opts.installer) || (url.pathname === "/add-host" && !opts.enroll);
        const asset = off ? undefined : (await buildPage()).get(url.pathname);
        if (!asset) return fail(404, "not_found", "not found");
        return req.method === "HEAD" ? new Response(null, { headers: asset.headers }) : asset.clone();
      }

      // DNS rebinding: the Host header must be exactly this listener, never an attacker's name.
      const hostHeader = req.headers.get("host") ?? "";
      if (!allowedHosts.has(hostHeader)) return fail(403, "forbidden", "unexpected Host header");
      const site = req.headers.get("sec-fetch-site");
      if (site !== null && site !== "same-origin" && site !== "none") return fail(403, "forbidden", "cross-site request");
      const origin = req.headers.get("origin");
      if (origin !== null && origin !== `http://${hostHeader}`) return fail(403, "forbidden", "cross-origin request");

      if (url.pathname === "/api/hosts") {
        if (req.method !== "GET") return fail(405, "method_not_allowed", "method not allowed", {}, { allow: "GET" });
        return Response.json(
          { hosts: config.hosts.map((h) => ({ id: h.id, name: h.name, apiBase: `/api/hosts/${h.id}`, ...(h.supervisor ? { supervisor: h.supervisor } : {}) })), ...(opts.installer ? { installer: true } : {}), ...(opts.enroll ? { enroll: true } : {}), ...(opts.manage ? { manage: true } : {}) },
          { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
        );
      }

      const under = (p: string) => url.pathname === p || url.pathname.startsWith(`${p}/`);
      const prefix = under("/api/enroll") ? "/api/enroll" : under("/api/manage") ? "/api/manage" : under("/api/install") ? "/api/install" : null;
      if (prefix) {
        const handler = prefix === "/api/enroll" ? opts.enroll : prefix === "/api/manage" ? opts.manage : opts.installer;
        if (!handler) return fail(404, "not_found", "not found");
        if (req.method !== "GET" && req.method !== "POST") return fail(405, "method_not_allowed", "method not allowed", {}, { allow: "GET, POST" });
        if (url.search) return fail(400, "invalid", "query parameters are not accepted");
        let bytes: Uint8Array | null = null;
        if (req.method === "POST") {
          // The installer and enrollment change this machine, so a write must come from the page this gateway served.
          if (origin === null) return fail(403, "forbidden", "Origin required for writes");
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") ?? "")) return fail(415, "unsupported_media_type", "content-type must be application/json");
          if (Number(req.headers.get("content-length") ?? 0) > maxReq) return fail(413, "too_large", "request body too large");
          bytes = await readBounded(req.body, maxReq);
          if (!bytes) return fail(413, "too_large", "request body too large");
        }
        const reply = await handler(req.method, url.pathname.slice(prefix.length), bytes);
        return Response.json(reply.body, { status: reply.status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      }

      const m = /^\/api\/hosts\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (!m || m[2]!.includes("%") || m[2]!.includes("\\")) return fail(404, "not_found", "not found");
      const route = matchRoute(m[2]!.split("/"));
      const host = hosts.get(m[1]!);
      if (!route || !host) return fail(404, "not_found", "not found");

      if (host.supervisor && (route.kind === "mcp" || m[2]!.startsWith("requests"))) return fail(501, "unsupported", "legacy requests and MCP are unsupported for central supervisors");
      if (!host.supervisor && m[2]!.endsWith("/cooperative")) return fail(404, "not_found", "not found");

      if (route.kind === "ws") {
        if (req.method !== "GET") return fail(405, "method_not_allowed", "method not allowed", {}, { allow: "GET" });
        // A browser always sends Origin on a WebSocket handshake; a missing one is not a page we served.
        if (origin === null) return fail(403, "forbidden", "Origin required");
        if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return fail(400, "invalid", "expected a WebSocket upgrade");
        const q = new URLSearchParams();
        for (const [k, re] of Object.entries(route.query)) {
          const v = url.searchParams.get(k);
          if (v === null) continue;
          if (!re.test(v)) return fail(400, "invalid", `bad query parameter ${k}`);
          q.set(k, v);
        }
        const token = config.credentials.bearer(host.id);
        const relay = token ? await connectUpstream(host, token, route.upstream + (q.size ? `?${q}` : "")) : null;
        if (!relay) {
          log(`host ${host.id}: terminal upstream unavailable`);
          return fail(502, "upstream_unreachable", "host terminal unavailable", { host: host.id });
        }
        if (srv.upgrade(req, { data: relay })) return undefined;
        relay.up.close(1000);
        return fail(400, "upgrade_failed", "expected a WebSocket upgrade");
      }

      if (route.kind === "mcp") {
        // Non-browser MCP clients send no Origin, so it is optional here; a browser always sends
        // one on POST, and a wrong one was refused above.
        if (req.method !== "POST") return fail(405, "method_not_allowed", "method not allowed", {}, { allow: "POST" });
        return proxyHttp(req, host, route, url);
      }

      if (!route.methods.includes(req.method)) return fail(405, "method_not_allowed", "method not allowed", {}, { allow: route.methods.join(", ") });
      // Browser writes must come from the page this gateway served.
      if (req.method !== "GET" && origin === null) return fail(403, "forbidden", "Origin required for writes");
      if (host.supervisor && route.upstream.startsWith("/api/commands")) return proxyCentral(req, host, route, url);
      // Bun drops a connection idle for 10 s; a long route keeps it open as long as it waits upstream.
      if (route.timeoutMs) srv.timeout(req, Math.ceil(route.timeoutMs / 1000) + 10);
      return proxyHttp(req, host, route, url);
    },
  });

  allowedHosts = new Set([`127.0.0.1:${server.port}`, `localhost:${server.port}`]);
  const stop = server.stop.bind(server);
  server.stop = ((closeActive?: boolean) => { offRemove(); return stop(closeActive); }) as typeof server.stop;
  return server;
}
