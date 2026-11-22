// Rules for looking after a host's tokens file from the page: list the principals, rotate or revoke one,
// and let a gateway replace or give up its own token. Only an operator may do any of it.
import { AdminError } from "./fleet-admin.ts";
import { AGENT_NAME } from "./agents.ts";
import type { Role } from "./roles.ts";

export type TokenRow = { name: string; role: Role };
export type TokenView = TokenRow & { self: boolean; managed: boolean };

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
export const HASH = /^[0-9a-f]{64}$/;

export const viewOf = (rows: readonly TokenRow[], caller: string | undefined): TokenView[] =>
  rows.map((r) => ({ ...r, self: r.name === caller, managed: AGENT_NAME.test(r.name) && r.role === "agent" }));

const confirmOf = (input: unknown): unknown =>
  input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).confirm : undefined;

function only(input: unknown, keys: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminError("invalid", "body must be an object");
  const extra = Object.keys(input).filter((k) => !keys.includes(k));
  if (extra.length) throw new AdminError("invalid", `unknown field ${extra[0]}`);
}

// Rotate or revoke someone else's line, confirmed by typing its name. Checked again under the file lock.
export function checkOther(action: "rotate" | "revoke", name: string, input: unknown, rows: readonly TokenRow[], caller: string | undefined): TokenRow {
  only(input, ["confirm"]);
  if (!NAME.test(name)) throw new AdminError("invalid", "bad principal name");
  const row = rows.find((r) => r.name === name);
  if (!row) throw new AdminError("not_found", `no principal ${name} in the tokens file`);
  if (AGENT_NAME.test(name) && row.role === "agent") throw new AdminError("invalid", `${name} is a managed agent's token; it ends when the agent stops`);
  if (name === caller) throw new AdminError("invalid", `${name} is the token you are using now; rotate it from the gateway, or remove the host from the gateway`);
  if (action === "revoke" && row.role === "operator" && rows.filter((r) => r.role === "operator").length < 2) {
    throw new AdminError("invalid", `${name} is the last operator; add another before revoking it`);
  }
  if (confirmOf(input) !== name) throw new AdminError("invalid", `type ${name} to confirm`);
  return row;
}

// A gateway replacing its own token: it sends only the hash of the new one.
export function checkOwnHash(input: unknown, rows: readonly TokenRow[], caller: string | undefined): string {
  only(input, ["hash"]);
  if (!caller || !rows.some((r) => r.name === caller)) throw new AdminError("not_found", "the caller has no line in the tokens file");
  const hash = (input as Record<string, unknown>).hash;
  if (typeof hash !== "string" || !HASH.test(hash)) throw new AdminError("invalid", "hash must be 64 lowercase hex characters");
  return hash;
}

// A gateway giving up its own token before it forgets the host, confirmed with its own name.
export function checkOwnRevoke(input: unknown, rows: readonly TokenRow[], caller: string | undefined): void {
  only(input, ["confirm"]);
  const row = rows.find((r) => r.name === caller);
  if (!caller || !row) throw new AdminError("not_found", "the caller has no line in the tokens file");
  if (row.role === "operator" && rows.filter((r) => r.role === "operator").length < 2) {
    throw new AdminError("invalid", `${caller} is the last operator on this host; add another before revoking it`);
  }
  if (confirmOf(input) !== caller) throw new AdminError("invalid", `type ${caller} to confirm`);
}
