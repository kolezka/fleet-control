// How a central run records which supervisor owns it, and how that owner is shown to readers.
import type { Principal } from "./identity.ts";

// The embedded newline cannot occur in a valid authenticated principal name.
const ownerPrefix = "central-supervisor\n";

export const runOwner = (principal: Extract<Principal, { role: "supervisor" }>) =>
  ownerPrefix + JSON.stringify([principal.name, principal.principalId, principal.hostId, principal.session]);

export const displayOwner = (owner: string) => {
  if (!owner.startsWith(ownerPrefix)) return owner;
  try {
    const parts: unknown = JSON.parse(owner.slice(ownerPrefix.length));
    return Array.isArray(parts) && parts.length === 4 && parts.every((part) => typeof part === "string") ? parts[0] as string : owner;
  } catch { return owner; }
};
export const displayRun = <T extends { orchestrator: string }>(run: T): T => ({ ...run, orchestrator: displayOwner(run.orchestrator) });
export const displayRequest = <T extends { origin: string }>(request: T): T => ({ ...request, origin: displayOwner(request.origin) });
