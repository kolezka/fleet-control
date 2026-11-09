import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = [
  [".design/drafts/console/terminal-deck/v4.html", "docs/design/terminal-deck.html"],
  [".design/shots/console/terminal-deck/v4-dark-1440x900.png", "docs/design/desktop-dark.png"],
  [".design/shots/console/terminal-deck/v4-light-1440x900.png", "docs/design/desktop-light.png"],
  [".design/shots/console/terminal-deck/v4-dark-390x844.png", "docs/design/phone-dark.png"],
  [".design/shots/console/terminal-deck/v4-light-390x844.png", "docs/design/phone-light.png"],
] as const;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const records = [];
for (const [source, destination] of files) {
  const src = join(root, source);
  const dest = join(root, destination);
  if (existsSync(dest)) throw new Error(`Destination already exists: ${destination}`);
  const original = readFileSync(src);
  if (source.endsWith(".png")) {
    if (original.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`Invalid PNG: ${source}`);
    const expected = source.includes("1440x900") ? [1440, 900] : [500, 844];
    if (original.readUInt32BE(16) !== expected[0] || original.readUInt32BE(20) !== expected[1]) throw new Error(`Unexpected screenshot dimensions: ${source}`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest, constants.COPYFILE_EXCL);
  const copied = readFileSync(dest);
  if (digest(copied) !== digest(original)) throw new Error(`Copy mismatch: ${destination}`);
  records.push({ source, destination, sha256: digest(copied) });
  console.log(`Verified identical copy: ${destination}`);
}
const manifest = {
  status: "selected implementation baseline, not a shipped runtime",
  sourceDraft: ".design/drafts/console/terminal-deck/v4.html",
  capturedAt: new Date().toISOString(),
  modelDisplayImplemented: false,
  phoneCapture: "390px draft inside a 500px screenshot frame; right grey strip is outside the design",
  files: records,
};
writeFileSync(join(root, "docs/design/manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
const oldTest = readFileSync(join(root, ".design/check-coordination.ts"), "utf8");
const originalPath = 'Bun.file("/Users/me/Development/fleet-control/.design/drafts/console/terminal-deck/v4.html")';
if (!oldTest.includes(originalPath)) throw new Error("Expected original test path missing");
const portableTest = oldTest.replace(originalPath, 'Bun.file(new URL("../docs/design/terminal-deck.html", import.meta.url))');
mkdirSync(join(root, "scripts"), { recursive: true });
writeFileSync(join(root, "scripts/check-design.ts"), portableTest, { flag: "wx" });
console.log("Created a portable design check and a source-linked SHA-256 manifest.");
