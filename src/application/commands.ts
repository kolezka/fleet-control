// What the web API and the MCP tools do with the host command queue. Both call these, so they cannot drift.
import type { Commands } from "../data/commands.ts";
import { MAX_PAGE, PAGE } from "../data/page.ts";
import { CommandError, MAX_TEXT, type Command, type CommandEvent, type CommandStatus } from "../domain/commands.ts";
import { asCaller, requirePermission, type Caller } from "../domain/roles.ts";
import type { Deliverer } from "./delivery.ts";

export type CommandView = { command: Command; events: CommandEvent[] };

// Lists and polling reads of all events return pages of the same size.
export { MAX_PAGE, PAGE } from "../data/page.ts";
export const EVENT_PAGE = PAGE;
export const MAX_EVENT_PAGE = MAX_PAGE;

// With auth, `who` is the authenticated caller: its name replaces any self-declared actor and its
// role decides whether it may change anything. A viewer only reads.
// `carriesSecret` says whether a text holds a live access token; such a text is neither stored nor delivered.
export function commandUseCases(deps: { commands: Commands; deliverer: Deliverer; carriesSecret?: (text: string) => boolean }, who?: Caller | string) {
  const { commands, deliverer } = deps;
  const caller = asCaller(who);
  const principal = caller?.name;
  const write = () => requirePermission(caller, "write");
  // Delivered text stays in the pane's scrollback, readable by every terminal viewer.
  // Text over MAX_TEXT is left to the store's own length error, so a huge body costs no scan.
  // The length is measured after trim, as the store does, so padding cannot skip the scan.
  const refuseSecret = (text: string, what: string) => {
    const trimmed = text.trim();
    if (trimmed.length <= MAX_TEXT && deps.carriesSecret?.(trimmed)) throw new CommandError("invalid", `text contains an access token; it was ${what}`);
  };
  return {
    // Queues the instruction and tries to deliver it once. A repeated key returns the original command and delivers nothing.
    async submit(input: { idempotencyKey: string; target: string; actor: string; text: string }): Promise<CommandView & { created: boolean }> {
      write();
      refuseSecret(input.text, "not stored or delivered");
      const { command, created } = commands.submit(principal ? { ...input, actor: principal } : input);
      const after = created ? await deliverer.deliver(command.id) : command;
      return { command: after, created, events: commands.events(command.id) };
    },

    // A row queued before the guard existed, or by an instance without auth, is checked again here.
    async deliver(id: string): Promise<CommandView> {
      write();
      // Only a queued row is sent; other statuses come back unchanged, as before.
      const stored = commands.get(id);
      if (stored.status === "queued") refuseSecret(stored.text, "not delivered");
      const command = await deliverer.deliver(id);
      return { command, events: commands.events(id) };
    },

    read(id: string): CommandView {
      return { command: commands.get(id), events: commands.events(id) };
    },

    list: (status?: CommandStatus): Command[] => commands.list(status),
    latest: (limit: number): Command[] => commands.latest(limit),
    page: (page: Parameters<Commands["listPage"]>[0] = {}) => commands.listPage(page),

    // Events of every command after a cursor, for polling, at most limit per call.
    eventsAfter: (afterSeq: number, limit = EVENT_PAGE): CommandEvent[] => commands.events(undefined, afterSeq, limit),

    // The recipient's answer. Without a reason the decision itself is recorded as the detail.
    respond: (id: string, decision: "accepted" | "rejected", actor: string, reason: string): Command => {
      write();
      return commands.transition(id, decision, principal ?? actor, reason || decision);
    },

    report: (id: string, status: "running" | "completed" | "failed", actor: string, evidence: string): Command => {
      write();
      return commands.transition(id, status, principal ?? actor, evidence);
    },
  };
}
