import { expect, test } from "bun:test";
import { pinnedFleetBin, resolveFleetBin } from "./path.ts";

test("defaults to the pinned submodule independent of working directory", () => {
  expect(resolveFleetBin({})).toBe(pinnedFleetBin);
  expect(pinnedFleetBin).toEndWith("/vendor/agent-fleet/scripts/fleet");
});

test("explicit overrides take precedence and never silently fall back", () => {
  expect(resolveFleetBin({ FLEET_BIN: import.meta.path })).toBe(import.meta.path);
  expect(resolveFleetBin({ READONLY_FLEET_BIN: pinnedFleetBin, FLEET_BIN: import.meta.path })).toBe(pinnedFleetBin);
  expect(() => resolveFleetBin({ READONLY_FLEET_BIN: "/missing/fleet-control-cli" })).toThrow("git submodule update --init --recursive");
});
