// Tokens for orchestrator agents, kept in the host's own tokens file so the service and `scripts/tokens.ts`
// see one list. The principal is the agent's name (the fc- prefix is reserved for managed agents) with the
// agent role: it may write runs, phases and requests, never answer them. Each change is written under the
// tokens file lock and loaded into the running service at once, without waiting for a SIGHUP.
import { readFileSync } from "node:fs";
import { change, withLock, writeAtomic } from "../scripts/tokens.ts";
import { Auth, parseTokens } from "./auth.ts";
import { AGENT_NAME, AgentError, type AgentTokens } from "./domain/agents.ts";

export class FileAgentTokens implements AgentTokens {
  constructor(readonly file: string, readonly auth: Auth) {}

  // The role of this name's line, or null when there is none.
  private roleOf(text: string, name: string) {
    return text === "" ? null : parseTokens(text).get(name)?.role ?? null;
  }

  private async edit(name: string, next: (text: string, role: string | null) => string | null) {
    if (!AGENT_NAME.test(name)) throw new Error(`${name} is not a managed agent name`);
    withLock(this.file, () => {
      const text = readFileSync(this.file, "utf8");
      const out = next(text, this.roleOf(text, name));
      if (out !== null) writeAtomic(this.file, out);
    });
    // The file is the source of truth; a reload that fails leaves the old tokens and says why.
    this.auth.replace(await Auth.fromFile(this.file));
  }

  // A line left for this name (a crash between issue and revoke) is replaced, so its old token dies.
  // A line with another role was made by hand: it is never touched, and the start is refused.
  async issue(name: string): Promise<string> {
    let token = "";
    await this.edit(name, (text, role) => {
      if (role !== null && role !== "agent") throw new AgentError("invalid", `${name} is a token for role ${role}, not a managed agent; choose another agent name`);
      const c = role !== null ? change("revoke", name, text) : { text };
      const added = change("add", name, c.text, undefined, "agent");
      token = added.token!;
      return added.text;
    });
    return token;
  }

  async revoke(name: string): Promise<void> {
    // Only an agent line: a hand-made line with another role under this name is left alone.
    await this.edit(name, (text, role) => (role === "agent" ? change("revoke", name, text).text : null));
  }
}
