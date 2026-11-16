// Reads the phase table of a phased-delivery run file (references/run-file.md in phased-delivery 0.2.0).
// run.md stays the only writer: the service record is derived from it, never written back.

export const PHASE_STATUSES = ["todo", "running", "done", "blocked", "stopped"] as const;
export type PhaseRow = { number: number; title: string; status: string; tip: string };
export type RunFile = { title: string; phases: PhaseRow[] };

const validStatus = (status: string) => (PHASE_STATUSES as readonly string[]).includes(status) || /^fix-round-[1-9][0-9]*$/.test(status);
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
    const [number, title, status, tip] = cells(row);
    if (!/^[1-9][0-9]*$/.test(number ?? "") || Number(number) !== index + 1) throw new Error(`phase row ${index + 1} has number "${number}"`);
    if (!title) throw new Error(`phase ${number} has no title`);
    if (!validStatus(status ?? "")) throw new Error(`phase ${number} has unknown status "${status}"`);
    return { number: Number(number), title, status: status!, tip: tip ?? "" };
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
    phaseStatus: `${row.status}${row.tip ? ` at ${row.tip}` : ""}; ${done} of ${run.phases.length} done`.slice(0, 500),
  };
}
