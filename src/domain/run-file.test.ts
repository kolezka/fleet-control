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
  expect(currentPhase(parsed)).toEqual({ phase: "phase 2: Retry", phaseStatus: "fix-round-1 at def5678; 1 of 3 done" });
});

test("a finished run shows its last phase, and the decisions table is not read as phases", () => {
  const parsed = parseRunFile(run("| 1 | Parser | done | abc1234 | | |\n| 2 | Retry | done | def5678 | | |"));
  expect(parsed.phases).toHaveLength(2);
  expect(currentPhase(parsed)).toEqual({ phase: "phase 2: Retry", phaseStatus: "done at def5678; 2 of 2 done" });
});

test("refuses a run file it cannot read exactly instead of guessing", () => {
  expect(() => parseRunFile("# Something else\n")).toThrow("no '# Phased run:' title");
  expect(() => parseRunFile(run("| 1 | Parser | finished | | | |"))).toThrow('unknown status "finished"');
  expect(() => parseRunFile(run("| 1 | Parser | done | | | |\n| 3 | Docs | todo | | | |"))).toThrow('phase row 2 has number "3"');
  expect(() => parseRunFile(run("| 1 | | todo | | | |"))).toThrow("phase 1 has no title");
  expect(() => parseRunFile(run(""))).toThrow("no rows");
  expect(() => parseRunFile(run("| 1 | Parser | fix-round-0 | | | |"))).toThrow("unknown status");
  expect(() => parseRunFile(run("| 1 | Parser | todo | | | |").replace("| # | Title | Status | Tip |", "| # | Status | Title | Tip |"))).toThrow("header");
});
