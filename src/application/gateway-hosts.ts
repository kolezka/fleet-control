// A gateway looking after its own hosts: give a host a new gateway token, or remove a host. The gateway
// makes the new token and sends the host only its hash. The disk, the network and the config are injected.
import { createHash } from "node:crypto";

export class GatewayHostError extends Error {
  constructor(readonly kind: "invalid" | "not_found" | "conflict" | "failed", message: string) {
    super(message);
  }
}

export type HostAnswer = { status: number; body: unknown };
export type GatewayHostsDeps = {
  known(id: string): { name: string; url: string } | undefined;
  // The token file the config names for this host, and whether it is this gateway's own token-<id> file.
  tokenFile(id: string): Promise<{ file: string; own: boolean }>;
  bearer(id: string): string | undefined;
  newToken(): string;
  call(url: string, token: string, path: string, body?: object): Promise<HostAnswer>;
  // Writes the new token next to the old one without replacing it; returns the temp file.
  stage(id: string, token: string): Promise<string>;
  // Puts the staged file in place and gives the running gateway the new token.
  commit(id: string, staged: string, token: string): Promise<void>;
  discard(staged: string): Promise<void>;
  // Drops the host from the config file and the running gateway; removes the token file only if own.
  forget(id: string): Promise<{ tokenFileRemoved: boolean }>;
};

const principalOf = (a: HostAnswer): string | null => {
  const b = a.body as { principal?: unknown } | null;
  return a.status === 200 && typeof b?.principal === "string" ? b.principal : null;
};
const reason = (a: HostAnswer): string => {
  const m = (a.body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof m === "string" ? m : `the host answered ${a.status}`;
};
const confirmOf = (input: unknown): unknown =>
  input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).confirm : undefined;

export function gatewayHostUseCases(deps: GatewayHostsDeps) {
  let busy: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = busy.then(fn, fn);
    busy = next.catch(() => undefined);
    return next;
  };
  const host = (id: string) => {
    const h = deps.known(id);
    const token = deps.bearer(id);
    if (!h || !token) throw new GatewayHostError("not_found", `no host ${id} in this gateway`);
    return { ...h, token };
  };
  const whoami = async (url: string, token: string) => {
    try { return principalOf(await deps.call(url, token, "/api/whoami")); } catch { return null; }
  };

  return {
    // New gateway token for one host. The host swaps the hash in its tokens file; the old token dies there at once.
    rotate: (id: string, input: unknown) => serial(async () => {
      const h = host(id);
      if (confirmOf(input) !== id) throw new GatewayHostError("invalid", `type ${id} to confirm`);
      const tf = await deps.tokenFile(id);
      if (!tf.own) throw new GatewayHostError("invalid", `${id} reads its token from ${tf.file}, which may be shared with another program; rotate that token on the host`);
      const me = await whoami(h.url, h.token);
      if (!me) throw new GatewayHostError("failed", `${h.url} does not accept this gateway's token now; nothing changed`);
      const token = deps.newToken();
      const staged = await deps.stage(id, token);
      const hash = createHash("sha256").update(token).digest("hex");
      let answer: HostAnswer | null = null;
      try { answer = await deps.call(h.url, h.token, "/api/token/replace", { hash }); } catch { answer = null; }
      if (answer && answer.status !== 200) {
        await deps.discard(staged);
        throw new GatewayHostError("failed", `${h.url} refused the new token: ${reason(answer)}`);
      }
      // No answer: the host may or may not have taken it. Ask with each token which one it knows.
      if (!answer && (await whoami(h.url, token)) !== me) {
        if ((await whoami(h.url, h.token)) === me) {
          await deps.discard(staged);
          throw new GatewayHostError("failed", `${h.url} did not answer; it still takes the old token, so nothing changed`);
        }
        throw new GatewayHostError("failed", `${h.url} did not answer and takes neither token now; the new one is kept in ${staged}`);
      }
      await deps.commit(id, staged, token);
      return { id, principal: me, rotated: true };
    }),

    // Removes a host from this gateway. With revoke the host first deletes this gateway's line; without it
    // (a host that is gone) the line stays on the host and the answer says so.
    remove: (id: string, input: unknown) => serial(async () => {
      const h = host(id);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new GatewayHostError("invalid", "body must be an object");
      const { confirm, revoke, ...rest } = input as Record<string, unknown>;
      if (Object.keys(rest).length) throw new GatewayHostError("invalid", `unknown field ${Object.keys(rest)[0]}`);
      if (confirm !== id) throw new GatewayHostError("invalid", `type ${id} to confirm`);
      if (typeof revoke !== "boolean") throw new GatewayHostError("invalid", "revoke must be true or false");
      let principal: string | null = null;
      if (revoke) {
        principal = await whoami(h.url, h.token);
        if (!principal) throw new GatewayHostError("failed", `${h.url} does not answer with this gateway's token; remove it without revoking, then revoke the line on the host`);
        let answer: HostAnswer;
        try { answer = await deps.call(h.url, h.token, "/api/token/revoke", { confirm: principal }); }
        catch { throw new GatewayHostError("failed", `${h.url} did not answer the revoke; the host is still in this gateway, try again`); }
        if (answer.status !== 200) throw new GatewayHostError("failed", `${h.url} refused the revoke: ${reason(answer)}`);
      }
      const { tokenFileRemoved } = await deps.forget(id);
      return { id, removed: true, revokedOnHost: revoke, principal, tokenFileRemoved };
    }),
  };
}
export type GatewayHostUseCases = ReturnType<typeof gatewayHostUseCases>;
