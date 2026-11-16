import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Glob } from "bun";

// Relative links in the project's markdown must point at files that exist.
const root = resolve(import.meta.dir, "..");
const sources = ["*.md", "docs/**/*.md", "deploy/**/*.md"];

export function brokenLinks(base: string, patterns: string[]): string[] {
  const broken: string[] = [];
  for (const pattern of patterns) {
    for (const file of new Glob(pattern).scanSync({ cwd: base })) {
      const text = readFileSync(join(base, file), "utf8").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
      for (const match of text.matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
        const target = match[1]!.split("#")[0]!;
        if (!target || /^[a-z]+:/i.test(target)) continue;
        if (!existsSync(join(base, dirname(file), decodeURIComponent(target)))) broken.push(`${file}: ${match[1]}`);
      }
    }
  }
  return broken;
}

test("relative markdown links point at existing files", () => {
  expect(brokenLinks(root, sources)).toEqual([]);
});
