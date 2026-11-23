// Use cases for the infrastructure part of the page: certificate status and renewal, Tailscale Serve (read
// only), and restarting other services on this host that the operator listed for the page.
import { AdminError } from "../domain/fleet-admin.ts";
import { requirePermission, type Caller } from "../domain/roles.ts";
import { checkRenewRequest, checkServiceRestart, RENEW_BEFORE_DAYS, serviceTarget, type CertState, type InfraView, type OtherService, type OtherServiceState } from "../domain/infra.ts";

export type InfraHost = {
  certs(): Promise<CertState[]>;
  // Asks `tailscale cert` for the tailnet certificate into its files; returns the new state of that certificate.
  renew(): Promise<CertState>;
  serveStatus(): Promise<{ text: string } | { error: string }>;
  serviceState(s: OtherService): Promise<OtherServiceState>;
  restart(s: OtherService): Promise<void>;
};
export type InfraDeps = { host: InfraHost; services: OtherService[]; now?: () => Date };

let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
};
let renewedAt: string | null = null;

export function infraUseCases(deps: InfraDeps, caller?: Caller) {
  const now = deps.now ?? (() => new Date());
  const renewNow = async () => {
    const before = (await deps.host.certs()).find((c) => c.id === "tailnet");
    if (!before) throw new AdminError("failed", "this host has no tailnet certificate to renew");
    const after = await deps.host.renew();
    const renewed = after.notAfter !== before.notAfter;
    if (renewed) renewedAt = now().toISOString();
    return { cert: after, renewed, renewBeforeDays: RENEW_BEFORE_DAYS };
  };
  return {
    async get(): Promise<InfraView> {
      requirePermission(caller, "operate");
      const [certs, serve, services] = await Promise.all([
        deps.host.certs(),
        deps.host.serveStatus(),
        Promise.all(deps.services.map((s) => deps.host.serviceState(s).catch((e): OtherServiceState => ({ name: s.name, kind: s.kind, target: serviceTarget(s), running: null, detail: e instanceof Error ? e.message : String(e) })))),
      ]);
      return { certs, renewedAt, serve, services };
    },

    renew: (input: unknown) => serial(async () => {
      requirePermission(caller, "operate");
      checkRenewRequest(input);
      return renewNow();
    }),

    // The service's own daily check; it shares the queue with page actions so two renewals never interleave.
    // Renews when fewer than RENEW_BEFORE_DAYS are left. The listener keeps the old certificate until the service restarts.
    renewIfDue: (log: (line: string) => void = console.log) => serial(async () => {
      const c = (await deps.host.certs()).find((x) => x.id === "tailnet");
      if (!c || !c.renewable || c.error || c.daysLeft >= RENEW_BEFORE_DAYS) return false;
      try {
        const r = await renewNow();
        log(r.renewed
          ? `tailnet certificate renewed: valid to ${r.cert.notAfter}; the listener takes it at the next service start`
          : `tailnet certificate checked: tailscale returned the current one (valid to ${r.cert.notAfter})`);
        return r.renewed;
      } catch (e) {
        log(`tailnet certificate renewal failed (${c.daysLeft} days left): ${e instanceof Error ? e.message : e}`);
        return false;
      }
    }),

    restart: (name: string, input: unknown) => serial(async () => {
      requirePermission(caller, "operate");
      const s = checkServiceRestart(name, input, deps.services);
      await deps.host.restart(s);
      return deps.host.serviceState(s);
    }),
  };
}
