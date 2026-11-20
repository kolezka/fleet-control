// Tokens for orchestrator agents, kept in the host's own tokens file so the service and `scripts/tokens.ts`
// see one list. The principal is the agent's name (the fc- prefix is reserved for managed agents) with the
// agent role: it may write runs, phases and requests, never answer them. Each change is written under the
// tokens file lock and loaded into the running service at once, without waiting for a SIGHUP.
import { readFileSync } from "node:fs";
import { change, withLock, writeAtomic } from "../scripts/tokens.ts";
import { Auth, parseTokens } from "./auth.ts";
import { AGENT_NAME, type AgentTokens } from "./domain/agents.ts";

export class FileAgentTokens implements AgentTokens {
  constructor(readonly file: string, readonly auth: Auth) {}

  private names(text: string) {
    return text === "" ? new Set<string>() : new Set(parseTokens(text).keys());
  }

  private async edit(name: string, next: (text: string, present: boolean) => string | null) {
    if (!AGENT_NAME.test(name)) throw new Error(`${name} is not a managed agent name`);
    withLock(this.file, () => {
      const text = readFileSync(this.file, "utf8");
      const out = next(text, this.names(text).has(name));
      if (out !== null) writeAtomic(this.file, out);
    });
    // The file is the source of truth; a reload that fails leaves the old tokens and says why.
    this.auth.replace(await Auth.fromFile(this.file));
  }

  // A line left for this name (a crash between issue and revoke) is replaced, so its old token dies.
  async issue(name: string): Promise<string> {
    let token = "";
    await this.edit(name, (text, present) => {
      const c = present ? change("revoke", name, text) : { text };
      const added = change("add", name, c.text, undefined, "agent");
      token = added.token!;
      return added.text;
    });
    return token;
  }

  async revoke(name: string): Promise<void> {
    await this.edit(name, (text, present) => (present ? change("revoke", name, text).text : null));
  }
}
