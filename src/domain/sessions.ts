// A session Fleet Control knows about. Runtime truth still comes from the fleet CLI.
import type { SessionKind } from "./model.ts";

export type SessionRecord = {
  name: string;
  host: string;
  role: string;
  kind: SessionKind;
  configuredModel: string | null;
};
