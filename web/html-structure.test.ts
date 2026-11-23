import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The page tests find elements by id, so they cannot see a lost closing tag that nests one part inside another.
// A merge once dropped the </div> after the service part, which hid the watchdog part and every admin notice.
test("every page's <div> tags balance, and the admin parts are siblings, not nested", () => {
  const dir = import.meta.dir;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".html"))) {
    const html = readFileSync(join(dir, f), "utf8");
    expect([f, (html.match(/<div\b/g) ?? []).length]).toEqual([f, (html.match(/<\/div>/g) ?? []).length]);
  }
  const html = readFileSync(join(dir, "index.html"), "utf8");
  // Walk the div nesting and record the depth at which each admin part opens.
  const depth: Record<string, number> = {};
  let d = 0;
  for (const m of html.matchAll(/<div\b([^>]*)>|<\/div>|<p id="adminStatus"/g)) {
    if (m[0] === "</div>") d--;
    else if (m[0].startsWith("<p")) depth.adminStatus = d;
    else { const id = /\bid="([^"]+)"/.exec(m[1] ?? "")?.[1]; if (id) depth[id] = d; d++; }
  }
  const parts = ["settingsPart", "servicePart", "watchdogPart"].filter((id) => id in depth);
  expect(parts).toEqual(["settingsPart", "servicePart", "watchdogPart"]);
  for (const id of parts) expect([id, depth[id]]).toEqual([id, depth.adminStatus]);
});
