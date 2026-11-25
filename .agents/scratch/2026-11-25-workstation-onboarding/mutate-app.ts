// Negative controls for web/app.test.ts: remove one protected behaviour from web/app.ts at a time,
// run the unchanged tests, and require the named test to fail at an expect(), then restore the file.
// Usage: bun .agents/scratch/2026-11-25-workstation-onboarding/mutate-app.ts   (from the repository root)
const file = "web/app.ts";
const original = await Bun.file(file).text();
const sum = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

// also: a second change made together with the first. survives: a guard another guard repeats, so removing it alone changes nothing.
const mutations: { name: string; from: string; to: string; kills: string; also?: { from: string; to: string }; survives?: true }[] = [
  { name: "no-review", from: "if (reviewing?.host !== h.info.id) return false;", to: "if (reviewing?.host !== h.info.id) return true;", kills: "no answer is sent when no review is open" },
  { name: "button-host", from: ' && b.dataset.host === h.info.id && inReview(h, q)', to: " && inReview(h, q)", kills: "no answer is sent when the button names another host" },
  { name: "project", from: 'return typeof owner === "object" && owner.project === want.project && owner.task === want.task;', to: 'return typeof owner === "object" && owner.task === want.task;', kills: "no answer is sent when the request belongs to another project" },
  { name: "task", from: 'return typeof owner === "object" && owner.project === want.project && owner.task === want.task;', to: 'return typeof owner === "object" && owner.project === want.project;', kills: "no answer is sent when the request belongs to another task" },
  { name: "unassigned-owner", from: 'if (!want) return owner === "none";', to: "if (!want) return true;", kills: "a request with no project is answered in the unassigned review, not on the machine" },
  { name: "revision", from: "      && q.revision === Number(b.dataset.revision) && q.status", to: "      && q.status", kills: "no answer is sent when the revision is not the current one" },
  { name: "open", from: ' && q.status === "open" && q.allowedResponses.includes(b.dataset.answer)) void answer', to: " && q.allowedResponses.includes(b.dataset.answer)) void answer", kills: "no answer is sent when the request is no longer open" },
  { name: "allowed", from: ' && q.status === "open" && q.allowedResponses.includes(b.dataset.answer)) void answer', to: ' && q.status === "open") void answer', kills: "no answer is sent when the response is not one the request allows" },
  { name: "ready", from: 'if (h && q && h.coordRead.status === "ready" && b.dataset.host', to: "if (h && q && b.dataset.host", kills: "no answer is sent when the request state could not be read again" },
  { name: "esc-review-revision", from: "const revision = esc(String(q.revision));", to: "const revision = String(q.revision);", kills: "host-provided strings never become markup anywhere on the page" },
  { name: "esc-machine-revision", from: "· revision ${esc(String(q.revision))}</p>` +", to: "· revision ${q.revision}</p>` +", kills: "host-provided strings never become markup anywhere on the page" },
  { name: "machine-answer", from: '<button type="button" data-host="${esc(h.info.id)}" data-unassigned="yes">', to: '<button type="button" data-host="${esc(h.info.id)}" data-unassigned="yes" data-answer="approve">', kills: "a request with no project is answered in the unassigned review, not on the machine" },
  {"name":"half-owner-as-none","from":"if (project == null && task == null) return \"none\";","to":"if (project == null || task == null) return \"none\";","kills":"a request with half an owner is in no review and cannot be answered"},
  {"name":"empty-owner-accepted","from":"return typeof project === \"string\" && project && typeof task === \"string\" && task ? { project, task } : \"malformed\";","to":"return typeof project === \"string\" && typeof task === \"string\" && task ? { project, task } : \"malformed\";","kills":"a request with half an owner is in no review and cannot be answered"},
  {"name":"malformed-in-unassigned","from":"if (!want) return owner === \"none\";","to":"if (!want) return typeof owner !== \"object\";","kills":"a request with half an owner is in no review and cannot be answered"},
  {"name":"malformed-offers-unassigned","from":"const toReview = owner === \"malformed\" ? `<p>Project and task could not be read. This request cannot be answered.</p>`","to":"const toReview = owner === \"malformed\" ? `<p>Project and task could not be read. This request cannot be answered.</p><button type=\"button\" data-host=\"${esc(h.info.id)}\" data-unassigned=\"yes\">Open unassigned decisions</button>`","kills":"a request with half an owner is in no review and cannot be answered"},
  {"name":"reset-on-host-change","from":"if (reviewing && (!h || h.info.supervisor || h.info.id !== reviewing.host)) reviewing = null;","to":"if (reviewing && (!h || h.info.supervisor)) reviewing = null;","kills":"picking another host closes the review, and the old review answers nothing there"},
  {"name":"reset-on-cooperative","from":"if (reviewing && (!h || h.info.supervisor || h.info.id !== reviewing.host)) reviewing = null;","to":"if (reviewing && (!h || h.info.id !== reviewing.host)) reviewing = null;","kills":"a host that becomes cooperative closes the review and takes no answer"},
  {"name":"review-host-alone","from":"if (reviewing?.host !== h.info.id) return false;","to":"if (!reviewing) return false;","kills":"picking another host closes the review, and the old review answers nothing there","survives":true},
  {"name":"review-host-and-reset","from":"if (reviewing?.host !== h.info.id) return false;","to":"if (!reviewing) return false;","kills":"picking another host closes the review, and the old review answers nothing there","also":{"from":"if (reviewing && (!h || h.info.supervisor || h.info.id !== reviewing.host)) reviewing = null;","to":"if (reviewing && (!h || h.info.supervisor)) reviewing = null;"}},
  {"name":"open-project-other-host-alone","from":"if (b.dataset.project && b.dataset.task && b.dataset.host === fleet.selectedHost) {","to":"if (b.dataset.project && b.dataset.task) {","kills":"a review button that names a host other than the selected one opens no review","survives":true},
  {"name":"open-project-other-host-and-reset","from":"if (b.dataset.project && b.dataset.task && b.dataset.host === fleet.selectedHost) {","to":"if (b.dataset.project && b.dataset.task) {","kills":"a review button that names a host other than the selected one opens no review","also":{"from":"if (reviewing && (!h || h.info.supervisor || h.info.id !== reviewing.host)) reviewing = null;","to":"if (reviewing && (!h || h.info.supervisor)) reviewing = null;"}},
  {"name":"open-unassigned-other-host-alone","from":"if (b.dataset.unassigned && b.dataset.host === fleet.selectedHost) {","to":"if (b.dataset.unassigned) {","kills":"a review button that names a host other than the selected one opens no review","survives":true},
  {"name":"open-unassigned-other-host-and-reset","from":"if (b.dataset.unassigned && b.dataset.host === fleet.selectedHost) {","to":"if (b.dataset.unassigned) {","kills":"a review button that names a host other than the selected one opens no review","also":{"from":"if (reviewing && (!h || h.info.supervisor || h.info.id !== reviewing.host)) reviewing = null;","to":"if (reviewing && (!h || h.info.supervisor)) reviewing = null;"}},
  {"name":"both-empty-as-none","from":"if (project == null && task == null) return \"none\";","to":"if (!project && !task) return \"none\";","kills":"a request with half an owner is in no review and cannot be answered"},
];

let bad = 0;
try {
  for (const m of mutations) {
    const count = original.split(m.from).length - 1;
    if (count !== 1) { console.log(`${m.name}: SETUP ERROR, needle found ${count} times`); bad++; continue; }
    let changed = original.replace(m.from, m.to);
    if (m.also) {
      const n = changed.split(m.also.from).length - 1;
      if (n !== 1) { console.log(`${m.name}: SETUP ERROR, second needle found ${n} times`); bad++; continue; }
      changed = changed.replace(m.also.from, m.also.to);
    }
    await Bun.write(file, changed);
    const run = Bun.spawnSync(["bun", "test", "web/app.test.ts"], { stdout: "pipe", stderr: "pipe" });
    const out = run.stdout.toString() + run.stderr.toString();
    await Bun.write(`/tmp/fc-wo-mutation-${m.name}.log`, out);
    const failed = [...new Set([...out.matchAll(/^\(fail\) (.*?)(?: \[[\d.]+ms\])?$/gm)].map((x) => x[1]!))];
    // The failure must be an assertion, not a crash of the page code.
    const section = out.slice(0, out.indexOf(`(fail) ${m.kills}`));
    const atExpect = /error: expect\(received\)[^\n]*\n(?:(?!\n\(pass\)|\n\(fail\))[\s\S])*$/.test(section);
    if (m.survives) {
      const ok = run.exitCode === 0 && failed.length === 0;
      if (!ok) bad++;
      console.log(`${m.name}: exit ${run.exitCode}, ${ok ? "SURVIVES as expected (repeated by another guard)" : "UNEXPECTED"}; failed: ${JSON.stringify(failed)}`);
      continue;
    }
    const ok = run.exitCode !== 0 && failed.includes(m.kills) && atExpect;
    if (!ok) bad++;
    console.log(`${m.name}: exit ${run.exitCode}, ${ok ? "KILLED" : "NOT KILLED"} by "${m.kills}"; failed: ${JSON.stringify(failed)}; at expect: ${atExpect}`);
  }
} finally {
  await Bun.write(file, original);
}
const restored = sum(await Bun.file(file).text()) === sum(original);
console.log(`restored: ${restored}, sha256 ${sum(original)}`);
process.exit(bad || !restored ? 1 : 0);
