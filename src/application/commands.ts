// What the web API and the MCP tools do with the host command queue. Both call these, so they cannot drift.
import type { Commands } from "../data/commands.ts";
import type { Command, CommandEvent, CommandStatus } from "../domain/commands.ts";
import type { Deliverer } from "./delivery.ts";

export type CommandView = { command: Command; events: CommandEvent[] };

// With auth, `principal` is the authenticated caller and replaces any self-declared actor.
export function commandUseCases(deps: { commands: Commands; deliverer: Deliverer }, principal?: string) {
  const { commands, deliverer } = deps;
  return {
    // Queues the instruction and tries to deliver it once. A repeated key returns the original command and delivers nothing.
    async submit(input: { idempotencyKey: string; target: string; actor: string; text: string }): Promise<CommandView & { created: boolean }> {
      const { command, created } = commands.submit(principal ? { ...input, actor: principal } : input);
      const after = created ? await deliverer.deliver(command.id) : command;
      return { command: after, created, events: commands.events(command.id) };
    },

    async deliver(id: string): Promise<CommandView> {
      const command = await deliverer.deliver(id);
      return { command, events: commands.events(id) };
    },

    read(id: string): CommandView {
      return { command: commands.get(id), events: commands.events(id) };
    },

    list: (status?: CommandStatus): Command[] => commands.list(status),

    // Events of every command after a cursor, for polling.
    eventsAfter: (afterSeq: number): CommandEvent[] => commands.events(undefined, afterSeq),

    // The recipient's answer. Without a reason the decision itself is recorded as the detail.
    respond: (id: string, decision: "accepted" | "rejected", actor: string, reason: string): Command =>
      commands.transition(id, decision, principal ?? actor, reason || decision),

    report: (id: string, status: "running" | "completed" | "failed", actor: string, evidence: string): Command =>
      commands.transition(id, status, principal ?? actor, evidence),
  };
}
