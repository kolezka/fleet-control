// Saved plans for machines that do not run Fleet Control yet. Saving a plan starts nothing:
// it makes no token, adds no host and runs nothing on the machine.
import { checkEnrollRequest, EnrollError, type EnrollRequest } from "../domain/enrollment.ts";

export type WorkstationPlanStore = { save(input: unknown): void; list(): EnrollRequest[] };

// knownIds: the hosts this gateway already has. A plan for one of them would describe a machine that is already here.
export function workstationPlanUseCases(store: WorkstationPlanStore, knownIds: () => string[]) {
  return {
    save(input: unknown): void {
      const { id } = checkEnrollRequest(input);
      if (knownIds().includes(id)) throw new EnrollError(`host id ${id} is already in use`);
      store.save(input);
    },
    list: (): EnrollRequest[] => store.list(),
  };
}
export type WorkstationPlanUseCases = ReturnType<typeof workstationPlanUseCases>;
