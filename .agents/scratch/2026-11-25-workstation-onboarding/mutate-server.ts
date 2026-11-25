// Negative controls for the review fixes outside web/app.ts: remove one protected behaviour at a time,
// run the unchanged test file, require the named test to fail at an expect(), then restore the source.
// Usage: bun .agents/scratch/2026-11-25-workstation-onboarding/mutate-server.ts   (from the repository root)
const sum = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

const mutations: { name: string; file: string; from: string; to: string; test: string; kills: string; survives?: true }[] = [
  { name: "list-creates-file", file: "src/data/workstation-plans.ts", from: "      if (!existsSync(path)) return [];\n      const db = new Database(path, { readonly: true });\n      try { return readPlans(db); }", to: "      const db = new Database(path, { create: true });\n      try { return workstationPlans(db).list(); }", test: "src/data/workstation-plans.test.ts", kills: "reading plans never creates or changes the store file" },
  { name: "list-creates-table", file: "src/data/workstation-plans.ts", from: "      const db = new Database(path, { readonly: true });\n      try { return readPlans(db); }", to: "      const db = new Database(path);\n      try { return workstationPlans(db).list(); }", test: "src/data/workstation-plans.test.ts", kills: "a store file that is not a plan store is a read error, not an empty list" },
  { name: "handler-read-creates-file", file: "src/data/workstation-plans.ts", from: "      if (!existsSync(path)) return [];\n      const db = new Database(path, { readonly: true });\n      try { return readPlans(db); }", to: "      const db = new Database(path, { create: true });\n      try { return workstationPlans(db).list(); }", test: "src/gateway-enroll.test.ts", kills: "reading saved plans leaves no store file behind, and a broken store is logged with its cause" },
  { name: "plan-known-id", file: "src/application/workstation-plans.ts", from: "      if (knownIds().includes(id)) throw new EnrollError(`host id ${id} is already in use`);\n", to: "", test: "src/gateway-enroll.test.ts", kills: "a plan cannot take the id of a host this gateway already has" },
  { name: "plan-log", file: "src/gateway-enroll.ts", from: '      log(`${method === "GET" ? "reading" : "saving"} workstation plans failed: ${errorChain(err)}`);\n', to: "", test: "src/gateway-enroll.test.ts", kills: "reading saved plans leaves no store file behind, and a broken store is logged with its cause" },
  { name: "profile-log", file: "src/gateway-hosts.ts", from: "      log(`saving the profile of ${live.id} failed: ${e instanceof Error ? e.message : String(e)}`);\n", to: "", test: "src/gateway-profile-edit.test.ts", kills: "a profile save that fails is logged with its cause and changes nothing in memory" },
  { name: "origin-required-plans", file: "src/client-gateway.ts", from: '          if (origin === null) return fail(403, "forbidden", "Origin required for writes");\n', to: "", test: "src/gateway-enroll.test.ts", kills: "a plan sent without this page's origin is refused and nothing is stored" },
  { name: "origin-required-profile", file: "src/client-gateway.ts", from: '          if (origin === null) return fail(403, "forbidden", "Origin required for writes");\n', to: "", test: "src/gateway-profile-edit.test.ts", kills: "a profile sent without this page's origin is refused and the config file stays as it was" },
  { name: "origin-match-plans", file: "src/client-gateway.ts", from: '      if (origin !== null && origin !== `http://${hostHeader}`) return fail(403, "forbidden", "cross-origin request");\n', to: "", test: "src/gateway-enroll.test.ts", kills: "a plan sent without this page's origin is refused and nothing is stored" },
  { name: "origin-match-profile", file: "src/client-gateway.ts", from: '      if (origin !== null && origin !== `http://${hostHeader}`) return fail(403, "forbidden", "cross-origin request");\n', to: "", test: "src/gateway-profile-edit.test.ts", kills: "a profile sent without this page's origin is refused and the config file stays as it was" },
  { name: "harness-enum", file: "web/host-state.ts", from: '      if (defaultHarness !== undefined && defaultHarness !== "deepseek-harness" && defaultHarness !== "claude-code") return null;\n', to: "", test: "web/host-state.test.ts", kills: "host list: a harness preference is one of the two known harnesses or the list is refused" },
  { name: "page-stale-lock", file: "web/workstation.ts", from: "if(res.status===409){snapshot=null;notice(", to: "if(res.status===409){notice(", test: "web/workstation.test.ts", kills: "a save the gateway refuses as stale locks the form until the settings are read again" },
  { name: "page-confirm-reply", file: "web/workstation.ts", from: "if(stored.name!==name||stored.origin!==snapshot.origin||!parseWorkstationProfile(stored.profile)||Object.keys(profile).some(k=>stored.profile[k]!==profile[k as keyof typeof profile]))throw Error();", to: "", test: "web/workstation.test.ts", kills: "a save is not reported as done when the reply is an error, missing, or holds other values" },
  { name: "page-malformed-read", file: "web/workstation.ts", from: "if(typeof raw.name!=='string'||typeof raw.origin!=='string'||(raw.profile!==null&&!profile)) throw Error();", to: "", test: "web/workstation.test.ts", kills: "settings that cannot be read, or are malformed, leave the form locked instead of showing empty fields as saved" },
  { name: "page-save-needs-change", file: "web/workstation.ts", from: "field('save').disabled=busy || !changes.length || !now.name || !now.group;", to: "field('save').disabled=busy || !now.name || !now.group;", test: "web/workstation.test.ts", kills: "the form loads the saved settings and offers nothing to save until something changes" },
  {"name":"page-read-status","file":"web/workstation.ts","from":"if(!res.ok) throw Error();","to":"","test":"web/workstation.test.ts","kills":"settings that cannot be read, or are malformed, leave the form locked instead of showing empty fields as saved"},
  {"name":"list-readonly-flag-alone","file":"src/data/workstation-plans.ts","from":"      const db = new Database(path, { readonly: true });","to":"      const db = new Database(path, { create: true });","test":"src/data/workstation-plans.test.ts","kills":"reading plans never creates or changes the store file","survives":true},
];

let bad = 0;
for (const m of mutations) {
  const original = await Bun.file(m.file).text();
  const count = original.split(m.from).length - 1;
  if (count !== 1) { console.log(`${m.name}: SETUP ERROR, needle found ${count} times in ${m.file}`); bad++; continue; }
  let line = "";
  try {
    await Bun.write(m.file, original.replace(m.from, m.to));
    const run = Bun.spawnSync(["bun", "test", m.test], { stdout: "pipe", stderr: "pipe" });
    const out = run.stdout.toString() + run.stderr.toString();
    await Bun.write(`/tmp/fc-wo-mutation-${m.name}.log`, out);
    const failed = [...new Set([...out.matchAll(/^\(fail\) (.*?)(?: \[[\d.]+ms\])?$/gm)].map((x) => x[1]!))];
    const at = out.indexOf(`(fail) ${m.kills}`);
    const before = at < 0 ? "" : out.slice(0, at);
    const start = Math.max(before.lastIndexOf("\n(pass) "), before.lastIndexOf("\n(fail) "));
    const atExpect = /error: expect\(received\)/.test(before.slice(start < 0 ? 0 : start));
    const ok = m.survives ? run.exitCode === 0 && failed.length === 0 : run.exitCode !== 0 && failed.includes(m.kills) && atExpect;
    if (!ok) bad++;
    if (m.survives) line = `${m.name}: exit ${run.exitCode}, ${ok ? "SURVIVES as expected (no observable effect)" : "UNEXPECTED"}; failed: ${JSON.stringify(failed)}`;
    else line = `${m.name}: exit ${run.exitCode}, ${ok ? "KILLED" : "NOT KILLED"} by "${m.kills}"; failed: ${JSON.stringify(failed)}; at expect: ${atExpect}`;
  } finally {
    await Bun.write(m.file, original);
  }
  const restored = sum(await Bun.file(m.file).text()) === sum(original);
  if (!restored) bad++;
  console.log(`${line}; restored: ${restored}`);
}
process.exit(bad ? 1 : 0);
