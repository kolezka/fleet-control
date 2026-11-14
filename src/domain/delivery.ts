// What a delivery sends and how a sender's result is read. No I/O here.
import type { Command } from "./commands.ts";

export type SendResult = { exitCode: number; stdout: string; stderr: string };
export type Sender = (session: string, file: string) => Promise<SendResult>;

// The bundled sender probes only the first 40 characters, not the full command ID.
export function messageFor(c: Command): string {
  // Backslashes are doubled so literal escape text cannot collide with escaped controls.
  // Actors without backslashes or listed controls are unchanged; other Unicode is not sanitized.
  const actor = c.actor.replace(/[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (character) => character === "\\" ? "\\\\" : `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return [
    `Fleet Control command ${c.id} from ${actor}:`,
    "",
    c.text,
    "",
    `This message is a delivery, not an approval. Accept or reject ${c.id} with the fleet-control command_respond tool before acting on it.`,
    "",
  ].join("\n");
}

// Sender output cannot prove no effect. Unconfirmed results are unknown and never retried automatically.
export function classify(r: SendResult, target: string): { status: "delivered" | "delivery_unknown"; detail: string } {
  const expected = `${target}: delivered`;
  if (r.exitCode === 0 && (r.stdout === expected || r.stdout === `${expected}\n` || r.stdout === `${expected}\r\n`)) return { status: "delivered", detail: r.stdout };
  return { status: "delivery_unknown", detail: "fleet send result unknown" };
}
