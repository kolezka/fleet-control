// Adding a host from the gateway page. The steps are kept apart on purpose: the gateway makes and
// keeps the token (begin), the operator or SSH runs the command on the host (the host's own action),
// and only a check that the host answers with this principal and the operator role adds the host.
import { createHash } from "node:crypto";
import { checkEnrollRequest, EnrollError, enrolledAs, pasteCommand, type EnrollRequest } from "../domain/enrollment.ts";

export type EnrollDeps = {
  newToken(): string;
  knownIds(): string[];
  writeToken(id: string, token: string): Promise<string>; // returns the file; must refuse to overwrite
  removeToken(file: string): Promise<void>;
  whoami(url: string, token: string): Promise<{ status: number; body: unknown }>;
  addHost(host: { id: string; name: string; url: string; tokenFile: string }, token: string): Promise<void>;
  ssh?(target: string, port: number | undefined, command: string): Promise<{ code: number; output: string }>;
  now?(): Date;
};

type Pending = { request: EnrollRequest; token: string; tokenFile: string; command: string; createdAt: string };
export type PendingView = { id: string; name: string; url: string; mode: string; principal: string; command: string; ssh: string | null; createdAt: string };

const view = (p: Pending): PendingView => ({
  id: p.request.id, name: p.request.name, url: p.request.url, mode: p.request.mode, principal: p.request.principal,
  command: p.command, ssh: p.request.ssh ?? null, createdAt: p.createdAt,
});

export function enrollUseCases(deps: EnrollDeps) {
  const pending = new Map<string, Pending>();
  let busy = Promise.resolve();
  // One change at a time: two adds for one id must not both write a token file.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = busy.then(fn, fn);
    busy = next.then(() => undefined, () => undefined);
    return next;
  };
  const get = (id: string) => pending.get(id) ?? (() => { throw new EnrollError(`no host ${id} is being added`); })();

  return {
    list: (): PendingView[] => [...pending.values()].map(view),

    begin: (input: unknown) => serial(async () => {
      const request = checkEnrollRequest(input);
      if (deps.knownIds().includes(request.id) || pending.has(request.id)) throw new EnrollError(`host id ${request.id} is already in use`);
      if (request.ssh && !deps.ssh) throw new EnrollError("this gateway cannot run SSH");
      const token = deps.newToken();
      const hash = createHash("sha256").update(token).digest("hex");
      const command = pasteCommand(request, hash);
      const tokenFile = await deps.writeToken(request.id, token);
      const p: Pending = { request, token, tokenFile, command, createdAt: (deps.now?.() ?? new Date()).toISOString() };
      pending.set(request.id, p);
      return view(p);
    }),

    // Runs the same command over SSH. Its output never holds the token; only the hash went out.
    runSsh: (id: string) => serial(async () => {
      const p = get(id);
      if (!p.request.ssh || !deps.ssh) throw new EnrollError(`${id} has no SSH target`);
      const r = await deps.ssh(p.request.ssh, p.request.sshPort, p.command);
      return { code: r.code, output: r.output.replaceAll(p.token, "<token>").slice(-4000) };
    }),

    // Adds the host only once it answers with this principal and the operator role.
    check: (id: string) => serial(async () => {
      const p = get(id);
      let answer: { status: number; body: unknown };
      try { answer = await deps.whoami(p.request.url, p.token); }
      catch (e) { return { added: false, reason: `cannot reach ${p.request.url}: ${e instanceof Error ? e.message : "no answer"}` }; }
      if (answer.status === 401) return { added: false, reason: "the host does not know this token yet; run the command there first" };
      if (answer.status !== 200) return { added: false, reason: `the host answered ${answer.status}` };
      const why = enrolledAs(answer.body, p.request.principal);
      if (why) return { added: false, reason: why };
      if (deps.knownIds().includes(id)) throw new EnrollError(`host id ${id} is already in use`);
      await deps.addHost({ id, name: p.request.name, url: p.request.url, tokenFile: p.tokenFile }, p.token);
      pending.delete(id);
      return { added: true, reason: null };
    }),

    cancel: (id: string) => serial(async () => {
      const p = get(id);
      pending.delete(id);
      await deps.removeToken(p.tokenFile);
      return { cancelled: id };
    }),
  };
}
export type EnrollUseCases = ReturnType<typeof enrollUseCases>;
