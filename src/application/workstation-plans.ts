// Saved plans for machines that do not run Fleet Control yet. Saving a plan starts nothing:
// it makes no token, adds no host and runs nothing on the machine.
import type { EnrollRequest } from "../domain/enrollment.ts";

export type WorkstationPlanStore = { save(input: unknown): void; list(): EnrollRequest[] };

export function workstationPlanUseCases(store: WorkstationPlanStore) {
  return {
    save: (input: unknown): void => store.save(input),
    list: (): EnrollRequest[] => store.list(),
  };
}
export type WorkstationPlanUseCases = ReturnType<typeof workstationPlanUseCases>;
