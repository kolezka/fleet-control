// What the web API and the MCP tools do with the host command queue. Both call these, so they cannot drift.
import type { Commands } from "../data/commands.ts";
import type { Command, CommandEvent } from "../domain/commands.ts";
import type { Deliverer } from "./delivery.ts";

export type CommandView = { command: Command; events: CommandEvent[] };

export function commandUseCases(deps: { commands: Commands; deliverer: Deliverer }) {
  const { commands, deliverer } = deps;
  return {
    // Queues the instruction and tries to deliver it once. A repeated key returns the original command and delivers nothing.
    async submit(input: { idempotencyKey: string; target: string; actor: string; text: string }): Promise<CommandView & { created: boolean }> {
      const { command, created } = commands.submit(input);
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
  };
}
