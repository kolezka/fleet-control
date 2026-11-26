import { expect, test } from "bun:test";

// Check the product entry, not the standalone design document.
test("the gateway home page opens the Terminal Studio workspace", async () => {
  const home = await Bun.file(new URL("./index.html", import.meta.url)).text();
  expect(home).toContain("<title>Terminal Studio");
  expect(home).toContain('aria-label="Workspaces"');
  const { navigationMarkup } = await import('./studio-navigation.ts');
  expect(navigationMarkup).toContain('data-view="dashboard"');
});
