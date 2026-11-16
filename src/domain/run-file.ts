// Reads the phase table of a phased-delivery run file (references/run-file.md in phased-delivery 0.2.0).
// run.md stays the only writer: the service record is derived from it, never written back.

export const PHASE_STATUSES = ["todo", "running", "done", "blocked", "stopped"] as const;
// `status` is the normalized value; `written` is the cell as the orchestrator wrote it.
export type PhaseRow = { number: number; title: string; status: string; written: string; tip: string };
export type RunFile = { title: string; phases: PhaseRow[] };
export type Current = { number: number; status: string; tip: string; phase: string; phaseStatus: string };

const validStatus = (status: string) => (PHASE_STATUSES as readonly string[]).includes(status) || /^fix-round-[1-9][0-9]*$/.test(status);
// Real run files drift from the documented values: "done, pushed", "in progress". Only the part before
// a comma counts, and only these spellings are mapped; anything else is still refused.
const ALIASES: Record<string, string> = { "in progress": "running", "in-progress": "running" };
export const normalizeStatus = (cell: string) => { const head = cell.split(",")[0]!.trim().toLowerCase(); return ALIASES[head] ?? head; };
// "\|" inside a cell is a literal pipe, as in GitHub markdown.
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
// Cuts by code point, so a surrogate pair is never split, and drops the space a cut can leave.
// The service limits are in UTF-16 units, so cut there, without splitting a surrogate pair.
const clip = (text: string, max: number) => {
  let out = "";
  for (const ch of text) { if (out.length + ch.length > max) break; out += ch; }
  return out.trimEnd();
};
export const TIP = /^[0-9a-f]{7,40}$/;

export function parseRunFile(text: string): RunFile {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const first = lines.find((line) => line.trim() !== "") ?? "";
  if (!first.startsWith("# Phased run: ") || !first.slice(14).trim()) throw new Error("run file must start with a '# Phased run:' title");
  const title = first.slice(14).trim();
  const start = lines.findIndex((line) => line.trim() === "## Phases");
  if (start < 0) throw new Error("run file has no '## Phases' section");
  const table: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (line.trim().startsWith("|")) table.push(line);
    else if (table.length > 0) break; // a table ends at the first line that is not a row, blank or not
  }
  const [header, rule, ...rows] = table;
  const columns = header ? cells(header) : [];
  if (!header || !rule || columns.slice(0, 4).join("|").toLowerCase() !== "#|title|status|tip" || !cells(rule).every((cell) => /^:?-+:?$/.test(cell))) {
    throw new Error("phase table header must start with | # | Title | Status | Tip |");
  }
  const phases = rows.map((row, index) => {
    const values = cells(row);
    if (values.length !== columns.length) throw new Error(`phase row ${index + 1} has ${values.length} cells, the header has ${columns.length}`);
    const [number, title, written, tip] = values as [string, string, string, string];
    // "8+" marks a placeholder for later phases; it may only be the last row.
    const open = index === rows.length - 1 && number.endsWith("+");
    const digits = open ? number.slice(0, -1) : number;
    if (!/^[1-9][0-9]*$/.test(digits) || Number(digits) !== index + 1) throw new Error(`phase row ${index + 1} has number "${number}"`);
    if (!title) throw new Error(`phase ${number} has no title`);
    const status = normalizeStatus(written);
    if (!validStatus(status)) throw new Error(`phase ${number} has unknown status "${written}"`);
    if (tip && !TIP.test(tip)) throw new Error(`phase ${number} tip "${tip}" is not a commit hash`);
    return { number: Number(digits), title, status, written, tip };
  });
  if (phases.length === 0) throw new Error("phase table has no rows");
  return { title, phases };
}

// The phase the service should show: the first one that is not done, or the last one when all are.
// A blocked or stopped phase is not done, so it stays current even if a later row says running.
export function currentPhase(run: RunFile): Current {
  const row = run.phases.find((phase) => phase.status !== "done") ?? run.phases.at(-1)!;
  const done = run.phases.filter((phase) => phase.status === "done").length;
  return {
    number: row.number, status: row.status, tip: row.tip,
    phase: clip(`phase ${row.number}: ${row.title}`, 200),
    phaseStatus: clip(`${row.written}${row.tip ? ` at ${row.tip}` : ""}; ${done} of ${run.phases.length} done`, 500),
  };
}
