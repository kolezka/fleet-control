// Looking after a host's tokens file from the page. The file and the running service's token list are
// injected; every change is checked again against the file as it is under the lock, then loaded at once.
import { AdminError } from "../domain/fleet-admin.ts";
import { checkOther, checkOwnHash, checkOwnRevoke, viewOf, type TokenRow } from "../domain/token-admin.ts";
import { requirePermission, type Caller } from "../domain/roles.ts";

export type TokenChange = { kind: "rotate" } | { kind: "revoke" } | { kind: "hash"; hash: string };
export type TokenFile = {
  rows(): Promise<TokenRow[]>;
  // Under the file lock: reads the rows, asks decide what to do (decide throws to refuse), applies it to
  // this name's line, writes the file and loads it into the service. Returns the new token for a rotate, else null.
  change(name: string, decide: (rows: TokenRow[]) => TokenChange): Promise<string | null>;
};
export type TokenAdminDeps = { file: TokenFile };

export function tokenUseCases(deps: TokenAdminDeps, caller?: Caller) {
  const me = caller?.name;
  const need = () => requirePermission(caller, "operate");
  return {
    async list() {
      need();
      return { tokens: viewOf(await deps.file.rows(), me) };
    },
    // Someone else's token. The new token is shown once and is not kept anywhere on this host.
    async rotate(name: string, input: unknown) {
      need();
      const token = await deps.file.change(name, (rows) => { checkOther("rotate", name, input, rows, me); return { kind: "rotate" }; });
      if (!token) throw new AdminError("unavailable", "the rotate made no token");
      return { name, token };
    },
    async revoke(name: string, input: unknown) {
      need();
      await deps.file.change(name, (rows) => { checkOther("revoke", name, input, rows, me); return { kind: "revoke" }; });
      return { name, revoked: true };
    },
    // The caller's own line takes a hash the caller made; the old token stops working at once.
    async replaceOwn(input: unknown) {
      need();
      if (!me) throw new AdminError("invalid", "only a signed-in caller has its own token");
      await deps.file.change(me, (rows) => ({ kind: "hash", hash: checkOwnHash(input, rows, me) }));
      return { name: me, replaced: true };
    },
    async revokeOwn(input: unknown) {
      need();
      if (!me) throw new AdminError("invalid", "only a signed-in caller has its own token");
      await deps.file.change(me, (rows) => { checkOwnRevoke(input, rows, me); return { kind: "revoke" }; });
      return { name: me, revoked: true };
    },
  };
}
export type TokenUseCases = ReturnType<typeof tokenUseCases>;
