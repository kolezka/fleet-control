// Service settings an operator keeps in a file the service reads at start. The file holds only what was set
// from the page; anything it leaves out keeps the value from the service's environment (plist or unit).
// FLEET_CONTROL_ADMIN is not here: turning it off from the page would cut the page off.
import { CLAUDE_MODEL, DSH_MODEL } from "./agents.ts";
import { AdminError } from "./fleet-admin.ts";

export type ServiceSettings = {
  agentRoots?: string[];
  agentModels?: string[];
  agentDshModels?: string[];
  agentMcpUrl?: string | null;
  input?: boolean;
};
export const SETTING_KEYS = ["agentRoots", "agentModels", "agentDshModels", "agentMcpUrl", "input"] as const;
export const SETTINGS_CONFIRM = "settings";
// The environment variable each setting stands in for.
export const SETTING_ENV: Record<(typeof SETTING_KEYS)[number], string> = {
  agentRoots: "FLEET_CONTROL_AGENT_ROOTS",
  agentModels: "FLEET_CONTROL_AGENT_MODELS",
  agentDshModels: "FLEET_CONTROL_AGENT_DSH_MODELS",
  agentMcpUrl: "FLEET_CONTROL_AGENT_MCP_URL",
  input: "FLEET_CONTROL_INPUT",
};
const ROOT = /^\/[A-Za-z0-9._\/-]+$/;
const MAX_ITEMS = 32;

export function checkMcpUrl(mcp: string): void {
  let u: URL;
  try { u = new URL(mcp); } catch { throw new AdminError("invalid", `agentMcpUrl: ${mcp} is not a URL`); }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (!(u.protocol === "https:" || (u.protocol === "http:" && loopback)) || u.pathname !== "/mcp" || u.search || u.hash || u.username || u.password)
    throw new AdminError("invalid", "agentMcpUrl must be https://<this host>:<port>/mcp or http://127.0.0.1:<port>/mcp");
}

const list = (key: string, v: unknown, ok: RegExp, what: string, allowEmpty: boolean): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new AdminError("invalid", `${key} must be a list of strings`);
  const items = (v as string[]).map((x) => x.trim()).filter(Boolean);
  if (!allowEmpty && items.length === 0) throw new AdminError("invalid", `${key} must not be empty`);
  if (items.length > MAX_ITEMS) throw new AdminError("invalid", `${key} may hold at most ${MAX_ITEMS} entries`);
  for (const x of items) if (!ok.test(x) || x === "/") throw new AdminError("invalid", `${key}: ${x} is not ${what}`);
  if (new Set(items).size !== items.length) throw new AdminError("invalid", `${key} lists an entry twice`);
  return items;
};

// What may be stored. Unknown keys are refused; a key set to null in agentMcpUrl means "no orchestrators".
export function checkSettings(input: unknown): ServiceSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminError("invalid", "settings must be an object");
  const o = input as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !(SETTING_KEYS as readonly string[]).includes(k));
  if (extra.length) throw new AdminError("invalid", `unknown setting ${extra[0]}`);
  const out: ServiceSettings = {};
  if (o.agentRoots !== undefined) out.agentRoots = list("agentRoots", o.agentRoots, ROOT, "a plain absolute folder", true);
  if (o.agentModels !== undefined) out.agentModels = list("agentModels", o.agentModels, CLAUDE_MODEL, "a model alias", false);
  if (o.agentDshModels !== undefined) out.agentDshModels = list("agentDshModels", o.agentDshModels, DSH_MODEL, "provider/model", true);
  if (o.agentMcpUrl !== undefined) {
    if (o.agentMcpUrl === null || o.agentMcpUrl === "") out.agentMcpUrl = null;
    else if (typeof o.agentMcpUrl !== "string") throw new AdminError("invalid", "agentMcpUrl must be a string or null");
    else { checkMcpUrl(o.agentMcpUrl.trim()); out.agentMcpUrl = o.agentMcpUrl.trim(); }
  }
  if (o.input !== undefined) {
    if (typeof o.input !== "boolean") throw new AdminError("invalid", "input must be true or false");
    out.input = o.input;
  }
  return out;
}

// The environment the service starts with: the file's settings over the plist's or unit's values.
export function settingsEnv(env: Record<string, string | undefined>, s: ServiceSettings): Record<string, string | undefined> {
  const out = { ...env };
  if (s.agentRoots) out.FLEET_CONTROL_AGENT_ROOTS = s.agentRoots.join(":");
  if (s.agentModels) out.FLEET_CONTROL_AGENT_MODELS = s.agentModels.join(",");
  if (s.agentDshModels) out.FLEET_CONTROL_AGENT_DSH_MODELS = s.agentDshModels.join(",");
  if (s.agentMcpUrl !== undefined) out.FLEET_CONTROL_AGENT_MCP_URL = s.agentMcpUrl ?? "";
  if (s.input !== undefined) out.FLEET_CONTROL_INPUT = s.input ? "1" : "";
  return out;
}

// What the file holds: only the settings that differ from the service's own environment, so a later plist or
// unit change to any other setting still takes effect.
export function settingsDiff(base: Required<ServiceSettings>, wanted: Required<ServiceSettings>): ServiceSettings {
  const out: Record<string, unknown> = {};
  for (const k of SETTING_KEYS) if (JSON.stringify(base[k]) !== JSON.stringify(wanted[k])) out[k] = wanted[k];
  return out as ServiceSettings;
}

// Agent models, DSH models and the MCP address do nothing without agent folders; refuse them rather than
// show them as taking effect.
export function checkNeedsRoots(next: Required<ServiceSettings>, saved: ServiceSettings): void {
  if (next.agentRoots.length) return;
  const idle = (["agentModels", "agentDshModels", "agentMcpUrl"] as const).filter((k) => saved[k] !== undefined && saved[k] !== null && !(Array.isArray(saved[k]) && (saved[k] as string[]).length === 0));
  if (idle.length) throw new AdminError("invalid", `${idle.join(", ")} need agent folders; set agentRoots too, or leave ${idle.length > 1 ? "them" : "it"} as the service has ${idle.length > 1 ? "them" : "it"}`);
}

// The settings as the running service took them from its environment, in the file's shape.
export function settingsOf(env: Record<string, string | undefined>): Required<ServiceSettings> {
  const split = (v: string | undefined, sep: string) => (v ?? "").split(sep).map((x) => x.trim()).filter(Boolean);
  const roots = split(env.FLEET_CONTROL_AGENT_ROOTS, ":");
  return {
    agentRoots: roots,
    // The service's own default when the variable is unset, with or without folders.
    agentModels: env.FLEET_CONTROL_AGENT_MODELS === undefined ? ["sonnet", "opus", "haiku"] : split(env.FLEET_CONTROL_AGENT_MODELS, ","),
    agentDshModels: split(env.FLEET_CONTROL_AGENT_DSH_MODELS, ","),
    agentMcpUrl: env.FLEET_CONTROL_AGENT_MCP_URL?.trim() || null,
    input: env.FLEET_CONTROL_INPUT === "1",
  };
}
