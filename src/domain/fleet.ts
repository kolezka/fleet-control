// What the host service needs from a fleet: session status and screen text. The CLI adapter implements it.

export type FleetErrorKind = "config" | "session_missing" | "invalid_name" | "cli_failed" | "malformed_output";

export class FleetError extends Error {
  constructor(
    readonly kind: FleetErrorKind,
    message: string,
    readonly detail: { exitCode?: number; stderr?: string } = {},
  ) {
    super(message);
    this.name = "FleetError";
  }
}

export type FleetSessionStatus = {
  name: string;
  // tmux session exists on the fleet socket
  running: boolean;
  // context percent parsed from the agent screen; null when the CLI printed "?"
  contextPct: number | null;
};

export type FleetStatus = { sessions: FleetSessionStatus[]; raw: string };

export interface FleetReader {
  screen(session: string, lines?: number): Promise<string>;
  status(): Promise<FleetStatus>;
}
