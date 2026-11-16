// Reads the phase table of a phased-delivery run file (references/run-file.md in phased-delivery 0.2.0).
// run.md stays the only writer: the service record is derived from it, never written back.

export const PHASE_STATUSES = ["todo", "running", "done", "blocked", "stopped"] as const;
// `status` is the normalized value; `written` is the cell as the orchestrator wrote it.
export type PhaseRow = { number: number; title: string; status: string; written: string; tip: string };
export type RunFile = { title: string; phases: PhaseRow[] };

const validStatus = (status: string) => (PHASE_STATUSES as readonly string[]).includes(status) || /^fix-round-[1-9][0-9]*$/.test(status);
// Real run files drift from the documented values: "done, pushed", "in progress". Only the part before
// a comma counts, and only these spellings are mapped; anything else is still refused.
const ALIASES: Record<string, string> = { "in progress": "running", "in-progress": "running" };
const normalize = (cell: string) => { const head = cell.split(",")[0]!.trim().toLowerCase(); return ALIASES[head] ?? head; };
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

export function parseRunFile(text: string): RunFile {
  const lines = text.split(/\r?\n/);
  const title = lines.find((line) => line.startsWith("# Phased run: "))?.slice("# Phased run: ".length).trim();
  if (!title) throw new Error("run file has no '# Phased run:' title");
  const start = lines.findIndex((line) => line.trim() === "## Phases");
  if (start < 0) throw new Error("run file has no '## Phases' section");
  const table: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (line.trim().startsWith("|")) table.push(line);
    else if (table.length > 0 && line.trim() !== "") break;
  }
  const [header, rule, ...rows] = table;
  if (!header || !rule || cells(header).slice(0, 4).join("|").toLowerCase() !== "#|title|status|tip" || !cells(rule).every((cell) => /^:?-+:?$/.test(cell))) {
    throw new Error("phase table header must start with | # | Title | Status | Tip |");
  }
  const phases = rows.map((row, index) => {
    const [number, title, written, tip] = cells(row);
    // "8+" marks a placeholder for later phases; it may only be the last row.
    const open = index === rows.length - 1 && /\+$/.test(number ?? "");
    const digits = open ? number!.slice(0, -1) : number ?? "";
    if (!/^[1-9][0-9]*$/.test(digits) || Number(digits) !== index + 1) throw new Error(`phase row ${index + 1} has number "${number}"`);
    if (!title) throw new Error(`phase ${number} has no title`);
    const status = normalize(written ?? "");
    if (!validStatus(status)) throw new Error(`phase ${number} has unknown status "${written}"`);
    return { number: Number(digits), title, status, written: written!, tip: tip ?? "" };
  });
  if (phases.length === 0) throw new Error("phase table has no rows");
  return { title, phases };
}

// The phase the service should show: the first one that is not done, or the last one when all are.
export function currentPhase(run: RunFile): { phase: string; phaseStatus: string } {
  const row = run.phases.find((phase) => phase.status !== "done") ?? run.phases.at(-1)!;
  const done = run.phases.filter((phase) => phase.status === "done").length;
  return {
    phase: `phase ${row.number}: ${row.title}`.slice(0, 200),
    phaseStatus: `${row.written}${row.tip ? ` at ${row.tip}` : ""}; ${done} of ${run.phases.length} done`.slice(0, 500),
  };
}
