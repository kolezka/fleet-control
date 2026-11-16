import { expect, test } from "bun:test";
import { currentPhase, parseRunFile } from "./run-file.ts";

const run = (rows: string, extra = "") => `# Phased run: Add login retry

Repo: /repo
${extra}
## Goal
Retry once.

## Phases
| # | Title | Status | Tip | Verified by orchestrator | Review |
|---|---|---|---|---|---|
${rows}

## Decisions
| # | Question | Answer | Who, when |
|---|---|---|---|
| 1 | Keep old flag? | open | |
`;

test("reads the phase table of the documented run file format and picks the first phase not done", () => {
  const parsed = parseRunFile(run("| 1 | Parser | done | abc1234 | `bun test` exit 0 | APPROVE |\n| 2 | Retry | fix-round-1 | def5678 | | |\n| 3 | Docs | todo | | | |"));
  expect(parsed.title).toBe("Add login retry");
  expect(parsed.phases.map((p) => p.status)).toEqual(["done", "fix-round-1", "todo"]);
  expect(currentPhase(parsed)).toMatchObject({ phase: "phase 2: Retry", phaseStatus: "fix-round-1 at def5678; 1 of 3 done" });
});

test("a finished run shows its last phase, and the decisions table is not read as phases", () => {
  const parsed = parseRunFile(run("| 1 | Parser | done | abc1234 | | |\n| 2 | Retry | done | def5678 | | |"));
  expect(parsed.phases).toHaveLength(2);
  expect(currentPhase(parsed)).toMatchObject({ phase: "phase 2: Retry", phaseStatus: "done at def5678; 2 of 2 done" });
});

test("reads the spellings real run files use: a note after a comma, 'in progress' and an open last row like 8+", () => {
  const parsed = parseRunFile(run("| 1 | Tokens | done, pushed | 48734cb | yes | |\n| 2 | Graph | in progress | | | |\n| 3+ | API items | todo | | | |"));
  expect(parsed.phases.map((p) => [p.number, p.status, p.written])).toEqual([[1, "done", "done, pushed"], [2, "running", "in progress"], [3, "todo", "todo"]]);
  expect(currentPhase(parsed)).toMatchObject({ phase: "phase 2: Graph", phaseStatus: "in progress; 1 of 3 done" });
  expect(() => parseRunFile(run("| 1+ | Tokens | done | | | |\n| 2 | Graph | todo | | | |"))).toThrow('phase row 1 has number "1+"');
  expect(() => parseRunFile(run("| 1 | Tokens | almost done | | | |"))).toThrow('unknown status "almost done"');
});

test("escaped pipes stay in the cell, cut text keeps surrogate pairs whole, and a table ends at a blank line", () => {
  const parsed = parseRunFile("\uFEFF" + run("| 1 | Split a \\| b | running | | | |\n\n| 2 | Ghost | todo | | | |"));
  expect(parsed.phases).toEqual([{ number: 1, title: "Split a | b", status: "running", written: "running", tip: "" }]);
  const long = currentPhase(parseRunFile(run(`| 1 | ${"x".repeat(190)}😀😀😀😀😀😀😀😀😀😀 | todo | | | |`)));
  expect(long.phase.isWellFormed()).toBe(true);
  expect(Array.from(long.phase)).toHaveLength(200);
  expect(() => parseRunFile(run("| 1 | Parser | todo |"))).toThrow("has 3 cells, the header has 6");
  expect(() => parseRunFile(run("| 1 | Parser | done | main | | |"))).toThrow('tip "main" is not a commit hash');
  expect(() => parseRunFile("intro\n" + run("| 1 | Parser | todo | | | |"))).toThrow("must start with a");
});

test("refuses a run file it cannot read exactly instead of guessing", () => {
  expect(() => parseRunFile("# Something else\n")).toThrow("must start with a");
  expect(() => parseRunFile(run("| 1 | Parser | finished | | | |"))).toThrow('unknown status "finished"');
  expect(() => parseRunFile(run("| 1 | Parser | done | | | |\n| 3 | Docs | todo | | | |"))).toThrow('phase row 2 has number "3"');
  expect(() => parseRunFile(run("| 1 | | todo | | | |"))).toThrow("phase 1 has no title");
  expect(() => parseRunFile(run(""))).toThrow("no rows");
  expect(() => parseRunFile(run("| 1 | Parser | fix-round-0 | | | |"))).toThrow("unknown status");
  expect(() => parseRunFile(run("| 1 | Parser | todo | | | |").replace("| # | Title | Status | Tip |", "| # | Status | Title | Tip |"))).toThrow("header");
});
